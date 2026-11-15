import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { io as connect } from 'socket.io-client'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { startHostServer, type HostServer } from '../server.js'
import { defaultAgentRuntimeSettings } from '../runtime-config.js'
import { grantPostgresRuntimeDml, runPostgresMigrations, type PostgresMigrationPool } from '../postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './postgres-hot-state.js'
import { PostgresAgentPromptSettingsStore } from './postgres-agent-settings.js'
import { PostgresSettingsServingSet } from './settings-serving-set.js'
import { createPostgresRuntimeResourceOwnershipStore, type RuntimeUnitReplicaMembership } from './postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from './unit.js'

const exec = promisify(execFile)
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: object) => PostgresMigrationPool }
const integration = process.env.KALA_RUN_POSTGRES_MIGRATION_INTEGRATION === '1' ? describe : describe.skip
integration('Agent configuration / actual PostgreSQL notification gap and two native HTTP consumers', () => {
  const container = `kala-agent-settings-${randomUUID()}`, password = randomUUID()
  const root = resolve('../../.settings-test-work', container), instances: HostServer[] = [], pools: PostgresHotStateStore[] = []
  let owner: PostgresMigrationPool, url: string
  let replicas: ReturnType<typeof createPostgresRuntimeResourceOwnershipStore>
  let holdCall: Promise<void> | undefined, callEntered = false
  beforeAll(async () => {
    await mkdir(root, { recursive: true })
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--env', `POSTGRES_PASSWORD=${password}`,
      '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const port = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])).stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('fixture PostgreSQL unavailable')
    const ownerUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`
    owner = new Pool({ connectionString: ownerUrl })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await owner.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await runPostgresMigrations(owner, { throughVersion: 33 })
    await owner.query(`CREATE ROLE agent_runtime LOGIN PASSWORD '${password}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    await grantPostgresRuntimeDml({ connectionString: ownerUrl, runtimeRole: 'agent_runtime' })
    url = `postgresql://agent_runtime:${password}@127.0.0.1:${port}/postgres`
    replicas = createPostgresRuntimeResourceOwnershipStore({ connectionString: url })
    const baseline = createPostgresHotStateStore({ connectionString: url }); pools.push(baseline)
    const old = new PostgresAgentPromptSettingsStore(baseline.database, 'organization-fixture')
    await old.save(defaultAgentRuntimeSettings())
    expect(await old.revision()).toBeUndefined()
    await runPostgresMigrations(owner)
    await grantPostgresRuntimeDml({ connectionString: ownerUrl, runtimeRole: 'agent_runtime' })
  }, 120_000)
  afterAll(async () => {
    await Promise.allSettled(instances.map(instance => instance.close()))
    await Promise.allSettled(pools.map(pool => pool.close()))
    await owner?.end()
    await replicas?.close()
    await exec('docker', ['rm', '--force', container]).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  it('records only completed ordered Session refreshes and reconstructs both real consumers after LISTEN loss', async () => {
    const settings: PostgresAgentPromptSettingsStore[] = []
    const views: PostgresSettingsServingSet[] = [], leases: RuntimeUnitReplicaMembership[] = [], publications: (() => Promise<void>)[] = []
    for (const id of ['one', 'two']) {
      const pool = createPostgresHotStateStore({ connectionString: url, applicationName: `fixture-agent-${id}` }); pools.push(pool)
      const source = new PostgresAgentPromptSettingsStore(pool.database, 'organization-fixture'); settings.push(source)
      const index = settings.length - 1
      const view = new PostgresSettingsServingSet({ database: pool.database, organizationId: 'organization-fixture',
        unitId: 'fixture-unit', membership: () => leases[index] })
      views.push(view)
      let native: HostServer | undefined, tail = Promise.resolve()
      const publish = () => {
        const next = tail.catch(() => undefined).then(async () => {
          if (native) {
            const revision = await source.revision()
            if (revision) await view.publish({ kind: 'agent', id: 'runtime' }, native.agentSettingsObservation(revision))
          }
        })
        tail = next; return next
      }
      publications.push(publish)
      const server = await startHostServer({
        port: 0, sessionsDir: resolve(root, id, 'sessions'), vapidKeys: null, copilot: { enabled: false },
        defaultConfig: { tools: [], systemPrompt: 'initial fixture prompt' },
        resolveSystemPrompt: async () => {
          const value = await source.load()
          return value.slots.find(slot => slot.id === value.selectedSlotId)!.prompt
        },
        llm: { name: 'fictional-no-network', call: async () => {
          callEntered = true
          await holdCall
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'fixture completed safely' }] } }
        } },
        settingsRevision: resource => resource === 'agent' ? source.revision() : Promise.resolve(undefined),
        settingsServingSet: view, onAgentApplicationChange: () => { void publish().catch(() => undefined) },
        onAgentSettingsChange: (listener, onState) => source.subscribe(() => listener({ kind: 'anonymous' }), onState),
        settingsConfiguration: async () => {
          const snapshot = await source.configuration()
          return { resource: { kind: 'agent', id: 'runtime' }, revision: snapshot.revision, capabilities: [],
            value: { agentPrompt: { ...snapshot.value, configPath: 'protected-fixture' } },
            application: { state: 'unknown', desiredRevision: snapshot.revision, effectiveRevision: null,
              scope: 'unit', applyMode: 'next-turn',
              observations: [{ unitId: 'fixture-unit', replicaId: id, revision: null, observedAt: new Date().toISOString(), synchronization: 'synchronizing' }] } }
        },
      })
      native = server
      leases[index] = await replicas.registerReplica({ organizationId: 'organization-fixture', unitId: parseTenantRuntimeUnitId('fixture-unit'),
        replicaId: id, membershipToken: randomUUID(), origin: `http://127.0.0.1:${server.port}` }, 120_000)
      instances.push(server)
      await server.store.ensure({ sessionId: `session-${id}`, defaultConfig: { tools: [], systemPrompt: 'initial fixture prompt' } })
      await publish()
    }
    const read = async (server: HostServer) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/settings/sections/agent`)
      expect(response.status).toBe(200)
      return response.json()
    }
    const change = defaultAgentRuntimeSettings()
    const updated = { ...change, slots: change.slots.map(slot => ({ ...slot, prompt: 'new durable fixture prompt' })) }
    await settings[0]!.save(updated, { expectedRevision: '1' })
    await vi.waitFor(async () => {
      for (const [index, server] of instances.entries()) {
        expect(server.store.get(`session-${index ? 'two' : 'one'}`)!.config.systemPrompt).toBe('new durable fixture prompt')
        expect(await read(server)).toMatchObject({ revision: '2', application: {
          state: 'applied', effectiveRevision: '2', reasonCode: 'all_current_serving_consumers_observed',
          sessionObservations: [{ state: 'applied', desiredRevision: '2', effectiveRevision: '2' }],
        } })
      }
    }, { timeout: 5_000 })
    await owner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='fixture-agent-two-notifications'")
    await vi.waitFor(async () => expect((await read(instances[1]!)).application).toMatchObject({
      state: 'unknown', effectiveRevision: null,
      observations: expect.arrayContaining([expect.objectContaining({ replicaId: 'two', synchronization: 'disconnected', revision: null })]),
      sessionObservations: [{ state: 'unknown', effectiveRevision: null }],
    }))
    await settings[0]!.save({ ...updated, slots: updated.slots.map(slot => ({ ...slot, prompt: 'written during notification gap' })) },
      { expectedRevision: '2' })
    await vi.waitFor(async () => {
      for (const server of instances) expect((await read(server)).application).toMatchObject({
        state: 'applied', effectiveRevision: '3', observations: [
          expect.objectContaining({ replicaId: 'one', generation: '1', synchronization: 'ready', revision: '3' }),
          expect.objectContaining({ replicaId: 'two', generation: '1', synchronization: 'ready', revision: '3' }),
        ],
        sessionObservations: [{ state: 'applied', desiredRevision: '3', effectiveRevision: '3' }],
      })
    }, { timeout: 5_000 })
    expect((await owner.query("SELECT count(*)::text AS count FROM tenant_agent_prompt_settings WHERE tenant_id='organization-fixture'")).rows[0]).toEqual({ count: '1' })
    let release!: () => void
    holdCall = new Promise<void>(resolve => { release = resolve })
    const socket = connect(`http://127.0.0.1:${instances[0]!.port}/dashboard`, { transports: ['websocket'],
      auth: { sessionId: 'session-one', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('session:ready', () => resolve()); socket.once('connect_error', reject) })
      expect(await socket.timeout(2_000).emitWithAck('client:user_message', { intent: 'text', sessionId: 'session-one',
        text: 'hold this real turn', operationId: 'hold-fixture-turn', mode: 'queue' })
        .catch(() => { throw new Error('fixture held-turn admission acknowledgement unavailable') })).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(callEntered).toBe(true))
      await settings[0]!.save({ ...updated, slots: updated.slots.map(slot => ({ ...slot, prompt: 'next safe boundary fixture' })) },
        { expectedRevision: '3' })
      await vi.waitFor(async () => expect((await read(instances[0]!)).application).toMatchObject({
        state: 'pending', effectiveRevision: null, sessionObservations: [{ state: 'pending', desiredRevision: '4', effectiveRevision: null }],
      }))
      expect(instances[0]!.loop.hasActiveLlmCall('session-one')).toBe(true)
      holdCall = undefined; release()
      await instances[0]!.loop.waitForQuiescence()
      expect(await socket.timeout(2_000).emitWithAck('client:user_message', { intent: 'text', sessionId: 'session-one',
        text: 'observe next safe turn', operationId: 'next-fixture-turn', mode: 'queue' })).toMatchObject({ ok: true })
      await vi.waitFor(async () => expect((await read(instances[0]!)).application).toMatchObject({
        sessionObservations: [{ state: 'applied', desiredRevision: '4', effectiveRevision: '4' }],
      }), { timeout: 5_000 })
      await publications[1]!()
      expect((await read(instances[0]!)).application.state).toBe('applied')
      const previous = leases[1]!
      await replicas.releaseReplica(previous)
      const replacement = await replicas.registerReplica({ organizationId: previous.organizationId, unitId: previous.unitId,
        replicaId: previous.replicaId, origin: previous.origin, membershipToken: randomUUID() }, 120_000)
      expect(replacement.generation).toBe(previous.generation + 1n)
      expect(await views[1]!.publish({ kind: 'agent', id: 'runtime' }, instances[1]!.agentSettingsObservation('4'))).toBe(false)
      expect((await read(instances[0]!)).application).toMatchObject({ state: 'unknown', effectiveRevision: null,
        observations: expect.arrayContaining([expect.objectContaining({ replicaId: 'two', generation: '2', revision: null })]) })
      leases[1] = replacement
      await publications[1]!()
      expect((await read(instances[0]!)).application.state).toBe('applied')
      leases[1] = await replicas.renewReplica(replacement, 120_000)
      expect((await read(instances[0]!)).application.state).toBe('unknown')
      await publications[1]!()
      expect((await read(instances[0]!)).application.state).toBe('applied')
    } finally { holdCall = undefined; release(); socket.disconnect() }
  })
})
