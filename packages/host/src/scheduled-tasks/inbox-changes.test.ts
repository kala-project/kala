import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ScheduledTaskStore } from './store.js'
import { SqliteScheduledTaskStore } from './sqlite-store.js'
import { changedInboxes, inboxSignatures } from './inbox-changes.js'
import { canReceiveInboxChange } from './dashboard-inbox.js'

it.each(['json', 'sqlite'])('notifies only committed visible Inbox/receipt changes (%s)', async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), 'inbox-change-'))
  const store = kind === 'json' ? new ScheduledTaskStore(directory) : new SqliteScheduledTaskStore(join(directory, 'state.sqlite'))
  const changes = vi.fn()
  await store.start('unit')
  const stop = await store.onInboxChange(changes)
  try {
    const task = await store.create({
      ownerKey: 'organization:a', createdBy: 'alice', prompt: 'Scheduled',
      target: { kind: 'session', sessionId: 's1' },
      schedule: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    })
    await store.setPaused(task.ownerKey, task.id, true)
    await store.setPaused(task.ownerKey, task.id, false)
    const run = await store.claim(task.id, task.nextRunAt!)
    expect(changes).not.toHaveBeenCalled()
    await expect(store.finish('missing-run', 'failed')).rejects.toThrow()
    expect(changes).not.toHaveBeenCalled()
    await store.finish(run!.occurrenceId, 'enqueued', { sessionId: 's1' })
    expect(changes).toHaveBeenCalledExactlyOnceWith({ ownerKey: task.ownerKey, principal: 'alice' })
    expect((await store.inbox(task.ownerKey, 'alice')).unreadCount).toBe(1)
    await store.finish(run!.occurrenceId, 'failed')
    await store.markInboxSeen(task.ownerKey, 'bob', [run!.occurrenceId])
    expect(changes).toHaveBeenCalledTimes(1)
    await store.markInboxSeen(task.ownerKey, 'alice', [run!.occurrenceId])
    expect(changes).toHaveBeenCalledTimes(2)
    await store.markInboxSeen(task.ownerKey, 'alice', [run!.occurrenceId])
    await store.setPaused(task.ownerKey, task.id, true)
    await store.delete(task.ownerKey, task.id)
    expect(changes).toHaveBeenCalledTimes(2)
    await stop()
    expect((await store.inbox(task.ownerKey, 'alice')).unreadCount).toBe(0)
  } finally {
    await stop()
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('invalidates an Inbox when history trimming removes its last item, not when claimed/skipped runs change', () => {
  const run = {
    occurrenceId: 'occ', taskId: 'task', operationId: 'schedule_a', scheduledFor: '2035-01-01', updatedAt: '2035-01-01',
    status: 'enqueued' as const,
    task: { id: 'task', generation: 1, ownerKey: 'organization:a', createdBy: 'alice', prompt: 'Run', target: { kind: 'session' as const, sessionId: 's1' } },
  }
  const state = { schemaVersion: 1 as const, revision: 1, tasks: [], runs: [run] }
  expect(changedInboxes(inboxSignatures(state), { ...state, runs: [] })).toEqual([{ ownerKey: 'organization:a', principal: 'alice' }])
  expect(changedInboxes(inboxSignatures({ ...state, runs: [] }), { ...state, runs: [{ ...run, status: 'skipped' }] })).toEqual([])
})

it('filters org AND creator principal, including unowned Portable token/anonymous Sessions', () => {
  const change = { ownerKey: 'organization:a', principal: 'alice' }
  expect(canReceiveInboxChange({ kind: 'ingress', organizationId: 'a', principal: 'alice', role: 'viewer' }, change)).toBe(true)
  expect(canReceiveInboxChange({ kind: 'ingress', organizationId: 'a', principal: 'bob', role: 'owner' }, change)).toBe(false)
  expect(canReceiveInboxChange({ kind: 'ingress', organizationId: 'b', principal: 'alice', role: 'owner' }, change)).toBe(false)
  expect(canReceiveInboxChange({ kind: 'token' }, { ownerKey: 'principal:token', principal: 'token' })).toBe(true)
  expect(canReceiveInboxChange({ kind: 'anonymous' }, { ownerKey: 'principal:token', principal: 'token' })).toBe(false)
  expect(canReceiveInboxChange({ kind: 'github_user', login: 'alice' }, { ownerKey: 'principal:alice', principal: 'alice' })).toBe(true)
  expect(canReceiveInboxChange(undefined)).toBe(false)
})
