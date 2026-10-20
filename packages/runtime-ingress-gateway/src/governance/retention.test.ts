import { createServer } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { createRuntimeHostRetentionClient, RetentionService, startRetentionScheduler } from './retention.js'
import type { ControlPlaneDatabase, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('RetentionService', () => {
  it('purges tenant-scoped sessions and devices using the organization retention policy', async () => {
    const database = new FakeRetentionDatabase()
    const service = new RetentionService(database)
    const now = new Date('2026-09-07T04:00:00Z')

    await expect(service.purgeOrganization('org_acme', now)).resolves.toEqual({ sessions: 2, devices: 1, hostSessions: 0 })

    expect(database.transactionCount).toBe(1)
    expect(database.executed.map((entry) => entry.sql)).toEqual([
      'SELECT r.session_days,o.runtime_unit_id FROM retention_policies r JOIN organizations o ON o.id=r.organization_id WHERE r.organization_id=$1',
      "INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result,metadata) VALUES($1,$2,NULL,'system','retention.purge','organization',$2,'allowed',$3)",
      "DELETE FROM notification_devices WHERE organization_id=$1 AND updated_at < $2::timestamptz - ($3::text || ' days')::interval",
      "DELETE FROM browser_sessions WHERE organization_id=$1 AND COALESCE(revoked_at,absolute_expires_at) < $2::timestamptz - ($3::text || ' days')::interval",
      'UPDATE audit_events SET result=$2,metadata=$3 WHERE id=$1',
    ])
    expect(database.executed[1]?.values).toEqual([expect.any(String), 'org_acme', { before: '2026-08-08T04:00:00.000Z', phase: 'started' }])
    expect(database.executed[2]?.values).toEqual(['org_acme', now, 30])
    expect(database.executed[3]?.values).toEqual(['org_acme', now, 30])
    expect(database.executed[4]?.values).toEqual([
      database.executed[1]?.values[0],
      'succeeded',
      { before: '2026-08-08T04:00:00.000Z', sessions: 2, devices: 1, hostSessions: 0 },
    ])
  })

  it('purges host tenant sessions and artifacts with the same retention cutoff', async () => {
    const database = new FakeRetentionDatabase()
    const hostData = {
      purgeOrganizationSessions: vi.fn(async () => ({ sessions: 3 })),
    }
    const service = new RetentionService(database, hostData)
    const now = new Date('2026-09-07T04:00:00Z')

    await expect(service.purgeOrganization('org_acme', now)).resolves.toEqual({ sessions: 2, devices: 1, hostSessions: 3 })
    expect(hostData.purgeOrganizationSessions).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      runtimeUnitId: 'unit_acme',
      before: new Date('2026-08-08T04:00:00Z'),
    })
  })

  it('reports a Host failure and retries that tenant on the next purge', async () => {
    const database = new FakeRetentionDatabase()
    const hostData = {
      purgeOrganizationSessions: vi.fn()
        .mockRejectedValueOnce(new Error('temporary Host storage failure'))
        .mockResolvedValueOnce({ sessions: 1 }),
    }
    const service = new RetentionService(database, hostData)
    const now = new Date('2026-09-07T04:00:00Z')

    await expect(service.purgeAllOrganizations(now)).resolves.toEqual({
      purged: [],
      failures: [{ organizationId: 'org_acme', error: 'temporary Host storage failure' }],
    })
    await expect(service.purgeAllOrganizations(now)).resolves.toMatchObject({
      purged: [{ organizationId: 'org_acme', hostSessions: 1 }],
      failures: [],
    })
    expect(hostData.purgeOrganizationSessions).toHaveBeenCalledTimes(2)
    expect(database.executed.filter((entry) => entry.sql.startsWith('UPDATE audit_events')).map((entry) => entry.values[1])).toEqual(['failed', 'succeeded'])
  })

  it('does not delete data when its durable system audit intention cannot be recorded', async () => {
    const database = new FakeRetentionDatabase({ failAuditInsert: true })
    await expect(new RetentionService(database).purgeOrganization('org_acme')).rejects.toThrow('audit write failed')
    expect(database.executed.some((entry) => entry.sql.startsWith('DELETE '))).toBe(false)
  })

  it('fails closed when retention policy is missing', async () => {
    const database = new FakeRetentionDatabase({ policyRows: [] })
    const service = new RetentionService(database)

    await expect(service.purgeOrganization('org_missing')).rejects.toThrow('retention policy not found')
    expect(database.executed.some((entry) => entry.sql.startsWith('DELETE '))).toBe(false)
  })

  it('exports only the requested organization control-plane records', async () => {
    const database = new FakeRetentionDatabase()
    const service = new RetentionService(database)

    const exported = await service.exportOrganization('org_acme')

    expect(exported).toMatchObject({
      schemaVersion: 1,
      organization: { id: 'org_acme' },
      memberships: [{ organization_id: 'org_acme' }],
      usage: [{ organization_id: 'org_acme' }],
      audit: [{ organization_id: 'org_acme' }],
    })
    expect(database.executed.slice(-4).map((entry) => entry.values)).toEqual([
      ['org_acme'],
      ['org_acme'],
      ['org_acme'],
      ['org_acme'],
    ])
  })

  it('orchestrates scheduled purge across tenant policies and reports per-tenant failures', async () => {
    const database = new FakeRetentionDatabase({
      organizationRows: [{ organization_id: 'org_acme' }, { organization_id: 'org_missing' }],
      policyRowsByOrganization: new Map([
        ['org_acme', [{ session_days: 30, runtime_unit_id: 'unit_acme' }]],
        ['org_missing', []],
      ]),
    })
    const service = new RetentionService(database)

    await expect(service.purgeAllOrganizations(new Date('2026-09-07T04:00:00Z'))).resolves.toEqual({
      purged: [{ organizationId: 'org_acme', sessions: 2, devices: 1, hostSessions: 0 }],
      failures: [{ organizationId: 'org_missing', error: 'retention policy not found' }],
    })

    expect(database.executed[0]?.sql).toBe("SELECT r.organization_id FROM retention_policies r JOIN organizations o ON o.id=r.organization_id WHERE o.status IN ('active','suspended','closing') ORDER BY r.organization_id")
    expect(database.transactionCount).toBe(2)
  })

  it('routes retention through the trusted Unit resolver and never falls back to static Host', async () => {
    const requests: Array<{ body: unknown; path?: string }> = []
    const runtime = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ sessions: 4 }))
    })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    const address = runtime.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const resolvedUnits: string[] = []
    const client = createRuntimeHostRetentionClient({
      origin: 'http://127.0.0.1:9',
      ingressSecret: 'test-secret',
      runtimeOriginResolver: { async resolve(unitId) { resolvedUnits.push(unitId); return origin } },
    })
    try {
      await expect(client.purgeOrganizationSessions({
        organizationId: 'org_acme', runtimeUnitId: 'unit_acme', before: new Date('2026-08-08T04:00:00Z'),
      })).resolves.toEqual({ sessions: 4 })
      expect(resolvedUnits).toEqual(['unit_acme'])
      expect(requests).toEqual([{ path: '/internal/retention/sessions', body: { organizationId: 'org_acme', unitId: 'unit_acme', before: '2026-08-08T04:00:00.000Z' } }])

      const unavailable = createRuntimeHostRetentionClient({
        origin,
        ingressSecret: 'test-secret',
        runtimeOriginResolver: { async resolve() { return undefined } },
      })
      await expect(unavailable.purgeOrganizationSessions({
        organizationId: 'org_acme', runtimeUnitId: 'unit_acme', before: new Date(),
      })).rejects.toThrow('origin is unavailable')
      expect(requests).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => runtime.close(() => resolve()))
    }
  })

  it('starts a bounded retention scheduler and rejects unsafe intervals', async () => {
    vi.useFakeTimers()
    const database = new FakeRetentionDatabase({ organizationRows: [{ organization_id: 'org_acme' }] })
    const service = new RetentionService(database)
    const results: unknown[] = []

    expect(() => startRetentionScheduler({ service, intervalMs: 59_999 })).toThrow('retention scheduler interval')
    const scheduler = startRetentionScheduler({
      service,
      intervalMs: 60_000,
      now: () => new Date('2026-09-07T04:00:00Z'),
      onResult: (result) => results.push(result),
    })
    await vi.runOnlyPendingTimersAsync()
    scheduler.stop()

    expect(results.length).toBeGreaterThanOrEqual(1)
    vi.useRealTimers()
  })
})

class FakeRetentionDatabase implements ControlPlaneDatabase, SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []
  transactionCount = 0

  constructor(private readonly options: {
    policyRows?: Array<{ session_days: number; runtime_unit_id: string }>
    policyRowsByOrganization?: Map<string, Array<{ session_days: number; runtime_unit_id: string }>>
    organizationRows?: Array<{ organization_id: string }>
    failAuditInsert?: boolean
  } = {}) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('INSERT INTO audit_events') && this.options.failAuditInsert) throw new Error('audit write failed')
    if (sql.startsWith('SELECT r.organization_id FROM retention_policies')) return result((this.options.organizationRows ?? [{ organization_id: 'org_acme' }]) as unknown as Row[])
    if (sql.startsWith('SELECT r.session_days,o.runtime_unit_id') && this.options.policyRowsByOrganization) return result((this.options.policyRowsByOrganization.get(String(values[0])) ?? []) as unknown as Row[])
    if (sql.startsWith('SELECT r.session_days,o.runtime_unit_id')) return result((this.options.policyRows ?? [{ session_days: 30, runtime_unit_id: 'unit_acme' }]) as unknown as Row[])
    if (sql.startsWith('DELETE FROM notification_devices')) return result([], 1)
    if (sql.startsWith('DELETE FROM browser_sessions')) return result([], 2)
    if (sql.startsWith('SELECT * FROM organizations')) return result([{ id: values[0] } as unknown as Row])
    if (sql.startsWith('SELECT m.* FROM organization_memberships')) return result([{ organization_id: values[0] } as unknown as Row])
    if (sql.startsWith('SELECT * FROM usage_ledger')) return result([{ organization_id: values[0] } as unknown as Row])
    if (sql.startsWith('SELECT * FROM audit_events')) return result([{ organization_id: values[0] } as unknown as Row])
    return result([])
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1
    return operation(this)
  }

  async health() { return { ok: true as const, schemaVersion: 1 } }
  async close() {}
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}
