import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebhookOutboxWorker, webhookDeliveryId, type WebhookWorkerOptions } from './outbox-worker.js'
import { assertWebhookInstallation, assertWebhookWorkerPrivileges, grantWebhookWorker } from './worker-authority.js'
import { scopedWebhookSecrets } from '../bin/webhook-worker.js'
import { OrganizationProvisioningService } from '../organizations/provisioning.js'
import { grantControlWriter } from '../bin/init-control-plane.js'
import { RetentionService } from '../governance/retention.js'
import { assertRetentionPrivileges, grantRetentionRole, openRetentionDatabase } from '../governance/retention-authority.js'
import { PostgresUsageLedger } from '../governance/usage-ledger.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations, type ControlPlaneDatabase } from '../persistence/postgres.js'

// Explicit integration gate: creates/removes ONLY its own bounded temporary PG.
// KALA_TEST_WEBHOOK_DELIVERY=1 KALA_TEST_DOCKER_SUDO=1 vitest run <this file>
describe.runIf(process.env.KALA_TEST_WEBHOOK_DELIVERY === '1')('durable control governance / real PostgreSQL and HTTP', () => {
  let container: string | undefined
  let admin: ControlPlaneDatabase
  let a: ControlPlaneDatabase
  let b: ControlPlaneDatabase
  let server: Server
  let origin: string
  let root: string
  let workerUrl: string
  let maintenanceA: ControlPlaneDatabase
  let maintenanceB: ControlPlaneDatabase
  const installation = randomUUID()
  const migrationsDir = resolve(import.meta.dirname, '../../migrations')
  const requests: { path: string; body: string; deliveryId: string; signature: string }[] = []
  const failures = new Set<string>()
  let slow: { path: string; started: () => void; wait: Promise<void> } | undefined
  const children = new Set<ChildProcess>()
  const docker = (...args: string[]) => execFileSync(process.env.KALA_TEST_DOCKER_SUDO === '1' ? 'sudo' : 'docker',
    [...(process.env.KALA_TEST_DOCKER_SUDO === '1' ? ['-n', 'docker'] : []), ...args], { encoding: 'utf8', timeout: 30_000 }).trim()
  const ref = { ref: 'bao:organizations/org_acme/webhooks/key#value' }
  const worker = (db = a, options: Partial<WebhookWorkerOptions> = {}) => new WebhookOutboxWorker(db, {
    allowedOrigins: [origin], allowLoopbackHttp: true, resolveSecret: async () => 'fixture-signing-value', ...options,
  })
  const endpoint = (id: string, path = `/${id}`, org = 'org_acme', secretRef = ref) => admin.query(
    `INSERT INTO webhook_endpoints(id,organization_id,url,secret_ref,topics) VALUES($1,$2,$3,$4,ARRAY['unit.changed'])`, [id, org, origin + path, secretRef])
  const event = (id: string, payload: unknown = { token: 'fixture-private-value', message: 'safe' }) => admin.query(
    `INSERT INTO outbox_events(id,organization_id,topic,aggregate_type,aggregate_id,payload) VALUES($1,'org_acme','unit.changed','organization','org_acme',$2)`, [id, payload])
  const progress = async () => (await admin.query(`SELECT event_id,endpoint_id,state,attempt_count,last_error,last_status,lease_generation FROM webhook_deliveries ORDER BY event_id,endpoint_id`)).rows
  const due = () => admin.query(`UPDATE webhook_deliveries SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'`)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-webhook-framework-'))
    const password = randomUUID()
    container = docker('run', '--pull=never', '-d', '--name', `kala-webhook-test-${randomUUID()}`, '--label', 'kala.test=webhook-framework',
      '--memory', '256m', '--cpus', '0.5', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=192m',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=runlab_control', '-p', '127.0.0.1::5432', 'postgres:16-alpine')
    const port = docker('port', container, '5432/tcp').split(':').at(-1)
    admin = createPostgresControlPlaneDatabase({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/runlab_control`, maxConnections: 4 })
    for (let i = 0; ; i++) {
      try { await admin.query('SELECT 1'); break } catch (error) { if (i >= 50) throw error; await sleep(100) }
    }
    const migrations = await readControlPlaneMigrations(migrationsDir)
    await migrateControlPlane(admin, migrations.slice(0, 7))
    await admin.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload) VALUES('legacy','old','system','system','{}')`)
    await migrateControlPlane(admin, migrations)
    expect((await admin.query(`SELECT webhook_fanout_state FROM outbox_events WHERE id='legacy'`)).rows[0]).toEqual({ webhook_fanout_state: 'legacy_review' })
    await admin.query(`CREATE SCHEMA kala_installation_claim;
      CREATE TABLE kala_installation_claim.marker(singleton boolean PRIMARY KEY,installation_id uuid NOT NULL);
      CREATE TABLE kala_installation_claim.recovery_checkpoint(singleton boolean PRIMARY KEY,installation_id uuid NOT NULL,checkpoint_id uuid NOT NULL,key_sha256 text NOT NULL)`)
    await admin.query('INSERT INTO kala_installation_claim.marker VALUES(true,$1)', [installation])
    await admin.query('INSERT INTO kala_installation_claim.recovery_checkpoint VALUES(true,$1,$2,$3)', [installation, randomUUID(), 'a'.repeat(64)])
    await admin.query(`CREATE ROLE webhook_worker LOGIN PASSWORD '${password}'; CREATE ROLE gateway_writer LOGIN PASSWORD '${password}'; CREATE ROLE retention_maintenance LOGIN PASSWORD '${password}'`)
    await admin.transaction((tx) => grantWebhookWorker(tx, 'webhook_worker'))
    await grantControlWriter(admin, 'gateway_writer')
    await admin.transaction((tx) => grantRetentionRole(tx, 'retention_maintenance'))
    workerUrl = `postgresql://webhook_worker:${password}@127.0.0.1:${port}/runlab_control`
    a = createPostgresControlPlaneDatabase({ connectionString: workerUrl, applicationName: 'webhook-test-a' })
    b = createPostgresControlPlaneDatabase({ connectionString: workerUrl, applicationName: 'webhook-test-b' })
    maintenanceA = createPostgresControlPlaneDatabase({ connectionString: workerUrl.replace('webhook_worker:', 'retention_maintenance:'), applicationName: 'retention-test-a' })
    maintenanceB = createPostgresControlPlaneDatabase({ connectionString: workerUrl.replace('webhook_worker:', 'retention_maintenance:'), applicationName: 'retention-test-b' })
    server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk)
      if (req.url?.startsWith('/v1/')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(req.url.includes('/auth/') ? { auth: { client_token: 'fixture-issued-value', lease_duration: 60 } }
          : { data: { data: { value: 'fixture-signing-value' } } })); return
      }
      requests.push({ path: req.url!, body, deliveryId: String(req.headers['x-agent-runlab-delivery-id']), signature: String(req.headers['x-agent-runlab-signature']) })
      if (slow && slow.path === req.url) { const barrier = slow; barrier.started(); await barrier.wait }
      if (req.url === '/redirect') { res.writeHead(302, { location: `${origin}/must-not-follow` }); res.end(); return }
      res.statusCode = failures.has(req.url!) ? 503 : 204; res.end()
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable')
    origin = `http://127.0.0.1:${address.port}`
    await writeFile(join(root, 'installation'), installation)
    await writeFile(join(root, 'jwt'), 'fixture-workload-identity')
    expect(await worker().runBatch()).toMatchObject({ materialized: 0, claimed: 0 })
  }, 60_000)

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL')
    server?.closeAllConnections()
    if (server) await new Promise<void>((done) => server.close(() => done()))
    await Promise.all([a?.close(), b?.close(), maintenanceA?.close(), maintenanceB?.close(), admin?.close()])
    if (container) docker('rm', '-f', container)
    if (root) await rm(root, { recursive: true, force: true })
  }, 30_000)

  beforeEach(async () => {
    requests.length = 0; failures.clear(); slow = undefined
    // Test owner only, within a disposable database; never a production cleanup path.
    await admin.transaction(async (tx) => {
      await tx.query(`SET LOCAL session_replication_role=replica`)
      await tx.query(`TRUNCATE webhook_deliveries,outbox_events,webhook_endpoints,organizations CASCADE`)
    })
    await admin.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_acme','A','active','unit_a'),('org_other','B','active','unit_b')`)
  })

  it('atomically rolls back a business event; snapshots recipients, isolates endpoint retry, signs and redacts real HTTP', async () => {
    await endpoint('a'); await endpoint('b'); await endpoint('other', '/other', 'org_other')
    await expect(admin.transaction(async (tx) => {
      await tx.query(`UPDATE organizations SET name='rolled back' WHERE id='org_acme'`)
      await tx.query(`INSERT INTO outbox_events(id,organization_id,topic,aggregate_type,aggregate_id,payload) VALUES('rollback','org_acme','unit.changed','organization','org_acme','{}')`)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect((await admin.query(`SELECT name FROM organizations WHERE id='org_acme'`)).rows[0]?.name).toBe('A')
    expect((await admin.query(`SELECT id FROM outbox_events WHERE id='rollback'`)).rowCount).toBe(0)
    // Preserve PostgreSQL microseconds: JS Date would silently exclude recipients
    // registered earlier within this same millisecond.
    await admin.query(`UPDATE webhook_endpoints SET created_at='2000-01-01T00:00:00.000100Z'`)
    await event('evt_1')
    await admin.query(`UPDATE outbox_events SET occurred_at='2000-01-01T00:00:00.000200Z' WHERE id='evt_1'`)
    await endpoint('late')
    failures.add('/b')
    expect(await worker().runBatch()).toMatchObject({ delivered: 1, retried: 1, claimed: 2 })
    expect(requests.map((r) => r.path).sort()).toEqual(['/a', '/b'])
    for (const request of requests) {
      expect(request.body).not.toContain('fixture-private-value')
      expect(JSON.parse(request.body).payload.token).toBe('[redacted]')
      expect(request.signature).toBe(`sha256=${createHmac('sha256', 'fixture-signing-value').update(request.body).digest('hex')}`)
    }
    failures.clear(); await due()
    expect(await worker(b).runBatch()).toMatchObject({ delivered: 1, claimed: 1 })
    expect(requests.filter((r) => r.path === '/a')).toHaveLength(1)
    const retries = requests.filter((r) => r.path === '/b')
    expect(retries).toHaveLength(2); expect(retries[0]?.deliveryId).toBe(retries[1]?.deliveryId)
    expect((await progress()).map((p) => p.state)).toEqual(['delivered', 'delivered'])
  })

  it('two independent workers cannot share a live claim and slow HTTP holds no PostgreSQL transaction', async () => {
    await endpoint('a', '/slow'); await endpoint('b'); await event('evt_parallel')
    let release!: () => void; let started!: () => void
    const observed = new Promise<void>((ready) => { started = ready })
    slow = { path: '/slow', started, wait: new Promise<void>((ready) => { release = ready }) }
    const first = worker(a, { concurrency: 1 }).runBatch(1)
    try {
      await observed
      expect((await admin.query(`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name LIKE 'webhook-test-%' AND state='idle in transaction'`)).rows[0]?.count).toBe(0)
      expect(await worker(b, { concurrency: 1 }).runBatch(1)).toMatchObject({ claimed: 1, delivered: 1 })
      expect(requests.filter((r) => r.path === '/slow')).toHaveLength(1)
    } finally { release() }
    expect(await first).toMatchObject({ delivered: 1 })
    expect((await progress()).every((p) => p.attempt_count === 1)).toBe(true)
  })

  it('expired claim takeover retains delivery identity and rejects a late former owner completion', async () => {
    await endpoint('a', '/slow'); await event('evt_takeover')
    let release!: () => void; let started!: () => void
    const observed = new Promise<void>((ready) => { started = ready })
    slow = { path: '/slow', started, wait: new Promise<void>((ready) => { release = ready }) }
    const first = worker(a).runBatch(1)
    try {
      await observed
      await admin.query(`UPDATE webhook_deliveries SET lease_expires_at=clock_timestamp()-interval '1 second'`)
      slow = undefined
      expect(await worker(b).runBatch(1)).toMatchObject({ delivered: 1 })
    } finally { release() }
    expect(await first).toMatchObject({ stale: 1, delivered: 0 })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.deliveryId).toBe(webhookDeliveryId('evt_takeover', 'a'))
    expect(requests[0]?.deliveryId).toBe(requests[1]?.deliveryId)
    expect((await progress())[0]).toMatchObject({ state: 'delivered', attempt_count: 2, lease_generation: '2' })

    // Actual clock expiry while completion waits behind an unmodified row lock:
    // expiry must be checked AFTER the lock, not in an earlier UPDATE scan.
    await event('evt_locked')
    let secretReady!: () => void; let allowSecret!: () => void; let unlock!: () => void; let lockReady!: () => void
    const secretStarted = new Promise<void>((ready) => { secretReady = ready })
    const secretWait = new Promise<void>((ready) => { allowSecret = ready })
    const lockStarted = new Promise<void>((ready) => { lockReady = ready })
    const lockWait = new Promise<void>((ready) => { unlock = ready })
    const waiting = worker(a, { leaseMs: 1_000, requestTimeoutMs: 500, resolveSecret: async () => {
      secretReady(); await secretWait; return 'fixture-signing-value'
    } }).runBatch(1)
    await secretStarted
    const blocker = admin.transaction(async (tx) => {
      await tx.query(`SELECT event_id FROM webhook_deliveries WHERE event_id='evt_locked' FOR UPDATE`)
      lockReady(); await lockWait
    })
    await lockStarted
    try { allowSecret(); await sleep(1_100) } finally { unlock() }
    await blocker
    expect(await waiting).toMatchObject({ stale: 1, delivered: 0 })
    expect((await progress()).find((p) => p.event_id === 'evt_locked')).toMatchObject({ state: 'inflight' })
    expect(await worker(b).runBatch(1)).toMatchObject({ delivered: 1 })
  })

  it('cancels disabled/retargeted snapshots, rejects destinations and redirects, and times out secrets without late dispatch', async () => {
    await endpoint('a'); await endpoint('b'); await event('evt_cancel')
    failures.add('/a'); failures.add('/b'); await worker().runBatch()
    await admin.query(`UPDATE webhook_endpoints SET enabled=false WHERE id='a'`)
    await admin.query(`UPDATE webhook_endpoints SET url=$1 WHERE id='b'`, [origin + '/new'])
    // Reverting both changes must NOT revive an invalidated snapshot.
    await admin.query(`UPDATE webhook_endpoints SET enabled=true WHERE id='a'`)
    await admin.query(`UPDATE webhook_endpoints SET url=$1 WHERE id='b'`, [origin + '/b'])
    await due(); expect(await worker().runBatch()).toMatchObject({ cancelled: 2 }); expect(requests).toHaveLength(2)
    await admin.query(`UPDATE webhook_endpoints SET enabled=false WHERE id IN ('a','b')`)
    await endpoint('redirect', '/redirect'); await endpoint('denied')
    await admin.query(`UPDATE webhook_endpoints SET url='https://unapproved.invalid/path' WHERE id='denied'`)
    await event('evt_policy'); expect(await worker().runBatch()).toMatchObject({ dead: 1, retried: 1 })
    expect(requests.some((r) => r.path === '/must-not-follow')).toBe(false)
    await admin.query(`UPDATE webhook_endpoints SET enabled=false`)
    await endpoint('timeout'); await event('evt_timeout')
    let resolved = false
    const batch = await worker(a, { requestTimeoutMs: 100, leaseMs: 1_000, resolveSecret: async () => {
      await sleep(200); resolved = true; return 'late-fixture-value'
    } }).runBatch()
    expect(batch.retried).toBe(1)
    await sleep(150); expect(resolved).toBe(true)
    expect(requests.some((r) => r.path === '/timeout')).toBe(false)
    expect((await progress()).find((p) => p.event_id === 'evt_timeout')).toMatchObject({ last_error: 'delivery_timeout' })
    await admin.query(`UPDATE webhook_endpoints SET enabled=false`)
    await endpoint('budget'); failures.add('/budget'); await event('evt_budget')
    expect(await worker(a, { maxAttempts: 1 }).runBatch()).toMatchObject({ dead: 1 })
    expect((await progress()).find((p) => p.event_id === 'evt_budget')).toMatchObject({ state: 'dead', attempt_count: 1, last_status: 503 })
    await worker(b, { maxAttempts: 1 }).runBatch()
    expect(requests.filter((r) => r.path === '/budget')).toHaveLength(1)
    await admin.query(`UPDATE webhook_endpoints SET enabled=false`)
    await endpoint('secret'); await event('evt_secret')
    expect(await worker(a, { maxAttempts: 1, resolveSecret: async () => { throw new Error('fixture-private-failure') } }).runBatch()).toMatchObject({ dead: 1 })
    expect((await progress()).find((p) => p.event_id === 'evt_secret')).toMatchObject({ last_error: 'secret_unavailable' })
    expect(JSON.stringify(await progress())).not.toContain('fixture-private-failure')
  })

  it('enforces tenant constraints, envelope immutability, least authority, installation and schema gates', async () => {
    await assertWebhookWorkerPrivileges(a); await assertWebhookInstallation(a, installation)
    await expect(assertWebhookInstallation(a, randomUUID())).rejects.toThrow('does not match')
    await expect(assertWebhookWorkerPrivileges(admin)).rejects.toThrow('excessive')
    const migrations = await readControlPlaneMigrations(migrationsDir)
    await expect(assertControlPlaneSchema(a, migrations.slice(0, 7))).rejects.toThrow('ahead')
    await endpoint('other', '/other', 'org_other'); await event('evt_scope')
    await expect(a.query(`INSERT INTO webhook_deliveries(event_id,endpoint_id,organization_id,destination_url,secret_ref) VALUES('evt_scope','other','org_acme',$1,'{}')`, [origin])).rejects.toMatchObject({ code: '23503' })
    for (const sql of [`UPDATE outbox_events SET payload='{}'`, `DELETE FROM outbox_events`, `UPDATE organizations SET name='bad'`, `SELECT * FROM dedicated_owner_credentials`, `CREATE TABLE forbidden(id integer)`, `UPDATE kala_installation_claim.marker SET installation_id='${randomUUID()}'`]) {
      await expect(a.query(sql)).rejects.toMatchObject({ code: '42501' })
    }
    const gateway = createPostgresControlPlaneDatabase({ connectionString: workerUrl.replace('webhook_worker:', 'gateway_writer:') })
    try {
      const input = { operationId: 'actual-producer', name: 'Production-path fixture', owner: { issuer: 'https://identity.example', subject: 'producer' },
        contractReference: 'fixture-contract', supportTier: 'standard' as const, startsAt: new Date('2026-01-01'), endsAt: new Date('2027-01-01'), seatLimit: 2, concurrentSessionLimit: 2 }
      const service = new OrganizationProvisioningService(gateway)
      const produced = await service.provision(input)
      expect((await admin.query(`SELECT organization_id,webhook_fanout_state FROM outbox_events WHERE id='actual-producer'`)).rows[0])
        .toEqual({ organization_id: produced.organizationId, webhook_fanout_state: 'pending' })
      expect(await service.provision(input)).toMatchObject({ alreadyApplied: true })
      await expect(gateway.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload,webhook_fanout_state)
        VALUES('forged','unit.changed','system','system','{}','complete')`)).rejects.toMatchObject({ code: '42501' })
      await expect(gateway.query(`UPDATE outbox_events SET payload='{}'`)).rejects.toMatchObject({ code: '42501' })
      await expect(gateway.query(`UPDATE webhook_deliveries SET state='dead'`)).rejects.toMatchObject({ code: '42501' })
    } finally { await gateway.close() }
    const scoped = scopedWebhookSecrets({ resolve: async () => { throw new Error('must not resolve') } })
    await expect(scoped({ ref: 'bao:organizations/org_other/webhooks/key#value' }, 'org_acme', new AbortController().signal)).rejects.toThrow('denied')
    await admin.query(`GRANT UPDATE (payload) ON outbox_events TO webhook_worker`)
    try { await expect(assertWebhookWorkerPrivileges(a)).rejects.toThrow('excessive') }
    finally { await admin.query(`REVOKE UPDATE (payload) ON outbox_events FROM webhook_worker`) }
    await admin.query(`CREATE FUNCTION public.webhook_test_escape() RETURNS void LANGUAGE sql SECURITY DEFINER
      AS $$ UPDATE organizations SET name='forbidden'; $$`)
    try { await expect(assertWebhookWorkerPrivileges(a)).rejects.toThrow('excessive') }
    finally { await admin.query(`DROP FUNCTION public.webhook_test_escape()`) }
  })

  const prepareRetention = async () => {
    await admin.query(`INSERT INTO principals(id,kind,issuer,subject) VALUES('prn_a','human','https://fixture.invalid','a'),('prn_b','human','https://fixture.invalid','b') ON CONFLICT DO NOTHING`)
    await admin.query(`INSERT INTO organization_memberships(organization_id,principal_id,role) VALUES('org_acme','prn_a','owner'),('org_other','prn_b','owner')`)
    await admin.query(`INSERT INTO retention_policies(organization_id,session_days,artifact_days,audit_days,deleted_resource_grace_days)
      VALUES('org_acme',30,30,365,30),('org_other',30,30,365,30)`)
    await admin.query(`INSERT INTO browser_sessions(id,principal_id,organization_id,token_hash,cache_namespace,device,idle_expires_at,absolute_expires_at)
      VALUES('bs_old','prn_a','org_acme','old','fixture','{}','2020-01-01','2020-01-02'),
      ('bs_live','prn_a','org_acme','live','fixture','{}','2030-01-01','2030-01-02'),
      ('bs_other','prn_b','org_other','other','fixture','{}','2020-01-01','2020-01-02')`)
    await admin.query(`INSERT INTO notification_devices(id,organization_id,principal_id,endpoint_hash,subscription_encrypted,label,updated_at)
      VALUES('old','org_acme','prn_a','old','{}','fixture','2020-01-01'),('other','org_other','prn_b','other','{}','fixture','2020-01-01')`)
  }

  it('preserves immutable audit/usage attribution, tenant FK boundaries and independent maintenance authority', async () => {
    await prepareRetention()
    await assertRetentionPrivileges(maintenanceA)
    const gateway = createPostgresControlPlaneDatabase({ connectionString: workerUrl.replace('webhook_worker:', 'gateway_writer:') })
    const entry = { id: 'usage_a', organizationId: 'org_acme', principalId: 'prn_a', workspaceId: 'ws_a', inputTokens: 2, outputTokens: 3,
      occurredAt: new Date(), operationId: 'usage-operation' }
    try {
      await admin.query(`INSERT INTO workspaces(id,organization_id,name) VALUES('ws_a','org_acme','A'),('ws_b','org_other','B')`)
      const ledger = new PostgresUsageLedger(gateway)
      expect(await ledger.append(entry)).toBe(true)
      expect(await ledger.append({ ...entry, id: 'usage_duplicate' })).toBe(false)
      await expect(ledger.append({ ...entry, id: 'usage_cross', workspaceId: 'ws_b', operationId: 'cross' })).rejects.toMatchObject({ code: '23503' })
      await gateway.query(`INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,result)
        VALUES('audit_a','org_acme','prn_a','human','fixture','organization','allowed')`)
      for (const sql of [`UPDATE audit_events SET result='succeeded'`, `DELETE FROM audit_events`, `UPDATE usage_ledger SET input_tokens=0`, `DELETE FROM usage_ledger`, `TRUNCATE usage_ledger`, `DELETE FROM retention_runs`]) {
        await expect(gateway.query(sql)).rejects.toMatchObject({ code: '42501' })
      }
      await expect(admin.query(`UPDATE audit_events SET result='succeeded' WHERE id='audit_a'`)).rejects.toMatchObject({ code: '42501' })
      await expect(admin.query(`TRUNCATE usage_ledger`)).rejects.toMatchObject({ code: '42501' })
      await expect(admin.query(`DELETE FROM workspaces WHERE id='ws_a'`)).rejects.toMatchObject({ code: '23503' })
      await expect(admin.query(`DELETE FROM principals WHERE id='prn_a'`)).rejects.toMatchObject({ code: '23503' })
      await expect(gateway.query(`UPDATE principals SET subject='rewritten-history' WHERE id='prn_a'`)).rejects.toMatchObject({ code: '42501' })
      await gateway.query(`UPDATE principals SET display_name='Updated profile' WHERE id='prn_a'`)
      expect((await admin.query(`SELECT actor_principal_id FROM audit_events WHERE id='audit_a'`)).rows[0]?.actor_principal_id).toBe('prn_a')
      for (const sql of [`UPDATE organizations SET name='bad'`, `SELECT * FROM usage_ledger`, `UPDATE audit_events SET result='failed'`, `DELETE FROM outbox_events`, `UPDATE retention_runs SET cutoff=now()`]) {
        await expect(maintenanceA.query(sql)).rejects.toMatchObject({ code: '42501' })
      }
      const options = { enabled: true, migrationsDirectory: migrationsDir, installationId: installation,
        readSecret: async () => workerUrl.replace('webhook_worker:', 'retention_maintenance:') }
      const opened = await openRetentionDatabase(options); await opened?.close()
      await expect(openRetentionDatabase({ ...options, installationId: randomUUID() })).rejects.toThrow('authority unavailable')
      await expect(openRetentionDatabase({ ...options, readSecret: async () => workerUrl.replace('webhook_worker:', 'gateway_writer:') })).rejects.toThrow('authority unavailable')
      await expect(openRetentionDatabase({ ...options, enabled: false, readSecret: async () => { throw new Error('must not read') } })).resolves.toBeUndefined()
      await admin.query(`GRANT retention_maintenance TO gateway_writer`)
      try {
        await gateway.transaction(async (tx) => {
          await tx.query(`SET LOCAL ROLE retention_maintenance`)
          await expect(assertRetentionPrivileges(tx)).rejects.toThrow('excessive')
        })
      } finally { await admin.query(`REVOKE retention_maintenance FROM gateway_writer`) }
      const exported = await new RetentionService(gateway).exportOrganization('org_acme')
      expect(exported.usage).toHaveLength(1); expect(exported.audit).toHaveLength(1)
    } finally { await gateway.close() }
  })

  it('admits one retention sweep across replicas, records immutable intent/outcome, and reuses the captured daily receipt', async () => {
    await prepareRetention()
    let release!: () => void; let started!: () => void; let calls = 0
    const observed = new Promise<void>((ready) => { started = ready })
    const wait = new Promise<void>((ready) => { release = ready })
    const adapter = { async purgeOrganizationSessions(input: { organizationId: string; runtimeUnitId: string; before: Date }) {
      calls++; expect(input).toEqual({ organizationId: 'org_acme', runtimeUnitId: 'unit_a', before: new Date('2026-09-30T12:00:00Z') })
      started(); await wait; return { sessions: 3 }
    } }
    const time = new Date('2026-10-30T12:00:00Z')
    const first = new RetentionService(maintenanceA, adapter).purgeOrganization('org_acme', time)
    try {
      await observed
      expect((await admin.query(`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name LIKE 'retention-test-%' AND state='idle in transaction'`)).rows[0]?.count).toBe(0)
      await expect(new RetentionService(maintenanceB, adapter).purgeOrganization('org_acme', time)).rejects.toThrow('requires_review')
      expect(calls).toBe(1)
      expect((await admin.query(`SELECT id FROM browser_sessions ORDER BY id`)).rows.map((row) => row.id)).toEqual(['bs_live','bs_other'])
      expect((await admin.query(`SELECT id FROM notification_devices`)).rows.map((row) => row.id)).toEqual(['other'])
    } finally { release() }
    const receipt = await first
    expect(receipt).toMatchObject({ sessions: 1, devices: 1, hostSessions: 3, state: 'succeeded', reused: false })
    await admin.query(`UPDATE retention_policies SET session_days=1 WHERE organization_id='org_acme'`)
    expect(await new RetentionService(maintenanceB, adapter).purgeOrganization('org_acme', new Date('2026-10-30T23:59:00Z')))
      .toEqual({ ...receipt, reused: true })
    expect(calls).toBe(1)
    const audit = (await admin.query(`SELECT result,metadata,request_id FROM audit_events WHERE action='retention.purge' ORDER BY occurred_at,id`)).rows
    expect(audit).toHaveLength(2); expect(audit.map((row) => row.result)).toEqual(['allowed','succeeded'])
    expect(audit.every((row) => row.request_id === receipt.runId)).toBe(true)
    expect(audit[0]?.metadata).toMatchObject({ phase: 'started' })
    const controlOnly = await new RetentionService(maintenanceB).purgeOrganization('org_other', time)
    expect(controlOnly).toMatchObject({ state: 'control_only', hostSessions: 0 })
  })

  it('quarantines ambiguous/crashed retention, never redispatches next day, and rolls deletion back without an audit intention', async () => {
    await prepareRetention()
    let calls = 0
    const adapter = { async purgeOrganizationSessions() { calls++; throw new Error('fixture-private-runtime-failure') } }
    const time = new Date('2026-10-30T12:00:00Z')
    await expect(new RetentionService(maintenanceA, adapter).purgeOrganization('org_acme', time)).rejects.toThrow('requires_review')
    await expect(new RetentionService(maintenanceB, adapter).purgeOrganization('org_acme', new Date('2026-10-31T12:00:00Z'))).rejects.toThrow('requires_review')
    expect(calls).toBe(1)
    expect((await admin.query(`SELECT state FROM retention_runs WHERE organization_id='org_acme'`)).rows[0]?.state).toBe('unknown')
    expect(JSON.stringify((await admin.query(`SELECT * FROM audit_events`)).rows)).not.toContain('fixture-private-runtime-failure')
    // Simulate process loss after durable admission and before settlement by
    // failing the outcome INSERT at the real database privilege boundary.
    let dispatches = 0
    await admin.query(`REVOKE INSERT ON audit_events FROM retention_maintenance`)
    try {
      await expect(new RetentionService(maintenanceA, { async purgeOrganizationSessions() { dispatches++; return { sessions: 0 } } })
        .purgeOrganization('org_other', time)).rejects.toMatchObject({ code: '42501' })
      expect(dispatches).toBe(0)
      expect((await admin.query(`SELECT id FROM browser_sessions WHERE id='bs_other'`)).rowCount).toBe(1)
      expect((await admin.query(`SELECT id FROM retention_runs WHERE organization_id='org_other'`)).rowCount).toBe(0)
    } finally { await admin.query(`GRANT INSERT ON audit_events TO retention_maintenance`) }
    const lostReceipt = new RetentionService(maintenanceA, { async purgeOrganizationSessions() {
      dispatches++; await admin.query(`REVOKE INSERT ON audit_events FROM retention_maintenance`); return { sessions: 2 }
    } })
    try { await expect(lostReceipt.purgeOrganization('org_other', time)).rejects.toMatchObject({ code: '42501' }) }
    finally { await admin.query(`GRANT INSERT ON audit_events TO retention_maintenance`) }
    expect((await admin.query(`SELECT state FROM retention_runs WHERE organization_id='org_other'`)).rows[0]?.state).toBe('dispatching')
    await expect(new RetentionService(maintenanceB, { async purgeOrganizationSessions() { dispatches++; return { sessions: 0 } } })
      .purgeOrganization('org_other', new Date('2026-11-01'))).rejects.toThrow('requires_review')
    expect(dispatches).toBe(1)
  })

  it('runs the independent process with external secret protocol, exits once, and drains idle SIGTERM', async () => {
    await endpoint('process'); await event('evt_process')
    const env = { ...process.env, KALA_OTEL_ENABLED: '0', KALA_DEPLOYMENT_CONFIG: resolve(import.meta.dirname, '../../../../deploy/private-cloud/deployment.json'),
      KALA_INSTALLATION_ID_FILE: join(root, 'installation'), KALA_WEBHOOK_DATABASE_URL: workerUrl,
      KALA_WEBHOOK_MIGRATIONS_DIR: migrationsDir, KALA_WEBHOOK_ALLOWED_ORIGINS: origin, KALA_WEBHOOK_ALLOW_LOOPBACK_HTTP: '1',
      KALA_SECRET_RESOLVER: 'openbao-jwt', KALA_OPENBAO_ADDR: origin, KALA_OPENBAO_AUTH_MOUNT: 'jwt', KALA_OPENBAO_ROLE: 'webhook',
      KALA_OPENBAO_JWT_FILE: join(root, 'jwt'), KALA_OPENBAO_KV_MOUNT: 'secret', KALA_OPENBAO_ALLOW_LOOPBACK_HTTP: '1' }
    const run = (once: boolean) => {
      const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), resolve(import.meta.dirname, '../bin/webhook-worker.ts')],
        { env: { ...env, KALA_WEBHOOK_ONCE: once ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      let output = ''; child.stdout!.on('data', (data) => { output += String(data) }); child.stderr!.on('data', (data) => { output += String(data) })
      const exited = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', (code) => { children.delete(child); done(code) }) })
      return { child, exited, output: () => output }
    }
    const once = run(true)
    expect(await once.exited, once.output()).toBe(0)
    expect(requests.filter((r) => r.path === '/process')).toHaveLength(1)
    expect(once.output()).toContain('webhook_worker_ready')
    const idle = run(false)
    for (let i = 0; !idle.output().includes('webhook_worker_ready'); i++) { if (i > 100) throw new Error(idle.output()); await sleep(20) }
    idle.child.kill('SIGTERM'); expect(await idle.exited, idle.output()).toBe(0)
    expect(idle.output()).not.toContain('fixture-signing-value')
  }, 15_000)
})
