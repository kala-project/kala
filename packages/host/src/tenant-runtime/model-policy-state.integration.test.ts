import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@agent-kernel/shared'
import { assertPostgresSchemaCurrent, grantPostgresRuntimeDml, postgresMigrationHistory,
  runPostgresMigrations, type PostgresMigrationPool } from '../postgres-migrations.js'
import { ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, OrganizationModelSettings } from '../llm/organization-model-settings.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './postgres-hot-state.js'
import { PostgresTenantStateStore } from './postgres-state.js'
import { RuntimeModelPolicyState } from './model-policy-state.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_MIGRATION_INTEGRATION === '1' ? describe : describe.skip
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: object) => PostgresMigrationPool }
integration('durable model-policy Runtime authority / actual PostgreSQL', () => {
  const container = `kala-model-policy-${randomUUID()}`, password = randomUUID(), role = 'fixture_runtime'
  const installationId = randomUUID(), organizationId = 'organization-policy-fixture', unitId = 'model-policy-unit'
  const key = randomBytes(32), operationId = randomUUID()
  const identity = { replicaId: randomUUID(), generation: '1', origin: 'http://127.0.0.1:13002' }
  const command: schema.SettingsModelPolicyReconcile = { operationId, organizationId, unitId,
    expectedEffectivePolicyRevision: '1', desiredPolicyRevision: '2', management: 'dashboard' }
  let policy: schema.SettingsModelPolicy = { installationId, organizationId, unitId, installed: false,
    desiredManagement: 'operator', desiredRevision: '1', effectiveManagement: 'operator', effectiveRevision: '1',
    state: 'active', operationId: null, requiredServingScope: [] }
  let owner: PostgresMigrationPool, hot: PostgresHotStateStore, state: PostgresTenantStateStore, runtime: RuntimeModelPolicyState
  let ownerUrl: string, runtimeUrl: string
  const instances: OrganizationModelSettings[] = []
  const reconnect = async () => {
    await hot?.close()
    hot = createPostgresHotStateStore({ connectionString: runtimeUrl })
    state = new PostgresTenantStateStore(hot.database, organizationId, key)
    runtime = new RuntimeModelPolicyState({ installationId, state, unitId,
      policy: { read: async () => structuredClone(policy) }, operatorModelReferences: ['operator:baseline'] })
  }
  beforeAll(async () => {
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--env', `POSTGRES_PASSWORD=${password}`,
      '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const port = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])).stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('fixture PostgreSQL not listening')
    ownerUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`
    runtimeUrl = `postgresql://${role}:${password}@127.0.0.1:${port}/postgres`
    owner = new Pool({ connectionString: ownerUrl })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await owner.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await runPostgresMigrations(owner, { throughVersion: 33 })
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    await grantPostgresRuntimeDml({ connectionString: ownerUrl, runtimeRole: role })
    await reconnect()
  }, 120_000)
  afterAll(async () => {
    await Promise.allSettled(instances.map(instance => instance.close()))
    await hot?.close().catch(() => undefined)
    await owner?.end().catch(() => undefined)
    await exec('docker', ['rm', '--force', container]).catch(() => undefined)
  })

  it('boots and writes on exact33, preserves full histories/ciphertext through35 and excludes Gateway and Runtime mutation of receipts', async () => {
    expect(await assertPostgresSchemaCurrent(hot.database)).toBe(33)
    await runtime.assertSnapshot({ effectiveRevision: '1', effectiveManagement: 'operator' })
    await state.setCredential('bridge-secret', 'protected-fictional-before-expansion', { retained: 'metadata' })
    const before = (await owner.query('SELECT version,name,checksum FROM kala_schema_migrations ORDER BY version')).rows
    const cipher = (await owner.query("SELECT ciphertext,nonce,auth_tag,metadata FROM tenant_state_credentials WHERE credential_id='bridge-secret'")).rows
    await runPostgresMigrations(owner)
    await grantPostgresRuntimeDml({ connectionString: ownerUrl, runtimeRole: role })
    expect(await assertPostgresSchemaCurrent(hot.database)).toBe(36)
    expect((await owner.query('SELECT version,name,checksum FROM kala_schema_migrations WHERE version<=33 ORDER BY version')).rows).toEqual(before)
    expect((await owner.query("SELECT ciphertext,nonce,auth_tag,metadata FROM tenant_state_credentials WHERE credential_id='bridge-secret'")).rows).toEqual(cipher)
    expect(postgresMigrationHistory()[32]?.checksum).toBe('8c2ba7454860aa668508858485cd34020df4b9bcf419dab3e4831d1dd9641bd3')
    expect(postgresMigrationHistory()[33]?.checksum).toBe('48394947737b8cddcaeb0fee37c7a1f8da66fa35eb7642b7529868a9b6184192')
    await state.setCredential('bridge-secret', 'protected-fictional-after-expansion', { retained: 'new metadata' })
    await reconnect()
    expect(await state.getCredential('bridge-secret')).toMatchObject({ secret: 'protected-fictional-after-expansion', metadata: { retained: 'new metadata' } })
    for (const table of ['settings_model_policy_transitions', 'settings_model_policy_replica_receipts']) {
      await expect(hot.database.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      await expect(hot.database.query(`UPDATE ${table} SET management='operator'`)).rejects.toMatchObject({ code: '42501' })
    }
    await expect(hot.database.query('ALTER TABLE settings_model_policy_fences ADD COLUMN forbidden text')).rejects.toMatchObject({ code: '42501' })
    await expect(hot.database.query('UPDATE kala_schema_migrations SET checksum=checksum')).rejects.toMatchObject({ code: '42501' })
  })

  it('requires exact durable drain evidence, rolls back initialization/receipt/fence together and resumes after database-client reconstruction', async () => {
    policy = { ...policy, installed: true, desiredManagement: 'dashboard', desiredRevision: '2',
      operationId, state: 'preparing', requiredServingScope: [{ ...identity, phase: 'drain' }] }
    await expect(runtime.reconcile(command)).rejects.toMatchObject({ code: 'model_policy_quiescence_unverified' })
    expect(await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL)).toBeUndefined()
    let drains = 0
    await expect(runtime.recordDrained(command, { ...identity, generation: '2' }, async () => { drains++ }))
      .rejects.toMatchObject({ code: 'model_policy_replica_scope_mismatch' })
    expect(drains).toBe(0)
    await expect(runtime.recordDrained(command, identity, async () => { throw new Error('safe checkpoint unavailable') }))
      .rejects.toThrow('safe checkpoint unavailable')
    await expect(runtime.reconcile(command)).rejects.toMatchObject({ code: 'model_policy_quiescence_unverified' })
    await runtime.recordDrained(command, identity, async () => { drains++ })
    await runtime.recordDrained(command, identity, async () => { throw new Error('must not drain twice') })
    expect(drains).toBe(1)
    await owner.query(`CREATE FUNCTION fixture_fail_policy_receipt() RETURNS trigger LANGUAGE plpgsql AS $fail$
      BEGIN RAISE EXCEPTION 'fixture transaction failure'; END $fail$;
      CREATE TRIGGER fixture_fail_policy_receipt BEFORE INSERT ON settings_model_policy_transitions
        FOR EACH ROW EXECUTE FUNCTION fixture_fail_policy_receipt()`)
    await expect(runtime.reconcile(command)).rejects.toThrow('fixture transaction failure')
    expect(await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL)).toBeUndefined()
    expect((await owner.query('SELECT count(*)::text AS count FROM settings_model_policy_fences')).rows[0]?.count).toBe('0')
    await owner.query('DROP TRIGGER fixture_fail_policy_receipt ON settings_model_policy_transitions; DROP FUNCTION fixture_fail_policy_receipt()')
    const result = await runtime.reconcile(command)
    expect(result).toMatchObject({ operationId, organizationId, unitId, policyRevision: '2', management: 'dashboard', catalogRevision: '2' })
    const original = (await owner.query('SELECT ciphertext,nonce,auth_tag,metadata FROM tenant_state_credentials WHERE tenant_id=$1 AND credential_id=$2',
      [organizationId, ORGANIZATION_MODEL_SETTINGS_CREDENTIAL])).rows
    expect(JSON.parse((await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL))!.secret)).toEqual({
      version: 1, catalog: { version: 1, defaultModel: null, providers: [] }, keys: {},
    })
    await reconnect()
    expect(await runtime.reconcile(command)).toEqual(result)
    expect((await owner.query('SELECT ciphertext,nonce,auth_tag,metadata FROM tenant_state_credentials WHERE tenant_id=$1 AND credential_id=$2',
      [organizationId, ORGANIZATION_MODEL_SETTINGS_CREDENTIAL])).rows).toEqual(original)
    await expect(runtime.reconcile({ ...command, expectedEffectivePolicyRevision: '2' })).rejects.toThrow()
    await expect(runtime.reconcile({ ...command, organizationId: 'other-organization' })).rejects.toMatchObject({ code: 'model_policy_scope_mismatch' })
  })

  it('requires fresh control and Runtime fences plus the actual loaded catalog revision for startup, with encrypted catalog reconstruction', async () => {
    policy = { ...policy, effectiveManagement: 'dashboard', effectiveRevision: '2', state: 'awaiting_runtime' }
    const expected = { effectiveRevision: '2', effectiveManagement: 'dashboard' as const }
    await expect(runtime.assertSnapshot(expected)).rejects.toMatchObject({ code: 'model_policy_transition_fenced' })
    await runtime.assertSnapshot(expected, undefined, true)
    await expect(runtime.recordReady(expected, { ...identity, generation: '2' }, '1')).rejects.toMatchObject({ code: 'model_policy_catalog_snapshot_mismatch' })
    const acknowledgement = await runtime.recordReady(expected, { ...identity, generation: '2' }, '2')
    expect(acknowledgement).toMatchObject({ policyRevision: '2', management: 'dashboard', catalogRevision: '2', generation: '2' })
    expect(Number.isFinite(Date.parse(acknowledgement.observedAt))).toBe(true)
    policy = { ...policy, state: 'active' }
    const settings = new OrganizationModelSettings(state, organizationId, {
      assertCallAllowed: () => runtime.assertSnapshot(expected),
      assertMutationAllowed: tx => runtime.assertSnapshot(expected, tx),
      assertInitializationAllowed: async () => { throw new Error('reconciliation required') },
    })
    instances.push(settings)
    await settings.load()
    expect(settings.defaultModel).toBeNull()
    await expect(settings.llm.call({ messages: [], tools: [] })).rejects.toThrow('model_not_configured')
    const actor = { kind: 'ingress' as const, principal: 'admin', organizationId, role: 'admin' as const }
    await settings.addProvider({ id: 'owned', wire: 'openai', baseUrl: 'https://provider.invalid/v1', apiKey: 'fictional-owned-key' }, actor)
    const saved = await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL)
    expect(saved?.secret).toContain('fictional-owned-key')
    const encrypted = (await owner.query('SELECT ciphertext FROM tenant_state_credentials WHERE tenant_id=$1 AND credential_id=$2',
      [organizationId, ORGANIZATION_MODEL_SETTINGS_CREDENTIAL])).rows[0]?.ciphertext
    expect(Buffer.isBuffer(encrypted) && encrypted.includes(Buffer.from('fictional-owned-key'))).toBe(false)
    policy = { ...policy, desiredRevision: '3', desiredManagement: 'operator', state: 'preparing', operationId: randomUUID() }
    await expect(settings.addModel({ providerId: 'owned', id: 'must-not-write' }, actor)).rejects.toMatchObject({ code: 'model_policy_transition_fenced' })
    await expect(settings.llm.call({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'model_policy_transition_fenced' })
    expect((await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL))?.secret).toBe(saved?.secret)
  })
})
