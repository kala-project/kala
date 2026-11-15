import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grantControlWriter } from '../bin/init-control-plane.js'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations,
  assertControlPlaneSchema, type ControlPlaneDatabase } from '../persistence/postgres.js'
import { assertSettingsOperatorPrivileges, grantSettingsOperator } from './operator-authority.js'
import { PostgresSettingsOperator } from './operator-store.js'
import { PostgresModelPolicyReader } from './model-policy-reader.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
integration('typed Settings Operator / actual PostgreSQL identities and CLI', () => {
  const container = `kala-settings-operator-${randomUUID()}`
  const password = randomUUID()
  const installationId = randomUUID()
  const directory = resolve('../../.settings-test-work', `operator-${randomUUID()}`)
  const databases: ControlPlaneDatabase[] = []
  let owner: ControlPlaneDatabase, database: ControlPlaneDatabase, gateway: ControlPlaneDatabase
  let operator: PostgresSettingsOperator
  let connectionString: string
  const profile = { schemaVersion: 1 as const, installationIdFile: `${directory}/installation`,
    controlPlaneDatabaseUrlRef: pathToFileURL(`${directory}/connection`).href, runtimeControlOrigin: 'http://127.0.0.1:1',
    internalCredentialRef: pathToFileURL(`${directory}/internal`).href, planSigningKeyRef: pathToFileURL(`${directory}/key`).href,
    allowedOrganizations: ['org_operator'], allowedResourceKinds: ['workspace', 'pool', 'entitlement', 'webhook-secret-binding', 'model-management'] as const }
  const change = (kind: string, id: string, revision: string, patch: unknown) => ({
    schemaVersion: 1, operationId: randomUUID(), organizationId: 'org_operator',
    resource: { kind, id }, expectedRevision: revision, patch,
  })

  beforeAll(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', 'POSTGRES_DB=runlab_control', '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const port = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])).stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('fixture PostgreSQL unavailable')
    const connect = (role: string) => {
      const value = createPostgresControlPlaneDatabase({ connectionString: `postgresql://${role}:${password}@127.0.0.1:${port}/runlab_control` })
      databases.push(value); return value
    }
    owner = connect('postgres')
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await owner.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const migrations = await readControlPlaneMigrations(resolve('migrations'))
    await migrateControlPlane(owner, migrations.slice(0, 15))
    await owner.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_operator','Fixture','active','operator-unit');
      INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_policy','Policy fixture','active','policy-unit');
      INSERT INTO workspaces(id,organization_id,name) VALUES('ws_fixture','org_operator','Before');
      INSERT INTO executor_pools(id,organization_id,name,mode) VALUES('pool_fixture','org_operator','Before','organization');
      INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,seat_limit,concurrent_session_limit,workspace_limit)
        VALUES('org_operator','contract-fixture','standard',now()-interval '1 day',now()+interval '1 day',10,10,10);
      CREATE ROLE settings_operator LOGIN PASSWORD '${password}';
      CREATE ROLE settings_gateway LOGIN PASSWORD '${password}';
      CREATE SCHEMA kala_installation_claim;
      CREATE TABLE kala_installation_claim.marker(singleton boolean PRIMARY KEY,installation_id uuid);
      CREATE TABLE kala_installation_claim.recovery_checkpoint(singleton boolean PRIMARY KEY,installation_id uuid,checkpoint_id uuid,key_sha256 text)`)
    await owner.query('INSERT INTO kala_installation_claim.marker VALUES(true,$1)', [installationId])
    await owner.query('INSERT INTO kala_installation_claim.recovery_checkpoint VALUES(true,$1,$2,$3)', [installationId, randomUUID(), 'a'.repeat(64)])
    await grantControlWriter(owner, 'settings_gateway')
    gateway = connect('settings_gateway')
    expect(await assertControlPlaneSchema(gateway, migrations)).toBe(15)
    expect(await new PostgresModelPolicyReader(gateway, installationId).read({
      installationId, organizationId: 'org_operator', unitId: 'operator-unit',
    })).toMatchObject({ installed: false, state: 'active', effectiveManagement: 'operator', effectiveRevision: '1' })
    await migrateControlPlane(owner, migrations)
    expect(await assertControlPlaneSchema(gateway, migrations)).toBe(17)
    await expect(assertControlPlaneSchema(gateway, migrations.slice(0, 15))).rejects.toThrow('ahead expected version 15')
    await grantControlWriter(owner, 'settings_gateway')
    await grantSettingsOperator(owner, 'settings_operator')
    database = connect('settings_operator')
    connectionString = `postgresql://settings_operator:${password}@127.0.0.1:${port}/runlab_control`
    operator = new PostgresSettingsOperator(database, {
      profile: { ...profile, allowedResourceKinds: [...profile.allowedResourceKinds] },
      installationFingerprint: 'a'.repeat(64), key: randomBytes(32),
      consumers: { authorizeWebhookReference: async reference => {
        if (!reference.startsWith('bao:organizations/org_operator/webhooks/')) throw new Error('fixture reference denied')
      } },
    })
  }, 120_000)
  afterAll(async () => {
    await Promise.allSettled(databases.map(value => value.close()))
    await exec('docker', ['rm', '--force', container]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  })

  it('audits real effective privileges and excludes browser reads/mutations of the journal and Operator policy', async () => {
    await assertSettingsOperatorPrivileges(database)
    for (const sql of ["UPDATE organizations SET name='forbidden'", "UPDATE principals SET display_name='forbidden'",
      "UPDATE workspaces SET organization_id='org_operator'", 'DELETE FROM organization_webhook_secret_bindings',
      'DELETE FROM audit_events', "UPDATE control_plane_schema_migrations SET checksum='forbidden'"]) {
      await expect(database.query(sql)).rejects.toMatchObject({ code: '42501' })
    }
    await expect(gateway.query('SELECT * FROM settings_operator_operations')).rejects.toMatchObject({ code: '42501' })
    await expect(gateway.query("UPDATE organization_model_management SET desired_management='dashboard'")).rejects.toMatchObject({ code: '42501' })
    await owner.query('GRANT SELECT ON audit_events TO settings_operator')
    await expect(assertSettingsOperatorPrivileges(database)).rejects.toThrow('excessive or missing')
    await owner.query('REVOKE SELECT ON audit_events FROM settings_operator')
    await assertSettingsOperatorPrivileges(database)
  })

  it('reads fresh organization-bound policy through the actual read-only Gateway identity without journal authority', async () => {
    const reader = new PostgresModelPolicyReader(gateway, installationId)
    const request = { installationId, organizationId: 'org_policy', unitId: 'policy-unit' }
    expect(await reader.read(request)).toMatchObject({ installed: true, state: 'active', effectiveManagement: 'operator', effectiveRevision: '1' })
    await expect(reader.read({ ...request, unitId: 'different-unit' })).rejects.toMatchObject({ status: 403 })
    await expect(reader.read({ ...request, installationId: randomUUID() })).rejects.toMatchObject({ status: 403 })
    await expect(reader.read({ ...request, actor: 'browser' })).rejects.toMatchObject({ status: 400 })
    // A compatible Operator metadata write is immediately visible without LISTEN/cache readiness.
    await database.query("UPDATE organization_model_management SET desired_revision=2,effective_revision=2 WHERE organization_id='org_policy'")
    expect(await reader.read(request)).toMatchObject({ desiredRevision: '2', effectiveRevision: '2' })
  })

  it('plans without writes and applies a signed resource revision, audit and dedup receipt atomically', async () => {
    const plan = await operator.plan(change('workspace', 'ws_fixture', '1', { name: 'After' }))
    expect((await operator.inspect('org_operator', plan.resource)).value).toMatchObject({ name: 'Before' })
    expect((await owner.query('SELECT count(*)::text AS count FROM settings_operator_operations')).rows[0]?.count).toBe('0')
    const receipt = await operator.apply(plan)
    expect(receipt).toMatchObject({ state: 'applied', revision: '2', persisted: true, consumerVerification: 'pending' })
    expect(await operator.apply(plan)).toEqual(receipt)
    expect((await owner.query("SELECT count(*)::text AS count FROM audit_events WHERE action='settings.operator.applied'")).rows[0]?.count).toBe('1')
    expect(await operator.verify(plan.operationId)).toMatchObject({ state: 'verified', consumerVerification: 'not-applicable' })
    const stale = await operator.plan(change('workspace', 'ws_fixture', '2', { name: 'Stale' }))
    await gateway.query("UPDATE workspaces SET name='Compatibility writer' WHERE id='ws_fixture'")
    await expect(operator.apply(stale)).rejects.toMatchObject({ exitCode: 3, code: 'revision_conflict' })
    expect(await operator.verify(plan.operationId)).toMatchObject({ consumerVerification: 'failed', reasonCode: 'resource_changed_after_operation' })
  })

  it('reverts only the current reversible revision through a linked new operation and never resets the old counter', async () => {
    const plan = await operator.plan(change('pool', 'pool_fixture', '1', { name: 'Renamed' }))
    await operator.apply(plan)
    const inverse = await operator.revert(plan.operationId, '2')
    expect(inverse).toMatchObject({ revision: '3', state: 'applied' })
    expect((await operator.inspect('org_operator', plan.resource)).value).toMatchObject({ name: 'Before' })
    await expect(operator.revert(plan.operationId, '2')).rejects.toMatchObject({ exitCode: 3 })
    expect((await owner.query('SELECT state,reverted_by FROM settings_operator_operations WHERE id=$1', [plan.operationId])).rows[0])
      .toMatchObject({ state: 'reverted', reverted_by: inverse.operationId })
  })

  it('rolls back the business row, revision, journal and audit together and rejects a reused operation with another signed plan', async () => {
    const plan = await operator.plan(change('workspace', 'ws_fixture', '3', { name: 'Must roll back' }))
    await owner.query(`CREATE FUNCTION settings_operator_fixture_fail() RETURNS trigger LANGUAGE plpgsql
      AS 'BEGIN RAISE EXCEPTION ''operator_fixture_audit_failed''; END';
      CREATE TRIGGER settings_operator_fixture_fail BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION settings_operator_fixture_fail()`)
    try { await expect(operator.apply(plan)).rejects.toThrow('operator_fixture_audit_failed') }
    finally { await owner.query('DROP TRIGGER settings_operator_fixture_fail ON audit_events') }
    expect(await operator.inspect('org_operator', plan.resource)).toMatchObject({ revision: '3', value: { name: 'Compatibility writer' } })
    expect((await owner.query('SELECT 1 FROM settings_operator_operations WHERE id=$1', [plan.operationId])).rowCount).toBe(0)
    const old = (await owner.query<{ id: string }>("SELECT id FROM settings_operator_operations WHERE resource_kind='workspace' LIMIT 1")).rows[0]!
    const reused = await operator.plan({ ...change('workspace', 'ws_fixture', '3', { name: 'Different signed operation' }), operationId: old.id })
    await expect(operator.apply(reused)).rejects.toMatchObject({ exitCode: 3, code: 'operation_id_reused' })
    await expect(operator.plan(change('entitlement', 'org_operator', '1', { endsAt: '2020-01-01T00:00:00Z' })))
      .rejects.toMatchObject({ exitCode: 2, code: 'invalid_entitlement_terms' })
  })

  it('rejects pool rebind when a token/Executor dependency appears after planning, preserving the old association', async () => {
    const plan = await operator.plan(change('pool', 'pool_fixture', '3', { mode: 'workspace', workspaceId: 'ws_fixture' }))
    await owner.query(`INSERT INTO executors(id,organization_id,pool_id,name,status)
      VALUES('exe_fixture','org_operator','pool_fixture','Fixture','active')`)
    await expect(operator.apply(plan)).rejects.toMatchObject({ exitCode: 3, code: 'pool_has_enrollment_references' })
    expect((await operator.inspect('org_operator', plan.resource)).value).toMatchObject({ mode: 'organization', workspaceId: null })
    await expect(operator.plan(change('workspace', 'ws_fixture', '3', { status: 'archived' }))).rejects.toMatchObject({ exitCode: 4 })
  })

  it('preserves encrypted-reference semantics and refuses irreversible binding creation rollback or reference replacement', async () => {
    const plan = await operator.plan(change('webhook-secret-binding', 'operator_binding', '0',
      { label: 'Reviewed key', secretRef: 'bao:organizations/org_operator/webhooks/v1#key' }))
    expect(plan.reversible).toBe(false)
    expect(await operator.apply(plan)).toMatchObject({ revision: '1' })
    expect(await operator.verify(plan.operationId)).toMatchObject({ consumerVerification: 'pending', reasonCode: 'business_delivery_not_observed' })
    await expect(operator.revert(plan.operationId, '1')).rejects.toMatchObject({ exitCode: 3 })
    await expect(database.query("UPDATE organization_webhook_secret_bindings SET secret_ref='forbidden'")).rejects.toMatchObject({ code: '42501' })
    const rename = await operator.plan(change('webhook-secret-binding', 'operator_binding', '1', { label: 'Renamed key' }))
    await operator.apply(rename)
    expect(await operator.verify(rename.operationId)).toMatchObject({ consumerVerification: 'not-applicable' })
  })

  it('stores arbitrary precision decimal metadata without pretending that uninstalled cap consumers enforce it', async () => {
    const limit = '1234567890123456789012345678901234567890'
    const plan = await operator.plan(change('entitlement', 'org_operator', '1', { monthlyTokenLimit: limit, seatLimit: Number.MAX_SAFE_INTEGER }))
    expect(plan.effects).toEqual(['entitlement.reported-metadata'])
    await operator.apply(plan)
    const snapshot = await operator.inspect('org_operator', plan.resource)
    expect(snapshot.value).toMatchObject({ monthlyTokenLimit: limit, seatLimit: Number.MAX_SAFE_INTEGER })
    expect(snapshot.enforcement).toMatchObject({ monthlyTokenLimit: 'reported-only', seatLimit: 'reported-only', endsAt: 'enforced' })
    expect(await operator.verify(plan.operationId)).toMatchObject({ consumerVerification: 'not-applicable' })
  })

  it('runs protected-file Inspect/Plan/Apply/Verify/Revert in the actual separate CLI process and rejects wrong profile scope', async () => {
    for (const [name, value] of Object.entries({ installation: installationId, connection: connectionString,
      key: 'fictional-plan-signing-key-with-at-least-32-bytes', internal: 'fictional-internal-maintenance-key',
      profile: JSON.stringify(profile), change: JSON.stringify(change('workspace', 'ws_fixture', '3', { name: 'CLI name' })) })) {
      await writeFile(`${directory}/${name}`, value, { mode: 0o600 })
    }
    const loader = createRequire(resolve('../host/package.json')).resolve('tsx/esm')
    const command = (...args: string[]) => exec(process.execPath, ['--import', loader,
      resolve('src/bin/control-plane-settings.ts'), ...args, '--profile', `${directory}/profile`], {
      env: { PATH: process.env.PATH, TMPDIR: directory, KALA_INGRESS_MIGRATIONS_DIR: resolve('migrations') },
    })
    const inspected = JSON.parse((await command('inspect', '--organization', 'org_operator', '--resource', 'workspace/ws_fixture')).stdout)
    expect(inspected.revision).toBe('3')
    await command('plan', '--input', `${directory}/change`, '--out', `${directory}/plan`)
    const plan = JSON.parse(await readFile(`${directory}/plan`, 'utf8'))
    await expect(command('apply', '--plan', `${directory}/plan`)).rejects.toMatchObject({ code: 4 })
    const verified = JSON.parse((await command('verify', '--operation', plan.operationId)).stdout)
    expect(verified).toMatchObject({ revision: '4', state: 'verified', consumerVerification: 'not-applicable' })
    await expect(command('revert', '--operation', plan.operationId, '--expected-revision', '4')).rejects.toMatchObject({ code: 4 })
    expect(JSON.parse((await command('inspect', '--organization', 'org_operator', '--resource', 'workspace/ws_fixture')).stdout))
      .toMatchObject({ revision: '5', value: { name: 'Compatibility writer' } })
    await expect(command('inspect', '--organization', 'org_foreign', '--resource', 'workspace/ws_fixture')).rejects.toMatchObject({ code: 2 })
  }, 30_000)
})
