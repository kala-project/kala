import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresMemoStore } from '../memo-store.js'
import { PostgresAzureSpeechCredentialStore } from '../speech/credential-store.js'
import { PostgresWebSearchCredentialStore } from '../web-search/credential-store.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './postgres-hot-state.js'
import { PostgresTenantStateStore } from './postgres-state.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('Private Cloud PostgreSQL tenant state integration', () => {
  const testProject = `kala-tenant-state-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const databases: PostgresHotStateStore[] = []
  const masterKey = randomBytes(32)
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_tenant_state_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgres://postgres:kala_test_only@127.0.0.1:${port}/kala_tenant_state_test`
    const schema = state('schema', masterKey)
    await eventually(async () => await schema.initializeSchema(), 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(databases.map(async (database) => await database.close()))
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function state(tenantId: string, key: Uint8Array): PostgresTenantStateStore {
    const database = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${tenantId}` })
    databases.push(database)
    return new PostgresTenantStateStore(database.database, tenantId, key)
  }

  it('atomically rejects one of two memo writers with the same revision across nodes', async () => {
    const first = new PostgresMemoStore(state('org-cas', masterKey))
    const second = new PostgresMemoStore(state('org-cas', masterKey))

    const results = await Promise.allSettled([
      first.write('member-a', { content: 'first', expectedRevision: 0 }),
      second.write('member-a', { content: 'second', expectedRevision: 0 }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'memo_revision_conflict' }) })
    expect(await first.read('member-a')).toMatchObject({ revision: 1 })
  })

  it('recovers encrypted web and speech credentials across nodes and isolates organizations', async () => {
    const writerState = state('org-a', masterKey)
    const webWriter = new PostgresWebSearchCredentialStore(writerState)
    const speechWriter = new PostgresAzureSpeechCredentialStore(writerState)
    await webWriter.set('serper', 'serper-secret-value')
    await speechWriter.set({
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      apiKey: 'azure-secret-value',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 7,
      afterRecordingMaxMinutes: 30,
    })

    const readerState = state('org-a', masterKey)
    expect(await new PostgresWebSearchCredentialStore(readerState).get('serper')).toBe('serper-secret-value')
    expect(await new PostgresAzureSpeechCredentialStore(readerState).get()).toMatchObject({
      apiKey: 'azure-secret-value',
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 7,
      afterRecordingMaxMinutes: 30,
    })

    const isolatedState = state('org-b', masterKey)
    expect(await new PostgresWebSearchCredentialStore(isolatedState).get('serper')).toBeUndefined()
    expect(await new PostgresAzureSpeechCredentialStore(isolatedState).get()).toBeUndefined()

    const rows = await writerState.database.query<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; metadata: unknown }>(
      'SELECT ciphertext, nonce, auth_tag, metadata FROM tenant_state_credentials WHERE tenant_id = $1 ORDER BY credential_id',
      ['org-a'],
    )
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows) {
      expect(row.ciphertext.toString('utf8')).not.toContain('secret-value')
      expect(row.nonce).toHaveLength(12)
      expect(row.auth_tag).toHaveLength(16)
      expect(JSON.stringify(row.metadata)).not.toContain('secret-value')
    }
  })

  it('fails closed with the wrong key and deletes both credential kinds', async () => {
    const tenant = `org-key-${randomUUID()}`
    const writerState = state(tenant, masterKey)
    const web = new PostgresWebSearchCredentialStore(writerState)
    const speech = new PostgresAzureSpeechCredentialStore(writerState)
    await web.set('serper', 'delete-web-secret')
    await speech.set({
      endpoint: 'https://eastus.api.cognitive.microsoft.com/',
      apiKey: 'delete-speech-secret',
      enabled: false,
      mode: 'realtime',
    })

    const wrongKeyState = state(tenant, randomBytes(32))
    await expect(new PostgresWebSearchCredentialStore(wrongKeyState).get('serper')).rejects.toThrow('credential_decryption_failed')
    await expect(new PostgresAzureSpeechCredentialStore(wrongKeyState).get()).rejects.toThrow('credential_decryption_failed')

    expect(await web.delete('serper')).toEqual({ configured: false, provider: 'serper' })
    expect(await speech.delete()).toMatchObject({ configured: false, provider: 'azure' })
    expect(await web.get('serper')).toBeUndefined()
    expect(await speech.get()).toBeUndefined()
  })
})

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
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
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}
