import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteMessageQueueStore } from './sqlite-message-queue.js'

const roots: string[] = []
const stores: SqliteMessageQueueStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => await store.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { maxCancelledOperationIds?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kala-sqlite-message-queue-'))
  roots.push(root)
  const databasePath = join(root, 'state.sqlite')
  const store = new SqliteMessageQueueStore(databasePath, options)
  stores.push(store)
  return { databasePath, store }
}

function item(operationId: string, text = operationId, id = operationId) {
  return { id, operationId, text, mode: 'queue' as const, createdAt: '2026-10-23T00:00:00.000Z' }
}

describe('SqliteMessageQueueStore', () => {
  it('persists ordered rows across reopen and leaves state.sqlite user_version alone', async () => {
    const { databasePath, store } = fixture()
    const setup = new DatabaseSync(databasePath)
    setup.exec('PRAGMA user_version = 37')
    setup.close()

    await store.initialize()
    await store.enqueue('session-a', item('one'), 'back')
    await store.enqueue('session-a', item('two'), 'back')
    await store.enqueue('session-a', item('front'), 'front')
    expect((await store.load('session-a')).items.map(({ operationId }) => operationId))
      .toEqual(['front', 'one', 'two'])
    await store.close()

    const reopened = new SqliteMessageQueueStore(databasePath)
    stores.push(reopened)
    await reopened.initialize()
    expect((await reopened.load('session-a')).items.map(({ operationId }) => operationId))
      .toEqual(['front', 'one', 'two'])
    const inspect = new DatabaseSync(databasePath)
    expect((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(37)
    inspect.close()
  })

  it('makes active and cancelled operation IDs idempotent and rejects conflicting duplicates', async () => {
    const { store } = fixture()
    await store.initialize()

    await expect(store.enqueue('session-a', item('operation-a', 'original'), 'back'))
      .resolves.toMatchObject({ changed: true })
    await expect(store.enqueue('session-a', item('operation-a', 'original', 'retry-id'), 'front'))
      .resolves.toMatchObject({ changed: false })
    await expect(store.enqueue('session-a', item('operation-a', 'different'), 'back'))
      .rejects.toThrow('message operation ID conflict')
    expect((await store.load('session-a')).items).toHaveLength(1)

    await expect(store.cancel('session-a', 'operation-a')).resolves.toMatchObject({ changed: true })
    await expect(store.cancel('session-a', 'operation-a')).resolves.toMatchObject({ changed: false })
    await expect(store.enqueue('session-a', item('operation-a', 'original'), 'back'))
      .resolves.toMatchObject({ changed: false })
    await expect(store.load('session-a')).resolves.toEqual({
      items: [],
      cancelledOperationIds: ['operation-a'],
    })
  })

  it('atomically dequeues the head without changing another Session', async () => {
    const { store } = fixture()
    await store.initialize()
    await store.enqueue('session-a', item('a-one'), 'back')
    await store.enqueue('session-a', item('a-front'), 'front')
    await store.enqueue('session-b', item('b-one'), 'back')

    await expect(store.dequeue('session-a')).resolves.toMatchObject({
      changed: true,
      item: { operationId: 'a-front' },
      state: { items: [{ operationId: 'a-one' }] },
    })
    await expect(store.load('session-b')).resolves.toMatchObject({
      items: [{ operationId: 'b-one' }],
      cancelledOperationIds: [],
    })
    await expect(store.dequeue('session-a')).resolves.toMatchObject({ changed: true, item: { operationId: 'a-one' } })
    await expect(store.dequeue('session-a')).resolves.toEqual({
      state: { items: [], cancelledOperationIds: [] },
      changed: false,
    })
    await store.close()
    const recovered = new SqliteMessageQueueStore(store.databasePath)
    stores.push(recovered)
    await recovered.initialize()
    await expect(recovered.enqueue('session-a', item('a-front'), 'back')).resolves.toMatchObject({ changed: false })
    await expect(recovered.load('session-a')).resolves.toMatchObject({ items: [] })
  })

  it('rolls back cancellation tombstones and item removal together on failure', async () => {
    const { databasePath, store } = fixture()
    await store.initialize()
    await store.enqueue('rollback-session', item('rollback-operation'), 'back')

    const setup = new DatabaseSync(databasePath)
    setup.exec(`
      CREATE TRIGGER reject_portable_queue_delete
      BEFORE DELETE ON portable_message_queue_items
      BEGIN
        SELECT RAISE(FAIL, 'injected queue delete failure');
      END;
    `)
    setup.close()

    await expect(store.cancel('rollback-session', 'rollback-operation'))
      .rejects.toThrow('injected queue delete failure')
    await expect(store.load('rollback-session')).resolves.toMatchObject({
      items: [{ operationId: 'rollback-operation' }],
      cancelledOperationIds: [],
    })
  })

  it('fails closed at the per-Session cancellation bound and preserves prior state', async () => {
    const { databasePath, store } = fixture({ maxCancelledOperationIds: 2 })
    await store.initialize()
    await store.cancel('bounded-session', 'cancel-one')
    await store.cancel('bounded-session', 'cancel-two')
    await expect(store.cancel('bounded-session', 'cancel-three'))
      .rejects.toThrow('cancellation tombstone limit of 2 exceeded')
    await store.close()

    const reopened = new SqliteMessageQueueStore(databasePath, { maxCancelledOperationIds: 2 })
    stores.push(reopened)
    await reopened.initialize()
    await expect(reopened.load('bounded-session')).resolves.toEqual({
      items: [],
      cancelledOperationIds: ['cancel-one', 'cancel-two'],
    })
  })
})
