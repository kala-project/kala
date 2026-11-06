/**
 * Background-shell runtime.
 *
 * A single process-wide registry that owns detached bash children spawned by
 * the `bash` tool with `run_in_background: true`. The registry:
 *
 *  - Persists each child's stdout+stderr into an on-disk ring buffer in a
 *    private, per-process temporary directory, capped at MAX_LOG_BYTES so a
 *    chatty task can't fill the disk.
 *  - Tracks status metadata (start time, exit code / signal, bytes logged,
 *    bytes truncated by the ring buffer).
 *  - Emits change events so the executor's dashboard-facing WS handlers can
 *    push live updates without polling.
 *  - Evicts task metadata and log files GRACE_MS after the task exits, so an
 *    executor that stays up for weeks doesn't keep every completed task in
 *    memory forever.
 *
 * The registry is in-memory and does not recover tasks after an Executor
 * restart. Detached children may survive an Executor crash or restart;
 * their cleanup requires external process supervision or OS containment.
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFile,
  mkdtemp,
  readFile,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ulid } from 'ulid'
import { shellArgv, shellResourceLimitsFromEnv, type ShellSpec } from './shell-runtime.js'

let taskDirectory: Promise<string> | undefined

function getTaskDirectory(): Promise<string> {
  taskDirectory ??= mkdtemp(join(tmpdir(), '.ak-tasks-'))
  return taskDirectory
}

const MAX_LOG_BYTES = 4 * 1024 * 1024
const UPDATE_THROTTLE_MS = 400
const GRACE_MS = 15 * 60 * 1000

export type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'signaled'

export type BackgroundTaskSummary = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  pid?: number
  startedAt: string
  endedAt?: string
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  bytesLogged: number
  bytesTruncated: number
  outputError?: string
}

export type BgTaskChange =
  | { kind: 'spawned'; task: BackgroundTaskSummary }
  | {
      kind: 'output'
      task: BackgroundTaskSummary
      delta: { fromOffset: number; content: string }
    }
  | { kind: 'ended'; task: BackgroundTaskSummary }
  | { kind: 'evicted'; sessionId: string; taskId: string }

type Task = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  logPath: string
  child: ChildProcess
  startedAt: number
  endedAt?: number
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  bytesLogged: number
  bytesTruncated: number
  bufferSize: number
  pendingDelta: string
  pendingOffset: number | null
  flushTimer: NodeJS.Timeout | null
  evictTimer: NodeJS.Timeout | null
  writeChain: Promise<void>
  outputError: string | null
  inputChain: Promise<void>
  stdinClosed: boolean
  outputWaiters: Set<() => void>
}

const tasks = new Map<string, Task>()
const emitter = new EventEmitter()

emitter.setMaxListeners(50)

export function subscribeBackgroundTasks(
  handler: (change: BgTaskChange) => void,
): () => void {
  emitter.on('change', handler)
  return () => {
    emitter.off('change', handler)
  }
}

export function listBackgroundTasks(sessionId: string): readonly BackgroundTaskSummary[] {
  return [...tasks.values()]
    .filter((task) => task.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(summaryOf)
}

export function getBackgroundTask(
  taskId: string,
): BackgroundTaskSummary | null {
  const task = tasks.get(taskId)
  return task ? summaryOf(task) : null
}

export async function startBackgroundShell(params: {
  sessionId: string
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  shell: ShellSpec
}): Promise<BackgroundTaskSummary> {
  const taskId = ulid()
  const logPath = join(await getTaskDirectory(), `${taskId}.log`)
  await writeFile(logPath, '', { flag: 'wx', mode: 0o600 })

  const env = params.env ?? process.env
  const child = spawn(params.shell.executable, shellArgv(params.shell, params.command, shellResourceLimitsFromEnv(env)), {
    cwd: params.cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin?.on('error', () => {
    // Ignore EPIPE when child exits before stdin write completes.
  })

  const task: Task = {
    taskId,
    sessionId: params.sessionId,
    command: params.command,
    cwd: params.cwd,
    logPath,
    child,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    signal: null,
    bytesLogged: 0,
    bytesTruncated: 0,
    bufferSize: 0,
    pendingDelta: '',
    pendingOffset: null,
    flushTimer: null,
    evictTimer: null,
    writeChain: Promise.resolve(),
    outputError: null,
    inputChain: Promise.resolve(),
    stdinClosed: false,
    outputWaiters: new Set(),
  }
  tasks.set(taskId, task)

  const enqueueLog = (buf: Buffer): void => {
    task.writeChain = task.writeChain.then(() => {
      if (task.outputError === null) return appendToLog(task, buf)
    }).catch((err: unknown) => {
      task.outputError = `log I/O failed: ${err instanceof Error ? err.message : String(err)}`
      notifyWaiters()
    })
  }
  child.stdout?.on('data', enqueueLog)
  child.stderr?.on('data', enqueueLog)

  const notifyWaiters = (): void => {
    for (const waiter of task.outputWaiters) {
      waiter()
    }
    task.outputWaiters.clear()
  }

  let spawnError = false
  child.on('close', (code, signal) => {
    task.endedAt = Date.now()
    task.exitCode = code
    task.signal = signal
    task.stdinClosed = true
    task.status = spawnError ? 'signaled' : signal ? (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT' ? 'killed' : 'signaled') : 'exited'
    void task.writeChain.finally(() => {
      if (task.pendingDelta.length > 0 && task.flushTimer === null) {
        flushDelta(task)
      }
      notifyWaiters()
      emitChange({ kind: 'ended', task: summaryOf(task) })
    })
    task.evictTimer = setTimeout(() => void evict(taskId), GRACE_MS)
    task.evictTimer.unref?.()
  })

  child.on('error', (err) => {
    spawnError = true
    enqueueLog(Buffer.from(`\n[spawn error] ${err.message}\n`))
  })

  child.unref()
  emitChange({ kind: 'spawned', task: summaryOf(task) })
  return summaryOf(task)
}

export async function readBackgroundShell(params: {
  taskId: string
  sessionId: string
  offset?: number
  block?: boolean
  waitForOutput?: boolean
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}): Promise<{
  content: string
  nextOffset: number
  hasMore: boolean
  done: boolean
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  bytesTruncated: number
}> {
  const task = tasks.get(params.taskId)
  if (!task || task.sessionId !== params.sessionId) throw new Error(`unknown background task: ${params.taskId}`)
  const requestedOffset = params.offset ?? 0
  if (params.block && task.status === 'running') {
    if (params.waitForOutput) {
      await waitForOutputOrExit(task, requestedOffset, params.timeoutMs ?? 30_000, params.signal)
    } else {
      await waitForExit(task, params.timeoutMs ?? 30_000, params.signal)
    }
  }
  await task.writeChain
  if (task.outputError !== null) throw new Error(`background task ${task.taskId} output unavailable: ${task.outputError}`)
  let buf: Buffer
  try {
    buf = await readFile(task.logPath)
  } catch (err) {
    throw new Error(`background task ${task.taskId} output unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
  const bufferStart = task.bytesLogged - buf.length
  const sliceFrom = Math.max(0, requestedOffset - bufferStart)
  const slice = buf.subarray(Math.min(sliceFrom, buf.length), params.maxBytes === undefined
    ? undefined : Math.min(buf.length, sliceFrom + params.maxBytes))
  const nextOffset = bufferStart + Math.min(buf.length, sliceFrom + slice.length)
  return {
    content: slice.toString('utf8'),
    nextOffset,
    hasMore: nextOffset < task.bytesLogged,
    done: task.status !== 'running',
    status: task.status,
    exitCode: task.exitCode,
    signal: task.signal,
    bytesTruncated: task.bytesTruncated,
  }
}

export async function writeBackgroundShell(params: {
  taskId: string
  sessionId: string
  input?: string
  eof?: boolean
  signal?: AbortSignal
}): Promise<{
  taskId: string
  writtenBytes: number
  eof: boolean
  status: BackgroundTaskStatus
}> {
  const task = tasks.get(params.taskId)
  if (!task || task.sessionId !== params.sessionId) throw new Error(`unknown background task: ${params.taskId}`)
  const operation = task.inputChain.then(async () => {
    if (params.signal?.aborted) throw new Error(`background write cancelled before stdin action: ${params.taskId}`)
    if (task.status !== 'running') {
      throw new Error(`background task is not running: ${params.taskId} (status=${task.status})`)
    }
    const stdin = task.child.stdin
    if (!stdin || task.stdinClosed || stdin.destroyed || !stdin.writable) {
      throw new Error(`stdin is closed for background task: ${params.taskId}`)
    }
    const payload = Buffer.from(params.input ?? '', 'utf8')
    if (payload.length > 0) {
      await new Promise<void>((resolve, reject) => {
        stdin.write(payload, (err) => err ? reject(err) : resolve())
      })
    }
    if (params.eof === true) {
      task.stdinClosed = true
      await new Promise<void>((resolve) => stdin.end(() => resolve()))
    }
    return {
      taskId: task.taskId,
      writtenBytes: payload.length,
      eof: task.stdinClosed,
      status: task.status,
    }
  })
  task.inputChain = operation.then(() => undefined, () => undefined)
  return operation
}

export async function waitForBackgroundShell(params: {
  taskId: string
  sessionId: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{
  exited: boolean
  aborted: boolean
  task: BackgroundTaskSummary
}> {
  const task = tasks.get(params.taskId)
  if (!task || task.sessionId !== params.sessionId) throw new Error(`unknown background task: ${params.taskId}`)
  let aborted = false
  if (task.status === 'running') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, params.timeoutMs)
      const onClose = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        aborted = true
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        task.child.off('close', onClose)
        params.signal?.removeEventListener('abort', onAbort)
      }
      if (params.signal?.aborted) {
        aborted = true
        cleanup()
        resolve()
        return
      }
      task.child.once('close', onClose)
      params.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  await task.writeChain
  return {
    exited: task.status !== 'running',
    aborted,
    task: summaryOf(task),
  }
}

export async function evictBackgroundShellNow(taskId: string, sessionId: string): Promise<void> {
  const task = tasks.get(taskId)
  if (!task || task.sessionId !== sessionId) return
  if (task.status === 'running') throw new Error(`cannot evict running background task: ${taskId}`)
  if (task.flushTimer) {
    clearTimeout(task.flushTimer)
    task.flushTimer = null
  }
  if (task.evictTimer) {
    clearTimeout(task.evictTimer)
    task.evictTimer = null
  }
  await evict(taskId)
}

export async function killBackgroundShell(
  taskId: string,
  sessionId: string,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<boolean> {
  const task = tasks.get(taskId)
  if (!task || task.sessionId !== sessionId) throw new Error(`unknown background task: ${taskId}`)
  if (task.status !== 'running') return false
  // `close` can lag behind exit while a descendant holds stdout open. The
  // leader's PID (and, on POSIX, its process-group ID) may already be reused.
  if (task.child.exitCode !== null || task.child.signalCode !== null) return false
  if (process.platform === 'win32' && task.child.pid !== undefined) {
    return await new Promise<boolean>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(task.child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('error', () => resolve(false))
      killer.on('close', (code) => resolve(code === 0))
    })
  }
  if (task.child.pid !== undefined) {
    try {
      process.kill(-task.child.pid, signal)
      return true
    } catch {
      // Fall back to direct child kill if group signal fails.
    }
  }
  return task.child.kill(signal)
}

async function appendToLog(task: Task, buf: Buffer): Promise<void> {
  const incoming = buf.length

  let toWrite: Buffer
  if (task.bufferSize + incoming <= MAX_LOG_BYTES) {
    toWrite = buf
    task.bufferSize += incoming
  } else {
    const overflow = task.bufferSize + incoming - MAX_LOG_BYTES
    task.bytesTruncated += overflow
    if (incoming >= MAX_LOG_BYTES) {
      toWrite = buf.subarray(incoming - MAX_LOG_BYTES)
      await truncate(task.logPath, 0)
      task.bufferSize = toWrite.length
    } else {
      const keepFromBuffer = MAX_LOG_BYTES - incoming
      const existing = await readFile(task.logPath)
      const kept = existing.subarray(existing.length - keepFromBuffer)
      await writeFile(task.logPath, kept)
      task.bufferSize = kept.length
      toWrite = buf
      task.bufferSize += incoming
    }
  }

  await appendFile(task.logPath, toWrite)
  task.bytesLogged += incoming

  const chunk = toWrite.toString('utf8')
  if (task.pendingOffset === null) {
    task.pendingOffset = task.bytesLogged - toWrite.length
  }
  task.pendingDelta += chunk

  if (task.flushTimer === null) {
    task.flushTimer = setTimeout(() => flushDelta(task), UPDATE_THROTTLE_MS)
    task.flushTimer.unref?.()
  }
  if (task.outputWaiters.size > 0) {
    for (const waiter of task.outputWaiters) {
      waiter()
    }
    task.outputWaiters.clear()
  }
}

function flushDelta(task: Task): void {
  if (task.flushTimer !== null) {
    clearTimeout(task.flushTimer)
    task.flushTimer = null
  }
  if (task.pendingDelta.length === 0 || task.pendingOffset === null) return
  const delta = {
    fromOffset: task.pendingOffset,
    content: task.pendingDelta,
  }
  task.pendingDelta = ''
  task.pendingOffset = null
  emitChange({ kind: 'output', task: summaryOf(task), delta })
}

async function evict(taskId: string): Promise<void> {
  const task = tasks.get(taskId)
  if (!task || task.status === 'running') return
  await task.writeChain
  if (tasks.get(taskId) !== task) return
  tasks.delete(taskId)
  try {
    await unlink(task.logPath)
  } catch {
    // Best-effort.
  }
  emitChange({ kind: 'evicted', sessionId: task.sessionId, taskId })
}

async function waitForExit(task: Task, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (task.status !== 'running') return
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      task.child.off('close', finish)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    task.child.once('close', finish)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted || task.status !== 'running') finish()
  })
  try {
    await stat(task.logPath)
  } catch {
    // Ignore; readFile will surface the actual error below.
  }
}

async function waitForOutputOrExit(task: Task, requestedOffset: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await task.writeChain
  if (task.status !== 'running' || task.bytesLogged > requestedOffset) return
  await new Promise<void>((resolve) => {
    const waiter = (): void => {
      clearTimeout(timer)
      task.outputWaiters.delete(waiter)
      signal?.removeEventListener('abort', waiter)
      resolve()
    }
    const timer = setTimeout(waiter, timeoutMs)
    task.outputWaiters.add(waiter)
    signal?.addEventListener('abort', waiter, { once: true })
    if (signal?.aborted || task.status !== 'running' || task.bytesLogged > requestedOffset) waiter()
  })
}

function emitChange(change: BgTaskChange): void {
  emitter.emit('change', change)
}

function summaryOf(task: Task): BackgroundTaskSummary {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    command: task.command,
    cwd: task.cwd,
    ...(typeof task.child.pid === 'number' ? { pid: task.child.pid } : {}),
    startedAt: new Date(task.startedAt).toISOString(),
    ...(task.endedAt ? { endedAt: new Date(task.endedAt).toISOString() } : {}),
    status: task.status,
    exitCode: task.exitCode,
    signal: task.signal,
    bytesLogged: task.bytesLogged,
    bytesTruncated: task.bytesTruncated,
    ...(task.outputError !== null ? { outputError: task.outputError } : {}),
  }
}

// Test-only: expose the private log for failure-path checks.
export function __backgroundTaskLogPathForTests(taskId: string): string {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`unknown background task: ${taskId}`)
  return task.logPath
}

// Test-only: reset all state so vitest can start each case fresh.
export function __resetBackgroundShellRegistryForTests(): void {
  for (const task of tasks.values()) {
    if (task.flushTimer) clearTimeout(task.flushTimer)
    if (task.evictTimer) clearTimeout(task.evictTimer)
    if (task.status === 'running') {
      try {
        task.child.kill('SIGKILL')
      } catch {
        // Fine.
      }
    }
  }
  tasks.clear()
  emitter.removeAllListeners('change')
}
