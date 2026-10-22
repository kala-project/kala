/**
 * HTTP request routing for the host process.
 *
 *   - `/models`     JSON, GET/HEAD    — sanitised model list for the dashboard
 *   - `/settings`   JSON, GET/HEAD    — settings snapshot
 *   - `/settings/models` POST/DELETE  — manually managed model ids
 *   - everything else                 — static bundle (dashboard `dist/`),
 *                                       with SPA fallback to `index.html`
 *
 * Socket.IO owns `/socket.io/*` on the same HTTP server; every handler here
 * short-circuits on that prefix so the two listeners don't clobber each
 * other. JSON routes always run first because static serving falls back to
 * `index.html` for unknown paths and would otherwise mask a missing endpoint.
 */

import { createReadStream, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'

import type {
  AttachedExecutor,
  ClientAddManualModel,
  ClientAddManualProvider,
  ClientDeleteManualModel,
  ClientDeleteManualProvider,
  ClientSetDefaultModel,
  ClientUpdateAgentPromptSettings,
  ServerExecutorIdentitiesPayload,
  ServerExecutorIdentityRevokedPayload,
  ServerExecutorInvitePayload,
  ServerExecutorInviteRevokedPayload,
  ServerExecutorInvitesPayload,
  ModelInfo,
  HostRestartStatus,
  HostRestartAttempt,
  ServerModelsPayload,
  ServerSettingsPayload,
} from '@agent-kernel/shared'
import { PORTABLE_DEPLOYMENT, effectiveTenancy, productVariant, schema, validateClientMessagePayload, validateInlineMessageFiles, validateInlineMessageImages } from '@agent-kernel/shared'
import { parseWire } from '../wire-validation.js'

import { buildArtifactManifest, decodeManifestCursor, pageArtifactManifest, pruneArtifacts, type ArtifactManifest } from '../artifact-manifest.js'
import {
  exportRolloutFrameworkAdapter,
  exportRolloutSegments,
  exportRolloutSidecar,
} from '../rl-export.js'
import { verifyReward } from '../rl-reward.js'
import { exportSessionTraceArtifacts } from '../session-export.js'
import { profileSession } from '../session-profile.js'
import { exportTraceOtlp, loadHeadersFile } from '../trace-otlp-export.js'
import { buildMemoryIndex } from '../memory-index.js'
import { retrieveMemory } from '../memory-retrieval.js'
import { auditSessionReliability, replayReliabilityChaos } from '../reliability.js'
import { evaluateReliabilityGate, type ReliabilityGatePolicy } from '../reliability-gate.js'
import { classifyReliability } from '../reliability-classify.js'
import type { AuthConfig, DashboardActor } from '../auth-control.js'
import {
  authenticateDashboardHandshake,
  buildGithubStart,
  clearGithubSessionCookie,
  finishGithubOAuth,
  setGithubSessionCookie,
  readGithubSession,
} from '../auth-control.js'
import type { AuditActor, AuditLogger } from '../audit-log.js'
import type { SessionArtifactStorage } from '../session-artifact-registry.js'
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type MessageAttachmentStorage,
} from '../message-attachment-store.js'
import { assertImageAttachmentBytes, assertKernelTextAttachment, supportedImageMediaType, validateMessageAttachmentReferences } from '../message-attachment-resolver.js'
import type { OperationalMetrics } from '../operational-metrics.js'
import type { MemoStore } from '../memo-store.js'
import { diffToolCatalogs } from '../tool-catalog-diff.js'
import { writeExecutorCapabilitySnapshot } from '../executor-capabilities.js'
import { SessionNotFoundError, type SessionRecord, type SessionStore } from '../store/session.js'
import { compareToolVersions } from '../tool-version.js'
import { exportSubAgentGraph } from '../subagent-graph.js'
import { runWebSearch, type WebSearchCredentialStore } from '../web-search/index.js'
import type { WebSearchCredentialStatus } from '../web-search/credential-store.js'
import type { AzureSpeechCredentialStore } from '../speech/credential-store.js'
import { MAX_SPEECH_MAX_MINUTES, normalizeAzureSpeechEndpoint } from '../speech/credential-store.js'
import { transcribeAzureSpeechAudio } from '../speech/fast-transcription.js'
import { issueAzureSpeechToken } from '../speech/token-service.js'
import { validatedPublicOrigin } from './public-access-gate.js'
import { ContentInputError, resolveContentToPath } from './content-inputs.js'
import {
  HttpThemeError,
  readMarketplaceTheme,
  readMarketplaceThemeExtension,
  searchMarketplaceThemes,
} from '../vscode-themes.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const ROUTE_CLAIMED = Symbol('agent-kernel-route-claimed')

const MAX_ARTIFACT_CONTENT_BYTES = 1024 * 1024
const MAX_DOC_CONTENT_BYTES = 1024 * 1024
const MAX_SPEECH_RECORDING_BYTES = 25 * 1024 * 1024
const DEFAULT_ARTIFACT_MANIFEST_PAGE_SIZE = 100
const MAX_ARTIFACT_MANIFEST_PAGE_SIZE = 500
const ARTIFACT_MANIFEST_SNAPSHOT_FRESH_MS = 10 * 60_000
const ARTIFACT_MANIFEST_SNAPSHOT_RETENTION_MS = 10 * 60_000

function parseArtifactKinds(values: readonly string[]): Set<string> {
  const kinds = values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
  if (kinds.length > 50 || kinds.some((kind) => kind.length > 80 || !/^[a-z0-9_]+$/.test(kind))) {
    throw new HttpRouteError(400, 'invalid artifact kind filter')
  }
  return new Set(kinds)
}

type EnhancementActionRequest = {
  action?: string
  rootDir?: string
  sessionId?: string
  text?: string
  sessionLogPath?: string
  sessionLogPaths?: readonly string[] | string
  workspaceRoot?: string
  runId?: string
  evalInstanceId?: string
  pricingPath?: string
  includeGlobal?: boolean
  sessionsDir?: string
  taskId?: string
  frameworkTarget?: string
  framework?: string
  model?: string
  weightVersion?: string
  rewardPath?: string
  tokenSegmentsPath?: string
  sidecarPath?: string
  trialPath?: string
  scorePath?: string
  outputFilename?: string
  chaosReportPath?: string
  maxDanglingCount?: number | string
  minRecoverableRatio?: number | string
  maxRecoveryEventCount?: number | string
  maxDanglingByKind?: Record<string, number | string>
  requireStatusIn?: readonly string[] | string
  maxIntegrityIssueCount?: number | string
  heartbeatPath?: string
  wedgedThresholdMs?: number | string
  baselineCatalogPath?: string
  candidateCatalogPath?: string
  query?: string
  maxTokens?: number | string
  maxHits?: number | string
  outputPath?: string
  maxHashBytes?: number | string
  olderThanDays?: number | string
  maxTotalBytes?: number | string
  kinds?: readonly string[] | string
  dryRun?: boolean
  endpoint?: string
  headers?: Record<string, string> | string
  headersFilePath?: string
  retries?: number | string
  retryDelayMs?: number | string
  timeoutMs?: number | string
  serviceName?: string
  hostVersion?: string
  sessionLogContent?: string
  chaosReportContent?: string
  heartbeatContent?: string
  baselineCatalogContent?: string
  candidateCatalogContent?: string
  rewardContent?: string
  tokenSegmentsContent?: string
  sidecarContent?: string
  trialContent?: string
  scoreContent?: string
  headersFileContent?: string
  pricingContent?: string
}

function applyCorsHeaders(req: IncomingMessage, headers: Record<string, string>): void {
  const origin = req.headers.origin
  const publicOrigin = validatedPublicOrigin(req)
  if (typeof origin === 'string' && publicOrigin) {
    headers['access-control-allow-origin'] = publicOrigin
    headers['vary'] = 'Origin'
    headers['access-control-allow-credentials'] = 'true'
  }
}

export function attachJsonRoutes(
  server: HttpServer,
  payloads: {
    models: readonly ModelInfo[] | (() => readonly ModelInfo[])
    defaultModel: string | (() => string)
    settings?: ServerSettingsPayload | ((actor: DashboardActor) => ServerSettingsPayload | Promise<ServerSettingsPayload>)
    addManualModel?: (input: ClientAddManualModel) => ServerSettingsPayload
    deleteManualModel?: (input: ClientDeleteManualModel) => ServerSettingsPayload
    addManualProvider?: (input: ClientAddManualProvider) => ServerSettingsPayload
    deleteManualProvider?: (input: ClientDeleteManualProvider) => ServerSettingsPayload
    setDefaultModel?: (input: ClientSetDefaultModel) => ServerSettingsPayload
    updateAgentPrompt?: (input: ClientUpdateAgentPromptSettings, actor: DashboardActor) => ServerSettingsPayload | Promise<ServerSettingsPayload>
    initializeSocketAdmin?: (input: { password: string; mode?: 'development' | 'production' }) => ServerSettingsPayload
    updateSocketAdminMode?: (input: { mode: 'development' | 'production' }) => ServerSettingsPayload
    artifactRootDir?: string | false
    docsRootDir?: string
    embeddedDocs?: readonly EmbeddedStaticAsset[]
    sessionArtifacts?: SessionArtifactStorage
    messageAttachments?: MessageAttachmentStorage
    storageQuota?: TenantStorageQuotaEnforcer
    sessions?: SessionStore
    routerHealth?: () => unknown
    executorsSnapshot?: () => readonly AttachedExecutor[]
    toolRegistry?: () => readonly import('@agent-kernel/kernel').ToolSchema[]
    toolResultPersisted?: (sessionId: string, callId: string) => Promise<boolean>
    restartStatus?: () => HostRestartStatus
    requestRestart?: (input: { mode?: 'checkpoint' | 'when_idle' | 'force'; reason?: 'manual' | 'deploy' | 'settings_changed'; timeoutMs?: number; deployment?: NonNullable<HostRestartAttempt['deployment']> }) => Promise<HostRestartAttempt>
    commitRestartActivation?: (attemptId: string) => HostRestartAttempt | null
    abortRestart?: (attemptId?: string) => HostRestartAttempt | null
    unitQuiescence?: () => unknown
    reserveCutover?: () => Promise<unknown>
    releaseCutover?: () => void
    auth?: AuthConfig
    audit?: AuditLogger
    /**
     * Minimal queue access for the reliable "queue a message even if the
     * browser is closing" beacon path. Lets the HTTP layer enqueue+drain a
     * user message without a live socket.
     */
    enqueueUserMessage?: (input: { sessionId: string; text: string; intent: 'text' | 'shell'; operationId?: string; mode?: 'queue' | 'steer'; content?: readonly import('@agent-kernel/kernel').MessageContent[] }) => Promise<{ accepted?: boolean; committed: boolean; cursor?: number }>
    capabilities?: import('@agent-kernel/shared').RuntimeCapabilities
    evaluationUrl?: string
    deployment?: import('@agent-kernel/shared').ProductDeploymentConfig
    metrics?: OperationalMetrics
    memoStore?: MemoStore
    webSearchCredentials?: WebSearchCredentialStore & {
      status(): Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
      set(provider: 'serper', key: string): Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
      delete(provider: 'serper'): Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
    }
    speechCredentials?: AzureSpeechCredentialStore
    publicApiHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>
  },
): void {
  type ManifestSnapshot = { id: string; createdAt: number; manifest: ArtifactManifest }
  const manifestSnapshots = new Map<string, ManifestSnapshot>()
  let currentManifestSnapshot: ManifestSnapshot | undefined
  let manifestBuild: Promise<ManifestSnapshot> | undefined

  const artifactManifestSnapshot = async (forceRefresh: boolean): Promise<ManifestSnapshot> => {
    const now = Date.now()
    if (!forceRefresh && currentManifestSnapshot && now - currentManifestSnapshot.createdAt < ARTIFACT_MANIFEST_SNAPSHOT_FRESH_MS) return currentManifestSnapshot
    if (manifestBuild) return manifestBuild
    manifestBuild = buildArtifactManifest({ rootDir: payloads.artifactRootDir as string }).then(({ manifest }) => {
      const snapshot = { id: randomUUID(), createdAt: Date.now(), manifest }
      currentManifestSnapshot = snapshot
      manifestSnapshots.set(snapshot.id, snapshot)
      for (const [id, candidate] of manifestSnapshots) {
        if (id !== snapshot.id && snapshot.createdAt - candidate.createdAt > ARTIFACT_MANIFEST_SNAPSHOT_RETENTION_MS) manifestSnapshots.delete(id)
      }
      while (manifestSnapshots.size > 2) {
        const oldest = [...manifestSnapshots.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
        if (!oldest || oldest.id === snapshot.id) break
        manifestSnapshots.delete(oldest.id)
      }
      return snapshot
    }).finally(() => {
      manifestBuild = undefined
    })
    return manifestBuild
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    // Engine.IO exclusively owns this path and may already have committed the
    // polling response before Node invokes this later request listener.
    if (url.startsWith('/socket.io/') || routeClaimed(req) || res.headersSent || res.writableEnded) return
    // Keep error responses CORS-readable too; sendJson also applies the same
    // policy, but capability denials commonly use sendError.
    const corsHeaders: Record<string, string> = {}
    applyCorsHeaders(req, corsHeaders)
    for (const [name, value] of Object.entries(corsHeaders)) res.setHeader(name, value)
    // Strip query string / fragment before matching, so `/models?ts=…`
    // (cache-buster) still hits.
    const path = url.split('?')[0]?.split('#')[0] ?? ''
    if ((path === '/api/v1' || path.startsWith('/api/v1/')) && payloads.publicApiHandler) {
      claimRoute(req)
      void payloads.publicApiHandler(req, res).catch((error) => {
        if (res.writableEnded) return
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: { code: 'internal_error', message: 'internal API error', requestId: req.headers['x-request-id'] ?? 'unknown' } }))
        payloads.audit?.log({ action: 'public_api.unhandled_error', actor: httpActor(req, payloads.auth), outcome: 'error', error: error instanceof Error ? error.message : String(error) })
      })
      return
    }
    if ((path === '/memo' || path === '/user/session-tabs') && ['GET', 'HEAD', 'PUT'].includes(req.method ?? '') && payloads.memoStore) {
      claimRoute(req)
      const principalOwner = memoOwner(req)
      const owner = principalOwner ? `${principalOwner}:${path === '/memo' ? 'memo' : 'session-tabs'}` : undefined
      if (!owner) { sendError(res, 401, 'memo_authentication_required'); return }
      if (req.method === 'GET' || req.method === 'HEAD') {
        void payloads.memoStore.read(owner).then((body) => sendJson(req, res, body)).catch((error) => sendError(res, 500, error instanceof Error ? error.message : String(error)))
        return
      }
      void readJson(req).then((raw) => {
        const body = raw as { content?: unknown; expectedRevision?: unknown }
        if (typeof body.content !== 'string' || (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0))) throw new HttpRouteError(400, 'invalid_memo_document')
        return payloads.memoStore!.write(owner, { content: body.content, ...(body.expectedRevision !== undefined ? { expectedRevision: Number(body.expectedRevision) } : {}) })
      }).then((body) => sendJson(req, res, body)).catch((error) => sendError(res, error instanceof Error && error.message === 'memo_revision_conflict' ? 409 : error instanceof HttpRouteError ? error.status : 500, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      const body = payloads.metrics?.render() ?? ''
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    if (req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type, authorization',
        'access-control-max-age': '600',
      }
      applyCorsHeaders(req, headers)
      if (headers['access-control-allow-origin']) {
        claimRoute(req)
        res.writeHead(204, headers)
        res.end()
        return
      }
    }
    const sessionToolLockMatch = path.match(/^\/runtime\/sessions\/([^/]+)\/tool-lock$/u)
    if (sessionToolLockMatch && req.method === 'GET' && payloads.sessions) {
      claimRoute(req)
      const record = payloads.sessions.get(decodeURIComponent(sessionToolLockMatch[1] ?? ''))
      if (!record) { sendError(res, 404, 'session not found'); return }
      const accessError = httpSessionAccessError(req, record)
      if (accessError) { sendError(res, accessError.status, accessError.message); return }
      sendJson(req, res, { sessionId: record.sessionId, tools: record.toolLock })
      return
    }
    if (path === '/runtime/tool-registry' && req.method === 'GET' && payloads.toolRegistry) {
      claimRoute(req)
      const executors = payloads.executorsSnapshot?.() ?? []
      sendJson(req, res, {
        generatedAt: new Date().toISOString(),
        tools: payloads.toolRegistry().map((tool) => { const required = tool.version ?? '0.0.0'; return { name: tool.name, version: required, schemaHash: tool.schemaHash ?? null, source: tool.toolsetId ?? 'unknown', execution: tool.executionKind ?? 'executor', implementations: executors.map((executor) => { const version = executor.toolImplementations?.[tool.executionHandler ?? tool.name]?.version; return { workspaceId: executor.workspaceId, version: version ?? null, status: compareToolVersions(required, version) } }) } }),
      })
      return
    }
    if (path === '/runtime/capabilities' && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      const deployment = payloads.deployment ?? PORTABLE_DEPLOYMENT
      sendJson(req, res, {
        product: productVariant(deployment),
        deployment,
        capabilities: payloads.capabilities ?? { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
        ...(payloads.evaluationUrl ? { integrations: { evaluation: { url: payloads.evaluationUrl } } } : {}),
      })
      return
    }
    if (path === '/themes/marketplace/search' && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''
      void searchMarketplaceThemes(query)
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, err instanceof HttpThemeError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    const themeExtensionMatch = path.match(/^\/themes\/marketplace\/extensions\/([^/]+)\/([^/]+)$/u)
    if (themeExtensionMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      void readMarketplaceThemeExtension(decodeURIComponent(themeExtensionMatch[1] ?? ''), decodeURIComponent(themeExtensionMatch[2] ?? ''))
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, err instanceof HttpThemeError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    const themeMatch = path.match(/^\/themes\/marketplace\/extensions\/([^/]+)\/([^/]+)\/themes\/([^/]+)$/u)
    if (themeMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      void readMarketplaceTheme(
        decodeURIComponent(themeMatch[1] ?? ''),
        decodeURIComponent(themeMatch[2] ?? ''),
        decodeURIComponent(themeMatch[3] ?? ''),
      )
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, err instanceof HttpThemeError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/auth/github/start' && req.method === 'GET' && payloads.auth?.github) {
      claimRoute(req)
      try {
        const location = buildGithubStart(payloads.auth.github, res)
        res.statusCode = 302
        res.setHeader('location', location)
        res.end()
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/auth/github/callback' && req.method === 'GET' && payloads.auth?.github) {
      claimRoute(req)
      void finishGithubOAuth(req, payloads.auth.github)
        .then((result) => {
          if (!result.ok) {
            payloads.audit?.log({ action: 'auth.github_callback', actor: { kind: 'anonymous' }, outcome: 'denied', error: result.reason })
            sendError(res, 403, result.reason)
            return
          }
          setGithubSessionCookie(res, payloads.auth!.github!, result.session)
          payloads.audit?.log({ action: 'auth.github_login', actor: { kind: 'github_user', login: result.session.login, ...(result.session.id !== undefined ? { id: result.session.id } : {}) }, outcome: 'ok' })
          res.statusCode = 302
          res.setHeader('location', '/')
          res.end()
        })
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      claimRoute(req)
      clearGithubSessionCookie(res)
      sendJson(req, res, { ok: true })
      return
    }
    if (path === '/auth/executor-invites' && req.method === 'GET') {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_invite.list', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, auth.status, auth.error)
        return
      }
      void Promise.resolve(payloads.auth?.executorIdentityStore?.inviteSnapshot() ?? [])
        .then((invites) => sendJson(req, res, { invites } satisfies ServerExecutorInvitesPayload))
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/auth/executor-pairings' && req.method === 'POST') {
      claimRoute(req)
      void readJson(req).then(async (body) => {
        const input=body as {workspaceId?:unknown;label?:unknown};const workspaceId=cleanString(input.workspaceId)
        if(!workspaceId){sendError(res,400,'workspaceId is required');return}
        const pairing=await payloads.auth?.executorIdentityStore?.createPairing({workspaceId,label:cleanString(input.label)})
        if(!pairing){sendError(res,500,'executor identity store is not configured');return}
        payloads.audit?.log({action:'executor_pairing.request',actor:{kind:'anonymous'},target:{workspaceId},outcome:'ok',metadata:{id:pairing.id}})
        sendJson(req,res,pairing)
      }).catch((e)=>sendError(res,400,e instanceof Error?e.message:String(e)));return
    }
    if (path === '/auth/executor-pairings' && req.method === 'GET') { claimRoute(req);const auth=authorizeSensitiveManagement(req,effectiveTenancy(payloads.deployment??PORTABLE_DEPLOYMENT),payloads.auth);if(!auth.ok){sendError(res,auth.status,auth.error);return}void Promise.resolve(payloads.auth?.executorIdentityStore?.pairingSnapshot()??[]).then((pairings)=>sendJson(req,res,{pairings})).catch((e:unknown)=>sendError(res,500,e instanceof Error?e.message:String(e)));return }
    const pairingMatch=path.match(/^\/auth\/executor-pairings\/([^/]+)\/(approve|reject|claim)$/u)
    if(pairingMatch&&req.method==='POST'){
      claimRoute(req);const id=decodeURIComponent(pairingMatch[1]??''),action=pairingMatch[2]
      if(action==='claim'){void readJson(req).then(async(body)=>{const secret=cleanString((body as {claimSecret?:unknown}).claimSecret);const result=secret?await payloads.auth?.executorIdentityStore?.claimPairing(id,secret):undefined;if(!result){sendError(res,404,'pairing not found');return}sendJson(req,res,result)}).catch((e:unknown)=>sendError(res,500,e instanceof Error?e.message:String(e)));return}
      const auth=authorizeSensitiveManagement(req,effectiveTenancy(payloads.deployment??PORTABLE_DEPLOYMENT),payloads.auth);if(!auth.ok){sendError(res,auth.status,auth.error);return}
      void Promise.resolve(payloads.auth?.executorIdentityStore?.decidePairing(id,action==='approve')).then((result)=>{if(!result){sendError(res,404,'pending pairing not found');return}payloads.audit?.log({action:`executor_pairing.${action}`,actor:auth.actor,target:{workspaceId:result.workspaceId},outcome:'ok',metadata:{id}});sendJson(req,res,result)}).catch((e:unknown)=>sendError(res,500,e instanceof Error?e.message:String(e)));return
    }
    if (path === '/auth/executor-invites' && req.method === 'POST') {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_invite.create', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, auth.status, auth.error)
        return
      }
      void readJson(req)
        .then(async (body) => {
          const input = typeof body === 'object' && body !== null ? body as { label?: unknown; workspaceId?: unknown } : {}
          const invite = await payloads.auth?.executorIdentityStore?.createInvite({ label: cleanString(input.label), workspaceId: cleanString(input.workspaceId) })
          if (!invite) {
            sendError(res, 500, 'executor identity store is not configured')
            return
          }
          const response: ServerExecutorInvitePayload = invite
          payloads.audit?.log({ action: 'executor_invite.create', actor: httpActor(req, payloads.auth), outcome: 'ok', target: invite.workspaceId ? { workspaceId: invite.workspaceId } : undefined, metadata: { id: invite.id } })
          sendJson(req, res, response)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    const invitePathMatch = path.match(/^\/auth\/executor-invites\/([^/]+)(?:\/(regenerate|revoke))?$/u)
    if (invitePathMatch && (req.method === 'PATCH' || req.method === 'DELETE' || req.method === 'POST')) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_invite.manage', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, auth.status, auth.error)
        return
      }
      const id = decodeURIComponent(invitePathMatch[1] ?? '').trim()
      const action = invitePathMatch[2]
      if (!id) {
        sendError(res, 400, 'invite id is required')
        return
      }
      if (req.method === 'PATCH' && !action) {
        void readJson(req)
          .then(async (body) => {
            const input = typeof body === 'object' && body !== null ? body as { label?: unknown; workspaceId?: unknown } : {}
            const updated = await payloads.auth?.executorIdentityStore?.updateInvite(id, {
              ...(Object.prototype.hasOwnProperty.call(input, 'label') ? { label: cleanString(input.label) ?? '' } : {}),
              ...(Object.prototype.hasOwnProperty.call(input, 'workspaceId') ? { workspaceId: input.workspaceId === null ? null : cleanString(input.workspaceId) ?? '' } : {}),
            })
            if (!updated) {
              sendError(res, 404, 'invite not found')
              return
            }
            payloads.audit?.log({ action: 'executor_invite.update', actor: httpActor(req, payloads.auth), outcome: 'ok', metadata: { id } })
            sendJson(req, res, updated)
          })
          .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
        return
      }
      if (req.method === 'DELETE' && !action) {
        void Promise.resolve(payloads.auth?.executorIdentityStore?.deleteInvite(id) ?? false).then((deleted) => {
          payloads.audit?.log({ action: 'executor_invite.delete', actor: httpActor(req, payloads.auth), outcome: deleted ? 'ok' : 'denied', ...(deleted ? {} : { error: 'invite_not_found' }), metadata: { id } })
          if (!deleted) { sendError(res, 404, 'invite not found'); return }
          sendJson(req, res, { ok: true, id, deleted: true })
        }).catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
        return
      }
      if (req.method === 'POST' && action === 'revoke') {
        void Promise.resolve(payloads.auth?.executorIdentityStore?.revokeInvite(id) ?? false).then((revoked) => {
          payloads.audit?.log({ action: 'executor_invite.revoke', actor: httpActor(req, payloads.auth), outcome: revoked ? 'ok' : 'denied', ...(revoked ? {} : { error: 'invite_not_found_or_revoked' }), metadata: { id } })
          if (!revoked) { sendError(res, 404, 'invite not found or already revoked'); return }
          const body: ServerExecutorInviteRevokedPayload = { ok: true, id, revoked: true }
          sendJson(req, res, body)
        }).catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
        return
      }
      if (req.method === 'POST' && action === 'regenerate') {
        void Promise.resolve(payloads.auth?.executorIdentityStore?.regenerateInvite(id)).then((invite) => {
          if (!invite) {
            sendError(res, 404, 'invite not found')
            return
          }
          const response: ServerExecutorInvitePayload = invite
          payloads.audit?.log({ action: 'executor_invite.regenerate', actor: httpActor(req, payloads.auth), outcome: 'ok', metadata: { id } })
          sendJson(req, res, response)
        }).catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
        return
      }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (path === '/auth/executor-identities' && req.method === 'GET') {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_identity.list', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, auth.status, auth.error)
        return
      }
      void Promise.resolve(payloads.auth?.executorIdentityStore?.snapshot() ?? []).then((identities) => {
        const body: ServerExecutorIdentitiesPayload = {
          identities: identities.map((entry) => ({
            workspaceId: entry.workspaceId,
            ...(entry.label ? { label: entry.label } : {}),
            createdAt: entry.createdAt,
            ...(entry.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
          })),
        }
        sendJson(req, res, body)
      }).catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/auth/executor-identities' && req.method === 'DELETE') {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_identity.revoke', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, auth.status, auth.error)
        return
      }
      const parsed = new URL(url, 'http://x')
      const workspaceId = parsed.searchParams.get('workspaceId')?.trim() ?? ''
      if (!workspaceId) {
        sendError(res, 400, 'workspaceId is required')
        return
      }
      void Promise.resolve(payloads.auth?.executorIdentityStore?.revokeWorkspace(workspaceId) ?? false).then((revoked) => {
        payloads.audit?.log({ action: 'executor_identity.revoke', actor: httpActor(req, payloads.auth), target: { workspaceId }, outcome: revoked ? 'ok' : 'denied', ...(revoked ? {} : { error: 'identity_not_found' }) })
        const body: ServerExecutorIdentityRevokedPayload = { ok: true, workspaceId, revoked }
        sendJson(req, res, body)
      }).catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    const internalToolBarrier = /^\/internal\/runtime\/tool-result\/([^/]+)\/([^/]+)$/u.exec(path)
    if (internalToolBarrier && payloads.toolResultPersisted && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      if (!internalIngressAuthorized(req)) { sendError(res, 401, 'invalid ingress handoff'); return }
      void payloads.toolResultPersisted(decodeURIComponent(internalToolBarrier[1]!), decodeURIComponent(internalToolBarrier[2]!))
        .then((persisted) => sendJson(req, res, { persisted }))
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (payloads.auth?.github?.required && isProtectedJsonRoute(path)) {
      const auth = authenticateDashboardHandshake(undefined, req, payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'http.auth_reject', actor: { kind: 'anonymous' }, target: { path, method: req.method }, outcome: 'denied', error: auth.reason })
        claimRoute(req)
        sendError(res, 401, auth.reason)
        return
      }
    }
    if (path === '/settings/web-search' && payloads.webSearchCredentials) {
      claimRoute(req)
      if (req.method === 'GET' || req.method === 'HEAD') {
        void Promise.resolve(payloads.webSearchCredentials.status())
          .then((body) => sendJson(req, res, body))
          .catch((error: unknown) => sendError(res, 500, error instanceof Error ? error.message : String(error)))
        return
      }
      if (req.method === 'PUT') {
        const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
        if (!auth.ok) { sendError(res, auth.status, auth.error); return }
        void readJson(req).then((raw) => {
          const body = typeof raw === 'object' && raw !== null ? raw as { provider?: unknown; apiKey?: unknown; key?: unknown } : {}
          if (body.provider !== 'serper') throw new HttpRouteError(400, 'provider must be serper')
          const key = body.apiKey ?? body.key
          if (typeof key !== 'string' || key !== key.trim() || key.length < 8 || key.length > 512) {
            throw new HttpRouteError(400, 'key must be a trimmed string between 8 and 512 characters')
          }
          return payloads.webSearchCredentials!.set('serper', key)
        }).then((body) => sendJson(req, res, body))
          .catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 500, error instanceof Error ? error.message : String(error)))
        return
      }
      if (req.method === 'DELETE') {
        const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
        if (!auth.ok) { sendError(res, auth.status, auth.error); return }
        void Promise.resolve(payloads.webSearchCredentials.delete('serper'))
          .then((body) => sendJson(req, res, body))
          .catch((error: unknown) => sendError(res, 500, error instanceof Error ? error.message : String(error)))
        return
      }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (path === '/settings/web-search/test' && req.method === 'POST' && payloads.webSearchCredentials) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void runWebSearch({ query: 'Kala', limit: 1 }, { credentials: payloads.webSearchCredentials })
        .then((result) => {
          if (!result.ok) {
            sendError(res, result.failure?.code === 'ESEARCH_CREDENTIAL' ? 400 : 502, result.content)
            return
          }
          sendJson(req, res, { ok: true })
        })
        .catch((error: unknown) => sendError(res, 502, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/settings/speech' && payloads.speechCredentials) {
      claimRoute(req)
      if (req.method === 'GET' || req.method === 'HEAD') {
        void Promise.resolve(payloads.speechCredentials.status())
          .then((body) => sendJson(req, res, body))
          .catch((error: unknown) => sendError(res, 500, error instanceof Error ? error.message : String(error)))
        return
      }
      if (req.method === 'PUT') {
        const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
        if (!auth.ok) { sendError(res, auth.status, auth.error); return }
        void readJson(req).then((raw) => {
          const body = typeof raw === 'object' && raw !== null
            ? raw as {
                endpoint?: unknown
                apiKey?: unknown
                enabled?: unknown
                mode?: unknown
                realtimeMaxMinutes?: unknown
                afterRecordingMaxMinutes?: unknown
              }
            : {}
          if (typeof body.endpoint !== 'string') throw new HttpRouteError(400, 'endpoint is required')
          let endpoint: string
          try {
            endpoint = normalizeAzureSpeechEndpoint(body.endpoint).endpoint
          } catch (error) {
            throw new HttpRouteError(400, error instanceof Error ? error.message : String(error))
          }
          if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpRouteError(400, 'enabled must be a boolean')
          const enabled = typeof body.enabled === 'boolean' ? body.enabled : true
          if (body.mode !== undefined && body.mode !== 'realtime' && body.mode !== 'after_recording') {
            throw new HttpRouteError(400, 'mode must be realtime or after_recording')
          }
          for (const [field, value] of [
            ['realtimeMaxMinutes', body.realtimeMaxMinutes],
            ['afterRecordingMaxMinutes', body.afterRecordingMaxMinutes],
          ] as const) {
            if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SPEECH_MAX_MINUTES)) {
              throw new HttpRouteError(400, `${field} must be an integer between 1 and ${MAX_SPEECH_MAX_MINUTES}`)
            }
          }
          const mode = body.mode === 'after_recording' ? 'after_recording' : 'realtime'
          const apiKey = body.apiKey
          if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey !== apiKey.trim() || apiKey.length < 16 || apiKey.length > 512)) {
            throw new HttpRouteError(400, 'apiKey must be a trimmed string between 16 and 512 characters')
          }
          return Promise.resolve(payloads.speechCredentials!.status()).then((status) => {
            if (typeof apiKey !== 'string' && !status.configured) throw new HttpRouteError(400, 'an Azure Speech key is required')
            return payloads.speechCredentials!.set({
              endpoint,
              enabled,
              mode,
              ...(typeof body.realtimeMaxMinutes === 'number' ? { realtimeMaxMinutes: body.realtimeMaxMinutes } : {}),
              ...(typeof body.afterRecordingMaxMinutes === 'number' ? { afterRecordingMaxMinutes: body.afterRecordingMaxMinutes } : {}),
              ...(typeof apiKey === 'string' ? { apiKey } : {}),
            })
          })
        }).then((body) => sendJson(req, res, body))
          .catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 500, error instanceof Error ? error.message : String(error)))
        return
      }
      if (req.method === 'DELETE') {
        const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
        if (!auth.ok) { sendError(res, auth.status, auth.error); return }
        void Promise.resolve(payloads.speechCredentials.delete())
          .then((body) => sendJson(req, res, body))
          .catch((error: unknown) => sendError(res, 500, error instanceof Error ? error.message : String(error)))
        return
      }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (path === '/settings/speech/test' && req.method === 'POST' && payloads.speechCredentials) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void issueAzureSpeechToken(payloads.speechCredentials, { allowDisabled: true })
        .then(() => sendJson(req, res, { ok: true }))
        .catch((error: unknown) => sendError(res, 502, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/runtime/speech/token' && req.method === 'POST' && payloads.speechCredentials) {
      claimRoute(req)
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      if (!dashboardActorCanWrite(auth.actor)) { sendError(res, 403, 'forbidden'); return }
      void issueAzureSpeechToken(payloads.speechCredentials)
        .then((body) => sendJson(req, res, body))
        .catch((error: unknown) => sendError(res, 502, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/runtime/speech/transcribe' && req.method === 'POST' && payloads.speechCredentials) {
      claimRoute(req)
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      if (!dashboardActorCanWrite(auth.actor)) { sendError(res, 403, 'forbidden'); return }
      void (async () => {
        const declaredLength = Number(req.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > MAX_SPEECH_RECORDING_BYTES) {
          throw new HttpRouteError(413, `Recording exceeds ${MAX_SPEECH_RECORDING_BYTES} bytes`)
        }
        const mediaType = typeof req.headers['content-type'] === 'string'
          ? req.headers['content-type'].split(';', 1)[0]!.trim().toLowerCase()
          : ''
        if (!['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4'].includes(mediaType)) {
          throw new HttpRouteError(415, 'unsupported recording media type')
        }
        const audio = await readBytes(req, MAX_SPEECH_RECORDING_BYTES, 'Recording')
        if (audio.byteLength === 0) throw new HttpRouteError(400, 'recording is empty')
        return transcribeAzureSpeechAudio(payloads.speechCredentials!, { audio, mediaType })
      })()
        .then((body) => sendJson(req, res, body))
        .catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 502, error instanceof Error ? error.message : String(error)))
      return
    }
    const toolBarrier = /^\/runtime\/sessions\/([^/]+)\/tool-result\/([^/]+)$/u.exec(path)
    if (toolBarrier && payloads.toolResultPersisted && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      void (async () => {
        const sessionId = decodeURIComponent(toolBarrier[1]!)
        const record = payloads.sessions?.get(sessionId) ?? await payloads.sessions?.load(sessionId, { recoverDangling: false }).catch(() => undefined)
        const accessError = httpSessionAccessError(req, record)
        if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
        return payloads.toolResultPersisted!(sessionId, decodeURIComponent(toolBarrier[2]!))
      })()
        .then((persisted) => sendJson(req, res, { persisted }))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/runtime/admission/messages' && payloads.enqueueUserMessage && req.method === 'POST') {
      claimRoute(req)
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      if (!dashboardActorCanWrite(auth.actor)) { sendError(res, 403, 'forbidden'); return }
      void readJson(req).then(async (body) => {
        const payloadError = validateClientMessagePayload(body)
        if (payloadError) throw new HttpRouteError(413, `${payloadError.code}: ${payloadError.message}`)
        const input = schema.ClientUserMessageSchema.safeParse(body)
        if (!input.success || !input.data.operationId) throw new HttpRouteError(400, 'invalid admission message')
        const imageValidation = validateInlineMessageImages(input.data.content)
        if (!imageValidation.ok) throw new HttpRouteError(400, `${imageValidation.error.code}: ${imageValidation.error.message}`)
        const fileValidation = validateInlineMessageFiles(input.data.content)
        if (!fileValidation.ok) throw new HttpRouteError(400, `${fileValidation.error.code}: ${fileValidation.error.message}`)
        if (!input.data.text.trim() && !input.data.content?.length) throw new HttpRouteError(400, 'message content is required')
        await validateMessageAttachmentReferences(payloads.messageAttachments, input.data.sessionId, input.data.content)
        const session = await payloads.sessions?.load(input.data.sessionId, { recoverDangling: false }).catch((error) => {
          if (error instanceof SessionNotFoundError) throw error
          throw new HttpRouteError(400, error instanceof Error ? error.message : String(error))
        })
        const accessError = httpSessionAccessError(req, session)
        if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
        const outcome = await payloads.enqueueUserMessage!({
          sessionId: input.data.sessionId, operationId: input.data.operationId, text: input.data.text,
          intent: input.data.intent, mode: input.data.mode ?? 'steer', ...(input.data.content ? { content: input.data.content } : {}),
        })
        sendJsonStatus(req, res, 202, { accepted: true, duplicate: false, operationId: input.data.operationId, sequence: 0, state: outcome.committed ? 'committed' : 'pending', routeGeneration: 0, ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}) })
      }).catch((error) => {
        sendError(res, error instanceof HttpRouteError ? error.status : error instanceof SessionNotFoundError ? 404 : 400, error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (path === '/runtime/attachments' && payloads.messageAttachments && payloads.sessions && req.method === 'POST') {
      claimRoute(req)
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      if (!dashboardActorCanWrite(auth.actor)) { sendError(res, 403, 'forbidden'); return }
      void (async () => {
        const requestUrl = new URL(url, 'http://localhost')
        const sessionId = requestUrl.searchParams.get('sessionId')?.trim()
        const encodedName = req.headers['x-agent-runlab-attachment-name']
        if (!sessionId || typeof encodedName !== 'string') throw new HttpRouteError(400, 'sessionId and attachment name are required')
        let name: string
        try { name = decodeURIComponent(encodedName) } catch { throw new HttpRouteError(400, 'invalid attachment name') }
        const declaredLength = Number(req.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MESSAGE_ATTACHMENT_BYTES) {
          throw new HttpRouteError(413, `Attachment exceeds ${MAX_MESSAGE_ATTACHMENT_BYTES} bytes`)
        }
        const session = await payloads.sessions!.load(sessionId, { recoverDangling: false })
        const accessError = httpSessionAccessError(req, session)
        if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
        const data = await readBytes(req, MAX_MESSAGE_ATTACHMENT_BYTES)
        await assertTenantStorageQuota(payloads.storageQuota, session, 'message_attachment', data.byteLength)
        const mediaType = typeof req.headers['content-type'] === 'string'
          ? req.headers['content-type'].split(';', 1)[0]!.trim().toLowerCase()
          : 'application/octet-stream'
        const imageMediaType = supportedImageMediaType(mediaType)
        if (imageMediaType) assertImageAttachmentBytes(imageMediaType, data)
        if (session.agentRuntime === 'kernel') assertKernelTextAttachment({ name, mediaType }, data)
        const file = await payloads.messageAttachments!.register({
          sessionId,
          name,
          mediaType,
          data,
        })
        sendJsonStatus(req, res, 201, { file })
      })().catch((error) => {
        const status = error instanceof HttpRouteError
          ? error.status
          : error instanceof SessionNotFoundError
            ? 404
            : 400
        sendError(res, status, error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (path === '/runtime/attachments/release' && payloads.messageAttachments && req.method === 'POST') {
      claimRoute(req)
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      if (!dashboardActorCanWrite(auth.actor)) { sendError(res, 403, 'forbidden'); return }
      void readJson(req).then(async (body) => {
        if (!body || typeof body !== 'object') throw new HttpRouteError(400, 'invalid release request')
        const input = body as Record<string, unknown>
        if (typeof input.sessionId !== 'string' || !Array.isArray(input.attachmentIds)) {
          throw new HttpRouteError(400, 'sessionId and attachmentIds are required')
        }
        const session = await payloads.sessions?.load(input.sessionId, { recoverDangling: false }).catch((error) => {
          if (error instanceof SessionNotFoundError) throw error
          throw new HttpRouteError(400, error instanceof Error ? error.message : String(error))
        })
        const accessError = httpSessionAccessError(req, session)
        if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
        const attachmentIds = input.attachmentIds.filter((value): value is string => typeof value === 'string')
        if (attachmentIds.length !== input.attachmentIds.length) throw new HttpRouteError(400, 'invalid attachmentIds')
        await payloads.messageAttachments!.releasePending(input.sessionId, attachmentIds)
        sendJsonStatus(req, res, 200, { released: true })
      }).catch((error) => sendError(res, error instanceof HttpRouteError ? error.status : 400, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/internal/runtime/attachments/commit' && payloads.messageAttachments && req.method === 'POST') {
      claimRoute(req)
      if (!internalIngressAuthorized(req)) { sendError(res, 401, 'unauthorized'); return }
      void readJson(req).then(async (body) => {
        if (!body || typeof body !== 'object') throw new HttpRouteError(400, 'invalid attachment commit request')
        const input = body as Record<string, unknown>
        const content = schema.MessageContentSchema.array().safeParse(input.content ?? [])
        if (typeof input.sessionId !== 'string' || !content.success) throw new HttpRouteError(400, 'invalid attachment commit request')
        await payloads.messageAttachments!.commitReferences(input.sessionId, content.data)
        sendJsonStatus(req, res, 200, { committed: true })
      }).catch((error) => sendError(res, error instanceof HttpRouteError ? error.status : 400, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/internal/runtime/quiescence' && payloads.unitQuiescence && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      sendJson(req, res, payloads.unitQuiescence())
      return
    }
    if (path === '/internal/runtime/cutover/reserve' && payloads.reserveCutover && req.method === 'POST') {
      claimRoute(req)
      void payloads.reserveCutover().then((snapshot) => sendJson(req, res, snapshot)).catch((error) => sendError(res, 409, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/internal/runtime/cutover/release' && payloads.releaseCutover && req.method === 'POST') {
      claimRoute(req)
      payloads.releaseCutover()
      sendJson(req, res, { ok: true })
      return
    }
    if (path === '/internal/runtime/admission/commit' && payloads.enqueueUserMessage && req.method === 'POST') {
      claimRoute(req)
      if (!internalIngressAuthorized(req)) { sendError(res, 401, 'invalid ingress handoff'); return }
      void readJson(req).then(async (body) => {
        const input = body as Record<string, unknown>
        const sessionId = requiredString(input.sessionId, 'sessionId')
        const operationId = requiredString(input.operationId, 'operationId')
        const text = typeof input.text === 'string' ? input.text : ''
        const mode = input.mode === 'steer' ? 'steer' : 'queue'
        const intent = input.intent === 'text' || input.intent === 'shell' ? input.intent : undefined
        if (!intent) throw new Error('intent is required')
        const content = Array.isArray(input.content) ? input.content as readonly import('@agent-kernel/kernel').MessageContent[] : undefined
        if (!text.trim() && !content?.length) throw new Error('message content is required')
        await validateMessageAttachmentReferences(payloads.messageAttachments, sessionId, content)
        let outcome: { accepted?: boolean; committed: boolean; cursor?: number }
        try {
          outcome = await payloads.enqueueUserMessage!({ sessionId, operationId, text, intent, mode, ...(content ? { content } : {}) })
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            sendJsonStatus(req, res, 404, { error: 'The target Session no longer exists', code: 'SESSION_NOT_FOUND' })
            return
          }
          throw error
        }
        sendJson(req, res, { accepted: outcome.accepted ?? outcome.committed, committed: outcome.committed, operationId, ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}) })
      }).catch((error) => sendError(res, error instanceof HttpRouteError ? error.status : 400, error instanceof Error ? error.message : String(error)))
      return
    }
    const internalRestartPath = path.startsWith('/internal/runtime/restart')
    if (internalRestartPath && !internalIngressAuthorized(req)) {
      claimRoute(req)
      sendError(res, 401, 'invalid runtime handoff')
      return
    }
    const publicRestartPath = path.startsWith('/runtime/restart')
    if (publicRestartPath && (payloads.deployment ?? PORTABLE_DEPLOYMENT).architecture === 'platform') {
      claimRoute(req)
      sendError(res, 409, 'legacy runtime restart is disabled for platform deployments; use the Deploy Supervisor protocol')
      return
    }
    if ((path === '/runtime/restart/status' || path === '/internal/runtime/restart/status') && payloads.restartStatus && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      sendJson(req, res, payloads.restartStatus())
      return
    }
    if ((path === '/runtime/restart' || path === '/internal/runtime/restart') && payloads.requestRestart && req.method === 'POST') {
      claimRoute(req)
      void readJson(req)
        .then(async (body) => {
          const input = parseRestartRequest(body)
          const result = await payloads.requestRestart!(input)
          payloads.audit?.log({ action: 'runtime.restart_request', actor: httpActor(req, payloads.auth), outcome: 'ok', metadata: { mode: result.mode, reason: result.reason, attemptId: result.attemptId } })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if ((path === '/runtime/restart/commit' || path === '/internal/runtime/restart/commit') && payloads.commitRestartActivation && req.method === 'POST') {
      claimRoute(req)
      void readJson(req).then((body) => {
        const attemptId = typeof (body as { attemptId?: unknown })?.attemptId === 'string' ? (body as { attemptId: string }).attemptId : ''
        const result = attemptId ? payloads.commitRestartActivation!(attemptId) : null
        if (!result) { sendError(res, 409, 'restart activation commit rejected'); return }
        sendJson(req, res, result)
      }).catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if ((path === '/runtime/restart/abort' || path === '/internal/runtime/restart/abort') && payloads.abortRestart && req.method === 'POST') {
      claimRoute(req)
      void readJson(req).catch(() => ({})).then((body) => {
        const attemptId = typeof (body as { attemptId?: unknown })?.attemptId === 'string' ? (body as { attemptId: string }).attemptId : undefined
        const result = payloads.abortRestart!(attemptId)
        payloads.audit?.log({ action: 'runtime.restart_abort', actor: httpActor(req, payloads.auth), outcome: result ? 'ok' : 'denied' })
        sendJson(req, res, result ?? { ok: false })
      })
      return
    }
    if (path === '/settings/models' && req.method === 'POST' && payloads.addManualModel) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientAddManualModelSchema, body, { channel: 'POST /settings/models' })
          if (!input) {
            sendError(res, 400, 'invalid manual model input')
            return
          }
          const result = payloads.addManualModel!(input)
          payloads.audit?.log({ action: 'settings.model_add', actor: httpActor(req, payloads.auth), target: { providerId: input.providerId, model: input.id }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/models' && req.method === 'DELETE' && payloads.deleteManualModel) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      const parsed = new URL(url, 'http://x')
      try {
        const input = parseWire(schema.ClientDeleteManualModelSchema, {
          providerId: parsed.searchParams.get('providerId') ?? '',
          id: parsed.searchParams.get('id') ?? '',
        }, { channel: 'DELETE /settings/models' })
        if (!input) {
          sendError(res, 400, 'invalid manual model delete input')
          return
        }
        const result = payloads.deleteManualModel(input)
        payloads.audit?.log({ action: 'settings.model_delete', actor: httpActor(req, payloads.auth), target: { providerId: input.providerId, model: input.id }, outcome: 'ok' })
        sendJson(req, res, result)
      } catch (err: unknown) {
        sendError(res, 400, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/settings/providers' && req.method === 'POST' && payloads.addManualProvider) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientAddManualProviderSchema, body, { channel: 'POST /settings/providers' })
          if (!input) {
            sendError(res, 400, 'invalid manual provider input')
            return
          }
          const result = payloads.addManualProvider!(input)
          payloads.audit?.log({ action: 'settings.provider_add', actor: httpActor(req, payloads.auth), target: { providerId: input.id }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/providers' && req.method === 'DELETE' && payloads.deleteManualProvider) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      const parsed = new URL(url, 'http://x')
      try {
        const input = parseWire(schema.ClientDeleteManualProviderSchema, {
          providerId: parsed.searchParams.get('providerId') ?? '',
        }, { channel: 'DELETE /settings/providers' })
        if (!input) {
          sendError(res, 400, 'invalid manual provider delete input')
          return
        }
        const result = payloads.deleteManualProvider(input)
        payloads.audit?.log({ action: 'settings.provider_delete', actor: httpActor(req, payloads.auth), target: { providerId: input.providerId }, outcome: 'ok' })
        sendJson(req, res, result)
      } catch (err: unknown) {
        sendError(res, 400, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/settings/default-model' && req.method === 'POST' && payloads.setDefaultModel) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientSetDefaultModelSchema, body, { channel: 'POST /settings/default-model' })
          if (!input) {
            sendError(res, 400, 'invalid default model input')
            return
          }
          const result = payloads.setDefaultModel!(input)
          payloads.audit?.log({ action: 'settings.default_model_set', actor: httpActor(req, payloads.auth), target: { model: input.model }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/agent-prompt' && req.method === 'POST' && payloads.updateAgentPrompt) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientUpdateAgentPromptSettingsSchema, body, { channel: 'POST /settings/agent-prompt' })
          if (!input) {
            sendError(res, 400, 'invalid agent prompt settings input')
            return
          }
          return Promise.resolve(payloads.updateAgentPrompt!(input, auth.actor)).then((result) => {
            payloads.audit?.log({ action: 'settings.agent_prompt_update', actor: auth.actor, target: { slotId: input.selectedSlotId }, outcome: 'ok' })
            sendJson(req, res, result)
          })
        })
        .catch((err: unknown) => {
          const status = err instanceof Error && 'status' in err && typeof err.status === 'number'
            ? err.status
            : 400
          const message = err instanceof Error ? err.message : String(err)
          if (status === 503 && err instanceof Error && 'settingsSaved' in err && err.settingsSaved === true) {
            sendJsonStatus(req, res, status, { error: message, settingsSaved: true })
          } else {
            sendError(res, status, message)
          }
        })
      return
    }
    if (path === '/settings/socket-admin/init' && req.method === 'POST' && payloads.initializeSocketAdmin) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void readJson(req)
        .then((body) => {
          const input = typeof body === 'object' && body !== null ? body as { password?: unknown; mode?: unknown } : {}
          const password = typeof input.password === 'string' ? input.password : ''
          if (!password.trim()) {
            sendError(res, 400, 'password is required')
            return
          }
          if (input.mode !== undefined && input.mode !== 'development' && input.mode !== 'production') {
            sendError(res, 400, 'mode must be development or production')
            return
          }
          const result = payloads.initializeSocketAdmin!({ password, ...(input.mode ? { mode: input.mode } : {}) })
          payloads.audit?.log({ action: 'settings.socket_admin_init', actor: httpActor(req, payloads.auth), outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => {
          const status = err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
            ? (err as { status: number }).status
            : 400
          sendError(res, status, err instanceof Error ? err.message : String(err))
        })
      return
    }
    if (path === '/settings/socket-admin/mode' && req.method === 'POST' && payloads.updateSocketAdminMode) {
      claimRoute(req)
      const auth = authorizeSensitiveManagement(req, effectiveTenancy(payloads.deployment ?? PORTABLE_DEPLOYMENT), payloads.auth)
      if (!auth.ok) { sendError(res, auth.status, auth.error); return }
      void readJson(req)
        .then((body) => {
          const input = typeof body === 'object' && body !== null ? body as { mode?: unknown } : {}
          if (input.mode !== 'development' && input.mode !== 'production') {
            sendError(res, 400, 'mode must be development or production')
            return
          }
          const result = payloads.updateSocketAdminMode!({ mode: input.mode })
          payloads.audit?.log({ action: 'settings.socket_admin_mode_update', actor: httpActor(req, payloads.auth), target: { mode: input.mode }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/enhancement/action' && req.method === 'POST') {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const request = body as EnhancementActionRequest
          requiredString(request.action, 'action')
          return runEnhancementAction(request, payloads)
        })
        .then((result) => {
          payloads.audit?.log({ action: 'http.enhancement_action', actor: httpActor(req, payloads.auth), target: { action: (result as { action?: unknown }).action }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (req.method === 'POST' && path === '/session-artifacts/register') {
      claimRoute(req)
      if (!payloads.sessionArtifacts || !payloads.sessions) { sendError(res, 404, 'session artifacts are not configured'); return }
      void readJson(req).then(async (body) => {
        const input = body as { sessionId?: string; title?: string; fileName?: string; data?: string }
        if (!input.sessionId || !input.fileName || !input.data) throw new HttpRouteError(400, 'sessionId, fileName, and base64 data are required')
        const session = await payloads.sessions!.load(input.sessionId)
        const accessError = httpSessionAccessError(req, session)
        if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
        const data = Buffer.from(input.data, 'base64')
        await assertTenantStorageQuota(payloads.storageQuota, session, 'session_artifact', data.byteLength)
        const record = await payloads.sessionArtifacts!.registerImage({ sessionId: input.sessionId, title: input.title, fileName: input.fileName, data })
        sendJson(req, res, { ...record, uri: `artifact://${record.artifactId}?mediaType=${encodeURIComponent(record.mediaType)}` })
      }).catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 400, error instanceof Error ? error.message : String(error)))
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (path.startsWith('/runtime/attachments/')) {
      claimRoute(req)
      if (!payloads.messageAttachments || !payloads.sessions) { sendError(res, 404, 'attachment not found'); return }
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      let attachmentId: string
      try { attachmentId = decodeURIComponent(path.slice('/runtime/attachments/'.length)) } catch { sendError(res, 400, 'invalid attachment id'); return }
      const attachmentUrl = new URL(url, 'http://localhost')
      const sessionId = attachmentUrl.searchParams.get('sessionId')
      if (!sessionId) { sendError(res, 400, 'sessionId is required'); return }
      void payloads.sessions.load(sessionId, { recoverDangling: false })
        .then(async (session) => {
          const accessError = httpSessionAccessError(req, session)
          if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
          const attachment = await payloads.messageAttachments!.resolveById(sessionId, attachmentId)
          if (!supportedImageMediaType(attachment.mediaType)) throw new HttpRouteError(409, 'attachment is not a previewable image')
          const data = req.method === 'HEAD' ? undefined : await attachment.read()
          const headers = {
            'content-type': attachment.mediaType,
            'content-length': String(attachment.bytes),
            'cache-control': 'private, max-age=31536000, immutable',
            etag: `"${attachment.sha256}"`,
            'x-content-type-options': 'nosniff',
          }
          res.writeHead(200, headers)
          res.end(data)
        })
        .catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 404, error instanceof Error ? error.message : 'attachment not found'))
      return
    }
    if (path.startsWith('/session-artifacts/')) {
      claimRoute(req)
      if (!payloads.sessionArtifacts || !payloads.sessions) { sendError(res, 404, 'artifact not found'); return }
      let artifactId: string
      try { artifactId = decodeURIComponent(path.slice('/session-artifacts/'.length)) } catch { sendError(res, 400, 'invalid artifact id'); return }
      const artifactUrl = new URL(url, 'http://localhost')
      const sessionId = artifactUrl.searchParams.get('sessionId')
      if (!sessionId) { sendError(res, 403, 'artifact does not belong to this session'); return }
      void (async () => {
        const session = await payloads.sessions!.load(sessionId)
        const accessError = httpSessionAccessError(req, session)
        if (accessError) throw new HttpRouteError(accessError.status, accessError.message)
        const record = await payloads.sessionArtifacts!.get(sessionId, artifactId)
        if (!record) throw new HttpRouteError(404, 'artifact not found')
        if (record.mediaType === 'image/svg+xml' && artifactUrl.searchParams.get('allowSvg') !== '1') {
          throw new HttpRouteError(409, 'SVG preview requires explicit confirmation')
        }
        const data = req.method === 'HEAD' ? undefined : await record.read()
        const headers = {
          'content-type': record.mediaType,
          'content-length': String(record.bytes),
          'cache-control': 'private, max-age=31536000, immutable',
          etag: `"${record.sha256}"`,
          'x-content-type-options': 'nosniff',
          ...(record.mediaType === 'image/svg+xml'
            ? { 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }
            : {}),
        }
        res.writeHead(200, headers)
        res.end(data)
      })()
        .catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 404, error instanceof Error ? error.message : 'session not found'))
      return
    }
    if (path === '/artifacts/manifest') {
      claimRoute(req)
      if (!payloads.artifactRootDir) {
        sendError(res, 404, 'artifact capture is not configured')
        return
      }
      void (async () => {
        const requestUrl = new URL(url, 'http://localhost')
        const limitValue = requestUrl.searchParams.get('limit')
        const limit = limitValue === null ? DEFAULT_ARTIFACT_MANIFEST_PAGE_SIZE : Number(limitValue)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_MANIFEST_PAGE_SIZE) throw new HttpRouteError(400, `limit must be an integer between 1 and ${MAX_ARTIFACT_MANIFEST_PAGE_SIZE}`)
        const kinds = parseArtifactKinds(requestUrl.searchParams.getAll('kind'))
        const cursorValue = requestUrl.searchParams.get('cursor')
        let snapshot: ManifestSnapshot
        let offset = 0
        if (cursorValue) {
          let cursor: { snapshotId: string; offset: number; filterKey: string }
          try {
            cursor = decodeManifestCursor(cursorValue)
          } catch (error) {
            throw new HttpRouteError(400, error instanceof Error ? error.message : String(error))
          }
          const retained = manifestSnapshots.get(cursor.snapshotId)
          if (!retained) throw new HttpRouteError(409, 'artifact manifest cursor expired; reload the first page')
          if (cursor.filterKey !== [...kinds].sort().join(',')) throw new HttpRouteError(400, 'artifact manifest cursor does not match kind filters')
          snapshot = retained
          offset = cursor.offset
        } else {
          snapshot = await artifactManifestSnapshot(requestUrl.searchParams.has('refresh'))
        }
        return pageArtifactManifest({ manifest: snapshot.manifest, snapshotId: snapshot.id, offset, limit, ...(kinds.size > 0 ? { kinds } : {}) })
      })()
        .then((manifest) => sendJson(req, res, manifest))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/artifacts/content') {
      claimRoute(req)
      if (!payloads.artifactRootDir) {
        sendError(res, 404, 'artifact capture is not configured')
        return
      }
      void readArtifactContent(url, payloads.artifactRootDir)
        .then((content) => sendJson(req, res, content))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/artifacts/download') {
      claimRoute(req)
      if (!payloads.artifactRootDir) {
        sendError(res, 404, 'artifact capture is not configured')
        return
      }
      void resolveArtifactFile(url, payloads.artifactRootDir)
        .then(({ abs, name, size, mediaType }) => {
          res.writeHead(200, {
            'content-type': mediaType,
            'content-length': String(size),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'x-content-type-options': 'nosniff',
          })
          if (req.method === 'HEAD') res.end()
          else createReadStream(abs).pipe(res)
        })
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/docs/index') {
      claimRoute(req)
      void listDocsIndex(payloads.docsRootDir, payloads.embeddedDocs)
        .then((result) => sendJson(req, res, result))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/docs/content') {
      claimRoute(req)
      void readDocContent(url, payloads.docsRootDir, payloads.embeddedDocs)
        .then((content) => sendJson(req, res, content))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/models') {
      claimRoute(req)
      const body: ServerModelsPayload = {
        models: valueOf(payloads.models),
        defaultModel: valueOf(payloads.defaultModel),
      }
      sendJson(req, res, body)
      return
    }
    if (path === '/settings' && payloads.settings) {
      claimRoute(req)
      const auth = authorizeDashboardHttp(req, payloads.auth)
      if (!auth.ok) { sendError(res, 401, auth.reason); return }
      const settings = typeof payloads.settings === 'function'
        ? payloads.settings(auth.actor)
        : payloads.settings
      void Promise.resolve(settings)
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/router/health' && payloads.routerHealth) {
      claimRoute(req)
      sendJson(req, res, payloads.routerHealth())
      return
    }
  })
}

function isProtectedJsonRoute(path: string): boolean {
  return path === '/models' ||
    path === '/settings' ||
    path === '/runtime/capabilities' ||
    path === '/runtime/tool-registry' ||
    /^\/runtime\/sessions\/[^/]+\/tool-lock$/u.test(path) ||
    /^\/runtime\/sessions\/[^/]+\/tool-result\/[^/]+$/u.test(path) ||
    path.startsWith('/internal/runtime/') ||
    path === '/runtime/restart/status' ||
    path === '/runtime/restart' ||
    path === '/runtime/restart/commit' ||
    path === '/runtime/restart/abort' ||
    path === '/settings/models' ||
    path === '/settings/web-search' ||
    path === '/settings/web-search/test' ||
    path === '/settings/speech' ||
    path === '/settings/speech/test' ||
    path === '/runtime/speech/token' ||
    path === '/runtime/speech/transcribe' ||
    path === '/settings/agent-prompt' ||
    path === '/settings/socket-admin/init' ||
    path === '/settings/socket-admin/mode' ||
    path === '/auth/executor-invites' ||
    path.startsWith('/auth/executor-invites/') ||
    path === '/auth/executor-identities' ||
    path.startsWith('/enhancement/') ||
    path.startsWith('/artifacts/') ||
    path.startsWith('/docs/') ||
    path.startsWith('/router/')
}

function authorizeSensitiveManagement(req: IncomingMessage, tenancy: import('@agent-kernel/shared').PlatformTenancy, auth: AuthConfig | undefined): { ok: true; actor: DashboardActor } | { ok: false; status: number; error: string; reason: string } {
  const authorization = req.headers.authorization
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
  const result = authenticateDashboardHandshake({ role: 'dashboard', clientVersion: 'http', ...(token ? { token } : {}) }, req, auth)
  if (!result.ok) return { ok: false, status: 401, error: result.reason, reason: result.reason }
  if (tenancy === 'multi-tenant' && (result.actor.kind !== 'ingress' || !['owner', 'admin'].includes(result.actor.role))) return { ok: false, status: 403, error: 'admin_required', reason: 'admin_required' }
  return { ok: true, actor: result.actor }
}

function authorizeDashboardHttp(req: IncomingMessage, auth: AuthConfig | undefined): ReturnType<typeof authenticateDashboardHandshake> {
  const authorization = req.headers.authorization
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
  return authenticateDashboardHandshake({ role: 'dashboard', clientVersion: 'http', ...(token ? { token } : {}) }, req, auth)
}

function dashboardActorCanWrite(actor: AuditActor): boolean {
  return actor.kind !== 'ingress' || actor.role !== 'viewer'
}

function httpSessionAccessError(
  req: IncomingMessage,
  record: SessionRecord | undefined,
): { status: number; message: string } | undefined {
  const actor = ingressActorFromHeaders(req)
  if (!actor) return undefined
  if (!record) return { status: 404, message: 'session not found' }
  if (!record.organizationId) return { status: 403, message: 'tenant_attribution_missing' }
  if (record.organizationId !== actor.organizationId) return { status: 403, message: 'tenant_forbidden' }
  return undefined
}

async function assertTenantStorageQuota(
  quota: TenantStorageQuotaEnforcer | undefined,
  session: SessionRecord,
  kind: 'message_attachment' | 'session_artifact',
  bytes: number,
): Promise<void> {
  if (!quota) return
  if (!session.organizationId) throw new HttpRouteError(403, 'tenant_attribution_missing')
  await quota.assertCanStoreArtifact({ organizationId: session.organizationId, sessionId: session.sessionId, kind, bytes })
}

function ingressActorFromHeaders(req: IncomingMessage): Extract<DashboardActor, { kind: 'ingress' }> | undefined {
  const principal = singleHeader(req, 'x-agent-runlab-principal')
  const organizationId = singleHeader(req, 'x-agent-runlab-organization-id')
  const role = singleHeader(req, 'x-agent-runlab-organization-role')
  if (!principal || !organizationId) return undefined
  if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') return undefined
  return { kind: 'ingress', principal, organizationId, role }
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function internalIngressAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.KALA_INGRESS_HANDOFF_SECRET
  const supplied = req.headers['x-agent-runlab-ingress-handoff']
  return Boolean(expected && typeof supplied === 'string' && supplied.length === expected.length && supplied === expected)
}

function httpActor(req: IncomingMessage, auth: AuthConfig | undefined): AuditActor {
  if (auth?.github?.required) {
    const session = readGithubSession(req, auth.github)
    if (session) return { kind: 'github_user', login: session.login, ...(session.id !== undefined ? { id: session.id } : {}) }
  }
  if (auth?.sharedToken) return { kind: 'token' }
  return { kind: 'anonymous' }
}

async function runEnhancementAction(
  body: EnhancementActionRequest,
  payloads: {
    artifactRootDir?: string | false
    sessions?: SessionStore
    executorsSnapshot?: () => readonly AttachedExecutor[]
    enqueueUserMessage?: (input: { sessionId: string; text: string; intent: 'text' | 'shell'; operationId?: string; mode?: 'queue' | 'steer'; content?: readonly import('@agent-kernel/kernel').MessageContent[] }) => Promise<{ accepted?: boolean; committed: boolean; cursor?: number }>
  },
): Promise<unknown> {
  const action = requiredString(body.action, 'action')
  if (action === 'enqueue-user-message') {
    // Reliable queue path used by the dashboard's pagehide beacon: enqueue a
    // follow-up message even when the WebSocket is gone because the browser is
    // closing. Enqueue + drain so it is delivered as soon as the current turn
    // finishes, with no live socket required.
    if (!payloads.enqueueUserMessage) throw new HttpRouteError(503, 'queue is not available')
    const sessionId = requiredString(body.sessionId, 'sessionId')
    const text = requiredString(body.text, 'text')
    await payloads.enqueueUserMessage({ sessionId, text, intent: 'text' })
    return { action, sessionId, queued: true }
  }
  // All other enhancement actions read or publish local files and paths. A caller-
  // supplied rootDir can bypass the missing default artifact root in PG/S3 mode,
  // returning a success path on disposable Runtime scratch. Fail closed until a
  // durable object-backed enhancement artifact port exists.
  if (payloads.sessions?.usesPostgresAuthority) {
    throw new HttpRouteError(409, 'file-based enhancement actions are unavailable with PostgreSQL Session authority')
  }
  const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
  if (!rootDir) throw new HttpRouteError(400, 'rootDir is required when artifact capture is not configured')
  if (action === 'profile-session') {
    const pricingPath = await resolveInputPath(body, 'pricingPath', 'pricingContent', 'pricing', '.json', rootDir, action)
    const result = await profileSession({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      ...(pricingPath ? { pricingPath } : {}),
    })
    return { action, profilePath: result.profilePath, profile: result.profile }
  }
  if (action === 'reliability-audit-session') {
    const result = await auditSessionReliability({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action) })
    return { action, auditPath: result.auditPath, audit: result.audit }
  }
  if (action === 'reliability-chaos-replay') {
    const result = await replayReliabilityChaos({ rootDir, sessionLogPaths: sessionLogPaths(body) })
    return { action, reportPath: result.reportPath, report: result.report }
  }
  if (action === 'reliability-gate') {
    const policy: ReliabilityGatePolicy = {}
    const maxDanglingCount = positiveNumber(body.maxDanglingCount, 'maxDanglingCount')
    const minRecoverableRatio = positiveNumber(body.minRecoverableRatio, 'minRecoverableRatio')
    const maxRecoveryEventCount = positiveNumber(body.maxRecoveryEventCount, 'maxRecoveryEventCount')
    const maxIntegrityIssueCount = positiveNumber(body.maxIntegrityIssueCount, 'maxIntegrityIssueCount')
    if (maxDanglingCount !== undefined) policy.maxDanglingCount = maxDanglingCount
    if (minRecoverableRatio !== undefined) policy.minRecoverableRatio = minRecoverableRatio
    if (maxRecoveryEventCount !== undefined) policy.maxRecoveryEventCount = maxRecoveryEventCount
    if (maxIntegrityIssueCount !== undefined) policy.maxIntegrityIssueCount = maxIntegrityIssueCount
    const rawKindCaps = body.maxDanglingByKind
    if (rawKindCaps && typeof rawKindCaps === 'object' && !Array.isArray(rawKindCaps)) {
      const parsed: Record<string, number> = {}
      for (const [kind, raw] of Object.entries(rawKindCaps as Record<string, unknown>)) {
        const cap = positiveNumber(raw, `maxDanglingByKind.${kind}`)
        if (cap !== undefined) parsed[kind] = cap
      }
      if (Object.keys(parsed).length > 0) policy.maxDanglingByKind = parsed
    }
    const requireStatus = listInput(body.requireStatusIn)
    if (requireStatus && requireStatus.length > 0) policy.requireStatusIn = requireStatus
    const chaosReport = await resolveInputPath(body, 'chaosReportPath', 'chaosReportContent', 'chaosReport', '.json', rootDir, action)
    const logPaths = listInput(body.sessionLogPaths)
    if (!chaosReport && (!logPaths || logPaths.length === 0)) {
      throw new HttpRouteError(400, 'reliability-gate requires chaosReportPath or sessionLogPaths')
    }
    const output = cleanString(body.outputFilename)
    const result = await evaluateReliabilityGate({
      rootDir,
      ...(chaosReport ? { chaosReportPath: chaosReport } : {}),
      ...(logPaths && logPaths.length > 0 ? { sessionLogPaths: logPaths } : {}),
      policy,
      ...(output ? { outputFilename: output } : {}),
    })
    return { action, verdictPath: result.verdictPath, verdict: result.verdict }
  }
  if (action === 'reliability-classify') {
    const wedgedThresholdMs = positiveNumber(body.wedgedThresholdMs, 'wedgedThresholdMs')
    const heartbeatPath = await resolveInputPath(body, 'heartbeatPath', 'heartbeatContent', 'heartbeat', '.jsonl', rootDir, action, { required: true })
    const result = await classifyReliability({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      heartbeatPath: heartbeatPath!,
      ...(wedgedThresholdMs !== undefined ? { wedgedThresholdMs } : {}),
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return { action, reportPath: result.reportPath, report: result.report }
  }
  if (action === 'tool-catalog-diff') {
    const baselinePath = await resolveInputPath(body, 'baselineCatalogPath', 'baselineCatalogContent', 'baselineCatalog', '.json', rootDir, action, { required: true })
    const candidatePath = await resolveInputPath(body, 'candidateCatalogPath', 'candidateCatalogContent', 'candidateCatalog', '.json', rootDir, action, { required: true })
    const result = await diffToolCatalogs({
      rootDir,
      baselinePath: baselinePath!,
      candidatePath: candidatePath!,
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return { action, diffPath: result.diffPath, diff: result.diff }
  }
  if (action === 'executor-capabilities-snapshot') {
    if (!payloads.executorsSnapshot) {
      throw new HttpRouteError(500, 'executor snapshot is not available in this host build')
    }
    const executors = payloads.executorsSnapshot()
    const result = await writeExecutorCapabilitySnapshot({
      rootDir,
      executors,
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return { action, snapshotPath: result.snapshotPath, snapshot: result.snapshot }
  }
  if (action === 'memory-index') {
    const result = await buildMemoryIndex({ rootDir, ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}), ...(body.includeGlobal === true ? { includeGlobal: true } : {}) })
    return { action, indexPath: result.indexPath, entries: result.index.entries.length, warnings: result.index.warnings }
  }
  if (action === 'memory-retrieve') {
    const maxTokens = positiveInteger(body.maxTokens, 'maxTokens')
    const maxHits = positiveInteger(body.maxHits, 'maxHits')
    const result = await retrieveMemory({
      rootDir,
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot)! } : {}),
      ...(body.includeGlobal === true ? { includeGlobal: true } : {}),
      query: requiredString(body.query, 'query'),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(maxHits === undefined ? {} : { maxHits }),
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return {
      action,
      artifactPath: result.artifactPath,
      hitCount: result.artifact.hitCount,
      budget: result.artifact.budget,
      reasonCodes: result.artifact.reasonCodes,
      hits: result.artifact.hits,
    }
  }
  if (action === 'subagents-graph') {
    const result = await exportSubAgentGraph({ rootDir, sessionsDir: cleanString(body.sessionsDir) ?? payloads.sessions?.dir ?? requiredString(body.sessionsDir, 'sessionsDir') })
    return { action, graphPath: result.graphPath, nodes: result.graph.nodes.length, edges: result.graph.edges.length, warnings: result.graph.warnings }
  }
  if (action === 'trace-export-session') {
    const result = await exportSessionTraceArtifacts({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action), ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}), ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, sessionId: result.sessionId, traceArtifact: result.traceArtifact, llmArtifacts: result.llmArtifacts }
  }
  if (action === 'rollout-export-segments') {
    const result = await exportRolloutSegments({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action), ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}), ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, sessionId: result.sessionId, artifact: result.artifact, segmentCount: result.segments.segments.length }
  }
  if (action === 'rollout-export-session') {
    const rewardPath = await resolveInputPath(body, 'rewardPath', 'rewardContent', 'reward', '.json', rootDir, action)
    const tokenSegmentsPath = await resolveInputPath(body, 'tokenSegmentsPath', 'tokenSegmentsContent', 'tokenSegments', '.json', rootDir, action)
    const result = await exportRolloutSidecar({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      taskId: requiredString(body.taskId, 'taskId'),
      frameworkTarget: frameworkTarget(requiredString(body.frameworkTarget ?? body.framework, 'frameworkTarget')),
      ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}),
      ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(cleanString(body.weightVersion) ? { weightVersion: cleanString(body.weightVersion) } : {}),
      ...(rewardPath ? { rewardPath } : {}),
      ...(tokenSegmentsPath ? { tokenSegmentsPath } : {}),
    })
    return { action, rolloutId: result.sidecar.rollout_id, sidecarPath: result.sidecarPath, traceArtifact: result.traceArtifact }
  }
  if (action === 'rollout-export-adapter') {
    const framework = cleanString(body.frameworkTarget ?? body.framework)
    const sidecarPath = await resolveInputPath(body, 'sidecarPath', 'sidecarContent', 'sidecar', '.json', rootDir, action, { required: true })
    const result = await exportRolloutFrameworkAdapter({ rootDir, sidecarPath: sidecarPath!, ...(framework ? { frameworkTarget: frameworkTarget(framework) } : {}) })
    return { action, adapterPath: result.adapterPath, status: result.adapter.status, frameworkTarget: result.adapter.frameworkTarget }
  }
  if (action === 'rollout-verify-reward') {
    const trialPath = await resolveInputPath(body, 'trialPath', 'trialContent', 'trial', '.json', rootDir, action)
    const scorePath = await resolveInputPath(body, 'scorePath', 'scoreContent', 'score', '.json', rootDir, action)
    if (!trialPath && !scorePath) throw new HttpRouteError(400, 'missing required trialPath or scorePath')
    const result = await verifyReward({
      rootDir,
      ...(trialPath ? { trialPath } : {}),
      ...(scorePath ? { scorePath } : {}),
      ...(cleanString(body.taskId) ? { taskId: cleanString(body.taskId)! } : {}),
      ...(cleanString(body.sessionId) ? { sessionId: cleanString(body.sessionId)! } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot)! } : {}),
    })
    return {
      action,
      artifact: result.artifact,
      taskId: result.reward.taskId,
      reward: result.reward.reward,
      resolved: result.reward.resolved,
      shapedLabels: result.reward.shapedLabels,
      reasonCodes: result.reward.reasonCodes,
    }
  }
  if (action === 'artifacts-manifest') {
    const maxHashBytes = positiveInteger(body.maxHashBytes, 'maxHashBytes')
    const result = await buildArtifactManifest({
      rootDir,
      ...(cleanString(body.outputPath) ? { outputPath: cleanString(body.outputPath) } : {}),
      ...(maxHashBytes !== undefined ? { maxHashBytes } : {}),
    })
    return { action, manifestPath: result.manifestPath, summary: result.manifest.summary }
  }
  if (action === 'artifacts-prune') {
    const olderThanDays = positiveNumber(body.olderThanDays, 'olderThanDays')
    const maxTotalBytes = positiveNumber(body.maxTotalBytes, 'maxTotalBytes')
    const kinds = listInput(body.kinds)
    const result = await pruneArtifacts({
      rootDir,
      ...(olderThanDays !== undefined ? { olderThanDays } : {}),
      ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      dryRun: body.dryRun === true,
      ...(cleanString(body.outputPath) ? { outputPath: cleanString(body.outputPath) } : {}),
    })
    return {
      action,
      reportPath: result.reportPath,
      dryRun: result.report.dryRun,
      before: result.report.before,
      after: result.report.after,
      removedCount: result.report.removed.length,
      protectedCount: result.report.protected.length,
    }
  }
  if (action === 'trace-export-otlp') {
    const retries = positiveInteger(body.retries, 'retries')
    const retryDelayMs = positiveInteger(body.retryDelayMs, 'retryDelayMs')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    let headers: Record<string, string> | undefined
    if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
      const parsed: Record<string, string> = {}
      for (const [name, raw] of Object.entries(body.headers as Record<string, unknown>)) {
        if (typeof raw !== 'string' || !name.trim()) continue
        parsed[name.trim()] = raw
      }
      if (Object.keys(parsed).length > 0) headers = parsed
    } else if (typeof body.headers === 'string' && body.headers.trim().length > 0) {
      const parsed: Record<string, string> = {}
      for (const line of body.headers.split(/[\n,]/)) {
        const [name, ...rest] = line.split('=')
        const trimmedName = name?.trim()
        const value = rest.join('=').trim()
        if (trimmedName && value) parsed[trimmedName] = value
      }
      if (Object.keys(parsed).length > 0) headers = parsed
    }
    const headersFilePath = await resolveInputPath(body, 'headersFilePath', 'headersFileContent', 'headers', '.json', rootDir, action)
    const fileHeaders = await loadHeadersFile(headersFilePath)
    const mergedHeaders = fileHeaders || headers
      ? { ...(fileHeaders ?? {}), ...(headers ?? {}) }
      : undefined
    const result = await exportTraceOtlp({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}),
      ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}),
      ...(cleanString(body.endpoint) ? { endpoint: cleanString(body.endpoint) } : {}),
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      ...(retries !== undefined ? { retries } : {}),
      ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename) } : {}),
      ...(cleanString(body.serviceName) ? { serviceName: cleanString(body.serviceName) } : {}),
      ...(cleanString(body.hostVersion) ? { hostVersion: cleanString(body.hostVersion) } : {}),
    })
    return {
      action,
      sessionId: result.sessionId,
      spanCount: result.spanCount,
      bundlePath: result.bundlePath,
      export: result.export,
    }
  }
  throw new HttpRouteError(400, `unsupported enhancement action: ${action}`)
}

async function sessionLogPath(body: EnhancementActionRequest, sessions: SessionStore | undefined, rootDir: string, action: string): Promise<string> {
  const explicit = cleanString(body.sessionLogPath)
  if (explicit) return explicit
  const content = cleanString(body.sessionLogContent)
  if (content) {
    try {
      return await resolveContentToPath(
        { content: body.sessionLogContent },
        { action, field: 'sessionLog', extension: '.jsonl', rootDir },
      )
    } catch (err) {
      if (err instanceof ContentInputError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  const sessionId = requiredString(body.sessionId, 'sessionId')
  if (!sessions) throw new HttpRouteError(400, 'sessionId lookup is unavailable')
  if (sessions.usesPostgresAuthority) {
    throw new HttpRouteError(409, `${action} requires a local JSONL; PostgreSQL Session authority has no local Session log`)
  }
  const cached = sessions.get(sessionId)
  if (cached) return cached.logPath
  return (await sessions.load(sessionId)).logPath
}

async function resolveInputPath(
  body: EnhancementActionRequest,
  pathField: keyof EnhancementActionRequest,
  contentField: keyof EnhancementActionRequest,
  logicalField: string,
  extension: string,
  rootDir: string,
  action: string,
  options: { required?: boolean } = {},
): Promise<string | undefined> {
  const path = cleanString(body[pathField])
  if (path) return path
  const rawContent = body[contentField]
  if (rawContent !== undefined && rawContent !== null && rawContent !== '') {
    try {
      return await resolveContentToPath(
        { content: rawContent as string },
        { action, field: logicalField, extension, rootDir },
      )
    } catch (err) {
      if (err instanceof ContentInputError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  if (options.required) {
    throw new HttpRouteError(400, `${String(pathField)} is required (or provide ${String(contentField)})`)
  }
  return undefined
}

function sessionLogPaths(body: EnhancementActionRequest): readonly string[] {
  const paths = listInput(body.sessionLogPaths)
  if (!paths) throw new HttpRouteError(400, 'sessionLogPaths is required')
  return paths
}

function frameworkTarget(value: string): 'slime' | 'verl' | 'trl' | 'openrlhf' | 'unknown' {
  if (value === 'slime' || value === 'verl' || value === 'trl' || value === 'openrlhf' || value === 'unknown') return value
  throw new HttpRouteError(400, `invalid frameworkTarget: ${value}`)
}

function requiredString(value: unknown, name: string): string {
  const cleaned = cleanString(value)
  if (!cleaned) throw new HttpRouteError(400, `${name} is required`)
  return cleaned
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function listInput(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    return out.length > 0 ? out : undefined
  }
  if (typeof value === 'string') {
    const out = value.split(',').map((item) => item.trim()).filter(Boolean)
    return out.length > 0 ? out : undefined
  }
  return undefined
}

function nonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(number) || number < 0) throw new HttpRouteError(400, `${name} must be a non-negative integer`)
  return number
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(number) || number <= 0) throw new HttpRouteError(400, `${name} must be a positive integer`)
  return number
}

function positiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number) || number < 0) throw new HttpRouteError(400, `${name} must be a non-negative number`)
  return number
}

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

export function claimRoute(req: IncomingMessage): void {
  ;(req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] = true
}

export function routeClaimed(req: IncomingMessage): boolean {
  return (req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] === true
}

class HttpRouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function resolveArtifactFile(url: string, rootDir: string): Promise<{ abs: string; rel: string; name: string; size: number; mediaType: string }> {
  const parsed = new URL(url, 'http://x')
  const requested = parsed.searchParams.get('path') ?? ''
  if (!requested || requested.includes('\0')) throw new HttpRouteError(400, 'missing artifact path')
  const root = resolvePath(rootDir)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  if (!abs.startsWith(root + sep) && abs !== root) throw new HttpRouteError(403, 'artifact path escapes root')
  const st = await stat(abs).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpRouteError(404, 'artifact not found')
    throw err
  })
  if (!st.isFile()) throw new HttpRouteError(400, 'artifact path is not a file')
  return { abs, rel, name: rel.split(sep).at(-1) ?? 'artifact', size: st.size, mediaType: MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' }
}

async function readArtifactContent(url: string, rootDir: string): Promise<{ path: string; mediaType: string; body: unknown }> {
  const { abs, rel, size, mediaType } = await resolveArtifactFile(url, rootDir)
  if (size > MAX_ARTIFACT_CONTENT_BYTES) throw new HttpRouteError(413, 'artifact is too large to read inline')
  if (!(mediaType.startsWith('application/json') || mediaType.startsWith('text/'))) throw new HttpRouteError(415, 'artifact media type cannot be previewed')
  const raw = await readFile(abs, 'utf8')
  if (mediaType.startsWith('application/json')) {
    return { path: rel.split(sep).join('/'), mediaType, body: JSON.parse(raw) as unknown }
  }
  return { path: rel.split(sep).join('/'), mediaType, body: raw }
}

type DocsIndexEntry = {
  path: string
  title: string
  size: number
  updatedAt: string
}

async function listDocsIndex(configuredRoot?: string, embeddedDocs?: readonly EmbeddedStaticAsset[]): Promise<{ root: 'docs'; docs: DocsIndexEntry[] }> {
  if (!configuredRoot && embeddedDocs) {
    const docs = embeddedDocs.map((asset) => {
      const body = Buffer.from(asset.contentBase64, 'base64').toString('utf8')
      return {
        path: asset.path,
        title: titleFromMarkdown(body) ?? titleFromDocPath(asset.path),
        size: Buffer.byteLength(body),
        updatedAt: new Date(0).toISOString(),
      }
    }).sort((a, b) => a.path.localeCompare(b.path))
    return { root: 'docs', docs }
  }
  const root = docsRoot(configuredRoot)
  const docs: DocsIndexEntry[] = []
  await collectDocs(root, '', docs)
  docs.sort((a, b) => a.path.localeCompare(b.path))
  return { root: 'docs', docs }
}

async function collectDocs(root: string, relativeDir: string, out: DocsIndexEntry[]): Promise<void> {
  const dir = relativeDir ? join(root, relativeDir) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpRouteError(404, 'docs directory not found')
    throw err
  })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = relativeDir ? join(relativeDir, entry.name) : entry.name
    if (entry.isDirectory()) {
      await collectDocs(root, rel, out)
      continue
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    const abs = join(root, rel)
    const info = await stat(abs)
    out.push({
      path: rel.split(sep).join('/'),
      title: titleFromDocPath(rel),
      size: info.size,
      updatedAt: info.mtime.toISOString(),
    })
  }
}

async function readDocContent(url: string, configuredRoot?: string, embeddedDocs?: readonly EmbeddedStaticAsset[]): Promise<{ path: string; title: string; body: string; updatedAt: string }> {
  const parsed = new URL(url, 'http://x')
  const requested = parsed.searchParams.get('path') ?? ''
  if (!requested || requested.includes('\0')) throw new HttpRouteError(400, 'missing doc path')
  if (extname(requested).toLowerCase() !== '.md') throw new HttpRouteError(400, 'doc path must be a markdown file')
  if (!configuredRoot && embeddedDocs) {
    const rel = normalize(requested).replace(/^[/\\]+/, '').split(sep).join('/')
    if (rel.startsWith('../') || rel === '..') throw new HttpRouteError(403, 'doc path escapes docs root')
    const asset = embeddedDocs.find((candidate) => candidate.path === rel)
    if (!asset) throw new HttpRouteError(404, 'doc not found')
    const body = Buffer.from(asset.contentBase64, 'base64').toString('utf8')
    if (Buffer.byteLength(body) > MAX_DOC_CONTENT_BYTES) throw new HttpRouteError(413, 'doc is too large to read inline')
    return { path: rel, title: titleFromMarkdown(body) ?? titleFromDocPath(rel), body, updatedAt: new Date(0).toISOString() }
  }
  const root = docsRoot(configuredRoot)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  if (!abs.startsWith(root + sep) && abs !== root) throw new HttpRouteError(403, 'doc path escapes docs root')
  const info = await stat(abs).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpRouteError(404, 'doc not found')
    throw err
  })
  if (!info.isFile()) throw new HttpRouteError(400, 'doc path is not a file')
  if (info.size > MAX_DOC_CONTENT_BYTES) throw new HttpRouteError(413, 'doc is too large to read inline')
  const body = await readFile(abs, 'utf8')
  return {
    path: rel.split(sep).join('/'),
    title: titleFromMarkdown(body) ?? titleFromDocPath(rel),
    body,
    updatedAt: info.mtime.toISOString(),
  }
}

function docsRoot(configuredRoot?: string): string {
  if (configuredRoot) return resolvePath(configuredRoot)
  const starts = [resolvePath(process.cwd())]
  const executable = process.argv[1]
  if (executable) starts.push(dirname(resolvePath(executable)))
  for (const start of starts) {
    let cursor = start
    for (let i = 0; i < 8; i++) {
      const candidate = join(cursor, 'docs')
      if (existsSync(candidate)) return candidate
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return resolvePath(process.cwd(), 'docs')
}

function titleFromMarkdown(body: string): string | undefined {
  const line = body.split(/\r?\n/u).find((candidate) => candidate.startsWith('# '))
  return line?.replace(/^#\s+/, '').trim() || undefined
}

function titleFromDocPath(path: string): string {
  const name = path.split(/[\\/]/u).pop() ?? path
  return name
    .replace(/\.md$/iu, '')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function memoOwner(req: IncomingMessage): string | undefined {
  const principal = req.headers['x-agent-runlab-principal']
  if (typeof principal === 'string' && principal.length > 0) return `ingress:${principal}`
  // Portable and Dedicated may have no identity provider; one local owner is intentional.
  if (!req.headers['x-agent-runlab-organization-id']) return 'local:owner'
  return undefined
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  return JSON.parse(raw) as unknown
}

async function readBytes(req: IncomingMessage, maxBytes: number, label = 'Attachment'): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) throw new HttpRouteError(413, `${label} exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function sendJson(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  sendJsonStatus(req, res, 200, body)
}

function sendJsonStatus(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  }
  applyCorsHeaders(req, headers)
  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(json)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const json = JSON.stringify({ error: message })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  })
  res.end(json)
}

export function attachStaticHandler(server: HttpServer, staticDir: string): void {
  const root = resolvePath(staticDir)
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Socket.IO's own request listener handles /socket.io/*; skip so we don't
    // clobber its response.
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    // Another handler (e.g. `/models` JSON) may have already responded.
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return

    void serveStatic(root, req, res)
  })
}

export type TenantStorageQuotaEnforcer = {
  assertCanStoreArtifact(params: {
    organizationId: string
    sessionId: string
    bytes: number
    kind: 'message_attachment' | 'session_artifact'
  }): Promise<void>
}

export type EmbeddedStaticAsset = {
  readonly path: string
  readonly contentBase64: string
}

export type StaticMount = {
  readonly path: string
  readonly rootDir?: string
  readonly assets?: readonly EmbeddedStaticAsset[]
}

export type DynamicStaticMount = () => StaticMount | undefined

export function attachEmbeddedStaticHandler(server: HttpServer, assets: readonly EmbeddedStaticAsset[]): void {
  const byPath = new Map<string, EmbeddedStaticAsset>()
  for (const asset of assets) {
    const normalized = normalizeStaticAssetPath(asset.path)
    byPath.set(normalized, { ...asset, path: normalized })
  }
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return

    serveEmbeddedStatic(byPath, req, res)
  })
}

export function attachStaticMountHandler(server: HttpServer, mount: StaticMount): void {
  const mountPath = normalizeMountPath(mount.path)
  const root = mount.rootDir ? resolvePath(mount.rootDir) : undefined
  const byPath = mount.assets ? embeddedAssetMap(mount.assets) : undefined
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (!isMountedPath(url, mountPath)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    claimRoute(req)
    if (new URL(url, 'http://x').pathname === mountPath) {
      redirectToMountedRoot(req, res, mountPath)
      return
    }
    const originalUrl = req.url
    req.url = mountedRequestUrl(originalUrl ?? '/', mountPath)
    if (root) {
      void serveStatic(root, req, res).finally(() => {
        req.url = originalUrl
      })
      return
    }
    if (byPath) {
      serveEmbeddedStatic(byPath, req, res)
      req.url = originalUrl
      return
    }
    req.url = originalUrl
    res.writeHead(404).end('not found')
  })
}

export function attachDynamicStaticMountHandler(server: HttpServer, getMount: DynamicStaticMount): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const mount = getMount()
    if (!mount) return
    const url = req.url ?? '/'
    const mountPath = normalizeMountPath(mount.path)
    if (!isMountedPath(url, mountPath)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    claimRoute(req)
    if (new URL(url, 'http://x').pathname === mountPath) {
      redirectToMountedRoot(req, res, mountPath)
      return
    }
    const originalUrl = req.url
    req.url = mountedRequestUrl(originalUrl ?? '/', mountPath)
    if (mount.rootDir) {
      void serveStatic(resolvePath(mount.rootDir), req, res).finally(() => {
        req.url = originalUrl
      })
      return
    }
    if (mount.assets) {
      serveEmbeddedStatic(embeddedAssetMap(mount.assets), req, res)
      req.url = originalUrl
      return
    }
    req.url = originalUrl
    res.writeHead(404).end('not found')
  })
}

export function attachReleaseAssetsHandler(
  server: HttpServer,
  releaseDir: string,
  embeddedAssets: readonly EmbeddedStaticAsset[] = [],
): void {
  const root = resolvePath(releaseDir)
  const embedded = embeddedAssetMap(embeddedAssets)
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (!url.startsWith('/release-assets/') && !url.startsWith('/install/assets/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    claimRoute(req)
    if (url.startsWith('/install/assets/')) req.url = url.replace('/install/assets/', '/release-assets/')
    void serveReleaseAsset(root, embedded, req, res)
  })
}

function embeddedAssetMap(assets: readonly EmbeddedStaticAsset[]): Map<string, EmbeddedStaticAsset> {
  const byPath = new Map<string, EmbeddedStaticAsset>()
  for (const asset of assets) {
    const normalized = normalizeStaticAssetPath(asset.path)
    byPath.set(normalized, { ...asset, path: normalized })
  }
  return byPath
}

function normalizeMountPath(path: string): string {
  const trimmed = path.trim() || '/'
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '') || '/'
}

function isMountedPath(rawUrl: string, mountPath: string): boolean {
  const pathname = new URL(rawUrl, 'http://x').pathname
  return pathname === mountPath || pathname.startsWith(`${mountPath}/`)
}

function mountedRequestUrl(rawUrl: string, mountPath: string): string {
  const url = new URL(rawUrl, 'http://x')
  const suffix = url.pathname === mountPath ? '/' : url.pathname.slice(mountPath.length)
  url.pathname = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${url.pathname}${url.search}`
}

function redirectToMountedRoot(req: IncomingMessage, res: ServerResponse, mountPath: string): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const location = `${mountPath}/${url.search}`
  res.writeHead(308, {
    location,
    'cache-control': 'no-store',
    'content-length': '0',
  })
  res.end()
}

export function attachRequestHandler(
  server: HttpServer,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    handler(req, res)
  })
}

async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = decodeURIComponent(url.pathname)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  // Reject traversal above root.
  if (!abs.startsWith(root + sep) && abs !== root) {
    res.writeHead(403).end()
    return
  }

  const filePath = await pickFile(abs, root)
  if (!filePath) {
    res.writeHead(404).end('not found')
    return
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = { 'content-type': mime }
  // Vite emits `assets/*.<hash>.<ext>` — safe to cache forever. Everything
  // else (index.html, favicon, etc.) must revalidate so stale dashboard
  // builds don't survive a redeploy in the user's browser.
  if (/[/\\]assets[/\\][^/\\]+\.[0-9a-f]{6,}\./i.test(filePath)) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['cache-control'] = 'no-cache, must-revalidate'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

function serveEmbeddedStatic(
  assets: ReadonlyMap<string, EmbeddedStaticAsset>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = normalizeStaticAssetPath(decodeURIComponent(url.pathname))
  const asset = pickEmbeddedAsset(assets, requested)
  if (!asset) {
    res.writeHead(404).end('not found')
    return
  }
  const body = Buffer.from(asset.contentBase64, 'base64')
  const mime = MIME[extname(asset.path).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'content-type': mime,
    'content-length': String(body.byteLength),
  }
  if (/^assets\/[^/]+\.[0-9a-f]{6,}\./i.test(asset.path)) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['cache-control'] = 'no-cache, must-revalidate'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

function pickEmbeddedAsset(
  assets: ReadonlyMap<string, EmbeddedStaticAsset>,
  requested: string,
): EmbeddedStaticAsset | null {
  if (requested === '__forbidden__') return null
  const direct = assets.get(requested)
  if (direct) return direct
  // A stale page or service worker may request a hashed chunk from the
  // previous release. Returning index.html for that .js URL causes strict
  // browsers such as Safari to reject it as an invalid text/html module.
  // Only extensionless client-side routes are eligible for SPA fallback.
  if (hasStaticAssetExtension(requested)) return null
  const index = assets.get(`${requested.replace(/\/+$/u, '')}/index.html`)
  if (index) return index
  return assets.get('index.html') ?? null
}

function hasStaticAssetExtension(requested: string): boolean {
  const leaf = requested.split('/').at(-1) ?? ''
  return extname(leaf).length > 0
}

function normalizeStaticAssetPath(path: string): string {
  const rel = normalize(path).replace(/^[/\\]+/, '')
  if (!rel || rel === '.') return 'index.html'
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return '__forbidden__'
  return rel.replace(/\\/g, '/')
}

function parseRestartRequest(body: unknown): { mode?: 'checkpoint' | 'when_idle' | 'force'; reason?: 'manual' | 'deploy' | 'settings_changed'; timeoutMs?: number; deployment?: NonNullable<HostRestartAttempt['deployment']> } {
  if (body === null || typeof body !== 'object') return {}
  const input = body as Record<string, unknown>
  const out: { mode?: 'checkpoint' | 'when_idle' | 'force'; reason?: 'manual' | 'deploy' | 'settings_changed'; timeoutMs?: number; deployment?: NonNullable<HostRestartAttempt['deployment']> } = {}
  if (input.mode !== undefined) {
    if (input.mode !== 'checkpoint' && input.mode !== 'when_idle' && input.mode !== 'force') throw new Error('invalid restart mode')
    out.mode = input.mode
  }
  if (input.reason !== undefined) {
    if (input.reason !== 'manual' && input.reason !== 'deploy' && input.reason !== 'settings_changed') throw new Error('invalid restart reason')
    out.reason = input.reason
  }
  if (input.timeoutMs !== undefined) {
    const n = Number(input.timeoutMs)
    if (!Number.isFinite(n) || n <= 0) throw new Error('invalid restart timeoutMs')
    out.timeoutMs = Math.floor(n)
  }
  if (input.deployment !== undefined) {
    if (!input.deployment || typeof input.deployment !== 'object' || Array.isArray(input.deployment)) throw new Error('invalid deployment restart ownership')
    const deployment = input.deployment as Record<string, unknown>
    if (typeof deployment.deploymentId !== 'string' || !deployment.deploymentId || typeof deployment.targetReleaseDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(deployment.targetReleaseDigest) || !Number.isSafeInteger(deployment.expectedRouteGeneration) || Number(deployment.expectedRouteGeneration) < 1 || typeof deployment.fencingToken !== 'string' || deployment.fencingToken.length < 16) throw new Error('invalid deployment restart ownership')
    out.deployment = {
      deploymentId: deployment.deploymentId,
      targetReleaseDigest: deployment.targetReleaseDigest,
      expectedRouteGeneration: Number(deployment.expectedRouteGeneration),
      fencingToken: deployment.fencingToken,
    }
  }
  return out
}

async function serveReleaseAsset(
  root: string,
  embeddedAssets: ReadonlyMap<string, EmbeddedStaticAsset>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = decodeURIComponent(url.pathname.replace(/^\/release-assets\//, ''))
  if (!requested || requested.includes('/')) {
    res.writeHead(404).end('not found')
    return
  }
  const abs = join(root, normalize(requested).replace(/^[/\\]+/, ''))
  if (!abs.startsWith(root + sep) && abs !== root) {
    res.writeHead(403).end()
    return
  }
  let fileSize: number
  try {
    const st = await stat(abs)
    if (!st.isFile()) {
      serveEmbeddedReleaseAsset(embeddedAssets, requested, req, res)
      return
    }
    fileSize = st.size
  } catch {
    serveEmbeddedReleaseAsset(embeddedAssets, requested, req, res)
    return
  }
  const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime, 'content-length': String(fileSize), 'cache-control': 'no-cache, must-revalidate' })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(abs).on('error', () => res.destroy()).pipe(res)
}

function serveEmbeddedReleaseAsset(
  assets: ReadonlyMap<string, EmbeddedStaticAsset>,
  requested: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const asset = assets.get(normalizeStaticAssetPath(requested))
  if (!asset) {
    res.writeHead(404).end('not found')
    return
  }
  const body = Buffer.from(asset.contentBase64, 'base64')
  const mime = MIME[extname(asset.path).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': mime,
    'content-length': String(body.byteLength),
    'cache-control': 'no-cache, must-revalidate',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

async function pickFile(abs: string, root: string): Promise<string | null> {
  try {
    const st = await stat(abs)
    if (st.isFile()) return abs
    if (st.isDirectory()) {
      const idx = join(abs, 'index.html')
      try {
        const s = await stat(idx)
        if (s.isFile()) return idx
      } catch {}
    }
  } catch {}
  // Missing static assets must stay 404. Serving index.html for a stale hashed
  // JavaScript chunk makes Safari reject it as an invalid text/html module.
  if (extname(abs).length > 0) return null
  // SPA fallback: extensionless unknown routes serve index.html.
  const fallback = join(root, 'index.html')
  try {
    const s = await stat(fallback)
    if (s.isFile()) return fallback
  } catch {}
  return null
}
