import { mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bashTool, shellTool } from './bash.js'
import { processTool } from './process.js'
import {
  __backgroundTaskLogPathForTests,
  __resetBackgroundShellRegistryForTests,
  evictBackgroundShellNow,
  startBackgroundShell,
  subscribeBackgroundTasks,
} from './background-shell.js'
import { makeCtx, makeTempWorkspace } from './_test-helpers.js'

describe('shell yield_time_ms and process tool', () => {
  let root: string

  beforeEach(() => {
    root = makeTempWorkspace('ak-process-')
    __resetBackgroundShellRegistryForTests()
  })

  afterEach(() => {
    __resetBackgroundShellRegistryForTests()
    rmSync(root, { recursive: true, force: true })
  })

  it('returns standard foreground output when command finishes within yield_time_ms', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-fast' }
    const out = await shellTool.run(
      { command: 'printf "quick-done\\n"', yield_time_ms: 2_000 },
      ctx,
    )

    expect(out).toContain('quick-done')
    expect(out).toContain('--- exit code: 0')

    // Transient task should be evicted immediately so list is empty.
    const listOut = JSON.parse(await processTool.run({ action: 'list' }, ctx)) as {
      count: number
      tasks: unknown[]
    }
    expect(listOut.count).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('keeps task output in a private temporary directory and file', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-private-log' }
    const started = JSON.parse(await shellTool.run({
      command: 'printf private',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const path = __backgroundTaskLogPathForTests(started.taskId)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('rejects a background launch cancelled before spawning', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-pre-abort' }
    const controller = new AbortController()
    controller.abort()
    await expect(shellTool.run(
      { command: 'sleep 5', run_in_background: true },
      { ...ctx, signal: controller.signal },
    )).rejects.toThrow(/ECANCELED/)
    expect(JSON.parse(await processTool.run({ action: 'list' }, ctx))).toMatchObject({ count: 0 })
  })

  it('rejects a background launch cancelled immediately after spawn and retains unconfirmed task IDs', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-post-abort' }
    const controller = new AbortController()
    let taskId = ''
    const unsubscribe = subscribeBackgroundTasks((change) => {
      if (change.kind === 'spawned' && change.task.sessionId === ctx.sessionId) {
        taskId = change.task.taskId
        controller.abort()
      }
    })

    try {
      let error = ''
      try {
        await shellTool.run(
          { command: 'sleep 5', run_in_background: true },
          { ...ctx, signal: controller.signal },
        )
      } catch (caught) {
        error = String(caught)
      }
      expect(taskId).toBeTruthy()
      expect(error).toContain('ECANCELED')
      const tasks = JSON.parse(await processTool.run({ action: 'list' }, ctx)) as {
        tasks: Array<{ taskId: string }>
      }
      if (error.includes('termination unconfirmed')) {
        expect(error).toContain(taskId)
        expect(tasks.tasks).toEqual([expect.objectContaining({ taskId })])
      } else {
        expect(tasks.tasks).toEqual([])
      }
    } finally {
      unsubscribe()
    }
  })

  it.skipIf(process.platform === 'win32')('retains the task when post-spawn termination cannot be confirmed', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-unconfirmed-abort' }
    const controller = new AbortController()
    let taskId = ''
    const unsubscribe = subscribeBackgroundTasks((change) => {
      if (change.kind === 'spawned' && change.task.sessionId === ctx.sessionId) {
        taskId = change.task.taskId
        controller.abort()
      }
    })
    const originalKill = process.kill.bind(process)
    const mockedKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
      pid < 0 ? true : originalKill(pid, signal))
    try {
      await expect(shellTool.run(
        { command: 'sleep 5', run_in_background: true },
        { ...ctx, signal: controller.signal },
      )).rejects.toThrow(/ECANCELED:.*termination unconfirmed/)
      expect(taskId).toBeTruthy()
      expect(JSON.parse(await processTool.run({ action: 'list' }, ctx))).toMatchObject({
        tasks: [expect.objectContaining({ taskId, status: 'running' })],
      })
    } finally {
      mockedKill.mockRestore()
      unsubscribe()
      if (taskId) await processTool.run({ action: 'kill', task_id: taskId, signal: 'SIGKILL' }, ctx)
    }
  })

  it('auto-backgrounds when command exceeds yield_time_ms and supports incremental polling', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-yield' }
    const started = await shellTool.run(
      {
        command: 'printf "phase-1\\n"; sleep 0.35; printf "phase-2\\n"',
        yield_time_ms: 100,
      },
      ctx,
    )

    const yielded = JSON.parse(started) as {
      status: string
      yielded: boolean
      taskId: string
      pid?: number
      output: string
      nextOffset: number
    }
    expect(yielded.yielded).toBe(true)
    expect(yielded.status).toBe('running')
    expect(yielded.taskId).toBeTruthy()
    expect(yielded.output).toContain('phase-1')

    const listOut = JSON.parse(await processTool.run({ action: 'list' }, ctx)) as {
      count: number
      tasks: Array<{ taskId: string; status: string }>
    }
    expect(listOut.count).toBe(1)
    expect(listOut.tasks[0]?.taskId).toBe(yielded.taskId)

    const polled = JSON.parse(
      await processTool.run(
        {
          action: 'poll',
          task_id: yielded.taskId,
          offset: yielded.nextOffset,
          block: true,
          wait_for_output: false,
          timeout_ms: 2_000,
        },
        ctx,
      ),
    ) as {
      content: string
      done: boolean
      status: string
      exitCode: number | null
    }
    expect(polled.content).toContain('phase-2')
    expect(polled.done).toBe(true)
    expect(polled.status).toBe('exited')
    expect(polled.exitCode).toBe(0)
  })

  it('supports interactive stdin write and immediate output polling via process tool', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-interactive', shellApprovalVerified: true }
    const started = JSON.parse(
      await bashTool.run(
        {
          command: 'while IFS= read -r line; do printf "ack:%s\\n" "$line"; done; printf "stdin-closed\\n"',
          run_in_background: true,
        },
        ctx,
      ),
    ) as { taskId: string }

    const write1 = JSON.parse(
      await processTool.run(
        {
          action: 'write',
          task_id: started.taskId,
          input: 'hello-agent\n',
        },
        ctx,
      ),
    ) as { writtenBytes: number; eof: boolean }
    expect(write1.writtenBytes).toBeGreaterThan(0)
    expect(write1.eof).toBe(false)

    const poll1 = JSON.parse(
      await processTool.run(
        {
          action: 'poll',
          task_id: started.taskId,
          offset: 0,
          block: true,
          timeout_ms: 2_000,
        },
        ctx,
      ),
    ) as { content: string; nextOffset: number; done: boolean }
    expect(poll1.content).toContain('ack:hello-agent')

    const write2 = JSON.parse(
      await processTool.run(
        {
          action: 'write',
          task_id: started.taskId,
          input: 'final-line\n',
          eof: true,
        },
        ctx,
      ),
    ) as { eof: boolean }
    expect(write2.eof).toBe(true)

    const poll2 = JSON.parse(
      await processTool.run(
        {
          action: 'poll',
          task_id: started.taskId,
          offset: poll1.nextOffset,
          block: true,
          wait_for_output: false,
          timeout_ms: 2_000,
        },
        ctx,
      ),
    ) as { content: string; done: boolean; exitCode: number | null }
    expect(poll2.content).toContain('ack:final-line')
    expect(poll2.content).toContain('stdin-closed')
    expect(poll2.done).toBe(true)
    expect(poll2.exitCode).toBe(0)
  })

  it('enforces foreground timeout when shorter than yield window', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-timeout' }
    const start = Date.now()
    const out = await shellTool.run(
      { command: 'sleep 5', yield_time_ms: 2_000, timeout_ms: 100 },
      ctx,
    )
    expect(Date.now() - start).toBeLessThan(1_500)
    expect(out).toContain('killed after 100ms (timeout)')
    expect(JSON.parse(await processTool.run({ action: 'list' }, ctx))).toMatchObject({ count: 0 })
  })

  it.skipIf(process.platform === 'win32')('bounds poll responses without skipping unread bytes', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-budget', shellApprovalVerified: true }
    const started = JSON.parse(await shellTool.run({
      command: 'node -e \'process.stdout.write("x".repeat(1200000))\'',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const first = JSON.parse(await processTool.run({
      action: 'poll', task_id: started.taskId, block: true, wait_for_output: false,
    }, ctx)) as { content: string; nextOffset: number; hasMore: boolean; done: boolean }
    expect(first.content.length).toBe(1_000_000)
    expect(first.nextOffset).toBe(1_000_000)
    expect(first.hasMore).toBe(true)
    expect(first.done).toBe(true)
    const second = JSON.parse(await processTool.run({
      action: 'poll', task_id: started.taskId, offset: first.nextOffset,
    }, ctx)) as { content: string; hasMore: boolean }
    expect(second.content.length).toBe(200_000)
    expect(second.hasMore).toBe(false)
  })

  it.each([true, false])('fails a cancelled blocking poll with ECANCELED (wait_for_output=%s)', async (waitForOutput) => {
    const ctx = { ...makeCtx(root), sessionId: `sess-poll-abort-${waitForOutput}` }
    const started = JSON.parse(await shellTool.run({
      command: 'cat',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = processTool.run({
      action: 'poll', task_id: started.taskId, block: true, wait_for_output: waitForOutput, timeout_ms: 3_000,
    }, { ...ctx, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      await expect(pending).rejects.toThrow(/ECANCELED/)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(JSON.parse(await processTool.run({ action: 'list' }, ctx))).toMatchObject({
        tasks: [expect.objectContaining({ taskId: started.taskId, status: 'running' })],
      })
    } finally {
      clearTimeout(timer)
    }
  })

  it('orders concurrent stdin and EOF', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-order' }
    const started = JSON.parse(await shellTool.run({
      command: 'cat',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const [written, closed] = await Promise.all([
      processTool.run({ action: 'write', task_id: started.taskId, input: 'ordered\n' }, ctx),
      processTool.run({ action: 'write', task_id: started.taskId, eof: true }, ctx),
    ])
    expect(JSON.parse(written)).toMatchObject({ writtenBytes: 8 })
    expect(JSON.parse(closed)).toMatchObject({ eof: true })
    const output = JSON.parse(await processTool.run({
      action: 'poll', task_id: started.taskId, block: true, wait_for_output: false,
    }, ctx)) as { content: string; done: boolean }
    expect(output.content).toContain('ordered')
    expect(output.done).toBe(true)
  })

  it('rejects yield with separate stream capture instead of silently ignoring yield', async () => {
    await expect(shellTool.run({
      command: 'sleep 5', yield_time_ms: 50, capture_separate_streams: true,
    }, makeCtx(root))).rejects.toThrow(/does not support capture_separate_streams/)
  })

  it('records a failed spawn exactly once and completes blocked polls', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-spawn-error' }
    let ended = 0
    const unsubscribe = subscribeBackgroundTasks((change) => {
      if (change.kind === 'ended') ended++
    })
    try {
      const task = await startBackgroundShell({
        sessionId: ctx.sessionId,
        command: 'ignored',
        cwd: root,
        shell: { family: 'sh', executable: `${root}/nonexistent-shell` },
      })
      const output = JSON.parse(await processTool.run({
        action: 'poll', task_id: task.taskId, block: true, timeout_ms: 2_000,
      }, ctx)) as { content: string; done: boolean; status: string }
      expect(output.done).toBe(true)
      expect(output.status).toBe('signaled')
      expect(output.content).toContain('[spawn error]')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(ended).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('surfaces background log write failure instead of reporting missing bytes as success', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-log-failure' }
    const started = JSON.parse(await shellTool.run({
      command: 'sleep 0.1; printf payload',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const path = __backgroundTaskLogPathForTests(started.taskId)
    rmSync(path)
    mkdirSync(path)
    await expect(processTool.run({
      action: 'poll', task_id: started.taskId, block: true, timeout_ms: 2_000,
    }, ctx)).rejects.toThrow(/output unavailable: log I\/O failed/)
    const list = JSON.parse(await processTool.run({ action: 'list' }, ctx)) as {
      tasks: Array<{ taskId: string; outputError?: string }>
    }
    expect(list.tasks[0]).toMatchObject({
      taskId: started.taskId,
      outputError: expect.stringContaining('log I/O failed'),
    })
  })

  it('fails a poll when its log file disappears instead of returning empty output', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-log-read-failure' }
    const started = JSON.parse(await shellTool.run({
      command: 'cat',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    rmSync(__backgroundTaskLogPathForTests(started.taskId))
    await expect(processTool.run({
      action: 'poll', task_id: started.taskId,
    }, ctx)).rejects.toThrow(/output unavailable:.*ENOENT/)
  })

  it('refuses to evict a running task', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-no-running-evict' }
    const started = JSON.parse(await shellTool.run({
      command: 'cat',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    await expect(evictBackgroundShellNow(started.taskId, ctx.sessionId)).rejects.toThrow(/cannot evict running/)
    expect(JSON.parse(await processTool.run({ action: 'list' }, ctx))).toMatchObject({
      tasks: [expect.objectContaining({ taskId: started.taskId, status: 'running' })],
    })
  })

  it.skipIf(process.platform === 'win32')('does not report a completed write after an in-flight cancellation', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-write-abort' }
    const started = JSON.parse(await shellTool.run({
      command: 'sleep 0.15; cat >/dev/null',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const controller = new AbortController()
    const writing = processTool.run({
      action: 'write', task_id: started.taskId, input: 'x'.repeat(1_000_000),
    }, { ...ctx, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(writing).rejects.toThrow(new RegExp(`ECANCELED:.*${started.taskId}`))
  })

  it.skipIf(process.platform === 'win32')('does not report a completed kill after an in-flight cancellation', async () => {
    const ctx = { ...makeCtx(root), sessionId: 'sess-kill-abort' }
    const started = JSON.parse(await shellTool.run({
      command: 'sleep 5',
      run_in_background: true,
    }, ctx)) as { taskId: string }
    const controller = new AbortController()
    const originalKill = process.kill.bind(process)
    const mockedKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0) controller.abort()
      return originalKill(pid, signal)
    })
    try {
      await expect(processTool.run({
        action: 'kill', task_id: started.taskId, signal: 'SIGKILL',
      }, { ...ctx, signal: controller.signal })).rejects.toThrow(
        new RegExp(`ECANCELED:.*${started.taskId}`),
      )
    } finally {
      mockedKill.mockRestore()
    }
  })

  it('enforces strict session isolation across list, poll, write, and kill', async () => {
    const sessionA = { ...makeCtx(root), sessionId: 'session-alpha' }
    const sessionB = { ...makeCtx(root), sessionId: 'session-beta' }

    const started = JSON.parse(
      await shellTool.run(
        { command: 'sleep 5', run_in_background: true },
        sessionA,
      ),
    ) as { taskId: string }

    // Session B sees 0 tasks in its list
    const listB = JSON.parse(await processTool.run({ action: 'list' }, sessionB)) as { count: number }
    expect(listB.count).toBe(0)

    // Session B cannot poll, write, or kill Session A's task
    await expect(
      processTool.run({ action: 'poll', task_id: started.taskId }, sessionB),
    ).rejects.toThrow(/unknown background task/)
    await expect(
      processTool.run({ action: 'write', task_id: started.taskId, input: 'hi\n' }, sessionB),
    ).rejects.toThrow(/unknown background task/)
    await expect(
      processTool.run({ action: 'kill', task_id: started.taskId }, sessionB),
    ).rejects.toThrow(/unknown background task/)

    // Session A can kill its own task with SIGKILL
    const killed = JSON.parse(
      await processTool.run(
        { action: 'kill', task_id: started.taskId, signal: 'SIGKILL' },
        sessionA,
      ),
    ) as { killed: boolean; signal: string }
    expect(killed).toEqual({
      taskId: started.taskId,
      signal: 'SIGKILL',
      killed: true,
    })
  })
})
