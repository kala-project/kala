import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertPostgresSchemaCurrent, grantPostgresArenaOperator, grantPostgresGatewayRuntimeReader, grantPostgresRuntimeDml, migratePostgres, runPostgresMigrations, type PostgresMigrationPool } from './postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './tenant-runtime/postgres-hot-state.js'
import { PostgresSessionAuthority } from './store/postgres-session-authority.js'
import { PostgresTenantStateStore } from './tenant-runtime/postgres-state.js'
import { PostgresAgentPromptSettingsStore } from './tenant-runtime/postgres-agent-settings.js'
import { defaultAgentRuntimeSettings } from './runtime-config.js'

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
  const arenaOperatorPassword = `operator-${randomUUID()}`
  const operatorOrganizationId = randomUUID()
  const operatorRole = `arena_operator_${operatorOrganizationId.replaceAll('-', '')}`
  let adminUrl = ''
  let runtimeUrl = ''
  let readerUrl = ''
  let arenaOperatorUrl = ''
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
    arenaOperatorUrl = `postgresql://${operatorRole}:${encodeURIComponent(arenaOperatorPassword)}@127.0.0.1:${port}/${database}`
    const admin = new Pool({ connectionString: adminUrl })
    await eventually(async () => { await admin.query('SELECT 1') }, 30_000)
    await admin.end()
    await execFileAsync('pnpm', ['build'], { cwd: process.cwd() })
  }, 120_000)

  afterAll(async () => {
    await hotState?.close().catch(() => undefined)
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  it('migrates from zero idempotently, then supports core DML while rejecting Runtime DDL', async () => {
    await expect(migratePostgres({ connectionString: adminUrl })).resolves.toMatchObject({
      previousVersion: 0,
      currentVersion: 27,
      appliedVersions: Array.from({ length: 27 }, (_, i) => i + 1),
    })

    await expect(migratePostgres({ connectionString: adminUrl })).resolves.toMatchObject({
      previousVersion: 27,
      currentVersion: 27,
      appliedVersions: [],
    })

    const admin = new Pool({ connectionString: adminUrl })
    const tables = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    expect(tables.rows.map((row) => row.tablename).length).toBeGreaterThanOrEqual(36)
    expect(tables.rows.map((row) => row.tablename)).toEqual(expect.arrayContaining([
      'tenant_object_capacity_accounts',
      'tenant_object_capacity_allocations',
      'tenant_runtime_unit_replica_memberships',
      'tenant_runtime_resource_ownerships',
      'tenant_runtime_active_workspace_effects',
      'tenant_runtime_arena_repository_claims',
      'tenant_runtime_arena_reconciliations',
      'tenant_runtime_arena_non_admissions',
      'tenant_runtime_arena_state_repairs',
      'tenant_runtime_unit_protocol_gates',
      'tenant_session_native_fs_usage',
      'tenant_session_native_fs_nodes',
      'tenant_session_native_fs_chunks',
      'tenant_session_native_posix_usage',
      'tenant_session_native_posix_nodes',
      'tenant_session_native_posix_blocks',
      'tenant_session_native_fs_admission',
      'tenant_agent_prompt_settings',
      'tenant_session_agent_boards',
      'tenant_session_child_commands',
    ]))
    await admin.query(`CREATE ROLE kala_runtime LOGIN PASSWORD '${runtimePassword.replaceAll("'", "''")}'`)
    await admin.query(`CREATE ROLE kala_gateway_reader LOGIN PASSWORD '${readerPassword.replaceAll("'", "''")}'`)
    await admin.query(`CREATE ROLE "${operatorRole}" LOGIN PASSWORD '${arenaOperatorPassword.replaceAll("'", "''")}'`)
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await admin.query('CREATE TABLE private_control_marker (id integer)')
    await admin.query('CREATE ROLE kala_runtime_ddl; GRANT CREATE ON SCHEMA public TO kala_runtime_ddl')
    await admin.query('CREATE ROLE kala_runtime_history; GRANT UPDATE ON kala_schema_migrations TO kala_runtime_history')
    await admin.query('GRANT UPDATE, DELETE ON tenant_runtime_arena_non_admissions TO kala_runtime')
    await admin.end()
    await expect(grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime_ddl' }))
      .rejects.toThrow('DDL privileges')
    await expect(grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime_history' }))
      .rejects.toThrow('migration history')
    await grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime' })
    await grantPostgresRuntimeDml({ connectionString: adminUrl, runtimeRole: 'kala_runtime' })
    await expect(grantPostgresArenaOperator({ connectionString: adminUrl, operatorRole: 'kala_runtime', organizationId: operatorOrganizationId }))
      .rejects.toThrow('exact organization')
    await grantPostgresArenaOperator({ connectionString: adminUrl, operatorRole, organizationId: operatorOrganizationId })
    await grantPostgresArenaOperator({ connectionString: adminUrl, operatorRole, organizationId: operatorOrganizationId })
    const operator = new Pool({ connectionString: arenaOperatorUrl })
    await expect(operator.query('SELECT effect_id FROM tenant_runtime_active_workspace_effects')).rejects.toMatchObject({ code: '42501' })
    await expect(operator.query(`SELECT * FROM kala_arena_operator_effects($1,'unit','session',20)`,
      [operatorOrganizationId])).resolves.toMatchObject({ rowCount: 0 })
    await expect(operator.query(`SELECT * FROM kala_arena_operator_effects($1,'unit','session',20)`,
      [randomUUID()])).rejects.toMatchObject({ code: 'P0001' })
    for (const table of ['tenant_runtime_resource_ownerships', 'tenant_runtime_arena_repository_claims',
      'tenant_runtime_hot_events', 'tenant_session_latest_projection', 'tenant_runtime_arena_reconciliations',
      'tenant_runtime_arena_state_repairs']) {
      await expect(operator.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      await expect(operator.query(`DELETE FROM ${table} WHERE false`)).rejects.toMatchObject({ code: '42501' })
    }
    await expect(operator.query('SELECT owner_token FROM tenant_runtime_active_workspace_effects')).rejects.toMatchObject({ code: '42501' })
    await expect(operator.query('SELECT request_digest FROM tenant_runtime_active_workspace_effects')).rejects.toMatchObject({ code: '42501' })
    await expect(operator.query('SELECT kala_arena_operator_claim($1,$2,$3,$4)',
      [randomUUID(), 'unit', 'session', 'git-common-inode:41:72'])).rejects.toMatchObject({ code: 'P0001' })
    await expect(operator.query('SELECT kala_arena_operator_dispatch($1,$2,$3,$4) AS dispatch',
      [operatorOrganizationId, 'unit', 'session', 'arena-probe-EMPTY']))
      .resolves.toMatchObject({ rows: [{ dispatch: null }] })
    await expect(operator.query('SELECT kala_arena_operator_dispatch($1,$2,$3,$4)',
      [randomUUID(), 'unit', 'session', 'arena-probe-EMPTY'])).rejects.toMatchObject({ code: 'P0001' })
    await expect(operator.query('DELETE FROM tenant_runtime_active_workspace_effects WHERE false')).rejects.toMatchObject({ code: '42501' })
    await expect(operator.query(`SELECT kala_arena_operator_state('x', 'x') AS arena`)).resolves.toMatchObject({
      rows: [{ arena: null }],
    })
    await expect(operator.query('SELECT 1 FROM tenant_agent_prompt_settings LIMIT 0')).rejects.toMatchObject({ code: '42501' })
    await expect(operator.query(`INSERT INTO tenant_runtime_arena_reconciliations
      (organization_id,unit_id,resource_id,effect_id,generation,operator_id,incident_id,evidence)
      VALUES ('x','x','x','x',1,'x','x','{}')`)).rejects.toMatchObject({ code: '42501' })
    await expect(operator.query(`SELECT kala_reconcile_arena_effect(
      'x','x','x','x',1,'x','x','forged','incident','{}',NULL,'{}')`)).rejects.toMatchObject({ code: 'P0001' })
    await expect(operator.query(`SELECT kala_reconcile_arena_effect(
      'x','x','x','x',1,'x','x','${operatorRole}','incident','{}',NULL,'{}')`))
      .rejects.toMatchObject({ code: 'P0001' })
    await expect(operator.query(`SELECT kala_arena_repair_init(
      'x','x','x','arena-init-A',1,'x','x','${operatorRole}','incident','{}','{}','{}')`))
      .rejects.toMatchObject({ code: 'P0001' })
    await operator.end()
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
    await expect(reader.query('SELECT * FROM tenant_session_native_fs_chunks')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM tenant_runtime_active_workspace_effects')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM tenant_agent_prompt_settings')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM tenant_session_agent_boards')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM tenant_session_child_commands')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM private_control_marker')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('SELECT * FROM kala_schema_migrations')).rejects.toMatchObject({ code: '42501' })
    await expect(reader.query('CREATE TABLE gateway_must_not_create_tables (id integer)')).rejects.toMatchObject({ code: '42501' })
    await reader.end()

    const runtime = new Pool({ connectionString: runtimeUrl })
    await expect(runtime.query(`SELECT kala_reconcile_arena_effect(
      'x','x','x','x',1,'x','x','kala_runtime','incident','{}',NULL,'{}')`)).rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query(`SELECT kala_arena_operator_state('x', 'x')`)).rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query(`SELECT kala_arena_operator_dispatch('x','x','x','x')`))
      .rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query(`SELECT kala_reconcile_arena_prepared_init(
      'x','x','x','x',1,'x','kala_runtime','incident','{}',NULL)`))
      .rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query(`SELECT kala_reconcile_arena_offline(
      'x','x','x','x',1,'x','kala_runtime','incident','{}',NULL,'prepared')`))
      .rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query(`SELECT kala_arena_repair_init(
      'x','x','x','arena-init-A',1,'x','x','kala_runtime','incident','{}','{}','{}')`))
      .rejects.toMatchObject({ code: '42501' })
    await expect(assertPostgresSchemaCurrent(runtime)).resolves.toBe(27)
    await expect(runtime.query('SELECT * FROM tenant_session_agent_boards')).resolves.toMatchObject({ rowCount: 0 })
    await expect(runtime.query('SELECT * FROM tenant_session_child_commands')).resolves.toMatchObject({ rowCount: 0 })
    await expect(runtime.query('SELECT * FROM tenant_runtime_unit_protocol_gates')).resolves.toMatchObject({ rowCount: 0 })
    await expect(runtime.query('SELECT * FROM tenant_runtime_active_workspace_effects')).resolves.toMatchObject({ rowCount: 0 })
    await expect(runtime.query('SELECT * FROM tenant_runtime_arena_non_admissions')).resolves.toMatchObject({ rowCount: 0 })
    await expect(runtime.query('DELETE FROM tenant_runtime_arena_non_admissions WHERE false'))
      .rejects.toMatchObject({ code: '42501' })
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

    const nativeAuthority = new PostgresSessionAuthority(hotState, 'org_native', { schemaManagement: 'external' })
    await nativeAuthority.create({ sessionId: 'native_dml', state: { cursor: 0 } })
    const native = nativeAuthority.nativeSessionFs('native_dml')
    await native.writeFile('/session-state/events.jsonl', 'operator-migrated native DML\n')
    await native.appendFile('/session-state/events.jsonl', 'append without DDL\n')
    await expect(native.readFile('/session-state/events.jsonl')).resolves.toBe('operator-migrated native DML\nappend without DDL\n')
    const counters = new Pool({ connectionString: runtimeUrl })
    await counters.query(`UPDATE tenant_session_native_fs_usage SET total_bytes = 3221225472
      WHERE tenant_id = 'org_native' AND session_id = 'native_dml'`)
    await native.appendFile('/session-state/events.jsonl', 'beyond former 32-bit accounting\n')
    await expect(counters.query(`SELECT total_bytes FROM tenant_session_native_fs_usage
      WHERE tenant_id = 'org_native' AND session_id = 'native_dml'`))
      .resolves.toMatchObject({ rows: [{ total_bytes: String(3221225472 + Buffer.byteLength('beyond former 32-bit accounting\n')) }] })
    await counters.end()
    await nativeAuthority.requestDeletion('native_dml')
    await nativeAuthority.delete('native_dml')

    const state = new PostgresTenantStateStore(hotState.database, 'org_test', new Uint8Array(32).fill(7))
    await state.writeMemo('user', { content: 'migrated schema DML works' })
    await expect(state.readMemo('user')).resolves.toMatchObject({ content: 'migrated schema DML works', revision: 1 })

    const prompts = new PostgresAgentPromptSettingsStore(hotState.database, 'org_prompt_a')
    const otherPrompts = new PostgresAgentPromptSettingsStore(hotState.database, 'org_prompt_b')
    await expect(prompts.load()).resolves.toEqual(defaultAgentRuntimeSettings())
    const updated = defaultAgentRuntimeSettings()
    updated.selectedSlotId = 'slot-3'
    updated.slots[2]!.prompt = 'organization prompt survives Runtime replacement'
    await prompts.save(updated)
    await expect(new PostgresAgentPromptSettingsStore(hotState.database, 'org_prompt_a').load()).resolves.toEqual(updated)
    await expect(otherPrompts.load()).resolves.toEqual(defaultAgentRuntimeSettings())
    await expect(prompts.save({ ...updated, slots: [] })).rejects.toThrow('invalid agent prompt settings')
    await hotState.database.query("UPDATE tenant_agent_prompt_settings SET settings = '{}'::jsonb WHERE tenant_id = $1", ['org_prompt_a'])
    await expect(prompts.load()).rejects.toThrow('Invalid persisted organization agent prompt settings')
  }, 120_000)

  it('rolls back a failed v22→v23 Arena transaction and resumes only after the obstruction is removed', async () => {
    const schema = `arena_rollback_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl })
    const secretDir = mkdtempSync(join(process.cwd(), 'arena-migration-secret-'))
    try {
      const ownerFile = join(secretDir, 'owner-url')
      writeFileSync(ownerFile, adminUrl, { mode: 0o600 })
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await runPostgresMigrations(admin as unknown as PostgresMigrationPool, { schema, throughVersion: 22 })
      const grantOnly = () => execFileAsync(process.execPath, [
        join(process.cwd(), 'dist', 'bin', 'kala-postgres-migrate.js'),
        '--schema', schema, '--grant-only', '--arena-operator-role', operatorRole,
        '--organization-id', operatorOrganizationId,
      ], { cwd: process.cwd(), env: {
        ...process.env, KALA_POSTGRES_MIGRATION_CONNECTION_STRING_FILE: ownerFile,
      } })
      await expect(grantOnly()).rejects.toThrow('not current')
      await admin.query(`CREATE FUNCTION "${schema}".kala_arena_operator_state(text,text)
        RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'`)
      await expect(migratePostgres({ connectionString: adminUrl, schema })).rejects.toMatchObject({ code: '42723' })
      const afterFailure = await admin.query(`SELECT version FROM "${schema}".kala_schema_migrations
        ORDER BY version DESC LIMIT 1`)
      expect(afterFailure.rows).toEqual([{ version: 22 }])
      const routine = await admin.query('SELECT to_regprocedure($1)::text AS routine', [
        `${schema}.kala_reconcile_arena_effect(text,text,text,text,bigint,text,text,text,text,jsonb,text,jsonb)`,
      ])
      expect(routine.rows[0]?.routine).toBeNull()
      await admin.query(`DROP FUNCTION "${schema}".kala_arena_operator_state(text,text)`)
      await expect(migratePostgres({ connectionString: adminUrl, schema }))
        .resolves.toMatchObject({ previousVersion: 22, currentVersion: 27, appliedVersions: [23,24,25,26,27] })
      await expect(grantOnly()).resolves.toMatchObject({ stdout: expect.stringContaining('"grantOnly":true') })
      const operator = new Pool({ connectionString: arenaOperatorUrl })
      try {
        await expect(operator.query(`SELECT "${schema}".kala_arena_operator_state('x', 'x') AS arena`))
          .resolves.toMatchObject({ rows: [{ arena: null }] })
      } finally { await operator.end() }
    } finally { await admin.end(); rmSync(secretDir, { recursive: true, force: true }) }
  })

  it('provisions and rotates an isolated tenant LOGIN without delivering an owner or cross-tenant credential', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'arena-provision-secret-'))
    const adminFile = join(dir, 'owner-url')
    const credentialFile = join(dir, 'operator-url')
    const org = randomUUID()
    const role = `arena_operator_${org.replaceAll('-', '')}`
    writeFileSync(adminFile, adminUrl, { mode: 0o600 })
    const provision = (...extra: string[]) => execFileAsync(process.execPath, [
      join(process.cwd(), 'dist', 'bin', 'kala-arena-operator-provision.js'),
      adminFile, org, credentialFile, ...extra,
    ], { cwd: process.cwd() })
    try {
      await provision()
      expect(statSync(credentialFile).mode & 0o077).toBe(0)
      const oldUrl = readFileSync(credentialFile, 'utf8').trim()
      expect(oldUrl).not.toContain(adminPassword)
      const scoped = new Pool({ connectionString: oldUrl })
      const admin = new Pool({ connectionString: adminUrl })
      try {
        expect((await scoped.query('SELECT session_user AS login')).rows[0]).toEqual({ login: role })
        expect((await admin.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles
          WHERE rolname = $1`, [role])).rows[0]).toEqual({
          rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false,
        })
        await expect(scoped.query(`SELECT * FROM kala_arena_operator_effects($1,'unit','session',1)`, [org]))
          .resolves.toMatchObject({ rowCount: 0 })
        await expect(scoped.query(`SELECT * FROM kala_arena_operator_effects($1,'unit','session',1)`, [randomUUID()]))
          .rejects.toMatchObject({ code: 'P0001' })
        await expect(scoped.query('SELECT effect_id FROM tenant_runtime_active_workspace_effects'))
          .rejects.toMatchObject({ code: '42501' })
        await expect(scoped.query('SELECT * FROM tenant_session_latest_projection'))
          .rejects.toMatchObject({ code: '42501' })
        const hold = await (scoped as unknown as { connect(): Promise<{
          query(sql: string): Promise<unknown>; release(): void
        }> }).connect()
        try {
          await hold.query('SELECT 1')
          await expect(provision('--rotate')).rejects.toThrow('active database connections')
        } finally { hold.release() }
      } finally { await scoped.end(); await admin.end() }
      await provision('--rotate')
      const nextUrl = readFileSync(credentialFile, 'utf8').trim()
      expect(nextUrl).not.toBe(oldUrl)
      const old = new Pool({ connectionString: oldUrl, connectionTimeoutMillis: 1000 })
      try { await expect(old.query('SELECT 1')).rejects.toMatchObject({ code: '28P01' }) }
      finally { await old.end() }
      const next = new Pool({ connectionString: nextUrl })
      try { await expect(next.query('SELECT session_user AS login')).resolves.toMatchObject({ rows: [{ login: role }] }) }
      finally { await next.end() }
      const { stdout: images } = await docker('image', 'ls', '--format', '{{.ID}} {{.Repository}}')
      const imageId = images.split('\n').find((entry) => entry.endsWith(' node'))?.split(' ')[0]
      if (!imageId) throw new Error('Locally cached Node image required for isolated PID namespace rehearsal')
      const { stdout: digest } = await docker('image', 'inspect', imageId, '--format', '{{.Id}}')
      const image = digest.trim()
      const anchor = `arena-pid-test-${randomUUID()}`
      const other = `arena-pid-test-${randomUUID()}`
      const launch = async (name: string) => await docker('run', '--detach', '--rm',
        '--name', name, '--network', 'none', '--entrypoint', 'node', image,
        '-e', 'setInterval(() => {}, 60000)')
      const { stdout: anchorId } = await launch(anchor)
      try {
        const { stdout: otherId } = await launch(other)
        try {
          const { stdout: identity } = await docker('run', '--rm', '--pull', 'never',
            '--pid', `container:${anchor}`, '--entrypoint', 'node', image,
            '-e', "console.log(require('fs').readlinkSync('/proc/self/ns/pid'))")
          const invoke = async (keeper: string, namespace: string, requestedOrg = org,
            requestedRole = role, action = 'inspect', suffix = '') => await execFileAsync('sg', [
            'docker', '-c', `sh ../../deploy/private-cloud/run-arena-operator.sh ${action} ${requestedOrg} unit session ${suffix}`,
          ], { cwd: process.cwd(), env: {
            ...process.env,
            KALA_ARENA_EXECUTOR_PID_ANCHOR: keeper,
            KALA_ARENA_OPERATOR_IMAGE: image,
            KALA_ARENA_OPERATOR_NETWORK: 'host',
            KALA_ARENA_WORKSPACE_HOST: dir,
            KALA_ARENA_OPERATOR_URL_FILE: credentialFile,
            KALA_ARENA_OPERATOR_ID: requestedRole,
            KALA_ARENA_EXPECTED_PID_NAMESPACE: namespace,
          } })
          await expect(invoke(anchorId.trim(), identity.trim())).resolves.toMatchObject({
            stdout: expect.stringContaining('[]'),
          })
          await expect(invoke(anchorId.trim(), identity.trim(), org, role, 'reconcile',
            `arena-init-123 ${dir} ${join(dir, 'absent-journal')} incident verify-stopped:arena-init-123`))
            .rejects.toThrow('Exact Arena effect not found')
          await expect(invoke(anchorId.trim(), identity.trim(), randomUUID()))
            .rejects.toThrow('tenant mismatch')
          await expect(invoke(anchorId.trim(), identity.trim(), org, 'postgres'))
            .rejects.toThrow('incident operator identity')
          await expect(invoke(otherId.trim(), identity.trim())).rejects.toThrow('original Executor PID namespace')
        } finally { await docker('rm', '--force', other) }
      } finally { await docker('rm', '--force', anchor) }
      await expect(provision()).rejects.toThrow('already exists')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)

  it('renders the legacy production Compose overlays read-only without delivering operator credentials to workloads', async () => {
    const root = '../../deploy/private-cloud/'
    const { stdout } = await docker('compose',
      '-f', `${root}compose.postgres-s3-base.yaml`,
      '-f', `${root}compose.storage-postgres-s3.yaml`,
      '-f', `${root}compose.storage-postgres-s3.parallel.yaml`,
      'config', '--no-interpolate', '--format', 'json')
    const config = JSON.parse(stdout) as { services: Record<string, { command?: string[];
      secrets?: Array<{ source: string }> }> }
    expect(config.services['runtime-schema-init']?.command).toEqual([
      'packages/host/dist/bin/kala-postgres-migrate.js',
      '--runtime-role', '${KALA_RUNTIME_DML_ROLE:?set the existing Runtime DML role}',
      '--gateway-runtime-reader-role', '${KALA_RUNTIME_READER_ROLE:?set the existing Gateway reader role}',
    ])
    expect(config.services['runtime-schema-init']?.secrets?.map((secret) => secret.source))
      .toEqual(['runtime_postgres_owner_url'])
    expect(Object.values(config.services).flatMap((service) => service.secrets ?? [])
      .some((secret) => secret.source.includes('arena_operator'))).toBe(false)
  })
  it('backfills commit-order fanout cursors for existing completed children during v17 upgrade', async () => {
    const schema = `fanout_upgrade_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await admin.query(`CREATE TABLE "${schema}".kala_schema_migrations
        (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL)`)
      await admin.query(`INSERT INTO "${schema}".kala_schema_migrations
        SELECT version, name, checksum FROM public.kala_schema_migrations WHERE version <= 17`)
      await admin.query(`CREATE TABLE "${schema}".tenant_session_child_commands AS
        SELECT * FROM public.tenant_session_child_commands WHERE false`)
      await admin.query(`ALTER TABLE "${schema}".tenant_session_child_commands DROP COLUMN completion_sequence`)
      await admin.query(`INSERT INTO "${schema}".tenant_session_child_commands
        (tenant_id,parent_session_id,child_session_id,command_id,ordinal,kind,message,status,outcome,completed_at)
        VALUES ('tenant','parent','child-b','call-b',1,'message','B','completed',
          '{"ok":true,"content":"done"}','2026-01-02T00:00:00Z'),
          ('tenant','parent','child-a','call-a',1,'message','A','completed',
          '{"ok":true,"content":"done"}','2026-01-01T00:00:00Z')`)
      await expect(runPostgresMigrations(admin as unknown as PostgresMigrationPool, { schema, throughVersion: 18 })).resolves.toMatchObject({
        previousVersion: 17, currentVersion: 18, appliedVersions: [18],
      })
      const rows = await admin.query(`SELECT child_session_id,completion_sequence::text
        FROM "${schema}".tenant_session_child_commands ORDER BY completion_sequence`)
      expect(rows.rows).toEqual([
        { child_session_id: 'child-a', completion_sequence: '1' },
        { child_session_id: 'child-b', completion_sequence: '2' },
      ])
      await expect(admin.query(`INSERT INTO "${schema}".tenant_session_child_commands
        (tenant_id,parent_session_id,child_session_id,command_id,ordinal,kind,message,status,outcome,completed_at)
        VALUES ('tenant','parent','old-writer','call-old',1,'message','old','completed',
          '{"ok":true,"content":"done"}',clock_timestamp())`)).rejects.toMatchObject({ code: '23514' })
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    }
  }, 120_000)

  it('upgrades an isolated v11 schema through Board v12–v18 and Arena v19–v27 without rewriting prior checksums', async () => {
    const schema = `combined_v11_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await expect(runPostgresMigrations(admin as unknown as PostgresMigrationPool, { schema, throughVersion: 11 }))
        .resolves.toMatchObject({ currentVersion: 11 })
      const before = await admin.query(`SELECT version, checksum FROM "${schema}".kala_schema_migrations ORDER BY version`)
      await expect(migratePostgres({ connectionString: adminUrl, schema })).resolves.toMatchObject({
        previousVersion: 11, currentVersion: 27, appliedVersions: Array.from({ length: 16 }, (_, i) => i + 12),
      })
      const after = await admin.query(`SELECT version, checksum FROM "${schema}".kala_schema_migrations
        WHERE version <= 11 ORDER BY version`)
      expect(after.rows).toEqual(before.rows)
      const both = await admin.query(`SELECT
        to_regclass($1)::text AS board, to_regclass($2)::text AS arena`,
      [`${schema}.tenant_session_child_commands`, `${schema}.tenant_runtime_arena_non_admissions`])
      expect(both.rows[0]).toEqual({
        board: `${schema}.tenant_session_child_commands`,
        arena: `${schema}.tenant_runtime_arena_non_admissions`,
      })
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    }
  }, 120_000)

  it('refuses an older private Arena v12 history instead of silently treating it as Board v12', async () => {
    const schema = `arena_legacy_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await runPostgresMigrations(admin as unknown as PostgresMigrationPool, { schema, throughVersion: 11 })
      await admin.query(`INSERT INTO "${schema}".kala_schema_migrations(version,name,checksum)
        VALUES (12,'active_workspace_effect_barrier',$1)`, ['0'.repeat(64)])
      await expect(migratePostgres({ connectionString: adminUrl, schema }))
        .rejects.toThrow('private Arena / Board migration identity conflict')
      const history = await admin.query(`SELECT version,name FROM "${schema}".kala_schema_migrations WHERE version=12`)
      expect(history.rows).toEqual([{ version: 12, name: 'active_workspace_effect_barrier' }])
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    }
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
