import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolCallMessage, ToolResultAck } from '@agent-kernel/shared'
import { ExecutionReceiptStore, executionRequestDigest } from './execution-receipts.js'
import { assertExecutorStopped, leaderIdentity } from './tools/arena-process-groups.js'

type ExecutorSocket = {
  readonly id: string
  readonly connected: boolean
  on(event: 'executor:announce', handler: (announcement: unknown) => void): void
  on(event: 'executor:shell_authorize', handler: (request: {
    sessionId: string; callId: string; name: string; command: string
  }, ack: (result: { authorized: boolean }) => void) => void): void
  emit(event: 'tool:call', payload: ToolCallMessage, ack: (result: ToolResultAck) => void): boolean
}

type ExecutorNamespace = {
  on(event: 'connection', handler: (socket: ExecutorSocket) => void): void
}

type SocketIoServer = {
  of(namespace: '/executor'): ExecutorNamespace
  close(callback: () => void): void
}

type SocketIoServerConstructor = new (
  httpServer: HttpServer,
  options: { transports: ['websocket'] },
) => SocketIoServer

const requireFromHost = createRequire(new URL('../../host/package.json', import.meta.url))
const { Server } = requireFromHost('socket.io') as { Server: SocketIoServerConstructor }
const fixturePath = fileURLToPath(new URL('./__fixtures__/executor-crash-process.ts', import.meta.url))
const tsxLoaderPath = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function lines(content: string): string[] {
  return content.split(/\r?\n/u).filter(Boolean)
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('executor process crash recovery', () => {
  const spawned = new Set<ChildProcessWithoutNullStreams>()
  const orphanedShells = new Set<number>()
  let io: SocketIoServer | undefined
  let http: HttpServer | undefined
  let testRoot: string | undefined

  afterEach(async () => {
    if (testRoot) await writeFile(join(testRoot, 'release-first-shell'), '').catch(() => undefined)
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    await Promise.all([...spawned].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }))
    for (const pid of orphanedShells) {
      await waitFor(() => !processIsAlive(pid), `known shell process ${pid} did not exit during cleanup`, 500).catch(() => undefined)
      if (processIsAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    orphanedShells.clear()
    if (io) await new Promise<void>((resolve) => io!.close(resolve))
    else if (http?.listening) await new Promise<void>((resolve, reject) => http!.close((error) => error ? reject(error) : resolve()))
    if (testRoot) await rm(testRoot, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== 'linux')('does not repeat an unresolved shell effect after SIGKILL and still replays completed calls', async () => {
    testRoot = await mkdtemp(join(process.cwd(), 'kala-executor-crash-'))
    const markerPath = join(testRoot, 'effects.log')
    const gatePath = join(testRoot, 'release-first-shell')
    const shellPidPath = join(testRoot, 'first-shell.pid')
    const receiptStorePath = join(testRoot, 'execution-receipts.json')
    const keeperFile = join(testRoot, 'keeper.json')
    const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      cwd: testRoot, stdio: ['pipe', 'pipe', 'pipe'],
    })
    spawned.add(keeper)
    if (!keeper.pid) throw new Error('test keeper did not start')
    await writeFile(keeperFile, JSON.stringify(await leaderIdentity(keeper.pid)), { mode: 0o600 })

    http = createServer()
    io = new Server(http, { transports: ['websocket'] })
    const announcedSockets: ExecutorSocket[] = []
    let approvedParent: { sessionId: string; callId: string; command: string;
      name: 'shell'; explicitlyApproved: true } | undefined
    const socketWaiters: Array<(socket: ExecutorSocket) => void> = []
    const authorizedCalls: string[] = []
    io.of('/executor').on('connection', (socket) => {
      socket.on('executor:shell_authorize', (request, ack) => {
        const authorized = Boolean(approvedParent && approvedParent.sessionId === request.sessionId
          && approvedParent.callId === request.callId && approvedParent.name === request.name
          && approvedParent.command === request.command && approvedParent.explicitlyApproved)
        if (authorized) authorizedCalls.push(request.callId)
        ack({ authorized })
      })
      socket.on('executor:announce', () => {
        const waiter = socketWaiters.shift()
        if (waiter) waiter(socket)
        else announcedSockets.push(socket)
      })
    })
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('loopback server did not expose a TCP port')
    const host = `http://127.0.0.1:${address.port}`

    const processOutput = new Map<number, string[]>()
    const startFixture = (): ChildProcessWithoutNullStreams => {
      const child = spawn(process.execPath, ['--import', tsxLoaderPath, fixturePath, host, testRoot!, receiptStorePath], {
        cwd: testRoot,
        env: { ...process.env, NO_COLOR: '1', ARENA_TEST_KEEPER: keeperFile },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      spawned.add(child)
      const output: string[] = []
      processOutput.set(child.pid!, output)
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
      return child
    }
    const nextSocket = async (child: ChildProcessWithoutNullStreams): Promise<ExecutorSocket> => {
      if (announcedSockets.length > 0) return announcedSockets.shift()!
      return await new Promise<ExecutorSocket>((resolve, reject) => {
        const timer = setTimeout(() => {
          const output = processOutput.get(child.pid!)?.join('') ?? ''
          reject(new Error(`executor announcement timed out; fixture output: ${output}`))
        }, 5_000)
        socketWaiters.push((socket) => {
          clearTimeout(timer)
          resolve(socket)
        })
      })
    }
    const stopFixture = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    }
    const dispatch = async (socket: ExecutorSocket, call: ToolCallMessage): Promise<ToolResultAck> => {
      return await new Promise<ToolResultAck>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`tool call ${call.callId} timed out`)), 5_000)
        socket.emit('tool:call', call, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
      })
    }

    const first = startFixture()
    const firstSocket = await nextSocket(first)
    expect(Number(await readFile(join(testRoot, 'executor.pid'), 'utf8'))).toBe(first.pid)
    const unresolvedCall: ToolCallMessage = {
      sessionId: 'session-crash-regression',
      callId: 'call-interrupted-effect',
      name: 'shell',
      cwd: testRoot,
      input: {
        command: `printf '%s\\n' $$ > ${shellQuote(shellPidPath)}; printf 'BEGIN\\n' >> ${shellQuote(markerPath)}; i=0; while [ ! -e ${shellQuote(gatePath)} ] && [ "$i" -lt 200 ]; do i=$((i + 1)); sleep 0.05; done; printf 'END\\n' >> ${shellQuote(markerPath)}`,
        timeout_ms: 15_000,
      },
    }
    const denied = await dispatch(firstSocket, unresolvedCall)
    expect(denied).toMatchObject({ ok: false, content: expect.stringContaining('authorization denied') })
    expect(await readIfPresent(markerPath)).toBe('')
    approvedParent = { sessionId: unresolvedCall.sessionId, callId: unresolvedCall.callId,
      name: 'shell', command: String(unresolvedCall.input.command), explicitlyApproved: true }
    firstSocket.emit('tool:call', unresolvedCall, () => undefined)
    await waitFor(async () => lines(await readIfPresent(markerPath)).includes('BEGIN'), 'first shell never reached its side effect')
    expect(authorizedCalls).toEqual([unresolvedCall.callId])
    const knownShellPid = Number.parseInt((await readFile(shellPidPath, 'utf8')).trim(), 10)
    expect(knownShellPid).toBeGreaterThan(0)
    orphanedShells.add(knownShellPid)

    await stopFixture(first)
    await writeFile(gatePath, '')
    await waitFor(async () => lines(await readIfPresent(markerPath)).includes('END'), 'orphaned shell did not finish after its Executor was killed')
    await waitFor(() => !processIsAlive(knownShellPid), 'orphaned shell remained alive after writing END')
    orphanedShells.delete(knownShellPid)

    const second = startFixture()
    const secondSocket = await nextSocket(second)
    const conflictingPending = await dispatch(secondSocket, {
      ...unresolvedCall,
      input: { command: `printf 'CONFLICT\\n' >> ${shellQuote(markerPath)}` },
    })
    expect(JSON.parse(conflictingPending.content)).toMatchObject({ outcome: 'execution_conflict' })
    const unknown = await dispatch(secondSocket, unresolvedCall)
    expect(lines(await readFile(markerPath, 'utf8')).filter((line) => line === 'BEGIN')).toHaveLength(1)
    expect(unknown.ok).toBe(false)
    expect(JSON.parse(unknown.content)).toEqual(expect.objectContaining({ outcome: 'execution_unknown' }))
    expect(unknown.content).toMatch(/do not automatically retry/iu)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(lines(await readFile(markerPath, 'utf8')).filter((line) => line === 'BEGIN')).toHaveLength(1)

    const completedCall: ToolCallMessage = {
      sessionId: 'session-crash-regression',
      callId: 'call-completed-effect',
      name: 'shell',
      cwd: testRoot,
      input: {
        command: `printf 'BENIGN\\n' >> ${shellQuote(markerPath)}; printf 'benign-ok'`,
      },
    }
    const completed = await dispatch(secondSocket, completedCall)
    expect(completed).toEqual(expect.objectContaining({ callId: completedCall.callId, ok: true }))
    expect(completed.content).toContain('benign-ok')
    expect(lines(await readFile(markerPath, 'utf8')).filter((line) => line === 'BENIGN')).toHaveLength(1)

    await stopFixture(second)
    const third = startFixture()
    const thirdSocket = await nextSocket(third)
    const conflictingCompleted = await dispatch(thirdSocket, {
      ...completedCall,
      input: { command: `printf 'CONFLICT\\n' >> ${shellQuote(markerPath)}` },
    })
    expect(JSON.parse(conflictingCompleted.content)).toMatchObject({ outcome: 'execution_conflict' })
    const replayed = await dispatch(thirdSocket, completedCall)
    expect(replayed).toEqual(completed)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(lines(await readFile(markerPath, 'utf8')).filter((line) => line === 'BENIGN')).toHaveLength(1)
    expect(lines(await readFile(markerPath, 'utf8'))).not.toContain('CONFLICT')

    const skill: ToolCallMessage = {
      sessionId: 'session-crash-regression',
      callId: 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'skill_file',
      cwd: testRoot,
      ownerGeneration: '9',
      origin: 'host',
      input: { action: 'create', name: 'crash-skill', content: 'first and only write', ownerGeneration: '9' },
    }
    thirdSocket.emit('tool:call', skill, () => undefined)
    await waitFor(async () => !!(await readIfPresent(join(testRoot!, 'skill-final-effect-finished')) ||
      await readIfPresent(join(testRoot!, '.agent', 'skills', 'crash-skill', 'SKILL.md'))),
    'skill final filesystem effect did not finish')
    const remotePath = join(testRoot, '.agent', 'skills', 'crash-skill', 'SKILL.md')
    expect(await readFile(remotePath, 'utf8')).toBe('first and only write')
    await stopFixture(third)
    const journal = new ExecutionReceiptStore(receiptStorePath)
    await journal.load()
    const stored = JSON.parse(await readFile(receiptStorePath, 'utf8'))[
      `${skill.sessionId}:${skill.callId}`] as { executorProcess?: Awaited<ReturnType<typeof leaderIdentity>>;
        target?: { pathDigest: string; contentDigest: string } }
    expect(stored.executorProcess?.pgid).toBe(third.pid)
    expect(stored.target).toEqual({ tool: 'skill_file', action: 'create',
      pathDigest: createHash('sha256').update(remotePath).digest('hex'),
      contentDigest: createHash('sha256').update('first and only write').digest('hex') })
    await assertExecutorStopped(stored.executorProcess!)
    const query = {
      sessionId: skill.sessionId, callId: skill.callId,
      ownerGeneration: '9', requestDigest: executionRequestDigest(skill),
    }
    expect(await journal.query(query)).toEqual({ status: 'started_unknown' })
    const fourth = startFixture()
    const fourthSocket = await nextSocket(fourth)
    const unknownSkill = await dispatch(fourthSocket, skill)
    expect(unknownSkill).toMatchObject({ ok: false, failure: { outcome: 'indeterminate' } })
    expect(await readFile(remotePath, 'utf8')).toBe('first and only write')
    expect(await journal.query(query)).toEqual({ status: 'started_unknown' })
  }, 30_000)
})
