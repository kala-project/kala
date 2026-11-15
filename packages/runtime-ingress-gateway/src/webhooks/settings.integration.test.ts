import { execFile } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grantControlWriter } from '../bin/init-control-plane.js'
import { scopedWebhookSecrets } from '../bin/webhook-worker.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, migrateControlPlane,
  readControlPlaneMigrations, type ControlPlaneDatabase } from '../persistence/postgres.js'
import { parseSettingsPage } from '../organizations/settings-view.js'
import { PostgresWebhookSettingsStore } from './settings-store.js'
import { WebhookOutboxWorker } from './outbox-worker.js'
import { grantWebhookWorker } from './worker-authority.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
integration('immutable organization Webhook settings / actual PostgreSQL roles and HTTP', () => {
  const container = `kala-webhook-settings-${randomUUID()}`
  const password = randomUUID()
  const databases: ControlPlaneDatabase[] = []
  const received: Array<{ body: string; signature: string }> = []
  const receiver = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    received.push({ body, signature: String(request.headers['x-agent-runlab-signature']) })
    response.writeHead(204); response.end()
  })
  let owner: ControlPlaneDatabase
  let gateway: ControlPlaneDatabase
  let worker: ControlPlaneDatabase
  let bindingsOperator: ControlPlaneDatabase
  let store: PostgresWebhookSettingsStore
  let origin: string
  const actor = (organizationId: string) => ({ issuer: 'https://fixture-identity.test', subject: organizationId })
  const reference = (organizationId: string, version = 'v1') => `bao:organizations/${organizationId}/webhooks/${version}#key`
  const page = { limit: 50 }
  const bindingId = async (organizationId: string) => (await store.bindings(organizationId)).bindings[0]!.id
  const body = async (organizationId: string) => ({
    url: `${origin}/business`, topics: ['usage.monthly_token_threshold'], enabled: true,
    secretBindingId: await bindingId(organizationId),
  })

  beforeAll(async () => {
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', 'POSTGRES_DB=runlab_control', '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const port = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])).stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('isolated PostgreSQL port unavailable')
    const connect = (role: string) => {
      const database = createPostgresControlPlaneDatabase({
        connectionString: `postgresql://${role}:${password}@127.0.0.1:${port}/runlab_control`, maxConnections: 4,
      })
      databases.push(database)
      return database
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
    await migrateControlPlane(owner, migrations.slice(0, 14))
    for (const [organizationId, count] of [['org_a', 2], ['org_b', 1], ['org_cap', 99], ['org_limit', 101]] as const) {
      await owner.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES ($1,$1,'active',$2)`, [organizationId, `unit_${organizationId}`])
      await owner.query(`INSERT INTO principals(id,kind,issuer,subject) VALUES ($1,'human',$2,$3)`,
        [`prn_${organizationId}`, actor(organizationId).issuer, actor(organizationId).subject])
      await owner.query(`INSERT INTO organization_memberships(organization_id,principal_id,role) VALUES ($1,$2,'owner')`,
        [organizationId, `prn_${organizationId}`])
      for (let index = 0; index < count; index++) {
        await owner.query(`INSERT INTO webhook_endpoints(id,organization_id,url,secret_ref,topics)
          VALUES ($1,$2,$3,$4::jsonb,ARRAY['usage.monthly_token_threshold'])`,
        [`${organizationId}_${index}`, organizationId, `${origin}/legacy`,
          JSON.stringify({ ref: reference(organizationId), preservedLegacyMetadata: true })])
      }
    }
    await owner.query(`INSERT INTO webhook_endpoints(id,organization_id,url,secret_ref,topics)
      VALUES ('legacy_invalid','org_a',$1,'{"ref":"bao:organizations/org_b/webhooks/key#key"}',ARRAY['usage.monthly_token_threshold'])`,
    [`${origin}/invalid`])
    await owner.query(`CREATE ROLE settings_gateway LOGIN PASSWORD '${password}';
      CREATE ROLE settings_worker LOGIN PASSWORD '${password}';
      CREATE ROLE settings_binding_operator LOGIN PASSWORD '${password}'`)
    await grantControlWriter(owner, 'settings_gateway')
    gateway = connect('settings_gateway')
    store = new PostgresWebhookSettingsStore(gateway, { publicOrigin: 'https://kala.test', allowedOrigins: [origin], allowLoopbackHttp: true })
    await expect(store.list('org_a', page)).rejects.toMatchObject({ status: 503 })
    const before = (await owner.query(`SELECT id,secret_ref,delivery_generation::text FROM webhook_endpoints
      WHERE id='org_a_0'`)).rows
    await migrateControlPlane(owner, migrations)
    expect(await assertControlPlaneSchema(gateway, migrations)).toBe(17)
    await expect(assertControlPlaneSchema(gateway, migrations.slice(0, 14))).rejects.toThrow('ahead expected version 14')
    expect((await owner.query(`SELECT id,secret_ref,delivery_generation::text FROM webhook_endpoints
      WHERE id='org_a_0'`)).rows).toEqual(before)
    await grantControlWriter(owner, 'settings_gateway')
    await owner.query(`CREATE SCHEMA kala_installation_claim;
      CREATE TABLE kala_installation_claim.marker(singleton boolean PRIMARY KEY,installation_id uuid NOT NULL);
      CREATE TABLE kala_installation_claim.recovery_checkpoint(singleton boolean PRIMARY KEY,
        installation_id uuid NOT NULL,checkpoint_id uuid NOT NULL,key_sha256 text NOT NULL)`)
    await owner.transaction(tx => grantWebhookWorker(tx, 'settings_worker'))
    await owner.query(`GRANT USAGE ON SCHEMA public TO settings_binding_operator;
      GRANT SELECT,INSERT ON organization_webhook_secret_bindings TO settings_binding_operator;
      GRANT UPDATE(label) ON organization_webhook_secret_bindings TO settings_binding_operator`)
    bindingsOperator = connect('settings_binding_operator')
    worker = connect('settings_worker')
  }, 120_000)

  afterAll(async () => {
    receiver.closeAllConnections()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    await Promise.allSettled(databases.map(database => database.close()))
    await exec('docker', ['rm', '--force', container]).catch(() => undefined)
  })

  it('backfills organization-local bindings without rewriting references/generations and disables invalid legacy references', async () => {
    expect((await store.bindings('org_a')).bindings).toHaveLength(1)
    expect((await store.bindings('org_b')).bindings).toHaveLength(1)
    const snapshot = await store.list('org_a', page)
    expect(snapshot.endpoints.find(endpoint => endpoint.id === 'legacy_invalid')).toMatchObject({
      enabled: false, secretBindingId: null, configurationError: 'invalid_secret_reference',
    })
    expect(snapshot.endpoints.find(endpoint => endpoint.id === 'org_a_0')).toMatchObject({ revision: '1', deliveryGeneration: '1' })
    expect(JSON.stringify(snapshot)).not.toContain('bao:')
    expect(JSON.stringify(await store.bindings('org_a'))).not.toContain('bao:')
    await expect(gateway.query("UPDATE organization_webhook_secret_bindings SET label='forbidden'")).rejects.toMatchObject({ code: '42501' })
    await expect(gateway.query("INSERT INTO organization_webhook_secret_bindings VALUES ('bad','org_a','bad','bad',1,now())")).rejects.toMatchObject({ code: '42501' })
  })

  it('enforces immutable binding references, matching namespace and referenced-binding deletion at the database boundary', async () => {
    const id = await bindingId('org_a')
    await expect(bindingsOperator.query('UPDATE organization_webhook_secret_bindings SET secret_ref=$2 WHERE id=$1',
      [id, reference('org_a', 'v2')])).rejects.toMatchObject({ code: '42501' })
    await expect(owner.query('UPDATE organization_webhook_secret_bindings SET secret_ref=$2 WHERE id=$1',
      [id, reference('org_a', 'v2')])).rejects.toMatchObject({ code: '23514' })
    await expect(owner.query('DELETE FROM organization_webhook_secret_bindings WHERE id=$1', [id])).rejects.toMatchObject({ code: '23503' })
    await expect(owner.query('UPDATE webhook_endpoints SET secret_ref=$2::jsonb WHERE id=$1',
      ['org_a_0', JSON.stringify({ ref: reference('org_a', 'unbound') })])).rejects.toMatchObject({ code: '23514' })
    for (const invalid of [reference('org_b'), `${reference('org_a')}\n`, 'bao:organizations/org_a/webhooks/../identity#key']) {
      await expect(bindingsOperator.query(`INSERT INTO organization_webhook_secret_bindings
        (id,organization_id,label,secret_ref) VALUES ($1,'org_a','Bad',$2)`, [randomUUID(), invalid])).rejects.toMatchObject({ code: '23514' })
    }
    await bindingsOperator.query("UPDATE organization_webhook_secret_bindings SET label='Reviewed signing key' WHERE id=$1", [id])
    expect((await store.bindings('org_a')).bindings[0]).toMatchObject({ label: 'Reviewed signing key', revision: '2' })
  })

  it('rejects unknown fields/topics, foreign bindings and actors and destinations outside the worker policy', async () => {
    const input = await body('org_a')
    for (const patch of [{ ...input, secretRef: reference('org_a') }, { ...input, topics: ['arbitrary.event'] },
      { ...input, topics: [] }, { ...input, url: 'https://unapproved.test/event' },
      { ...input, url: `${origin}/event?credential=forbidden` }, { ...input, url: `${origin}/event\npath` }]) {
      await expect(store.create('org_a', actor('org_a'), patch)).rejects.toMatchObject({ status: 400 })
    }
    await expect(store.create('org_a', actor('org_a'), { ...input, secretBindingId: await bindingId('org_b') })).rejects.toMatchObject({ status: 409 })
    await expect(store.create('org_a', actor('org_b'), input)).rejects.toMatchObject({ status: 403 })
  })

  it('serializes competing enables at the 100-endpoint ceiling and permits over-limit disable/remediation', async () => {
    const input = await body('org_cap')
    const raced = await Promise.allSettled([
      store.create('org_cap', actor('org_cap'), input),
      store.create('org_cap', actor('org_cap'), input),
    ])
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(raced.find(result => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'webhook_endpoint_limit_exceeded' },
    })
    expect((await store.list('org_cap', page)).enabledCount).toBe('100')
    const over = await store.list('org_limit', { limit: 100 })
    expect(over).toMatchObject({ blocked: true, enabledCount: '101' })
    await expect(store.create('org_limit', actor('org_limit'), await body('org_limit'))).rejects.toMatchObject({ status: 409 })
    const first = over.endpoints[0]!
    await store.patch('org_limit', actor('org_limit'), first.id, { enabled: false }, first.etag)
    expect((await store.list('org_limit', page))).toMatchObject({ blocked: false, enabledCount: '100' })
  })

  it('requires scoped CAS; keeps a topics-only snapshot unchanged and advances generation for explicit rebind/disable/re-enable', async () => {
    const created = await store.create('org_a', actor('org_a'), await body('org_a'))
    await expect(store.patch('org_a', actor('org_a'), created.id, { enabled: false })).rejects.toMatchObject({ status: 428 })
    const topic = await store.patch('org_a', actor('org_a'), created.id, { topics: ['organization.provisioned'] }, created.etag)
    expect(topic).toMatchObject({ revision: '2', deliveryGeneration: '1' })
    await expect(store.patch('org_a', actor('org_a'), created.id, { enabled: false }, created.etag)).rejects.toMatchObject({ status: 412 })
    const foreignAuthority = new PostgresWebhookSettingsStore(gateway, {
      publicOrigin: 'https://other-kala.test', allowedOrigins: [origin], allowLoopbackHttp: true,
    })
    await expect(foreignAuthority.patch('org_a', actor('org_a'), created.id, { enabled: false }, topic.etag)).rejects.toMatchObject({ status: 412 })
    await bindingsOperator.query(`INSERT INTO organization_webhook_secret_bindings
      (id,organization_id,label,secret_ref) VALUES ('binding_v2','org_a','Rotated material',$1)`, [reference('org_a', 'v2')])
    const rebound = await store.patch('org_a', actor('org_a'), created.id, { secretBindingId: 'binding_v2' }, topic.etag)
    expect(rebound).toMatchObject({ revision: '3', deliveryGeneration: '2', secretBindingId: 'binding_v2' })
    expect((await owner.query('SELECT secret_ref FROM webhook_endpoints WHERE id=$1', [created.id])).rows[0]?.secret_ref)
      .toEqual({ ref: reference('org_a', 'v2') })
    const disabled = await store.patch('org_a', actor('org_a'), created.id, { enabled: false }, rebound.etag)
    const enabled = await store.patch('org_a', actor('org_a'), created.id, { enabled: true }, disabled.etag)
    expect(enabled).toMatchObject({ revision: '5', deliveryGeneration: '4' })
  })

  it('rolls back endpoint, revision, generation and audit together when the audit insert fails', async () => {
    const created = await store.create('org_a', actor('org_a'), await body('org_a'))
    await owner.query(`CREATE FUNCTION settings_webhook_audit_failure() RETURNS trigger LANGUAGE plpgsql
      AS 'BEGIN RAISE EXCEPTION ''fixture audit failure''; END'`)
    await owner.query(`CREATE TRIGGER settings_webhook_audit_failure BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION settings_webhook_audit_failure()`)
    try {
      await expect(store.patch('org_a', actor('org_a'), created.id, { enabled: false }, created.etag)).rejects.toThrow('fixture audit failure')
      expect((await store.list('org_a', { limit: 100 })).endpoints.find(endpoint => endpoint.id === created.id)).toMatchObject(created)
    } finally { await owner.query('DROP TRIGGER settings_webhook_audit_failure ON audit_events') }
  })

  it('pages only the requested organization and binds cursors to that scope', async () => {
    const first = await store.list('org_cap', { limit: 1 })
    expect(first.nextCursor).toBeTruthy()
    const parameters = new URLSearchParams({ limit: '1', cursor: first.nextCursor! })
    expect(() => parseSettingsPage('org_b', 'webhooks', parameters)).toThrow('invalid_page_cursor')
    const second = await store.list('org_cap', parseSettingsPage('org_cap', 'webhooks', parameters))
    expect(second.endpoints[0]?.id).not.toBe(first.endpoints[0]?.id)
    const keys = await store.bindings('org_a', { limit: 1 })
    expect(keys.nextCursor).toBeTruthy()
    const keyParameters = new URLSearchParams({ limit: '1', cursor: keys.nextCursor! })
    expect(() => parseSettingsPage('org_b', 'webhook-bindings', keyParameters)).toThrow('invalid_page_cursor')
    const nextKey = await store.bindings('org_a', parseSettingsPage('org_a', 'webhook-bindings', keyParameters))
    expect(nextKey.bindings[0]?.id).not.toBe(keys.bindings[0]?.id)
  })

  it('lets legacy-topic endpoints be disabled but refuses to enable unregistered topics', async () => {
    await owner.query("UPDATE webhook_endpoints SET topics=ARRAY['legacy.unregistered'] WHERE id='org_a_0'")
    const legacy = (await store.list('org_a', { limit: 100 })).endpoints.find(row => row.id === 'org_a_0')!
    const disabled = await store.patch('org_a', actor('org_a'), legacy.id, { enabled: false }, legacy.etag)
    await expect(store.patch('org_a', actor('org_a'), legacy.id, { enabled: true }, disabled.etag)).rejects.toMatchObject({ status: 400 })
  })

  it('delivers an actual registered event using the immutable binding snapshot without sending a test event on save', async () => {
    received.length = 0
    const created = await store.create('org_b', actor('org_b'), await body('org_b'))
    expect(received).toHaveLength(0)
    await owner.query(`INSERT INTO outbox_events(id,organization_id,topic,aggregate_type,aggregate_id,payload)
      VALUES ('settings_business_event','org_b','usage.monthly_token_threshold','organization','org_b','{"percent":90}')`)
    const runner = new WebhookOutboxWorker(worker, { allowedOrigins: [origin], allowLoopbackHttp: true,
      resolveSecret: scopedWebhookSecrets({ resolve: async value => {
        expect(value).toBe(reference('org_b'))
        return 'fictional-settings-signing-key'
      } }) })
    expect(await runner.runBatch()).toMatchObject({ delivered: 2, materialized: 1 })
    expect(received).toHaveLength(2)
    for (const request of received) {
      expect(request.signature).toBe(`sha256=${createHmac('sha256', 'fictional-settings-signing-key').update(request.body).digest('hex')}`)
      expect(JSON.parse(request.body)).toMatchObject({ topic: 'usage.monthly_token_threshold', organizationId: 'org_b' })
    }
    expect((await store.list('org_b', page)).endpoints.find(endpoint => endpoint.id === created.id)?.deliveries).toMatchObject({ delivered: '1' })
  })
})
