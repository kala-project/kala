import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { nextOccurrence } from './recurrence.js'
import { occurrenceSessionId, UnitScheduler, type ScheduledTaskExecutor } from './scheduler.js'
import { ScheduledTaskStore } from './store.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'kala-schedules-'))
  directories.push(path)
  return path
}

function executor(overrides: Partial<ScheduledTaskExecutor> = {}): ScheduledTaskExecutor {
  return {
    validate: vi.fn(async () => undefined),
    receipt: vi.fn(async () => 'absent'),
    enqueueSession: vi.fn(async () => undefined),
    createWorkspaceSession: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('scheduled task recurrence', () => {
  it('resolves daily and weekly wall-clock times in an IANA timezone', () => {
    expect(nextOccurrence(
      { kind: 'daily', timezone: 'America/New_York', hour: 9, minute: 30 },
      new Date('2026-07-01T13:31:00.000Z'),
    )?.toISOString()).toBe('2026-07-02T13:30:00.000Z')
    expect(nextOccurrence(
      { kind: 'weekly', timezone: 'Asia/Tokyo', daysOfWeek: [1], hour: 8, minute: 0 },
      new Date('2026-10-02T00:00:00.000Z'),
    )?.toISOString()).toBe('2026-10-04T23:00:00.000Z')
  })

  it('anchors every-N-days schedules to local calendar dates and skips a DST gap', () => {
    const schedule = { kind: 'interval' as const, timezone: 'America/New_York', hour: 2, minute: 30, everyDays: 2, startDate: '2026-03-08' }
    expect(nextOccurrence(schedule, new Date('2026-03-07T12:00:00.000Z'))?.toISOString()).toBe('2026-03-10T06:30:00.000Z')
    expect(nextOccurrence(schedule, new Date('2026-03-10T06:30:00.000Z'))?.toISOString()).toBe('2026-03-12T06:30:00.000Z')
  })

  it('skips nonexistent month dates and emits a repeated fall-back wall minute only once', () => {
    expect(nextOccurrence(
      { kind: 'monthly', timezone: 'UTC', hour: 10, minute: 0, daysOfMonth: [31] },
      new Date('2026-01-31T10:00:00.000Z'),
    )?.toISOString()).toBe('2026-03-31T10:00:00.000Z')
    expect(nextOccurrence(
      { kind: 'monthly', timezone: 'America/New_York', hour: 1, minute: 30, daysOfMonth: [1] },
      new Date('2026-11-01T05:30:00.000Z'),
    )?.toISOString()).toBe('2026-12-01T06:30:00.000Z')
  })

  it('strictly validates interval anchors and monthly date selections', () => {
    expect(() => nextOccurrence(
      { kind: 'interval', timezone: 'UTC', hour: 0, minute: 0, everyDays: 0, startDate: '2026-01-01' }, new Date(),
    )).toThrow('everyDays')
    expect(() => nextOccurrence(
      { kind: 'interval', timezone: 'UTC', hour: 0, minute: 0, everyDays: 2, startDate: '2026-02-30' }, new Date(),
    )).toThrow('YYYY-MM-DD')
    expect(() => nextOccurrence(
      { kind: 'monthly', timezone: 'UTC', hour: 0, minute: 0, daysOfMonth: [1, 1] }, new Date(),
    )).toThrow('unique integers')
  })
})

describe('Unit scheduler durability and isolation', () => {
  it('isolates owner reads, requires pause before delete, and fences a second writer', async () => {
    const path = await directory()
    const store = new ScheduledTaskStore(path, () => new Date('2026-10-02T09:00:00.000Z'))
    await store.start('unit-a')
    const task = await store.create({
      ownerKey: 'organization:a', createdBy: 'alice', prompt: 'hello', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    expect(await store.listTasks('organization:b')).toEqual([])
    await expect(store.delete('organization:a', task.id)).rejects.toThrow('paused')
    const competing = new ScheduledTaskStore(path)
    await expect(competing.start('unit-a')).rejects.toThrow('writer lease is already held')
    await store.setPaused('organization:a', task.id, true)
    expect(await store.delete('organization:a', task.id)).toBe(true)
    await store.close()
  })

  it('loads existing schema-v1 tasks and run snapshots without runtime legacy branches or rewriting state', async () => {
    const path = await directory()
    const state = {
      schemaVersion: 1, revision: 7,
      tasks: [{
        id: 'legacy-task', generation: 1, ownerKey: 'principal:p', createdBy: 'p', status: 'active', prompt: 'existing daily',
        target: { kind: 'session', sessionId: 's1' }, schedule: { kind: 'daily', timezone: 'UTC', hour: 10, minute: 0 },
        nextRunAt: '2026-10-03T10:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
      }],
      runs: [{
        occurrenceId: 'occ_existing', taskId: 'legacy-task', operationId: 'schedule_existing', scheduledFor: '2026-10-02T10:00:00.000Z',
        status: 'enqueued', claimedAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:01.000Z',
        task: { id: 'legacy-task', generation: 1, ownerKey: 'principal:p', createdBy: 'p', prompt: 'historical prompt', target: { kind: 'session', sessionId: 's1' } },
      }],
    }
    await writeFile(join(path, 'state.json'), JSON.stringify(state))
    const store = new ScheduledTaskStore(path)
    await store.start('u')
    expect(await store.listTasks('principal:p')).toMatchObject([{ id: 'legacy-task', schedule: { kind: 'daily' } }])
    expect(await store.history('principal:p', 'legacy-task')).toMatchObject([{ task: { prompt: 'historical prompt' } }])
    await store.close()
    expect(JSON.parse(await readFile(join(path, 'state.json'), 'utf8'))).toEqual(state)
  })

  it('claims each stable occurrence once and advances recurring definitions atomically', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const store = new ScheduledTaskStore(await directory(), () => now)
    await store.start('unit-a')
    const task = await store.create({
      ownerKey: 'principal:local', createdBy: 'local', prompt: 'daily', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'daily', timezone: 'UTC', hour: 10, minute: 0 },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    const first = await store.claim(task.id, task.nextRunAt!)
    expect(first?.operationId).toMatch(/^schedule_[a-f0-9]{40}$/u)
    expect(await store.claim(task.id, task.nextRunAt!)).toBeUndefined()
    expect((await store.getTask('principal:local', task.id))?.nextRunAt).toBe('2026-10-03T10:00:00.000Z')
    await store.close()
  })

  it('bounds recurring catchup to one executable occurrence and explicit skipped history', async () => {
    let now = new Date('2026-10-01T09:00:00.000Z')
    const store = new ScheduledTaskStore(await directory(), () => now)
    await store.start('u')
    const task = await store.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'daily', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'daily', timezone: 'UTC', hour: 10, minute: 0 },
    })
    now = new Date('2026-10-05T12:00:00.000Z')
    await store.claim(task.id, task.nextRunAt!)
    const history = await store.history('principal:p', task.id)
    expect(history.filter((run) => run.status === 'claimed')).toHaveLength(1)
    expect(history.filter((run) => run.status === 'skipped')).toHaveLength(4)
    expect((await store.getTask('principal:p', task.id))?.nextRunAt).toBe('2026-10-06T10:00:00.000Z')
    await store.close()
  })

  it('queues session targets and creates one deterministic Session for a workspace occurrence', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const path = await directory()
    const exec = executor()
    const scheduler = new UnitScheduler(new ScheduledTaskStore(path, () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await scheduler.start()
    const sessionTask = await scheduler.store.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'session prompt', target: { kind: 'session', sessionId: 'existing' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    const workspaceTask = await scheduler.store.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'workspace prompt', target: { kind: 'workspace', workspaceId: 'w1' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    await scheduler.tick()
    expect(exec.enqueueSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing', prompt: 'session prompt' }))
    const workspaceCall = vi.mocked(exec.createWorkspaceSession).mock.calls[0]![0]
    const run = (await scheduler.store.history('principal:p', workspaceTask.id))[0]!
    expect(workspaceCall.sessionId).toBe(occurrenceSessionId(run.occurrenceId))
    expect(workspaceCall.task.id).toBe(workspaceTask.id)
    expect((await scheduler.store.history('principal:p', sessionTask.id))[0]?.status).toBe('enqueued')
    await scheduler.stop()
  })

  it('reconciles a persisted claim before replay and marks unknown receipts needs-review', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const path = await directory()
    const firstStore = new ScheduledTaskStore(path, () => now)
    await firstStore.start('u')
    const task = await firstStore.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'recover', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    await firstStore.claim(task.id, task.nextRunAt!)
    await firstStore.close()

    const unknown = executor({ receipt: vi.fn(async () => 'unknown') })
    const restarted = new UnitScheduler(new ScheduledTaskStore(path, () => now), unknown, { unitId: 'u', pollMs: 60_000 })
    await restarted.start()
    expect(unknown.enqueueSession).not.toHaveBeenCalled()
    expect((await restarted.store.history('principal:p', task.id))[0]?.status).toBe('needs_review')
    await restarted.stop()
  })

  it('replays an authoritatively absent stale claim once with its stable operation ID', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const path = await directory()
    const first = new ScheduledTaskStore(path, () => now)
    await first.start('u')
    const task = await first.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'recover safely', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    const claim = await first.claim(task.id, task.nextRunAt!)
    await first.close()

    const exec = executor({ receipt: vi.fn(async () => 'absent') })
    const restarted = new UnitScheduler(new ScheduledTaskStore(path, () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await restarted.start()
    expect(exec.enqueueSession).toHaveBeenCalledTimes(1)
    expect(exec.enqueueSession).toHaveBeenCalledWith(expect.objectContaining({ operationId: claim!.operationId }))
    expect((await restarted.store.history('principal:p', task.id))[0]?.status).toBe('enqueued')
    await restarted.stop()
  })

  it('releases the writer lease when its process is force-killed', async () => {
    const path = await directory()
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `import { ScheduledTaskStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
       const store = new ScheduledTaskStore(${JSON.stringify(path)});
       await store.start('u');
       process.stdout.write('ready\\n');
       setInterval(() => {}, 60_000);`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
          if (stdout.includes('ready\n')) resolve()
        })
        child.stderr.on('data', (chunk: string) => { stderr += chunk })
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`lease child exited before ready (${code}): ${stderr}`)))
      })
      await expect(new ScheduledTaskStore(path).start('u')).rejects.toThrow('writer lease is already held')
      expect(child.kill('SIGKILL')).toBe(true)
      await exited

      const restarted = new ScheduledTaskStore(path)
      await restarted.start('u')
      await restarted.close()
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it('recovers and executes the immutable claimed snapshot, not a later task edit', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const path = await directory()
    const first = new ScheduledTaskStore(path, () => now)
    await first.start('u')
    const task = await first.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'original', target: { kind: 'session', sessionId: 'original-session' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    const run = await first.claim(task.id, task.nextRunAt!)
    await first.update('principal:p', task.id, { prompt: 'edited', target: { kind: 'session', sessionId: 'edited-session' } })
    await first.setPaused('principal:p', task.id, true)
    await expect(first.delete('principal:p', task.id)).rejects.toThrow('claimed occurrence')
    expect(run?.task).toMatchObject({ generation: 1, prompt: 'original', target: { sessionId: 'original-session' } })
    await first.close()

    const exec = executor()
    const restarted = new UnitScheduler(new ScheduledTaskStore(path, () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await restarted.start()
    expect(exec.enqueueSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'original-session', prompt: 'original' }))
    expect(await restarted.store.delete('principal:p', task.id)).toBe(true)
    expect(await restarted.store.history('principal:p', task.id)).toEqual([
      expect.objectContaining({ status: 'enqueued', task: expect.objectContaining({ prompt: 'original' }) }),
    ])
    await restarted.stop()
  })

  it('reports a transient poll error and schedules the next poll', async () => {
    const store = new ScheduledTaskStore(await directory())
    const due = vi.spyOn(store, 'due').mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValue([])
    const errors: unknown[] = []
    const scheduler = new UnitScheduler(store, executor(), { unitId: 'u', pollMs: 5, reportError: (error) => errors.push(error) })
    await scheduler.start()
    expect(errors).toEqual([expect.objectContaining({ message: 'temporary read failure' })])
    await vi.waitFor(() => expect(due.mock.calls.length).toBeGreaterThanOrEqual(2))
    await scheduler.stop()
  })

  it('does not produce a remote effect when owner fencing rejects a due claim', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const store = new ScheduledTaskStore(await directory(), () => now)
    const exec = executor()
    const errors: unknown[] = []
    const scheduler = new UnitScheduler(store, exec, { unitId: 'u', pollMs: 60_000, reportError: (error) => errors.push(error) })
    await scheduler.start()
    const task = await store.create({
      ownerKey: 'organization:a', createdBy: 'a', prompt: 'must stay local', target: { kind: 'session', sessionId: 'owned-elsewhere' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    vi.spyOn(store, 'claim').mockRejectedValue(new Error('Session owner fenced'))
    now = new Date('2026-10-02T10:00:00.000Z')
    await scheduler.tick()
    expect(errors).toEqual([expect.objectContaining({ message: 'Session owner fenced' })])
    expect(exec.validate).not.toHaveBeenCalled()
    expect(exec.enqueueSession).not.toHaveBeenCalled()
    expect(exec.createWorkspaceSession).not.toHaveBeenCalled()
    expect(await store.history('organization:a', task.id)).toEqual([])
    await scheduler.stop()
  })

  it('fails a due occurrence when execution-time target authorization no longer passes', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const exec = executor({ validate: vi.fn(async () => { throw new Error('session not found') }) })
    const scheduler = new UnitScheduler(new ScheduledTaskStore(await directory(), () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await scheduler.start()
    const task = await scheduler.store.create({
      ownerKey: 'organization:a', createdBy: 'a', prompt: 'blocked', target: { kind: 'session', sessionId: 'moved-to-another-unit' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    await scheduler.tick()
    expect(exec.enqueueSession).not.toHaveBeenCalled()
    expect((await scheduler.store.history('organization:a', task.id))?.[0]).toMatchObject({ status: 'failed', error: 'session not found' })
    await scheduler.stop()
  })

  it('does not replay a delivery whose admission may have succeeded before ACK loss', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    const path = await directory()
    const delivery = vi.fn(async () => { throw new Error('ACK lost after admission') })
    const exec = executor({ enqueueSession: delivery, receipt: vi.fn(async () => 'unknown') })
    const scheduler = new UnitScheduler(new ScheduledTaskStore(path, () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await scheduler.start()
    const task = await scheduler.store.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'once', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    await scheduler.tick()
    expect((await scheduler.store.history('principal:p', task.id))?.[0]).toMatchObject({ status: 'needs_review', sessionId: 's1' })
    expect(delivery).toHaveBeenCalledTimes(1)
    await scheduler.stop()
    const restarted = new UnitScheduler(new ScheduledTaskStore(path, () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await restarted.start()
    expect(delivery).toHaveBeenCalledTimes(1)
    await restarted.stop()
  })

  it('keeps corrupt startup state fatal and releases the acquired lease', async () => {
    const path = await directory()
    await writeFile(join(path, 'state.json'), '{not-json')
    await expect(new ScheduledTaskStore(path).start('u')).rejects.toThrow()
    await rm(join(path, 'state.json'))
    const restarted = new ScheduledTaskStore(path)
    await restarted.start('u')
    await restarted.close()
  })

  it('waits for an active occurrence side effect during termination', async () => {
    let now = new Date('2026-10-02T09:00:00.000Z')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const exec = executor({ enqueueSession: vi.fn(async () => await blocked) })
    const path = await directory()
    const scheduler = new UnitScheduler(new ScheduledTaskStore(path, () => now), exec, { unitId: 'u', pollMs: 60_000 })
    await scheduler.start()
    await scheduler.store.create({
      ownerKey: 'principal:p', createdBy: 'p', prompt: 'wait', target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'once', at: '2026-10-02T10:00:00.000Z' },
    })
    now = new Date('2026-10-02T10:00:00.000Z')
    const ticking = scheduler.tick()
    await vi.waitFor(() => expect(exec.enqueueSession).toHaveBeenCalled())
    let stopped = false
    const stopping = scheduler.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    await expect(new ScheduledTaskStore(path).start('u')).rejects.toThrow('writer lease is already held')
    release()
    await Promise.all([ticking, stopping])
    expect(stopped).toBe(true)
    const replacement = new ScheduledTaskStore(path)
    await replacement.start('u')
    await replacement.close()
  })
})
