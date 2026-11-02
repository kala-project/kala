import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteScheduledTaskStore } from './sqlite-store.js'
import { createScheduledTaskStorage } from './storage.js'
import { ScheduledTaskStore } from './store.js'

const directories: string[] = []

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kala-scheduled-sqlite-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}

function input(at = '2026-10-24T10:00:00.000Z') {
  return {
    ownerKey: 'owner-a',
    createdBy: 'principal-a',
    prompt: 'portable scheduled task',
    target: { kind: 'session' as const, sessionId: 'session-a' },
    schedule: { kind: 'once' as const, at },
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SQLite scheduled task store', () => {
  it('persists claimed-run recovery and inbox receipts across reopen', async () => {
    const path = await databasePath()
    let now = new Date('2026-10-24T09:00:00.000Z')
    const first = new SqliteScheduledTaskStore(path, () => now)
    await first.start('unit-a')
    const task = await first.create(input())
    now = new Date(task.nextRunAt!)
    const claimed = await first.claim(task.id, task.nextRunAt!)
    expect(claimed?.status).toBe('claimed')
    expect(await first.claim(task.id, task.nextRunAt!)).toBeUndefined()
    await first.close()

    const recovered = new SqliteScheduledTaskStore(path, () => now)
    await recovered.start('unit-a')
    expect(await recovered.claimedRuns()).toEqual([claimed])
    await recovered.finish(claimed!.occurrenceId, 'failed', { error: 'executor unavailable' })
    expect(await recovered.inbox('owner-a', 'principal-a')).toMatchObject({
      unreadCount: 1,
      items: [{ occurrenceId: claimed!.occurrenceId, status: 'failed', seen: false }],
    })
    expect(await recovered.markInboxSeen('owner-a', 'principal-a', [claimed!.occurrenceId])).toEqual({
      acknowledged: [claimed!.occurrenceId], unreadCount: 0,
    })
    await recovered.close()

    const reopened = new SqliteScheduledTaskStore(path, () => now)
    await reopened.start('unit-a')
    expect(await reopened.claimedRuns()).toEqual([])
    expect(await reopened.inbox('owner-a', 'principal-a')).toMatchObject({ unreadCount: 0, items: [{ seen: true }] })
    await reopened.close()

    expect(await readdir(join(path, '..'))).not.toEqual(expect.arrayContaining(['state.json', 'lease.sqlite']))
  })

  it('serializes simultaneous clients so an occurrence is claimed only once', async () => {
    const path = await databasePath()
    let now = new Date('2026-10-24T09:00:00.000Z')
    const first = new SqliteScheduledTaskStore(path, () => now)
    const second = new SqliteScheduledTaskStore(path, () => now)
    await Promise.all([first.start('unit-a'), second.start('unit-a')])
    const task = await first.create(input())
    now = new Date(task.nextRunAt!)

    const claims = await Promise.all([
      first.claim(task.id, task.nextRunAt!),
      second.claim(task.id, task.nextRunAt!),
    ])
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
    expect(await first.claimedRuns()).toHaveLength(1)
    expect(await second.claimedRuns()).toHaveLength(1)

    await Promise.all([first.close(), second.close()])
  })

  it('rolls back an in-memory mutation when snapshot persistence fails', async () => {
    const path = await databasePath()
    const store = new SqliteScheduledTaskStore(path, () => new Date('2026-10-24T09:00:00.000Z'))
    await store.start('unit-a')
    const task = await store.create(input())
    const injector = new DatabaseSync(path)
    injector.exec(`
      CREATE TRIGGER fail_scheduled_snapshot_update
      BEFORE UPDATE ON portable_scheduled_state
      BEGIN
        SELECT RAISE(ABORT, 'injected snapshot failure');
      END
    `)

    await expect(store.update('owner-a', task.id, { prompt: 'must roll back' })).rejects.toThrow('injected snapshot failure')
    injector.exec('DROP TRIGGER fail_scheduled_snapshot_update')
    expect(await store.getTask('owner-a', task.id)).toEqual(task)
    expect((injector.prepare('SELECT revision FROM portable_scheduled_state').get() as { revision: number }).revision).toBe(1)

    injector.close()
    await store.close()
  })

  it('fails closed on an incompatible scheduled snapshot schema', async () => {
    const path = await databasePath()
    const incompatible = new DatabaseSync(path)
    incompatible.exec('CREATE TABLE portable_scheduled_state (singleton INTEGER PRIMARY KEY)')
    incompatible.close()

    const store = new SqliteScheduledTaskStore(path)
    await expect(store.start('unit-a')).rejects.toThrow('invalid portable_scheduled_state schema')
    expect(await readdir(join(path, '..'))).not.toEqual(expect.arrayContaining(['state.json', 'lease.sqlite']))
  })

  it('tracks lifecycle and keeps backend selection explicit', async () => {
    const path = await databasePath()
    const sqlite = createScheduledTaskStorage({ kind: 'portable-sqlite', databasePath: path })
    const legacy = createScheduledTaskStorage({ kind: 'legacy', directory: join(path, '..', 'legacy') })
    expect(sqlite).toBeInstanceOf(SqliteScheduledTaskStore)
    expect(legacy).toBeInstanceOf(ScheduledTaskStore)
    await expect(sqlite.listTasks('owner-a')).rejects.toThrow('not started')
    await sqlite.start('unit-a')
    const accepted = sqlite.create(input('2099-01-01T00:00:00.000Z'))
    const closing = sqlite.close()
    await expect(accepted).resolves.toMatchObject({ prompt: 'portable scheduled task' })
    await closing
    await expect(sqlite.create(input('2099-01-02T00:00:00.000Z'))).rejects.toThrow('not started')
  })
})
