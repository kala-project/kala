#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { AGENT_RUNTIME_CAPABILITIES, FULL_RUNTIME_CAPABILITIES, PROTOCOL_VERSION, productVariant, type ServerSettingsPayload } from '@agent-kernel/shared'
import { createConfiguredSecretResolver } from '@agent-kernel/shared/secret-resolver'
import { createOnlineTelemetryFromEnv, type OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'

import { createScheduledPrincipalAuthorizer } from '../src/scheduled-tasks/authorization.js'
import { startLoopbackHostRuntimeUnit } from '../src/tenant-runtime/loopback-host-unit.js'
import { resolveBuiltinAgentModule } from '../src/builtin-tools.js'
import type { DashboardActor } from '../src/auth-control.js'
import type { SettingsWriteOptions } from '../src/settings-concurrency.js'
import { PostgresAgentPromptSettingsStore } from '../src/tenant-runtime/postgres-agent-settings.js'
import { loadRuntimeHooks } from '../src/tenant-runtime/runtime-hooks.js'
import { provisionRuntimeHooks } from '../src/tenant-runtime/runtime-hooks-provisioning.js'
import { ExplicitLLMClientFactory } from '../src/llm/client-factory.js'
import { DedicatedModelSettings } from '../src/llm/dedicated-model-settings.js'
import { ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, OrganizationModelSettings } from '../src/llm/organization-model-settings.js'
import { ModelPolicyClient, ModelPolicyUnavailable } from '../src/tenant-runtime/model-policy-client.js'
import { PostgresSettingsServingSet } from '../src/tenant-runtime/settings-serving-set.js'
import { RuntimeModelPolicyState } from '../src/tenant-runtime/model-policy-state.js'
import { RuntimeModelPolicyControl, type LoadedModelPolicySnapshot } from '../src/tenant-runtime/model-policy-control.js'
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
import { PostgresWorkspaceReferenceAuthority } from '../src/tenant-runtime/workspace-references.js'
import { LocalWebSearchCredentialStore, PostgresWebSearchCredentialStore } from '../src/web-search/credential-store.js'
import { KalaStateStore } from '../src/store/state-store.js'
import { LocalAzureSpeechCredentialStore, PostgresAzureSpeechCredentialStore } from '../src/speech/credential-store.js'
import { loadProductDeploymentConfig } from '../src/deployment-config.js'
import { UnitResourceGovernor } from '../src/tenant-runtime/resource-governor.js'
import type { TenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'
import { createPostgresHotStateStore } from '../src/tenant-runtime/postgres-hot-state.js'
import { PostgresSessionAuthority } from '../src/store/postgres-session-authority.js'
import { nativeFsLimitsFromEnv, type NativeFsLimits } from '../src/store/native-session-fs.js'
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
import { isPublicExecutorInstallAssetRequest } from '../src/http/executor-installation-routes.js'
import { initializePrivateCloudExperimentalStorageSchema } from '../src/store/postgres-private-cloud-storage.js'
import { checkPostgresSchemaVersion, initializeExperimentalRuntimeResourceOwnershipSchema, type PostgresSchemaManagement } from '../src/postgres-migrations.js'
import { assertPostgresInstallationClaim, assertS3InstallationClaim, createPostgresClaimPool, createS3ClaimClient } from '../src/storage/fresh-install-claim.js'
import { assertRecoveryCheckpoint, readPostgresRecoveryCheckpoint, readS3RecoveryCheckpoint, stateKeySha256 } from '../src/storage/recovery-checkpoint.js'
import packageJson from '../package.json' with { type: 'json' }

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const nativeFsLimits = nativeFsLimitsFromEnv(process.env)
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
  let verifiedInstallationId: string | undefined
  if (process.env.KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM !== undefined) {
    if (process.env.KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM !== '1' || !experimentalStorage || experimentalStorage.schemaManagement !== 'external') {
      throw new Error('Runtime installation claim requires externally migrated PostgreSQL/S3 storage')
    }
    const installationId = (await readFile(required('KALA_INSTALLATION_ID_FILE'), 'utf8')).trim()
    const pool = createPostgresClaimPool(experimentalStorage.connectionString, 'kala-runtime-startup-claim')
    const s3 = createS3ClaimClient(experimentalStorage)
    try {
      await assertPostgresInstallationClaim(pool, installationId, 'Runtime PostgreSQL')
      await assertS3InstallationClaim(s3, experimentalStorage.bucket, installationId)
      const pgCheckpoint = await readPostgresRecoveryCheckpoint(pool)
      const s3Checkpoint = await readS3RecoveryCheckpoint(s3, experimentalStorage.bucket)
      if (pgCheckpoint.installationId !== installationId || pgCheckpoint.keySha256 !== stateKeySha256(experimentalStateMasterKey!)) {
        throw new Error('Runtime recovery checkpoint does not match installation or state master key')
      }
      assertRecoveryCheckpoint(s3Checkpoint, pgCheckpoint, 'S3')
      verifiedInstallationId = installationId
    } finally {
      await pool.end()
      s3.destroy?.()
    }
  }
  // Private Cloud Runtime Units are operator-controlled. Match the Dedicated
  // binary's default while retaining an explicit opt-out.
  if (process.env.KALA_ALLOW_ALL_OK === undefined) process.env.KALA_ALLOW_ALL_OK = '1'
  const deployment = loadProductDeploymentConfig({ configPath: required('KALA_DEPLOYMENT_CONFIG') })
  const product = productVariant(deployment)
  if (product !== 'private-cloud' && product !== 'dedicated') {
    throw new Error('Runtime service requires a Platform deployment config')
  }
  // Fresh Aspire Dedicated is never permitted to fall back to a local Unit
  // tree. The existing systemd installer does not launch this service binary.
  if (product === 'dedicated' && (!experimentalStorage || experimentalStorage.schemaManagement !== 'external'
    || process.env.KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM !== '1')) {
    throw new Error('Dedicated Runtime requires operator-migrated PostgreSQL/S3 and a verified installation claim')
  }
  const capabilities = deployment.runtimeProfile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES
  // Created after installation/recovery bootstrap checks: this instance covers
  // online Runtime PG/S3 traffic, while bootstrap clients remain intentionally separate.
  const telemetry = createOnlineTelemetryFromEnv('kala-runtime')
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
        telemetry,
      })
    : new RuntimeUnitMaterializationStore(join(dataRoot, 'host', 'runtime-unit-catalog.json'))
  await catalog.load()
  if (product === 'dedicated' && catalog.list().filter((unit) => unit.desiredState !== 'deleted').length > 1) {
    throw new Error('Dedicated Runtime catalog has more than one active logical Unit')
  }
  const placementStore = experimentalStorage
    ? createPostgresRuntimeUnitPlacementStore({
        connectionString: experimentalStorage.connectionString,
        applicationName: `kala-runtime-placement-${experimentalStorage.nodeId}`,
        telemetry,
      })
    : undefined
  if (experimentalStorage?.schemaManagement !== 'external') await placementStore?.initialize()
  const replicaStore = experimentalStorage
    ? createPostgresRuntimeResourceOwnershipStore({
        connectionString: experimentalStorage.connectionString,
        applicationName: `kala-runtime-replica-${experimentalStorage.nodeId}`,
        telemetry,
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
        operationTimeoutMs: Math.min(10_000, Math.floor(experimentalStorage.placementTtlMs / 3)),
      })
    : undefined
  const placementOwnership = placementStore && experimentalStorage
    ? new PostgresRuntimeUnitPlacementOwnership(placementStore, {
        nodeId: experimentalStorage.nodeId,
        origin: experimentalStorage.nodeOrigin,
        ttlMs: experimentalStorage.placementTtlMs,
        operationTimeoutMs: Math.min(10_000, Math.floor(experimentalStorage.placementTtlMs / 3)),
      })
    : undefined
  const catalogPath = process.env.KALA_RUNTIME_HOST_LLM_CATALOG_FILE?.trim()
  const runtimeCatalog = catalogPath ? await loadRuntimeProviderCatalog(catalogPath) : undefined
  const providerSecrets = createConfiguredSecretResolver(process.env)
    ?? new FileSecretResolver(process.env.KALA_RUNTIME_HOST_SECRET_ROOT ?? '/run/kala-secrets')
  const runtimeProvider = runtimeCatalog
    ? product === 'dedicated' ? {
        llm: { name: 'dedicated-models-not-loaded', call: async () => { throw new Error('Dedicated model settings have not loaded') } },
        models: [],
        defaultModel: runtimeCatalog.defaultModel,
      } : await createRuntimeProviderRuntime(
        runtimeCatalog,
        new ExplicitLLMClientFactory(providerSecrets),
      )
    : await createEnvironmentRuntimeProvider()
  const modelPolicyClient = product === 'private-cloud' && verifiedInstallationId
    ? new ModelPolicyClient({ installationId: verifiedInstallationId, origin: required('KALA_RUNTIME_AUTHORITY_ORIGIN'), serviceSecret: ingressSecret })
    : undefined
  const operationalPolicyClient = modelPolicyClient ?? (verifiedInstallationId && process.env.KALA_RUNTIME_AUTHORITY_ORIGIN
    ? new ModelPolicyClient({ installationId: verifiedInstallationId, origin: process.env.KALA_RUNTIME_AUTHORITY_ORIGIN, serviceSecret: ingressSecret })
    : undefined)
  const modelPolicyStore = verifiedInstallationId && experimentalStorage
    ? createPostgresHotStateStore({ connectionString: experimentalStorage.connectionString, applicationName: 'kala-runtime-settings-control', telemetry })
    : undefined
  const modelPolicyConsumers = new Map<string, () => Promise<LoadedModelPolicySnapshot>>()
  const settingsServingProbes = new Map<string, () => Promise<void>>()
  replicaMembership?.setObservationHandler(async id => { await settingsServingProbes.get(id)?.() })
  let modelPolicyControl: RuntimeModelPolicyControl | undefined
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
    maxLoadedUnits: product === 'dedicated' ? 1 : Number(process.env.KALA_RUNTIME_HOST_MAX_LOADED_UNITS ?? 100),
    countsTowardCapacity: (unitId) => unitId !== publicInstallerUnitId,
    beforeRoutable: async (unitId, organizationId) => {
      if (unitId !== publicInstallerUnitId) await modelPolicyControl?.beforeRoutable(unitId, organizationId)
    },
    ...(experimentalStorage ? { catalog } : {}),
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
      if (value === publicInstallerUnitId) return releaseAssetsDir && isPublicExecutorInstallAssetRequest(request) ? value : undefined
      return typeof value === 'string' ? value : undefined
    },
    factory: async (id) => {
      // The read-only public installer route is not a tenant Unit and carries no
      // Session/Queue authority; it must not consume Dedicated's single Unit slot.
      if (product === 'dedicated' && id !== publicInstallerUnitId) {
        const active = catalog.list().filter((unit) => unit.desiredState !== 'deleted')
        if (active.length !== 1 || active[0]?.unitId !== id) {
          throw new Error('Dedicated Runtime accepts only its one provisioned logical Unit')
        }
      }
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
      if (process.env.KALA_RUNTIME_HOOKS_MANIFEST && process.env.KALA_RUNTIME_HOOKS_CONFIG) {
        throw new Error('KALA_RUNTIME_HOOKS_MANIFEST and KALA_RUNTIME_HOOKS_CONFIG are mutually exclusive')
      }
      const provisionedHooks = process.env.KALA_RUNTIME_HOOKS_MANIFEST && organizationId && id !== publicInstallerUnitId
        ? provisionRuntimeHooks({ unitRoot, unitId: id, organizationId, manifestPath: process.env.KALA_RUNTIME_HOOKS_MANIFEST })
        : undefined
      if (process.env.KALA_RUNTIME_HOOKS_MANIFEST && !organizationId && id !== publicInstallerUnitId) {
        throw new Error('Runtime hook provisioning requires a trusted organization/Unit binding')
      }
      const runtimeHooks = loadRuntimeHooks({ unitRoot, product, ...(id !== publicInstallerUnitId && process.env.KALA_RUNTIME_HOOKS_CONFIG ? { configPath: process.env.KALA_RUNTIME_HOOKS_CONFIG } : {}) })
      const sessionOwnership = sessionOwnershipFlag === '1' && replicaStore && replicaMembership && organizationId && experimentalStorage
        ? new RuntimeSessionOwnership(organizationId, id, replicaMembership,
            new RuntimeResourceOwnershipManager(replicaStore, {
              ttlMs: experimentalStorage.placementTtlMs,
              operationTimeoutMs: Math.min(10_000, Math.floor(experimentalStorage.placementTtlMs / 3)),
            }),
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
            placementLease, maxArtifactBytes, telemetry, nativeFsLimits, sessionOwnership, replicaStore)
        : undefined
      const agentSettings = persistentStorage?.agentSettings
      const modelPolicy = modelPolicyClient && organizationId && id !== publicInstallerUnitId
        ? await modelPolicyClient.read(organizationId, id).catch(async error => { await persistentStorage?.close(); throw error }) : undefined
      const modelPolicyState = modelPolicy && persistentStorage && verifiedInstallationId
        ? new RuntimeModelPolicyState({ installationId: verifiedInstallationId, state: persistentStorage.tenantState,
          unitId: id, policy: modelPolicyClient!, operatorModelReferences: runtimeProvider.models.map(model => model.ref ?? model.id) })
        : undefined
      if (modelPolicy && !modelPolicyState) throw new ModelPolicyUnavailable('model_policy_storage_unavailable')
      const modelSettings = product === 'dedicated' && persistentStorage && organizationId && runtimeCatalog
        ? new DedicatedModelSettings(persistentStorage.tenantState, organizationId, runtimeCatalog, providerSecrets)
        : modelPolicy?.effectiveManagement === 'dashboard' && modelPolicyState && persistentStorage && organizationId
          ? new OrganizationModelSettings(persistentStorage.tenantState, organizationId, {
            assertCallAllowed: () => modelPolicyState.assertSnapshot(modelPolicy),
            assertMutationAllowed: tx => modelPolicyState.assertSnapshot(modelPolicy, tx),
            assertInitializationAllowed: async () => { throw new ModelPolicyUnavailable('organization_catalog_reconciliation_required') },
          }) : undefined
      try {
        if (modelPolicy && modelPolicyState) await modelPolicyState.assertSnapshot(modelPolicy, undefined, true)
        await modelSettings?.load()
      } catch (error) {
        await modelSettings?.close().catch(() => undefined)
        await persistentStorage?.close().catch(() => undefined)
        throw error
      }
      const unitProvider = !modelSettings && product === 'dedicated' && runtimeCatalog && id !== publicInstallerUnitId
        ? await createRuntimeProviderRuntime(runtimeCatalog, new ExplicitLLMClientFactory(providerSecrets))
        : runtimeProvider
      const currentModels = () => modelSettings?.models ?? unitProvider.models
      const currentDefaultModel = () => modelSettings ? modelSettings.defaultModel : unitProvider.defaultModel
      const policyLoadedAt = new Date().toISOString()
      const consumer = modelPolicy && persistentStorage ? async (): Promise<LoadedModelPolicySnapshot> => ({
        policyRevision: modelPolicy.effectiveRevision, management: modelPolicy.effectiveManagement,
        catalogRevision: modelSettings ? modelSettings.effectiveRevision ?? '0'
          : await persistentStorage.tenantState.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, async tx =>
            await persistentStorage.tenantState.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
              ? await persistentStorage.tenantState.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) ?? '0' : '0'),
        synchronization: modelSettings?.synchronization ?? 'ready', observedAt: modelSettings?.observationTime ?? policyLoadedAt,
      }) : undefined
      if (consumer) modelPolicyConsumers.set(id, consumer)
      let currentAgentSettings = persistentStorage?.initialAgentSettings
      const assertActorOrganization = (actor?: DashboardActor): void => {
        if (actor?.kind === 'ingress' && actor.organizationId !== organizationId) {
          throw Object.assign(new Error('tenant_forbidden'), { status: 403 })
        }
      }
      const refreshAgentSettings = async (actor?: DashboardActor) => {
        assertActorOrganization(actor)
        currentAgentSettings = await agentSettings?.load()
        return currentAgentSettings
      }
      const currentAgentModule = () => {
        const settings = currentAgentSettings
        return settings
          ? resolveBuiltinAgentModule({
              systemPrompt: settings.slots.find((slot) => slot.id === settings.selectedSlotId)!.prompt,
              desktopManualAuthorizationRequired: settings.desktopManualAuthorizationRequired ?? false,
              computerUseEnabled: settings.computerUseEnabled ?? false,
            })
          : agentModule
      }
      const resourceArtifactUsage = persistentStorage
        ? persistentStorage.objectStorage.resourceArtifactUsage
        : async () => await directoryBytes([
            join(unitRoot, 'artifacts'),
            join(unitRoot, 'session-artifacts'),
            join(unitRoot, 'message-attachments'),
          ])
      const makeSettings = async (actor: DashboardActor): Promise<ServerSettingsPayload> => {
        if (modelPolicy && modelPolicyState) await modelPolicyState.assertSnapshot(modelPolicy)
        const prompt = await refreshAgentSettings(actor)
        const objectUsage = await persistentStorage?.objectStorage.resourceArtifactUsageSnapshot()
        const [identities, invites] = persistentStorage
          ? await Promise.all([persistentStorage.executorIdentityStore.snapshot(), persistentStorage.executorIdentityStore.inviteSnapshot()])
          : [[], []]
        return {
          providers: modelSettings?.providers ?? runtimeCatalog?.providers.map(provider => ({
            id: provider.id, label: provider.label ?? provider.id, wire: provider.wire, baseUrl: provider.baseUrl,
            models: currentModels().filter(model => model.providerId === provider.id),
          })) ?? [],
          defaultModel: currentDefaultModel() ?? '', hooks: runtimeHooks.hooks.map(({ event, command, match }) => ({ event, command, ...(match ? { match } : {}) })),
          modelConfiguration: modelSettings ? { management: 'dashboard' } : { management: 'operator', ...(catalogPath ? { providerCatalogPath: catalogPath } : {}) },
          versions: { host: packageJson.version, protocol: PROTOCOL_VERSION },
          agentModule: currentAgentModule().metadata,
          ...(prompt && agentSettings ? { agentPrompt: { ...prompt, configPath: agentSettings.configPath } } : {}),
          ...(prompt && agentSettings ? { desktopAccess: { manualAuthorizationRequired: prompt.desktopManualAuthorizationRequired ?? false,
            computerUseEnabled: prompt.computerUseEnabled ?? false, desktopPreviewEnabled: prompt.desktopPreviewEnabled ?? false } } : {}),
          ...(actor.kind === 'ingress' ? {
            auth: {
              dashboardAuthRequired: true,
              githubOAuth: { required: false, configured: false, usernameWhitelistEnabled: false, usernameWhitelist: [] },
              executorIdentity: { tokenScoped: true, tokenCount: identities.length, inviteCount: invites.filter((invite) => !invite.revoked).length },
            },
          } : {}),
          mcp: { supported: false, note: 'MCP availability is resolved by the Runtime.' },
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: runtimeHooks.configPath, sessionsDir: join(unitRoot, 'sessions') },
          ...(objectUsage && organizationId ? {
            storage: {
              kind: 'postgres-s3' as const,
              organizationId,
              objectBytes: objectUsage.storedBytes + objectUsage.reservedBytes,
              objectLimitBytes: maxArtifactBytes,
              usage: objectUsage,
            },
          } : {}),
          ...(releaseAssetsDir ? { release: { bootstrapBaseUrl: '/release-assets', source: 'local' as const } } : {}),
        }
      }
      resourceGovernor.reconcile(id, { artifactBytes: await resourceArtifactUsage() })
      const webSearchCredentialStore = persistentStorage?.webSearchCredentialStore ?? localWebSearchCredentialStore
      const speechCredentialStore = persistentStorage?.speechCredentialStore ?? localSpeechCredentialStore
      const settingsServingSet = persistentStorage && organizationId && replicaMembership ? new PostgresSettingsServingSet({
        database: persistentStorage.tenantState.database, organizationId, unitId: id,
        membership: () => replicaMembership.activeLease(id, organizationId),
      }) : undefined
      let publishSettings = async (): Promise<void> => undefined
      let stopModelObservation: (() => void) | undefined
      let observationTail = Promise.resolve(), observerClosed = false
      const unit = await startLoopbackHostRuntimeUnit(id, {
        telemetry,
        ...(settingsServingSet ? { settingsServingSet, onAgentApplicationChange: () => { void publishSettings().catch(() => undefined) } } : {}),
        hooks: runtimeHooks.hooks,
        hookRunner: runtimeHooks.hookRunner,
        requireIngressIdentity: true,
        ...(operationalPolicyClient && organizationId && id !== publicInstallerUnitId ? {
          executorAdmission: async (executor: { executorId: string; workspaceId: string; enrollmentHash?: string }) => {
            if (!(await operationalPolicyClient.executor(organizationId, id, executor)).admitted) {
              throw new ModelPolicyUnavailable('executor_resource_admission_denied')
            }
          },
        } : {}),
        ...(organizationId ? { executorManagementOrganizationId: organizationId } : {}),
        authorizeScheduledPrincipal: createScheduledPrincipalAuthorizer({
          origin: process.env.KALA_RUNTIME_AUTHORITY_ORIGIN,
          serviceSecret: ingressSecret,
          unitId: id,
        }),
        sessionsDir: join(unitRoot, 'sessions'),
        ...(releaseAssetsDir && id === publicInstallerUnitId ? { copilot: { enabled: false } } : {}),
        // Trace/message-assembly captures currently write only to the local
        // artifact tree; do not publish disposable captures in PG/S3 mode.
        artifactRootDir: persistentStorage ? false : join(unitRoot, 'artifacts'),
        ...(persistentStorage ? {
          sessionAuthority: persistentStorage.sessionAuthority,
          ...(sessionOwnership ? { requireArenaEffectBarrier: true } : {}),
          ...(sessionOwnership ? { requireSkillEffectBarrier: true } : {}),
          ...(persistentStorage.registerSkillEffect ? {
            registerSkillEffect: persistentStorage.registerSkillEffect,
            beginSkillDispatch: persistentStorage.beginSkillDispatch,
            releaseNeverDispatchedSkillEffect: persistentStorage.releaseNeverDispatchedSkillEffect,
          } : {}),
          ...(persistentStorage.registerMemoryEffect ? {
            registerMemoryEffect: persistentStorage.registerMemoryEffect,
            beginMemoryDispatch: persistentStorage.beginMemoryDispatch,
          } : {}),
          ...(persistentStorage.backgroundLearningJobs ? {
            backgroundLearningJobs: persistentStorage.backgroundLearningJobs,
          } : {}),
          ...(persistentStorage.registerArenaEffect ? { registerArenaEffect: persistentStorage.registerArenaEffect } : {}),
          ...(persistentStorage.releaseNeverDispatchedArenaEffect ? {
            releaseNeverDispatchedArenaEffect: persistentStorage.releaseNeverDispatchedArenaEffect,
            beginArenaDispatch: persistentStorage.beginArenaDispatch,
          } : {}),
          ...(persistentStorage.claimArenaRepository ? { claimArenaRepository: persistentStorage.claimArenaRepository } : {}),
          ...(persistentStorage.assertSessionEffectOwner ? {
            assertSessionEffectOwner: persistentStorage.assertSessionEffectOwner,
            captureSessionEffectOwner: persistentStorage.captureSessionEffectOwner,
            chooseChildReplicaId: persistentStorage.chooseChildReplicaId,
            handoffChildOwner: persistentStorage.handoffChildOwner,
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
          closeResource: async () => {
            observerClosed = true
            stopModelObservation?.()
            if (settingsServingProbes.get(id) === publishSettings) settingsServingProbes.delete(id)
            await observationTail.catch(() => undefined)
            if (settingsServingSet) {
              await Promise.allSettled(['models', 'agent'].map(kind => settingsServingSet.publish(
                { kind, id: kind === 'models' ? 'catalog' : 'runtime' }, { revision: null, synchronization: 'disconnected' })))
            }
            if (modelPolicyConsumers.get(id) === consumer) modelPolicyConsumers.delete(id)
            await modelSettings?.close(); await persistentStorage.close()
          },
        } : {}),
        ...(!persistentStorage && id !== publicInstallerUnitId ? {
          workspaceDir,
          executorIdentityStorePath: join(unitRoot, 'executor-identities.json'),
        } : {}),
        llm: modelSettings?.llm ?? (modelPolicy && modelPolicyState ? {
          name: 'policy-fenced-operator-models',
          call: async params => { await modelPolicyState.assertSnapshot(modelPolicy); return unitProvider.llm.call(params) },
        } : unitProvider.llm),
        defaultConfig: () => currentAgentModule().config,
        ...(agentSettings ? {
          desktopFeaturePolicy: (actor?: DashboardActor) => {
            assertActorOrganization(actor)
            return { computerUseEnabled: currentAgentSettings?.computerUseEnabled ?? false, desktopPreviewEnabled: currentAgentSettings?.desktopPreviewEnabled ?? false }
          },
          desktopManualAuthorizationRequired: (actor?: DashboardActor) => {
            assertActorOrganization(actor)
            return currentAgentSettings?.desktopManualAuthorizationRequired ?? false
          },
          resolveSystemPrompt: async (actor?: DashboardActor) => {
            await refreshAgentSettings(actor)
            return currentAgentModule().systemPrompt
          },
          updateAgentPrompt: async (input: Parameters<typeof agentSettings.save>[0], actor: DashboardActor, write?: SettingsWriteOptions) => {
            assertActorOrganization(actor)
            await agentSettings.update((current) => ({ ...current, ...input, desktopManualAuthorizationRequired: current.desktopManualAuthorizationRequired ?? false,
              computerUseEnabled: current.computerUseEnabled ?? false, desktopPreviewEnabled: current.desktopPreviewEnabled ?? false }), write)
            return makeSettings(actor)
          },
          updateDesktopAccess: async (input: { manualAuthorizationRequired: boolean; computerUseEnabled?: boolean; desktopPreviewEnabled?: boolean }, actor: DashboardActor, write?: SettingsWriteOptions) => {
            assertActorOrganization(actor)
            await agentSettings.update((current) => ({ ...current, desktopManualAuthorizationRequired: input.manualAuthorizationRequired,
              computerUseEnabled: input.computerUseEnabled ?? current.computerUseEnabled ?? false,
              desktopPreviewEnabled: input.desktopPreviewEnabled ?? current.desktopPreviewEnabled ?? false }), write)
            return makeSettings(actor)
          },
        } : {}),
        ...(modelSettings ? {
          onModelCatalogChange: (listener) => modelSettings.onChange(listener),
          addManualProvider: async (input, actor, write) => { await modelSettings.addProvider(input, actor, write); return makeSettings(actor) },
          updateManualProvider: async (input, actor, write) => { await modelSettings.updateProvider(input, actor, write); return makeSettings(actor) },
          deleteManualProvider: async (input, actor, write) => { await modelSettings.deleteProvider(input, actor, write); return makeSettings(actor) },
          addManualModel: async (input, actor, write) => { await modelSettings.addModel(input, actor, write); return makeSettings(actor) },
          updateManualModel: async (input, actor, write) => { await modelSettings.updateModel(input, actor, write); return makeSettings(actor) },
          deleteManualModel: async (input, actor, write) => { await modelSettings.deleteModel(input, actor, write); return makeSettings(actor) },
          setDefaultModel: async (input, actor, write) => { await modelSettings.setDefault(input, actor, write); return makeSettings(actor) },
        } : {}),
        ...(agentSettings && organizationId ? {
          onAgentSettingsChange: (listener, onState) => agentSettings.subscribe(
            () => listener({ kind: 'ingress', principal: 'system', organizationId, role: 'admin' }), onState),
        } : {}),
        models: currentModels,
        defaultModel: currentDefaultModel,
        settingsRevision: async (resource, actor) => {
          assertActorOrganization(actor)
          if (resource === 'models') return modelSettings?.desiredRevision()
          if (resource === 'agent') return agentSettings?.revision()
          return undefined
        },
        deployment,
        capabilities,
        webSearchCredentials: webSearchCredentialStore,
        webSearchCredentialStatus: () => webSearchCredentialStore.status(),
        webSearchCredentialConfiguration: () => webSearchCredentialStore.configuration(),
        setWebSearchCredential: (provider, key, write) => webSearchCredentialStore.set(provider, key, write),
        deleteWebSearchCredential: (provider, write) => webSearchCredentialStore.delete(provider, write),
        speechCredentials: speechCredentialStore,
        stateStore,
        resourceGovernor,
        resourceUnitId: id,
        resourceArtifactUsage,
        ...(dashboardDir ? { staticDir: resolve(dashboardDir) } : {}),
        ...(docsDir ? { docsRootDir: resolve(docsDir) } : {}),
        ...(releaseAssetsDir ? { releaseAssetsDir: resolve(releaseAssetsDir) } : {}),
        settings: makeSettings,
        assertSettingsReady: async actor => {
          assertActorOrganization(actor)
          if (modelPolicy && modelPolicyState) await modelPolicyState.assertSnapshot(modelPolicy)
        },
        settingsConfiguration: async (section, actor) => {
          assertActorOrganization(actor)
          if (modelPolicy && modelPolicyState) await modelPolicyState.assertSnapshot(modelPolicy)
          if (section === 'models' && modelSettings) {
            const snapshot = await modelSettings.configuration()
            const manager = actor.kind === 'ingress' && ['owner', 'admin'].includes(actor.role)
            const membership = organizationId ? replicaMembership?.activeLease(id, organizationId) : undefined
            return {
              resource: { kind: 'models', id: 'catalog', ...(organizationId ? { organizationId } : {}) },
              revision: snapshot.revision, capabilities: [],
              value: { providers: snapshot.providers.map((provider) => {
                if (manager) return provider
                const { baseUrl: _baseUrl, ...publicProvider } = provider
                return publicProvider
              }), defaultModel: snapshot.defaultModel, modelConfiguration: { management: 'dashboard' } },
              application: { state: 'unknown', desiredRevision: snapshot.revision,
                effectiveRevision: modelSettings.effectiveRevision, applyMode: 'immediate', scope: 'unit',
                reasonCode: 'local_replica_observation_only',
                observations: membership ? [{
                  unitId: id, replicaId: membership.replicaId, revision: modelSettings.effectiveRevision,
                  observedAt: modelSettings.observationTime, synchronization: modelSettings.synchronization,
                }] : [],
              },
            }
          }
          if ((section === 'agent' || section === 'execution') && agentSettings) {
            const snapshot = await agentSettings.configuration()
            const prompt = snapshot.value
            return {
              resource: { kind: 'agent', id: 'runtime', ...(organizationId ? { organizationId } : {}) },
              revision: snapshot.revision, capabilities: [],
              value: section === 'agent'
                ? { agentPrompt: { ...prompt, configPath: agentSettings.configPath } }
                : { agentSettingsResourceId: agentSettings.configPath, desktopAccess: {
                  manualAuthorizationRequired: prompt.desktopManualAuthorizationRequired ?? false,
                  computerUseEnabled: prompt.computerUseEnabled ?? false, desktopPreviewEnabled: prompt.desktopPreviewEnabled ?? false,
                } },
              application: { state: 'unknown', desiredRevision: snapshot.revision, effectiveRevision: null,
                applyMode: 'next-turn', scope: 'unit', reasonCode: 'session_application_not_observed',
                observations: organizationId && replicaMembership?.activeLease(id, organizationId) ? [{
                  unitId: id, replicaId: replicaMembership.activeLease(id, organizationId)!.replicaId,
                  revision: null, observedAt: new Date().toISOString(), synchronization: 'synchronizing',
                }] : [],
              },
            }
          }
          return undefined
        },
        settingsSection: async (section, actor) => {
          assertActorOrganization(actor)
          if (section === 'models') {
            const manager = actor.kind === 'ingress' && ['owner', 'admin'].includes(actor.role)
            return {
              providers: manager ? modelSettings?.providers ?? runtimeCatalog?.providers.map(provider => ({
                id: provider.id, label: provider.label ?? provider.id, wire: provider.wire, baseUrl: provider.baseUrl,
                models: currentModels().filter(model => model.providerId === provider.id),
              })) ?? [] : runtimeCatalog?.providers.map(provider => ({
                id: provider.id, label: provider.label ?? provider.id, wire: provider.wire,
                models: currentModels().filter(model => model.providerId === provider.id),
              })) ?? [],
              defaultModel: currentDefaultModel(),
              modelConfiguration: modelSettings ? { management: 'dashboard' } : { management: 'operator' },
            }
          }
          if (section === 'agent' || section === 'execution') {
            const prompt = await refreshAgentSettings(actor)
            return section === 'agent'
              ? { agentModule: currentAgentModule().metadata, ...(prompt && agentSettings ? { agentPrompt: { ...prompt, configPath: agentSettings.configPath } } : {}) }
              : { ...(prompt && agentSettings ? { agentSettingsResourceId: agentSettings.configPath, desktopAccess: { manualAuthorizationRequired: prompt.desktopManualAuthorizationRequired ?? false,
                computerUseEnabled: prompt.computerUseEnabled ?? false, desktopPreviewEnabled: prompt.desktopPreviewEnabled ?? false } } : {}) }
          }
          if (section === 'hooks') return {
            hooksSummary: { sourceRef: provisionedHooks ? 'mounted-unit-hooks-manifest' : 'runtime-hooks',
              loadState: 'loaded', events: runtimeHooks.hooks.map(({ event }) => event),
              loadedAt: runtimeHooks.loadedAt, ...(provisionedHooks ? { version: provisionedHooks.revision } : {}), applyMode: 'restart' },
          }
          if (section === 'storage') {
            const usage = await persistentStorage?.objectStorage.resourceArtifactUsageSnapshot()
            return usage && organizationId ? { storage: { kind: 'postgres-s3', organizationId,
              objectBytes: usage.storedBytes + usage.reservedBytes, objectLimitBytes: maxArtifactBytes, usage } } : {}
          }
          if (section === 'services') {
            const observedAt = new Date().toISOString()
            return { versions: { host: packageJson.version, protocol: PROTOCOL_VERSION }, configurationSources: [
              { id: 'models', sourceRef: modelSettings ? 'runtime.encrypted-tenant-model-catalog' : 'deployment.operator-model-catalog',
                management: modelSettings ? 'dashboard' : 'protected-maintenance',
                revision: modelSettings ? await modelSettings.desiredRevision() ?? null : null,
                effectiveRevision: modelSettings?.effectiveRevision ?? null, observedAt,
                ...(!modelSettings ? { maintenance: 'runtime-operator' as const } : {}) },
              { id: 'agent', sourceRef: agentSettings ? 'runtime.postgres-agent-settings' : 'runtime.unit-agent-settings',
                management: 'dashboard', revision: await agentSettings?.revision() ?? null,
                effectiveRevision: null, observedAt },
              { id: 'credentials', sourceRef: persistentStorage ? 'runtime.encrypted-postgres' : 'runtime.encrypted-sqlite',
                management: 'protected-maintenance', revision: null, effectiveRevision: null, observedAt },
              { id: 'hooks', sourceRef: 'runtime.loaded-protected-hooks', management: 'protected-maintenance',
                revision: null, effectiveRevision: null, observedAt },
            ] }
          }
          if (section === 'integrations') return { integrationStatus: [
            { id: 'secrets', component: 'runtime', configured: true, health: 'unknown',
              sourceRef: persistentStorage ? 'organization-encrypted-postgres' : 'unit-encrypted-sqlite',
              observedAt: new Date().toISOString(), reasonCode: 'authority_installed_health_not_probed' },
          ] }
          return {}
        },
      })
      if (settingsServingSet) {
        publishSettings = () => {
          const task = observationTail.catch(() => undefined).then(async () => {
            if (observerClosed) return
            if (modelSettings) await settingsServingSet.publish({ kind: 'models', id: 'catalog' }, {
              revision: modelSettings.effectiveRevision, synchronization: modelSettings.synchronization,
            })
            if (agentSettings) {
              const revision = await agentSettings.revision()
              if (revision) await settingsServingSet.publish({ kind: 'agent', id: 'runtime' },
                unit.server.agentSettingsObservation(revision, organizationId))
            }
          })
          observationTail = task
          return task
        }
        settingsServingProbes.set(id, publishSettings)
        stopModelObservation = modelSettings?.onObservationChange(() => { void publishSettings().catch(() => undefined) })
        await publishSettings()
      }
      return unit
    },
  })
  if (modelPolicyClient && modelPolicyStore && verifiedInstallationId && experimentalStateMasterKey && replicaMembership && replicaStore) {
    modelPolicyControl = new RuntimeModelPolicyControl({ installationId: verifiedInstallationId,
      database: modelPolicyStore.database, masterKey: experimentalStateMasterKey, policy: modelPolicyClient,
      catalog, service: host, membership: replicaMembership, replicas: replicaStore,
      operatorModelReferences: runtimeProvider.models.map(model => model.ref ?? model.id),
      operatorCatalogRevision: createHash('sha256').update(JSON.stringify(runtimeCatalog ?? runtimeProvider.models)).digest('hex'),
      loadedSnapshot: async unitId => await modelPolicyConsumers.get(unitId)?.(),
    })
  }
  if (experimentalStorage) {
    // Node readiness is not tenant availability. Recover eligible Units from
    // bounded authoritative pages continuously, including after live lease loss.
    await host.reconcile()
  } else {
    for (const entry of catalog.list()) {
      if (entry.desiredState !== 'ready') continue
      try {
        await host.markRoutable(entry.unitId, placementOwnership ? await trustedOrganizationId(catalog, entry.unitId) : undefined)
      } catch (error) {
        if (!(error instanceof RuntimeUnitPlacementHeldError)) throw error
        process.stderr.write(`${JSON.stringify({ event: 'tenant_runtime_unit_placement_held', unitId: entry.unitId, currentNodeId: error.currentNodeId })}\n`)
      }
    }
  }
  if (releaseAssetsDir) await host.markRoutable(publicInstallerUnitId)
  attachTenantRuntimeControlApi({ http: host.http, serviceSecret: ingressSecret, service: host, store: catalog, dataRoot, capabilities,
    modelPolicy: modelPolicyControl,
    ...(modelPolicyStore && verifiedInstallationId ? { workspaceReferences: new PostgresWorkspaceReferenceAuthority({
      database: modelPolicyStore.database, installationId: verifiedInstallationId, policy: operationalPolicyClient,
    }) } : {}),
  })
  process.stdout.write(`${JSON.stringify({ event: 'tenant_runtime_service_ready', port: host.port, dataRoot })}\n`)
  let shuttingDown: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      let exitCode = 0
      try {
        try { await host.drain() } finally { await host.close() }
      } catch (error) {
        exitCode = 1
        process.stderr.write(`${JSON.stringify({ event: 'tenant_runtime_shutdown_failed', reason: error instanceof Error ? error.name : 'unknown' })}\n`)
      } finally {
        await Promise.allSettled([catalog.close(), placementStore?.close() ?? Promise.resolve(), replicaStore?.close() ?? Promise.resolve(),
          modelPolicyStore?.close() ?? Promise.resolve()])
        await telemetry?.close()
      }
      process.exit(exitCode)
    })()
    return shuttingDown
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
    || EXPERIMENTAL_STORAGE_SECRET_ENV.some((name) => process.env[name] !== undefined || process.env[`${name}_FILE`] !== undefined || process.env[`${name}_REF`] !== undefined)
  if (enabled === undefined && !configured) return undefined
  if (enabled !== '1') {
    throw new Error(`${EXPERIMENTAL_STORAGE_FLAG}=1 is required when experimental DB/S3 storage is configured`)
  }
  const values = Object.fromEntries(EXPERIMENTAL_STORAGE_ENV.map((name) => [name, required(name)]))
  const connectionString = await readRequiredSecretEnv('KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING')
  const accessKeyId = await readRequiredSecretEnv('KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID')
  const secretAccessKey = await readRequiredSecretEnv('KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY')
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
  const placementTtlMs = Number(process.env.KALA_RUNTIME_EXPERIMENTAL_PLACEMENT_TTL_MS ?? 45_000)
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
  telemetry: OnlineTelemetry | undefined,
  nativeFsLimits: Readonly<NativeFsLimits>,
  sessionOwnership?: RuntimeSessionOwnership,
  replicaStore?: ReturnType<typeof createPostgresRuntimeResourceOwnershipStore>,
) {
  const hotState = createPostgresHotStateStore({
    connectionString: config.connectionString,
    applicationName: `kala-runtime-experimental-${organizationId}`,
    placementLease,
    telemetry,
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
    const agentSettings = new PostgresAgentPromptSettingsStore(hotState.database, organizationId)
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
    if (config.schemaManagement !== 'external') {
      await tenantState.initializeSchema()
      await agentSettings.initializeSchema()
    }
    const initialAgentSettings = await agentSettings.load()
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
      ...(placementLease.protocol !== 'parallel-v1' ? { unitPlacement: placementLease } : {}),
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
      telemetry,
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
    const activeReplicaId = sessionOwnership?.membership.activeLease(unitId, organizationId)?.replicaId
    if (sessionOwnership && !activeReplicaId) throw new Error('Child routing requires a live local replica membership')
    return {
      sessionAuthority: new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: config.schemaManagement,
        nativeFsLimits,
        ...(sessionOwnership ? {
          unitId,
          resourceOwnerForSession: (sessionId: string) => sessionOwnership.activeLease(sessionId),
          prepareSessionOwner: async (sessionId: string) => { await sessionOwnership.ensure(sessionId) },
          localReplicaId: activeReplicaId,
        } : {}),
      }),
      ...(sessionOwnership ? {
        captureSessionEffectOwner: (sessionId: string) => sessionOwnership.captureEffectFence(sessionId),
        claimArenaRepository: async (sessionId: string, generation: string, repositoryIdentity: string, arenaId: string) => {
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Arena owner generation changed')
          await replicaStore.claimArenaRepository(owner, repositoryIdentity, arenaId)
        },
        prepareArenaInitEffect: async (
          sessionId: string, generation: string, callId: string, workspaceId: string,
          repositoryIdentity: string, arenaId: string,
        ) => {
          if (!/^arena-init-[A-Z0-9]+$/u.test(callId)) throw new Error('Unsupported Arena init effect')
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Arena init owner changed')
          await replicaStore.prepareArenaInitEffect(owner, callId, workspaceId, repositoryIdentity, arenaId)
          return async () => await replicaStore.completeWorkspaceEffect(owner, callId)
        },
        registerArenaEffect: async (
          sessionId: string, generation: string, callId: string, workspaceId: string,
          repositoryIdentity?: string, arenaId?: string,
        ) => {
          if (!/^arena-(probe|status|diff|init|apply|cleanup)-[A-Z0-9]+$/u.test(callId)) throw new Error('unsupported Arena effect')
          if (!workspaceId || workspaceId.trim() !== workspaceId) throw new Error('Arena workspace identity is required')
          if (!callId.startsWith('arena-probe-') && (!repositoryIdentity || !arenaId)) {
            throw new Error('Arena mutation or read requires a claimed canonical repository')
          }
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation) throw new Error('Arena owner generation changed')
          if (!replicaStore) throw new Error('Arena effect store unavailable')
          await replicaStore.registerWorkspaceEffect(owner, callId, workspaceId, repositoryIdentity, arenaId, true)
          return async (releaseArenaId?: string) => {
            if (releaseArenaId) {
              if (!repositoryIdentity || releaseArenaId !== arenaId) throw new Error('Arena cleanup repository identity mismatch')
              await replicaStore.completeArenaCleanupEffect(owner, callId, repositoryIdentity, releaseArenaId)
            } else {
              await replicaStore.completeWorkspaceEffect(owner, callId)
            }
          }
        },
        beginArenaDispatch: async (sessionId: string, generation: string, callId: string, requestDigest: string) => {
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Arena dispatch owner changed')
          await replicaStore.beginWorkspaceEffectDispatch(owner, callId, requestDigest)
        },
        registerSkillEffect: async (sessionId: string, generation: string, callId: string, workspaceId: string) => {
          if (!/^skill-file-[0-9A-HJKMNP-TV-Z]{26}$/u.test(callId) || !workspaceId) {
            throw new Error('Invalid Skill effect identity')
          }
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Skill owner generation changed')
          await replicaStore.registerWorkspaceEffect(owner, callId, workspaceId, undefined, undefined, true)
          return async () => await replicaStore.completeWorkspaceEffect(owner, callId)
        },
        beginSkillDispatch: async (sessionId: string, generation: string, callId: string, digest: string) => {
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Skill dispatch owner changed')
          await replicaStore.beginWorkspaceEffectDispatch(owner, callId, digest)
        },
        releaseNeverDispatchedSkillEffect: async (
          sessionId: string, generation: string, callId: string, workspaceId: string,
        ) => {
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Skill refusal owner changed')
          await replicaStore.completeNeverDispatchedWorkspaceEffect(owner, callId, workspaceId,
            'skill_host_pre_dispatch_rejection')
        },
        registerMemoryEffect: async (sessionId: string, generation: string, callId: string, workspaceId: string) => {
          if (!/^memory-file-[a-f0-9]{64}$/u.test(callId) || !workspaceId) {
            throw new Error('Invalid memory effect identity')
          }
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Memory owner generation changed')
          await replicaStore.registerWorkspaceEffect(owner, callId, workspaceId, undefined, undefined, true)
          return async () => await replicaStore.completeWorkspaceEffect(owner, callId)
        },
        beginMemoryDispatch: async (sessionId: string, generation: string, callId: string, digest: string) => {
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Memory dispatch owner changed')
          await replicaStore.beginWorkspaceEffectDispatch(owner, callId, digest)
        },
        backgroundLearningJobs: {
          enqueue: async (sessionId: string, fingerprint: string) =>
            await replicaStore!.enqueueBackgroundLearning(await sessionOwnership.ensure(sessionId), fingerprint),
          claim: async (sessionId: string, fingerprint: string) =>
            await replicaStore!.claimBackgroundLearning(await sessionOwnership.ensure(sessionId), fingerprint),
          complete: async (sessionId: string, fingerprint: string, error?: string) =>
            await replicaStore!.finishBackgroundLearning(await sessionOwnership.ensure(sessionId), fingerprint, error),
          pending: async (sessionId: string) =>
            await replicaStore!.pendingBackgroundLearning(await sessionOwnership.ensure(sessionId)),
        },
        releaseNeverDispatchedArenaEffect: async (
          sessionId: string, generation: string, callId: string, workspaceId: string,
        ) => {
          const owner = await sessionOwnership.ensure(sessionId)
          if (String(owner.generation) !== generation || !replicaStore) throw new Error('Arena refusal owner changed')
          await replicaStore.completeNeverDispatchedWorkspaceEffect(owner, callId, workspaceId, 'host_pre_dispatch_rejection')
        },
        chooseChildReplicaId: (childSessionId: string) => sessionOwnership.chooseChildReplicaId(childSessionId),
        handoffChildOwner: (childSessionId: string, replicaId: string) => sessionOwnership.handoffChild(childSessionId, replicaId),
        assertSessionEffectOwner: async (sessionId: string) => {
          const owner = await sessionOwnership.ensure(sessionId)
          await hotState.database.transaction(async (transaction) => {
            await hotState.assertResourceOwnerForScope(transaction, {
              tenantId: organizationId, scopeType: 'session', scopeId: sessionId,
            }, owner)
          })
          return { ownerGeneration: String(owner.generation) }
        },
      } : {}),
      objectStorage,
      memoStore: new PostgresMemoStore(tenantState),
      tenantState,
      agentSettings,
      initialAgentSettings,
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
  const model = required('KALA_RUNTIME_HOST_LLM_MODEL')
  const wire = process.env.KALA_RUNTIME_HOST_LLM_WIRE ?? 'openai'
  if (wire !== 'openai' && wire !== 'anthropic') throw new Error('KALA_RUNTIME_HOST_LLM_WIRE must be openai or anthropic')
  const baseUrl = required('KALA_RUNTIME_HOST_LLM_BASE_URL')
  const llm = await new ExplicitLLMClientFactory({ resolve: (_reference, signal) => readRequiredSecretEnv('KALA_RUNTIME_HOST_LLM_API_KEY', signal) }).create({ id: 'runtime-provider', wire, model, baseUrl, credentialRef: 'runtime-secret' })
  return { llm, models: [{ id: model, ref: model, providerId: wire, provider: wire, label: model }], defaultModel: model }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
