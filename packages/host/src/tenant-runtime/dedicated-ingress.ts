import { createServer, type Server as HttpServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Socket } from 'node:net'

import { schema, validateClientMessagePayload, validateInlineMessageFiles, validateInlineMessageImages, type PublicUrlPattern } from '@agent-kernel/shared'
import { authenticateDashboardHandshake, type AuthConfig, type DashboardActor } from '../auth-control.js'
import { effectiveAttachmentLimit } from '../message-attachment-policy.js'
import { createRuntimeUnitIngress } from './runtime-unit-ingress.js'
import { AdmissionBackpressureError, DedicatedAdmissionLedger, type AdmissionMessage } from './dedicated-admission-ledger.js'
import { DEDICATED_RUNTIME_UNIT_ID } from './dedicated-unit.js'
import { readDedicatedRouteState } from './dedicated-slot-state.js'
import { readJsonFile, writeAtomicFile } from './atomic-json-file.js'
import { isDedicatedDashboardRequest, readDashboardRouteState, serveDedicatedDashboard } from './dedicated-dashboard.js'
import { attachPublicAccessGate } from '../http/public-access-gate.js'

export type DedicatedIngress = {
  readonly http: HttpServer
  readonly port: number
  readonly unitId: typeof DEDICATED_RUNTIME_UNIT_ID
  readonly origin: string
  close(): Promise<void>
}

/** Stable public ingress for the fixed Dedicated `local` Runtime Unit. */
export async function startDedicatedIngress(options: {
  port: number
  unitOrigin: string
  routeStatePath?: string
  listenHost?: string
  admissionLedgerPath?: string
  admissionCapacity?: number
  ingressHandoffSecret?: string
  candidateStatePath?: string
  operatorStatusPath?: string
  deploymentRequestsPath?: string
  dashboardStatePath?: string
  dashboardReleasesRoot?: string
  auth?: AuthConfig
  publicUrls?: readonly PublicUrlPattern[]
}): Promise<DedicatedIngress> {
  const ledger = options.admissionLedgerPath ? new DedicatedAdmissionLedger(options.admissionLedgerPath, options.admissionCapacity) : undefined
  const http = createServer((request, response) => {
    if (response.headersSent || response.writableEnded) return
    stripUntrustedIdentityHeaders(request)
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (path === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (path === '/runtime/admission/messages' && request.method === 'POST' && ledger) {
      void acceptAdmission(request, options.auth, ledger, currentRoute, options.ingressHandoffSecret, () => scheduleReconcile()).then((body) => {
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
      }).catch((error) => {
        const status = error instanceof AdmissionBackpressureError ? 429 : error instanceof AdmissionHttpError ? error.status : 400
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(status === 429 ? { 'retry-after': '2' } : {}) })
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof AdmissionHttpError && error.durablyAccepted ? { durablyAccepted: true } : {}),
        }))
      })
      return
    }
    if (path === '/runtime/admission/status' && request.method === 'GET' && ledger) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void ledger.snapshot().then((snapshot) => { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(snapshot)) })
      return
    }
    const admissionOperation = /^\/runtime\/admission\/messages\/([^/]+)$/u.exec(path)
    if (admissionOperation && request.method === 'GET' && ledger) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      const operationId = decodeURIComponent(admissionOperation[1]!)
      void ledger.operation(operationId, principalDigest(auth.actor)).then((status) => {
        if (!status) { response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'admission operation not found' })); return }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(status))
      }).catch((error) => {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
      return
    }
    if (path === '/runtime/deployment/status' && request.method === 'GET' && options.operatorStatusPath) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void Promise.all([readJsonFile<Record<string, unknown>>(options.operatorStatusPath), options.dashboardStatePath ? readDashboardRouteState(options.dashboardStatePath) : undefined]).then(([status, dashboard]) => {
        if (!status) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ...status, ...(dashboard ? { dashboard } : {}) }))
      }).catch(() => response.writeHead(503).end())
      return
    }
    if (path === '/runtime/deployment/restart' && request.method === 'POST' && options.operatorStatusPath && options.deploymentRequestsPath) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void submitRuntimeRestart(options.operatorStatusPath, options.deploymentRequestsPath).then((operation) => {
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(operation))
      }).catch((error) => {
        response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
      return
    }
    const deploymentOperation = /^\/runtime\/deployment\/operations\/([^/]+)$/u.exec(path)
    if (deploymentOperation && request.method === 'GET' && options.operatorStatusPath && options.deploymentRequestsPath) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void runtimeDeploymentOperation(options.operatorStatusPath, options.deploymentRequestsPath, decodeURIComponent(deploymentOperation[1]!)).then((operation) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(operation))
      }).catch((error) => {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
      return
    }
    const deploymentAbort = /^\/runtime\/deployment\/operations\/([^/]+)\/abort$/u.exec(path)
    if (deploymentAbort && request.method === 'POST' && options.operatorStatusPath && options.deploymentRequestsPath) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void submitRuntimeAbort(options.operatorStatusPath, options.deploymentRequestsPath, decodeURIComponent(deploymentAbort[1]!)).then((operation) => {
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(operation))
      }).catch((error) => {
        response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
      return
    }
    if (path === '/runtime/dashboard/status' && request.method === 'GET' && options.dashboardStatePath) {
      void readDashboardRouteState(options.dashboardStatePath).then((status) => {
        if (!status) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(status))
      }).catch(() => response.writeHead(503).end())
      return
    }
    if (options.dashboardStatePath && options.dashboardReleasesRoot && isDedicatedDashboardRequest(request)) {
      void serveDedicatedDashboard({ request, response, statePath: options.dashboardStatePath, releasesRoot: options.dashboardReleasesRoot }).then((served) => {
        if (!served && !response.writableEnded) response.writeHead(503).end('dashboard unavailable')
      }).catch(() => { if (!response.headersSent) response.writeHead(503).end('dashboard unavailable') })
      return
    }
    if ((request.url ?? '/').startsWith('/internal/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'NOT_FOUND' }))
    }
  })
  // Stable Ingress carries long-lived Browser and Executor sockets. Node's
  // http.close() deliberately waits for upgraded and incomplete connections,
  // so a systemd stop would otherwise reach TimeoutStopSec and SIGKILL the
  // process. Track every accepted transport and explicitly disconnect it once
  // the listener has stopped accepting new work. Clients reconnect through the
  // same stable address after the process returns.
  const transports = new Set<Socket>()
  const trackTransport = (socket: Socket): void => {
    transports.add(socket)
    socket.once('close', () => transports.delete(socket))
  }
  http.on('connection', trackTransport)
  let cachedOrigin = options.unitOrigin
  let cachedGeneration = 0
  const currentRoute = async (): Promise<{ origin: string; generation: number }> => {
    await resolveOrigin()
    return { origin: cachedOrigin, generation: cachedGeneration }
  }
  const resolveOrigin = async (): Promise<string> => {
    if (!options.routeStatePath) return options.unitOrigin
    try {
      const state = await readDedicatedRouteState(options.routeStatePath)
      if (state.generation >= cachedGeneration) {
        cachedGeneration = state.generation
        cachedOrigin = state.slots[state.activeSlot].origin
      }
    } catch {
      // Keep the last valid route. A partial or missing file must never route
      // traffic to an unverified candidate.
    }
    return cachedOrigin
  }
  const ingress = createRuntimeUnitIngress({
    isRoutableRequest: (request) => !(request.url ?? '/').startsWith('/internal/') && !(request.url ?? '/').startsWith('/runtime/admission/') && !(request.url ?? '/').startsWith('/runtime/deployment/') && !(request.url ?? '/').startsWith('/runtime/dashboard/') && !(options.dashboardStatePath && options.dashboardReleasesRoot && isDedicatedDashboardRequest(request)),
    resolve: async () => ({ unitId: DEDICATED_RUNTIME_UNIT_ID, origin: await resolveOrigin() }),
    resolveUpgrade: async () => {
      const route = await currentRoute()
      const handoff = options.candidateStatePath ? await readCandidateState(options.candidateStatePath, route.generation) : undefined
      if (handoff?.phase === 'paused') return undefined
      return { unitId: DEDICATED_RUNTIME_UNIT_ID, origin: handoff?.origin ?? route.origin }
    },
  })
  http.prependListener('upgrade', stripUntrustedIdentityHeaders)
  ingress.attach(http)
  const detachPublicAccessGate = options.publicUrls ? attachPublicAccessGate(http, options.publicUrls) : undefined
  let reconciling = false
  let retryRequested = false
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined
  let reconcileDue = 0
  let reconcilePromise: Promise<void> | undefined
  let closing = false
  const scheduleReconcile = (delayMs = 0): void => {
    if (closing) return
    const due = Date.now() + delayMs
    if (reconcileTimer && due >= reconcileDue) return
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileDue = due
    reconcileTimer = setTimeout(() => {
      reconcileTimer = undefined
      if (reconcilePromise) {
        retryRequested = true
        return
      }
      const run = reconcileAdmission()
      reconcilePromise = run
      void run.catch(() => undefined).finally(() => {
        if (reconcilePromise === run) reconcilePromise = undefined
      })
    }, delayMs)
    reconcileTimer.unref()
  }
  const watchers = watchReconcileInputs([
    options.candidateStatePath,
    options.routeStatePath,
  ], scheduleReconcile)
  const reconcileAdmission = async (): Promise<void> => {
    if (!ledger || !options.ingressHandoffSecret) return
    if (reconciling) {
      retryRequested = true
      return
    }
    reconciling = true
    retryRequested = false
    const owner = `ingress-${process.pid}`
    const blockedSessionIds = new Set<string>()
    try {
      while (true) {
        const route = await currentRoute()
        const handoff = options.candidateStatePath ? await readCandidateState(options.candidateStatePath, route.generation) : undefined
        if (handoff?.phase === 'paused' || handoff?.phase === 'candidate') return
        const handoffOrigin = handoff?.origin ?? route.origin
        const record = await ledger.leaseNext(owner, route.generation, 30_000, blockedSessionIds)
        if (!record) return
        try {
          const response = await fetch(`${handoffOrigin}/internal/runtime/admission/commit`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': options.ingressHandoffSecret },
            body: JSON.stringify({ sessionId: record.sessionId, operationId: record.operationId, text: record.text, intent: record.intent, mode: record.mode, ...(record.content ? { content: record.content } : {}) }),
            signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) {
            const failure = await response.json().catch(() => ({})) as { code?: string; error?: string }
            if (response.status === 404 && failure.code === 'SESSION_NOT_FOUND') {
              await ledger.fail(record.operationId, owner, route.generation, 'The target Session no longer exists')
              continue
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
              await ledger.fail(record.operationId, owner, route.generation, failure.error ?? `Runtime rejected attachment validation (${response.status})`)
              continue
            }
            throw new Error(`runtime admission commit returned ${response.status}${failure.code ? ` (${failure.code})` : ''}`)
          }
          const outcome = await response.json() as { accepted?: boolean; committed?: boolean; cursor?: number }
          const terminal = outcome.accepted === true || outcome.committed === true
          const validCursor = outcome.cursor === undefined
            || (Number.isSafeInteger(outcome.cursor) && outcome.cursor >= 1)
          if (!terminal || !validCursor) {
            await ledger.release(record.operationId, owner, 'Runtime did not durably accept the operation')
            blockedSessionIds.add(record.sessionId)
            retryRequested = true
            continue
          }
          // A durable queue snapshot is a terminal handoff even before user
          // execution appends a Session event. If an earlier Ingress process
          // died before recording this receipt, Host's operationId tombstone or
          // queue entry makes the retry authoritative and idempotent.
          await ledger.committed(record.operationId, route.generation, outcome.cursor)
        } catch (error) {
          await ledger.release(record.operationId, owner, error instanceof Error ? error.message : String(error))
          blockedSessionIds.add(record.sessionId)
          retryRequested = true
          continue
        }
      }
    } finally {
      reconciling = false
      if (retryRequested) scheduleReconcile(1000)
    }
  }
  scheduleReconcile()
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.listenHost ?? '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  return {
    http,
    port: typeof address === 'object' && address ? address.port : options.port,
    unitId: DEDICATED_RUNTIME_UNIT_ID,
    origin: options.unitOrigin,
    async close() {
      closing = true
      if (reconcileTimer) clearTimeout(reconcileTimer)
      for (const watcher of watchers) watcher.close()
      detachPublicAccessGate?.()
      ingress.close()
      const closed = new Promise<void>((resolve, reject) => {
        http.close((error) => error ? reject(error) : resolve())
      })
      for (const transport of transports) transport.destroy()
      await Promise.all([closed, reconcilePromise?.catch(() => undefined)])
      http.off('connection', trackTransport)
    },
  }

  function watchReconcileInputs(paths: Array<string | undefined>, notify: () => void): FSWatcher[] {
    const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))]
    return unique.flatMap((path) => {
      try {
        const filename = basename(path)
        const watcher = watch(dirname(path), { persistent: false }, (_event, changed) => {
          if (!changed || changed.toString() === filename) notify()
        })
        watcher.on('error', notify)
        return [watcher]
      } catch {
        return []
      }
    })
  }
}

class AdmissionHttpError extends Error {
  constructor(readonly status: number, message: string, readonly durablyAccepted = false) { super(message) }
}

async function acceptAdmission(
  request: import('node:http').IncomingMessage,
  auth: AuthConfig | undefined,
  ledger: DedicatedAdmissionLedger,
  route: () => Promise<{ origin: string; generation: number }>,
  ingressHandoffSecret: string | undefined,
  onAccepted?: () => void,
): Promise<unknown> {
  const authenticated = ingressActor(request, auth)
  if (!authenticated.ok) throw new AdmissionHttpError(401, authenticated.reason)
  if (authenticated.actor.kind === 'ingress' && authenticated.actor.role === 'viewer') {
    throw new AdmissionHttpError(403, 'forbidden')
  }
  const body = await readRequestJson(request)
  const payloadError = validateClientMessagePayload(body)
  if (payloadError) throw new AdmissionHttpError(413, `${payloadError.code}: ${payloadError.message}`)
  const parsed = schema.ClientUserMessageSchema.safeParse(body)
  if (!parsed.success) throw new AdmissionHttpError(400, 'invalid admission message')
  const imageValidation = validateInlineMessageImages(parsed.data.content)
  if (!imageValidation.ok) throw new AdmissionHttpError(400, `${imageValidation.error.code}: ${imageValidation.error.message}`)
  const fileValidation = validateInlineMessageFiles(parsed.data.content, effectiveAttachmentLimit(request.headers, auth?.requireIngressIdentity === true && authenticated.actor.kind === 'ingress'))
  if (!fileValidation.ok) throw new AdmissionHttpError(400, `${fileValidation.error.code}: ${fileValidation.error.message}`)
  const message: AdmissionMessage = {
    schemaVersion: 1, principalDigest: principalDigest(authenticated.actor), unitId: 'local',
    sessionId: parsed.data.sessionId, operationId: required(parsed.data.operationId, 'operationId'),
    mode: parsed.data.mode === 'queue' ? 'queue' : 'steer', intent: parsed.data.intent, text: parsed.data.text,
    ...(parsed.data.content ? { content: parsed.data.content } : {}),
  }
  const hasReferencedAttachments = message.content?.some(isHostReferencedAttachment) ?? false
  if (hasReferencedAttachments && !ingressHandoffSecret) {
    throw new AdmissionHttpError(503, 'attachment admission requires the Runtime handoff channel')
  }
  const attachmentCommitSecret = ingressHandoffSecret
  const active = await route()
  const result = await ledger.append(message, active.generation)
  onAccepted?.()
  if (hasReferencedAttachments) {
    if (!attachmentCommitSecret) throw new AdmissionHttpError(503, 'attachment admission requires the Runtime handoff channel')
    let response: Response
    try {
      response = await fetch(`${active.origin}/internal/runtime/attachments/commit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-runlab-ingress-handoff': attachmentCommitSecret,
        },
        body: JSON.stringify({ sessionId: message.sessionId, content: message.content }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch (error) {
      throw new AdmissionHttpError(503, `attachment reservation failed after durable admission: ${error instanceof Error ? error.message : String(error)}`, true)
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string }
      throw new AdmissionHttpError(503, failure.error ?? `attachment reservation returned ${response.status}`, true)
    }
  }
  return { accepted: true, duplicate: result.duplicate, operationId: result.record.operationId, sequence: result.record.sequence, state: result.record.state, routeGeneration: result.record.routeGeneration }
}

function ingressActor(request: import('node:http').IncomingMessage, auth: AuthConfig | undefined): ReturnType<typeof authenticateDashboardHandshake> {
  const authorization = request.headers.authorization
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
  return authenticateDashboardHandshake({ role: 'dashboard', clientVersion: 'ingress', ...(token ? { token } : {}) }, request, auth)
}

function stripUntrustedIdentityHeaders(request: import('node:http').IncomingMessage): void {
  delete request.headers['x-agent-runlab-principal']
  delete request.headers['x-agent-runlab-organization-id']
  delete request.headers['x-agent-runlab-organization-role']
}

function isHostReferencedAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const block = value as Record<string, unknown>
  if (block.type !== 'file' || !block.source || typeof block.source !== 'object') return false
  return (block.source as Record<string, unknown>).kind === 'host_ref'
}
function principalDigest(actor: DashboardActor): string { return createHash('sha256').update(JSON.stringify(actor)).digest('hex') }
async function readCandidateState(path: string, expectedGeneration: number): Promise<{ phase: 'paused' } | { phase: 'candidate' | 'admission'; origin: string } | undefined> {
  const state: { schemaVersion: number; expectedRouteGeneration: number; phase: unknown; origin?: unknown } | undefined = await readJsonFile<{ schemaVersion: number; expectedRouteGeneration: number; phase: unknown; origin?: unknown }>(path)
    .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT'
      ? undefined
      : { schemaVersion: 1, expectedRouteGeneration: expectedGeneration, phase: 'paused', origin: undefined })
  if (!state || state.expectedRouteGeneration !== expectedGeneration) return undefined
  if (state.schemaVersion !== 1 || state.phase === 'paused') return { phase: 'paused' }
  if ((state.phase !== 'candidate' && state.phase !== 'admission') || typeof state.origin !== 'string' || !isLoopbackOrigin(state.origin)) return { phase: 'paused' }
  return { phase: state.phase, origin: state.origin }
}
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const port = Number(url.port)
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number.isSafeInteger(port)
      && port >= 1
      && port <= 65_535
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}
function required(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim() }
type OperatorDeploymentStatus = {
  route: { generation: number; activeSlot: 'blue' | 'green'; activeReleaseId: string }
  slots: Record<'blue' | 'green', { releaseDigest?: string }>
  deployment?: null | { deploymentId: string; operationId: string; phase: string; releaseDigest: string; sourceReleaseDigest: string; candidateSlot: 'blue' | 'green'; blockers?: readonly string[]; error?: { message?: string } }
}
async function submitRuntimeRestart(statusPath: string, requestsPath: string): Promise<unknown> {
  const status = await requiredOperatorStatus(statusPath)
  if (status.deployment && !terminalDeploymentPhase(status.deployment.phase)) throw new Error(`deployment ${status.deployment.deploymentId} is already active in phase ${status.deployment.phase}`)
  const releaseDigest = required(status.slots[status.route.activeSlot].releaseDigest, 'active release digest')
  const operationId = `operation-restart-${randomUUID()}`
  const deploymentId = `deployment-restart-${randomUUID()}`
  const request = {
    schemaVersion: 1, action: 'restart', operationId, deploymentId, topology: 'dedicated-slots', unitId: 'local',
    requestedAt: new Date().toISOString(), expectedRouteGeneration: status.route.generation, fencingToken: randomBytes(24).toString('base64url'),
    sourceReleaseDigest: releaseDigest, targetReleaseDigest: releaseDigest, predecessorReleaseId: status.route.activeReleaseId,
    candidateSlot: status.route.activeSlot === 'blue' ? 'green' : 'blue',
  }
  await writeAtomicFile(join(requestsPath, `${operationId}.json`), `${JSON.stringify(request, null, 2)}\n`, 0o640)
  return { accepted: true, action: 'restart', operationId, deploymentId, phase: 'submitted' }
}
async function submitRuntimeAbort(statusPath: string, requestsPath: string, targetOperationId: string): Promise<unknown> {
  const status = await requiredOperatorStatus(statusPath)
  const target = status.deployment
  if (!target || target.operationId !== targetOperationId || terminalDeploymentPhase(target.phase)) throw new Error('restart operation is not active')
  const operationId = `operation-abort-${randomUUID()}`
  const request = {
    schemaVersion: 1, action: 'abort', operationId, deploymentId: target.deploymentId, topology: 'dedicated-slots', unitId: 'local',
    requestedAt: new Date().toISOString(), expectedRouteGeneration: status.route.generation, fencingToken: randomBytes(24).toString('base64url'),
    sourceReleaseDigest: target.sourceReleaseDigest, targetReleaseDigest: target.releaseDigest, predecessorReleaseId: status.route.activeReleaseId,
    candidateSlot: target.candidateSlot, targetDeploymentId: target.deploymentId,
  }
  await writeAtomicFile(join(requestsPath, `${operationId}.json`), `${JSON.stringify(request, null, 2)}\n`, 0o640)
  return { accepted: true, action: 'abort', operationId, deploymentId: target.deploymentId, targetOperationId, phase: 'submitted' }
}
async function runtimeDeploymentOperation(statusPath: string, requestsPath: string, operationId: string): Promise<unknown> {
  const status = await requiredOperatorStatus(statusPath)
  if (status.deployment?.operationId === operationId) return { operationId, deploymentId: status.deployment.deploymentId, phase: status.deployment.phase, blockers: status.deployment.blockers ?? [], error: status.deployment.error }
  const rejected = join(requestsPath, `${operationId}.json.rejected`)
  try {
    await access(rejected)
    const detail = await readJsonFile<{ message?: string }>(`${rejected}.error`)
    return { operationId, phase: 'rejected', error: { message: detail?.message ?? 'Supervisor rejected the restart request' } }
  } catch {}
  for (const suffix of ['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed']) {
    try { await access(join(requestsPath, `${operationId}.json.accepted.${suffix}`)); return { operationId, phase: suffix } } catch {}
  }
  try { await access(join(requestsPath, `${operationId}.json`)); return { operationId, phase: 'submitted' } } catch {}
  try { await access(join(requestsPath, `${operationId}.json.accepted`)); return { operationId, phase: 'accepted' } } catch {}
  throw new Error('deployment operation not found')
}
async function requiredOperatorStatus(path: string): Promise<OperatorDeploymentStatus> {
  const status = await readJsonFile<OperatorDeploymentStatus>(path)
  if (!status || !Number.isSafeInteger(status.route?.generation) || !['blue', 'green'].includes(status.route?.activeSlot)) throw new Error('deployment status is unavailable')
  return status
}
function terminalDeploymentPhase(phase: string): boolean { return ['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed'].includes(phase) }
async function readRequestJson(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8 * 1024 * 1024) throw new AdmissionHttpError(413, 'admission payload too large'); chunks.push(bytes) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
