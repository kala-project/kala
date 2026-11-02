#!/usr/bin/env node
/**
 * `kala-host` CLI.
 *
 * The runtime config is read from two operator-owned files:
 *
 *   `~/.claude/settings.json` — Anthropic base URL, model names, API key
 *     (either verbatim in `env` or produced by an `apiKeyHelper` shell hook).
 *   `~/.codex/config.toml`    — default model + one block per
 *     OpenAI-compatible provider (each with `base_url`, `env_key`).
 *
 * Falls back to the classic `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars
 * if neither file is present. The CLI never persists secrets — API keys stay
 * in-memory on the adapter objects; only sanitized `ModelInfo` is served over
 * HTTP (`GET /models`).
 *
 * Other env vars:
 *   KALA_PORT          — default 3000
 *   KALA_SESSIONS_DIR       — default ~/.kala/sessions
 *   KALA_AUTH_TOKEN    — optional; when set, clients must supply it in auth
 *   KALA_GITHUB_OAUTH_REQUIRED — set to 1 to require GitHub OAuth for dashboard/HTTP
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_OAUTH_CALLBACK_URL
 *   GITHUB_USERNAME_WHITELIST — optional comma-separated GitHub login allowlist
 *   KALA_AUTH_SESSION_SECRET — HMAC secret for dashboard login cookies
 *   KALA_EXECUTOR_TOKENS    — optional JSON array of {token, workspaceId?, label?}
 *   KALA_EXECUTOR_IDENTITIES — default ~/.kala/executor-identities.json
 *   KALA_AUDIT_DIR     — default ~/.kala/audit
 *   HOST_MODEL         — hard override for the default model
 *   KALA_RELEASE_BASE_URL — optional executor bootstrap asset base URL
 *   KALA_RELEASE_ASSETS_DIR — optional local release asset directory
 *   KALA_UPDATE_REPO / KALA_RELEASE_TAG — GitHub Release source
 */

import { homedir } from 'node:os'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ManualModelInput, ManualProviderInput, ModelInfo, ServerSettingsPayload } from '@agent-kernel/shared'
import { AGENT_RUNTIME_CAPABILITIES, FULL_RUNTIME_CAPABILITIES, PROTOCOL_VERSION, parsePublicUrls, productVariant } from '@agent-kernel/shared'
import bcrypt from 'bcryptjs'

import packageJson from '../package.json' with { type: 'json' }
import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import { policyGatewayAdapter } from '../src/llm/policy-gateway.js'
import {
  createProviderHealthRegistry,
  writeFallbackArtifact,
  type ProviderHealthRegistry,
} from '../src/llm/provider-health.js'
import { routerAdapter, toFallbackArtifact, type MutableRouter } from '../src/llm/router.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { resolveBuiltinAgentModule } from '../src/builtin-tools.js'
import { createHookRunner } from '../src/extensions/hooks.js'
import { createRuntimeLogger } from '../src/logger.js'
import {
  defaultAgentSettingsPath,
  loadAgentRuntimeSettings,
  loadHookConfigs,
  loadRuntimeConfig,
  modelInfo,
  modelRef,
  organizationAgentSettingsPath,
  type ProviderSpec,
  writeAgentRuntimeSettings,
  writeManualConfig,
} from '../src/runtime-config.js'
import { startHostServer } from '../src/server.js'
import { selectPortableInstallation } from '../src/store/portable-installation.js'
import { SqliteSessionAuthority } from '../src/store/sqlite-session-authority.js'
import { nativeFsLimitsFromEnv } from '../src/store/native-session-fs.js'
import { SqliteMessageQueueStore } from '../src/store/sqlite-message-queue.js'
import { SqliteLocalObjects } from '../src/store/sqlite-local-objects.js'
import { SqliteSessionArtifactStore } from '../src/store/sqlite-session-artifact-store.js'
import { SqliteMessageAttachmentStore } from '../src/store/sqlite-message-attachment-store.js'
import { createScheduledTaskStorage } from '../src/scheduled-tasks/storage.js'
import type { EmbeddedStaticAsset } from '../src/http/routes.js'
import { loadSocketAdminConfig, type EmbeddedSocketAdminAsset } from '../src/socket-admin.js'
import { loadProductDeploymentConfig } from '../src/deployment-config.js'
import { createSocketAdminStore } from '../src/socket-admin-store.js'
import { authSettings, type AuthConfig, type DashboardActor } from '../src/auth-control.js'
import { createAuditLogger } from '../src/audit-log.js'
import { ModelMetadataService } from '../src/model-metadata/model-metadata-service.js'
import { resolveModelContextWindow } from '../src/model-capabilities.js'
import { ExecutorIdentityStore } from '../src/store/executor-identity.js'
import { discoverSkills } from '../src/extensions/skills.js'
import { parseEnhancementCli, runEnhancementCli } from '../src/ops-cli.js'
import { LocalWebSearchCredentialStore } from '../src/web-search/credential-store.js'
import { KalaStateStore } from '../src/store/state-store.js'
import { LocalAzureSpeechCredentialStore } from '../src/speech/credential-store.js'
import { createDedicatedRuntimeReadiness, writeDedicatedProcessReadiness, writeDedicatedRuntimeReadiness } from '../src/tenant-runtime/dedicated-runtime-readiness.js'

const logger = createRuntimeLogger('kala-host')
const VERSION = packageJson.version

type BuildInfo = {
  releaseTag: string
  productVersion?: string
  gitCommit: string
  builtAt: string
  artifactKind: 'source' | 'cjs' | 'native'
  dashboardMode: 'vite' | 'static' | 'embedded' | 'none'
  socketAdminMode?: 'embedded' | 'filesystem' | 'missing'
}

function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') continue
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function hasFlag(argv: readonly string[], ...names: readonly string[]): boolean {
  return argv.some((arg) => names.includes(arg))
}

function printHelp(): void {
  process.stdout.write(`Kala Runtime

Usage:
  kala-dashboard-with-runtime.cjs [options]
  kala-dashboard-with-runtime.cjs enhancement <area> <command> [options]

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print version and exit.
  --port <port>              HTTP/WebSocket port. Defaults to KALA_PORT or 3000.
  --print-agent-module       Print resolved agent module metadata and exit.
  --print-system-prompt      Print resolved system prompt and exit.
  --print-tool-registry      Print resolved tool registry and exit.

Common environment:
  KALA_PORT                  Port used when --port is omitted.
  KALA_SESSIONS_DIR               Legacy Session JSONL directory / new SQLite state root parent.
  KALA_PORTABLE_SQLITE_FRESH       Set to 1 only on first launch with a nonexistent state root.
  KALA_ARTIFACTS_DIR Artifact root. Set to 0 to disable artifact writes.
  KALA_DASHBOARD_DIR              Static dashboard directory override.
  KALA_AUTH_TOKEN            Optional shared token required by clients.
  KALA_EXECUTOR_TOKENS            Optional JSON array of executor tokens.
  HOST_MODEL                 Override the default model.
  KALA_SOCKET_ADMIN_USER
                             Socket.IO Admin UI username. Default: admin.
  LOG_LEVEL                  trace, debug, info, warn, error. Default: info.
  LOG_FORMAT                 pretty/human or json. Default: pretty.

Examples:
  node kala-dashboard-with-runtime.cjs --port 3000
  KALA_PORT=3001 node kala-dashboard-with-runtime.cjs
  LOG_FORMAT=json node kala-dashboard-with-runtime.cjs --port 3000
  node kala-dashboard-with-runtime.cjs enhancement --help
`)
}

function printVersion(): void {
  process.stdout.write(`Kala Runtime ${VERSION}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (hasFlag(argv, '--help', '-h')) {
    printHelp()
    return
  }
  if (hasFlag(argv, '--version', '-v')) {
    printVersion()
    return
  }
  const nativeFsLimits = nativeFsLimitsFromEnv(process.env)

  const deployment = loadProductDeploymentConfig({
    configPath: process.env.KALA_DEPLOYMENT_CONFIG,
  })
  const product = productVariant(deployment)
  const capabilities = deployment.runtimeProfile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES
  const enhancementCommand = parseEnhancementCli(argv)
  if (await runEnhancementCli(enhancementCommand)) return

  // Default `KALA_ALLOW_ALL_OK` to "1" so the dashboard can flip a session into
  // `allow_all` approval mode without extra env plumbing. Operators who want
  // the original guard rail back can set `KALA_ALLOW_ALL_OK=0` explicitly.
  if (process.env.KALA_ALLOW_ALL_OK === undefined) {
    process.env.KALA_ALLOW_ALL_OK = '1'
  }
  const runtime = loadRuntimeConfig()
  const port = Number(argValue(process.argv.slice(2), '--port') ?? process.env.KALA_PORT ?? 3000)
  const sessionsDir =
    process.env.KALA_SESSIONS_DIR ?? join(homedir(), '.kala', 'sessions')
  const expectedDeployment = parseExpectedDeployment(process.env.KALA_EXPECTED_DEPLOYMENT)
  const stateRoot = dirname(sessionsDir)
  const portableAuthority = product === 'portable'
    ? selectPortableInstallation(stateRoot, process.env.KALA_PORTABLE_SQLITE_FRESH === '1')
    : 'legacy'
  if (process.env.KALA_PORTABLE_SQLITE_FRESH === '1' && product !== 'portable') {
    throw new Error('Portable SQLite fresh installation is only valid for the Portable product')
  }
  const portableDatabasePath = join(stateRoot, 'state.sqlite')
  const sqliteSessions = portableAuthority === 'sqlite' ? new SqliteSessionAuthority(portableDatabasePath, { nativeFsLimits }) : undefined
  const sqliteQueue = portableAuthority === 'sqlite' ? new SqliteMessageQueueStore(portableDatabasePath) : undefined
  const localObjects = portableAuthority === 'sqlite' ? new SqliteLocalObjects(stateRoot) : undefined
  const sqliteArtifacts = localObjects ? new SqliteSessionArtifactStore(stateRoot, { objects: localObjects }) : undefined
  const sqliteAttachments = localObjects ? new SqliteMessageAttachmentStore(stateRoot, { objects: localObjects }) : undefined
  const stateStore = new KalaStateStore(stateRoot, {
    ...(process.env.KALA_STATE_MASTER_KEY_PATH ? { keyPath: process.env.KALA_STATE_MASTER_KEY_PATH } : {}),
    legacyMemoDirectory: join(stateRoot, 'memos'),
    legacyCredentialDirectory: join(stateRoot, 'credentials'),
  })
  const webSearchCredentialStore = new LocalWebSearchCredentialStore(stateStore)
  const speechCredentialStore = new LocalAzureSpeechCredentialStore(stateStore)
  const artifactRootDir = process.env.KALA_ARTIFACTS_DIR === '0'
    ? false
    : process.env.KALA_ARTIFACTS_DIR ?? join(dirname(sessionsDir), 'artifacts')
  const auth = loadAuthConfig()
  const auditDir = process.env.KALA_AUDIT_DIR ?? join(dirname(sessionsDir), 'audit')
  const audit = createAuditLogger(auditDir)
  const executorIdentityPath = process.env.KALA_EXECUTOR_IDENTITIES ?? join(dirname(sessionsDir), 'executor-identities.json')
  const executorIdentityStore = new ExecutorIdentityStore(executorIdentityPath)
  executorIdentityStore.load()
  const effectiveAuth: AuthConfig = { ...(auth ?? {}), executorIdentityStore }
  const healthRegistry = createProviderHealthRegistry()
  const registry = createModelRegistry(runtime.providers, runtime.manualModels, {
    initialManualProviders: runtime.manualProviders,
    initialManualDefaultModel: runtime.manualDefaultModel,
    fallbackDefault: runtime.defaultModel,
    healthRegistry,
    ...(artifactRootDir ? { artifactRootDir } : {}),
    logger,
  })
  const modelMetadata = new ModelMetadataService({ logger })
  const enrichModels = () => modelMetadata.enrichModels(registry.models, registry.providers, registry.manualModels)
  modelMetadata.setUpdateHandler(enrichModels)
  await modelMetadata.start(registry.providers)
  enrichModels()
  const { llm } = registry

  const skills = await discoverSkills()
  const agentSettingsPath = defaultAgentSettingsPath()
  const settingsPathForActor = (actor?: DashboardActor): string => actor?.kind === 'ingress'
    ? organizationAgentSettingsPath(agentSettingsPath, actor.organizationId)
    : agentSettingsPath
  const agentSettingsForActor = (actor?: DashboardActor) => loadAgentRuntimeSettings(settingsPathForActor(actor))
  const resolveAgentModuleForActor = (actor?: DashboardActor) => {
    const settings = agentSettingsForActor(actor)
    return resolveBuiltinAgentModule({
      skills: skills.skills,
      systemPrompt: settings.slots.find((slot) => slot.id === settings.selectedSlotId)!.prompt,
      desktopManualAuthorizationRequired: settings.desktopManualAuthorizationRequired ?? false,
      computerUseEnabled: settings.computerUseEnabled ?? false,
      ...(resolveModelContextWindow(registry.defaultModel, registry.models)
        ? { contextLimit: resolveModelContextWindow(registry.defaultModel, registry.models) }
        : {}),
    })
  }
  const resolvedAgentModule = resolveAgentModuleForActor()
  if (hasFlag(argv, '--print-agent-module')) {
    process.stdout.write(`${JSON.stringify(resolvedAgentModule.metadata, null, 2)}\n`)
    return
  }
  if (hasFlag(argv, '--print-system-prompt')) {
    process.stdout.write(`${resolvedAgentModule.systemPrompt}\n`)
    return
  }
  if (hasFlag(argv, '--print-tool-registry')) {
    process.stdout.write(`${JSON.stringify(resolvedAgentModule.toolDefinitions, null, 2)}\n`)
    return
  }

  const dashboard = await createDashboardServing()
  const embeddedSocketAdminAssets = embeddedSocketAdminAssetsFromGlobal()
  const embeddedReleaseAssets = embeddedReleaseAssetsFromGlobal()
  const embeddedDocs = embeddedDocsFromGlobal()
  const socketAdminStorePath = process.env.KALA_SOCKET_ADMIN_CONFIG ?? join(homedir(), '.config', 'kala', 'socket-admin.json')
  const socketAdminStore = createSocketAdminStore(socketAdminStorePath)
  let socketAdminState = loadSocketAdminConfig({ currentModulePath: currentModulePath(), configPath: socketAdminStore.path, record: socketAdminStore.load(), embeddedAssets: embeddedSocketAdminAssets })
  let activeSocketAdminMode = socketAdminState.runtime?.mode
  const buildInfo = runtimeBuildInfo(dashboard, embeddedSocketAdminAssets)
  const hooks = loadHookConfigs()
  const hookRunner = hooks.length > 0 ? createHookRunner() : undefined
  let release = releaseSettings(port)
  const processReadinessPath = process.env.KALA_PROCESS_READINESS?.trim()

  const manualModelsPath = join(homedir(), '.config', 'kala', 'models.json')
  const hookSummaries = hooks.map((h) => ({
      event: h.event,
      command: h.command,
      ...(h.match !== undefined ? { match: h.match } : {}),
  }))
  const makeSettings = (actor?: DashboardActor): ServerSettingsPayload => {
    const actorSettings = agentSettingsForActor(actor)
    const actorAgentModule = resolveAgentModuleForActor(actor)
    return {
    providers: registry.providers.map((p) => ({
      id: p.id,
      label: p.label,
      wire: p.wire,
      source: p.source,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      models: registry.models.filter((m) => m.providerId === p.id),
    })),
    defaultModel: registry.defaultModel,
    hooks: hookSummaries,
    versions: {
      host: VERSION,
      protocol: PROTOCOL_VERSION,
      build: buildInfo,
    },
    agentModule: actorAgentModule.metadata,
    desktopAccess: { manualAuthorizationRequired: actorSettings.desktopManualAuthorizationRequired ?? false,
      computerUseEnabled: actorSettings.computerUseEnabled ?? false, desktopPreviewEnabled: actorSettings.desktopPreviewEnabled ?? false },
    agentPrompt: {
      selectedSlotId: actorSettings.selectedSlotId,
      slots: actorSettings.slots,
      configPath: settingsPathForActor(actor),
    },
    auth: authSettings(effectiveAuth),
    socketAdmin: socketAdminState.summary,
    paths: {
      claudeSettings: join(homedir(), '.claude', 'settings.json'),
      codexConfig: join(homedir(), '.codex', 'config.toml'),
      manualModels: manualModelsPath,
      hooksConfig: join(homedir(), '.config', 'kala', 'config.toml'),
      sessionsDir,
    },
    mcp: {
      supported: false,
      note: 'MCP runtime is not implemented yet — see docs/host/mcp.md for the planned design.',
    },
    release,
    }
  }

  const evaluationUrl = publicHttpUrl(process.env.KALA_EVALUATION_URL)
  const server = await startHostServer({
    port,
    ...(process.env.KALA_BIND_HOST?.trim() ? { listenHost: process.env.KALA_BIND_HOST.trim() } : {}),
    ...(product === 'portable' ? {
      publicUrls: parsePublicUrls(process.env.KALA_PUBLIC_URLS ?? `http://localhost:${port},http://127.0.0.1:${port}`),
    } : {}),
    deployment,
    capabilities,
    ...(evaluationUrl ? { evaluationUrl } : {}),
    sessionsDir,
    ...(sqliteSessions && sqliteQueue ? {
      sessionAuthority: sqliteSessions,
      messageQueueAuthority: sqliteQueue,
      scheduledTaskStore: createScheduledTaskStorage({ kind: 'portable-sqlite', databasePath: portableDatabasePath }),
      objectStorage: {
        sessionArtifacts: sqliteArtifacts!,
        messageAttachments: sqliteAttachments!,
      },
    } : {}),
    ...(expectedDeployment ? { expectedDeployment } : {}),
    ...((processReadinessPath || process.env.KALA_RUNTIME_READINESS?.trim()) ? {
      invalidateReadiness: () => {
        if (processReadinessPath) rmSync(processReadinessPath, { force: true })
        const runtimeReadinessPath = process.env.KALA_RUNTIME_READINESS?.trim()
        if (runtimeReadinessPath) rmSync(runtimeReadinessPath, { force: true })
      },
    } : {}),
    ...(expectedDeployment ? { mutableReady: () => plannedDeploymentPubliclyRouted(expectedDeployment) } : {}),
    ...(processReadinessPath ? { onProcessReady: async (ready) => {
      await writeDedicatedProcessReadiness(processReadinessPath, { schemaVersion: 1, ...ready, ...(expectedDeployment ? { deployment: expectedDeployment } : {}) })
    } } : {}),
    llm,
    logger,
    webSearchCredentials: webSearchCredentialStore,
    webSearchCredentialStatus: () => webSearchCredentialStore.status(),
    setWebSearchCredential: (provider, key) => webSearchCredentialStore.set(provider, key),
    deleteWebSearchCredential: (provider) => webSearchCredentialStore.delete(provider),
    speechCredentials: speechCredentialStore,
    stateStore,
    defaultConfig: (actor) => resolveAgentModuleForActor(actor).config,
    models: () => registry.models,
    defaultModel: () => registry.defaultModel,
    settings: makeSettings,
    addManualModel: (input) => {
      registry.addManual(input)
      enrichModels()
      writeManualConfig(manualModelsPath, { defaultModel: registry.manualDefaultModel, providers: registry.manualProviders, models: registry.manualModels })
      return makeSettings()
    },
    deleteManualModel: (input) => {
      registry.deleteManual(input.providerId, input.id)
      enrichModels()
      writeManualConfig(manualModelsPath, { defaultModel: registry.manualDefaultModel, providers: registry.manualProviders, models: registry.manualModels })
      return makeSettings()
    },
    addManualProvider: (input) => {
      registry.addManualProvider(input)
      modelMetadata.updateProviders(registry.providers)
      enrichModels()
      writeManualConfig(manualModelsPath, { defaultModel: registry.manualDefaultModel, providers: registry.manualProviders, models: registry.manualModels })
      return makeSettings()
    },
    deleteManualProvider: (input) => {
      registry.deleteManualProvider(input.providerId)
      modelMetadata.updateProviders(registry.providers)
      enrichModels()
      writeManualConfig(manualModelsPath, { defaultModel: registry.manualDefaultModel, providers: registry.manualProviders, models: registry.manualModels })
      return makeSettings()
    },
    setDefaultModel: (input) => {
      registry.setDefaultModel(input.model)
      writeManualConfig(manualModelsPath, { defaultModel: registry.manualDefaultModel, providers: registry.manualProviders, models: registry.manualModels })
      return makeSettings()
    },
    updateAgentPrompt: (input, actor) => {
      // Publish nothing in memory until the atomic rename succeeds. A failed
      // save therefore leaves both GET and the next model call on the old file.
      writeAgentRuntimeSettings(settingsPathForActor(actor), { ...agentSettingsForActor(actor), ...input,
        desktopManualAuthorizationRequired: agentSettingsForActor(actor).desktopManualAuthorizationRequired ?? false })
      return makeSettings(actor)
    },
    desktopManualAuthorizationRequired: (actor) => agentSettingsForActor(actor).desktopManualAuthorizationRequired ?? false,
    desktopFeaturePolicy: (actor) => {
      const settings = agentSettingsForActor(actor)
      return { computerUseEnabled: settings.computerUseEnabled ?? false, desktopPreviewEnabled: settings.desktopPreviewEnabled ?? false }
    },
    updateDesktopAccess: (input, actor) => {
      const current = agentSettingsForActor(actor)
      writeAgentRuntimeSettings(settingsPathForActor(actor), { ...current, desktopManualAuthorizationRequired: input.manualAuthorizationRequired,
        computerUseEnabled: input.computerUseEnabled ?? current.computerUseEnabled ?? false,
        desktopPreviewEnabled: input.desktopPreviewEnabled ?? current.desktopPreviewEnabled ?? false })
      return makeSettings(actor)
    },
    initializeSocketAdmin: (input) => {
      const password = input.password.trim()
      if (password.length < 8) throw new Error('Socket.IO Admin UI password must be at least 8 characters')
      if (socketAdminStore.load()) {
        const err = new Error('Socket.IO Admin UI password is already initialized') as Error & { status?: number }
        err.status = 409
        throw err
      }
      const username = process.env.KALA_SOCKET_ADMIN_USER?.trim() || 'admin'
      socketAdminStore.initialize({ username, passwordHash: hashSocketAdminPassword(password), mode: input.mode ?? socketAdminState.summary.configuredMode })
      socketAdminState = loadSocketAdminConfig({ currentModulePath: currentModulePath(), configPath: socketAdminStore.path, record: socketAdminStore.load(), embeddedAssets: embeddedSocketAdminAssets })
      if (socketAdminState.runtime) {
        input.activate(socketAdminState.runtime)
        activeSocketAdminMode = socketAdminState.runtime.mode
      }
      return makeSettings()
    },
    updateSocketAdminMode: (input) => {
      socketAdminStore.updateMode(input.mode)
      socketAdminState = loadSocketAdminConfig({ currentModulePath: currentModulePath(), configPath: socketAdminStore.path, record: socketAdminStore.load(), embeddedAssets: embeddedSocketAdminAssets })
      if (activeSocketAdminMode && input.mode !== activeSocketAdminMode) {
        socketAdminState = {
          ...socketAdminState,
          summary: {
            ...socketAdminState.summary,
            runtimeMode: activeSocketAdminMode,
            configuredMode: input.mode,
            restartRequired: true,
          },
        }
      }
      return makeSettings()
    },
    auth: effectiveAuth,
    audit,
    ...(dashboard.kind === 'vite' ? { dashboardHandler: dashboard.handler } : {}),
    ...(dashboard.kind === 'static' ? { staticDir: dashboard.staticDir } : {}),
    ...(dashboard.kind === 'embedded' ? { embeddedStaticAssets: dashboard.assets } : {}),
    ...(socketAdminState.runtime ? { socketAdmin: socketAdminState.runtime } : {}),
    ...(embeddedSocketAdminAssets.length > 0 ? { embeddedSocketAdminAssets } : {}),
    ...(embeddedReleaseAssets.length > 0 ? { embeddedReleaseAssets } : {}),
    ...(embeddedDocs.length > 0 ? { embeddedDocs } : {}),
    ...(release.source === 'local' ? { releaseAssetsDir: releaseDir() } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
    ...(hookRunner ? { hookRunner } : {}),
    artifactRootDir,
    ...(process.env.KALA_DOCS_DIR ? { docsRootDir: process.env.KALA_DOCS_DIR } : {}),
    routerHealth: () => ({
      generatedAt: new Date().toISOString(),
      providers: healthRegistry.entries(),
      lastDecision: 'lastDecision' in llm ? (llm as MutableRouter).lastDecision() : undefined,
    }),
  })
  release = releaseSettings(server.port)
  const runtimeReadinessPath = process.env.KALA_RUNTIME_READINESS?.trim()
  if (runtimeReadinessPath) {
    const writeLeasePath = process.env.KALA_WRITE_LEASE?.trim()
    if (!writeLeasePath) throw new Error('KALA_WRITE_LEASE is required with KALA_RUNTIME_READINESS')
    const restartStatus = server.restartStatus()
    await writeDedicatedRuntimeReadiness(runtimeReadinessPath, await createDedicatedRuntimeReadiness({
      sessionsDir, writeLeasePath, capabilities, restart: restartStatus.last,
      ...(expectedDeployment ? { deployment: expectedDeployment } : {}),
    }))
  }

  const startupDetails = {
    port: server.port,
    product,
    capabilities,
    sessionsDir,
    llm: llm.name,
    models: registry.models.map((m) => m.id),
    defaultModel: registry.defaultModel,
    dashboard: dashboard.kind,
    ...(dashboard.kind === 'static' ? { staticDir: dashboard.staticDir } : {}),
    ...(dashboard.kind === 'embedded' ? { embeddedAssets: dashboard.assets.length } : {}),
    socketAdmin: socketAdminState.summary,
    hooks: hooks.length,
    skills: skills.skills.length,
    artifactRootDir,
    auditDir,
    executorIdentityPath,
  }
  logger.info(`host listening on http://127.0.0.1:${server.port} (${dashboard.kind} dashboard, ${registry.models.length} models)`)
  logger.debug(startupDetails, 'host startup details')
  if (registry.models.length === 0) {
    logger.warn(
      'no models configured; check ~/.claude/settings.json and ~/.codex/config.toml',
    )
  }

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down')
    modelMetadata.stop()
    server.loop.beginDrain('checkpoint')
    const sessionIds = server.store.list().map((record) => record.sessionId)
    await Promise.all(sessionIds.map((sessionId) => server.loop.waitForCheckpoint(sessionId)))
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function publicHttpUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate.replace(/\/$/u, '') || '/'
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/$/u, '')
  } catch {
    return undefined
  }
}

function parseExpectedDeployment(raw: string | undefined): NonNullable<import('@agent-kernel/shared').HostRestartAttempt['deployment']> | undefined {
  if (!raw?.trim()) return undefined
  const value = JSON.parse(raw) as Record<string, unknown>
  if (typeof value.deploymentId !== 'string' || !value.deploymentId || typeof value.targetReleaseDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.targetReleaseDigest) || !Number.isSafeInteger(value.expectedRouteGeneration) || Number(value.expectedRouteGeneration) < 1 || typeof value.fencingToken !== 'string' || value.fencingToken.length < 16) throw new Error('invalid KALA_EXPECTED_DEPLOYMENT')
  return { deploymentId: value.deploymentId, targetReleaseDigest: value.targetReleaseDigest, expectedRouteGeneration: Number(value.expectedRouteGeneration), fencingToken: value.fencingToken }
}

function plannedDeploymentPubliclyRouted(expected: NonNullable<import('@agent-kernel/shared').HostRestartAttempt['deployment']>): boolean {
  const routePath = process.env.KALA_ROUTE_STATE?.trim()
  const slot = process.env.KALA_SLOT?.trim()
  if (!routePath || (slot !== 'blue' && slot !== 'green')) return false
  try {
    const route = JSON.parse(readFileSync(routePath, 'utf8')) as { generation?: unknown; activeSlot?: unknown }
    return route.generation === expected.expectedRouteGeneration + 1 && route.activeSlot === slot
  } catch {
    return false
  }
}

function hashSocketAdminPassword(password: string): string {
  return bcrypt.hashSync(password, 10)
}

type BuildResult = {
  llm: MutableRouter | LLMAdapter
  providers: ProviderSpec[]
  models: ModelInfo[]
  manualProviders: readonly ManualProviderInput[]
  manualModels: readonly ManualModelInput[]
  manualDefaultModel?: string
  defaultModel: string
  addManual(input: ManualModelInput): void
  deleteManual(providerId: string, id: string): void
  addManualProvider(input: ManualProviderInput): void
  deleteManualProvider(providerId: string): void
  setDefaultModel(model: string): void
}

function createModelRegistry(
  providers: readonly ProviderSpec[],
  initialManualModels: readonly ManualModelInput[],
  opts: {
    initialManualProviders?: readonly ManualProviderInput[]
    initialManualDefaultModel?: string
    fallbackDefault: string
    healthRegistry?: ProviderHealthRegistry
    artifactRootDir?: string
    logger?: ReturnType<typeof createRuntimeLogger>
  },
): BuildResult {
  const byPrefix: Array<{ prefix: string; adapter: LLMAdapter; routedModel?: string }> = []
  const models: ModelInfo[] = []
  const providerSpecs: ProviderSpec[] = [...providers]
  const manualProviders: ManualProviderInput[] = [...(opts.initialManualProviders ?? [])]
  const manualModels: ManualModelInput[] = [...initialManualModels]
  let primary: LLMAdapter | undefined

  for (const p of providerSpecs) {
    const perModelAdapters = buildProviderAdapters(p)
    for (const [modelId, adapter] of perModelAdapters) {
      models.push(modelInfo(modelId, p.label, {
        providerId: p.id,
        source: manualModels.some((m) => m.providerId === p.id && m.id === modelId) ? 'manual' : p.source,
        ...(p.contextWindows?.[modelId] ? { contextWindow: p.contextWindows[modelId] } : {}),
      }))
      byPrefix.push({ prefix: modelRef(p.id, modelId), adapter, routedModel: modelId })
      byPrefix.push({ prefix: modelId, adapter })
      if (!primary) primary = adapter
    }
  }

  if (!primary) {
    primary = environmentProviderAdapter(models)
  }

  const routerArtifactDir = opts.artifactRootDir
  const decisionLogger = opts.logger
  const router = routerAdapter({
    defaultAdapter: primary,
    byPrefix,
    ...(opts.healthRegistry ? { healthRegistry: opts.healthRegistry } : {}),
    ...(routerArtifactDir
      ? {
          onDecision: (decision) => {
            if (decision.finalOutcome === 'success' && decision.attempts.length <= 1) return
            void writeFallbackArtifact({
              rootDir: routerArtifactDir,
              artifact: toFallbackArtifact(decision),
            }).catch((err) => {
              decisionLogger?.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'router: failed to persist fallback artifact',
              )
            })
          },
        }
      : {}),
  })
  let manualDefaultModel = opts.initialManualDefaultModel
  return {
    llm: router,
    providers: providerSpecs,
    models,
    manualProviders,
    manualModels,
    get manualDefaultModel() { return manualDefaultModel },
    get defaultModel() { return process.env.HOST_MODEL ?? manualDefaultModel ?? opts.fallbackDefault },
    addManual(input) {
      const provider = providerSpecs.find((p) => p.id === input.providerId)
      if (!provider) throw new Error(`unknown provider: ${input.providerId}`)
      const id = input.id.trim()
      if (id.length === 0) throw new Error('model id is required')
      const existingModel = models.find((m) => m.providerId === provider.id && m.id === id)
      if (existingModel && existingModel.source !== 'manual') {
        throw new Error(`model already discovered from ${existingModel.source ?? 'provider config'}: ${id}`)
      }
      if (!existingModel) {
        const adapter = buildSingleAdapter(provider, id)
        router.addRoute(modelRef(provider.id, id), adapter, id)
        router.addRoute(id, adapter)
        models.push(modelInfo(id, provider.label, {
          providerId: provider.id,
          source: 'manual',
          ...(input.label ? { label: input.label } : {}),
          ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
        }))
      }
      const existing = manualModels.findIndex((m) => m.providerId === provider.id && m.id === id)
      const normalized = {
        providerId: provider.id,
        id,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
      }
      if (existing === -1) manualModels.push(normalized)
      else manualModels[existing] = normalized
    },
    deleteManual(providerId, id) {
      const manualIndex = manualModels.findIndex((m) => m.providerId === providerId && m.id === id)
      if (manualIndex === -1) return
      manualModels.splice(manualIndex, 1)
      const modelIndex = models.findIndex((m) => m.providerId === providerId && m.id === id && m.source === 'manual')
      if (modelIndex !== -1) models.splice(modelIndex, 1)
      router.deleteRoute(modelRef(providerId, id))
      router.deleteRoute(id)
    },
    addManualProvider(input) {
      const id = input.id.trim()
      if (id.length === 0) throw new Error('provider id is required')
      if (providerSpecs.some((p) => p.id === id)) throw new Error(`provider already exists: ${id}`)
      const baseUrl = input.baseUrl.trim()
      if (baseUrl.length === 0) throw new Error('base URL is required')
      const provider: ProviderSpec = {
        id,
        label: input.label?.trim() || id,
        wire: input.wire,
        source: 'manual',
        baseUrl,
        apiKey: input.apiKey,
        models: [],
      }
      providerSpecs.push(provider)
      manualProviders.push({
        id,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        wire: input.wire,
        baseUrl,
        apiKey: input.apiKey,
      })
    },
    deleteManualProvider(providerId) {
      const manualProviderIndex = manualProviders.findIndex((p) => p.id === providerId)
      if (manualProviderIndex === -1) return
      manualProviders.splice(manualProviderIndex, 1)
      const providerIndex = providerSpecs.findIndex((p) => p.id === providerId && p.source === 'manual')
      if (providerIndex !== -1) providerSpecs.splice(providerIndex, 1)
      for (let i = manualModels.length - 1; i >= 0; i--) {
        if (manualModels[i]?.providerId !== providerId) continue
        const id = manualModels[i]!.id
        manualModels.splice(i, 1)
        router.deleteRoute(modelRef(providerId, id))
        router.deleteRoute(id)
      }
      for (let i = models.length - 1; i >= 0; i--) {
        if (models[i]?.providerId === providerId) models.splice(i, 1)
      }
      if (manualDefaultModel?.startsWith(`${providerId}:`)) manualDefaultModel = undefined
    },
    setDefaultModel(model) {
      const trimmed = model.trim()
      if (trimmed.length === 0) {
        manualDefaultModel = undefined
        return
      }
      const match = models.find((m) => (m.ref ?? m.id) === trimmed || m.id === trimmed)
      if (!match) throw new Error(`unknown model: ${trimmed}`)
      manualDefaultModel = match.ref ?? match.id
    },
  }
}

function buildProviderAdapters(
  provider: ProviderSpec,
): Array<[string, LLMAdapter]> {
  const out: Array<[string, LLMAdapter]> = []
  for (const model of provider.models) {
    out.push([model, buildSingleAdapter(provider, model)])
  }
  return out
}

function buildSingleAdapter(provider: ProviderSpec, model: string): LLMAdapter {
  if (provider.wire === 'anthropic') {
    return anthropicAdapter({
      apiKey: provider.apiKey,
      model,
      ...(provider.baseUrl
        ? { apiUrl: joinPath(provider.baseUrl, '/messages') }
        : {}),
    })
  }
  return openaiAdapter({
    apiKey: provider.apiKey,
    model,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  })
}

function loadAuthConfig(): AuthConfig | undefined {
  const githubRequired = process.env.KALA_GITHUB_OAUTH_REQUIRED === '1'
  const executorTokens = parseExecutorTokens(process.env.KALA_EXECUTOR_TOKENS)
  const sharedToken = process.env.KALA_AUTH_TOKEN
  const github = githubRequired
    ? {
        required: true,
        ...(process.env.GITHUB_CLIENT_ID ? { clientId: process.env.GITHUB_CLIENT_ID } : {}),
        ...(process.env.GITHUB_CLIENT_SECRET ? { clientSecret: process.env.GITHUB_CLIENT_SECRET } : {}),
        ...(process.env.GITHUB_OAUTH_CALLBACK_URL ? { callbackUrl: process.env.GITHUB_OAUTH_CALLBACK_URL } : {}),
        ...(process.env.KALA_AUTH_SESSION_SECRET ? { sessionSecret: process.env.KALA_AUTH_SESSION_SECRET } : {}),
        usernameWhitelist: (process.env.GITHUB_USERNAME_WHITELIST ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      }
    : undefined
  if (!sharedToken && !github && executorTokens.length === 0) return undefined
  return {
    ...(sharedToken ? { sharedToken } : {}),
    ...(github ? { github } : {}),
    ...(executorTokens.length > 0 ? { executorTokens } : {}),
  }
}

function parseExecutorTokens(raw: string | undefined): NonNullable<AuthConfig['executorTokens']> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('KALA_EXECUTOR_TOKENS must be a JSON array')
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const rec = item as Record<string, unknown>
      if (typeof rec.token !== 'string' || rec.token.length === 0) return []
      return [{
        token: rec.token,
        ...(typeof rec.workspaceId === 'string' && rec.workspaceId.length > 0 ? { workspaceId: rec.workspaceId } : {}),
        ...(typeof rec.label === 'string' && rec.label.length > 0 ? { label: rec.label } : {}),
      }]
    })
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'invalid KALA_EXECUTOR_TOKENS; ignoring scoped executor tokens')
    return []
  }
}

/**
 * Path join for base URLs that may or may not already end in `/v1`. Anthropic
 * bases in the wild are inconsistent: some proxies expose `.../v1` (like the
 * newapi proxy at 127.0.0.1:33333), others expose the whole `.../v1/messages`
 * path. We normalize: strip trailing slash and any trailing `/messages`, then
 * append `/v1/messages` if the base isn't already versioned.
 */
function joinPath(base: string, tail: string): string {
  const trimmed = base.replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

/**
 * Environment-configured provider path used when no settings-file or catalog
 * provider is available. `KALA_PROVIDER` takes precedence; legacy
 * `KALA_PROVIDER` remains accepted for existing deployments.
 * `policy-gateway` selects SGLang-backed live rollouts.
 */
function environmentProviderAdapter(models: ModelInfo[]): LLMAdapter {
  const provider = (process.env.KALA_PROVIDER ?? process.env.KALA_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'policy-gateway') {
    const baseUrl = process.env.KALA_POLICY_BASE_URL
    const model = process.env.KALA_POLICY_MODEL ?? process.env.HOST_MODEL
    if (!baseUrl || !model) {
      fail('KALA_PROVIDER=policy-gateway requires KALA_POLICY_BASE_URL and KALA_POLICY_MODEL')
    }
    models.push(modelInfo(model, 'policy-gateway (SGLang)', { providerId: 'policy-gateway', source: 'env' }))
    return policyGatewayAdapter({
      baseUrl,
      artifactRoot: process.env.KALA_ARTIFACTS_DIR ?? join(homedir(), '.kala', 'artifacts'),
      model,
      ...(process.env.KALA_POLICY_TOKENIZER ? { tokenizerPath: process.env.KALA_POLICY_TOKENIZER } : {}),
      ...(process.env.KALA_POLICY_ROUTE_KEY ? { routeKey: process.env.KALA_POLICY_ROUTE_KEY } : {}),
      ...(process.env.KALA_POLICY_WEIGHT_VERSION ? { weightVersion: process.env.KALA_POLICY_WEIGHT_VERSION } : {}),
      requireLogprobs: process.env.KALA_POLICY_REQUIRE_LOGPROBS === '1',
    })
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (provider === 'openai' && openaiKey) {
    const model = process.env.HOST_MODEL ?? 'gpt-4'
    models.push(modelInfo(model, 'openai (env)', { providerId: 'openai-env', source: 'env' }))
    return openaiAdapter({
      apiKey: openaiKey,
      model,
      ...(process.env.OPENAI_BASE_URL
        ? { baseUrl: process.env.OPENAI_BASE_URL }
        : {}),
    })
  }
  if (anthropicKey) {
    const model = process.env.HOST_MODEL ?? 'claude-opus-4-7'
    models.push(modelInfo(model, 'anthropic (env)', { providerId: 'anthropic-env', source: 'env' }))
    return anthropicAdapter({
      apiKey: anthropicKey,
      model,
      ...(process.env.ANTHROPIC_BASE_URL
        ? { apiUrl: joinPath(process.env.ANTHROPIC_BASE_URL, '/messages') }
        : {}),
    })
  }
  fail(
    'No LLM provider available: set ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
      'or configure ~/.claude/settings.json / ~/.codex/config.toml',
  )
}

function fail(msg: string): never {
  logger.error(msg)
  process.exit(1)
}

type DashboardServing =
  | { kind: 'vite'; handler: (req: IncomingMessage, res: ServerResponse) => void }
  | { kind: 'static'; staticDir: string }
  | { kind: 'embedded'; assets: readonly EmbeddedStaticAsset[] }
  | { kind: 'none' }

async function createDashboardServing(): Promise<DashboardServing> {
  const override = process.env.KALA_DASHBOARD_DIR
  if (override) {
    return existsSync(join(override, 'index.html'))
      ? { kind: 'static', staticDir: override }
      : { kind: 'none' }
  }

  if (isSourceDevRun()) {
    const handler = await createViteDashboardHandler().catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to start vite dashboard middleware; falling back to built dashboard',
      )
      return null
    })
    if (handler) return { kind: 'vite', handler }
  }

  const embedded = embeddedDashboardAssets()
  if (embedded.length > 0) return { kind: 'embedded', assets: embedded }

  const staticDir = resolveDashboardDir()
  return staticDir ? { kind: 'static', staticDir } : { kind: 'none' }
}

function embeddedDashboardAssets(): readonly EmbeddedStaticAsset[] {
  const globalValue = (globalThis as typeof globalThis & {
    __KALA_EMBEDDED_DASHBOARD__?: unknown
  }).__KALA_EMBEDDED_DASHBOARD__
  if (!Array.isArray(globalValue)) return []
  const assets: EmbeddedStaticAsset[] = []
  for (const item of globalValue) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    if (typeof record.contentBase64 !== 'string') continue
    assets.push({ path: record.path, contentBase64: record.contentBase64 })
  }
  return assets
}

function embeddedSocketAdminAssetsFromGlobal(): readonly EmbeddedSocketAdminAsset[] {
  const globalValue = (globalThis as typeof globalThis & {
    __KALA_EMBEDDED_SOCKET_ADMIN_UI__?: unknown
  }).__KALA_EMBEDDED_SOCKET_ADMIN_UI__
  if (!Array.isArray(globalValue)) return []
  const assets: EmbeddedSocketAdminAsset[] = []
  for (const item of globalValue) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    if (typeof record.contentBase64 !== 'string') continue
    assets.push({ path: record.path, contentBase64: record.contentBase64 })
  }
  return assets
}

function embeddedReleaseAssetsFromGlobal(): readonly EmbeddedStaticAsset[] {
  const globalValue = (globalThis as typeof globalThis & {
    __KALA_EMBEDDED_RELEASE_ASSETS__?: unknown
  }).__KALA_EMBEDDED_RELEASE_ASSETS__
  if (!Array.isArray(globalValue)) return []
  const assets: EmbeddedStaticAsset[] = []
  for (const item of globalValue) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    if (typeof record.contentBase64 !== 'string') continue
    assets.push({ path: record.path, contentBase64: record.contentBase64 })
  }
  return assets
}

function embeddedDocsFromGlobal(): readonly EmbeddedStaticAsset[] {
  const globalValue = (globalThis as typeof globalThis & {
    __KALA_EMBEDDED_DOCS__?: unknown
  }).__KALA_EMBEDDED_DOCS__
  if (!Array.isArray(globalValue)) return []
  const assets: EmbeddedStaticAsset[] = []
  for (const item of globalValue) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string' || typeof record.contentBase64 !== 'string') continue
    assets.push({ path: record.path, contentBase64: record.contentBase64 })
  }
  return assets
}

function runtimeBuildInfo(dashboard: DashboardServing, socketAdminAssets: readonly EmbeddedSocketAdminAsset[]): BuildInfo & { embeddedDashboardFiles?: number; embeddedSocketAdminFiles?: number } {
  const globalValue = (globalThis as typeof globalThis & {
    __KALA_BUILD_INFO__?: unknown
  }).__KALA_BUILD_INFO__
  const base = parseBuildInfo(globalValue) ?? {
    releaseTag: process.env.KALA_RELEASE_TAG ?? 'local',
    productVersion: VERSION,
    gitCommit: process.env.KALA_GIT_COMMIT ?? 'unknown',
    builtAt: process.env.KALA_BUILT_AT ?? 'unknown',
    artifactKind: 'source' as const,
    dashboardMode: dashboard.kind,
  }
  return {
    ...base,
    dashboardMode: dashboard.kind,
    socketAdminMode: socketAdminAssets.length > 0 ? 'embedded' : base.socketAdminMode ?? 'filesystem',
    ...(dashboard.kind === 'embedded' ? { embeddedDashboardFiles: dashboard.assets.length } : {}),
    ...(socketAdminAssets.length > 0 ? { embeddedSocketAdminFiles: socketAdminAssets.length } : {}),
  }
}

function parseBuildInfo(value: unknown): BuildInfo | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const artifactKind = record.artifactKind
  const dashboardMode = record.dashboardMode
  if (artifactKind !== 'source' && artifactKind !== 'cjs' && artifactKind !== 'native') return null
  if (dashboardMode !== 'vite' && dashboardMode !== 'static' && dashboardMode !== 'embedded' && dashboardMode !== 'none') return null
  return {
    releaseTag: typeof record.releaseTag === 'string' ? record.releaseTag : 'unknown',
    ...(typeof record.productVersion === 'string' ? { productVersion: record.productVersion } : {}),
    gitCommit: typeof record.gitCommit === 'string' ? record.gitCommit : 'unknown',
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : 'unknown',
    artifactKind,
    dashboardMode,
    ...(record.socketAdminMode === 'embedded' || record.socketAdminMode === 'filesystem' || record.socketAdminMode === 'missing' ? { socketAdminMode: record.socketAdminMode } : {}),
  }
}

async function createViteDashboardHandler(): Promise<
  (req: IncomingMessage, res: ServerResponse) => void
> {
  type ViteDevServer = {
    middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void
  }
  type ViteModule = {
    createServer(options: unknown): Promise<ViteDevServer>
  }
  const runtimeImport = Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<unknown>
  const vite = (await runtimeImport('vite')) as ViteModule
  const dashboardRoot = resolve(dirname(currentModulePath()), '..', '..', 'dashboard')
  const viteServer = await vite.createServer({
    root: dashboardRoot,
    server: {
      middlewareMode: true,
      hmr: { server: false },
    },
    appType: 'spa',
  })
  return (req, res) => {
    viteServer.middlewares(req, res, (err?: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
    })
  }
}

function isSourceDevRun(): boolean {
  if (process.env.KALA_DASHBOARD_DEV === '0') return false
  if (process.env.KALA_DASHBOARD_DEV === '1') return true
  return currentModulePath().endsWith('.ts')
}

function resolveDashboardDir(): string | undefined {
  const here = dirname(currentModulePath())
  const candidates = [
    // Monorepo layout: packages/host/bin/ → packages/dashboard/dist/
    resolve(here, '..', '..', 'dashboard', 'dist'),
    // Installed layout: node_modules/@agent-kernel/dashboard/dist
    resolve(here, '..', '..', '..', 'dashboard', 'dist'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c
  }
  return undefined
}

function currentModulePath(): string {
  return resolve(process.argv[1] ?? process.cwd())
}

function releaseSettings(port: number): NonNullable<ServerSettingsPayload['release']> {
  const explicit = process.env.KALA_RELEASE_BASE_URL?.trim()
  if (explicit) {
    return { bootstrapBaseUrl: trimTrailingSlash(explicit), source: explicit.includes('github.com/') ? 'github' : 'local' }
  }
  const repo = process.env.KALA_UPDATE_REPO?.trim()
  const tag = process.env.KALA_RELEASE_TAG?.trim()
  if (repo) {
    const suffix = tag && tag !== 'latest' ? `releases/download/${tag}` : 'releases/latest/download'
    return { bootstrapBaseUrl: `https://github.com/${repo}/${suffix}`, source: 'github' }
  }
  return { bootstrapBaseUrl: `http://localhost:${port}/release-assets`, source: 'local' }
}

function releaseDir(): string {
  const explicit = process.env.KALA_RELEASE_ASSETS_DIR?.trim()
  if (explicit) return resolve(explicit)
  const found = findReleaseDir([process.cwd(), dirname(currentModulePath())])
  return found ?? resolve(process.cwd(), 'release')
}

function findReleaseDir(starts: readonly string[]): string | undefined {
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      const candidate = join(dir, 'release')
      if (existsSync(join(candidate, 'run.sh'))) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
