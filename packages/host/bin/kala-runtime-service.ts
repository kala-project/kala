#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { AGENT_RUNTIME_CAPABILITIES, FULL_RUNTIME_CAPABILITIES, productVariant } from '@agent-kernel/shared'

import { startLoopbackHostRuntimeUnit } from '../src/tenant-runtime/loopback-host-unit.js'
import { resolveBuiltinAgentModule } from '../src/builtin-tools.js'
import { ExplicitLLMClientFactory } from '../src/llm/client-factory.js'
import { startTenantRuntimeService } from '../src/tenant-runtime/service.js'
import { readRequiredSecretEnv } from '../src/config/secret-env.js'
import { createRuntimeProviderRuntime, FileSecretResolver, loadRuntimeProviderCatalog } from '../src/llm/runtime-provider-catalog.js'
import { RuntimeUnitMaterializationStore, type RuntimeUnitMaterializationCatalog } from '../src/tenant-runtime/materialization-store.js'
import { createPostgresRuntimeUnitMaterializationStore } from '../src/tenant-runtime/postgres-materialization-store.js'
import { createPostgresRuntimeUnitPlacementStore, RuntimeUnitPlacementHeldError, type RuntimeUnitPlacementLease } from '../src/tenant-runtime/postgres-runtime-unit-placement-store.js'
import { PostgresRuntimeUnitPlacementOwnership, validateNodeId, validateNodeOrigin } from '../src/tenant-runtime/runtime-unit-placement-ownership.js'
import { createPostgresRuntimeResourceOwnershipStore, RuntimeResourceOwnershipHeldError } from '../src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { PostgresRuntimeReplicaMembership } from '../src/tenant-runtime/runtime-replica-membership.js'
import { RuntimeResourceOwnershipManager } from '../src/tenant-runtime/runtime-resource-ownership.js'
import { RuntimeSessionOwnership } from '../src/tenant-runtime/runtime-session-ownership.js'
import { attachTenantRuntimeControlApi } from '../src/tenant-runtime/control-api.js'
import { LocalWebSearchCredentialStore, PostgresWebSearchCredentialStore } from '../src/web-search/credential-store.js'
import { KalaStateStore } from '../src/store/state-store.js'
import { LocalAzureSpeechCredentialStore, PostgresAzureSpeechCredentialStore } from '../src/speech/credential-store.js'
import { loadProductDeploymentConfig } from '../src/deployment-config.js'
import { UnitResourceGovernor } from '../src/tenant-runtime/resource-governor.js'
import type { TenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'
import { createPostgresHotStateStore } from '../src/tenant-runtime/postgres-hot-state.js'
import { PostgresSessionAuthority } from '../src/store/postgres-session-authority.js'
import { createPrivateCloudObjectStorage } from '../src/artifacts/private-cloud-storage.js'
import { PostgresTenantStateStore, loadPostgresStateMasterKey } from '../src/tenant-runtime/postgres-state.js'
import { PostgresMemoStore } from '../src/memo-store.js'
import { PostgresDagStore } from '../src/dag/postgres-store.js'
import { PostgresScheduledTaskStore } from '../src/scheduled-tasks/postgres-store.js'
import { PostgresPushSubscriptionStore } from '../src/push/postgres-store.js'
import { loadOrCreateVapidKeys } from '../src/push/vapid.js'
import { PostgresWorkspaceAliasStore } from '../src/store/postgres-workspace-alias.js'
import { PostgresExecutorInstallationStore } from '../src/store/postgres-executor-installation.js'
import { PostgresExecutorIdentityStore } from '../src/store/postgres-executor-identity.js'
import { initializePrivateCloudExperimentalStorageSchema } from '../src/store/postgres-private-cloud-storage.js'
import { checkPostgresSchemaVersion, initializeExperimentalRuntimeResourceOwnershipSchema, type PostgresSchemaManagement } from '../src/postgres-migrations.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const experimentalStorage = await readExperimentalDockerStorageConfig()
  const sessionOwnershipFlag = process.env.KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP
  if (sessionOwnershipFlag !== undefined && sessionOwnershipFlag !== '1') {
    throw new Error('KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP must be 1 when set')
  }
  if (sessionOwnershipFlag === '1' && experimentalStorage?.schemaManagement !== 'external') {
    throw new Error('Session ownership requires experimental storage with an operator-migrated PostgreSQL schema')
  }
  if (experimentalStorage?.schemaManagement === 'external') {
    await checkPostgresSchemaVersion({
      connectionString: experimentalStorage.connectionString,
      applicationName: 'kala-runtime-schema-check',
    })
  }
  const experimentalStateMasterKey = experimentalStorage
    ? await loadPostgresStateMasterKey(experimentalStorage.stateMasterKeyFile)
    : undefined
  // Private Cloud Runtime Units are operator-controlled. Match the Dedicated
  // binary's default while retaining an explicit opt-out.
  if (process.env.KALA_ALLOW_ALL_OK === undefined) process.env.KALA_ALLOW_ALL_OK = '1'
  const deployment = loadProductDeploymentConfig({ configPath: required('KALA_DEPLOYMENT_CONFIG') })
  if (productVariant(deployment) !== 'private-cloud') throw new Error('Runtime service requires a Private Cloud deployment config')
  const capabilities = deployment.runtimeProfile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES
  const port = Number(process.env.KALA_RUNTIME_KALA_PORT ?? 13002)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('KALA_RUNTIME_KALA_PORT must be a valid port')
  const ingressSecret = await readRequiredSecretEnv('KALA_INGRESS_SHARED_SECRET')
  if (Buffer.byteLength(ingressSecret) < 32) throw new Error('KALA_INGRESS_SHARED_SECRET must contain at least 32 bytes')
  const dataRoot = resolve(required('KALA_RUNTIME_HOST_DATA_ROOT'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const catalog: RuntimeUnitMaterializationCatalog = experimentalStorage
    ? createPostgresRuntimeUnitMaterializationStore({
        connectionString: experimentalStorage.connectionString,
        applicationName: 'kala-runtime-experimental-materializations',
        schemaManagement: experimentalStorage.schemaManagement,
      })
    : new RuntimeUnitMaterializationStore(join(dataRoot, 'host', 'runtime-unit-catalog.json'))
  await catalog.load()
  const placementStore = experimentalStorage
    ? createPostgresRuntimeUnitPlacementStore({
        connectionString: experimentalStorage.connectionString,
        applicationName: `kala-runtime-placement-${experimentalStorage.nodeId}`,
      })
    : undefined
  if (experimentalStorage?.schemaManagement !== 'external') await placementStore?.initialize()
  const replicaStore = experimentalStorage
    ? createPostgresRuntimeResourceOwnershipStore({
        connectionString: experimentalStorage.connectionString,
        applicationName: `kala-runtime-replica-${experimentalStorage.nodeId}`,
      })
    : undefined
  if (replicaStore && experimentalStorage?.schemaManagement !== 'external') {
    await initializeExperimentalRuntimeResourceOwnershipSchema(replicaStore.database)
  }
  const replicaMembership = replicaStore && experimentalStorage
    ? new PostgresRuntimeReplicaMembership(replicaStore, {
        replicaId: randomUUID(),
        origin: experimentalStorage.nodeOrigin,
        ttlMs: experimentalStorage.placementTtlMs,
      })
    : undefined
  const placementOwnership = placementStore && experimentalStorage
    ? new PostgresRuntimeUnitPlacementOwnership(placementStore, {
        nodeId: experimentalStorage.nodeId,
        origin: experimentalStorage.nodeOrigin,
        ttlMs: experimentalStorage.placementTtlMs,
      })
    : undefined
  const catalogPath = process.env.KALA_RUNTIME_HOST_LLM_CATALOG_FILE?.trim()
  const runtimeProvider = catalogPath
    ? await createRuntimeProviderRuntime(
        await loadRuntimeProviderCatalog(catalogPath),
        new ExplicitLLMClientFactory(new FileSecretResolver(process.env.KALA_RUNTIME_HOST_SECRET_ROOT ?? '/run/kala-secrets')),
      )
    : await createEnvironmentRuntimeProvider()
  const agentModule = resolveBuiltinAgentModule()
  const maxArtifactBytes = positiveIntegerEnv('KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES', 10 * 1024 * 1024 * 1024)
  const resourceGovernor = new UnitResourceGovernor({
    maxConcurrentTurns: positiveIntegerEnv('KALA_RUNTIME_UNIT_MAX_CONCURRENT_TURNS', 4),
    maxQueuedMessages: positiveIntegerEnv('KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES', 100),
    maxArtifactBytes,
  })
  const dashboardDir = process.env.KALA_RUNTIME_HOST_DASHBOARD_DIR
  const docsDir = process.env.KALA_RUNTIME_HOST_DOCS_DIR
  const releaseAssetsDir = process.env.KALA_RUNTIME_HOST_RELEASE_ASSETS_DIR
  // Anonymous downloads must never be bound to whichever organization happens
  // to be active. This reserved unit exposes only shared, read-only installers.
  const publicInstallerUnitId = 'public-installer'
  const isPublicInstallerRequest = (request: import('node:http').IncomingMessage): boolean => {
    const path = (request.url ?? '').split('?', 1)[0] ?? ''
    return (request.method === 'GET' || request.method === 'HEAD')
      && (path === '/install' || path === '/install.ps1' || path === '/install/invite.ps1'
        || path.startsWith('/install/assets/') || path.startsWith('/release-assets/'))
  }
  const tlsPaths = [
    process.env.KALA_RUNTIME_TLS_KEY_FILE,
    process.env.KALA_RUNTIME_TLS_CERT_FILE,
    process.env.KALA_RUNTIME_TLS_CA_FILE,
  ]
  if (tlsPaths.some(Boolean) && !tlsPaths.every(Boolean)) {
    throw new Error('KALA_RUNTIME_TLS_KEY_FILE, KALA_RUNTIME_TLS_CERT_FILE, and KALA_RUNTIME_TLS_CA_FILE must be configured together')
  }
  const host = await startTenantRuntimeService({
    port,
    listenHost: process.env.KALA_RUNTIME_KALA_BIND_HOST ?? '127.0.0.1',
    ingressSecret,
    requireProvisioning: true,
    maxLoadedUnits: Number(process.env.KALA_RUNTIME_HOST_MAX_LOADED_UNITS ?? 100),
    ...(placementOwnership ? {
      placementOwnership,
      replicaMembership,
      requiresPlacement: (unitId: TenantRuntimeUnitId) => unitId !== publicInstallerUnitId,
    } : {}),
    ...(tlsPaths.every(Boolean) ? {
      tls: {
        key: await readFile(tlsPaths[0]!),
        cert: await readFile(tlsPaths[1]!),
        ca: await readFile(tlsPaths[2]!),
      },
    } : {}),
    resolveUnitId: (request) => {
      const value = request.headers['x-agent-runlab-runtime-unit']
      if (value === publicInstallerUnitId) return releaseAssetsDir && isPublicInstallerRequest(request) ? value : undefined
      return typeof value === 'string' ? value : undefined
    },
    factory: async (id) => {
      const unitRoot = join(dataRoot, 'tenant-runtime-units', id)
      const organizationId = experimentalStorage && id !== publicInstallerUnitId
        ? await trustedOrganizationId(catalog, id)
        : undefined
      const placementLease = organizationId
        ? placementOwnership?.activeLease(id, organizationId)
        : undefined
      if (organizationId && !placementLease) {
        throw new Error(`Runtime Unit ${id} cannot load experimental storage without an active placement lease`)
      }
      if (placementLease?.protocol === 'parallel-v1' && sessionOwnershipFlag !== '1') {
        throw new Error(`Runtime Unit ${id} has an operator-gated parallel placement, but Session ownership is not enabled`)
      }
      const workspaceDir = join(unitRoot, 'workspace')
      const stateStore = new KalaStateStore(unitRoot, {
        ...(process.env.KALA_STATE_MASTER_KEY_PATH ? { keyPath: process.env.KALA_STATE_MASTER_KEY_PATH } : {}),
        legacyMemoDirectory: join(unitRoot, 'memos'),
        legacyCredentialDirectory: join(unitRoot, 'credentials'),
      })
      const localWebSearchCredentialStore = new LocalWebSearchCredentialStore(stateStore)
      const localSpeechCredentialStore = new LocalAzureSpeechCredentialStore(stateStore)
      // In object-backed mode the Runtime may only keep disposable local data.
      // A loopback Executor's workspace and execution receipts are durable
      // authorities and cannot safely live in this Pod's tmpfs.
      if (!experimentalStorage) await mkdir(workspaceDir, { recursive: true, mode: 0o700 })
      const sessionOwnership = sessionOwnershipFlag === '1' && replicaStore && replicaMembership && organizationId
        ? new RuntimeSessionOwnership(organizationId, id, replicaMembership,
            new RuntimeResourceOwnershipManager(replicaStore),
            async (lostUnitId) => { await host.suspendUnit(lostUnitId) })
        : undefined
      if (placementLease?.protocol === 'parallel-v1') {
        if (!sessionOwnership) {
          throw new Error(`Runtime Unit ${id} cannot use parallel-v1 without live replica membership and Session ownership`)
        }
        if (!experimentalStorage || experimentalStorage.schemaManagement !== 'external') {
          throw new Error(`Runtime Unit ${id} requires operator-migrated versioned PG/S3 storage for parallel-v1`)
        }
      }
      const persistentStorage = experimentalStorage && experimentalStateMasterKey && organizationId && placementLease
        ? await createExperimentalUnitStorage(experimentalStorage, organizationId, id, experimentalStateMasterKey,
            placementLease, maxArtifactBytes, sessionOwnership)
        : undefined
      const resourceArtifactUsage = persistentStorage
        ? persistentStorage.objectStorage.resourceArtifactUsage
        : async () => await directoryBytes([
            join(unitRoot, 'artifacts'),
            join(unitRoot, 'session-artifacts'),
            join(unitRoot, 'message-attachments'),
          ])
      resourceGovernor.reconcile(id, { artifactBytes: await resourceArtifactUsage() })
      const webSearchCredentialStore = persistentStorage?.webSearchCredentialStore ?? localWebSearchCredentialStore
      const speechCredentialStore = persistentStorage?.speechCredentialStore ?? localSpeechCredentialStore
      return startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(unitRoot, 'sessions'),
        // Trace/message-assembly captures currently write only to the local
        // artifact tree; do not publish disposable captures in PG/S3 mode.
        artifactRootDir: persistentStorage ? false : join(unitRoot, 'artifacts'),
        ...(persistentStorage ? {
          sessionAuthority: persistentStorage.sessionAuthority,
          ...(persistentStorage.assertSessionEffectOwner ? {
            assertSessionEffectOwner: persistentStorage.assertSessionEffectOwner,
          } : {}),
          objectStorage: persistentStorage.objectStorage,
          memoStore: persistentStorage.memoStore,
          dagStore: persistentStorage.dagStore,
          scheduledTaskStore: persistentStorage.scheduledTaskStore,
          workspaceAliasStore: persistentStorage.workspaceAliasStore,
          executorInstallationStore: persistentStorage.executorInstallationStore,
          executorIdentityStore: persistentStorage.executorIdentityStore,
          pushStore: persistentStorage.pushStore,
          vapidKeys: persistentStorage.vapidKeys,
          closeResource: persistentStorage.close,
        } : {}),
        ...(!persistentStorage && id !== publicInstallerUnitId ? {
          workspaceDir,
          executorIdentityStorePath: join(unitRoot, 'executor-identities.json'),
        } : {}),
        llm: runtimeProvider.llm,
        defaultConfig: agentModule.config,
        models: runtimeProvider.models,
        defaultModel: runtimeProvider.defaultModel,
        deployment,
        capabilities,
        webSearchCredentials: webSearchCredentialStore,
        webSearchCredentialStatus: () => webSearchCredentialStore.status(),
        setWebSearchCredential: (provider, key) => webSearchCredentialStore.set(provider, key),
        deleteWebSearchCredential: (provider) => webSearchCredentialStore.delete(provider),
        speechCredentials: speechCredentialStore,
        stateStore,
        resourceGovernor,
        resourceUnitId: id,
        resourceArtifactUsage,
        ...(dashboardDir ? { staticDir: resolve(dashboardDir) } : {}),
        ...(docsDir ? { docsRootDir: resolve(docsDir) } : {}),
        ...(releaseAssetsDir ? { releaseAssetsDir: resolve(releaseAssetsDir) } : {}),
        settings: {
          providers: [], defaultModel: '', hooks: [],
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: join(unitRoot, 'sessions') },
          mcp: { supported: false, note: 'disabled in Private Cloud bootstrap' },
          ...(releaseAssetsDir ? { release: { bootstrapBaseUrl: '/release-assets', source: 'local' as const } } : {}),
        },
      })
    },
  })
  for (const entry of catalog.list()) {
    if (entry.desiredState !== 'ready') continue
    try {
      await host.markRoutable(entry.unitId, placementOwnership ? await trustedOrganizationId(catalog, entry.unitId) : undefined)
    } catch (error) {
      if (!(error instanceof RuntimeUnitPlacementHeldError)) throw error
      process.stderr.write(`${JSON.stringify({ event: 'tenant_runtime_unit_placement_held', unitId: entry.unitId, currentNodeId: error.currentNodeId })}\n`)
    }
  }
  if (releaseAssetsDir) await host.markRoutable(publicInstallerUnitId)
  attachTenantRuntimeControlApi({ http: host.http, serviceSecret: ingressSecret, service: host, store: catalog, dataRoot, capabilities })
  process.stdout.write(`${JSON.stringify({ event: 'tenant_runtime_service_ready', port: host.port, dataRoot })}\n`)
  const shutdown = async (): Promise<void> => {
    try { await host.drain(); await host.close() } finally {
      await Promise.allSettled([catalog.close(), placementStore?.close() ?? Promise.resolve(), replicaStore?.close() ?? Promise.resolve()])
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() }); process.on('SIGINT', () => { void shutdown() })
}

type ExperimentalDockerStorageConfig = {
  connectionString: string
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  maxObjectBytes: number
  forcePathStyle: boolean
  nodeId: string
  nodeOrigin: string
  placementTtlMs: number
  stateMasterKeyFile: string
  schemaManagement: PostgresSchemaManagement
}

const EXPERIMENTAL_STORAGE_FLAG = 'KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE'
const EXPERIMENTAL_STORAGE_SECRET_ENV = [
  'KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING',
  'KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID',
  'KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY',
] as const
const EXPERIMENTAL_STORAGE_ENV = [
  'KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT',
  'KALA_RUNTIME_EXPERIMENTAL_S3_REGION',
  'KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET',
  'KALA_RUNTIME_EXPERIMENTAL_S3_MAX_OBJECT_BYTES',
  'KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE',
  'KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE',
] as const

async function readExperimentalDockerStorageConfig(): Promise<ExperimentalDockerStorageConfig | undefined> {
  const enabled = process.env[EXPERIMENTAL_STORAGE_FLAG]
  const configured = EXPERIMENTAL_STORAGE_ENV.some((name) => process.env[name] !== undefined)
    || EXPERIMENTAL_STORAGE_SECRET_ENV.some((name) => process.env[name] !== undefined || process.env[`${name}_FILE`] !== undefined)
  if (enabled === undefined && !configured) return undefined
  if (enabled !== '1') {
    throw new Error(`${EXPERIMENTAL_STORAGE_FLAG}=1 is required when experimental DB/S3 storage is configured`)
  }
  const values = Object.fromEntries(EXPERIMENTAL_STORAGE_ENV.map((name) => [name, required(name)]))
  const connectionString = await readRequiredExperimentalStorageSecret('KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING')
  const accessKeyId = await readRequiredExperimentalStorageSecret('KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID')
  const secretAccessKey = await readRequiredExperimentalStorageSecret('KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY')
  const maxObjectBytes = Number(values.KALA_RUNTIME_EXPERIMENTAL_S3_MAX_OBJECT_BYTES)
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
    throw new Error('KALA_RUNTIME_EXPERIMENTAL_S3_MAX_OBJECT_BYTES must be a positive safe integer')
  }
  const forcePathStyleValue = values.KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE
  if (forcePathStyleValue !== 'true' && forcePathStyleValue !== 'false') {
    throw new Error('KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE must be true or false')
  }
  const schemaMode = process.env.KALA_RUNTIME_POSTGRES_SCHEMA_MODE?.trim() ?? 'experimental-initialize'
  if (schemaMode !== 'experimental-initialize' && schemaMode !== 'versioned') {
    throw new Error('KALA_RUNTIME_POSTGRES_SCHEMA_MODE must be experimental-initialize or versioned')
  }
  const placementTtlMs = Number(process.env.KALA_RUNTIME_EXPERIMENTAL_PLACEMENT_TTL_MS ?? 15_000)
  if (!Number.isSafeInteger(placementTtlMs) || placementTtlMs < 5_000 || placementTtlMs > 120_000) {
    throw new Error('KALA_RUNTIME_EXPERIMENTAL_PLACEMENT_TTL_MS must be an integer between 5000 and 120000')
  }
  return {
    connectionString,
    endpoint: values.KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT!,
    region: values.KALA_RUNTIME_EXPERIMENTAL_S3_REGION!,
    bucket: values.KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET!,
    accessKeyId,
    secretAccessKey,
    maxObjectBytes,
    forcePathStyle: forcePathStyleValue === 'true',
    nodeId: validateNodeId(required('KALA_RUNTIME_NODE_ID')),
    nodeOrigin: validateNodeOrigin(required('KALA_RUNTIME_NODE_ORIGIN')),
    placementTtlMs,
    stateMasterKeyFile: values.KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE!,
    schemaManagement: schemaMode === 'versioned' ? 'external' : 'initialize',
  }
}

async function readRequiredExperimentalStorageSecret(name: typeof EXPERIMENTAL_STORAGE_SECRET_ENV[number]): Promise<string> {
  if (process.env[name] !== undefined && process.env[`${name}_FILE`] !== undefined) {
    throw new Error(`${name} and ${name}_FILE are mutually exclusive`)
  }
  return readRequiredSecretEnv(name)
}

async function trustedOrganizationId(catalog: RuntimeUnitMaterializationCatalog, id: TenantRuntimeUnitId): Promise<string> {
  const materialization = await catalog.refresh(id)
  if (materialization?.desiredState !== 'ready') throw new Error(`TenantRuntimeUnit ${id} is not ready`)
  const organizationId = materialization.organizationId
  if (typeof organizationId !== 'string' || organizationId.length > 200 || !/^org_[A-Za-z0-9_-]+$/u.test(organizationId)) {
    throw new Error(`TenantRuntimeUnit ${id} has no valid trusted organization binding for S3 storage`)
  }
  return organizationId
}

async function createExperimentalUnitStorage(
  config: ExperimentalDockerStorageConfig,
  organizationId: string,
  unitId: TenantRuntimeUnitId,
  stateMasterKey: Uint8Array,
  placementLease: RuntimeUnitPlacementLease,
  maxArtifactBytes: number,
  sessionOwnership?: RuntimeSessionOwnership,
) {
  const hotState = createPostgresHotStateStore({
    connectionString: config.connectionString,
    applicationName: `kala-runtime-experimental-${organizationId}`,
    placementLease,
  })
  let closed = false
  let orphanSweepTimer: NodeJS.Timeout | undefined
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (orphanSweepTimer) clearInterval(orphanSweepTimer)
    try { await sessionOwnership?.close() } finally { await hotState.close() }
  }
  try {
    if (config.schemaManagement !== 'external') await hotState.initialize()
    const tenantState = new PostgresTenantStateStore(hotState.database, organizationId, stateMasterKey)
    const vapidPublic = process.env.KALA_PUSH_VAPID_PUBLIC?.trim()
    const vapidPrivate = process.env.KALA_PUSH_VAPID_PRIVATE?.trim()
    if (Boolean(vapidPublic) !== Boolean(vapidPrivate)) {
      throw new Error('Private Cloud push requires both externally supplied VAPID keys, or neither to disable push')
    }
    // Only invoke the legacy loader with a complete externally supplied pair:
    // the no-env branch would generate a private key on disposable local disk.
    const vapidKeys = vapidPublic && vapidPrivate ? loadOrCreateVapidKeys('') : null
    // Experimental bootstrap only. Production rollout must move this DDL into
    // an operator-run, versioned migration before runtime processes start.
    if (config.schemaManagement !== 'external') await tenantState.initializeSchema()
    const dagStore = new PostgresDagStore(hotState.database, organizationId, unitId, {
      schemaManagement: config.schemaManagement,
      ...(sessionOwnership ? {
        prepareSessionOwner: async (sessionId: string) => { await sessionOwnership.ensure(sessionId) },
        resourceOwnerForSession: (sessionId: string) => sessionOwnership.activeLease(sessionId),
      } : {}),
    })
    await dagStore.initialize()
    const scheduledTaskStore = new PostgresScheduledTaskStore(hotState.database, organizationId, {
      schemaManagement: config.schemaManagement,
      ...(sessionOwnership ? {
        prepareSessionOwner: async (sessionId: string) => { await sessionOwnership.ensure(sessionId) },
        resourceOwnerForSession: (sessionId: string) => sessionOwnership.activeLease(sessionId),
        ...(placementLease.protocol === 'parallel-v1' ? {
          writerMode: 'parallel-v1' as const,
          tryPrepareScheduledSessionOwner: async (sessionId: string) => {
            try {
              await sessionOwnership.ensure(sessionId)
              return true
            } catch (error) {
              if (error instanceof RuntimeResourceOwnershipHeldError) return false
              throw error
            }
          },
        } : {}),
      } : {}),
    })
    if (config.schemaManagement !== 'external') await initializePrivateCloudExperimentalStorageSchema(hotState.database)
    const workspaceAliasStore = new PostgresWorkspaceAliasStore(hotState.database, organizationId)
    const executorInstallationStore = new PostgresExecutorInstallationStore(hotState.database, organizationId)
    const executorIdentityStore = new PostgresExecutorIdentityStore(hotState.database, organizationId, unitId)
    const objectStorage = await createPrivateCloudObjectStorage({
      organizationId,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      maxObjectBytes: config.maxObjectBytes,
      maxArtifactBytes,
      forcePathStyle: config.forcePathStyle,
      hotState,
      schemaManagement: config.schemaManagement,
      ...(sessionOwnership ? {
        prepareSessionOwner: async (sessionId: string) => { await sessionOwnership.ensure(sessionId) },
        resourceOwnerForSession: (sessionId: string) => sessionOwnership.activeLease(sessionId),
      } : {}),
    })
    // Recover failed uploads that occur after startup without scanning S3
    // globally. Each pass is tenant-scoped and bounded, and Unit close stops it.
    let sweeping = false
    orphanSweepTimer = setInterval(() => {
      if (closed || sweeping) return
      sweeping = true
      void objectStorage.reconcileOrphans()
        .catch((error: unknown) => console.warn('[private-cloud] orphan reconciliation failed', error))
        .finally(() => { sweeping = false })
    }, 60_000)
    orphanSweepTimer.unref()
    return {
      sessionAuthority: new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: config.schemaManagement,
        ...(sessionOwnership ? {
          unitId,
          resourceOwnerForSession: (sessionId: string) => sessionOwnership.activeLease(sessionId),
          prepareSessionOwner: async (sessionId: string) => { await sessionOwnership.ensure(sessionId) },
        } : {}),
      }),
      ...(sessionOwnership ? {
        assertSessionEffectOwner: async (sessionId: string) => {
          const owner = await sessionOwnership.ensure(sessionId)
          await hotState.database.transaction(async (transaction) => {
            await hotState.assertResourceOwnerForScope(transaction, {
              tenantId: organizationId, scopeType: 'session', scopeId: sessionId,
            }, owner)
          })
        },
      } : {}),
      objectStorage,
      memoStore: new PostgresMemoStore(tenantState),
      dagStore,
      scheduledTaskStore,
      workspaceAliasStore,
      executorInstallationStore,
      executorIdentityStore,
      pushStore: new PostgresPushSubscriptionStore(tenantState),
      vapidKeys,
      webSearchCredentialStore: new PostgresWebSearchCredentialStore(tenantState),
      speechCredentialStore: new PostgresAzureSpeechCredentialStore(tenantState),
      close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

async function directoryBytes(paths: readonly string[]): Promise<number> {
  let total = 0
  const pending = [...paths]
  while (pending.length > 0) {
    const path = pending.pop()!
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  }
  return total
}

async function createEnvironmentRuntimeProvider() {
  const llmApiKey = await readRequiredSecretEnv('KALA_RUNTIME_HOST_LLM_API_KEY')
  const model = required('KALA_RUNTIME_HOST_LLM_MODEL')
  const wire = process.env.KALA_RUNTIME_HOST_LLM_WIRE ?? 'openai'
  if (wire !== 'openai' && wire !== 'anthropic') throw new Error('KALA_RUNTIME_HOST_LLM_WIRE must be openai or anthropic')
  const baseUrl = required('KALA_RUNTIME_HOST_LLM_BASE_URL')
  const llm = await new ExplicitLLMClientFactory({ resolve: async () => llmApiKey }).create({ id: 'runtime-provider', wire, model, baseUrl, credentialRef: 'runtime-secret' })
  return { llm, models: [{ id: model, ref: model, providerId: wire, provider: wire, label: model }], defaultModel: model }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
