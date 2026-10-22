/**
 * Socket.IO server with `/dashboard` and `/executor` namespaces, plus HTTP
 * routes for `/models`, `/settings`, and (optionally) the dashboard bundle.
 *
 * `startHostServer` wires the layers together and returns handles; the
 * namespace-specific event bindings live in `connection/dashboard-ns.ts`
 * and `connection/executor-ns.ts`, and the HTTP routing lives in
 * `http/routes.ts`. This file's job is to construct the pieces and expose
 * a single `close()` for shutdown.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'

import type {
  AttachedExecutor,
  ModelInfo,
  PublicUrlPattern,
  ServerMessageQueueEvent,
  ServerSettingsPayload,
  SessionErrorEvent,
  SessionErrorScope,
} from '@agent-kernel/shared'
import { validatePublicRequest } from '@agent-kernel/shared'
import type {
  AgentConfig,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import { Server as IOServer } from 'socket.io'
import { instrument } from '@socket.io/admin-ui'
import { ulid } from 'ulid'

import type { LLMAdapter } from './llm/adapter.js'
import type { HostLoopDeps, LlmQuotaEnforcer, LoopBroadcast, LoopHandle, TenantModelPolicyEnforcer } from './loop.js'
import { runHostLoop } from './loop.js'
import type { HookConfig, HookRunner } from './extensions/hooks.js'
import { createBuiltinExtensionRegistry } from './extensions/builtin-registry.js'
import type { HostExtension } from './extensions/registry.js'
import { createSkillManager, defaultSkillRoots, discoverSkills, type SkillManager, type SkillRegistry } from './extensions/skills.js'
import { SessionNotFoundError, SessionStore, type SessionRecord } from './store/session.js'
import { slimEffect, type SessionOperationMatch } from './store/log.js'
import type { PostgresSessionAuthority } from './store/postgres-session-authority.js'
import type { ExecutorIdentityStorage } from './store/executor-identity.js'
import { WorkspaceAliasStore, type WorkspaceAliasStorage } from './store/workspace-alias.js'
import { PushSubscriptionStore, type PushSubscriptionStorage } from './push/store.js'
import { loadOrCreateVapidKeys, type VapidKeys } from './push/vapid.js'
import { createPushDispatcher } from './push/dispatch.js'
import { createPushRoutes } from './push/routes.js'
import { PushActivityTracker } from './push/activity.js'
import { OperationalMetrics } from './operational-metrics.js'
import {
  createExecutorRegistry,
  DEFAULT_TOOL_ACK_TIMEOUT_MS,
} from './connection/executor.js'
import {
  collectSessionDescendants,
  configureDashboardNamespace,
  deriveSessionConfig,
  type DashboardNs,
  type MessageQueueManager,
  type QueuedUserMessage,
  type TenantQueueQuotaEnforcer,
  type TenantSessionQuotaEnforcer,
  validateWorkspaceCwd,
  isRestingStatus,
} from './connection/dashboard-ns.js'
import {
  configureExecutorNamespace,
  type ExecutorNs,
  type TenantExecutorQuotaEnforcer,
} from './connection/executor-ns.js'
import { sessionRoom } from './connection/rooms.js'
import { mcpToolsForWorkspace, mergeMcpTools } from './mcp-tools.js'
import { attachDynamicStaticMountHandler, attachEmbeddedStaticHandler, attachJsonRoutes, attachReleaseAssetsHandler, claimRoute, attachRequestHandler, attachStaticHandler, type EmbeddedStaticAsset, type StaticMount, type TenantStorageQuotaEnforcer } from './http/routes.js'
import { SessionArtifactRegistry, type SessionArtifactStorage } from './session-artifact-registry.js'
import { MessageAttachmentStore, type MessageAttachmentStorage } from './message-attachment-store.js'
import { S3MessageAttachmentStore } from './message-attachments/s3-message-attachment-store.js'
import { validateMessageAttachmentReferences } from './message-attachment-resolver.js'
import { createLocalImagePublisher } from './local-image-publisher.js'
import { MemoStore } from './memo-store.js'
import type { AuthConfig, DashboardActor } from './auth-control.js'
import { authenticateDashboardHandshake } from './auth-control.js'
import type { AuditLogger } from './audit-log.js'
import { noopAuditLogger } from './audit-log.js'
import { snapshotFromConfig, type ContextWindowOverride } from './context/manager.js'
import { setWireValidationLogger } from './wire-validation.js'
import type { RuntimeLogger } from './logger.js'
import { AGENT_RUNTIME_CAPABILITIES, FULL_RUNTIME_CAPABILITIES, PORTABLE_DEPLOYMENT, effectiveTenancy, productVariant, type ProductDeploymentConfig, type RuntimeCapabilities } from '@agent-kernel/shared'
import { SOCKET_MAX_HTTP_BUFFER_BYTES } from '@agent-kernel/shared'
import type { SocketAdminConfig } from './socket-admin.js'
import { defaultRestartStatePath, RestartCoordinator } from './restart-coordinator.js'
import { inspectUnitQuiescence } from './tenant-runtime/quiescence.js'
import { socketConnectionAuditSnapshot } from './connection/socket-audit.js'
import { loadPersistedMessageQueueState, persistMessageQueueSnapshot, type PersistedMessageQueueState } from './message-queue-store.js'
import { QueueClaimFencedError, type PostgresMessageQueueClaim } from './postgres-message-queue.js'
import { messageOperationFingerprint } from './message-operation-fingerprint.js'
import { bangShellCallId, bangShellResultOperationId, bangShellResultState, formatBangShellResult, isBangShellResultForCommand, parseBangShellRequest } from './bang-shell.js'
import { modelIdFromRef, resolveModelContextWindow } from './model-capabilities.js'
import type { WebSearchCredentialStore } from './web-search/index.js'
import type { WebSearchCredentialStatus } from './web-search/credential-store.js'
import type { AzureSpeechCredentialStore } from './speech/credential-store.js'
import { ExecutorInstallationStore, type ExecutorInstallationStorage } from './store/executor-installation.js'
import { attachExecutorInstallationRoutes } from './http/executor-installation-routes.js'
import { attachMcpSettingsRoutes } from './http/mcp-settings-routes.js'
import { AgentRuntimeRegistry } from './agent-runtime/types.js'
import { KernelAgentRuntime } from './agent-runtime/kernel-runtime.js'
import { CopilotAgentRuntime } from './agent-runtime/copilot-runtime.js'
import { createRuntimeToolDispatcher } from './agent-runtime/tool-dispatcher.js'
import { AskUserChoiceBroker } from './ask-user-choice.js'
import { attachPublicAccessGate } from './http/public-access-gate.js'
import { KalaStateStore } from './store/state-store.js'
import { DagOrchestrator } from './dag/orchestrator.js'
import { DAG_WORKER_TOOLS } from './dag/worker-tool.js'
import type { DagStorage } from './dag/storage.js'
import type { SubAgentRuntimeController } from './extensions/agent-tool.js'
import type { UnitResourceGovernor } from './tenant-runtime/resource-governor.js'
import { createPublicApiHandler, type PublicApiActor } from './http/public-api.js'
import { resetCompactRuntime } from './extensions/compaction.js'
import { StorageInventory } from './store/storage-inventory.js'
import { SafeCleanupEngine } from './store/safe-cleanup.js'
import { ScheduledTaskStore, type ScheduledTaskStorage } from './scheduled-tasks/store.js'
import { occurrenceSessionId, UnitScheduler } from './scheduled-tasks/scheduler.js'
import type { ScheduledTask, ScheduledTaskSnapshot } from './scheduled-tasks/types.js'

export type HostServerOptions = {
  port: number
  listenHost?: string
  publicUrls?: readonly PublicUrlPattern[]
  sessionsDir: string
  /** Private Cloud Session authority. Omit to retain the local JSONL backend. */
  sessionAuthority?: PostgresSessionAuthority
  /** Optional SQL-checked Session owner gate before external model and tool effects. */
  assertSessionEffectOwner?: (sessionId: string) => Promise<void>
  /** Workspace alias authority. Omit to retain workspace-aliases.json. */
  workspaceAliasStore?: WorkspaceAliasStorage
  /** Executor installation authority. Omit to retain executor-installations.json. */
  executorInstallationStore?: ExecutorInstallationStorage
  /** Executor identity authority. Private Cloud injects an organization/unit-bound PostgreSQL implementation. */
  executorIdentityStore?: ExecutorIdentityStorage
  /** DAG authority. Private Cloud must inject a tenant/unit-scoped PostgreSQL implementation. */
  dagStore?: DagStorage
  /** Scheduled-task authority. Omit to retain the local state.json backend. */
  scheduledTaskStore?: ScheduledTaskStorage
  /** Push subscription authority. Private Cloud must inject a tenant-scoped implementation. */
  pushStore?: PushSubscriptionStorage
  /** VAPID authority override. Pass null to explicitly disable push without generating local keys. */
  vapidKeys?: VapidKeys | null
  /** Object-backed artifact stores. Both stores are required to avoid a mixed, partially local configuration. */
  objectStorage?: {
    sessionArtifacts: SessionArtifactStorage
    messageAttachments: MessageAttachmentStorage
    /** True only when both stores atomically enforce their shared quota before object put. */
    quotaManagedExternally?: boolean
  }
  llm: LLMAdapter
  llmQuota?: LlmQuotaEnforcer
  modelPolicy?: TenantModelPolicyEnforcer
  sessionQuota?: TenantSessionQuotaEnforcer
  queueQuota?: TenantQueueQuotaEnforcer
  storageQuota?: TenantStorageQuotaEnforcer
  resourceGovernor?: UnitResourceGovernor
  resourceUnitId?: string
  resourceArtifactUsage?: () => Promise<number>
  executorQuota?: TenantExecutorQuotaEnforcer
  copilot?: {
    enabled?: boolean
    gitHubToken?: string
    backgroundCompactionThreshold?: number
    bufferExhaustionThreshold?: number
  }
  /** Test synchronization seam: runs after a queue head is claimed, before dispatch I/O. */
  queueDispatchBarrier?: (claimed: { sessionId: string; operationId: string; runtime: string }) => Promise<void>
  /** Private Cloud persistent queue claim TTL; primarily configurable for fencing tests. */
  queueClaimTtlMs?: number
  defaultConfig: AgentConfig | ((actor?: DashboardActor) => AgentConfig)
  toolTimeoutMs?: number
  /**
   * Grace window after an executor disconnects before its "detached" event
   * fans out to dashboards and pending tool calls are failed. Covers routine
   * process restarts. Set to 0 in tests to keep the old instant-detach
   * behavior. Defaults to DETACH_GRACE_MS.
   */
  detachGraceMs?: number
  authToken?: string
  auth?: AuthConfig
  audit?: AuditLogger
  httpServer?: HttpServer
  staticDir?: string
  embeddedStaticAssets?: readonly EmbeddedStaticAsset[]
  embeddedDocs?: readonly EmbeddedStaticAsset[]
  embeddedSocketAdminAssets?: readonly EmbeddedStaticAsset[]
  embeddedReleaseAssets?: readonly EmbeddedStaticAsset[]
  dashboardHandler?: (req: IncomingMessage, res: ServerResponse) => void
  releaseAssetsDir?: string
  socketAdmin?: SocketAdminConfig
  /**
   * Advertised via `GET /models`. When absent the endpoint returns an empty
   * list and the dashboard falls back to whatever the current session says.
   * The CLI populates this from `~/.claude/settings.json` + `~/.codex/config.toml`.
   */
  models?: readonly ModelInfo[] | (() => readonly ModelInfo[])
  defaultModel?: string | (() => string)
  /**
   * User-configured hooks (from `~/.config/kala/config.toml`). When
   * present the loop invokes matching hooks around every tool dispatch;
   * session_start / session_end hooks fire from server.ts around
   * create/delete.
   */
  hooks?: readonly HookConfig[]
  hookRunner?: HookRunner
  /** Additional startup-composed Runtime extensions. The registry seals before the first Session runs. */
  extensions?: readonly HostExtension[]
  skills?: SkillRegistry | SkillManager
  webSearchCredentials?: WebSearchCredentialStore
  webSearchCredentialStatus?: () => Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
  setWebSearchCredential?: (provider: 'serper', key: string) => Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
  deleteWebSearchCredential?: (provider: 'serper') => Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
  speechCredentials?: AzureSpeechCredentialStore
  /** Memo authority override. Omit to retain the KalaStateStore SQLite backend. */
  memoStore?: MemoStore
  stateStore?: KalaStateStore
  artifactRootDir?: string | false
  docsRootDir?: string
  /**
   * Advertised via `GET /settings`. Read-only settings snapshot for the
   * dashboard's Settings dialog — providers, hooks, MCP status, config
   * file paths. Never carries API keys or command args beyond what the
   * operator already put in their config.
   */
  settings?: ServerSettingsPayload | ((actor: DashboardActor) => ServerSettingsPayload | Promise<ServerSettingsPayload>)
  addManualModel?: Parameters<typeof attachJsonRoutes>[1]['addManualModel']
  deleteManualModel?: Parameters<typeof attachJsonRoutes>[1]['deleteManualModel']
  addManualProvider?: Parameters<typeof attachJsonRoutes>[1]['addManualProvider']
  deleteManualProvider?: Parameters<typeof attachJsonRoutes>[1]['deleteManualProvider']
  setDefaultModel?: Parameters<typeof attachJsonRoutes>[1]['setDefaultModel']
  updateAgentPrompt?: Parameters<typeof attachJsonRoutes>[1]['updateAgentPrompt']
  initializeSocketAdmin?: (input: { password: string; mode?: 'development' | 'production'; activate: (config: SocketAdminConfig) => void }) => ServerSettingsPayload
  updateSocketAdminMode?: Parameters<typeof attachJsonRoutes>[1]['updateSocketAdminMode']
  routerHealth?: () => unknown
  logger?: Pick<RuntimeLogger, 'warn'>
  deployment?: ProductDeploymentConfig
  capabilities?: RuntimeCapabilities
  /** Public browser URL for an independently deployed Evaluation UI. */
  evaluationUrl?: string
  /** Dedicated/Portable defaults to true; embedders may explicitly retain the guard. */
  allowAllApprovalMode?: boolean
  /** Exact Supervisor fence expected by a candidate slot during planned recovery. */
  expectedDeployment?: NonNullable<import('@agent-kernel/shared').HostRestartAttempt['deployment']>
  /** Remove slot readiness before a planned restart closes its listener. */
  invalidateReadiness?: () => void | Promise<void>
  restartShutdownTimeoutMs?: number
  /** Test/embedding override for residual system-prompt synchronization retries. */
  promptSynchronizationRetryMs?: number
  mutableReady?: () => boolean
  onProcessReady?: (input: { pid: number; port: number; readyAt: string }) => void | Promise<void>
}

export type HostServer = {
  readonly io: IOServer
  readonly http: HttpServer
  readonly loop: LoopHandle
  readonly store: SessionStore
  readonly executorsSnapshot: () => readonly AttachedExecutor[]
  readonly restartStatus: () => import('@agent-kernel/shared').HostRestartStatus
  readonly port: number
  close(): Promise<void>
}

export async function startHostServer(
  options: HostServerOptions,
): Promise<HostServer> {
  if (options.logger) {
    setWireValidationLogger((entry) => {
      options.logger?.warn(entry, 'wire validation failed')
    })
  }
  const configuredAuth: AuthConfig | undefined = options.auth ?? (options.authToken ? { sharedToken: options.authToken } : undefined)
  const auth: AuthConfig | undefined = options.executorIdentityStore
    ? { ...(configuredAuth ?? {}), executorIdentityStore: options.executorIdentityStore }
    : configuredAuth
  const deployment = options.deployment ?? PORTABLE_DEPLOYMENT
  const product = productVariant(deployment)
  const tenancy = effectiveTenancy(deployment)
  const metrics = new OperationalMetrics()
  metrics.increment('agent_kernel_process_starts_total', 'Host process starts', { component: 'host', deployment_mode: product })
  const capabilities = options.capabilities ?? (deployment.runtimeProfile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES)
  const audit = options.audit ?? noopAuditLogger
  const http = options.httpServer ?? createServer()
  const io = new IOServer(http, {
    cors: { origin: true, credentials: true },
    ...(options.publicUrls ? {
      allowRequest: (request, callback) => {
        const decision = validatePublicRequest(options.publicUrls!, request.headers.host, typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
        callback(null, decision.ok)
      },
    } : {}),
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_BYTES,
    pingInterval: 20_000,
    pingTimeout: 30_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
      // Authentication/version middleware must still run after recovery.
      skipMiddlewares: false,
    },
  })
  const TOKEN_DELTA_BATCH_MS = 16
  const tokenDeltaBatches = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
  const streamingDrafts = new Map<string, { text: string; afterSeq: number; messageCount: number }>()
  const flushTokenDelta = (sessionId: string): void => {
    const batch = tokenDeltaBatches.get(sessionId)
    if (!batch) return
    clearTimeout(batch.timer)
    tokenDeltaBatches.delete(sessionId)
    if (batch.text.length > 0) {
      io.of('/dashboard').to(sessionRoom(sessionId)).emit('session:token_delta', { sessionId, text: batch.text })
    }
  }
  let closed = false
  let agentRuntimes: AgentRuntimeRegistry | undefined
  let dagOrchestrator: DagOrchestrator | undefined
  let storageInventory: StorageInventory | undefined
  let safeCleanup: SafeCleanupEngine | undefined
  let scheduledTaskScheduler: UnitScheduler | undefined
  let detachPublicAccessGate: (() => void) | undefined
  let promptSynchronizationTimer: ReturnType<typeof setTimeout> | undefined
  let deletionRecoveryTimer: ReturnType<typeof setInterval> | undefined
  let deletionRecoveryPass: Promise<void> | undefined
  const closeServer = async (): Promise<void> => {
    if (closed) return
    closed = true
    // Fencing PG writes alone cannot stop an already-started model/tool effect.
    // Abort cancellable effects before waiting for scheduler and queue shutdown.
    // Default single-process shutdown still drains already accepted queue work.
    // Only the distributed owner protocol requires immediate loss fencing.
    if (options.assertSessionEffectOwner) loop?.abortActiveEffects()
    if (promptSynchronizationTimer) clearTimeout(promptSynchronizationTimer)
    if (deletionRecoveryTimer) clearInterval(deletionRecoveryTimer)
    if (deletionRecoveryPass) await deletionRecoveryPass
    detachPublicAccessGate?.()
    for (const batch of tokenDeltaBatches.values()) clearTimeout(batch.timer)
    tokenDeltaBatches.clear()
    streamingDrafts.clear()
    // Stop claims first; shutdown waits for the active scheduler mutation/side effect.
    await scheduledTaskScheduler?.stop()
    // Queue persistence and post-turn drains may still be crossing their durable
    // boundary after the last socket closes. Wait before callers remove the
    // Session directory (tests) or replace storage (shutdown/deploy).
    await Promise.allSettled([...queueLoads.values(), ...queueMutations.values()])
    await agentRuntimes?.close()
    await dagOrchestrator?.close()
    for (let attempt = 0; attempt < 100 && drainingQueues.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    await Promise.allSettled([...queueLoads.values(), ...queueMutations.values()])
    detachPublicAccessGate = options.publicUrls ? attachPublicAccessGate(http, options.publicUrls) : undefined
    await new Promise<void>((resolve, reject) => {
      io.close((err) => (err ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve) => {
      if (!http.listening) {
        resolve()
        return
      }
      http.close(() => resolve())
    })
    await Promise.allSettled([...queueLoads.values(), ...queueMutations.values()])
    for (let attempt = 0; attempt < 100 && drainingQueues.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    storageInventory?.close()
    if (ownsStateStore) stateStore.close()
  }
  let activeSocketAdmin: SocketAdminConfig | undefined
  const activateSocketAdmin = (config: SocketAdminConfig): void => {
    if (activeSocketAdmin) return
    instrument(io, {
      auth: {
        type: 'basic',
        username: config.username,
        password: config.passwordHash,
      },
      mode: config.mode,
    })
    activeSocketAdmin = config
  }
  if (options.socketAdmin) activateSocketAdmin(options.socketAdmin)

  const getDefaultConfig = (actor?: DashboardActor): AgentConfig => typeof options.defaultConfig === 'function'
    ? options.defaultConfig(actor)
    : options.defaultConfig
  if (options.sessionAuthority && !options.objectStorage) {
    throw new Error('Private Cloud session authority requires both externally backed artifact stores')
  }
  const sessionArtifacts = options.objectStorage?.sessionArtifacts
    ?? new SessionArtifactRegistry(join(options.sessionsDir, '..', 'session-artifacts'))
  const messageAttachments = options.objectStorage?.messageAttachments
    ?? new MessageAttachmentStore(join(options.sessionsDir, '..', 'message-attachments'))
  await Promise.all([sessionArtifacts.load(), messageAttachments.load()])
  const useLocalArtifactGovernor = !options.objectStorage?.quotaManagedExternally
    && Boolean(options.resourceGovernor && options.resourceUnitId)
  const effectiveStorageQuota: TenantStorageQuotaEnforcer | undefined =
    options.storageQuota || useLocalArtifactGovernor
      ? {
          async assertCanStoreArtifact(params) {
            if (useLocalArtifactGovernor && options.resourceGovernor && options.resourceUnitId) {
              if (options.resourceArtifactUsage) {
                options.resourceGovernor.reconcile(options.resourceUnitId, {
                  artifactBytes: await options.resourceArtifactUsage(),
                })
              }
              const decision = options.resourceGovernor.reserveArtifact(options.resourceUnitId, params.bytes)
              if (!decision.ok) throw new Error(`Runtime Unit artifact quota exceeded (${decision.code})`)
            }
            try {
              await options.storageQuota?.assertCanStoreArtifact(params)
            } catch (error) {
              if (useLocalArtifactGovernor && options.resourceGovernor && options.resourceUnitId) {
                options.resourceGovernor.releaseArtifact(options.resourceUnitId, params.bytes)
              }
              throw error
            }
          },
        }
      : undefined
  const store = new SessionStore(options.sessionsDir, {
    authority: options.sessionAuthority,
    runtimeConfig: ({ executionMode }) => deriveSessionConfig(getDefaultConfig(), undefined, executionMode),
    artifactRootDir: options.artifactRootDir,
    deleteRegisteredArtifacts: async (sessionId) => {
      const results = await Promise.allSettled([
        sessionArtifacts.deleteSession(sessionId),
        messageAttachments.deleteSession(sessionId),
      ])
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, `Session ${sessionId} object cleanup failed`)
    },
    onStorageChanged: () => storageInventory?.invalidate(),
  })
  await store.initialize()
  if (store.usesExternalAuthority) {
    deletionRecoveryTimer = setInterval(() => {
      if (closed || deletionRecoveryPass) return
      deletionRecoveryPass = store.recoverPendingDeletions()
        .catch((error: unknown) => console.warn('[private-cloud] session deletion recovery failed', error))
        .finally(() => { deletionRecoveryPass = undefined })
    }, 60_000)
    deletionRecoveryTimer.unref()
  }
  // The current inventory and quarantine engine measure/move local Session trees.
  // Do not expose misleading partial results for PostgreSQL or object-backed data;
  // Dashboard RPCs fail explicitly with "storage inventory/cleanup unavailable".
  if (!options.sessionAuthority && !options.objectStorage) {
    storageInventory = new StorageInventory(options.sessionsDir)
    safeCleanup = new SafeCleanupEngine({
      sessionsDir: options.sessionsDir,
      quarantineDir: join(options.sessionsDir, '..', 'storage-quarantine'),
      metadataDir: join(options.sessionsDir, '..', 'storage-cleanup'),
      withMutationLease: async (sessionIds, action) => await store.withStorageMutationLease(sessionIds, action),
      onSessionsQuarantined: (sessionIds) => store.evictQuarantinedSessions(sessionIds),
    })
    await safeCleanup.recover(new Set())
    store.installStorageTombstones(await safeCleanup.listTombstonedSessionIds())
  }
  const ownsStateStore = options.stateStore === undefined
  const stateStore = options.stateStore ?? new KalaStateStore(join(options.sessionsDir, '..', 'memos'), {
    legacyMemoDirectory: join(options.sessionsDir, '..', 'memos'),
  })
  const memoStore = options.memoStore ?? new MemoStore(stateStore)
  if (options.sessionAuthority && !options.dagStore) {
    throw new Error('Private Cloud session authority requires an explicitly tenant/unit-scoped DAG store')
  }
  const dagStore = options.dagStore ?? stateStore.dagStore()
  const defaultSkillRootsList = defaultSkillRoots()
  const defaultSkillRegistry = await discoverSkills(defaultSkillRootsList)
  const workspaceAliases = options.workspaceAliasStore ?? new WorkspaceAliasStore(join(options.sessionsDir, '..', 'workspace-aliases.json'))
  await workspaceAliases.load()
  const executorInstallations = options.executorInstallationStore ?? new ExecutorInstallationStore(join(options.sessionsDir, '..', 'executor-installations.json'))
  await executorInstallations.load()
  const windowsReleaseAssetsReady = () => hasIntegrityCheckedWindowsReleaseAssets(options.releaseAssetsDir, options.embeddedReleaseAssets)
  attachExecutorInstallationRoutes(http, {
    store: executorInstallations,
    ...(auth?.executorIdentityStore ? { identities: auth.executorIdentityStore } : {}),
    ...(auth ? { auth } : {}),
    tenancy,
    audit,
    windowsReleaseAssetsReady,
  })

  // Web Push (see docs/planning/roadmap-notes/pwa-mobile-and-push.md §5).
  // Private Cloud must provide both authorities so a tmpfs restart can never
  // silently fall back to local subscriptions or auto-generated VAPID keys.
  if (options.sessionAuthority && !options.pushStore) {
    throw new Error('Private Cloud session authority requires an explicitly tenant-scoped push store')
  }
  if (options.sessionAuthority && options.vapidKeys === undefined) {
    throw new Error('Private Cloud session authority requires externally supplied VAPID keys or explicit null')
  }
  const localPushStore = options.pushStore ? undefined : new PushSubscriptionStore(join(options.sessionsDir, '..', 'push-subscriptions.jsonl'))
  if (localPushStore) await localPushStore.load()
  const pushStore = options.pushStore ?? localPushStore!
  const vapid = options.vapidKeys !== undefined ? options.vapidKeys : loadOrCreateVapidKeys(options.sessionsDir)
  const pushActivity = new PushActivityTracker()
  const pushDispatcher = createPushDispatcher({
    store: pushStore,
    vapid,
    shouldSuppress: () => pushActivity.hasActiveDevice(),
  })
  const pushRoutes = createPushRoutes({ store: pushStore, vapid, dispatcher: pushDispatcher, activity: pushActivity })
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (res.headersSent || res.writableEnded) return
    const requestUrl = new URL(req.url ?? '/', 'http://localhost')
    if ((req.url ?? '/').split('?')[0]?.startsWith('/push/')) claimRoute(req)
    // pushRoutes returns true when it handled the request. Anything not
    // matching /push/* falls through to attachJsonRoutes and beyond.
    void pushRoutes(req, res).then((handled) => {
      if (!handled) return
      // A route handled it; nothing to do here — the response is already sent.
    }).catch((err: unknown) => {
      if (res.headersSent) return
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    })
  })

  // Per-session "last status" so we only fire waiting_for_user once per
  // transition (running → done), not on every subsequent event that carries
  // the same state.
  const lastSessionStatus = new Map<string, string>()

  const executors = createExecutorRegistry(
    io,
    {
      workspaceIdFor: (sid) => store.get(sid)?.workspaceId,
      mcpSchemaHashFor: (sid, name) => store.get(sid)?.config.tools.find((tool) => tool.name === name && tool.name.includes('__') && !tool.name.startsWith('__') && tool.schemaHash && tool.version === tool.schemaHash)?.schemaHash,
    },
    options.toolTimeoutMs ?? DEFAULT_TOOL_ACK_TIMEOUT_MS,
    audit,
    options.detachGraceMs,
  )
  attachMcpSettingsRoutes(http, {
    installations: executorInstallations,
    executors,
    tenancy,
    ...(auth ? { auth } : {}),
    audit,
  })

  let restart: RestartCoordinator | undefined
  const hostStartedAt = new Date().toISOString()
  // Cloud Pod replacement is owned by the orchestrator, not the local-file
  // restart workflow. Do not create or recover restart-state.json on tmpfs.
  const restartUnavailableStatus = () => ({ pid: process.pid, startedAt: hostStartedAt, current: null, last: null })
  const settingsWithSkills = (settings: NonNullable<HostServerOptions['settings']>) => async (actor: DashboardActor): Promise<ServerSettingsPayload> => {
    const base = typeof settings === 'function'
      ? await settings(actor)
      : settings
    return {
      ...base,
      mcp: {
        supported: actor.kind === 'ingress' ? actor.role === 'owner' || actor.role === 'admin' : actor.kind !== 'anonymous',
        note: 'Managed MCP settings require authenticated operator access and an online Dashboard-installed Executor.',
      },
      skills: {
        count: defaultSkillRegistry.skills.length,
        roots: defaultSkillRootsList,
        diagnostics: defaultSkillRegistry.diagnostics,
      },
      ...(restart ? { runtime: restart.status() } : {}),
      socketConnections: socketConnectionAuditSnapshot(io),
    }
  }
  let publishSystemPromptChanged = (_record: SessionRecord): void => {}
  const organizationIdForActor = (actor: DashboardActor): string | undefined => actor.kind === 'ingress'
    ? actor.organizationId
    : undefined
  const actorForRecord = (record: SessionRecord): DashboardActor => record.organizationId
    ? {
        kind: 'ingress',
        principal: record.principal ?? 'system',
        organizationId: record.organizationId,
        role: record.organizationRole ?? 'member',
      }
    : { kind: 'anonymous' }
  const pendingPromptSynchronizations = new Set<string>()
  const promptSettingUpdateTails = new Map<string, Promise<ServerSettingsPayload>>()
  let startupPromptDiscoveryPending = true
  let promptSynchronizationRunning = false
  const ensureEffectiveSystemPrompt = async (record: SessionRecord): Promise<boolean> => {
    const prompt = getDefaultConfig(actorForRecord(record)).systemPrompt ?? ''
    const current = record.state.systemPromptOverride?.prompt
      ?? (record.state.messages[0]?.role === 'system'
        ? record.state.messages[0].content.filter((item) => item.type === 'text').map((item) => item.text).join('')
        : '')
    if (record.config.systemPrompt === prompt && current === prompt) return false
    // Fence an in-flight Copilot request before the durable replacement. cancel()
    // invalidates its generation synchronously; the next send resumes the same
    // provider Session under the new prompt rather than deleting its history.
    if (record.agentRuntime === 'copilot' && !isRestingStatus(record.state.status)) {
      await agentRuntimes?.get(record.agentRuntime)?.cancel(record)
    }
    const changed = await store.applySystemPrompt(record.sessionId, prompt)
    // Close the resting→running race between the pre-fence and durable commit.
    // The prompt-generation check already rejects late output; this also stops
    // provider work that entered during that narrow window.
    if (changed && record.agentRuntime === 'copilot' && !isRestingStatus(record.state.status)) {
      await agentRuntimes?.get(record.agentRuntime)?.cancel(record)
    }
    if (changed) publishSystemPromptChanged(record)
    return changed
  }
  const synchronizeOrganizationPrompt = async (actor: DashboardActor): Promise<void> => {
    const organizationId = organizationIdForActor(actor)
    let ids: string[]
    try {
      ids = await store.listSessionIdsForOrganization(organizationId)
    } catch (error) {
      startupPromptDiscoveryPending = true
      const pending = new AggregateError([error], 'Agent prompt settings were saved, but Session discovery is pending background retry') as AggregateError & { status: number; settingsSaved?: boolean }
      pending.status = 503
      pending.settingsSaved = true
      schedulePromptSynchronizationRetry()
      throw pending
    }
    const failures: unknown[] = []
    for (const sessionId of ids) {
      try {
        const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false, runtimeConfig: getDefaultConfig(actor) })
        await ensureEffectiveSystemPrompt(record)
        pendingPromptSynchronizations.delete(sessionId)
      } catch (error) {
        pendingPromptSynchronizations.add(sessionId)
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      const pending = new AggregateError(
        failures,
        `Agent prompt settings were saved, but ${failures.length} Session system prompt(s) are pending background retry`,
      ) as AggregateError & { status: number; settingsSaved?: boolean }
      pending.status = 503
      pending.settingsSaved = true
      schedulePromptSynchronizationRetry()
      throw pending
    }
  }
  function schedulePromptSynchronizationRetry(): void {
    if (closed || promptSynchronizationTimer) return
    promptSynchronizationTimer = setTimeout(() => {
      promptSynchronizationTimer = undefined
      void retryPromptSynchronizations()
    }, options.promptSynchronizationRetryMs ?? 1_000)
    promptSynchronizationTimer.unref?.()
  }
  const retryPromptSynchronizations = async (): Promise<void> => {
    if (closed || promptSynchronizationRunning) return
    // A blue/green candidate must not load (and recover) or mutate the
    // incumbent's Sessions until the supervisor admits this slot for writes.
    if (options.mutableReady?.() === false) {
      schedulePromptSynchronizationRetry()
      return
    }
    promptSynchronizationRunning = true
    try {
      if (startupPromptDiscoveryPending) {
        try {
          for (const sessionId of await store.listSessionIds()) pendingPromptSynchronizations.add(sessionId)
          startupPromptDiscoveryPending = false
        } catch {
          // Session storage may not be mounted yet. Keep discovery pending.
        }
      }
      for (const sessionId of [...pendingPromptSynchronizations]) {
        try {
          const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
          await ensureEffectiveSystemPrompt(record)
          pendingPromptSynchronizations.delete(sessionId)
        } catch {
          // Settings or Session storage may be temporarily unreadable. Retain it.
        }
      }
    } finally {
      promptSynchronizationRunning = false
      if (startupPromptDiscoveryPending || pendingPromptSynchronizations.size > 0) {
        schedulePromptSynchronizationRetry()
      }
    }
  }

  const enqueueUserMessage = async ({
    sessionId,
    text,
    intent,
    operationId: requestedOperationId,
    mode = 'queue',
    content,
  }: {
    sessionId: string
    text: string
    intent: 'text' | 'shell'
    operationId?: string
    mode?: 'queue' | 'steer'
    content?: readonly import('@agent-kernel/kernel').MessageContent[]
  }): Promise<{ accepted?: boolean; committed: boolean; cursor?: number }> => {
    const operationId = requestedOperationId ?? ulid()
    let record = store.get(sessionId)
    if (!record) record = await store.load(sessionId, { recoverDangling: false })
    await validateMessageAttachmentReferences(messageAttachments, sessionId, content)
    const shell = intent === 'shell' ? parseBangShellRequest(text) : undefined
    if (intent === 'shell' && !shell) throw new Error('Shell intent requires a leading ! command')
    if (shell && content?.length) throw new Error('Shell commands cannot include attachments or structured content')
    if (shell && !record.workspaceId) throw new Error('Shell commands require a Session bound to a workspace')
    const operationScan = record.agentRuntime === 'kernel' ? {} : { maxScanBytes: 64 * 1024 * 1024 }
    if (shell) {
      const existingResult = await store.findOperation(sessionId, bangShellResultOperationId(operationId), operationScan)
      if (existingResult?.kind === 'event') {
        if (!isBangShellResultForCommand(existingResult.event.text, shell.command)) {
          throw new Error(`operationId ${operationId} was already used for a different shell command`)
        }
        return { accepted: true, committed: true, cursor: existingResult.cursor }
      }
      if (existingResult?.kind === 'runtime_metadata') {
        if (existingResult.action !== 'copilot.user_message' || !isBangShellResultForCommand(existingResult.text ?? '', shell.command)) {
          throw new Error(`operationId ${operationId} was already used for a different shell command`)
        }
        return { accepted: true, committed: true, cursor: record.state.cursor }
      }
    }
    const existingOperation = await store.findOperation(sessionId, operationId, operationScan)
    if (existingOperation?.kind === 'event') {
      assertMessageOperationCompatible(existingOperation.event, text, content)
      await messageAttachments?.commitReferences(sessionId, content)
      return { accepted: true, committed: true, cursor: existingOperation.cursor }
    }
    if (existingOperation?.kind === 'runtime_metadata') {
      assertCopilotOperationCompatible(existingOperation, text, content)
      await messageAttachments?.commitReferences(sessionId, content)
      return { accepted: true, committed: true, cursor: record.state.cursor }
    }
    // PG/S3 stores the attachment protection and Queue item in one owner-fenced
    // transaction. Legacy storage still protects references before enqueue.
    const atomicAttachments = Boolean(options.sessionAuthority && messageAttachments instanceof S3MessageAttachmentStore
      && content?.some((block) => block.type === 'file' && 'source' in block && block.source.kind === 'host_ref'))
    if (!atomicAttachments) await messageAttachments?.commitReferences(sessionId, content)
    if (record.agentRuntime !== 'kernel') {
      const resting = isRestingStatus(record.state.status)
      await messageQueues.enqueue(sessionId, {
        id: operationId,
        operationId,
        text,
        mode,
        createdAt: new Date().toISOString(),
        ...(content ? { content } : {}),
        ...(effectiveModelForSession(sessionId) ? { model: effectiveModelForSession(sessionId) } : {}),
        ...(shell ? { shell: { ...shell, state: 'queued' as const } } : {}),
      }, mode === 'steer' ? 'front' : undefined, atomicAttachments ? 'atomic-attachments' : undefined)
      if (mode === 'steer' && !resting) {
        await agentRuntimes!.require(record.agentRuntime).cancel(record)
        await messageQueues.drain(sessionId)
      } else if (resting) {
        await messageQueues.drain(sessionId)
      } else {
        void messageQueues.drain(sessionId)
      }
      const committedCursor = await sessionUserOperationCursor(store, sessionId, shell ? bangShellResultOperationId(operationId) : operationId)
      return committedCursor === undefined
        ? { accepted: true, committed: false }
        : { accepted: true, committed: true, cursor: committedCursor }
    }
    if (record.state.status === 'thinking' && !loop.hasActiveLlmCall(sessionId)) {
      await loop.recoverInterruptedLlm(sessionId)
      record = store.get(sessionId) ?? record
    }
    const effectiveMode = mode === 'queue' && isRestingStatus(record.state.status) ? 'steer' : mode
    await messageQueues.enqueue(sessionId, {
      id: operationId,
      operationId,
      text,
      mode: effectiveMode,
      createdAt: new Date().toISOString(),
      ...(content ? { content } : {}),
      ...(shell ? { shell: { ...shell, state: 'queued' as const } } : {}),
    }, effectiveMode === 'steer' ? 'front' : undefined, atomicAttachments ? 'atomic-attachments' : undefined)
    if (effectiveMode === 'steer' && !isRestingStatus(record.state.status)) loop.requestStopAtBoundary(sessionId)
    void messageQueues.drain(sessionId)
    const committedCursor = await sessionUserOperationCursor(store, sessionId, shell ? bangShellResultOperationId(operationId) : operationId)
    return committedCursor === undefined
      ? { accepted: true, committed: false }
      : { accepted: true, committed: true, cursor: committedCursor }
  }
  let publicApiHandler: ReturnType<typeof createPublicApiHandler> = async (_request, response) => {
    response.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-kala-api-version': 'v1',
      'x-kala-api-compatibility': '1',
    })
    response.end(JSON.stringify({ error: { code: 'internal_error', message: 'Runtime API is starting', requestId: 'startup' } }))
    return true
  }
  attachJsonRoutes(http, {
    models: options.models ?? [],
    defaultModel: options.defaultModel ?? '',
    ...(options.settings ? { settings: async (actor: DashboardActor) => ({ ...await settingsWithSkills(options.settings!)(actor), deployment: { product, deployment, capabilities } }) } : {}),
    ...(options.addManualModel ? { addManualModel: options.addManualModel } : {}),
    ...(options.deleteManualModel ? { deleteManualModel: options.deleteManualModel } : {}),
    ...(options.addManualProvider ? { addManualProvider: options.addManualProvider } : {}),
    ...(options.deleteManualProvider ? { deleteManualProvider: options.deleteManualProvider } : {}),
    ...(options.setDefaultModel ? { setDefaultModel: options.setDefaultModel } : {}),
    ...(options.updateAgentPrompt ? {
      updateAgentPrompt: (input, actor) => {
        const organizationId = organizationIdForActor(actor)
        const key = organizationId === undefined ? 'portable' : `org:${organizationId}`
        const previous = promptSettingUpdateTails.get(key)
        const update = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
          if (options.mutableReady?.() === false) {
            throw Object.assign(new Error('Host is not ready to update agent prompt settings'), { status: 503 })
          }
          const result = await options.updateAgentPrompt!(input, actor)
          await synchronizeOrganizationPrompt(actor)
          return result
        })
        promptSettingUpdateTails.set(key, update)
        void update.finally(() => {
          if (promptSettingUpdateTails.get(key) === update) promptSettingUpdateTails.delete(key)
        }).catch(() => undefined)
        return update
      },
    } : {}),
    ...(options.initializeSocketAdmin ? { initializeSocketAdmin: (input: { password: string; mode?: 'development' | 'production' }) => options.initializeSocketAdmin!({ ...input, activate: activateSocketAdmin }) } : {}),
    ...(options.updateSocketAdminMode ? { updateSocketAdminMode: options.updateSocketAdminMode } : {}),
    ...(options.artifactRootDir !== undefined ? { artifactRootDir: options.artifactRootDir } : {}),
    ...(options.docsRootDir ? { docsRootDir: options.docsRootDir } : {}),
    ...(options.embeddedDocs ? { embeddedDocs: options.embeddedDocs } : {}),
    sessionArtifacts,
    messageAttachments,
    ...(effectiveStorageQuota ? { storageQuota: effectiveStorageQuota } : {}),
    ...(options.routerHealth ? { routerHealth: options.routerHealth } : {}),
    ...(auth ? { auth } : {}),
    audit,
    capabilities,
    deployment,
    ...(options.evaluationUrl ? { evaluationUrl: options.evaluationUrl } : {}),
    metrics,
    memoStore,
    ...(options.webSearchCredentials && options.webSearchCredentialStatus && options.setWebSearchCredential && options.deleteWebSearchCredential ? {
      webSearchCredentials: {
        get: (provider: 'serper') => options.webSearchCredentials!.get(provider),
        status: options.webSearchCredentialStatus,
        set: options.setWebSearchCredential,
        delete: options.deleteWebSearchCredential,
      },
    } : {}),
    ...(options.speechCredentials ? { speechCredentials: options.speechCredentials } : {}),
    publicApiHandler: async (request, response) => await publicApiHandler(request, response),
    sessions: store,
    executorsSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
    toolRegistry: () => (typeof options.defaultConfig === 'function' ? options.defaultConfig() : options.defaultConfig).tools,
    toolResultPersisted: async (sessionId, callId) => {
      const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false }).catch(() => undefined)
      if (!record) return false
      const runtime = agentRuntimes?.get(record.agentRuntime)
      return runtime ? await runtime.toolResultPersisted(record, callId) : false
    },
    restartStatus: () => restart?.status() ?? restartUnavailableStatus(),
    requestRestart: (input) => {
      if (!restart) throw new Error(options.sessionAuthority ? 'Private Cloud Runtime restart must be managed by the orchestrator' : 'restart coordinator is not ready')
      return restart.request(input)
    },
    commitRestartActivation: (attemptId) => restart?.commitActivation(attemptId) ?? null,
    abortRestart: (attemptId) => restart?.abort('restart aborted', attemptId) ?? null,
    unitQuiescence: () => inspectUnitQuiescence({ loop, store }, messageQueues.isStable()),
    reserveCutover: async () => {
      loop.beginDrain('checkpoint')
      const sessionIds = store.list().map((record) => record.sessionId)
      await Promise.all(sessionIds.map((sessionId) => loop.waitForCheckpoint(sessionId)))
      await messageQueues.waitForStable()
      const snapshot = inspectUnitQuiescence({ loop, store }, messageQueues.isStable())
      if (!snapshot.safe) throw new Error('Unit did not reach a stable cutover boundary')
      return snapshot
    },
    releaseCutover: () => loop.endDrain(),
    enqueueUserMessage,
  })

  const advertisedModels = (): readonly ModelInfo[] => typeof options.models === 'function'
    ? options.models()
    : options.models ?? []
  const normalizeModelRef = (model: string): string | undefined => {
    const selected = model.trim()
    if (!selected) return undefined
    const exact = advertisedModels().find((m) => (m.ref ?? m.id) === selected)
    if (exact) return exact.ref ?? exact.id
    const byId = advertisedModels().filter((m) => m.id === selected)
    return byId.length === 1 ? byId[0]!.ref ?? byId[0]!.id : undefined
  }
  const effectiveDefaultModel = (): string | undefined => {
    const configured = typeof options.defaultModel === 'function' ? options.defaultModel() : options.defaultModel
    if (!configured) return undefined
    const fallback = configured.trim()
    return normalizeModelRef(configured) ?? (fallback.length > 0 ? fallback : undefined)
  }
  const effectiveModelForSession = (sessionId: string): string | undefined => {
    const record = store.get(sessionId)
    const selected = record?.preferences.selectedModel
    if (record?.agentRuntime === 'copilot') return selected
    return (selected ? normalizeModelRef(selected) : undefined) ?? effectiveDefaultModel()
  }
  const contextWindowForModel = (model: string | undefined): ContextWindowOverride | undefined => {
    const selected = model?.trim()
    if (!selected) return undefined
    const normalized = normalizeModelRef(selected)
    if (!normalized) {
      const contextWindow = resolveModelContextWindow(selected, advertisedModels())
      return {
        model: selected,
        modelId: modelIdFromRef(selected),
        ...(contextWindow ? { contextWindow } : {}),
      }
    }
    const info = advertisedModels().find((m) => (m.ref ?? m.id) === normalized)
    if (!info) return { model: selected }
    const contextWindow = resolveModelContextWindow(normalized, advertisedModels())
    return {
      model: normalized,
      modelId: info.id,
      provider: info.providerId,
      ...(contextWindow ? { contextWindow } : {}),
    }
  }

  const socketAdminMount = (): StaticMount | undefined => activeSocketAdmin
    ? {
        path: activeSocketAdmin.path,
        ...(activeSocketAdmin.distDir ? { rootDir: activeSocketAdmin.distDir } : {}),
        ...(options.embeddedSocketAdminAssets ? { assets: options.embeddedSocketAdminAssets } : {}),
      }
    : undefined
  attachDynamicStaticMountHandler(http, socketAdminMount)

  const hasReleaseAssets = Boolean(options.releaseAssetsDir || options.embeddedReleaseAssets?.length)
  const releaseAssetsDir = options.releaseAssetsDir ?? process.cwd()
  if (options.dashboardHandler) {
    if (hasReleaseAssets) attachReleaseAssetsHandler(http, releaseAssetsDir, options.embeddedReleaseAssets)
    attachRequestHandler(http, options.dashboardHandler)
  } else if (options.staticDir) {
    if (hasReleaseAssets) attachReleaseAssetsHandler(http, releaseAssetsDir, options.embeddedReleaseAssets)
    attachStaticHandler(http, options.staticDir)
  } else if (options.embeddedStaticAssets && options.embeddedStaticAssets.length > 0) {
    if (hasReleaseAssets) attachReleaseAssetsHandler(http, releaseAssetsDir, options.embeddedReleaseAssets)
    attachEmbeddedStaticHandler(http, options.embeddedStaticAssets)
  } else if (hasReleaseAssets) {
    attachReleaseAssetsHandler(http, releaseAssetsDir, options.embeddedReleaseAssets)
  }

  const queuedMessages = new Map<string, QueuedUserMessage[]>()
  const cancelledQueueOperations = new Map<string, Set<string>>()
  const claimedQueueOperations = new Map<string, QueuedUserMessage>()
  const persistentQueue = options.sessionAuthority?.messageQueue
  const persistentQueueClaims = new Map<string, PostgresMessageQueueClaim>()
  const queueClaimOwner = `host:${randomUUID()}`
  const queueClaimTtlMs = options.queueClaimTtlMs ?? 30_000
  const drainingQueues = new Set<string>()
  const requestedQueueDrains = new Set<string>()
  const queueLoads = new Map<string, Promise<PersistedMessageQueueState>>()
  const queueMutations = new Map<string, Promise<void>>()

  const dashboardNs: DashboardNs = io.of('/dashboard') as unknown as DashboardNs
  const executorNs: ExecutorNs = io.of('/executor') as unknown as ExecutorNs
  publishSystemPromptChanged = (record) => {
    const model = effectiveModelForSession(record.sessionId)
    dashboardNs.to(sessionRoom(record.sessionId)).emit('state:changed', {
      sessionId: record.sessionId,
      cursor: record.state.cursor,
      state: record.state,
      contextSnapshot: record.runtimeContextSnapshot ?? snapshotFromConfig(
        record.config,
        record.state.messages,
        contextWindowForModel(model),
        model,
      ),
      ...(record.turnStartedAt ? { turnStartedAt: record.turnStartedAt } : {}),
    })
  }

  let loop: LoopHandle
  const queueSnapshot = (sessionId: string): ServerMessageQueueEvent => {
    const queue = queuedMessages.get(sessionId) ?? []
    // The dock represents user-visible *queued follow-ups* only. A `steer`
    // message is a transient interrupt: it is placed at the front of the
    // internal queue purely to preserve dispatch ordering across the async
    // turn-abort, then drained on the very next tick. Surfacing it as a
    // "pending" dock item makes a steer look like it got stuck in the queue
    // (and flickers in/out within a round-trip), so exclude steer items from
    // what the dashboard renders and counts.
    const visible = queue.filter((item) => item.mode !== 'steer')
    return {
      sessionId,
      pending: visible.length,
      items: visible.map((item) => ({
        id: item.id,
        text: item.text,
        mode: item.mode,
        createdAt: item.createdAt,
        ...(item.content ? { content: item.content } : {}),
        ...(item.shell ? { shell: {
          command: item.shell.command,
          state: item.shell.state ?? 'queued',
          ...(item.shell.result ? { result: item.shell.result } : {}),
          ...(item.shell.error ? { error: item.shell.error } : {}),
        } } : {}),
      })),
    }
  }

  const emitQueueUpdate = (sessionId: string): void => {
    dashboardNs.to(sessionRoom(sessionId)).emit('server:message_queue', queueSnapshot(sessionId))
  }

  const applyQueueState = (sessionId: string, state: PersistedMessageQueueState): QueuedUserMessage[] => {
    if (state.items.length === 0) queuedMessages.delete(sessionId)
    else queuedMessages.set(sessionId, [...state.items])
    cancelledQueueOperations.set(sessionId, new Set(state.cancelledOperationIds))
    syncGovernedQueueUsage()
    return queuedMessages.get(sessionId) ?? []
  }

  const loadQueue = async (sessionId: string): Promise<QueuedUserMessage[]> => {
    const existing = queuedMessages.get(sessionId)
    if (!persistentQueue && (existing || cancelledQueueOperations.has(sessionId))) return existing ?? []
    let pending = queueLoads.get(sessionId)
    if (!pending) {
      pending = (persistentQueue
        ? persistentQueue.loadOrInitialize(sessionId, async () => await loadPersistedMessageQueueState(store, sessionId))
        : loadPersistedMessageQueueState(store, sessionId)).catch((error) => {
        // Dashboard sockets may subscribe before creating their Session. Preserve
        // that empty-queue behavior, but fail closed for all actual read errors
        // so tombstones are never silently discarded.
        if (error instanceof SessionNotFoundError) return { items: [], cancelledOperationIds: [] }
        throw error
      })
      queueLoads.set(sessionId, pending)
    }
    let restored: PersistedMessageQueueState
    try {
      restored = await pending
    } finally {
      queueLoads.delete(sessionId)
    }
    return applyQueueState(sessionId, restored)
  }

  const persistQueue = async (sessionId: string, queue: readonly QueuedUserMessage[], cancelled = cancelledQueueOperations.get(sessionId) ?? new Set<string>()): Promise<void> => {
    if (persistentQueue) throw new Error('Private Cloud queue mutations must use PostgreSQL transactional operations')
    await persistMessageQueueSnapshot(store, sessionId, queue, [...cancelled])
    if (queue.length === 0) queuedMessages.delete(sessionId)
    else queuedMessages.set(sessionId, [...queue])
    cancelledQueueOperations.set(sessionId, new Set(cancelled))
    syncGovernedQueueUsage()
  }

  const resourceUnitId = options.resourceUnitId
  const resourceGovernor = options.resourceGovernor
  const syncGovernedQueueUsage = (): void => {
    if (!resourceGovernor || !resourceUnitId) return
    resourceGovernor.reconcile(resourceUnitId, {
      queuedMessages: [...queuedMessages.values()].reduce((total, queue) => total + queue.length, 0),
    })
  }

  const withQueueMutation = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = queueMutations.get(sessionId) ?? Promise.resolve()
    let done!: () => void
    const current = new Promise<void>((resolve) => {
      done = resolve
    })
    const chain = previous.then(() => current, () => current)
    queueMutations.set(sessionId, chain)
    try {
      await previous.catch(() => {})
      return await fn()
    } finally {
      done()
      if (queueMutations.get(sessionId) === chain) queueMutations.delete(sessionId)
    }
  }

  const claimedQueueMutationError = (claimed: QueuedUserMessage): Error =>
    new Error(`queued message ${claimed.id} is already dispatching`)

  const claimQueueHead = async (sessionId: string): Promise<QueuedUserMessage | undefined> =>
    await withQueueMutation(sessionId, async () => {
      if (closed || claimedQueueOperations.has(sessionId)) return undefined
      if (persistentQueue) {
        const result = await persistentQueue.claimHead(sessionId, `${queueClaimOwner}:${randomUUID()}`, queueClaimTtlMs)
        applyQueueState(sessionId, result.state)
        if (!result.claim) {
          if (result.executionUnknown && !closed) emitQueueUpdate(sessionId)
          return undefined
        }
        let claimed = result.claim.item
        if (claimed.shell && claimed.shell.state !== 'running' && !claimed.shell.result) {
          const shell = { ...claimed.shell, state: 'running' as const }
          const persisted = await persistentQueue.persistShellResult(result.claim, shell)
          applyQueueState(sessionId, persisted.state)
          claimed = { ...claimed, shell }
          result.claim.item = claimed
        }
        persistentQueueClaims.set(sessionId, result.claim)
        claimedQueueOperations.set(sessionId, claimed)
        return claimed
      }
      const next = (await loadQueue(sessionId))[0]
      if (!next) return undefined
      // Capture the exact payload while holding the same lock as edit/delete.
      // The lock is released before runtime I/O; this short-lived claim protects
      // the snapshot until dispatch commits or fails.
      const claimed = {
        ...next,
        ...(next.content ? { content: [...next.content] } : {}),
      }
      if (claimed.shell && claimed.shell.state !== 'running' && !claimed.shell.result) {
        claimed.shell = { ...claimed.shell, state: 'running' }
        const queue = [...await loadQueue(sessionId)]
        queue[0] = claimed
        await persistQueue(sessionId, queue)
      }
      claimedQueueOperations.set(sessionId, claimed)
      return claimed
    }).then((claimed) => {
      if (claimed?.shell?.state === 'running' && !closed) emitQueueUpdate(sessionId)
      return claimed
    })

  const releaseQueueClaim = async (sessionId: string, id: string): Promise<void> => {
    if (claimedQueueOperations.get(sessionId)?.id !== id) return
    const persistentClaim = persistentQueueClaims.get(sessionId)
    if (persistentQueue && persistentClaim) await persistentQueue.releaseClaim(persistentClaim).catch(() => false)
    persistentQueueClaims.delete(sessionId)
    claimedQueueOperations.delete(sessionId)
  }

  const dequeueClaimedQueueHead = async (sessionId: string, claimed: QueuedUserMessage): Promise<boolean> => {
    let changed = false
    await withQueueMutation(sessionId, async () => {
      if (closed) return
      const persistentClaim = persistentQueueClaims.get(sessionId)
      if (persistentQueue && persistentClaim) {
        try {
          const result = await persistentQueue.completeClaim(persistentClaim)
          applyQueueState(sessionId, result.state)
          persistentQueueClaims.delete(sessionId)
          claimedQueueOperations.delete(sessionId)
          changed = result.changed
        } catch (error) {
          if (!(error instanceof QueueClaimFencedError)) throw error
        }
        return
      }
      const queue = [...await loadQueue(sessionId)]
      if (queue[0]?.id !== claimed.id) return
      queue.shift()
      await persistQueue(sessionId, queue)
      await releaseQueueClaim(sessionId, claimed.id)
      changed = true
    })
    if (changed && !closed) emitQueueUpdate(sessionId)
    return changed
  }

  const isClaimedQueueHeadDispatchable = async (sessionId: string, claimed: QueuedUserMessage): Promise<boolean> =>
    await withQueueMutation(sessionId, async () => {
      if (closed) return false
      if (persistentQueue) {
        const persistentClaim = persistentQueueClaims.get(sessionId)
        return persistentClaim?.item.id === claimed.id
          && persistentClaim.item.operationId === claimed.operationId
          && await persistentQueue.confirmClaim(persistentClaim)
      }
      const activeClaim = claimedQueueOperations.get(sessionId)
      if (activeClaim?.id !== claimed.id || activeClaim.operationId !== claimed.operationId) return false
      const queueHead = (await loadQueue(sessionId))[0]
      if (queueHead?.id !== claimed.id || queueHead.operationId !== claimed.operationId) return false
      return !cancelledQueueOperations.get(sessionId)?.has(claimed.operationId)
    })

  const withQueueClaimHeartbeat = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    if (!persistentQueue) return await operation()
    let stopped = false
    let fenced: unknown
    const renew = async (): Promise<void> => {
      const claim = persistentQueueClaims.get(sessionId)
      if (!claim || stopped) return
      try {
        persistentQueueClaims.set(sessionId, await persistentQueue.renewClaim(claim, queueClaimTtlMs))
      } catch (error) {
        fenced = error
      }
    }
    const timer = setInterval(() => { void renew() }, Math.max(10, Math.floor(queueClaimTtlMs / 3)))
    try {
      const result = await operation()
      if (fenced) throw fenced
      return result
    } finally {
      stopped = true
      clearInterval(timer)
    }
  }

  const prepareQueuedDispatch = async (
    sessionId: string,
    record: SessionRecord,
    claimed: QueuedUserMessage,
  ): Promise<{ text: string; operationId: string; content?: readonly import('@agent-kernel/kernel').MessageContent[] } | undefined> => {
    if (!claimed.shell) {
      return { text: claimed.text, operationId: claimed.operationId, ...(claimed.content ? { content: claimed.content } : {}) }
    }
    // PostgreSQL takeover recovery marks an uncertain external effect as
    // unknown. It remains queued for operator inspection/deletion and must
    // never be interpreted as either a result or permission to execute again.
    if (persistentQueue && claimed.shell.state === 'unknown' && !claimed.shell.result) return undefined
    if (!claimed.shell.result) {
      const persistentClaim = persistentQueueClaims.get(sessionId)
      // Shell is an external side effect. Re-check the durable claim immediately
      // before dispatch; a stale process must never execute based on local state.
      if (persistentQueue && (!persistentClaim || !await persistentQueue.confirmClaim(persistentClaim))) return undefined
      const toolResult = record.workspaceId
        ? await executors.callTool(sessionId, {
            kind: 'call_tool',
            callId: bangShellCallId(claimed.operationId),
            name: 'bash',
            input: { command: claimed.shell.command, capture_separate_streams: true },
            cwd: record.state.cwd,
          })
        : { ok: false, content: 'Shell commands require a Session bound to a workspace' }
      const formatted = formatBangShellResult(claimed.shell.command, toolResult, claimed.operationId)
      const resultState = bangShellResultState(toolResult)
      let resultPersisted = false
      await withQueueMutation(sessionId, async () => {
        if (persistentQueue && persistentClaim) {
          try {
            const shell = { ...claimed.shell!, state: resultState, result: formatted }
            const result = await persistentQueue.persistShellResult(persistentQueueClaims.get(sessionId) ?? persistentClaim, shell)
            applyQueueState(sessionId, result.state)
            claimed.shell = shell
            const activeClaim = persistentQueueClaims.get(sessionId)
            if (activeClaim) activeClaim.item = claimed
            resultPersisted = true
          } catch (error) {
            if (!(error instanceof QueueClaimFencedError)) throw error
          }
          return
        }
        const queue = [...await loadQueue(sessionId)]
        const activeClaim = claimedQueueOperations.get(sessionId)
        if (activeClaim?.id !== claimed.id || activeClaim.operationId !== claimed.operationId) return
        if (queue[0]?.id !== claimed.id || queue[0].operationId !== claimed.operationId || !queue[0].shell) return
        if (cancelledQueueOperations.get(sessionId)?.has(claimed.operationId)) return
        queue[0] = { ...queue[0], shell: { ...queue[0].shell, state: resultState, result: formatted } }
        await persistQueue(sessionId, queue)
        claimed.shell = { ...claimed.shell!, state: resultState, result: formatted }
        resultPersisted = true
      })
      if (!resultPersisted) return undefined
      emitQueueUpdate(sessionId)
    }
    return { text: claimed.shell.result!, operationId: bangShellResultOperationId(claimed.operationId) }
  }

  const messageQueues: MessageQueueManager = {
    isStable() {
      return queueLoads.size === 0 && queueMutations.size === 0 && drainingQueues.size === 0
    },
    async waitForStable() {
      while (!messageQueues.isStable()) {
        await Promise.all([...queueLoads.values()].map((pending) => pending.catch(() => [])))
        await Promise.all([...queueMutations.values()].map((pending) => pending.catch(() => undefined)))
        if (drainingQueues.size > 0) await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    async hydrate(sessionId) {
      await loadQueue(sessionId)
    },
    async enqueue(sessionId, msg, priority, attachmentAdmission) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        const queue = [...await loadQueue(sessionId)]
        // operationId survives ACK loss, reconnect and Host restart. A retry is
        // already accepted when it is still queued or has a durable user event.
        const existing = queue.find((item) => item.operationId === msg.operationId)
        if (existing) {
          assertMessageOperationCompatible(existing, msg.text, msg.content)
          return
        }
        if (cancelledQueueOperations.get(sessionId)?.has(msg.operationId)) return
        const committedOperationId = msg.shell ? bangShellResultOperationId(msg.operationId) : msg.operationId
        if (msg.shell) {
          const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
          const committed = await store.findOperation(
            sessionId,
            committedOperationId,
            record.agentRuntime === 'kernel' ? {} : { maxScanBytes: 64 * 1024 * 1024 },
          )
          if (committed?.kind === 'event') {
            if (!isBangShellResultForCommand(committed.event.text, msg.shell.command)) {
              throw new Error(`operationId ${msg.operationId} was already used for a different shell command`)
            }
            return
          }
          if (committed?.kind === 'runtime_metadata') {
            if (committed.action !== 'copilot.user_message' || !isBangShellResultForCommand(committed.text ?? '', msg.shell.command)) {
              throw new Error(`operationId ${msg.operationId} was already used for a different shell command`)
            }
            return
          }
        } else {
          const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
          const committed = await store.findOperation(
            sessionId,
            committedOperationId,
            record.agentRuntime === 'kernel' ? {} : { maxScanBytes: 64 * 1024 * 1024 },
          )
          if (committed?.kind === 'event') {
            assertMessageOperationCompatible(committed.event, msg.text, msg.content)
            return
          }
          if (committed?.kind === 'runtime_metadata') {
            assertCopilotOperationCompatible(committed, msg.text, msg.content)
            return
          }
        }
        const admission = resourceGovernor && resourceUnitId
          ? resourceGovernor.tryEnqueue(resourceUnitId)
          : { ok: true as const }
        if (!admission.ok) throw new Error(`Runtime Unit queue limit exceeded (${admission.code})`)
        if (persistentQueue) {
          try {
            const result = attachmentAdmission === 'atomic-attachments'
              ? await (async () => {
                  if (!(messageAttachments instanceof S3MessageAttachmentStore) || !msg.content) throw new Error('PG/S3 atomic attachment admission is unavailable')
                  const admitted = await messageAttachments.admitQueuedMessage(sessionId, msg.content, msg.operationId,
                    async (transaction) => await persistentQueue.enqueueWithinTransaction(transaction, sessionId, msg, priority === 'front' ? 'front' : 'back'))
                  return admitted ?? { state: await persistentQueue.loadOrInitialize(sessionId,
                    async () => await loadPersistedMessageQueueState(store, sessionId)), changed: false }
                })()
              : await persistentQueue.enqueue(sessionId, msg, priority === 'front' ? 'front' : 'back')
            applyQueueState(sessionId, result.state)
            changed = result.changed
            if (!changed && resourceGovernor && resourceUnitId) resourceGovernor.dequeue(resourceUnitId)
          } catch (error) {
            if (resourceGovernor && resourceUnitId) resourceGovernor.dequeue(resourceUnitId)
            throw error
          }
          return
        }
        if (priority === 'front') {
          const claimed = claimedQueueOperations.get(sessionId)
          let insertAt = 0
          if (claimed) {
            if (queue[0]?.id !== claimed.id || queue[0].operationId !== claimed.operationId) {
              throw new Error(`claimed queue head ${claimed.id} is no longer fixed`)
            }
            insertAt = 1
          }
          // Front-priority STEER messages remain ahead of ordinary QUEUE items,
          // but retain their own arrival order. A claimed head is immutable until
          // its effect and result persistence have crossed the durable boundary.
          while (queue[insertAt]?.mode === 'steer') insertAt += 1
          queue.splice(insertAt, 0, msg)
        } else queue.push(msg)
        try {
          await persistQueue(sessionId, queue)
        } catch (error) {
          if (resourceGovernor && resourceUnitId) resourceGovernor.dequeue(resourceUnitId)
          throw error
        }
        changed = true
      })
      if (changed) emitQueueUpdate(sessionId)
    },
    async reorder(sessionId, id, beforeId) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        if (persistentQueue) {
          await loadQueue(sessionId)
          const result = await persistentQueue.reorder(sessionId, id, beforeId ?? undefined)
          applyQueueState(sessionId, result.state)
          changed = result.changed
          return
        }
        const claimed = claimedQueueOperations.get(sessionId)
        if (claimed && (id === claimed.id || id === claimed.operationId || beforeId === claimed.id || beforeId === claimed.operationId)) {
          throw claimedQueueMutationError(claimed)
        }
        const queue = [...await loadQueue(sessionId)]
        const from = queue.findIndex((item) => item.id === id)
        if (from === -1) return
        const [item] = queue.splice(from, 1)
        if (!item) return
        const to = beforeId ? queue.findIndex((candidate) => candidate.id === beforeId) : -1
        if (to === -1) queue.push(item)
        else queue.splice(to, 0, item)
        await persistQueue(sessionId, queue)
        changed = true
      })
      if (!changed) return
      emitQueueUpdate(sessionId)
    },
    async update(sessionId, id, text, content) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        const claimed = claimedQueueOperations.get(sessionId)
        if (claimed && (id === claimed.id || id === claimed.operationId)) throw claimedQueueMutationError(claimed)
        const queue = [...await loadQueue(sessionId)]
        const index = queue.findIndex((item) => item.id === id)
        if (index === -1) return
        const trimmed = text.trim()
        const current = queue[index]!
        const nextContent = content ?? current.content
        const hasImages = nextContent?.some((part) => part.type === 'image') ?? false
        if (trimmed.length === 0 && !hasImages) return
        const shell = parseBangShellRequest(text)
        if (shell && nextContent?.length) throw new Error('Shell commands cannot include attachments or structured content')
        if (shell && !(store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })).workspaceId) {
          throw new Error('Shell commands require a Session bound to a workspace')
        }
        queue[index] = {
          ...current,
          text: shell ? text : trimmed,
          ...(nextContent ? { content: nextContent } : {}),
          ...(shell ? { shell: { ...shell, state: 'queued' as const } } : { shell: undefined }),
        }
        if (persistentQueue) {
          const result = await persistentQueue.update(sessionId, id, queue[index]!)
          applyQueueState(sessionId, result.state)
          changed = result.changed
          return
        }
        await persistQueue(sessionId, queue)
        changed = true
      })
      if (!changed) return
      emitQueueUpdate(sessionId)
    },
    async delete(sessionId, id) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        if (persistentQueue) {
          await loadQueue(sessionId)
          const result = await persistentQueue.delete(sessionId, id)
          applyQueueState(sessionId, result.state)
          changed = result.changed
          return
        }
        const claimed = claimedQueueOperations.get(sessionId)
        if (claimed && (id === claimed.id || id === claimed.operationId)) throw claimedQueueMutationError(claimed)
        const queue = await loadQueue(sessionId)
        const cancelled = new Set(cancelledQueueOperations.get(sessionId) ?? [])
        const removed = queue.filter((item) => item.id === id || item.operationId === id)
        const next = queue.filter((item) => item.id !== id && item.operationId !== id)
        const cancellationIds = [id, ...removed.map((item) => item.operationId)]
        const addedTombstone = cancellationIds.some((operationId) => !cancelled.has(operationId))
        for (const operationId of cancellationIds) cancelled.add(operationId)
        if (next.length === queue.length && !addedTombstone) return
        await persistQueue(sessionId, next, cancelled)
        changed = next.length !== queue.length
      })
      if (changed) emitQueueUpdate(sessionId)
    },
    async stop(sessionId) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        if (persistentQueue) {
          await loadQueue(sessionId)
          const result = await persistentQueue.stop(sessionId)
          applyQueueState(sessionId, result.state)
          changed = result.changed
          return
        }
        const queue = await loadQueue(sessionId)
        const claimed = claimedQueueOperations.get(sessionId)
        if (queue.length === 0 && !claimed) return
        const cancelled = new Set(cancelledQueueOperations.get(sessionId) ?? [])
        for (const item of queue) cancelled.add(item.operationId)
        if (claimed) cancelled.add(claimed.operationId)
        await persistQueue(sessionId, [], cancelled)
        changed = queue.length > 0
      })
      if (changed) emitQueueUpdate(sessionId)
    },
    pending(sessionId) {
      return queuedMessages.get(sessionId)?.length ?? 0
    },
    snapshot: queueSnapshot,
    async drain(sessionId) {
      if (closed || loop.isDraining()) return
      if (drainingQueues.has(sessionId)) {
        requestedQueueDrains.add(sessionId)
        return
      }
      drainingQueues.add(sessionId)
      try {
        while (!closed) {
          if (loop.isDraining()) return
          await loadQueue(sessionId)
          if ((queuedMessages.get(sessionId)?.length ?? 0) === 0) return
          let record = store.get(sessionId)
          if (!record) {
            try {
              record = await store.load(sessionId)
            } catch {
              return
            }
          }
          // Also serves as restart recovery: a saved organization setting is
          // reconciled before any subsequent model turn, even if an earlier
          // bulk update was interrupted or one Session write failed.
          await ensureEffectiveSystemPrompt(record)
          if (record.agentRuntime !== 'kernel') {
            record = await store.load(sessionId)
            if (!isRestingStatus(record.state.status)) return
            const runtimeRecord = record
            const next = await claimQueueHead(sessionId)
            if (!next || closed) return
            const turnAdmission = resourceGovernor && resourceUnitId
              ? resourceGovernor.tryStartTurn(resourceUnitId)
              : { ok: true as const }
            if (!turnAdmission.ok) {
              await releaseQueueClaim(sessionId, next.id)
              return
            }
            try {
              await withQueueClaimHeartbeat(sessionId, async () => {
                await options.queueDispatchBarrier?.({ sessionId, operationId: next.operationId, runtime: runtimeRecord.agentRuntime })
                if (!await isClaimedQueueHeadDispatchable(sessionId, next)) return
                const dispatch = await prepareQueuedDispatch(sessionId, runtimeRecord, next)
                if (!dispatch) return
                const alreadyDispatched = await sessionUserOperationCursor(store, sessionId, dispatch.operationId) !== undefined
                if (!alreadyDispatched) {
                  const runtime = agentRuntimes?.require(runtimeRecord.agentRuntime)
                  if (!runtime) return
                  await runtime.send(runtimeRecord, {
                    text: dispatch.text,
                    ...(dispatch.content ? { content: dispatch.content } : {}),
                    ...(next.model ?? effectiveModelForSession(sessionId)
                      ? { model: next.model ?? effectiveModelForSession(sessionId) }
                      : {}),
                    operationId: dispatch.operationId,
                    queuedAt: next.createdAt,
                  })
                }
                await dequeueClaimedQueueHead(sessionId, next)
              })
            } finally {
              if (resourceGovernor && resourceUnitId) resourceGovernor.finishTurn(resourceUnitId)
              await releaseQueueClaim(sessionId, next.id)
              for (const queuedSessionId of queuedMessages.keys()) void messageQueues.drain(queuedSessionId)
            }
            continue
          }
          // `state.status` can briefly be `done` while dispatchOne is still
          // unwinding after an LLM/tool effect. Status alone is therefore not a
          // safe queue-drain boundary: dispatching here starts the queued turn
          // before the current serialized turn has actually ended. Wait for the
          // Loop's per-session tail to settle before re-reading state.
          if (loop.hasActiveTurn(sessionId)) {
            await loop.waitForActiveTurn(sessionId)
            if (closed) return
            record = store.get(sessionId)
            if (!record) return
          }
          if (record.state.status === 'thinking' && !loop.hasActiveLlmCall(sessionId)) {
            await loop.recoverInterruptedLlm(sessionId)
            record = store.get(sessionId)
          }
          if (!record || !isRestingStatus(record.state.status)) return
          const next = await claimQueueHead(sessionId)
          if (!next || closed) return
          const turnAdmission = resourceGovernor && resourceUnitId
            ? resourceGovernor.tryStartTurn(resourceUnitId)
            : { ok: true as const }
          if (!turnAdmission.ok) {
            await releaseQueueClaim(sessionId, next.id)
            return
          }
          // Dispatch first and persist the dequeue only after the durable
          // user_message commit. A crash before commit leaves the item queued;
          // a crash after commit is recognized by operationId and only removes
          // the already-dispatched item on recovery.
          const dequeueCommitted = async (): Promise<void> => {
            await dequeueClaimedQueueHead(sessionId, next)
          }
          try {
            await withQueueClaimHeartbeat(sessionId, async () => {
              await options.queueDispatchBarrier?.({ sessionId, operationId: next.operationId, runtime: record.agentRuntime })
              if (!await isClaimedQueueHeadDispatchable(sessionId, next)) return
              const dispatch = await prepareQueuedDispatch(sessionId, record, next)
              if (!dispatch) return
              const alreadyDispatched = await sessionUserOperationCursor(store, sessionId, dispatch.operationId) !== undefined
              if (!alreadyDispatched) {
                await loop.dispatch(sessionId, {
                  kind: 'user_message',
                  operationId: dispatch.operationId,
                  queuedAt: next.createdAt,
                  text: dispatch.text,
                  ...(dispatch.content ? { content: dispatch.content } : {}),
                }, { ...(next.model ? { model: next.model } : {}), onCommitted: dequeueCommitted })
              } else {
                await dequeueCommitted()
              }
            })
          } finally {
            if (resourceGovernor && resourceUnitId) resourceGovernor.finishTurn(resourceUnitId)
            await releaseQueueClaim(sessionId, next.id)
            for (const queuedSessionId of queuedMessages.keys()) void messageQueues.drain(queuedSessionId)
          }
        }
      } catch (error) {
        // An already-admitted drain can reach dispatch after a distributed
        // owner-loss close. Leave its durable queue claim for the successor;
        // do not leak a rejected fire-and-forget drain into the process.
        if (!closed || !options.assertSessionEffectOwner) throw error
      } finally {
        drainingQueues.delete(sessionId)
        if (requestedQueueDrains.delete(sessionId) && !closed && !loop.isDraining()) {
          void messageQueues.drain(sessionId)
        }
      }
    },
  }

  async function sessionUserOperationCursor(
    sessionStore: SessionStore,
    sessionId: string,
    operationId: string,
  ): Promise<number | undefined> {
    const record = sessionStore.get(sessionId)
    if (!record) return undefined
    const operation = await sessionStore.findOperation(
      sessionId,
      operationId,
      record.agentRuntime === 'kernel' ? {} : { maxScanBytes: 64 * 1024 * 1024 },
    )
    if (operation?.kind === 'event') return operation.cursor
    return operation?.kind === 'runtime_metadata' ? record.state.cursor : undefined
  }

  function assertCopilotOperationCompatible(
    existing: Extract<SessionOperationMatch, { kind: 'runtime_metadata' }>,
    text: string,
    content: readonly import('@agent-kernel/kernel').MessageContent[] | undefined,
  ): void {
    if (existing.action !== 'copilot.user_message'
      || existing.requestFingerprint !== messageOperationFingerprint(text, content)) {
      // Legacy Copilot logs contain no content identity. A matching text cannot
      // prove whether the original request also included structured content.
      throw new Error('message operation ID conflict')
    }
  }

  function assertMessageOperationCompatible(
    existing: { text?: string; content?: readonly import('@agent-kernel/kernel').MessageContent[] },
    text: string,
    content: readonly import('@agent-kernel/kernel').MessageContent[] | undefined,
  ): void {
    if ((existing.text ?? '') !== text || JSON.stringify(existing.content ?? []) !== JSON.stringify(content ?? [])) {
      throw new Error('message operation ID conflict')
    }
  }

  // Coalesce `server:sessions` broadcasts. The loop's onEvent fires once per
  // appended event, and during a tool-heavy turn that is dozens of events per
  // second — each one previously ran store.listSummaries() and pushed the full
  // session list to every dashboard, which re-rendered the sidebar and every
  // sessions-derived memo and starved the main thread (the "everything janks
  // while a tool runs" report). Session summaries barely change within a turn
  // (only lastEventAt / status), so we push a leading-edge update immediately
  // and then coalesce the rest to at most one per SESSIONS_BROADCAST_MIN_MS,
  // with a trailing flush so the final state is never missed.
  const SESSIONS_BROADCAST_MIN_MS = 600
  let sessionsBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  let sessionsBroadcastLastMs = 0
  let sessionsBroadcastPending = false
  let sessionsBroadcastAll = false
  const pendingSessionSummaryIds = new Set<string>()
  const flushSessionsBroadcast = (): void => {
    sessionsBroadcastLastMs = Date.now()
    sessionsBroadcastPending = false
    const broadcastAll = sessionsBroadcastAll
    const sessionIds = new Set(pendingSessionSummaryIds)
    sessionsBroadcastAll = false
    pendingSessionSummaryIds.clear()
    void store.listSummaries()
      .then((sessions) => {
        if (broadcastAll) {
          io.of('/dashboard').emit('server:sessions', { sessions })
          return
        }
        const byId = new Map(sessions.map((session) => [session.sessionId, session]))
        for (const sessionId of sessionIds) {
          const session = byId.get(sessionId)
          if (session) io.of('/dashboard').emit('server:control_update', {
            kind: 'session_summary_changed',
            session,
          })
        }
      })
      .catch(() => {})
  }
  const scheduleSessionsBroadcast = (sessionId?: string): void => {
    if (sessionId) pendingSessionSummaryIds.add(sessionId)
    else sessionsBroadcastAll = true
    const now = Date.now()
    const elapsed = now - sessionsBroadcastLastMs
    if (elapsed >= SESSIONS_BROADCAST_MIN_MS && sessionsBroadcastTimer === null) {
      // Leading edge: fire immediately when we haven't broadcast recently.
      flushSessionsBroadcast()
      return
    }
    // Within the throttle window: coalesce into a single trailing broadcast.
    sessionsBroadcastPending = true
    if (sessionsBroadcastTimer === null) {
      const delay = Math.max(0, SESSIONS_BROADCAST_MIN_MS - elapsed)
      sessionsBroadcastTimer = setTimeout(() => {
        sessionsBroadcastTimer = null
        if (sessionsBroadcastPending) flushSessionsBroadcast()
      }, delay)
    }
  }

  const broadcast: LoopBroadcast = {
    onEvent(sessionId, seq, event, effects, state, llmTrace, model, extras) {
      if (event.kind === 'llm_response') {
        metrics.increment('agent_kernel_llm_calls_total', 'LLM calls', { provider: llmTrace?.provider ?? 'unknown', outcome: 'ok' })
        if (event.usage) {
          metrics.increment('agent_kernel_llm_input_tokens_total', 'LLM input tokens', { provider: llmTrace?.provider ?? 'unknown' }, event.usage.inputTokens)
          metrics.increment('agent_kernel_llm_output_tokens_total', 'LLM output tokens', { provider: llmTrace?.provider ?? 'unknown' }, event.usage.outputTokens)
        }
      } else if (event.kind === 'llm_error') {
        metrics.increment('agent_kernel_llm_calls_total', 'LLM calls', { provider: llmTrace?.provider ?? 'unknown', outcome: 'error' })
      }
      // Terminal events must never overtake buffered text on the socket. The
      // Dashboard uses them to clear its live tail and install persisted state.
      if (event.kind === 'llm_response' || event.kind === 'llm_error' || event.kind === 'cancel') {
        flushTokenDelta(sessionId)
        streamingDrafts.delete(sessionId)
      }
      const room = sessionRoom(sessionId)
      const slimEffects = effects.map(slimEffect)
      const hasEffectsArtifact = effects.some((effect) => effect.kind === 'call_llm')
      scheduleSessionsBroadcast(sessionId)
      io.of('/dashboard').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects: slimEffects,
        ...(hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
        ...(llmTrace ? { hasLlmTraceArtifact: true } : {}),
        ...(model ? { model } : {}),
        ...(extras?.timing ? { timing: extras.timing } : {}),
        ...(extras?.compactionMetadata ? { compactionMetadata: extras.compactionMetadata } : {}),
      })
      const recordForContext = store.get(sessionId)
      io.of('/dashboard').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
        contextSnapshot: recordForContext?.runtimeContextSnapshot ?? snapshotFromConfig(
          recordForContext?.config ?? getDefaultConfig(),
          state.messages,
          contextWindowForModel(effectiveModelForSession(sessionId)),
          effectiveModelForSession(sessionId),
        ),
        ...(recordForContext?.turnStartedAt ? { turnStartedAt: recordForContext.turnStartedAt } : {}),
      })
      io.of('/executor').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects: slimEffects,
        ...(hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
        ...(llmTrace ? { hasLlmTraceArtifact: true } : {}),
        ...(model ? { model } : {}),
        ...(extras?.timing ? { timing: extras.timing } : {}),
        ...(extras?.compactionMetadata ? { compactionMetadata: extras.compactionMetadata } : {}),
      })
      io.of('/executor').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
        ...(recordForContext?.turnStartedAt ? { turnStartedAt: recordForContext.turnStartedAt } : {}),
      })
      if (!closed && isRestingStatus(state.status) && messageQueues.pending(sessionId) > 0) {
        setTimeout(() => {
          void messageQueues.drain(sessionId)
        }, 0)
      }
      // Web Push: fire once when a session transitions from running to done —
      // but only if the queue is empty. During an autonomous turn the status
      // briefly hits `done` between steps, and a queued message re-drives the
      // session immediately after. Firing on that transient `done` produced a
      // false "the turn finished, step in" push while work was still ongoing.
      // Requiring an empty queue makes this fire only on a real turn end.
      const prev = lastSessionStatus.get(sessionId)
      lastSessionStatus.set(sessionId, state.status)
      const isSubAgentSession = store.get(sessionId)?.parentSessionId !== undefined
      if (!isSubAgentSession && prev && prev !== 'done' && state.status === 'done' && messageQueues.pending(sessionId) === 0) {
        void pushDispatcher.send({
          kind: 'waiting_for_user',
          sessionId,
          title: 'Session ready for you',
          body: 'The active turn finished. Open the dashboard to continue.',
          url: `/#/sessions/${sessionId}`,
          tag: `waiting_for_user:${sessionId}`,
        })
      }
    },
    onApprovalRequired(sessionId, eff: RequestApprovalEffect) {
      io.of('/dashboard').to(sessionRoom(sessionId)).emit('approval:required', {
        sessionId,
        callId: eff.callId,
        name: eff.name,
        input: eff.input,
      })
      if (store.get(sessionId)?.parentSessionId === undefined) {
        void pushDispatcher.send({
          kind: 'approval_required',
          sessionId,
          title: 'Approval required',
          body: `${eff.name} is waiting for your approval.`,
          url: `/#/sessions/${sessionId}`,
          tag: `approval:${sessionId}:${eff.callId}`,
        })
      }
    },
    onError(sessionId, message) {
      flushTokenDelta(sessionId)
      streamingDrafts.delete(sessionId)
      const payload: SessionErrorEvent = {
        sessionId,
        scope: 'llm',
        message,
      }
      io.of('/dashboard').to(sessionRoom(sessionId)).emit('session:error', payload)
      io.of('/executor').to(sessionRoom(sessionId)).emit('session:error', payload)
      if (store.get(sessionId)?.parentSessionId === undefined) {
        void pushDispatcher.send({
          kind: 'session_error',
          sessionId,
          title: 'Session error',
          // Cap the body — the raw error text can be an unbounded stack trace.
          body: message.length > 240 ? `${message.slice(0, 237)}…` : message,
          url: `/#/sessions/${sessionId}`,
          tag: `error:${sessionId}`,
        })
      }
    },
    onTokenDelta(sessionId, text) {
      if (text.length === 0) return
      const draft = streamingDrafts.get(sessionId)
      if (draft) draft.text += text
      else {
        const state = store.get(sessionId)?.state
        streamingDrafts.set(sessionId, { text, afterSeq: state?.cursor ?? 0, messageCount: state?.messages.length ?? 0 })
      }
      const pending = tokenDeltaBatches.get(sessionId)
      if (pending) {
        pending.text += text
        return
      }
      const timer = setTimeout(() => flushTokenDelta(sessionId), TOKEN_DELTA_BATCH_MS)
      tokenDeltaBatches.set(sessionId, { text, timer })
    },
    onSubAgentStarted(payload) {
      const room = sessionRoom(payload.parentSessionId)
      io.of('/dashboard').to(room).emit('server:control_update', {
        kind: 'sub_agent_started',
        ...payload,
      })
    },
    onSubAgentFinished(payload) {
      const room = sessionRoom(payload.parentSessionId)
      io.of('/dashboard').to(room).emit('server:control_update', {
        kind: 'sub_agent_finished',
        ...payload,
      })
    },
    onCompactStatus(payload) {
      io.of('/dashboard').to(sessionRoom(payload.sessionId)).emit('server:compact_status', payload)
    },
  }

  const skills = options.skills ?? createSkillManager(store, getDefaultConfig(), executors)
  const askUserChoice = new AskUserChoiceBroker()
  const publishLocalImages = createLocalImagePublisher({
    artifacts: sessionArtifacts,
    reader: async (input) => await executors.publishLocalImage(input),
    ...(effectiveStorageQuota ? {
      assertCanStore: async (record, bytes) => {
        if (!record.organizationId) throw new Error('tenant_attribution_missing')
        await effectiveStorageQuota.assertCanStoreArtifact({
          organizationId: record.organizationId,
          sessionId: record.sessionId,
          kind: 'session_artifact',
          bytes,
        })
      },
    } : {}),
  })

  const extensions = createBuiltinExtensionRegistry(options.extensions)
  const loopDeps: HostLoopDeps = {
    store,
    llm: options.llm,
    ...(options.llmQuota !== undefined ? { llmQuota: options.llmQuota } : {}),
    ...(options.modelPolicy !== undefined ? { modelPolicy: options.modelPolicy } : {}),
    tools: executors,
    ...(options.assertSessionEffectOwner ? { assertSessionEffectOwner: options.assertSessionEffectOwner } : {}),
    broadcast,
    models: {
      get: effectiveModelForSession,
      contextWindow: (sessionId: string) => contextWindowForModel(effectiveModelForSession(sessionId))?.contextWindow,
    },
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.hookRunner !== undefined ? { hookRunner: options.hookRunner } : {}),
    skills,
    ...(options.webSearchCredentials ? { webSearchCredentials: options.webSearchCredentials } : {}),
    audit,
    ...(options.artifactRootDir ? { artifactRootDir: options.artifactRootDir } : {}),
    messageAttachments,
    askUserChoice,
    dagStore,
    dagWorkerConfig: () => {
      const config = getDefaultConfig()
      return {
        ...config,
        tools: [
          ...config.tools.filter((tool) => tool.name !== 'agent' && tool.name !== 'dag_plan' && !tool.name.startsWith('dag_')),
          ...DAG_WORKER_TOOLS,
        ],
      }
    },
    dagScheduler: {
      schedule: (parentSessionId) => dagOrchestrator?.schedule(parentSessionId),
    },
    publishDagRun: (parentSessionId) => {
      void Promise.resolve(dagStore.runForSession(parentSessionId)).then((run) => {
        dashboardNs.to(sessionRoom(parentSessionId)).emit('server:dag_run', {
          sessionId: parentSessionId,
          run: run ?? null,
        })
      }).catch((error: unknown) => broadcast.onError(parentSessionId, error instanceof Error ? error.message : String(error)))
    },
    publishLocalImages,
    extensions,
  }
  loop = runHostLoop(loopDeps)
  agentRuntimes = new AgentRuntimeRegistry()
  agentRuntimes.register(new KernelAgentRuntime(loop, store))
  const runtimeController: SubAgentRuntimeController = {
    async send(record, text, model) {
      await ensureEffectiveSystemPrompt(record)
      await agentRuntimes!.require(record.agentRuntime).send(record, {
        text,
        ...(model ? { model } : {}),
      })
    },
    async cancel(record) {
      await agentRuntimes!.require(record.agentRuntime).cancel(record)
    },
  }
  const copilotTools = createRuntimeToolDispatcher(loopDeps, executors, loop, runtimeController)
  const copilotRuntime = new CopilotAgentRuntime({
    store,
    tools: copilotTools,
    ...(options.assertSessionEffectOwner ? { assertSessionEffectOwner: options.assertSessionEffectOwner } : {}),
    messageAttachments,
    publishLocalImages,
    broadcast: {
      onState(record, state, runtimeContextSnapshot) {
        scheduleSessionsBroadcast(record.sessionId)
        const room = sessionRoom(record.sessionId)
        if (runtimeContextSnapshot) {
          void store.updateRuntimeContextSnapshot(record, runtimeContextSnapshot).catch((error) => {
            broadcast.onError(record.sessionId, error instanceof Error ? error.message : String(error))
          })
        }
        const contextSnapshot = runtimeContextSnapshot ?? record.runtimeContextSnapshot ?? snapshotFromConfig(
          record.config,
          state.messages,
          contextWindowForModel(effectiveModelForSession(record.sessionId)),
          effectiveModelForSession(record.sessionId),
        )
        dashboardNs.to(room).emit('state:changed', {
          sessionId: record.sessionId,
          cursor: state.cursor,
          state,
          contextSnapshot,
          ...(record.turnStartedAt ? { turnStartedAt: record.turnStartedAt } : {}),
        })
      },
      onTokenDelta(sessionId, text) {
        broadcast.onTokenDelta?.(sessionId, text)
      },
      onApprovalRequired(sessionId) {
        const call = store.get(sessionId)?.state.pendingCalls.find((candidate) => candidate.status === 'awaiting_approval')
        if (!call) return
        broadcast.onApprovalRequired(sessionId, {
          kind: 'request_approval',
          callId: call.callId,
          name: call.name,
          input: call.input,
          ...(call.intent ? { intent: call.intent } : {}),
        })
      },
      onError(sessionId, message) {
        broadcast.onError(sessionId, message)
      },
      onCompactStatus(payload) {
        broadcast.onCompactStatus?.(payload)
      },
    },
  }, {
    // Enabled by default. Operators can explicitly opt out without making an
    // installed SDK depend on an undocumented per-machine environment variable.
    enabled: options.copilot?.enabled ?? !['0', 'false'].includes((process.env.KALA_COPILOT_ENABLED ?? '').trim().toLowerCase()),
    sessionsDir: options.sessionsDir,
    ...(options.copilot?.gitHubToken ?? process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
      ? { gitHubToken: options.copilot?.gitHubToken ?? process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN }
      : {}),
    ...(options.copilot?.backgroundCompactionThreshold !== undefined
      ? { backgroundCompactionThreshold: options.copilot.backgroundCompactionThreshold }
      : {}),
    ...(options.copilot?.bufferExhaustionThreshold !== undefined
      ? { bufferExhaustionThreshold: options.copilot.bufferExhaustionThreshold }
      : {}),
  })
  await copilotRuntime.start()
  agentRuntimes.register(copilotRuntime)
  dagOrchestrator = new DagOrchestrator(dagStore, loopDeps, loop, runtimeController)
  for (const sessionId of await dagStore.activeParentSessionIds()) dagOrchestrator.schedule(sessionId)
  const loadApiRecord = async (sessionId: string): Promise<SessionRecord | undefined> => {
    const loaded = store.get(sessionId)
    if (loaded) return loaded
    try {
      return await store.load(sessionId, { recoverDangling: false })
    } catch (error) {
      if (error instanceof SessionNotFoundError) return undefined
      throw error
    }
  }
  const apiRecord = async (actor: PublicApiActor, sessionId: string): Promise<SessionRecord | undefined> => {
    const record = await loadApiRecord(sessionId)
    if (!record) return undefined
    if (actor.organizationId) {
      if (record.organizationId !== actor.organizationId) return undefined
    } else if (record.organizationId) {
      // Portable identities share their local Unit because legacy Sessions have no
      // principal owner, but they can never cross into an organization Unit.
      return undefined
    }
    return record
  }
  const apiSession = async (actor: PublicApiActor, sessionId: string) => {
    const record = await apiRecord(actor, sessionId)
    if (!record) return undefined
    const summary = (await store.listSummaries()).find((candidate) => candidate.sessionId === sessionId)
    return summary ? { summary, state: record.state } : undefined
  }
  const apiAuditActor = (actor: PublicApiActor): import('./audit-log.js').AuditActor =>
    actor.organizationId && actor.role
      ? { kind: 'ingress', principal: actor.principal, organizationId: actor.organizationId, role: actor.role }
      : { kind: 'token', label: actor.principal }
  const scheduleOwnerKey = (actor: PublicApiActor): string => actor.organizationId ? `organization:${actor.organizationId}` : `principal:${actor.principal}`
  const validateScheduledTarget = async (actor: PublicApiActor, task: Pick<ScheduledTask, 'target'>): Promise<void> => {
    if (task.target.kind === 'session') {
      if (!await apiRecord(actor, task.target.sessionId)) throw new Error('session not found')
      return
    }
    const target = task.target
    // Executor announcements do not carry authoritative Unit ownership. Fail closed
    // unless an existing Session registry entry binds this workspace to the actor's Unit.
    const summaries = await store.listSummaries()
    let workspaceOwned = false
    for (const summary of summaries) {
      if (summary.workspaceId !== target.workspaceId) continue
      if (await apiRecord(actor, summary.sessionId)) { workspaceOwned = true; break }
    }
    if (!workspaceOwned) throw new Error('workspace not found')
    const executor = executors.snapshot().find((candidate) => candidate.workspaceId === target.workspaceId)
    if (!executor) throw new Error('workspace offline')
    if (target.cwd) {
      const validation = await validateWorkspaceCwd({ executors }, target.workspaceId, target.cwd)
      if (!validation.ok) throw new Error(validation.reason)
    }
  }
  const scheduledActor = (task: ScheduledTaskSnapshot): PublicApiActor => {
    const organizationId = task.ownerKey.startsWith('organization:') ? task.ownerKey.slice('organization:'.length) : undefined
    return {
      principal: task.createdBy,
      canWrite: true,
      ...(organizationId ? { organizationId, role: 'member' as const } : {}),
    }
  }
  const scheduledTaskStore = options.scheduledTaskStore ?? new ScheduledTaskStore(join(options.sessionsDir, '.scheduled-tasks'))
  scheduledTaskScheduler = new UnitScheduler(scheduledTaskStore, {
    async validate(task) {
      await validateScheduledTarget(scheduledActor(task), task)
    },
    async receipt(run, task) {
      const sessionId = task.target.kind === 'session' ? task.target.sessionId : occurrenceSessionId(run.occurrenceId)
      const record = await loadApiRecord(sessionId)
      if (!record) return task.target.kind === 'workspace' ? 'absent' : 'unknown'
      const operation = await store.findOperation(sessionId, run.operationId, record.agentRuntime === 'kernel' ? {} : { maxScanBytes: 64 * 1024 * 1024 })
      if (operation) return 'committed'
      // The durable message queue also de-duplicates this operation ID. An absent
      // Session receipt is therefore safe to retry locally with the same ID.
      return 'absent'
    },
    async enqueueSession(input) {
      const organizationId = input.task.ownerKey.startsWith('organization:') ? input.task.ownerKey.slice('organization:'.length) : undefined
      if (options.queueQuota) {
        if (!organizationId) throw new Error('missing organization attribution for scheduled queue quota')
        await options.queueQuota.assertCanEnqueueMessage({
          organizationId, principal: input.task.createdBy, role: 'member',
          sessionId: input.sessionId, pendingMessages: messageQueues.pending(input.sessionId), mode: 'queue',
        })
      }
      await enqueueUserMessage({ sessionId: input.sessionId, text: input.prompt, intent: 'text', operationId: input.operationId, mode: 'queue' })
    },
    async createWorkspaceSession({ sessionId, task, operationId }) {
      if (task.target.kind !== 'workspace') throw new Error('invalid workspace occurrence target')
      const target = task.target
      const executor = executors.snapshot().find((candidate) => candidate.workspaceId === target.workspaceId)
      if (!executor) throw new Error('workspace offline')
      let cwd = target.cwd
      if (cwd) {
        const validation = await validateWorkspaceCwd({ executors }, target.workspaceId, cwd)
        if (!validation.ok) throw new Error(validation.reason)
        cwd = validation.cwd
      }
      const organizationId = task.ownerKey.startsWith('organization:') ? task.ownerKey.slice('organization:'.length) : undefined
      if (options.sessionQuota && !await loadApiRecord(sessionId)) {
        if (!organizationId) throw new Error('missing organization attribution for scheduled session quota')
        await options.sessionQuota.assertCanCreateSession({ organizationId, principal: task.createdBy, role: 'member', sessionId })
      }
      if (options.queueQuota) {
        if (!organizationId) throw new Error('missing organization attribution for scheduled queue quota')
        await options.queueQuota.assertCanEnqueueMessage({
          organizationId, principal: task.createdBy, role: 'member', sessionId,
          pendingMessages: messageQueues.pending(sessionId), mode: 'queue',
        })
      }
      const config = deriveSessionConfig(mergeMcpTools(getDefaultConfig(organizationId
        ? { kind: 'ingress', organizationId, principal: task.createdBy, role: 'member' }
        : undefined), mcpToolsForWorkspace(executors.snapshot(), target.workspaceId)), undefined, 'chat')
      const { record, created } = await store.ensure({
        sessionId, agentRuntime: 'kernel', executionMode: 'chat', defaultConfig: config, runtimeConfig: config,
        workspaceId: target.workspaceId,
        ...(target.workspaceName ? { workspaceName: target.workspaceName } : {}),
        ...(organizationId ? { organizationId, principal: task.createdBy, organizationRole: 'member' as const } : {}),
        ...(cwd ? { initialCwd: cwd } : {}),
      })
      if (record.workspaceId !== target.workspaceId || (organizationId && record.organizationId !== organizationId)) throw new Error('scheduled occurrence Session conflict')
      if (created) {
        await extensions.sessionCreated({ deps: loopDeps, record }).catch(() => undefined)
        scheduleSessionsBroadcast()
      }
      await enqueueUserMessage({ sessionId, text: task.prompt, intent: 'text', operationId, mode: 'queue' })
    },
  }, { unitId: options.resourceUnitId ?? 'local', catchupLimit: 10 })
  publicApiHandler = createPublicApiHandler({
    authorize(request) {
      const authorization = request.headers.authorization
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
      const result = authenticateDashboardHandshake(
        { role: 'dashboard', clientVersion: 'http-api-v1', ...(token ? { token } : {}) },
        request,
        auth,
      )
      if (!result.ok) return { ok: false, status: 401, code: 'authentication_required' }
      if (result.actor.kind === 'ingress') {
        if (effectiveTenancy(deployment) !== 'multi-tenant') {
          return { ok: false, status: 401, code: 'authentication_required' }
        }
        return {
          ok: true,
          actor: {
            principal: result.actor.principal,
            organizationId: result.actor.organizationId,
            role: result.actor.role,
            canWrite: result.actor.role !== 'viewer',
          },
        }
      }
      if (result.actor.kind === 'github_user') {
        return { ok: true, actor: { principal: result.actor.login, canWrite: true } }
      }
      return { ok: true, actor: { principal: result.actor.kind, canWrite: true } }
    },
    async listSessions(actor) {
      const summaries = await store.listSummaries()
      if (!actor.organizationId) return summaries.map((summary) => ({ summary }))
      const visible = []
      for (const summary of summaries) {
        const record = await apiRecord(actor, summary.sessionId)
        if (record) visible.push({ summary })
      }
      return visible
    },
    getSession: apiSession,
    async createSession(actor, input) {
      const executionMode = input.executionMode ?? 'chat'
      if (!extensions.getSessionMode(executionMode)) throw new Error(`unsupported session execution mode: ${executionMode}`)
      const selectedModel = input.selectedModel?.trim()
      const normalizedSelectedModel = selectedModel ? normalizeModelRef(selectedModel) : undefined
      if (selectedModel && !normalizedSelectedModel) throw new Error(`unknown or ambiguous model: ${selectedModel}`)
      const persisted = await loadApiRecord(input.sessionId)
      if (persisted) {
        if (actor.organizationId && persisted.organizationId !== actor.organizationId) {
          throw new Error('session id conflict')
        }
        if (persisted.executionMode !== executionMode
          || (input.workspaceId !== undefined && persisted.workspaceId !== input.workspaceId)
          || (input.workspaceName !== undefined && persisted.workspaceName !== input.workspaceName)
          || (input.cwd !== undefined && persisted.state.cwd !== input.cwd)
          || (normalizedSelectedModel !== undefined && persisted.preferences.selectedModel !== normalizedSelectedModel)) {
          throw new Error('session create idempotency conflict')
        }
        return { session: (await apiSession(actor, input.sessionId))!, created: false }
      }
      if (normalizedSelectedModel && options.modelPolicy) {
        if (!actor.organizationId) throw new Error('missing organization attribution for model policy enforcement')
        await options.modelPolicy.assertCanUseModel({
          organizationId: actor.organizationId,
          sessionId: input.sessionId,
          model: normalizedSelectedModel,
          principal: actor.principal,
        })
      }
      let cwd = input.cwd?.trim()
      if (cwd && input.workspaceId) {
        const validation = await validateWorkspaceCwd({ executors }, input.workspaceId, cwd)
        if (!validation.ok) throw new Error(validation.reason)
        cwd = validation.cwd
      }
      if (options.sessionQuota) {
        if (!actor.organizationId || !actor.role) throw new Error('missing organization attribution for session quota enforcement')
        await options.sessionQuota.assertCanCreateSession({
          organizationId: actor.organizationId,
          principal: actor.principal,
          role: actor.role,
          sessionId: input.sessionId,
        })
      }
      const config = deriveSessionConfig(mergeMcpTools(getDefaultConfig(actor.organizationId && actor.role
        ? { kind: 'ingress', organizationId: actor.organizationId, principal: actor.principal, role: actor.role }
        : undefined), mcpToolsForWorkspace(executors.snapshot(), input.workspaceId)), undefined, executionMode)
      const { record, created } = await store.ensure({
        sessionId: input.sessionId,
        agentRuntime: 'kernel',
        executionMode,
        defaultConfig: config,
        runtimeConfig: config,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
        ...(actor.organizationId && actor.role ? {
          organizationId: actor.organizationId,
          principal: actor.principal,
          organizationRole: actor.role,
        } : {}),
        ...(cwd ? { initialCwd: cwd } : {}),
        ...(normalizedSelectedModel ? { preferences: { selectedModel: normalizedSelectedModel } } : {}),
      })
      if (created) {
        await extensions.sessionCreated({ deps: loopDeps, record }).catch(() => undefined)
        scheduleSessionsBroadcast()
      }
      audit.log({
        action: 'public_api.session_create',
        actor: apiAuditActor(actor),
        target: { sessionId: record.sessionId, workspaceId: record.workspaceId },
        outcome: 'ok',
        refs: { operationId: input.operationId },
      })
      return { session: (await apiSession(actor, record.sessionId))!, created }
    },
    async deleteSession(actor, sessionId, operationId) {
      const root = await apiRecord(actor, sessionId)
      if (!root) {
        if (store.usesExternalAuthority && actor.organizationId) {
          await store.finishRequestedDeletion(sessionId, actor.organizationId)
        }
        return
      }
      const targetIds = collectSessionDescendants(await store.listSummaries(), sessionId)
      for (const targetSessionId of targetIds) {
        // A different replica may own a descendant even when this Runtime has
        // no local turn. Refuse the whole tree before pausing tasks or making
        // any external cleanup request unless every Session is locally owned.
        await options.assertSessionEffectOwner?.(targetSessionId)
        if (loop.hasActiveTurn(targetSessionId)) throw new Error('session tree has an active turn; stop it before deleting')
      }
      await scheduledTaskStore.pauseSessionTargets(scheduleOwnerKey(actor), new Set(targetIds))
      for (const targetSessionId of targetIds.reverse()) {
        await options.assertSessionEffectOwner?.(targetSessionId)
        const record = await apiRecord(actor, targetSessionId)
        if (store.usesExternalAuthority && !await store.requestDeletion(targetSessionId)) continue
        await messageQueues.stop(targetSessionId)
        await executors.cancelPending(targetSessionId)
        if (!record) {
          await store.delete(targetSessionId)
          continue
        }
        await agentRuntimes!.get(record.agentRuntime)?.delete?.(record)
        await extensions.sessionDeleted({ deps: loopDeps, record }).catch(() => undefined)
        if (record.workspaceId) {
          executors.closeSessionTerminals({ workspaceId: record.workspaceId, sessionId: targetSessionId })
          await executors.deleteOverflowSession(record.workspaceId, targetSessionId).catch(() => undefined)
        }
        await store.delete(targetSessionId)
        resetCompactRuntime(targetSessionId)
        dashboardNs.emit('server:session_deleted', { sessionId: targetSessionId })
      }
      audit.log({
        action: 'public_api.session_delete',
        actor: apiAuditActor(actor),
        target: { sessionId },
        outcome: 'ok',
        refs: { operationId },
      })
      scheduleSessionsBroadcast()
    },
    async sendMessage(actor, sessionId, input) {
      if (!await apiRecord(actor, sessionId)) throw new Error('session not found')
      return await enqueueUserMessage({
        sessionId,
        text: input.text,
        intent: 'text',
        operationId: input.operationId,
        mode: input.mode ?? 'queue',
        ...(input.content ? { content: input.content } : {}),
      })
    },
    async getDagRun(actor, sessionId) {
      if (!await apiRecord(actor, sessionId)) throw new Error('session not found')
      return await dagStore.runForSession(sessionId) ?? null
    },
    async answerDagDecision(actor, sessionId, decisionId, input) {
      if (!await apiRecord(actor, sessionId)) throw new Error('session not found')
      const run = await dagStore.runForSession(sessionId)
      if (!run) throw new Error('DAG run does not exist')
      const updated = await dagStore.answerDecision(run.id, decisionId, input.answer, input.operationId)
      dagOrchestrator?.schedule(sessionId)
      dashboardNs.to(sessionRoom(sessionId)).emit('server:dag_run', { sessionId, run: updated })
      return updated
    },
    scheduledTasks: {
      list: async (actor) => await scheduledTaskStore.listTasks(scheduleOwnerKey(actor)),
      get: async (actor, taskId) => await scheduledTaskStore.getTask(scheduleOwnerKey(actor), taskId),
      async create(actor, input) {
        await validateScheduledTarget(actor, input)
        return await scheduledTaskStore.create({ ...input, ownerKey: scheduleOwnerKey(actor), createdBy: actor.principal })
      },
      async update(actor, taskId, input) {
        const existing = await scheduledTaskStore.getTask(scheduleOwnerKey(actor), taskId)
        if (!existing) throw new Error('scheduled task not found')
        if (input.target) await validateScheduledTarget(actor, { target: input.target })
        return await scheduledTaskStore.update(scheduleOwnerKey(actor), taskId, input)
      },
      pause: async (actor, taskId, paused) => await scheduledTaskStore.setPaused(scheduleOwnerKey(actor), taskId, paused),
      delete: async (actor, taskId) => await scheduledTaskStore.delete(scheduleOwnerKey(actor), taskId),
      history: async (actor, taskId) => await scheduledTaskStore.history(scheduleOwnerKey(actor), taskId),
      origins: async (actor, sessionId) => await scheduledTaskStore.origins(scheduleOwnerKey(actor), sessionId),
      inbox: async (actor) => await scheduledTaskStore.inbox(scheduleOwnerKey(actor), actor.principal),
      markInboxSeen: async (actor, occurrenceIds) => await scheduledTaskStore.markInboxSeen(scheduleOwnerKey(actor), actor.principal, occurrenceIds),
    },
    onInternalError(error, requestId) {
      options.logger?.warn({
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }, 'public API request failed')
    },
  })
  await scheduledTaskScheduler.start()
  if (!options.sessionAuthority) restart = new RestartCoordinator({
    store,
    loop,
    statePath: defaultRestartStatePath(options.sessionsDir),
    emit: (event) => {
      dashboardNs.emit('server:control_update', {
        kind: 'host_restart',
        ...event,
      })
    },
    ...(options.invalidateReadiness ? { invalidateReadiness: options.invalidateReadiness } : {}),
    closeServer,
    ...(options.restartShutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: options.restartShutdownTimeoutMs } : {}),
    ...(options.expectedDeployment ? { expectedDeployment: options.expectedDeployment } : {}),
    queuedMessages: (sessionId) => messageQueues.pending(sessionId),
    hydrateQueue: async (sessionId) => await messageQueues.hydrate(sessionId),
    drainQueue: async (sessionId) => await messageQueues.drain(sessionId),
    waitForQueueStable: async () => await messageQueues.waitForStable(),
    waitForContinuationDependencies: async (plan) => {
      if (plan.checkpointKind !== 'before_tool_dispatch') return
      const record = store.get(plan.sessionId)
      const needsExecutor = record?.state.pendingCalls.some((call) => {
        const tool = record.config.tools.find((candidate) => candidate.name === call.name)
        return call.name !== 'websearch' && (tool?.executionKind ?? 'executor') === 'executor'
      }) ?? false
      if (!needsExecutor) return
      if (!await executors.waitForSessionExecutor(plan.sessionId)) {
        throw new Error(`planned continuation Executor reconnect deadline exceeded for ${plan.sessionId}`)
      }
    },
  })

  configureDashboardNamespace(dashboardNs, {
    store,
    loop,
    loopDeps,
    executors,
    defaultConfig: getDefaultConfig,
    ...(auth ? { auth } : {}),
    audit,
    ...(options.sessionQuota !== undefined ? { sessionQuota: options.sessionQuota } : {}),
    ...(options.queueQuota !== undefined ? { queueQuota: options.queueQuota } : {}),
    ...(options.modelPolicy !== undefined ? { modelPolicy: options.modelPolicy } : {}),
    allowAllApprovalMode: options.allowAllApprovalMode ?? true,
    broadcastError,
    contextWindowForModel,
    effectiveDefaultModel,
    effectiveModelForSession: (record) => effectiveModelForSession(record.sessionId),
    normalizeModelRef,
    dashboardNs,
    // Drain pending deltas before taking the synchronous ready snapshot. New
    // subscribers ignore pre-ready deltas; existing subscribers receive them.
    streamingDraftSnapshot: (sessionId) => {
      flushTokenDelta(sessionId)
      return streamingDrafts.get(sessionId)
    },
    messageQueues,
    agentRuntimes,
    askUserChoice,
    dagStore,
    storageInventory,
    safeCleanup,
    executorSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
    renameWorkspace: async (workspaceId, workspaceName) => {
      const applied = await workspaceAliases.rename(workspaceId, workspaceName)
      await store.renameWorkspace(workspaceId, applied)
      executors.renameWorkspace(workspaceId, applied)
      return applied
    },
    ...(options.mutableReady ? { mutableReady: options.mutableReady } : {}),
    onSessionCreated: (record) => extensions.sessionCreated({ deps: loopDeps, record }),
    onSessionDeleted: (record) => extensions.sessionDeleted({ deps: loopDeps, record }),
  })
  configureExecutorNamespace(executorNs, {
    store,
    executors,
    defaultConfig: getDefaultConfig,
    ...(auth ? { auth } : {}),
    installations: executorInstallations,
    ...(options.executorQuota ? { executorQuota: options.executorQuota } : {}),
    audit,
    broadcastError,
    dashboardNs,
  })

  // Executor attach/detach/updated events fan out to every connected
  // dashboard socket (not scoped to a session room) — the Workspaces column
  // shows all daemons, not just the one for the currently-selected session.
  executors.onChange((change) => {
    const effectiveChange = 'executor' in change
      ? { ...change, executor: workspaceAliases.apply(change.executor) }
      : change
    dashboardNs.emit('server:control_update', {
      kind: 'executor_changed',
      ...effectiveChange,
    })
  })

  function broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void {
    const payload: SessionErrorEvent = { sessionId, scope, message }
    dashboardNs.to(sessionRoom(sessionId)).emit('session:error', payload)
    // Executor no longer subscribes to session:error — it's UI-only.
  }

  await new Promise<void>((resolve, reject) => {
    if (http.listening) {
      resolve()
      return
    }
    const onError = (err: NodeJS.ErrnoException): void => {
      http.off('listening', onListening)
      const message = err.code === 'EADDRINUSE'
        ? `Port ${options.port} is already in use. Stop the process using it or start the host with KALA_PORT=<free-port> or --port <free-port>.`
        : `Failed to start host on port ${options.port}: ${err.message}`
      const wrapped = new Error(message)
      wrapped.cause = err
      reject(wrapped)
    }
    const onListening = (): void => {
      http.off('error', onError)
      resolve()
    }
    http.once('error', onError)
    http.listen(options.port, options.listenHost, onListening)
  })
  const addr = http.address()
  const port =
    typeof addr === 'object' && addr && 'port' in addr ? addr.port : options.port
  await options.onProcessReady?.({ pid: process.pid, port, readyAt: new Date().toISOString() })

  // The private listener must exist before planned continuation: a checkpoint
  // at before_tool_dispatch may need Executors to reconnect to this candidate.
  // Dashboard mutation remains fenced by mutableReady until the Supervisor's
  // final route commit, while the Executor namespace can settle continuation.
  await restart?.resumeMarkedSessions()

  // Reconcile persisted Sessions only after the listener and runtime services
  // are available. Residual failures remain pending until storage recovers.
  void retryPromptSynchronizations()

  return {
    io,
    http,
    loop,
    store,
    executorsSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
    restartStatus: () => restart?.status() ?? restartUnavailableStatus(),
    port,
    close: closeServer,
  }
}

const WINDOWS_INSTALL_RELEASE_ASSETS = Object.freeze([
  'kala-executor-win32-x64.exe',
  'kala-executor-service-host-win32-x64.exe',
  'node-pty-win32-x64.tar.gz',
  'install-executor.ps1',
])

function hasIntegrityCheckedWindowsReleaseAssets(
  releaseAssetsDir: string | undefined,
  embeddedReleaseAssets: readonly EmbeddedStaticAsset[] | undefined,
): boolean {
  const embedded = new Map((embeddedReleaseAssets ?? []).map((asset) => [asset.path.replaceAll('\\', '/').replace(/^\/+/, ''), asset]))
  const assetBytes = (name: string): Buffer | undefined => {
    if (releaseAssetsDir) {
      const path = join(releaseAssetsDir, name)
      try {
        if (existsSync(path) && statSync(path).isFile()) return readFileSync(path)
      } catch { return undefined }
    }
    const asset = embedded.get(name)
    if (!asset) return undefined
    try { return Buffer.from(asset.contentBase64, 'base64') } catch { return undefined }
  }

  const index = assetBytes('SHA256SUMS')?.toString('utf8')
  if (!index) return false
  const expected = new Map<string, string>()
  for (const line of index.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([0-9a-fA-F]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u)
    if (!match) return false
    const sha256 = match[1]!
    const name = match[2]!
    if (expected.has(name)) return false
    expected.set(name, sha256.toLowerCase())
  }
  for (const name of WINDOWS_INSTALL_RELEASE_ASSETS) {
    const bytes = assetBytes(name)
    const sha256 = expected.get(name)
    if (!bytes || !sha256 || createHash('sha256').update(bytes).digest('hex') !== sha256) return false
  }
  return true
}
