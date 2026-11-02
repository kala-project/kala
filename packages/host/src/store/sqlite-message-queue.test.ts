import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { QueueClaimFencedError } from '../message-queue-authority.js'
import { SqliteMessageQueueStore } from './sqlite-message-queue.js'

const roots: string[] = []
const stores: SqliteMessageQueueStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => await store.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { maxCancelledOperationIds?: number; now?: () => number } = {}) {
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

  it('keeps the claimed head durable across restart and completes it with an idempotent receipt', async () => {
    const { store } = fixture()
    await store.initialize()
    await store.enqueue('session-a', item('a-one'), 'back')
    await store.enqueue('session-a', item('a-front'), 'front')
    await store.enqueue('session-b', item('b-one'), 'back')

    const claim = (await store.claimHead('session-a', 'host-a', 60_000)).claim!
    expect(claim.item.operationId).toBe('a-front')
    expect((await store.load('session-a')).items.map(({ operationId }) => operationId))
      .toEqual(['a-front', 'a-one'])
    await store.close()

    const recovered = new SqliteMessageQueueStore(store.databasePath)
    stores.push(recovered)
    await recovered.initialize()
    await expect(recovered.confirmClaim(claim)).resolves.toBe(true)
    await expect(recovered.completeClaim(claim)).resolves.toMatchObject({
      changed: true,
      state: { items: [{ operationId: 'a-one' }] },
    })
    await expect(recovered.completeClaim(claim)).resolves.toMatchObject({ changed: false })
    await expect(recovered.load('session-b')).resolves.toMatchObject({
      items: [{ operationId: 'b-one' }],
      cancelledOperationIds: [],
    })
    await expect(recovered.enqueue('session-a', item('a-front'), 'back')).resolves.toMatchObject({ changed: false })
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

  it('transfers an expired claim with a higher generation and fences the stale owner', async () => {
    let now = Date.parse('2026-10-23T00:00:00.000Z')
    const { store } = fixture({ now: () => now })
    await store.initialize()
    await store.enqueue('claimed-session', {
      ...item('shell-operation', '!echo once'),
      shell: { command: 'echo once', state: 'queued' },
    }, 'back')

    const stale = (await store.claimHead('claimed-session', 'host-a', 100)).claim!
    now += 101
    const current = (await store.claimHead('claimed-session', 'host-b', 1_000)).claim!
    expect(current.generation).toBeGreaterThan(stale.generation)
    await expect(store.persistShellResult(stale, { command: 'echo once', state: 'completed', result: 'stale' }))
      .rejects.toBeInstanceOf(QueueClaimFencedError)
    await expect(store.completeClaim(stale)).rejects.toBeInstanceOf(QueueClaimFencedError)
    await expect(store.releaseClaim(stale)).resolves.toBe(false)

    await store.persistShellResult(current, { command: 'echo once', state: 'completed', result: 'known' })
    await expect(store.completeClaim(current)).resolves.toMatchObject({ changed: true, state: { items: [] } })
  })

  it('marks an expired running shell unknown after restart instead of delivering it twice', async () => {
    let now = Date.parse('2026-10-23T00:00:00.000Z')
    const { databasePath, store } = fixture({ now: () => now })
    await store.initialize()
    await store.enqueue('unknown-session', {
      ...item('unknown-operation', '!printf once'),
      shell: { command: 'printf once', state: 'queued' },
    }, 'back')
    const stale = (await store.claimHead('unknown-session', 'host-a', 100)).claim!
    await store.persistShellResult(stale, { command: 'printf once', state: 'running' })
    await store.close()

    now += 101
    const recovered = new SqliteMessageQueueStore(databasePath, { now: () => now })
    stores.push(recovered)
    await recovered.initialize()
    const takeover = await recovered.claimHead('unknown-session', 'host-b', 1_000)
    expect(takeover.claim).toBeUndefined()
    expect(takeover.executionUnknown).toBe(true)
    expect(takeover.state.items[0]?.shell).toMatchObject({
      command: 'printf once',
      state: 'unknown',
      error: expect.stringContaining('delete/cancel this item'),
    })
    const blocked = await recovered.claimHead('unknown-session', 'host-c', 1_000)
    expect(blocked.claim).toBeUndefined()
    expect(blocked.state).toMatchObject({ items: [{ shell: { state: 'unknown' } }] })
    await expect(recovered.persistShellResult(stale, { command: 'printf once', state: 'completed', result: 'late' }))
      .rejects.toBeInstanceOf(QueueClaimFencedError)
  })

  it('checks portable Session existence and tombstones in the enqueue transaction', async () => {
    const { databasePath, store } = fixture()
    await store.initialize()
    const setup = new DatabaseSync(databasePath)
    setup.exec(`
      CREATE TABLE portable_sessions (
        session_id TEXT PRIMARY KEY,
        deleting INTEGER NOT NULL CHECK (deleting IN (0, 1))
      );
      INSERT INTO portable_sessions (session_id, deleting) VALUES ('live-session', 0), ('deleting-session', 1);
    `)
    setup.close()

    await expect(store.enqueue('live-session', item('accepted'), 'back')).resolves.toMatchObject({ changed: true })
    await expect(store.enqueue('deleting-session', item('rejected'), 'back')).rejects.toThrow('is being deleted')
    await expect(store.enqueue('missing-session', item('missing'), 'back')).rejects.toThrow('is being deleted')
    await expect(store.load('deleting-session')).resolves.toEqual({ items: [], cancelledOperationIds: [] })
  })
})
