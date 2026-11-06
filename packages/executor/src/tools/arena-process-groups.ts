import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readdir, readFile, readlink } from 'node:fs/promises'

import { ToolError } from './registry.js'

// Keep the isolated worker inside the CJS Executor asset; tsc does not copy .mjs sidecars.
const ARENA_GIT_WORKER_SOURCE = `
const { spawn } = require('node:child_process')
process.title = 'kala-arena-git-worker'
process.on('disconnect', () => {})
process.once('message', ({ cwd, args, input }) => {
  process.disconnect?.()
  if (process.env.KALA_ARENA_TEST_PAUSE_GIT === 'probe-rev-parse'
    && args.includes('--show-toplevel')) process.kill(process.pid, 'SIGSTOP')
  const git = spawn('/usr/bin/git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    },
  })
  if (process.env.KALA_ARENA_TEST_PAUSE_GIT === 'worktree-add'
    && args.includes('worktree') && args.includes('add') && git.pid) {
    try { process.kill(git.pid, 'SIGSTOP') } catch {}
  }
  git.stdin.on('error', () => {})
  git.stdin.end(input ?? '')
  git.stdout.pipe(process.stdout)
  git.stderr.pipe(process.stderr)
  git.on('error', () => { process.exitCode = 127 })
  git.on('close', (code) => { process.exitCode = code ?? 127 })
})
`

export type ArenaProcessGroup = { pgid: number; leaderStartTicks: string; bootId: string; pidNamespace: string }
export const arenaGroupRecorder = new AsyncLocalStorage<(group: ArenaProcessGroup) => Promise<void>>()

function processFields(text: string): string[] {
  const offset = text.lastIndexOf(') ')
  if (offset < 0) throw new Error('invalid Linux process identity')
  return text.slice(offset + 2).trim().split(/\s+/u)
}

export async function leaderIdentity(pid: number): Promise<ArenaProcessGroup> {
  const fields = processFields(await readFile(`/proc/${pid}/stat`, 'utf8'))
  if (!fields[19]) throw new Error('missing Linux process start time')
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const pidNamespace = await readlink('/proc/self/ns/pid')
  if (!/^[a-f0-9-]{36}$/u.test(bootId)) throw new Error('missing Linux boot identity')
  if (!/^pid:\[\d+\]$/u.test(pidNamespace)) throw new Error('missing Linux PID namespace identity')
  return { pgid: pid, leaderStartTicks: fields[19], bootId, pidNamespace }
}

/** ENOENT or unreadable /proc is UNKNOWN, not proof of process exit. */
export async function assertGroupStopped(group: ArenaProcessGroup): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Linux /proc is required for Arena reconciliation')
  if (!group.bootId || group.bootId !== (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()) {
    throw new Error('Arena process group belongs to another host or boot; cannot prove stopped')
  }
  if (!group.pidNamespace || group.pidNamespace !== await readlink('/proc/self/ns/pid')) {
    throw new Error('Arena process group belongs to another PID namespace; cannot prove stopped')
  }
  const pids = await readdir('/proc')
  for (const name of pids) {
    if (!/^\d+$/u.test(name)) continue
    let fields: string[]
    try { fields = processFields(await readFile(`/proc/${name}/stat`, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (Number(fields[2]) !== group.pgid || fields[0] === 'Z' || fields[0] === 'X') continue
    throw new Error(`Arena process group ${group.pgid} still contains a live process`)
  }
}

export async function assertExecutorStopped(identity: ArenaProcessGroup): Promise<void> {
  if (process.platform !== 'linux' || !identity.bootId
    || identity.bootId !== (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    || !identity.pidNamespace || identity.pidNamespace !== await readlink('/proc/self/ns/pid')) {
    throw new Error('Executor host/boot/PID namespace identity cannot be verified')
  }
  let fields: string[]
  try { fields = processFields(await readFile(`/proc/${identity.pgid}/stat`, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (fields[19] === identity.leaderStartTicks && fields[0] !== 'Z' && fields[0] !== 'X') {
    throw new Error(`Executor process ${identity.pgid} is still running`)
  }
}

export async function trackedArenaGit(
  cwd: string, args: string[], input: string | undefined, signal: AbortSignal,
  limits: { stdout: number; stderr: number; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const record = arenaGroupRecorder.getStore()
  if (!record || process.platform !== 'linux') throw new ToolError('EACCES', 'Arena Git requires durable Linux process-group tracking')
  if (signal.aborted) throw new ToolError('ECANCELED', 'Arena Git aborted before launch')
  const worker = spawn(process.execPath, ['-e', ARENA_GIT_WORKER_SOURCE], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: '/usr/bin:/bin',
      ...(['worktree-add', 'probe-rev-parse'].includes(process.env.KALA_ARENA_TEST_PAUSE_GIT ?? '')
        ? { KALA_ARENA_TEST_PAUSE_GIT: process.env.KALA_ARENA_TEST_PAUSE_GIT } : {}),
    },
  })
  if (!worker.pid) throw new ToolError('EIO', 'Arena worker has no process identity')
  const group = await leaderIdentity(worker.pid)
  let stdout = '', stderr = '', timedOut = false
  const kill = () => { try { process.kill(-group.pgid, 'SIGKILL') } catch {} }
  const timeout = setTimeout(() => { timedOut = true; kill() }, limits.timeoutMs)
  signal.addEventListener('abort', kill, { once: true })
  worker.stdout!.on('data', (data: Buffer) => { stdout += data.toString('utf8'); if (stdout.length > limits.stdout) kill() })
  worker.stderr!.on('data', (data: Buffer) => { stderr += data.toString('utf8'); if (stderr.length > limits.stderr) kill() })
  const closed = new Promise<number>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('close', (code) => resolve(code ?? -1))
  })
  try {
    await record(group)
    if (signal.aborted) throw new ToolError('ECANCELED', 'Arena Git aborted before admission')
    await new Promise<void>((resolve, reject) => {
      worker.send({ cwd, args, input }, (error) => error ? reject(error) : resolve())
    })
    const code = await closed
    await assertGroupStopped(group)
    if (timedOut || signal.aborted || stdout.length > limits.stdout || stderr.length > limits.stderr) {
      throw new ToolError('EIO', 'Arena Git interrupted or output exceeded limits')
    }
    return { stdout, stderr, code }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', kill)
    if (worker.exitCode === null) kill()
    await closed.catch(() => undefined)
  }
}
