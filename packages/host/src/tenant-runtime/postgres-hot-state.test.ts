import { describe, expect, it } from 'vitest'

import { parseTenantRuntimeUnitId } from './unit.js'
import type { RuntimeResourceOwnership } from './postgres-runtime-resource-ownership.js'
import {
  PostgresHotStateStore,
  type HotStateDatabase,
  type HotStateSqlExecutor,
  type SqlQueryResult,
} from './postgres-hot-state.js'

class ReplayDatabase implements HotStateDatabase {
  queries = 0

  async query<Row extends Record<string, unknown>>(text: string): Promise<SqlQueryResult<Row>> {
    this.queries += 1
    expect(text).toContain('ORDER BY sequence ASC')
    return {
      rowCount: 1,
      rows: [{
        tenant_id: 'tenant-a', scope_type: 'session', scope_id: 'session-a',
        sequence: '9007199254740993', generation: '7', idempotency_key: 'op-a',
        event_type: 'message', payload: { text: 'hello' }, created_at: new Date(0),
      } as unknown as Row],
    }
  }

  async transaction<T>(_operation: (transaction: HotStateSqlExecutor) => Promise<T>): Promise<T> {
    throw new Error('not used')
  }
}

describe('PostgresHotStateStore input and replay boundary', () => {
  it('preserves bigint sequence values when mapping replay rows', async () => {
    const database = new ReplayDatabase()
    const store = new PostgresHotStateStore(database)
    const events = await store.replay({ tenantId: 'tenant-a', scopeType: 'session', scopeId: 'session-a' })
    expect(events[0]).toMatchObject({ sequence: 9007199254740993n, generation: 7n, payload: { text: 'hello' } })
  })

  it('rejects resource owner scope or Unit mismatches before starting a write transaction', async () => {
    const database = new ReplayDatabase()
    const unitId = parseTenantRuntimeUnitId('unit_a')
    const owner: RuntimeResourceOwnership = {
      organizationId: 'tenant-a', unitId, resourceType: 'session', resourceId: 'session-a',
      replicaId: 'replica-a', membershipGeneration: 1n, membershipToken: 'member-token',
      ownerToken: 'owner-token', generation: 1n, expiresAt: new Date(Date.now() + 30_000),
    }
    const placementLease = {
      organizationId: 'tenant-a', unitId, nodeId: 'node-a', origin: 'https://node-a.example',
      ownerToken: 'placement-token', generation: 1n, expiresAt: new Date(Date.now() + 30_000),
    }
    const store = new PostgresHotStateStore(database, { placementLease })
    const token = {
      tenantId: 'tenant-a', scopeType: 'session' as const, scopeId: 'session-a',
      ownerId: 'writer-a', generation: 1n, expiresAt: new Date(Date.now() + 30_000),
    }
    const event = { idempotencyKey: 'op-a', eventType: 'message', payload: { text: 'test' } }
    await expect(store.appendEventWithSideEffect(token, event, async () => undefined, {
      ...owner, resourceId: 'session-b',
    })).rejects.toThrow('scope must match')
    await expect(store.appendEventWithSideEffect(token, event, async () => undefined, {
      ...owner, unitId: parseTenantRuntimeUnitId('unit_b'),
    })).rejects.toThrow('must match its Unit placement')
    expect(database.queries).toBe(0)
  })

  it('rejects unsafe schema names and invalid replay bounds before querying', async () => {
    const database = new ReplayDatabase()
    expect(() => new PostgresHotStateStore(database, { schema: 'public; DROP SCHEMA public' })).toThrow('simple PostgreSQL identifier')
    const store = new PostgresHotStateStore(database)
    await expect(store.replay({ tenantId: 'tenant-a', scopeType: 'task', scopeId: 'task-a' }, { limit: 1001 })).rejects.toThrow('1 to 1000')
    expect(database.queries).toBe(0)
  })
})
