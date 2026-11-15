import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { io as connect } from 'socket.io-client'
import { AGENT_RUNTIME_CAPABILITIES, PRIVATE_CLOUD_DEPLOYMENT, PROTOCOL_VERSION, schema, type ServerSettingsPayload } from '@agent-kernel/shared'
import { migratePostgres, grantPostgresRuntimeDml } from '../../../host/src/postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from '../../../host/src/tenant-runtime/postgres-hot-state.js'
import { createPostgresRuntimeUnitMaterializationStore } from '../../../host/src/tenant-runtime/postgres-materialization-store.js'
import { createPostgresRuntimeUnitPlacementStore } from '../../../host/src/tenant-runtime/postgres-runtime-unit-placement-store.js'
import { PostgresRuntimeUnitPlacementOwnership } from '../../../host/src/tenant-runtime/runtime-unit-placement-ownership.js'
import { createPostgresRuntimeResourceOwnershipStore } from '../../../host/src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { PostgresRuntimeReplicaMembership } from '../../../host/src/tenant-runtime/runtime-replica-membership.js'
import { PostgresTenantStateStore } from '../../../host/src/tenant-runtime/postgres-state.js'
import { PostgresSessionAuthority } from '../../../host/src/store/postgres-session-authority.js'
import { PostgresExecutorIdentityStore } from '../../../host/src/store/postgres-executor-identity.js'
import { startLoopbackHostRuntimeUnit } from '../../../host/src/tenant-runtime/loopback-host-unit.js'
import { startTenantRuntimeService, type TenantRuntimeService } from '../../../host/src/tenant-runtime/service.js'
import { attachTenantRuntimeControlApi } from '../../../host/src/tenant-runtime/control-api.js'
import { ModelPolicyClient } from '../../../host/src/tenant-runtime/model-policy-client.js'
import { RuntimeModelPolicyState } from '../../../host/src/tenant-runtime/model-policy-state.js'
import { RuntimeModelPolicyControl, type LoadedModelPolicySnapshot } from '../../../host/src/tenant-runtime/model-policy-control.js'
import { OrganizationModelSettings, ORGANIZATION_MODEL_SETTINGS_CREDENTIAL } from '../../../host/src/llm/organization-model-settings.js'
import { createPrivateCloudObjectStorage } from '../../../host/src/artifacts/private-cloud-storage.js'
import { PostgresDagStore } from '../../../host/src/dag/postgres-store.js'
import { PostgresPushSubscriptionStore } from '../../../host/src/push/postgres-store.js'
import { parseTenantRuntimeUnitId } from '../../../host/src/tenant-runtime/unit.js'
import { PostgresWorkspaceReferenceAuthority } from '../../../host/src/tenant-runtime/workspace-references.js'
import { grantControlWriter } from '../bin/init-control-plane.js'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations, type ControlPlaneDatabase } from '../persistence/postgres.js'
import { grantSettingsOperator } from './operator-authority.js'
import { operatorInstallationFingerprint } from './operator-plan.js'
import { PostgresModelPolicyReader } from './model-policy-reader.js'
import { handleModelPolicyRead } from '../edge/model-policy.js'
import { OperatorModelPolicyTransport } from './model-policy-transport.js'
import { OperatorModelPolicyCoordinator } from './model-policy-coordinator.js'
import { PostgresSettingsOperator, type OperatorRuntimeReferences } from './operator-store.js'
import { inviteKey } from '../assignments/store.js'
import { PostgresOrganizationStore } from '../organizations/postgres-store.js'

const exec = promisify(execFile)
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: object) => {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void>;
} }
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
integration('organization model policy / actual control and Runtime PG, roles, HTTP and native Unit lifecycle', () => {
  const container = `kala-policy-protocol-${randomUUID()}`, password = randomUUID(), installationId = randomUUID()
  const siloContainer = `${container}-silo`, siloImage = 'sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'
  const s3Password = randomUUID()
  let s3Endpoint = ''
  const secret = 'fictional-policy-internal-credential-32bytes', key = Buffer.from(randomBytes(32).toString('base64url')), masterKey = randomBytes(32)
  const directory = resolve('../../.settings-test-work', `model-protocol-${randomUUID()}`)
  const organizationId = 'org_protocol', unitId = 'protocol-unit', otherOrg = 'org_other', otherUnit = 'other-unit'
  const databases: ControlPlaneDatabase[] = [], hotStores: PostgresHotStateStore[] = []
  const snapshots = new Map<string, () => Promise<LoadedModelPolicySnapshot>>(), catalogs = new Map<string, OrganizationModelSettings>()
  const controls = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/internal/')) return
    const upstream = httpRequest({ hostname: '127.0.0.1', port: service.port, path: incoming.url,
      method: incoming.method, headers: incoming.headers }, result => {
      response.writeHead(result.statusCode ?? 503, result.headers); result.pipe(response)
    })
    upstream.on('error', () => { response.writeHead(503); response.end() }); incoming.pipe(upstream)
  })
  const gateway = createServer()
  let owner: InstanceType<typeof Pool>, ownerUrl: string, runtimeUrl: string, runtime: PostgresHotStateStore
  let controlOwner: ControlPlaneDatabase, operatorDb: ControlPlaneDatabase, gatewayDb: ControlPlaneDatabase
  let service: TenantRuntimeService, controller: RuntimeModelPolicyControl, operator: PostgresSettingsOperator
  let placementStore: ReturnType<typeof createPostgresRuntimeUnitPlacementStore>
  let replicaStore: ReturnType<typeof createPostgresRuntimeResourceOwnershipStore>
  let catalog: ReturnType<typeof createPostgresRuntimeUnitMaterializationStore>
  let membership: PostgresRuntimeReplicaMembership, placement: PostgresRuntimeUnitPlacementOwnership
  let controlOrigin = '', firstOperation = '', lastOperation = '', loss: 'quiesce' | 'reconcile' | 'resume' | 'workspace-reserve' | 'operational-consume' | undefined, operatorCalls = 0
  let failBefore: 'quiesce' | 'reconcile' | 'resume' | undefined
  let pauseReservationResponse = false
  let pauseModelReconcileResponse = false
  let createOperator: () => PostgresSettingsOperator
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  const actorHeaders = { 'x-agent-runlab-ingress-secret': secret, 'x-agent-runlab-principal': 'fictional-admin',
    'x-agent-runlab-organization-id': organizationId, 'x-agent-runlab-organization-role': 'admin',
    'x-agent-runlab-runtime-unit': unitId }
  beforeAll(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=384m', '--env', `POSTGRES_PASSWORD=${password}`,
      '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const port = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])).stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('fixture PostgreSQL unavailable')
    ownerUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`
    owner = new Pool({ connectionString: ownerUrl })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await owner.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await owner.query('CREATE DATABASE runlab_control')
    expect((await exec('docker', ['image', 'inspect', siloImage, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'])).stdout.trim())
      .toBe('0cd388c666f8211f552604ae73448a066e9c25ce')
    await exec('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', siloContainer,
      '--tmpfs', '/data:rw,noexec,nosuid,size=64m', '--env', 'MINIO_ROOT_USER=fixtureowner',
      '--env', `MINIO_ROOT_PASSWORD=${s3Password}`, '--publish', '127.0.0.1::9000', siloImage,
      'server', '/data', '--address', ':9000', '--console-address', ':9001'])
    const siloPort = (await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}', siloContainer])).stdout.trim()
    if (!/^\d+$/u.test(siloPort)) throw new Error('fixture SILO unavailable')
    s3Endpoint = `http://127.0.0.1:${siloPort}`
    for (;;) {
      try { if ((await fetch(`${s3Endpoint}/minio/health/live`)).ok) break } catch {}
      if (Date.now() >= deadline) throw new Error('fixture SILO did not become ready')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const { S3Client, CreateBucketCommand } = createRequire(resolve('../host/package.json'))('@aws-sdk/client-s3')
    const s3 = new S3Client({ endpoint: s3Endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'fixtureowner', secretAccessKey: s3Password } })
    try { await s3.send(new CreateBucketCommand({ Bucket: 'settings-fixture' })) } finally { s3.destroy() }
    await migratePostgres({ connectionString: ownerUrl })
    await owner.query(`CREATE ROLE fixture_runtime LOGIN PASSWORD '${password}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    await grantPostgresRuntimeDml({ connectionString: ownerUrl, runtimeRole: 'fixture_runtime' })
    runtimeUrl = `postgresql://fixture_runtime:${password}@127.0.0.1:${port}/postgres`
    const connect = (role: string) => {
      const database = createPostgresControlPlaneDatabase({ connectionString: `postgresql://${role}:${password}@127.0.0.1:${port}/runlab_control` })
      databases.push(database); return database
    }
    controlOwner = connect('postgres')
    await migrateControlPlane(controlOwner, await readControlPlaneMigrations(resolve('migrations')))
    await controlOwner.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES
      ('${organizationId}','Protocol fixture','active','${unitId}'),('${otherOrg}','Other fixture','active','${otherUnit}');
      CREATE ROLE fixture_gateway LOGIN PASSWORD '${password}';
      CREATE ROLE fixture_operator LOGIN PASSWORD '${password}';
      CREATE SCHEMA kala_installation_claim;
      CREATE TABLE kala_installation_claim.marker(singleton boolean PRIMARY KEY,installation_id uuid);
      CREATE TABLE kala_installation_claim.recovery_checkpoint(singleton boolean PRIMARY KEY,installation_id uuid,checkpoint_id uuid,key_sha256 text)`)
    await controlOwner.query('INSERT INTO kala_installation_claim.marker VALUES(true,$1)', [installationId])
    await controlOwner.query('INSERT INTO kala_installation_claim.recovery_checkpoint VALUES(true,$1,$2,$3)', [installationId, randomUUID(), 'a'.repeat(64)])
    await grantControlWriter(controlOwner, 'fixture_gateway')
    await grantSettingsOperator(controlOwner, 'fixture_operator')
    gatewayDb = connect('fixture_gateway')
    const reader = new PostgresModelPolicyReader(gatewayDb, installationId)
    gateway.on('request', (request, response) => { void handleModelPolicyRead(request, response, secret, reader) })
    const client = new ModelPolicyClient({ origin: await listen(gateway), installationId, serviceSecret: secret })
    controlOrigin = await listen(controls)
    runtime = createPostgresHotStateStore({ connectionString: runtimeUrl, applicationName: 'policy-controller' })
    catalog = createPostgresRuntimeUnitMaterializationStore({ connectionString: runtimeUrl, schemaManagement: 'external' })
    await catalog.load()
    for (const [id, org] of [[unitId, organizationId], [otherUnit, otherOrg]]) await catalog.apply({
      schemaVersion: 1, unitId: id as never, organizationId: org, routingKeyDigest: '', routingKeyVersion: 1, generation: 1,
      desiredState: 'ready', dataRoot: resolve(directory, id!), capabilities: AGENT_RUNTIME_CAPABILITIES,
      lastOperationId: randomUUID(), updatedAt: new Date().toISOString(),
    })
    placementStore = createPostgresRuntimeUnitPlacementStore({ connectionString: runtimeUrl })
    replicaStore = createPostgresRuntimeResourceOwnershipStore({ connectionString: runtimeUrl })
    placement = new PostgresRuntimeUnitPlacementOwnership(placementStore, { nodeId: 'fixture-node', origin: controlOrigin })
    membership = new PostgresRuntimeReplicaMembership(replicaStore, { replicaId: randomUUID(), origin: controlOrigin })
    service = await startTenantRuntimeService({
      port: 0, ingressSecret: secret, requireProvisioning: true, catalog, placementOwnership: placement, replicaMembership: membership,
      resolveUnitId: request => typeof request.headers['x-agent-runlab-runtime-unit'] === 'string' ? request.headers['x-agent-runlab-runtime-unit'] : undefined,
      beforeRoutable: (id, org) => controller.beforeRoutable(id, org),
      factory: async id => {
        const materialization = await catalog.refresh(id), org = materialization!.organizationId!
        const policy = await client.read(org, id)
        const hot = createPostgresHotStateStore({ connectionString: runtimeUrl, applicationName: `fixture-model-unit-${id}`,
          placementLease: placement.activeLease(id, org) })
        hotStores.push(hot)
        const state = new PostgresTenantStateStore(hot.database, org, masterKey)
        const objectStorage = await createPrivateCloudObjectStorage({ organizationId: org, hotState: hot,
          endpoint: s3Endpoint, region: 'us-east-1', bucket: 'settings-fixture', forcePathStyle: true,
          accessKeyId: 'fixtureowner', secretAccessKey: s3Password, maxObjectBytes: 1024 * 1024, maxArtifactBytes: 10 * 1024 * 1024,
          schemaManagement: 'external' })
        const fence = new RuntimeModelPolicyState({ installationId, state, unitId: id, policy: client, operatorModelReferences: ['operator:baseline'] })
        await fence.assertSnapshot(policy, undefined, true)
        const models = policy.effectiveManagement === 'dashboard' ? new OrganizationModelSettings(state, org, {
          assertCallAllowed: () => fence.assertSnapshot(policy),
          assertMutationAllowed: tx => fence.assertSnapshot(policy, tx),
          assertInitializationAllowed: async () => { throw new Error('reconciliation required') },
        }) : undefined
        await models?.load()
        if (models) catalogs.set(id, models)
        snapshots.set(id, async () => ({ policyRevision: policy.effectiveRevision, management: policy.effectiveManagement,
          catalogRevision: models?.effectiveRevision ?? await state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL,
            async tx => await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
              ? await state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) ?? '0' : '0'),
          synchronization: models?.synchronization ?? 'ready', observedAt: models?.observationTime ?? new Date().toISOString() }))
        const payload = (): ServerSettingsPayload => ({ providers: models?.providers ?? [], defaultModel: models ? models.defaultModel ?? '' : 'operator:baseline',
          hooks: [], modelConfiguration: { management: models ? 'dashboard' : 'operator' },
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' }, mcp: { supported: false, note: '' } })
        return startLoopbackHostRuntimeUnit(id, {
          deployment: PRIVATE_CLOUD_DEPLOYMENT, capabilities: AGENT_RUNTIME_CAPABILITIES, requireIngressIdentity: true,
          defaultConfig: { tools: [], systemPrompt: 'fictional model-policy fixture' },
          sessionsDir: resolve(directory, id, 'sessions'), artifactRootDir: false,
          sessionAuthority: new PostgresSessionAuthority(hot, org, { schemaManagement: 'external', unitId: id }),
          executorIdentityStore: new PostgresExecutorIdentityStore(hot.database, org, id),
          executorAdmission: async executor => {
            if (!(await client.executor(org, id, executor)).admitted) throw new Error('executor resource admission denied')
          },
          objectStorage,
          dagStore: new PostgresDagStore(hot.database, org, id, { schemaManagement: 'external' }),
          pushStore: new PostgresPushSubscriptionStore(state), vapidKeys: null,
          llm: models?.llm ?? { name: 'fictional-deployment-models', call: async () => {
            await fence.assertSnapshot(policy); operatorCalls++; throw new Error('fictional deployment dispatch')
          } },
          models: () => models?.models ?? [{ id: 'baseline', ref: 'operator:baseline', providerId: 'operator', label: 'Baseline', provider: 'fictional' }],
          defaultModel: () => models ? models.defaultModel : 'operator:baseline', settings: payload,
          assertSettingsReady: () => fence.assertSnapshot(policy),
          ...(models ? { onModelCatalogChange: listener => models.onChange(listener),
            addManualProvider: async (input, actor, write) => { await models.addProvider(input, actor, write); return payload() },
            addManualModel: async (input, actor, write) => { await models.addModel(input, actor, write); return payload() },
            deleteManualProvider: async (input, actor, write) => { await models.deleteProvider(input, actor, write); return payload() },
          } : {}),
          closeResource: async () => { snapshots.delete(id); catalogs.delete(id); await models?.close(); await hot.close() },
        })
      },
    })
    controller = new RuntimeModelPolicyControl({ installationId, database: runtime.database, masterKey, policy: client,
      catalog, service, membership, replicas: replicaStore, operatorModelReferences: ['operator:baseline'],
      operatorCatalogRevision: 'b'.repeat(64), loadedSnapshot: async id => await snapshots.get(id)?.() })
    attachTenantRuntimeControlApi({ http: controls, serviceSecret: secret, service, store: catalog, dataRoot: directory,
      capabilities: AGENT_RUNTIME_CAPABILITIES, modelPolicy: controller,
      workspaceReferences: new PostgresWorkspaceReferenceAuthority({ database: runtime.database, installationId, policy: client }),
    })
    controls.prependListener('request', (request, response) => {
      if (pauseReservationResponse && request.url === '/internal/settings/workspace-reserve'
        || pauseModelReconcileResponse && request.url === '/internal/settings/model-management/reconcile') {
        const end = response.end.bind(response)
        response.end = ((...args: Parameters<typeof response.end>) => {
          if (response.statusCode === 200) { pauseReservationResponse = false; pauseModelReconcileResponse = false; return response }
          return end(...args)
        }) as typeof response.end
      }
      if (!loss || request.url !== (loss.includes('-') ? `/internal/settings/${loss}` : `/internal/settings/model-management/${loss}`)) return
      const original = response.end.bind(response)
      response.end = ((...args: Parameters<typeof response.end>) => {
        if (response.statusCode === 200) { loss = undefined; response.destroy(); return response }
        return original(...args)
      }) as typeof response.end
    })
    await service.markRoutable(unitId, organizationId); await service.markRoutable(otherUnit, otherOrg)
    await service.units.getOrLoad(unitId as never); await service.units.getOrLoad(otherUnit as never)
    operatorDb = connect('fixture_operator')
    const profile = { schemaVersion: 1 as const, installationIdFile: `${directory}/installation`, controlPlaneDatabaseUrlRef: `file://${directory}/database`,
      runtimeControlOrigin: controlOrigin, internalCredentialRef: `file://${directory}/internal`, planSigningKeyRef: `file://${directory}/key`,
      allowedOrganizations: [organizationId, otherOrg], allowedResourceKinds: ['model-management' as const, 'workspace' as const, 'pool' as const, 'entitlement' as const] }
    const operatorConnection = new URL(ownerUrl)
    operatorConnection.username = 'fixture_operator'; operatorConnection.pathname = '/runlab_control'
    for (const [name, content] of Object.entries({ installation: installationId, database: operatorConnection.href,
      internal: secret, key: key.toString('utf8'), profile: JSON.stringify(profile) })) {
      await writeFile(resolve(directory, name), content, { mode: 0o600 })
    }
    const identity = (await operatorDb.query<{ host: string; port: number; database: string; role: string }>(
      'SELECT inet_server_addr()::text AS host,inet_server_port() AS port,current_database() AS database,current_user AS role')).rows[0]!
    const installationFingerprint = operatorInstallationFingerprint({ installationId, databaseAuthority: identity, runtimeControlOrigin: controlOrigin })
    createOperator = () => {
      const transport = new OperatorModelPolicyTransport({ profile, installationId, credential: async () => secret })
      const send = transport.request.bind(transport)
      transport.request = async (...args: Parameters<typeof send>) => {
        if (args[0] === failBefore) { failBefore = undefined; throw new Error('fictional interrupted coordinator before native request') }
        return send(...args)
      }
      return new PostgresSettingsOperator(operatorDb, { profile, key, installationFingerprint, consumers: {
      authorizeWebhookReference: async () => { throw new Error('not a webhook fixture') },
      workspaceReferences: async (organizationId, unitId, workspaceId, operationId) => {
        const response = await fetch(`${controlOrigin}/internal/settings/workspace-references`, {
          method: 'POST', headers: { 'x-agent-runlab-ingress-secret': secret, 'content-type': 'application/json' },
          body: JSON.stringify({ installationId, organizationId, unitId, workspaceId, ...(operationId ? { operationId } : {}) }),
        })
        if (!response.ok) throw new Error('workspace fixture maintenance unavailable')
        return response.json()
      },
      reserveWorkspace: async input => await transport.operational('workspace-reserve', input) as OperatorRuntimeReferences,
      verifyResource: async input => {
        const receipt = schema.SettingsOperationalReceiptSchema.parse(await transport.operational('operational-consume', {
          organizationId: input.organizationId, unitId: input.unitId, resource: input.resource,
          operationId: input.operationId, revision: input.revision,
        }))
        return receipt.revision === input.revision ? 'verified' : 'failed'
      },
      modelPolicy: new OperatorModelPolicyCoordinator({ database: operatorDb, profile, key, installationFingerprint,
        transport }),
      } })
    }
    operator = createOperator()
  }, 120_000)
  afterAll(async () => {
    await service?.close().catch(() => undefined)
    for (const server of [controls, gateway]) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await Promise.allSettled(hotStores.map(hot => hot.close()))
    await Promise.allSettled(databases.map(database => database.close()))
    await Promise.allSettled([runtime?.close(), catalog?.close(), replicaStore?.close(), placementStore?.close(), owner?.end()])
    await exec('docker', ['rm', '--force', container]).catch(() => undefined)
    await exec('docker', ['rm', '--force', siloContainer]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  })

  it('resumes the same persisted operation after a separate CLI is SIGKILLed after Runtime commit and after actual startup response loss, without exposing shared keys', async () => {
    firstOperation = randomUUID()
    const plan = await operator.plan({ schemaVersion: 1, operationId: firstOperation, organizationId,
      resource: { kind: 'model-management', id: organizationId }, expectedRevision: '1', patch: { management: 'dashboard' } })
    const planPath = resolve(directory, 'process-model-plan')
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 })
    pauseModelReconcileResponse = true
    const args = ['--import', createRequire(resolve('../host/package.json')).resolve('tsx/esm'),
      resolve('src/bin/control-plane-settings.ts')]
    const env = { PATH: process.env.PATH, TMPDIR: resolve('../../.settings-test-work'), KALA_INGRESS_MIGRATIONS_DIR: resolve('migrations') }
    const child = spawn(process.execPath, [...args, 'apply', '--profile', resolve(directory, 'profile'), '--plan', planPath], { env, stdio: 'ignore' })
    const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('exit', (_code, signal) => resolve({ signal }))
    })
    try {
      await vi.waitFor(async () => expect((await runtime.database.query(
        'SELECT count(*)::text AS count FROM settings_model_policy_transitions WHERE operation_id=$1', [firstOperation])).rows[0]?.count)
        .toBe('1'), { timeout: 5_000 })
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await exited).toMatchObject({ signal: 'SIGKILL' })
    } finally {
      pauseModelReconcileResponse = false
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
    expect((await controlOwner.query('SELECT state,effective_revision::text,desired_revision::text FROM organization_model_management WHERE organization_id=$1', [organizationId])).rows[0])
      .toMatchObject({ state: 'preparing', effective_revision: '1', desired_revision: '2' })
    expect((await runtime.database.query('SELECT count(*)::text AS count FROM settings_model_policy_transitions WHERE operation_id=$1', [firstOperation])).rows[0]?.count).toBe('1')
    expect((await fetch(`${controlOrigin}/models`, { headers: { ...actorHeaders, 'x-agent-runlab-organization-id': otherOrg, 'x-agent-runlab-runtime-unit': otherUnit } })).status).toBe(200)
    loss = 'resume'
    operator = createOperator()
    expect(await operator.verify(firstOperation)).toMatchObject({ consumerVerification: 'pending' })
    expect((await controlOwner.query('SELECT state FROM organization_model_management WHERE organization_id=$1', [organizationId])).rows[0]?.state).toBe('awaiting_runtime')
    await expect(catalogs.get(unitId)!.llm.call({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'model_policy_transition_fenced' })
    operator = createOperator()
    expect(await operator.verify(firstOperation)).toMatchObject({ state: 'verified', consumerVerification: 'verified', revision: '2' })
    expect((await controlOwner.query('SELECT state,effective_revision::text FROM organization_model_management WHERE organization_id=$1', [organizationId])).rows[0])
      .toMatchObject({ state: 'active', effective_revision: '2' })
    expect((await fetch(`${controlOrigin}/models`, { headers: actorHeaders })).status).toBe(200)
    expect(catalogs.get(unitId)!.defaultModel).toBeNull()
    await expect(catalogs.get(unitId)!.llm.call({ messages: [], tools: [] })).rejects.toThrow('model_not_configured')
    expect(operatorCalls).toBe(0)
    expect(JSON.parse((await new PostgresTenantStateStore(runtime.database, organizationId, masterKey)
      .getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL))!.secret)).toEqual({
      version: 1, catalog: { version: 1, defaultModel: null, providers: [] }, keys: {},
    })
  }, 30_000)

  it('performs linked inverse and re-enable maintenance at new revisions, retaining the exact encrypted organization catalog', async () => {
    const response = await fetch(`${controlOrigin}/settings/providers`, { method: 'POST',
      headers: { ...actorHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'owned', wire: 'openai', baseUrl: 'https://provider.invalid/v1', apiKey: 'fictional-owned-key' }) })
    expect(response.status).toBe(200)
    const encrypted = async () => (await runtime.database.query('SELECT ciphertext,nonce,auth_tag,metadata FROM tenant_state_credentials WHERE tenant_id=$1 AND credential_id=$2',
      [organizationId, ORGANIZATION_MODEL_SETTINGS_CREDENTIAL])).rows
    const before = await encrypted()
    expect(await operator.revert(firstOperation, '2')).toMatchObject({ state: 'verified', consumerVerification: 'verified', revision: '3' })
    expect(await encrypted()).toEqual(before)
    expect((await controlOwner.query('SELECT state,reverted_by FROM settings_operator_operations WHERE id=$1', [firstOperation])).rows[0]).toMatchObject({ state: 'reverted' })
    lastOperation = randomUUID()
    const plan = await operator.plan({ schemaVersion: 1, operationId: lastOperation, organizationId,
      resource: { kind: 'model-management', id: organizationId }, expectedRevision: '3', patch: { management: 'dashboard' } })
    expect(await operator.apply(plan)).toMatchObject({ state: 'verified', revision: '4', consumerVerification: 'verified' })
    expect(await encrypted()).toEqual(before)
    expect(catalogs.get(unitId)!.providers).toHaveLength(1)
    expect(catalogs.get(unitId)!.defaultModel).toBeNull()
    expect((await controlOwner.query('SELECT desired_revision::text,effective_revision::text,state FROM organization_model_management WHERE organization_id=$1', [organizationId])).rows[0])
      .toMatchObject({ desired_revision: '4', effective_revision: '4', state: 'active' })
  })

  it('verifies the live consumer rather than historical readiness and rejects browser identity on native policy endpoints', async () => {
    const settings = catalogs.get(unitId)!
    await owner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1",
      [`fixture-model-unit-${unitId}-notifications`])
    const deadline = Date.now() + 5_000
    while (settings.synchronization === 'ready') {
      if (Date.now() >= deadline) throw new Error('actual LISTEN loss was not observed')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(await operator.verify(lastOperation)).toMatchObject({ state: 'verified', consumerVerification: 'pending' })
    await vi.waitFor(() => expect(settings.synchronization).toBe('ready'), { timeout: 5_000 })
    expect(await operator.verify(lastOperation)).toMatchObject({ consumerVerification: 'verified' })
    const cli = await exec(process.execPath, ['--import', createRequire(resolve('../host/package.json')).resolve('tsx/esm'),
      resolve('src/bin/control-plane-settings.ts'), 'verify', '--profile', resolve(directory, 'profile'), '--operation', lastOperation], {
      env: { PATH: process.env.PATH, TMPDIR: resolve('../../.settings-test-work'), KALA_INGRESS_MIGRATIONS_DIR: resolve('migrations') },
    })
    expect(JSON.parse(cli.stdout)).toMatchObject({ operationId: lastOperation, revision: '4', consumerVerification: 'verified' })
    const integrations = await fetch(`${controlOrigin}/settings/sections/integrations`, { headers: actorHeaders })
    expect(integrations.status).toBe(200)
    expect(await integrations.json()).toMatchObject({ integrationStatus: expect.arrayContaining([
      expect.objectContaining({ id: 'artifacts', configured: true, health: 'unknown', sourceRef: 'runtime-object-storage-adapter' }),
    ]) })
    const response = await fetch(`${controlOrigin}/internal/settings/model-management/inspect`, {
      method: 'POST', headers: { 'x-agent-runlab-ingress-secret': secret, cookie: 'fictional=browser', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, unitId }),
    })
    expect(response.status).toBe(403)
    expect((await fetch(`${controlOrigin}/models`, { headers: { ...actorHeaders, 'x-agent-runlab-organization-id': otherOrg, 'x-agent-runlab-runtime-unit': otherUnit } })).status).toBe(200)
  })

  it('refuses incompatible persisted Session references and serializes duplicate cross-database progress without duplicate receipts', async () => {
    const response = await fetch(`${controlOrigin}/settings/models`, { method: 'POST',
      headers: { ...actorHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'owned', id: 'exclusive', label: 'Organization-only fixture model' }) })
    expect(response.status).toBe(200)
    const unit = await service.units.getOrLoad(parseTenantRuntimeUnitId(unitId))
    if (!('server' in unit)) throw new Error('native fixture Unit unavailable')
    const native = unit as Awaited<ReturnType<typeof startLoopbackHostRuntimeUnit>>
    await native.server.store.ensure({ sessionId: 'reference-fixture', organizationId, principal: 'fixture-admin',
      organizationRole: 'admin', defaultConfig: { tools: [] }, preferences: { selectedModel: 'owned:exclusive' } })
    const next = () => ({ schemaVersion: 1, operationId: randomUUID(), organizationId,
      resource: { kind: 'model-management', id: organizationId }, expectedRevision: '4', patch: { management: 'operator' } })
    await expect(operator.plan(next())).rejects.toMatchObject({ code: 'model_policy_references_incompatible' })
    const removed = await fetch(`${controlOrigin}/settings/providers?providerId=owned`, { method: 'DELETE', headers: actorHeaders })
    expect(removed.status).toBe(409)
    expect(catalogs.get(unitId)!.providers).toHaveLength(1)
    await native.server.store.delete('reference-fixture')
    const plan = await operator.plan(next())
    const attempts = await Promise.all([operator.apply(plan), createOperator().apply(plan)])
    expect(attempts.every(receipt => receipt.persisted && receipt.operationId === plan.operationId)).toBe(true)
    await vi.waitFor(async () => expect(await createOperator().verify(plan.operationId)).toMatchObject({
      state: 'verified', revision: '5', consumerVerification: 'verified',
    }), { timeout: 5_000 })
    expect((await runtime.database.query('SELECT count(*)::text AS count FROM settings_model_policy_transitions WHERE operation_id=$1', [plan.operationId])).rows[0]?.count).toBe('1')
    expect((await controlOwner.query("SELECT count(*)::text AS count FROM audit_events WHERE action='settings.operator.model-policy.active' AND metadata->>'operationId'=$1",
      [plan.operationId])).rows[0]?.count).toBe('1')
  })

  it('reconstructs interrupted preparation, lost drain acknowledgement and pre-startup progress from the actual durable authorities', async () => {
    const operationId = randomUUID()
    const plan = await operator.plan({ schemaVersion: 1, operationId, organizationId,
      resource: { kind: 'model-management', id: organizationId }, expectedRevision: '5', patch: { management: 'dashboard' } })
    failBefore = 'quiesce'
    expect(await operator.apply(plan)).toMatchObject({ persisted: true, revision: '6', consumerVerification: 'pending' })
    expect((await controlOwner.query(`SELECT desired_revision::text,effective_revision::text,state
      FROM organization_model_management WHERE organization_id=$1`, [organizationId])).rows[0])
      .toMatchObject({ desired_revision: '6', effective_revision: '5', state: 'preparing' })
    expect((await fetch(`${controlOrigin}/settings/capabilities`, { headers: actorHeaders })).status).toBe(503)
    loss = 'quiesce'
    expect(await createOperator().verify(operationId)).toMatchObject({ persisted: true, consumerVerification: 'pending' })
    expect((await runtime.database.query(`SELECT count(*)::text AS count FROM settings_model_policy_replica_receipts
      WHERE operation_id=$1 AND phase='drained'`, [operationId])).rows[0]?.count).toBe('1')
    failBefore = 'reconcile'
    expect(await createOperator().verify(operationId)).toMatchObject({ consumerVerification: 'pending' })
    expect((await runtime.database.query('SELECT count(*)::text AS count FROM settings_model_policy_transitions WHERE operation_id=$1', [operationId])).rows[0]?.count).toBe('0')
    failBefore = 'resume'
    expect(await createOperator().verify(operationId)).toMatchObject({ consumerVerification: 'pending' })
    expect((await controlOwner.query(`SELECT effective_revision::text,state FROM organization_model_management
      WHERE organization_id=$1`, [organizationId])).rows[0]).toMatchObject({ effective_revision: '6', state: 'awaiting_runtime' })
    expect((await runtime.database.query('SELECT policy_revision::text FROM settings_model_policy_fences WHERE organization_id=$1',
      [organizationId])).rows[0]?.policy_revision).toBe('6')
    expect(await createOperator().verify(operationId)).toMatchObject({ state: 'verified', revision: '6', consumerVerification: 'verified' })
    expect((await runtime.database.query('SELECT count(*)::text AS count FROM settings_model_policy_transitions WHERE operation_id=$1', [operationId])).rows[0]?.count).toBe('1')
    expect((await controlOwner.query("SELECT count(*)::text AS count FROM audit_events WHERE action='settings.operator.model-policy.active' AND metadata->>'operationId'=$1",
      [operationId])).rows[0]?.count).toBe('1')
  })

  it('reads workspace references only under authoritative suspension and retains durable active Session blockers after a real native drain', async () => {
    const request = (workspaceId: string, extra = {}) => fetch(`${controlOrigin}/internal/settings/workspace-references`, {
      method: 'POST', headers: { 'x-agent-runlab-ingress-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ installationId, organizationId, unitId, workspaceId, ...extra }),
    })
    expect((await request('ws_fixture')).status).toBe(503)
    const loaded = await service.units.getOrLoad(parseTenantRuntimeUnitId(unitId)) as Awaited<ReturnType<typeof startLoopbackHostRuntimeUnit>>
    await loaded.server.store.ensure({ sessionId: 'workspace-reference-fixture', organizationId, principal: 'fixture-admin',
      organizationRole: 'admin', workspaceId: 'ws_fixture', defaultConfig: { tools: [] } })
    await service.quiesceUnit(unitId, 'workspace-fixture-maintenance')
    const materialization = (await catalog.refresh(parseTenantRuntimeUnitId(unitId)))!
    await catalog.apply({ ...materialization, generation: materialization.generation + 1, desiredState: 'suspended',
      lastOperationId: 'workspace-fixture-maintenance', updatedAt: new Date().toISOString() })
    const blocked = await request('ws_fixture')
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toMatchObject({ installationId, organizationId, unitId, workspaceId: 'ws_fixture',
      quiesced: true, activeSessions: 1, liveExecutors: 0, unresolvedWorkspaceEffects: 0 })
    const clear = await request('ws_different_fixture')
    expect(clear.status).toBe(200)
    expect(await clear.json()).toMatchObject({ activeSessions: 0, liveExecutors: 0, unresolvedWorkspaceEffects: 0,
      maintenanceHeld: false, revision: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    for (const id of ['ws_fixture', 'ws_different_fixture']) {
      await controlOwner.query('INSERT INTO workspaces(id,organization_id,name) VALUES($1,$2,$1)', [id, organizationId])
    }
    const archive = (id: string) => operator.plan({ schemaVersion: 1, operationId: randomUUID(), organizationId,
      resource: { kind: 'workspace', id }, expectedRevision: '1', patch: { status: 'archived' } })
    await expect(archive('ws_fixture')).rejects.toMatchObject({ code: 'workspace_has_active_references' })
    const plan = await archive('ws_different_fixture')
    loss = 'workspace-reserve'
    expect(await operator.apply(plan)).toMatchObject({ persisted: false, state: 'applying', consumerVerification: 'pending' })
    expect((await controlOwner.query("SELECT count(*)::text AS count FROM workspaces WHERE organization_id=$1 AND status='archived'", [organizationId])).rows[0]?.count).toBe('0')
    expect((await runtime.database.query("SELECT state FROM settings_workspace_maintenance_holds WHERE operation_id=$1", [plan.operationId])).rows[0]?.state).toBe('held')
    const heldMaterialization = (await catalog.refresh(parseTenantRuntimeUnitId(unitId)))!
    await expect(catalog.apply({ ...heldMaterialization, desiredState: 'ready', generation: heldMaterialization.generation + 1,
      lastOperationId: randomUUID(), updatedAt: new Date().toISOString() })).rejects.toMatchObject({ code: '55000' })
    const admit = () => runtime.database.query(`INSERT INTO tenant_session_latest_projection(tenant_id,session_id,version,document)
      VALUES($1,'archived-admission',1,$2::jsonb)`, [organizationId, JSON.stringify({
      sessionId: 'archived-admission', workspaceId: 'ws_different_fixture', state: { status: 'idle' },
    })])
    await expect(admit()).rejects.toMatchObject({ code: '55000' })
    await expect(runtime.database.query('UPDATE tenant_runtime_unit_materializations SET organization_id=$1 WHERE unit_id=$2',
      [otherOrg, unitId])).rejects.toMatchObject({ code: '55000' })
    // Terminal bookkeeping may finish under the hold without reopening admission or invalidating its safe reservation.
    await runtime.database.query(`INSERT INTO tenant_session_latest_projection(tenant_id,session_id,version,document)
      VALUES($1,'held-terminal-bookkeeping',1,$2::jsonb)`, [organizationId, JSON.stringify({
      sessionId: 'held-terminal-bookkeeping', workspaceId: 'ws_different_fixture', state: { status: 'done' },
    })])
    loss = 'operational-consume'
    expect(await createOperator().verify(plan.operationId)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'pending' })
    expect((await runtime.database.query("SELECT state FROM settings_workspace_maintenance_holds WHERE operation_id=$1", [plan.operationId])).rows[0]?.state).toBe('committed')
    expect(await createOperator().verify(plan.operationId)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'verified' })
    await expect(admit()).rejects.toMatchObject({ code: '55000' })
    await controlOwner.query(`INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,seat_limit,concurrent_session_limit)
      VALUES($1,'fixture','standard',now()-interval '1 day',now()+interval '1 day',10,10)`, [organizationId])
    const inverse = await createOperator().revert(plan.operationId, '2')
    expect(inverse).toMatchObject({ persisted: true, revision: '3' })
    expect(await createOperator().verify(inverse.operationId)).toMatchObject({ consumerVerification: 'verified' })
    await expect(admit()).resolves.toMatchObject({ rowCount: 1 })
    expect((await request('ws_fixture', { installationId: randomUUID() })).status).toBe(503)
    expect((await request('ws_fixture', { organizationId: otherOrg })).status).toBe(503)
  })

  it('recovers a SIGKILLed separate restricted Operator process after durable reservation and before its control commit', async () => {
    const workspaceId = 'ws_process_archive'
    await controlOwner.query('INSERT INTO workspaces(id,organization_id,name) VALUES($1,$2,$1)', [workspaceId, organizationId])
    const plan = await createOperator().plan({ schemaVersion: 1, operationId: randomUUID(), organizationId,
      resource: { kind: 'workspace', id: workspaceId }, expectedRevision: '1', patch: { status: 'archived' } })
    const planPath = resolve(directory, 'process-archive-plan')
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 })
    pauseReservationResponse = true
    const args = ['--import', createRequire(resolve('../host/package.json')).resolve('tsx/esm'),
      resolve('src/bin/control-plane-settings.ts')]
    const env = { PATH: process.env.PATH, TMPDIR: resolve('../../.settings-test-work'), KALA_INGRESS_MIGRATIONS_DIR: resolve('migrations') }
    const child = spawn(process.execPath, [...args, 'apply', '--profile', resolve(directory, 'profile'), '--plan', planPath], { env, stdio: 'ignore' })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    try {
      await vi.waitFor(async () => expect((await runtime.database.query(
        'SELECT state FROM settings_workspace_maintenance_holds WHERE operation_id=$1', [plan.operationId])).rows[0]?.state).toBe('held'), { timeout: 5_000 })
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await exited).toMatchObject({ signal: 'SIGKILL' })
      expect((await controlOwner.query('SELECT status,policy_version::text FROM workspaces WHERE id=$1', [workspaceId])).rows[0])
        .toMatchObject({ status: 'active', policy_version: '1' })
      await expect(controlOwner.query("UPDATE workspaces SET name='cannot-steal-maintenance' WHERE id=$1", [workspaceId]))
        .rejects.toMatchObject({ code: '55000' })
      const verified = await exec(process.execPath, [...args, 'verify', '--profile', resolve(directory, 'profile'), '--operation', plan.operationId], { env })
      expect(JSON.parse(verified.stdout)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'verified' })
      expect((await runtime.database.query('SELECT state FROM settings_workspace_maintenance_holds WHERE operation_id=$1', [plan.operationId])).rows[0]?.state).toBe('committed')
      expect((await controlOwner.query("SELECT count(*)::text AS count FROM audit_events WHERE action='settings.operator.applied' AND metadata->>'operationId'=$1",
        [plan.operationId])).rows[0]?.count).toBe('1')
    } finally {
      pauseReservationResponse = false
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })

  it('does not turn a disappeared required replica membership into a fabricated drain receipt', async () => {
    const ghost = await replicaStore.registerReplica({ organizationId: otherOrg, unitId: parseTenantRuntimeUnitId(otherUnit),
      replicaId: 'fixture-unavailable-replica', origin: controlOrigin, membershipToken: randomUUID() }, 15_000)
    const operationId = randomUUID()
    const plan = await createOperator().plan({ schemaVersion: 1, operationId, organizationId: otherOrg,
      resource: { kind: 'model-management', id: otherOrg }, expectedRevision: '1', patch: { management: 'dashboard' } })
    expect(await createOperator().apply(plan)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'pending' })
    await replicaStore.releaseReplica(ghost)
    expect(await createOperator().verify(operationId)).toMatchObject({ consumerVerification: 'pending' })
    expect((await controlOwner.query(`SELECT effective_revision::text,state,required_serving_scope
      FROM organization_model_management WHERE organization_id=$1`, [otherOrg])).rows[0]).toMatchObject({
      effective_revision: '1', state: 'preparing', required_serving_scope: expect.arrayContaining([
        expect.objectContaining({ replicaId: ghost.replicaId, generation: ghost.generation.toString(), phase: 'drain' }),
      ]),
    })
    expect((await runtime.database.query(`SELECT count(*)::text AS count FROM settings_model_policy_replica_receipts
      WHERE operation_id=$1 AND replica_id=$2 AND phase='drained'`, [operationId, ghost.replicaId])).rows[0]?.count).toBe('0')
    expect((await runtime.database.query('SELECT count(*)::text AS count FROM settings_model_policy_transitions WHERE operation_id=$1',
      [operationId])).rows[0]?.count).toBe('0')
  })

  it('binds an actual native device to its enrolled pool once, rechecks pool/contract admission and preserves the association after rotation', async () => {
    const workspaceId = 'ws_different_fixture', executorId = 'native-pool-device'
    const materialization = (await catalog.refresh(parseTenantRuntimeUnitId(unitId)))!
    await catalog.apply({ ...materialization, generation: materialization.generation + 1, desiredState: 'ready',
      lastOperationId: randomUUID(), updatedAt: new Date().toISOString() })
    await service.resumeUnit(unitId, organizationId, 'workspace-fixture-maintenance')
    const unit = await service.units.getOrLoad(parseTenantRuntimeUnitId(unitId)) as Awaited<ReturnType<typeof startLoopbackHostRuntimeUnit>>
    const identities = new PostgresExecutorIdentityStore(runtime.database, organizationId, unitId)
    const invite = await identities.createInvite({ label: 'fictional pool enrollment' })
    await controlOwner.query(`INSERT INTO principals(id,kind,issuer,subject) VALUES('prn_pool_fixture','human','fixture','pool-fixture');
      INSERT INTO executor_pools(id,organization_id,name,mode) VALUES('pool_native_fixture','${organizationId}','Native fixture','organization')`)
    await controlOwner.query("INSERT INTO organization_memberships(organization_id,principal_id,role) VALUES($1,'prn_pool_fixture','owner')", [organizationId])
    const directory = new PostgresOrganizationStore(gatewayDb)
    await directory.bindExecutorInvite(invite.inviteToken, unitId, { id: invite.id, expiresAt: invite.expiresAt })
    expect((await controlOwner.query('SELECT expires_at FROM executor_enrollment_tokens WHERE token_hash=$1',
      [inviteKey(invite.inviteToken)])).rows[0]?.expires_at.toISOString()).toBe(invite.expiresAt)
    const announce = { executorId, workspaceId, workspaceName: 'Pool fixture', tools: ['read'], runtime: 'node' as const, runtimeVersion: '22' }
    const attach = async (token: string) => {
      const socket = connect(`http://127.0.0.1:${service.port}/executor`, { transports: ['websocket'], reconnection: false,
        extraHeaders: actorHeaders, auth: { role: 'executor', clientVersion: PROTOCOL_VERSION,
          ...(token.startsWith('ak_invite_') ? { invite: token } : { token }) } })
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
      return socket
    }
    const first = await attach(invite.inviteToken)
    try {
      const credential = new Promise<string>(resolve => first.once('executor:welcome', (value: { token: string }) => resolve(value.token)))
      first.emit('executor:announce', announce)
      const token = await credential
      await vi.waitFor(() => expect(unit.server.executorsSnapshot().map(value => value.executorId)).toContain(executorId))
      expect((await controlOwner.query("SELECT used_count FROM executor_enrollment_tokens WHERE pool_id='pool_native_fixture'")).rows[0]?.used_count).toBe(1)
      const enrolled = await new PostgresExecutorIdentityStore(runtime.database, organizationId, unitId).resolveToken(token)
      expect(enrolled?.enrollmentHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(enrolled?.enrollmentInviteId).toBe(invite.id)
      const poolPlan = () => createOperator().plan({ schemaVersion: 1, operationId: randomUUID(), organizationId,
        resource: { kind: 'pool', id: 'pool_native_fixture' }, expectedRevision: '1',
        patch: { mode: 'workspace', workspaceId: 'ws_fixture' } })
      await expect(poolPlan()).rejects.toMatchObject({ code: 'pool_has_enrollment_references' })
      first.disconnect()
      const rotated = await new PostgresExecutorIdentityStore(runtime.database, organizationId, unitId).rotateWorkspaceCredential(workspaceId)
      expect((await identities.resolveToken(rotated))?.enrollmentHash).toBe(enrolled?.enrollmentHash)
      const next = await attach(rotated)
      try {
        next.emit('executor:announce', announce)
        await vi.waitFor(() => expect(unit.server.executorsSnapshot().map(value => value.executorId)).toContain(executorId))
        expect((await controlOwner.query("SELECT used_count FROM executor_enrollment_tokens WHERE pool_id='pool_native_fixture'")).rows[0]?.used_count).toBe(1)
        expect((await controlOwner.query("SELECT count(*)::text AS count FROM executors WHERE pool_id='pool_native_fixture'")).rows[0]?.count).toBe('1')
        await controlOwner.query("UPDATE executors SET status='revoked' WHERE pool_id='pool_native_fixture'")
        const rejected = new Promise<void>(resolve => next.once('disconnect', () => resolve()))
        next.emit('executor:shell_authorize', { sessionId: 'unknown', callId: 'unknown', name: 'shell', command: 'echo fixture' }, () => undefined)
        await rejected
      } finally { next.disconnect() }
      const regenerated = (await identities.regenerateInvite(invite.id))!
      await directory.revokeExecutorInviteBinding(invite.id, unitId, true)
      await directory.bindExecutorInvite(regenerated.inviteToken, unitId, { id: regenerated.id, expiresAt: regenerated.expiresAt })
      const renewed = await attach(regenerated.inviteToken)
      try {
        const welcome = new Promise<string>(resolve => renewed.once('executor:welcome', (value: { token: string }) => resolve(value.token)))
        renewed.emit('executor:announce', announce)
        const regeneratedToken = await welcome
        await vi.waitFor(() => expect(unit.server.executorsSnapshot().map(value => value.executorId)).toContain(executorId))
        await directory.bindExecutorInvite(regenerated.inviteToken, unitId, { id: regenerated.id, expiresAt: regenerated.expiresAt })
        expect((await controlOwner.query("SELECT used_count FROM executor_enrollment_tokens WHERE pool_id='pool_native_fixture'")).rows[0]?.used_count).toBe(1)
        expect((await controlOwner.query("SELECT count(*)::text AS count FROM executors WHERE pool_id='pool_native_fixture' AND status='active'")).rows[0]?.count).toBe('1')
        await identities.deleteInvite(invite.id)
        await directory.revokeExecutorInviteBinding(invite.id, unitId, false)
        renewed.disconnect()
        const retained = await attach(regeneratedToken)
        try {
          retained.emit('executor:announce', announce)
          await vi.waitFor(() => expect(unit.server.executorsSnapshot().map(value => value.executorId)).toContain(executorId))
          await identities.revokeWorkspace(workspaceId)
          await directory.revokeExecutorInviteBinding(invite.id, unitId, true)
          const disconnected = new Promise<void>(resolve => retained.once('disconnect', () => resolve()))
          retained.emit('executor:shell_authorize', { sessionId: 'unknown', callId: 'unknown', name: 'shell', command: 'echo fixture' }, () => undefined)
          await disconnected
        } finally { retained.disconnect() }
      } finally { renewed.disconnect() }
    } finally { first.disconnect() }
  }, 30_000)

  it('applies pool binding through the installed admission source and changes real principal/Native admission with a verified contract inverse', async () => {
    const binding = await createOperator().plan({ schemaVersion: 1, operationId: randomUUID(), organizationId,
      resource: { kind: 'pool', id: 'pool_native_fixture' }, expectedRevision: '1',
      patch: { mode: 'workspace', workspaceId: 'ws_fixture' } })
    expect(await createOperator().apply(binding)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'pending' })
    expect(await createOperator().verify(binding.operationId)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'verified' })
    const reader = new PostgresModelPolicyReader(gatewayDb, installationId)
    const wrongWorkspaceInvite = 'fictional-pool-binding-invite'
    await controlOwner.query(`INSERT INTO executor_enrollment_tokens(id,organization_id,pool_id,token_hash,created_by,expires_at)
      VALUES('binding-fixture-enrollment',$1,'pool_native_fixture',$2,'prn_pool_fixture',now()+interval '1 hour')`,
    [organizationId, inviteKey(wrongWorkspaceInvite)])
    const { createHash } = await import('node:crypto')
    const enrollmentHash = createHash('sha256').update(wrongWorkspaceInvite).digest('hex')
    expect(await reader.executor({ installationId, organizationId, unitId, executorId: 'new-bound-fixture',
      workspaceId: 'ws_different_fixture', enrollmentHash })).toMatchObject({ admitted: false, pool: { revision: '2', mode: 'workspace', workspaceId: 'ws_fixture' } })
    expect(await reader.executor({ installationId, organizationId, unitId, executorId: 'new-bound-fixture',
      workspaceId: 'ws_fixture', enrollmentHash })).toMatchObject({ admitted: true, registry: 'registered', pool: { revision: '2' } })
    expect((await controlOwner.query("SELECT used_count FROM executor_enrollment_tokens WHERE id='binding-fixture-enrollment'")).rows[0]?.used_count).toBe(1)
    const organizations = new PostgresOrganizationStore(gatewayDb)
    const principal = { issuer: 'fixture', subject: 'pool-fixture' }
    expect((await organizations.findAccess(principal))?.organization.status).toBe('active')
    const expire = await createOperator().plan({ schemaVersion: 1, operationId: randomUUID(), organizationId,
      resource: { kind: 'entitlement', id: organizationId }, expectedRevision: '1',
      patch: { endsAt: new Date(Date.now() - 3_600_000).toISOString() } })
    expect(await createOperator().apply(expire)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'pending' })
    expect(await createOperator().verify(expire.operationId)).toMatchObject({ persisted: true, revision: '2', consumerVerification: 'verified' })
    expect((await organizations.findAccess(principal))?.organization.status).toBe('expired')
    expect(await reader.executor({ installationId, organizationId, unitId, executorId: 'new-bound-fixture',
      workspaceId: 'ws_fixture', enrollmentHash })).toMatchObject({ admitted: false })
    const restored = await createOperator().revert(expire.operationId, '2')
    expect(restored).toMatchObject({ persisted: true, revision: '3', consumerVerification: 'pending' })
    expect(await createOperator().verify(restored.operationId)).toMatchObject({ persisted: true, revision: '3', consumerVerification: 'verified' })
    expect((await organizations.findAccess(principal))?.organization.status).toBe('active')
    expect(await reader.executor({ installationId, organizationId, unitId, executorId: 'new-bound-fixture',
      workspaceId: 'ws_fixture', enrollmentHash })).toMatchObject({ admitted: true, registry: 'registered' })
    const directory = await new PostgresOrganizationStore(gatewayDb).settingsView(organizationId, 'executors', { limit: 100 })
    expect(directory.executorPools).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'pool_native_fixture', mode: 'workspace', workspaceId: 'ws_fixture', revision: '2' })]))
    expect(directory.executorRegistrations).toEqual(expect.arrayContaining([expect.objectContaining({ nativeExecutorId: 'new-bound-fixture', workspaceId: 'ws_fixture', status: 'active' })]))
    expect((await createOperator().inspect(organizationId, { kind: 'entitlement', id: organizationId })).enforcement)
      .toMatchObject({ startsAt: 'enforced', endsAt: 'enforced', monthlyTokenLimit: 'reported-only', concurrentSessionLimit: 'reported-only' })
  })
})
