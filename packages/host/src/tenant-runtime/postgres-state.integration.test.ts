import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { PostgresMemoStore } from '../memo-store.js'
import { PostgresAzureSpeechCredentialStore } from '../speech/credential-store.js'
import { PostgresWebSearchCredentialStore } from '../web-search/credential-store.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './postgres-hot-state.js'
import { PostgresTenantStateStore } from './postgres-state.js'
import { DedicatedModelSettings, DEDICATED_MODEL_SETTINGS_CREDENTIAL } from '../llm/dedicated-model-settings.js'
import type { DashboardActor } from '../auth-control.js'
import type { RuntimeProviderCatalog } from '../llm/runtime-provider-catalog.js'
import { ExplicitLLMClientFactory } from '../llm/client-factory.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('Private Cloud PostgreSQL tenant state integration', () => {
  const testProject = `kala-tenant-state-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const databases: PostgresHotStateStore[] = []
  const modelServices: DedicatedModelSettings[] = []
  const masterKey = randomBytes(32)
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--pull', 'never', '--detach', '--rm',
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
    await Promise.allSettled(modelServices.map(service => service.close()))
    await Promise.allSettled(databases.map(async (database) => await database.close()))
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function state(tenantId: string, key: Uint8Array, applicationName = `${testProject}-${tenantId}`): PostgresTenantStateStore {
    const database = createPostgresHotStateStore({ connectionString, applicationName })
    databases.push(database)
    return new PostgresTenantStateStore(database.database, tenantId, key)
  }

  it('persists atomic live model edits, encrypted keys and tenant isolation with real adapter routing', async () => {
    const calls: Array<{ url: string; key?: string; model: string }> = []
    let holdReply = false
    let releaseReply: (() => void) | undefined
    let entered: (() => void) | undefined
    const provider = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        calls.push({ url: request.url!, key: request.headers.authorization, model: (JSON.parse(body) as { model: string }).model })
        const reply = () => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
        }
        if (holdReply) { holdReply = false; releaseReply = reply; entered?.() } else reply()
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    try {
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      const base = `http://127.0.0.1:${address.port}`
      const seed: RuntimeProviderCatalog = { version: 1, defaultModel: 'seed:original', providers: [{
        id: 'seed', wire: 'openai', baseUrl: `${base}/seed`, credentialRef: 'file:seed',
        models: [{ id: 'original' }, { id: 'retained' }],
      }] }
      const actor: DashboardActor = { kind: 'ingress', principal: 'admin', organizationId: 'org-models', role: 'admin' }
      const authority = state('org-models', masterKey)
      const settings = new DedicatedModelSettings(authority, 'org-models', seed, { resolve: async () => 'seed-secret' }, resolver => ({
        create: async config => {
          if (config.baseUrl.endsWith('/compile-failure')) throw new Error('test compiler rejection')
          return new ExplicitLLMClientFactory(resolver).create(config)
        },
      }))
      modelServices.push(settings)
      await settings.load()
      await settings.addProvider({ id: 'custom', wire: 'openai', baseUrl: `${base}/first`, apiKey: 'custom-secret' }, actor)
      expect(settings.providers.find(provider => provider.id === 'custom')?.models).toEqual([])
      await settings.addModel({ providerId: 'custom', id: 'first' }, actor)
      await settings.addModel({ providerId: 'custom', id: 'chosen' }, actor)
      await settings.setDefault({ model: 'custom:chosen' }, actor)
      await settings.llm.call({ messages: [], tools: [] })
      expect(calls.at(-1)).toEqual({ url: '/first/chat/completions', key: 'Bearer custom-secret', model: 'chosen' })
      holdReply = true
      const requestStarted = new Promise<void>(resolve => { entered = resolve })
      const inFlight = settings.llm.call({ messages: [], tools: [], model: 'custom:first' })
      await requestStarted
      await settings.updateProvider({ providerId: 'custom', baseUrl: `${base}/edited`, apiKey: '   ' }, actor)
      releaseReply!()
      releaseReply = undefined
      await inFlight
      expect(calls.at(-1)).toEqual({ url: '/first/chat/completions', key: 'Bearer custom-secret', model: 'first' })
      await settings.llm.call({ messages: [], tools: [], model: 'custom:first' })
      expect(calls.at(-1)).toEqual({ url: '/edited/chat/completions', key: 'Bearer custom-secret', model: 'first' })
      const before = (await authority.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL))!.secret
      await expect(settings.updateProvider({ providerId: 'custom', baseUrl: `${base}/compile-failure` }, actor)).rejects.toThrow('compiler rejection')
      await expect(settings.updateProvider({ providerId: 'custom', baseUrl: 'ftp://invalid.test' }, actor)).rejects.toThrow('HTTP(S)')
      await expect(settings.setDefault({ model: 'missing' }, actor)).rejects.toThrow('defaultModel is unknown')
      await expect(settings.deleteModel({ providerId: 'custom', id: 'chosen' }, actor)).rejects.toThrow('another default')
      await expect(settings.deleteProvider({ providerId: 'custom' }, actor)).rejects.toThrow('another default')
      await expect(settings.updateProvider({ providerId: 'custom', apiKey: 'forbidden' }, { ...actor, organizationId: 'other' })).rejects.toMatchObject({ status: 403 })
      await expect(settings.updateProvider({ providerId: 'custom', apiKey: 'forbidden' }, { ...actor, role: 'member' })).rejects.toMatchObject({ status: 403 })
      expect((await authority.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL))!.secret).toBe(before)
      const restarted = new DedicatedModelSettings(state('org-models', masterKey), 'org-models', seed, { resolve: async () => { throw new Error('seed must not be reread') } })
      modelServices.push(restarted)
      await restarted.load()
      expect(restarted.models.map(model => model.ref)).toEqual(['seed:original', 'seed:retained', 'custom:first', 'custom:chosen'])
      expect(restarted.defaultModel).toBe('custom:chosen')
      expect(JSON.stringify(restarted.providers)).not.toContain('secret')
      await restarted.llm.call({ messages: [], tools: [] })
      expect(calls.at(-1)).toEqual({ url: '/edited/chat/completions', key: 'Bearer custom-secret', model: 'chosen' })
      expect(await state('other', masterKey).getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL)).toBeUndefined()
      const row = (await authority.database.query<{ ciphertext: Buffer; metadata: unknown }>(
        'SELECT ciphertext, metadata FROM tenant_state_credentials WHERE tenant_id = $1 AND credential_id = $2',
        ['org-models', DEDICATED_MODEL_SETTINGS_CREDENTIAL],
      )).rows[0]!
      expect(row.ciphertext.toString()).not.toContain('custom-secret')
      expect(JSON.stringify(row.metadata)).not.toContain('custom-secret')
    } finally {
      releaseReply?.()
      await new Promise<void>(resolve => provider.close(() => resolve()))
    }
  })

  it('persists model metadata patches without changing Session references and rejects invalid patches atomically', async () => {
    const organizationId = `org-${randomUUID()}`
    const authority = state(organizationId, masterKey)
    const seed: RuntimeProviderCatalog = { version: 1, defaultModel: 'stable-session-reference', providers: [{
      id: 'seed', wire: 'openai', baseUrl: 'https://example.test/v1', credentialRef: 'file:seed',
      models: [{ id: 'original', ref: 'stable-session-reference', label: 'Original label', contextWindow: 32000 }],
    }] }
    const actor: DashboardActor = { kind: 'ingress', principal: 'admin', organizationId, role: 'admin' }
    const settings = new DedicatedModelSettings(authority, organizationId, seed, { resolve: async () => 'metadata-secret' })
    modelServices.push(settings)
    await settings.load()
    await settings.updateModel({ providerId: 'seed', id: 'original', label: 'Updated label', contextWindow: 64000 }, actor)
    expect(settings.models[0]).toMatchObject({ id: 'original', ref: 'stable-session-reference', label: 'Updated label', contextWindow: 64000 })
    const before = (await authority.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL))!.secret
    await expect(settings.updateModel({ providerId: 'seed', id: 'original', contextWindow: 0 }, actor)).rejects.toThrow('positive integer')
    await expect(settings.updateModel({ providerId: 'seed', id: 'missing', label: 'Not applied' }, actor)).rejects.toThrow('unknown model')
    await expect(settings.updateModel({ providerId: 'seed', id: 'original' }, actor)).rejects.toThrow('patch is empty')
    expect((await authority.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL))!.secret).toBe(before)
    expect(settings.models[0]).toMatchObject({ ref: 'stable-session-reference', label: 'Updated label', contextWindow: 64000 })
    await settings.updateModel({ providerId: 'seed', id: 'original', label: '' }, actor)
    const restarted = new DedicatedModelSettings(state(organizationId, masterKey), organizationId, seed, {
      resolve: async () => { throw new Error('seed must not be reread') },
    })
    modelServices.push(restarted)
    await restarted.load()
    expect(restarted.models[0]).toMatchObject({ id: 'original', ref: 'stable-session-reference', label: 'original', contextWindow: 64000 })
    expect(restarted.defaultModel).toBe('stable-session-reference')
  })

  it('invalidates live replicas after commits, logs retry failures and rehydrates notification gaps on reconnect', async () => {
    const organizationId = `org-${randomUUID()}`
    const applicationName = `model-${randomUUID()}`
    const writerState = state(organizationId, masterKey)
    const replicaState = state(organizationId, masterKey, applicationName)
    const seed: RuntimeProviderCatalog = { version: 1, defaultModel: 'seed:first', providers: [{
      id: 'seed', wire: 'openai', baseUrl: 'https://example.test/v1', credentialRef: 'file:seed',
      models: [{ id: 'first' }, { id: 'second' }],
    }] }
    const logger = { warn: vi.fn(), info: vi.fn() }
    const writer = new DedicatedModelSettings(writerState, organizationId, seed, { resolve: async () => 'replica-secret' }, undefined, logger)
    const replica = new DedicatedModelSettings(replicaState, organizationId, seed, { resolve: async () => { throw new Error('persisted keys required') } }, undefined, logger)
    modelServices.push(writer, replica)
    const actor: DashboardActor = { kind: 'ingress', principal: 'admin', organizationId, role: 'owner' }
    await writer.load()
    await replica.load()
    const events = new EventEmitter()
    writer.onChange(() => { throw new Error('replica-secret') })
    replica.onChange(() => events.emit('change'))
    vi.spyOn(replicaState, 'getCredential').mockRejectedValueOnce(new Error('replica-secret'))
    let changed = once(events, 'change', { signal: AbortSignal.timeout(5_000) })
    await writer.setDefault({ model: 'seed:second' }, actor)
    await eventually(async () => {
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'model_settings_synchronization_failed', organizationId, retryMs: 1000,
      }), expect.any(String))
    }, 1_000)
    await expect(replica.llm.call({ messages: [], tools: [] })).rejects.toThrow('synchronization is unavailable')
    await changed
    expect(replica.defaultModel).toBe('seed:second')
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'model_settings_synchronization_recovered' }), expect.any(String))
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'model_settings_observer_failed' }), expect.any(String))
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('replica-secret')
    changed = once(events, 'change', { signal: AbortSignal.timeout(5_000) })
    await writer.updateModel({ providerId: 'seed', id: 'second', label: 'Replica metadata', contextWindow: 128000 }, actor)
    await changed
    expect(replica.models.find(model => model.id === 'second')).toMatchObject({
      ref: 'seed:second', label: 'Replica metadata', contextWindow: 128000,
    })
    const listenerName = `${applicationName}-notifications`
    const listener = await writerState.database.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()',
      [listenerName],
    )
    expect(listener.rows).toHaveLength(1)
    changed = once(events, 'change', { signal: AbortSignal.timeout(5_000) })
    await writerState.database.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND datname = current_database() AND application_name = $2',
      [listener.rows[0]!.pid, listenerName],
    )
    await writer.updateProvider({ providerId: 'seed', baseUrl: 'https://edited.test/v1', apiKey: 'rotated-secret' }, actor)
    await changed
    expect(replica.providers[0]?.baseUrl).toBe('https://edited.test/v1')
    changed = once(events, 'change', { signal: AbortSignal.timeout(5_000) })
    await writer.setDefault({ model: 'seed:first' }, actor)
    await changed
    expect(replica.defaultModel).toBe('seed:first')
  }, 15_000)

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
