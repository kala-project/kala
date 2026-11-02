/**
 * Hooks system.
 *
 * Users configure "when event X happens, run command Y" in
 * `~/.config/kala/config.toml`. Supported events:
 *   - `pre_tool_use`   fired before every tool dispatch. Non-zero exit blocks
 *                      the tool call: the loop synthesizes a `tool_result`
 *                      with `ok: false` instead of dispatching to the executor.
 *   - `post_tool_use`  fired after every tool dispatch. Result is not blocking.
 *   - `session_start`  fired when a new session is created.
 *   - `session_end`    fired when a session is deleted.
 *
 * Each hook receives a JSON payload on stdin; the exit code decides whether the
 * event was allowed to proceed. Stdout is captured and surfaced in the tool
 * result when a hook blocks. Modeled after git hooks.
 */

import { spawn } from 'node:child_process'

export type HookEvent =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'session_start'
  | 'session_end'

export type HookConfig = {
  event: HookEvent
  command: string
  match?: string
}

export type HookPayload = {
  event: HookEvent
  sessionId: string
  workspaceId?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: {
    ok: boolean
    content: string
  }
}

export type HookOutcome = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export type HookRunner = {
  run(hook: HookConfig, payload: HookPayload): Promise<HookOutcome>
}

const DEFAULT_TIMEOUT_MS = 15_000

export function createHookRunner(
  opts: { timeoutMs?: number } = {},
): HookRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async run(hook, payload) {
      return await runOne(hook, payload, timeoutMs)
    },
  }
}

async function runOne(
  hook: HookConfig,
  payload: HookPayload,
  timeoutMs: number,
): Promise<HookOutcome> {
  return new Promise<HookOutcome>((resolve) => {
    const child = spawn(hook.command, [], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // An immediately rejecting hook may close stdin before reading its payload.
      // Its exit status still decides the outcome.
      if (error.code === 'EPIPE') return
      stderrChunks.push(Buffer.from(error.message))
      finish(-1)
    })
    let done = false
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      if (done) return
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore — process may already be gone
      }
    }, timeoutMs)

    const finish = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout,
        stderr: timedOut
          ? stderr.length > 0
            ? `${stderr}\nhook exceeded ${timeoutMs}ms timeout`
            : `hook exceeded ${timeoutMs}ms timeout`
          : stderr,
      })
    }

    child.on('error', (err) => {
      stderrChunks.push(Buffer.from(String(err.message ?? err)))
      finish(-1)
    })
    // Use `exit` (fires when the process exits) rather than `close` (fires
    // when stdio streams close). On SIGKILL, `close` may never come because
    // the parent's pipe end-of-file signalling can be lost; `exit` still
    // fires with signal='SIGKILL'.
    child.on('exit', (code, signal) => {
      // Small delay so any final chunks emitted to stdout/stderr just before
      // exit still land in our buffers.
      setTimeout(() => finish(code ?? (signal ? -1 : 0)), 10)
    })

    try {
      child.stdin.end(JSON.stringify(payload))
    } catch {
      // Child may already be gone (spawn error path); the close/error handler
      // above will surface the failure.
    }
  })
}

/**
 * Filter hooks for an event + optional tool name. `match` is a simple exact
 * string; if absent the hook applies to every occurrence of the event.
 */
export function selectHooks(
  hooks: readonly HookConfig[],
  event: HookEvent,
  toolName?: string,
): readonly HookConfig[] {
  return hooks.filter((h) => {
    if (h.event !== event) return false
    if (h.match === undefined || h.match === '') return true
    if (toolName === undefined) return false
    return h.match === toolName
  })
}
