import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertPostgresSchemaCurrent, grantPostgresRuntimeDml, postgresMigrationHistory, runPostgresMigrations, type PostgresMigrationPool } from '../postgres-migrations.js'
import { defaultAgentRuntimeSettings } from '../runtime-config.js'
import { PostgresAzureSpeechCredentialStore, DEFAULT_AZURE_SPEECH_ENDPOINT } from '../speech/credential-store.js'
import { PostgresWebSearchCredentialStore } from '../web-search/credential-store.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './postgres-hot-state.js'
import { PostgresAgentPromptSettingsStore } from './postgres-agent-settings.js'
import { PostgresTenantStateStore } from './postgres-state.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: object) => PostgresMigrationPool }

integration('Settings schema33/34/35/36 bridge and transaction-owned revisions', () => {
  const container = `kala-settings-revisions-${randomUUID()}`
  const databases: PostgresHotStateStore[] = []
  const masterKey = randomBytes(32)
  let owner: PostgresMigrationPool
  let ownerUrl: string
  let runtimeUrl: string

  beforeAll(async () => {
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--env', 'POSTGRES_PASSWORD=settings_test_only',
      '--env', 'POSTGRES_DB=settings_test', '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const port = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])).stdout.trim()
    if (!/^[0-9]+$/u.test(port)) throw new Error('isolated PostgreSQL port unavailable')
    ownerUrl = `postgresql://postgres:settings_test_only@127.0.0.1:${port}/settings_test`
    runtimeUrl = `postgresql://settings_runtime:settings_runtime_test_only@127.0.0.1:${port}/settings_test`
    owner = new Pool({ connectionString: ownerUrl })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await owner.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(databases.map((database) => database.close()))
    await owner?.end()
    await exec('docker', ['rm', '--force', container]).catch(() => undefined)
  })

  function state(organizationId: string, url = runtimeUrl) {
    const database = createPostgresHotStateStore({ connectionString: url })
    databases.push(database)
    return new PostgresTenantStateStore(database.database, organizationId, masterKey)
  }

  it('boots the baseline bridge, preserves existing ciphertext/history on expansion and grants actual Runtime DML', async () => {
    await runPostgresMigrations(owner, { throughVersion: 33 })
    expect(await assertPostgresSchemaCurrent(owner)).toBe(33)
    const baseline = state('organization-a', ownerUrl)
    await baseline.setCredential('serper', 'baseline-provider-key', { version: 1, preserved: true })
    await expect(baseline.credentialConfiguration('serper')).rejects.toMatchObject({ status: 503 })
    await expect(baseline.setCredential('serper', 'must-not-write', {}, undefined, undefined, {
      writeProtocol: 'conditional-required',
    })).rejects.toMatchObject({ status: 503 })
    const ciphertext = (await owner.query("SELECT encode(ciphertext,'hex') AS ciphertext, metadata FROM tenant_state_credentials")).rows
    const history = (await owner.query('SELECT version,name,checksum FROM kala_schema_migrations ORDER BY version')).rows
    expect(history).toEqual(postgresMigrationHistory().slice(0, 33))
    await runPostgresMigrations(owner)
    expect(await assertPostgresSchemaCurrent(owner)).toBe(36)
    expect((await owner.query('SELECT version,name,checksum FROM kala_schema_migrations WHERE version <= 33 ORDER BY version')).rows).toEqual(history)
    expect((await owner.query("SELECT encode(ciphertext,'hex') AS ciphertext, metadata FROM tenant_state_credentials")).rows).toEqual(ciphertext)
    await owner.query("CREATE ROLE settings_runtime LOGIN PASSWORD 'settings_runtime_test_only'")
    await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await grantPostgresRuntimeDml({ connectionString: ownerUrl, runtimeRole: 'settings_runtime' })
    const upgraded = state('organization-a')
    expect(await upgraded.credentialConfiguration('serper')).toMatchObject({ revision: '1', value: { secret: 'baseline-provider-key', metadata: { preserved: true } } })
    await expect(upgraded.database.query('CREATE TABLE forbidden_settings_ddl (id int)')).rejects.toMatchObject({ code: '42501' })
    await expect(upgraded.database.query('UPDATE kala_schema_migrations SET checksum = checksum')).rejects.toMatchObject({ code: '42501' })
  })

  it('serializes competing conditional writes, retains tombstones, preserves legacy writers and rolls back ciphertext with revision failure', async () => {
    const first = state('organization-a')
    const second = state('organization-a')
    const searchA = new PostgresWebSearchCredentialStore(first)
    const searchB = new PostgresWebSearchCredentialStore(second)
    const results = await Promise.allSettled([
      searchA.set('serper', 'conditional-first', { expectedRevision: '1' }),
      searchB.set('serper', 'conditional-second', { expectedRevision: '1' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 412 } })
    expect((await searchB.configuration()).revision).toBe('2')
    const before = await searchA.get('serper')
    await owner.query(`CREATE FUNCTION settings_revision_failure() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''fixture revision failure''; END'`)
    await owner.query(`CREATE TRIGGER settings_revision_failure BEFORE UPDATE ON settings_resource_versions
      FOR EACH ROW EXECUTE FUNCTION settings_revision_failure()`)
    try {
      await expect(searchA.set('serper', 'rollback-key', { expectedRevision: '2' })).rejects.toThrow('fixture revision failure')
      expect(await searchA.get('serper')).toBe(before)
      expect((await searchA.configuration()).revision).toBe('2')
    } finally { await owner.query('DROP TRIGGER settings_revision_failure ON settings_resource_versions') }
    await searchB.set('serper', 'compatibility-write')
    expect((await searchA.configuration()).revision).toBe('3')
    await expect(searchA.delete('serper', { writeProtocol: 'conditional-required' })).rejects.toMatchObject({ status: 428 })
    await searchA.delete('serper', { expectedRevision: '3' })
    expect(await searchB.configuration()).toEqual({ revision: '4', value: { configured: false, provider: 'serper' } })
    const reconstructed = new PostgresWebSearchCredentialStore(state('organization-a'))
    await reconstructed.set('serper', 'post-upgrade-rollback-bridge-write', { expectedRevision: '4' })
    expect((await searchA.configuration()).revision).toBe('5')
    expect(await new PostgresWebSearchCredentialStore(state('organization-b')).configuration()).toEqual({
      revision: '1', value: { configured: false, provider: 'serper' },
    })
  })

  it('shares prompt/desktop CAS and preserves Speech keys/durations during partial updates', async () => {
    const authority = state('organization-c')
    const promptsA = new PostgresAgentPromptSettingsStore(authority.database, 'organization-c')
    const promptsB = new PostgresAgentPromptSettingsStore(state('organization-c').database, 'organization-c')
    expect((await promptsA.configuration()).revision).toBe('1')
    await promptsA.update((current) => ({ ...current, selectedSlotId: 'slot-3' }), { expectedRevision: '1' })
    await expect(promptsB.update((current) => ({ ...current, computerUseEnabled: true }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 412 })
    expect(await promptsA.load()).toEqual({ ...defaultAgentRuntimeSettings(), selectedSlotId: 'slot-3' })
    await promptsB.update((current) => ({ ...current, computerUseEnabled: true }), { expectedRevision: '2' })
    expect(await promptsA.configuration()).toMatchObject({ revision: '3', value: { selectedSlotId: 'slot-3', computerUseEnabled: true } })
    const speech = new PostgresAzureSpeechCredentialStore(authority)
    const input = { endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT, enabled: true, mode: 'realtime' as const }
    await speech.set({ ...input, apiKey: 'speech-private-key', realtimeMaxMinutes: 9 }, { expectedRevision: '1' })
    await speech.set({ ...input, enabled: false }, { expectedRevision: '2' })
    expect(await speech.get()).toMatchObject({ apiKey: 'speech-private-key', realtimeMaxMinutes: 9, enabled: false })
    expect((await speech.configuration()).revision).toBe('3')
    expect(JSON.stringify(await speech.configuration())).not.toContain('speech-private-key')
  })
})
