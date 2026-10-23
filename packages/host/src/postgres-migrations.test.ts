import { describe, expect, it } from 'vitest'

import {
  assertPostgresSchemaCurrent,
  grantPostgresGatewayRuntimeReaderPrivileges,
  grantPostgresRuntimePrivileges,
  LATEST_POSTGRES_SCHEMA_VERSION,
  runPostgresMigrations,
} from './postgres-migrations.js'

type Row = Record<string, unknown> & { version: number; name: string; checksum: string }

class FakeClient {
  readonly statements: string[] = []
  readonly applied: Row[] = []
  privilegeOverrides: Record<string, boolean> = {}
  claimPresent = false
  claimWritable = false
  releaseCount = 0

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(text)
    if (text.startsWith('SELECT version, name, checksum')) {
      return { rows: this.applied.map((row) => ({ ...row })) as T[], rowCount: this.applied.length }
    }
    if (text.includes("to_regclass('kala_installation_claim.recovery_checkpoint')")) {
      return { rows: [{ checkpoint: this.claimPresent ? 'kala_installation_claim.recovery_checkpoint' : null }] as T[], rowCount: 1 }
    }
    if (text.includes("to_regclass('kala_installation_claim.marker')")) {
      return { rows: [{ marker: this.claimPresent ? 'kala_installation_claim.marker' : null }] as T[], rowCount: 1 }
    }
    if (text.includes("has_schema_privilege($1, 'kala_installation_claim'")) {
      return { rows: [{ can_create: false, can_write: this.claimWritable, owns_schema: false, owns_marker: false }] as T[], rowCount: 1 }
    }
    if (text.includes('has_schema_privilege')) {
      return { rows: [{ can_create: false, can_create_db: false, elevated: false, migration_write: false, forbidden_dml: false, owns_schema: false, owns_table: false, ...this.privilegeOverrides }] as T[], rowCount: 1 }
    }
    if (text.startsWith('INSERT INTO') && text.includes('kala_schema_migrations')) {
      this.applied.push({ version: Number(values[0]), name: String(values[1]), checksum: String(values[2]) })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  release(): void { this.releaseCount += 1 }
}

function pool(client: FakeClient) {
  return {
    query: client.query.bind(client),
    connect: async () => client,
    end: async () => undefined,
  }
}

describe('PostgreSQL migrations', () => {
  it('applies the initial migration once under an advisory lock and is idempotent', async () => {
    const client = new FakeClient()
    const first = await runPostgresMigrations(pool(client))
    expect(first).toEqual({ previousVersion: 0, currentVersion: 6, appliedVersions: [1, 2, 3, 4, 5, 6] })
    expect(client.statements[0]).toContain('pg_advisory_lock')
    expect(client.statements).toContain('BEGIN')
    expect(client.statements).toContain('COMMIT')
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock')
    expect(client.statements.filter((statement) => statement.includes('tenant_runtime_hot_events'))).toHaveLength(1)
    expect(client.statements.some((statement) => statement.includes('tenant_object_capacity_allocations'))).toBe(true)
    expect(client.statements.some((statement) => statement.includes('tenant_runtime_unit_replica_memberships'))).toBe(true)
    expect(client.statements.some((statement) => statement.includes('tenant_runtime_resource_ownerships'))).toBe(true)
    expect(client.statements.some((statement) => statement.includes('tenant_runtime_resource_ownerships_global_resource_uidx'))).toBe(true)
    expect(client.statements.some((statement) => statement.includes('tenant_runtime_unit_protocol_gates'))).toBe(true)

    client.statements.length = 0
    const second = await runPostgresMigrations(pool(client))
    expect(second).toEqual({ previousVersion: 6, currentVersion: 6, appliedVersions: [] })
    expect(client.statements).not.toContain('BEGIN')
    expect(client.releaseCount).toBe(2)
  })

  it('checks current history with SELECT only and rejects modified history', async () => {
    const client = new FakeClient()
    await runPostgresMigrations(pool(client))
    client.statements.length = 0

    await expect(assertPostgresSchemaCurrent(client)).resolves.toBe(LATEST_POSTGRES_SCHEMA_VERSION)
    expect(client.statements).toHaveLength(1)
    expect(client.statements[0]).toMatch(/^SELECT /u)

    client.applied[0]!.checksum = 'modified'
    await expect(assertPostgresSchemaCurrent(client)).rejects.toThrow('does not match this release')
  })

  it('grants DML only on migrated Runtime tables and SELECT only on migration history', async () => {
    const client = new FakeClient()
    await runPostgresMigrations(pool(client))
    client.statements.length = 0
    await grantPostgresRuntimePrivileges(pool(client), { runtimeRole: 'kala_runtime' })
    const grants = client.statements.filter((statement) => statement.startsWith('GRANT'))
    expect(grants).toContain('GRANT SELECT ON TABLE "public"."kala_schema_migrations" TO "kala_runtime"')
    expect(grants).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."tenant_runtime_resource_ownerships" TO "kala_runtime"')
    expect(grants).toContain('GRANT SELECT ON TABLE "public"."tenant_runtime_unit_protocol_gates" TO "kala_runtime"')
    expect(grants.some((statement) => statement.includes('ALL TABLES'))).toBe(false)
    expect(grants.filter((statement) => statement.includes('SELECT, INSERT, UPDATE, DELETE'))).toHaveLength(21)
    expect(client.statements.at(-1)).toBe('COMMIT')
    await expect(grantPostgresRuntimePrivileges(pool(client), { runtimeRole: 'invalid;role' })).rejects.toThrow('identifier')
  })

  it('grants both steady-state roles read-only marker access only when the fresh claim exists', async () => {
    const client = new FakeClient()
    await runPostgresMigrations(pool(client))
    client.claimPresent = true
    client.statements.length = 0
    await grantPostgresRuntimePrivileges(pool(client), { runtimeRole: 'kala_runtime' })
    await grantPostgresGatewayRuntimeReaderPrivileges(pool(client), { readerRole: 'kala_gateway_reader' })
    for (const role of ['kala_runtime', 'kala_gateway_reader']) {
      expect(client.statements).toContain(`GRANT USAGE ON SCHEMA kala_installation_claim TO "${role}"`)
      expect(client.statements).toContain(`GRANT SELECT ON TABLE kala_installation_claim.marker, kala_installation_claim.recovery_checkpoint TO "${role}"`)
    }
    expect(client.statements.filter((statement) => statement.startsWith('GRANT') && statement.includes('kala_installation_claim'))).toHaveLength(4)
    client.claimWritable = true
    await expect(grantPostgresRuntimePrivileges(pool(client), { runtimeRole: 'kala_runtime' })).rejects.toThrow('must not own or mutate')
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('grants the Gateway reader SELECT on exactly five Runtime tables and rejects existing DML', async () => {
    const client = new FakeClient()
    await runPostgresMigrations(pool(client))
    client.statements.length = 0

    await grantPostgresGatewayRuntimeReaderPrivileges(pool(client), { readerRole: 'kala_gateway_reader' })
    const grants = client.statements.filter((statement) => statement.startsWith('GRANT'))
    expect(grants).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "kala_gateway_reader"',
      'GRANT SELECT ON TABLE "public"."tenant_runtime_unit_placement_leases" TO "kala_gateway_reader"',
      'GRANT SELECT ON TABLE "public"."tenant_runtime_unit_protocol_gates" TO "kala_gateway_reader"',
      'GRANT SELECT ON TABLE "public"."tenant_runtime_unit_replica_memberships" TO "kala_gateway_reader"',
      'GRANT SELECT ON TABLE "public"."tenant_runtime_resource_ownerships" TO "kala_gateway_reader"',
      'GRANT SELECT ON TABLE "public"."tenant_session_latest_projection" TO "kala_gateway_reader"',
    ])
    expect(grants.some((statement) => statement.includes('kala_schema_migrations'))).toBe(false)
    expect(grants.some((statement) => /INSERT|UPDATE|DELETE|ALL TABLES/u.test(statement))).toBe(false)

    client.privilegeOverrides.forbidden_dml = true
    await expect(grantPostgresGatewayRuntimeReaderPrivileges(pool(client), { readerRole: 'overprivileged' }))
      .rejects.toThrow('must not own tables')
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('fails closed when the tracking table does not exist', async () => {
    const executor = {
      query: async () => { throw Object.assign(new Error('missing'), { code: '42P01' }) },
    }
    await expect(assertPostgresSchemaCurrent(executor)).rejects.toThrow('run kala-postgres-migrate')
  })
})
