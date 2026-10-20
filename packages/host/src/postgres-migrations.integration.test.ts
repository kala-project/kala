import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertPostgresSchemaCurrent, grantPostgresGatewayRuntimeReader, grantPostgresRuntimeDml, migratePostgres } from './postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './tenant-runtime/postgres-hot-state.js'
import { PostgresTenantStateStore } from './tenant-runtime/postgres-state.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_MIGRATION_INTEGRATION === '1' ? describe : describe.skip
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: object) => {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end(): Promise<void>
} }

integrationDescribe('PostgreSQL operator migrations and DML-only Runtime role', () => {
  const project = `kala-migration-${randomUUID()}`
  const container = `${project}-postgres`
  const database = 'kala_migration_test'
  const adminPassword = `admin-${randomUUID()}`
  const runtimePassword = `runtime-${randomUUID()}`
  const readerPassword = `reader-${randomUUID()}`
  let adminUrl = ''
  let runtimeUrl = ''
  let readerUrl = ''
  let hotState: PostgresHotStateStore

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${adminPassword}`,
      '--env', `POSTGRES_DB=${database}`,
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container)
    const port = stdout.trim()
    adminUrl = `postgresql://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/${database}`
    runtimeUrl = `postgresql://kala_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:${port}/${database}`
    readerUrl = `postgresql://kala_gateway_reader:${encodeURIComponent(readerPassword)}@127.0.0.1:${port}/${database}`
    const admin = new Pool({ connectionString: adminUrl })
    await eventually(async () => { await admin.query('SELECT 1') }, 30_000)
    await admin.end()
  }, 120_000)

  afterAll(async () => {
    await hotState?.close().catch(() => undefined)
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  it('migrates from zero idempotently, then supports core DML while rejecting Runtime DDL', async () => {
    await expect(migratePostgres({ connectionString: adminUrl })).resolves.toMatchObject({
      previousVersion: 0,
      currentVersion: 6,
      appliedVersions: [1, 2, 3, 4, 5, 6],
    })
    await expect(migratePostgres({ connectionString: adminUrl })).resolves.toMatchObject({
      previousVersion: 6,
      currentVersion: 6,
      appliedVersions: [],
    })

    const admin = new Pool({ connectionString: adminUrl })
    const tables = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    expect(tables.rows.map((row) => row.tablename)).toHaveLength(23)
    expect(tables.rows.map((row) => row.tablename)).toEqual(expect.arrayContaining([
      'tenant_object_capacity_accounts',
      'tenant_object_capacity_allocations',
      'tenant_runtime_unit_replica_memberships',
      'tenant_runtime_resource_ownerships',
      'tenant_runtime_unit_protocol_gates',
    ]))
    await admin.query(`CREATE ROLE kala_runtime LOGIN PASSWORD '${runtimePassword.replaceAll("'", "''")}'`)
    await admin.query(`CREATE ROLE kala_gateway_reader LOGIN PASSWORD '${readerPassword.replaceAll("'", "''")}'`)
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await admin.query('CREATE TABLE private_control_marker (id integer)')
    await admin.query('CREATE ROLE kala_runtime_ddl; GRANT CREATE ON SCHEMA public TO kala_runtime_ddl')
    await admin.query('CREATE ROLE kala_runtime_history; GRANT UPDATE ON kala_schema_migrations TO kala_runtime_history')
    await admin.end()
    await expect(grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime_ddl' }))
      .rejects.toThrow('DDL privileges')
    await expect(grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime_history' }))
      .rejects.toThrow('migration history')
    await grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime' })
    await grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime' })
    await expect(grantPostgresGatewayRuntimeReader({ connectionString: adminUrl, readerRole: 'kala_runtime' }))
      .rejects.toThrow('Gateway Runtime reader role')
    await grantPostgresGatewayRuntimeReader({ connectionString: adminUrl, readerRole: 'kala_gateway_reader' })
    const reader = new Pool({ connectionString: readerUrl })
    for (const table of [
      'tenant_runtime_unit_placement_leases', 'tenant_runtime_unit_replica_memberships',
      'tenant_runtime_resource_ownerships', 'tenant_session_latest_projection',
    ]) {
      await expect(reader.query(`SELECT 1 FROM ${table} LIMIT 0`)).resolves.toMatchObject({ rowCount: 0 })
      await expect(reader.query(`DELETE FROM ${table} WHERE false`)).rejects.toMatchObject({ code: '42501' })
    }
    await expect(reader.query('SELECT * FROM private_control_marker')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM kala_schema_migrations')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('CREATE TABLE gateway_must_not_create_tables (id integer)')).rejects.toMatchObject({ code: '42501' })
    await reader.end()

    const runtime = new Pool({ connectionString: runtimeUrl })
    await expect(assertPostgresSchemaCurrent(runtime)).resolves.toBe(6)
    await expect(runtime.query('SELECT * FROM tenant_runtime_unit_protocol_gates')).resolves.toMatchObject({ rowCount: 0 })
    await expect(runtime.query(`INSERT INTO tenant_runtime_unit_protocol_gates
      (organization_id, unit_id, feature_version, barrier_generation) VALUES ('org', 'unit', 1, 1)`))
      .rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query('CREATE TABLE runtime_must_not_create_tables (id integer)')).rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query('SELECT * FROM private_control_marker')).rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query('UPDATE kala_schema_migrations SET checksum = checksum')).rejects.toMatchObject({ code: '42501' })
    await runtime.end()

    hotState = createPostgresHotStateStore({ connectionString: runtimeUrl, applicationName: `${project}-runtime` })
    const scope = { tenantId: 'org_test', scopeType: 'session' as const, scopeId: 'session_test' }
    const lease = await hotState.acquireLease(scope, 'runtime-test', 10_000)
    await hotState.appendEvent(lease, { idempotencyKey: 'event-1', eventType: 'test', payload: { ok: true } })
    await expect(hotState.replay(scope)).resolves.toHaveLength(1)

    const state = new PostgresTenantStateStore(hotState.database, 'org_test', new Uint8Array(32).fill(7))
    await state.writeMemo('user', { content: 'migrated schema DML works' })
    await expect(state.readMemo('user')).resolves.toMatchObject({ content: 'migrated schema DML works', revision: 1 })
  }, 120_000)

  it('refuses v3 to v4 when two Units already own the same resource, without deleting either row', async () => {
    const schema = `migration_conflict_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      // Copy verified historical checksums instead of inventing a migration history.
      await admin.query(`CREATE TABLE "${schema}".kala_schema_migrations
        (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL)`)
      await admin.query(`INSERT INTO "${schema}".kala_schema_migrations
        SELECT version, name, checksum FROM public.kala_schema_migrations WHERE version <= 3`)
      await admin.query(`CREATE TABLE "${schema}".tenant_runtime_resource_ownerships
        (organization_id text NOT NULL, unit_id text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL)`)
      await admin.query(`INSERT INTO "${schema}".tenant_runtime_resource_ownerships VALUES
        ('org', 'unit-a', 'session', 'same-session'), ('org', 'unit-b', 'session', 'same-session')`)

      await expect(migratePostgres({ connectionString: adminUrl, schema })).rejects.toMatchObject({ code: '23505' })
      const history = await admin.query(`SELECT version FROM "${schema}".kala_schema_migrations ORDER BY version`)
      expect(history.rows.map((row) => row.version)).toEqual([1, 2, 3])
      await expect(assertPostgresSchemaCurrent(admin, { schema })).rejects.toThrow('not current')
      const owners = await admin.query(`SELECT unit_id FROM "${schema}".tenant_runtime_resource_ownerships ORDER BY unit_id`)
      expect(owners.rows.map((row) => row.unit_id)).toEqual(['unit-a', 'unit-b'])
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    }
  }, 120_000)
})

async function docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}
