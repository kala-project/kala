import { describe, expect, it } from 'vitest'

import { ServiceAccountService, type ServiceAccountScope } from './service-accounts.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

const NOW = new Date('2026-01-01T00:00:00.000Z')

describe('ServiceAccountService', () => {
  it('uses the owning transaction for the quota lock and both principal and Token writes', async () => {
    const database = new FakeServiceAccountDatabase()
    let active = false
    const executed: string[] = []
    const service = new ServiceAccountService({
      query: async () => { throw new Error('transaction escape') },
      async transaction(operation) {
        active = true
        try {
          return await operation({ query: async (text, values) => {
            expect(active).toBe(true)
            executed.push(text)
            return database.query(text, values)
          } })
        } finally { active = false }
      },
    })
    await service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['organization:read'] })
    expect(executed[0]).toContain('FOR UPDATE')
    expect(executed[1]).toContain('INSERT INTO principals')
    expect(executed[2]).toContain('INSERT INTO service_account_tokens')
  })

  it('enforces configured active service account quotas before issuing a token', async () => {
    const database = new FakeServiceAccountDatabase({ activeCount: 1 })
    const service = new ServiceAccountService(database, { maxActiveServiceAccounts: 1, now: () => NOW })

    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['organization:read'] }))
      .rejects.toThrow('service account quota exceeded')
    expect(database.executed.some((entry) => entry.sql.startsWith('INSERT INTO'))).toBe(false)
  })

  it('deduplicates valid scopes, stores only a token hash, and applies a finite default expiration', async () => {
    const database = new FakeServiceAccountDatabase({ activeCount: 0 })
    const service = new ServiceAccountService(database, { maxActiveServiceAccounts: 2, defaultExpirationMs: 60_000, maxExpirationMs: 120_000, now: () => NOW })

    const created = await service.create({ organizationId: 'org_acme', name: ' automation ', scopes: ['organization:read', 'organization:read', 'audit:read'] })

    expect(created).toMatchObject({
      id: expect.stringMatching(/^prn_/u),
      token: expect.stringMatching(/^ak_sa_/u),
      name: 'automation',
      scopes: ['organization:read', 'audit:read'],
      createdAt: NOW.toISOString(),
      expiresAt: '2026-01-01T00:01:00.000Z',
      revokedAt: null,
    })
    const tokenInsert = database.executed.find((entry) => entry.sql.startsWith('INSERT INTO service_account_tokens'))
    expect(tokenInsert?.values[3]).toMatch(/^[a-f0-9]{64}$/u)
    expect(tokenInsert?.values).not.toContain(created.token)
    expect(tokenInsert?.values[4]).toEqual(['organization:read', 'audit:read'])
    expect(tokenInsert?.values[5]).toEqual(NOW)
    expect(tokenInsert?.values[6]).toEqual(new Date('2026-01-01T00:01:00.000Z'))
  })

  it('rejects invalid scopes, expiration values, expired requests, and excessive lifetimes', async () => {
    expect(() => new ServiceAccountService(new FakeServiceAccountDatabase(), { maxActiveServiceAccounts: 0 })).toThrow('maxActiveServiceAccounts')
    expect(() => new ServiceAccountService(new FakeServiceAccountDatabase(), { defaultExpirationMs: 2, maxExpirationMs: 1 })).toThrow('defaultExpirationMs')
    const service = new ServiceAccountService(new FakeServiceAccountDatabase(), { defaultExpirationMs: 30_000, maxExpirationMs: 60_000, now: () => NOW })
    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['root:all' as ServiceAccountScope] })).rejects.toThrow('invalid service account')
    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['organization:read'], expiresAt: 'not-a-date' })).rejects.toThrow('valid date-time')
    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['organization:read'], expiresAt: NOW.toISOString() })).rejects.toThrow('future')
    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['organization:read'], expiresAt: '2026-01-01T00:01:00.001Z' })).rejects.toThrow('maximum lifetime')
  })

  it('lists only the requested organization without exposing token material', async () => {
    const database = new FakeServiceAccountDatabase({ listed: [{
      id: 'prn_automation',
      name: 'automation',
      scopes: ['workspace:read'],
      created_at: NOW,
      expires_at: null,
      revoked_at: '2026-01-02T00:00:00.000Z',
    }] })
    const service = new ServiceAccountService(database)

    const listed = await service.list('org_acme')

    expect(listed).toEqual([{
      id: 'prn_automation',
      name: 'automation',
      scopes: ['workspace:read'],
      createdAt: NOW.toISOString(),
      expiresAt: null,
      revokedAt: '2026-01-02T00:00:00.000Z',
    }])
    expect(database.executed.at(-1)?.values).toEqual(['org_acme'])
    expect(JSON.stringify(listed)).not.toMatch(/token|hash/iu)
  })

  it('scopes revocation to both organization and opaque principal id', async () => {
    const database = new FakeServiceAccountDatabase({ revoked: true })
    const service = new ServiceAccountService(database)

    await expect(service.revoke('org_acme', 'prn_automation')).resolves.toBe(true)
    expect(database.executed.at(-1)).toMatchObject({ values: ['org_acme', 'prn_automation'] })
    expect(database.executed.at(-1)?.sql).toContain('organization_id=$1 AND principal_id=$2')
  })

  it('binds authenticated tokens to their organization Runtime Unit', async () => {
    const service = new ServiceAccountService(new FakeServiceAccountDatabase({
      authenticated: {
        principal_id: 'prn_automation',
        organization_id: 'org_acme',
        runtime_unit_id: 'tenant_acme',
        organization_status: 'active',
        scopes: ['workspace:read'],
      },
    }))
    await expect(service.authenticate('ak_sa_token')).resolves.toEqual({
      principalId: 'prn_automation',
      organizationId: 'org_acme',
      unitId: 'tenant_acme',
      organizationStatus: 'active',
      scopes: ['workspace:read'],
    })
  })
})

class FakeServiceAccountDatabase implements SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []

  constructor(private readonly options: {
    activeCount?: number
    authenticated?: {
      principal_id: string
      organization_id: string
      runtime_unit_id: string
      organization_status: string
      scopes: ServiceAccountScope[]
    }
    listed?: Array<{
      id: string
      name: string
      scopes: ServiceAccountScope[]
      created_at: Date | string
      expires_at: Date | string | null
      revoked_at: Date | string | null
    }>
    revoked?: boolean
  } = {}) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('SELECT COUNT(*)')) return result([{ count: String(this.options.activeCount ?? 0) } as unknown as Row])
    if (sql.startsWith('SELECT tokens.principal_id AS id')) return result((this.options.listed ?? []) as unknown as Row[])
    if (sql.startsWith('SELECT tokens.principal_id') && this.options.authenticated) return result([this.options.authenticated as unknown as Row])
    if (sql.startsWith('UPDATE service_account_tokens')) return result([], this.options.revoked ? 1 : 0)
    return result([])
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}
