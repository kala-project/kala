import { mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bashTool, shellTool } from './bash.js'
import { bashOutputTool } from './bash-output.js'
import { killShellTool } from './kill-shell.js'
import { makeCtx, makeCtxWithCwd, makeTempWorkspace, normalizePath } from './_test-helpers.js'
import { createSandbox } from '../sandbox.js'

describe('bash', () => {
  let root: string
  beforeEach(() => {
    root = makeTempWorkspace('ak-bash-')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('runs a command and returns stdout + exit code', async () => {
    const out = await bashTool.run(
      { command: 'echo hello' },
      makeCtx(root),
    )
    expect(out).toContain('hello')
    expect(out).toContain('--- exit code: 0')
  })

  it('captures non-zero exit codes without ok:false semantics', async () => {
    const out = await bashTool.run(
      { command: 'sh -c "exit 3"' },
      makeCtx(root),
    )
    expect(out).toContain('--- exit code: 3')
  })

  it('optionally returns separate stdout and stderr for operator shell escapes', async () => {
    const out = await bashTool.run(
      { command: 'printf out; printf err >&2; exit 7', capture_separate_streams: true },
      makeCtx(root),
    )

    expect(JSON.parse(out)).toMatchObject({
      stdout: 'out',
      stderr: 'err',
      exitCode: 7,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
  })

  it('runs commands from the session cwd when no tool-local cwd is supplied', async () => {
    const child = join(root, 'child')
    mkdirSync(child)

    const out = await bashTool.run(
      { command: 'pwd' },
      makeCtxWithCwd(root, child),
    )

    expect(normalizePath(out.split('\n')[0]!)).toBe(normalizePath(child))
    expect(out).toContain('--- exit code: 0')
  })

  it('uses ctx.env for shell HOME expansion', async () => {
    const out = await bashTool.run(
      { command: 'printf "%s\n" ~' },
      { ...makeCtx(root), env: { ...process.env, HOME: root } },
    )

    expect(normalizePath(out.split('\n')[0]!)).toBe(normalizePath(root))
    expect(out).toContain('--- exit code: 0')
  })

  it('injects immutable Session and call identities into deployment shell processes', async () => {
    const out = await shellTool.run(
      { command: 'printf "%s\n%s\n" "$KALA_SESSION_ID" "$KALA_CALL_ID"' },
      {
        ...makeCtx(root),
        sessionId: 'session-origin-shell',
        callId: 'call-origin-shell',
        env: { ...process.env, KALA_SESSION_ID: 'forged-session', KALA_CALL_ID: 'forged-call' },
      },
    )

    expect(out.split('\n').slice(0, 2)).toEqual(['session-origin-shell', 'call-origin-shell'])
    expect(out).toContain('--- exit code: 0')
  })

  it('allows the workspace root itself as cwd', async () => {
    const out = await bashTool.run(
      { command: 'pwd', cwd: root },
      makeCtx(root),
    )

    expect(normalizePath(out.split('\n')[0]!)).toBe(normalizePath(root))
    expect(out).toContain('--- exit code: 0')
  })

  it('uses the session cwd instead of process.cwd() when no sandbox root is configured', async () => {
    const out = await bashTool.run(
      { command: 'pwd' },
      {
        sandbox: createSandbox({ roots: [] }),
        cwd: root,
        signal: new AbortController().signal,
      },
    )

    expect(normalizePath(out.split('\n')[0]!)).toBe(normalizePath(root))
    expect(normalizePath(out.split('\n')[0]!)).not.toBe(normalizePath(process.cwd()))
    expect(out).toContain('--- exit code: 0')
  })

  it.skipIf(process.platform === 'win32').each(['timeout', 'abort'])('terminates the POSIX foreground group on %s, not just the waiting shell', async (reason) => {
    const controller = new AbortController()
    const timer = reason === 'abort' ? setTimeout(() => controller.abort(), 100) : undefined
    try {
      const out = JSON.parse(await bashTool.run(
        { shell: 'sh', command: 'sleep 2 & wait', timeoutMs: reason === 'timeout' ? 100 : 5_000, capture_separate_streams: true },
        makeCtx(root, controller.signal),
      ))
      expect(out.timedOut).toBe(reason === 'timeout')
      expect(out.aborted).toBe(reason === 'abort')
      expect(out.durationMs).toBeLessThan(1_000)
    } finally {
      clearTimeout(timer)
    }
  })

  it('honours timeoutMs by killing the process', async () => {
    const out = await bashTool.run(
      { command: 'sleep 5', timeoutMs: 200 },
      makeCtx(root),
    )
    expect(out).toContain('killed after 200ms (timeout)')
  })

  it('honours timeout_seconds from the public tool schema', async () => {
    const out = await bashTool.run(
      { command: 'sleep 5', timeout_seconds: 1 },
      makeCtx(root),
    )
    expect(out).toContain('killed after 1000ms (timeout)')
  })

  it('honours timeout_ms for older recorded tool calls', async () => {
    const out = await bashTool.run(
      { command: 'sleep 5', timeout_ms: 200 },
      makeCtx(root),
    )
    expect(out).toContain('killed after 200ms (timeout)')
  })

  it('rejects cwd outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ak-bash-out-'))
    try {
      await expect(
        bashTool.run({ command: 'true', cwd: outside }, makeCtx(root)),
      ).rejects.toThrow(/EACCES/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws EINVAL on an empty command', async () => {
    await expect(
      bashTool.run({ command: '  ' }, makeCtx(root)),
    ).rejects.toThrow(/EINVAL/)
  })

  it('short-circuits when the signal is already aborted (no hang, no spawn)', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const start = Date.now()
    const out = await bashTool.run(
      { command: 'sleep 30' },
      makeCtx(root, ctrl.signal),
    )
    expect(Date.now() - start).toBeLessThan(200)
    expect(out).toContain('aborted before spawn')
    expect(out).toContain('--- exit code: -1')
  })

  it('reports mid-run abort as a status marker instead of hanging', async () => {
    const ctrl = new AbortController()
    const promise = bashTool.run(
      { command: 'sleep 5', timeoutMs: 10_000 },
      makeCtx(root, ctrl.signal),
    )
    // Give the process a moment to actually start, then abort.
    await new Promise((r) => setTimeout(r, 50))
    ctrl.abort()
    const out = await promise
    expect(out).toContain('--- aborted')
    // Should not have been treated as a timeout kill.
    expect(out).not.toContain('(timeout)')
  })

  it('falls back to process.cwd() when no sandbox root and no cwd input', async () => {
    const out = await bashTool.run(
      { command: 'pwd' },
      {
        sandbox: createSandbox({ roots: [] }),
        signal: new AbortController().signal,
      },
    )
    expect(normalizePath(out)).toContain(normalizePath(process.cwd()))
    expect(out).toContain('--- exit code: 0')
  })

  it('resolves with a spawn-failure marker when the child errors', async () => {
    // Point cwd inside the workspace, but delete it after resolve() so spawn
    // trips ENOENT asynchronously. This is the exact class of failure the
    // old code silently swallowed (child.on('error') was never wired).
    const doomed = mkdtempSync(join(root, 'doomed-'))
    rmSync(doomed, { recursive: true, force: true })
    const out = await bashTool.run(
      { command: 'echo hi', cwd: doomed },
      makeCtx(root),
    )
    expect(out).toContain('spawn failed')
    expect(out).toContain('--- exit code: -1')
  })

  it('starts a background task and reads output later', async () => {
    const started = await bashTool.run(
      { command: 'sleep 0.2; echo done', run_in_background: true },
      makeCtx(root),
    )
    const parsed = JSON.parse(started) as { taskId: string; pid?: number }
    expect(parsed.taskId).toBeTruthy()
    expect(parsed.pid).toEqual(expect.any(Number))

    const first = JSON.parse(
      await bashOutputTool.run(
        { task_id: parsed.taskId, block: false },
        makeCtx(root),
      ),
    ) as { content: string; nextOffset: number; done: boolean }
    expect(first.content).toBe('')
    expect(first.done).toBe(false)

    const second = JSON.parse(
      await bashOutputTool.run(
        { task_id: parsed.taskId, block: true, timeout_ms: 1000 },
        makeCtx(root),
      ),
    ) as { content: string; done: boolean }
    expect(second.content).toContain('done')
    expect(second.done).toBe(true)
  })

  it('scopes background task reads and kills to the owning session', async () => {
    const owner = { ...makeCtx(root), sessionId: 'session-a' }
    const sibling = { ...makeCtx(root), sessionId: 'session-b' }
    const started = await bashTool.run(
      { command: 'sleep 1; echo hidden', run_in_background: true },
      owner,
    )
    const parsed = JSON.parse(started) as { taskId: string }

    await expect(
      bashOutputTool.run({ task_id: parsed.taskId, block: false }, sibling),
    ).rejects.toThrow(/unknown background task/)
    await expect(
      killShellTool.run({ task_id: parsed.taskId }, sibling),
    ).rejects.toThrow(/unknown background task/)

    const killed = JSON.parse(await killShellTool.run({ task_id: parsed.taskId }, owner)) as { killed: boolean }
    expect(killed.killed).toBe(true)
  })
})
