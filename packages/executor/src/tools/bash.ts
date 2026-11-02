import { spawn } from 'node:child_process'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalString,
  requireString,
} from './schema.js'
import { startBackgroundShell } from './background-shell.js'
import { selectShell, shellArgv, shellResourceLimitsFromEnv } from './shell-runtime.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 1_000_000

/**
 * Kill a spawned shell *and its descendants*. `child.kill()` signals only the
 * direct child; on Windows the child (`bash.exe`) spawns the actual command
 * (`sleep`, a compiler, …) as a grandchild that keeps the stdout pipe open, so
 * a bare kill leaves it running and `close` never fires until the command
 * exits on its own — timeoutMs and abort would hang for the full duration.
 * On win32 we hand the whole tree to `taskkill /T /F`. On POSIX, the
 * foreground shell owns a separate process group (without unref); kill that
 * group so waiting shells and their ordinary descendants close their pipes.
 * Descendants that explicitly create another session can escape this group.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    const pid = child.pid
    if (pid === undefined) {
      child.kill('SIGKILL')
      return
    }
    // Fire-and-forget; if taskkill itself can't run we still fall back to the
    // direct kill so the child is at least signalled.
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      }).on('error', () => child.kill('SIGKILL'))
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // The group may already have exited; still try the direct child.
    }
  }
  child.kill('SIGKILL')
}

async function runShell(input: Record<string, unknown>, ctx: Parameters<Tool['run']>[1]): Promise<string> {
    const command = requireString(input, 'command')
    if (command.trim().length === 0) {
      throw new ToolError('EINVAL', 'command is empty')
    }
    const cwdInput = optionalString(input, 'cwd')
    const runInBackground = optionalBoolean(input, 'run_in_background') ?? optionalBoolean(input, 'background') ?? false
    const captureSeparateStreams = optionalBoolean(input, 'capture_separate_streams') ?? false
    const shell = selectShell(optionalString(input, 'shell'))
    const timeoutMs = bashTimeoutMs(input) ?? DEFAULT_TIMEOUT_MS
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(ctx.env ?? {}),
      KALA_SESSION_ID: ctx.sessionId,
      KALA_CALL_ID: ctx.callId,
    }

    const cwd = cwdInput ?? ctx.cwd ?? ctx.sandbox.roots[0] ?? process.cwd()
    let resolvedCwd: string
    try {
      resolvedCwd = await ctx.sandbox.resolve(cwd, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('EACCES', 'cwd outside workspace')
      }
      throw err
    }

    // Race #1: caller aborted before spawn. Short-circuit so we don't leak
    // a subprocess whose only outcome would be an immediate SIGKILL.
    if (ctx.signal.aborted) {
      return captureSeparateStreams
        ? JSON.stringify({ stdout: '', stderr: 'aborted before spawn', exitCode: null, signal: 'ABORT', durationMs: 0 })
        : `--- exit code: -1, duration: 0ms\n--- aborted before spawn`
    }

    if (runInBackground) {
      const task = await startBackgroundShell({ sessionId: ctx.sessionId, command, cwd: resolvedCwd, env, shell })
      return JSON.stringify({
        taskId: task.taskId,
        note: 'started',
        ...(task.pid !== undefined ? { pid: task.pid } : {}),
      })
    }

    return await new Promise<string>((resolve) => {
      const start = Date.now()
      let settled = false
      const settle = (payload: string): void => {
        if (settled) return
        settled = true
        resolve(payload)
      }

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(shell.executable, shellArgv(shell, command, shellResourceLimitsFromEnv(env)), {
          cwd: resolvedCwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        })
      } catch (err) {
        // Synchronous spawn failure (e.g. cwd disappeared between resolve and
        // spawn). Report as a status marker so the LLM can react rather than
        // the loop hanging on an unresolved promise.
        const msg = err instanceof Error ? err.message : String(err)
        settle(captureSeparateStreams
          ? JSON.stringify({ stdout: '', stderr: `spawn failed: ${msg}`, exitCode: null, signal: null, durationMs: 0 })
          : `--- exit code: -1, duration: 0ms\n--- spawn failed: ${msg}`)
        return
      }

      const chunks: Buffer[] = []
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let bytes = 0
      let stdoutTruncated = false
      let stderrTruncated = false
      let killedByTimeout = false
      let killedByAbort = false

      const onData = (target: 'stdout' | 'stderr', buf: Buffer): void => {
        if (bytes >= MAX_OUTPUT) {
          if (target === 'stdout') stdoutTruncated = true
          else stderrTruncated = true
          return
        }
        const room = MAX_OUTPUT - bytes
        const slice = buf.length > room ? buf.subarray(0, room) : buf
        if (captureSeparateStreams) {
          if (target === 'stdout') stdoutChunks.push(slice)
          else stderrChunks.push(slice)
        } else {
          chunks.push(slice)
        }
        bytes += slice.length
        if (slice.length < buf.length) {
          if (target === 'stdout') stdoutTruncated = true
          else stderrTruncated = true
        }
      }
      child.stdout?.on('data', (buf: Buffer) => onData('stdout', buf))
      child.stderr?.on('data', (buf: Buffer) => onData('stderr', buf))

      const timer = setTimeout(() => {
        killedByTimeout = true
        killTree(child)
      }, timeoutMs)

      const abortListener = (): void => {
        killedByAbort = true
        killTree(child)
      }
      ctx.signal.addEventListener('abort', abortListener, { once: true })

      const cleanup = (): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abortListener)
      }

      // Async spawn failure (ENOENT for missing bash binary, EACCES on cwd,
      // etc.). Without this listener the promise would never resolve.
      child.on('error', (err) => {
        cleanup()
        const msg = err instanceof Error ? err.message : String(err)
        const duration = Date.now() - start
        settle(captureSeparateStreams
          ? JSON.stringify({ stdout: '', stderr: `spawn failed: ${msg}`, exitCode: null, signal: null, durationMs: duration })
          : `--- exit code: -1, duration: ${duration}ms\n--- spawn failed: ${msg}`)
      })

      child.on('close', (code, signal) => {
        cleanup()
        const duration = Date.now() - start
        const output = Buffer.concat(chunks).toString('utf8')
        if (captureSeparateStreams) {
          settle(JSON.stringify({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: code,
            signal,
            durationMs: duration,
            stdoutTruncated,
            stderrTruncated,
            timedOut: killedByTimeout,
            aborted: killedByAbort,
          }))
          return
        }
        // Exit code is null when the child was killed by a signal. Preserve
        // the distinction so callers can tell abort/timeout apart from a
        // clean non-zero exit.
        const exitLabel = code ?? (signal ? `signal:${signal}` : -1)
        const status = `--- exit code: ${exitLabel}, duration: ${duration}ms`
        const trailer = killedByTimeout
          ? `\n--- killed after ${timeoutMs}ms (timeout)`
          : killedByAbort
            ? `\n--- aborted`
            : ''
        settle(`${output}${status}${trailer}`)
      })
    })
}

export const shellTool: Tool = { name: 'shell', run: runShell }
export const bashTool: Tool = { name: 'bash', run: runShell }

function bashTimeoutMs(input: Record<string, unknown>): number | undefined {
  const timeoutSeconds =
    optionalPositiveInt(input, 'timeout_seconds', 1) ??
    optionalPositiveInt(input, 'timeoutSeconds', 1)
  if (timeoutSeconds !== undefined) return timeoutSeconds * 1000
  return (
    optionalPositiveInt(input, 'timeout_ms', 100) ??
    optionalPositiveInt(input, 'timeoutMs', 100)
  )
}
