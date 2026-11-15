import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { inviteKey } from '../assignments/store.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import { PostgresOrganizationStore } from './postgres-store.js'

const identity = { issuer: 'https://id.example', subject: 'alice' }
const createdAt = new Date('2026-01-01T00:00:00Z')

describe('PostgresOrganizationStore identity assignment', () => {
  it('fails closed instead of selecting a tenant when active memberships are ambiguous', async () => {
    const database = new MembershipDatabase([
      accessRow('org_a', 'tenant_a'),
      accessRow('org_b', 'tenant_b'),
    ])

    await expect(new PostgresOrganizationStore(database).findAccess(identity))
      .rejects.toThrow('identity_has_multiple_active_organizations')
    expect(database.executed[0]?.sql).toContain('LIMIT 2')
  })

  it('rejects adding an identity that is active in another organization', async () => {
    const database = new MembershipDatabase([], [['https://id.example|alice', 'org_a']])
    const store = new PostgresOrganizationStore(database)

    await expect(store.addMember('org_b', identity, 'member'))
      .rejects.toThrow('identity_already_belongs_to_another_organization')
    expect(database.membershipInserts).toBe(0)
  })

  it('serializes concurrent cross-organization writes and permits exactly one', async () => {
    const database = new MembershipDatabase()
    const store = new PostgresOrganizationStore(database)

    const outcomes = await Promise.allSettled([
      store.addMember('org_a', identity, 'member'),
      store.addMember('org_b', identity, 'admin'),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejection = outcomes.find(({ status }) => status === 'rejected')
    expect(rejection).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'identity_already_belongs_to_another_organization' }) })
    expect(database.membershipInserts).toBe(1)
    expect(database.executed.filter(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2)
  })

  it('persists only a hash when creating an invitation', async () => {
    const database = new InviteCreationDatabase()
    const store = new PostgresOrganizationStore(database)
    const created = await store.createInvite('org_a', identity, 'Invitee@Example.Test', 'member', new Date(Date.now() + 86_400_000).toISOString())

    expect(created.token).toMatch(/^ak_org_invite_/u)
    expect(database.values).toContain(inviteKey(created.token))
    expect(database.values).not.toContain(created.token)
    expect(created.invite.email).toBe('invitee@example.test')
  })

  it('uses only a hashed invite as the post-enrollment route hint and still checks revocation', async () => {
    let query: { sql: string; values: readonly unknown[] } | undefined
    const database = {
      async query(sql: string, values: readonly unknown[]) { query = { sql, values }; return result([{ runtime_unit_id: 'tenant_alice' }]) },
      async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return operation(database as SqlExecutor) },
    } as SqlExecutor & { transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> }
    const store = new PostgresOrganizationStore(database)
    const hash = inviteKey('ak_invite_original')
    expect(await store.findUnitByExecutorRouteHint(hash)).toBe('tenant_alice')
    expect(query?.values).toEqual([hash])
    expect(query?.sql).toContain('t.revoked_at IS NULL')
    expect(query?.sql).toContain("o.status = 'active'")
    expect(query?.sql).not.toContain('t.expires_at > now()')
    expect(await store.findUnitByExecutorInvite('ak_invite_original')).toBe('tenant_alice')
    expect(query?.values).toEqual([hash])
  })

  it('updates only the enforced session retention field', async () => {
    const executed: QueryEntry[] = []
    const database = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
        const sql = normalize(text); executed.push({ sql, values })
        if (sql.startsWith('SELECT session_days,artifact_days')) return result([{ session_days: 30, artifact_days: 90, audit_days: 365, deleted_resource_grace_days: 30, version: '1' } as unknown as Row])
        return result([], 1)
      },
      async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return operation(database) },
    }
    await new PostgresOrganizationStore(database).updateRetentionPolicy('org_a', { sessionDays: 45, artifactDays: 90, auditDays: 365, deletedResourceGraceDays: 30 })
    expect(executed[1]).toMatchObject({ values: ['org_a', 45] })
    expect(executed[1]?.sql).toContain('SET session_days=$2,version=version+1')
    expect(executed[1]?.sql).not.toContain('artifact_days=$3')
  })

  it('rejects unsupported retention changes without persisting them', async () => {
    let updates = 0
    const database = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string): Promise<SqlQueryResult<Row>> {
        if (normalize(text).startsWith('SELECT session_days,artifact_days')) return result([{ session_days: 30, artifact_days: 90, audit_days: 365, deleted_resource_grace_days: 30, version: '1' } as unknown as Row])
        updates += 1; return result([], 1)
      },
      async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return operation(database) },
    }
    await expect(new PostgresOrganizationStore(database).updateRetentionPolicy('org_a', { sessionDays: 45, artifactDays: 7, auditDays: 30, deletedResourceGraceDays: 30 }))
      .rejects.toThrow('unsupported_retention_fields:artifactDays,auditDays')
    expect(updates).toBe(0)
  })

  it('locks the invitation row and conditionally marks it accepted in the same transaction', async () => {
    const source = await readFile(new URL('./postgres-store.ts', import.meta.url), 'utf8')
    expect(source).toContain('FOR UPDATE OF i')
    expect(source).toContain('accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()')
    expect(source).toContain('pg_advisory_xact_lock')
  })

  it('ships a migration that preflights ambiguity before adding the database backstop', async () => {
    const sql = await readFile(new URL('../../migrations/0004_unique_active_organization_membership.sql', import.meta.url), 'utf8')
    const preflight = sql.indexOf('HAVING count(*) > 1')
    const uniqueIndex = sql.indexOf('CREATE UNIQUE INDEX organization_memberships_active_principal_uidx')

    expect(preflight).toBeGreaterThan(-1)
    expect(uniqueIndex).toBeGreaterThan(preflight)
    expect(sql).toContain("WHERE status = 'active'")
  })
})

class InviteCreationDatabase implements SqlExecutor {
  values: readonly unknown[] = []
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(_text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.values = values
    return result([{
      id: values[0], organization_id: values[1], email_normalized: values[2], role: values[3],
      created_at: createdAt, expires_at: new Date(String(values[5])), accepted_at: null, revoked_at: null,
    } as unknown as Row])
  }
  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return await operation(this) }
}

type QueryEntry = { sql: string; values: readonly unknown[] }
type AccessRow = Record<string, unknown>

class MembershipDatabase {
  readonly executed: QueryEntry[] = []
  readonly memberships: Map<string, string>
  membershipInserts = 0
  private readonly lockTails = new Map<string, Promise<void>>()

  constructor(
    private readonly accessRows: AccessRow[] = [],
    memberships: ReadonlyArray<readonly [string, string]> = [],
  ) {
    this.memberships = new Map(memberships)
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    return this.execute<Row>(text, values)
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined
    const transaction: SqlExecutor = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        const sql = normalize(text)
        if (sql.includes('pg_advisory_xact_lock')) {
          const key = String(values[0])
          const prior = this.lockTails.get(key) ?? Promise.resolve()
          let unlock!: () => void
          const current = new Promise<void>((resolve) => { unlock = resolve })
          this.lockTails.set(key, prior.then(() => current))
          await prior
          release = unlock
          this.executed.push({ sql, values })
          return result<Row>([])
        }
        return this.execute<Row>(text, values)
      },
    }
    try {
      return await operation(transaction)
    } finally {
      release?.()
    }
  }

  private async execute<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    const sql = normalize(text)
    this.executed.push({ sql, values })
    if (sql.startsWith('SELECT o.id,')) return result(this.accessRows as Row[])
    if (sql.startsWith('SELECT m.organization_id')) {
      const organizationId = this.memberships.get(`${String(values[0])}|${String(values[1])}`)
      return result(organizationId ? [{ organization_id: organizationId } as unknown as Row] : [])
    }
    if (sql.startsWith('INSERT INTO organization_memberships')) {
      this.membershipInserts += 1
      this.memberships.set(`${String(values[1])}|${String(values[2])}`, String(values[0]))
      return result([{ created_at: createdAt } as unknown as Row])
    }
    if (sql.startsWith('UPDATE organizations SET authorization_version')) return result([], 1)
    return result([])
  }
}

function accessRow(id: string, runtimeUnitId: string): AccessRow {
  return { id, name: id, status: 'active', runtime_unit_id: runtimeUnitId, created_at: createdAt, role: 'member', membership_created_at: createdAt }
}
function normalize(sql: string): string { return sql.trim().replace(/\s+/gu, ' ') }
function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}
