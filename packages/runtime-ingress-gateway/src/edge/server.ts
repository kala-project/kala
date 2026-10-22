import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'

import httpProxy from 'http-proxy'
import { parsePublicUrls, validatePublicRequest, type PublicUrlPattern } from '@agent-kernel/shared'

import type { LoginStateStore } from '../auth/login-state-store.js'
import type { OidcClient } from '../auth/oidc-client.js'
import { inviteKey, type AuthenticatedIdentity, type RuntimeAssignmentStore } from '../assignments/store.js'
import { permits, type OrganizationAccess, type OrganizationStore } from '../organizations/store.js'
import { browserDeviceFromUserAgent, browserSessionTokenHash, isLive, type BrowserSession, type BrowserSessionStore } from '../auth/browser-session-store.js'
import type { SessionSecretBox } from '../auth/session-secret-box.js'
import type { EnterpriseSsoResolver } from '../auth/enterprise-sso.js'
import { ServiceAccountInputError, type ServiceAccountService, type ServiceAccountScope } from '../api/service-accounts.js'
import { enterpriseManagementOpenApi } from '../api/openapi.js'
import type { RateLimiter } from '../governance/rate-limit.js'
import { isOwnerBootstrapToken, ownerBootstrapHash, type OwnerBootstrapGateway } from '../organizations/owner-bootstrap.js'
import type { RuntimeOriginResolver } from '../runtime-origin/postgres-runtime-origin-resolver.js'
import type { RuntimeRoutingTicketResolver } from '../runtime-origin/runtime-routing-ticket-resolver.js'

export type RuntimeIngressGateway = { readonly http: HttpServer; readonly port: number; close(): Promise<void> }
export type { RuntimeOriginResolver } from '../runtime-origin/postgres-runtime-origin-resolver.js'

class RuntimeOriginUnavailableError extends Error {
  constructor() { super('runtime_origin_unavailable') }
}

function publicProfile(session: AuthenticatedIdentity): { displayName: string; email?: string; initials: string } {
  const displayName = session.displayName?.trim() || session.email?.split('@')[0] || 'Kala user'
  const initials = displayName.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'AR'
  return { displayName, ...(session.email ? { email: session.email } : {}), initials }
}

function isDocumentNavigation(request: IncomingMessage): boolean {
  if (request.method !== 'GET') return false
  const accept = request.headers.accept ?? ''
  const destination = request.headers['sec-fetch-dest']
  return accept.includes('text/html') && (destination === 'document' || destination === undefined)
}

function isPublicInstallerPath(pathname: string): boolean {
  return pathname === '/install' || pathname === '/install.ps1' || pathname === '/install/invite.ps1' || pathname.startsWith('/install/assets/') || pathname.startsWith('/release-assets/')
}

const DASHBOARD_API_EXACT = new Set(['/models', '/settings', '/memo', '/metrics', '/organization', '/install', '/install.ps1'])
const DASHBOARD_API_PREFIXES = [
  '/socket.io/', '/runtime/', '/internal/', '/settings/', '/auth/', '/push/', '/api/', '/user/', '/organization/',
  '/artifacts/', '/session-artifacts/', '/router/', '/enhancement/', '/install/', '/release-assets/', '/themes/',
]

function isDashboardRequest(request: IncomingMessage, pathname: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (DASHBOARD_API_EXACT.has(pathname) || DASHBOARD_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  if (pathname === '/docs/index' || pathname === '/docs/content') return false
  if (pathname === '/' || request.headers.accept?.includes('text/html')) return true
  return /\.[A-Za-z0-9]+$/u.test(pathname)
}

function denyInactiveOrganization(response: ServerResponse, status: string): void {
  response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: 'organization_not_active', status }))
}

function enforceRateLimit(response: ServerResponse, limiter: RateLimiter | undefined, key: string, api = false): boolean {
  if (!limiter) return true
  const decision = limiter.check(key)
  if (decision.ok) return true
  const requestId = api ? randomBytes(16).toString('hex') : undefined
  response.writeHead(429, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'retry-after': String(Math.ceil(decision.retryAfterMs / 1_000)),
    ...(api ? {
      'x-request-id': requestId!,
      'x-kala-api-version': 'v1',
      'x-kala-api-compatibility': '1',
    } : {}),
  })
  response.end(JSON.stringify(api
    ? { error: { code: 'rate_limited', message: 'request rate limit exceeded', requestId, details: { retryAfterMs: decision.retryAfterMs } } }
    : { error: 'rate_limited', retryAfterMs: decision.retryAfterMs }))
  return false
}

async function readRequestBody(request: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.length
    if (bytes > maxBytes) throw new Error('request_body_too_large')
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

function cookies(request: IncomingMessage): Record<string, string> {
  try {
    return Object.fromEntries((request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2) as [string, string][])
  } catch { return {} }
}

function signedOutPage(): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed out · Kala</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#f8fafc;font:16px system-ui,sans-serif}.card{width:min(28rem,calc(100% - 2rem));padding:2rem;border:1px solid #27272a;border-radius:1rem;background:#18181b;box-sizing:border-box}.mark{width:3rem;height:3rem;display:grid;place-items:center;border-radius:.75rem;background:#0f766e;font-weight:800}h1{font-size:1.5rem;margin:1.25rem 0 .5rem}p{color:#a1a1aa;line-height:1.5}a{display:inline-flex;margin-top:1rem;padding:.75rem 1rem;border-radius:.65rem;background:#0f766e;color:white;text-decoration:none;font-weight:650}</style></head><body><main class="card"><div class="mark">AR</div><h1>You are signed out</h1><p>Your Kala browser session has ended. Sign in again when you are ready.</p><a href="/auth/login">Sign in</a></main></body></html>'
}

function inviteResultPage(kind: 'accepted' | 'verified_email_required' | 'email_mismatch' | 'unavailable'): string {
  const copy = {
    accepted: ['Invitation accepted', 'Your verified identity is now connected to the organization.', 'Open Kala'],
    verified_email_required: ['Invitation not accepted', 'Your identity provider did not attest that your email is verified. Ask your administrator or identity provider for help.', 'Try another account'],
    email_mismatch: ['Invitation not accepted', 'The verified email on this account does not match the invitation.', 'Try another account'],
    unavailable: ['Invitation not accepted', 'This invitation is invalid, expired, revoked, or already used. Ask an organization administrator for a new link.', 'Return to sign in'],
  }[kind]
  const href = kind === 'accepted' ? '/' : '/auth/login?prompt=login'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy[0]} · Kala</title></head><body><main><h1>${copy[0]}</h1><p>${copy[1]}</p><a href="${href}">${copy[2]}</a></main></body></html>`
}

function ownerBootstrapResultPage(result: { bootstrapId: string; confirmationCode: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Owner confirmation required · Kala</title></head><body><main><h1>Operator confirmation required</h1><p>Login succeeded, but no organization or owner was created. Read this one-time code to the trusted operator and keep this page open while they compare the candidate identity.</p><p>Authorization: <strong>${result.bootstrapId}</strong></p><p>Confirmation code: <strong>${result.confirmationCode}</strong></p><p>After the operator confirms, return to the normal sign-in page.</p></main></body></html>`
}

export async function startRuntimeIngressGateway(options: {
  port: number
  oidc: OidcClient
  directory: RuntimeAssignmentStore
  organizations?: OrganizationStore
  ownerBootstrap?: OwnerBootstrapGateway
  enterpriseSso?: EnterpriseSsoResolver
  loginStates: LoginStateStore
  hostOrigin: string
  runtimeOriginResolver?: RuntimeOriginResolver
  runtimeRoutingTicketResolver?: RuntimeRoutingTicketResolver
  dashboardOrigin?: string
  sessions: BrowserSessionStore
  cacheNamespaceSecret: string
  secretBox: SessionSecretBox
  publicOrigin: string
  publicUrls?: readonly PublicUrlPattern[]
  listenHost?: string
  ingressSecret: string
  runtimeTls?: {
    ca: string | Buffer
    cert: string | Buffer
    key: string | Buffer
    servername?: string
  }
  serviceAccounts?: ServiceAccountService
  rateLimiter?: RateLimiter
  socketRecheckMs?: number
  provision?(unitId: string): Promise<void>
}): Promise<RuntimeIngressGateway> {
  const recheckMs = options.socketRecheckMs ?? 15_000
  if (!Number.isSafeInteger(recheckMs) || recheckMs < 1) throw new Error('socketRecheckMs must be positive')
  const browserSockets = new Map<Duplex, { sessionId: string; identity: AuthenticatedIdentity; upstream?: Duplex; timer?: ReturnType<typeof setTimeout> }>()
  const executorSockets = new Map<Duplex, { routeHash: string; unitId: string; upstream?: Duplex; timer?: ReturnType<typeof setTimeout> }>()
  const authorizationStillValid = async (check: () => Promise<boolean>): Promise<boolean> => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        check(),
        new Promise<false>((resolve) => { deadline = setTimeout(() => resolve(false), 5_000); deadline.unref() }),
      ])
    } catch { return false }
    finally { if (deadline) clearTimeout(deadline) }
  }
  const closeSockets = (predicate: (entry: { sessionId: string; identity: AuthenticatedIdentity }) => boolean) => {
    for (const [socket, entry] of browserSockets) if (predicate(entry)) {
      entry.upstream?.destroy()
      socket.destroy()
    }
  }
  const closeSocketsForIdentity = (identity: AuthenticatedIdentity) => closeSockets((entry) =>
    entry.identity.issuer === identity.issuer && entry.identity.subject === identity.subject)
  const closeExecutorSocket = (socket: Duplex) => {
    executorSockets.get(socket)?.upstream?.destroy()
    socket.destroy()
  }
  const monitorBrowserSocket = (socket: Duplex, session: BrowserSession, access: OrganizationAccess) => {
    const entry: { sessionId: string; identity: AuthenticatedIdentity; upstream?: Duplex; timer?: ReturnType<typeof setTimeout> } = { sessionId: session.id, identity: session.identity }
    browserSockets.set(socket, entry)
    socket.once('close', () => { if (entry.timer) clearTimeout(entry.timer); browserSockets.delete(socket) })
    const schedule = () => {
      entry.timer = setTimeout(() => { void recheck() }, recheckMs)
      entry.timer.unref()
    }
    const recheck = async () => {
      const valid = await authorizationStillValid(async () => {
        const current = await options.sessions.findByTokenHash(session.tokenHash)
        if (!current || current.id !== session.id || !isLive(current, Date.now())) return false
        const latest = await options.organizations!.findAccess(session.identity)
        return latest?.organization.id === access.organization.id
          && latest.organization.unitId === access.organization.unitId
          && latest.organization.status === 'active'
          && latest.membership.role === access.membership.role
          && permits(latest.membership.role, 'runtime:write')
      })
      if (!valid) closeSockets((candidate) => candidate === entry)
      if (!socket.destroyed) schedule()
    }
    schedule()
  }
  const monitorExecutorSocket = (socket: Duplex, routeHash: string, unitId: string) => {
    const entry: { routeHash: string; unitId: string; upstream?: Duplex; timer?: ReturnType<typeof setTimeout> } = { routeHash, unitId }
    executorSockets.set(socket, entry)
    socket.once('close', () => { if (entry.timer) clearTimeout(entry.timer); executorSockets.delete(socket) })
    const schedule = () => {
      entry.timer = setTimeout(() => { void recheck() }, recheckMs)
      entry.timer.unref()
    }
    const recheck = async () => {
      const valid = await authorizationStillValid(async () =>
        (await options.directory.findUnitByExecutorRouteHint(entry.routeHash)) === entry.unitId)
      if (!valid) closeExecutorSocket(socket)
      if (!socket.destroyed) schedule()
    }
    schedule()
  }
  const runtimeAgent = options.runtimeTls
    ? new HttpsAgent({
        ca: options.runtimeTls.ca,
        cert: options.runtimeTls.cert,
        key: options.runtimeTls.key,
        servername: options.runtimeTls.servername,
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      })
    : undefined
  const proxy = httpProxy.createProxyServer({
    ws: true,
    target: options.hostOrigin,
    ...(runtimeAgent ? { agent: runtimeAgent, secure: true } : {}),
  })
  const dashboardProxy = options.dashboardOrigin ? httpProxy.createProxyServer({ target: options.dashboardOrigin }) : undefined
  proxy.on('error', () => {})
  // `open` exposes only the upstream socket. `proxyReqWs` also carries the
  // incoming socket, so bind the specific outgoing upgrade without guessing by
  // connection order (which can differ under concurrent tenant handshakes).
  proxy.on('proxyReqWs', (proxyRequest, _request, incomingSocket) => {
    if (!browserSockets.has(incomingSocket) && !executorSockets.has(incomingSocket)) return
    proxyRequest.once('upgrade', (_response, upstreamSocket) => {
      const entry = browserSockets.get(incomingSocket) ?? executorSockets.get(incomingSocket)
      if (!entry || incomingSocket.destroyed) { upstreamSocket.destroy(); return }
      entry.upstream = upstreamSocket
      incomingSocket.once('close', () => upstreamSocket.destroy())
      upstreamSocket.once('close', () => incomingSocket.destroy())
    })
  })
  dashboardProxy?.on('error', () => {})
  const resolveRuntimeOrigin = async (unitId: string): Promise<string> => {
    if (!options.runtimeOriginResolver) return options.hostOrigin
    let resolved: string | undefined
    try { resolved = await options.runtimeOriginResolver.resolve(unitId) } catch { throw new RuntimeOriginUnavailableError() }
    if (!resolved) throw new RuntimeOriginUnavailableError()
    try {
      const parsed = new URL(resolved)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin')
      return parsed.origin
    } catch {
      throw new RuntimeOriginUnavailableError()
    }
  }
  const authenticate = async (request: IncomingMessage): Promise<BrowserSession | undefined> => {
    const token = cookies(request).ak_session
    if (!token || token.length < 32 || token.length > 128) return undefined
    let session = await options.sessions.findByTokenHash(browserSessionTokenHash(token))
    if (!session || !isLive(session, Date.now())) return undefined
    if (session.refreshToken && session.providerRefreshAfter !== undefined && session.providerRefreshAfter <= Date.now()) {
      try {
        const result = await options.oidc.refresh(options.secretBox.decrypt(session.refreshToken))
        const replacement = result.refreshToken ? options.secretBox.encrypt(result.refreshToken) : session.refreshToken
        session = await options.sessions.updateProvider(session.id, session.refreshToken, {
          refreshToken: replacement,
          providerRefreshAfter: result.accessTokenExpiresAt !== undefined ? result.accessTokenExpiresAt - 5 * 60_000 : Date.now() + 55 * 60_000,
        }) ?? session
      } catch {
        return undefined
      }
    }
    return await options.sessions.touch(session.id, Date.now(), Date.now() + 86_400_000)
  }
  const publicUrl = new URL(options.publicOrigin)
  let publicUrls = options.publicUrls
  const secure = publicUrl.protocol === 'https:' ? '; Secure' : ''
  const callbackUri = `${options.publicOrigin}/auth/callback`
  const requestPublicOrigin = (request: IncomingMessage): string => {
    const value = request.headers['x-kala-public-origin']
    return typeof value === 'string' ? value : publicUrl.origin
  }
  const requireSameOriginWhenPresent = (request: IncomingMessage, response: ServerResponse): boolean => {
    const origin = request.headers.origin
    if (!origin || origin === requestPublicOrigin(request)) return true
    response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: 'forbidden', message: 'same-origin browser request is required' }))
    return false
  }
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', options.publicOrigin)
    if (url.pathname === '/install/invite.ps1' && url.search) {
      response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'query_not_allowed' }))
      return
    }
    if (url.pathname === '/install/invite.ps1' && request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'method_not_allowed' }))
      return
    }
    if (isPublicInstallerPath(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      // Anonymous installation assets are shared release bytes, never a tenant
      // route. Replace untrusted client headers before contacting the Runtime.
      request.headers['x-agent-runlab-runtime-unit'] = 'public-installer'
      request.headers['x-agent-runlab-ingress-secret'] = options.ingressSecret
      request.headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1)
      request.headers['x-forwarded-host'] = publicUrl.host
      proxy.web(request, response, { target: options.hostOrigin }, () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('installer upstream unavailable')
      })
      return
    }
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/signed-out') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(signedOutPage())
      return
    }
    if (url.pathname === '/auth/invite-result' && url.searchParams.get('status') === 'accepted') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(inviteResultPage('accepted')); return
    }
    if (url.pathname === '/auth/owner-bootstrap') {
      const token = url.searchParams.get('token')?.trim() ?? ''
      if (!options.ownerBootstrap || !isOwnerBootstrapToken(token)) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end('owner bootstrap unavailable'); return }
      const tokenHash = ownerBootstrapHash(token)
      try { await options.ownerBootstrap.assertAvailable(tokenHash) } catch { response.writeHead(410, { 'cache-control': 'no-store' }); response.end('owner bootstrap unavailable'); return }
      const oidcNonce = randomBytes(24).toString('base64url')
      const login = await options.oidc.authorizationUrl(callbackUri, { prompt: 'login', nonce: oidcNonce })
      const loginCookie = randomBytes(24).toString('base64url')
      await options.loginStates.put(loginCookie, { ...login, oidcNonce, redirectUri: callbackUri, expiresAt: Date.now() + 10 * 60_000, ownerBootstrapHash: tokenHash })
      response.writeHead(302, { location: login.url.href, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'set-cookie': `ak_login=${loginCookie}; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=600` }); response.end(); return
    }
    if (url.pathname === '/auth/login') {
      const forceLogin = url.searchParams.get('prompt') === 'login'
      const organizationInviteToken = url.searchParams.get('invite')?.trim()
      if (organizationInviteToken && !/^ak_org_invite_[A-Za-z0-9_-]{43}$/u.test(organizationInviteToken)) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(inviteResultPage('unavailable')); return
      }
      const ssoSelector = url.searchParams.get('sso')?.trim()
      const ssoConnection = ssoSelector && options.enterpriseSso ? await options.enterpriseSso.resolve(ssoSelector) : undefined
      if (ssoSelector && !ssoConnection) {
        response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'sso_connection_not_found' })); return
      }
      const oidcNonce = randomBytes(24).toString('base64url')
      const login = await options.oidc.authorizationUrl(callbackUri, {
        nonce: oidcNonce,
        ...(forceLogin ? { prompt: 'login' as const } : {}),
        ...(ssoConnection?.loginHint ? { loginHint: ssoConnection.loginHint } : {}),
        ...(ssoConnection ? { idpHint: ssoConnection.providerId } : {}),
      })
      const nonce = randomBytes(24).toString('base64url')
      await options.loginStates.put(nonce, { ...login, oidcNonce, redirectUri: callbackUri, expiresAt: Date.now() + 10 * 60_000, ...(ssoConnection ? { ssoConnectionId: ssoConnection.id } : {}), ...(organizationInviteToken ? { organizationInviteHash: inviteKey(organizationInviteToken) } : {}) })
      response.writeHead(302, { location: login.url.href, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'set-cookie': `ak_login=${nonce}; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=600` }); response.end(); return
    }
    if (url.pathname === '/auth/callback') {
      const nonce = cookies(request).ak_login
      const login = nonce ? await options.loginStates.take(nonce) : undefined
      if (!login) { response.writeHead(400); response.end('invalid login state'); return }
      const authentication = await options.oidc.callback(url, login.redirectUri, login.codeVerifier, login.state, login.oidcNonce)
      const identity = authentication.identity
      if (login.ownerBootstrapHash) {
        try {
          const result = await options.ownerBootstrap?.captureCandidate(login.ownerBootstrapHash, identity)
          if (!result) throw new Error('owner_bootstrap_not_available')
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0` })
          response.end(ownerBootstrapResultPage(result)); return
        } catch (reason) {
          const code = reason instanceof Error ? reason.message : 'owner_bootstrap_not_available'
          response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0` })
          response.end(JSON.stringify({ error: code })); return
        }
      }
      if (login.ssoConnectionId) {
        const connection = await options.enterpriseSso?.resolve(login.ssoConnectionId)
        if (!connection || !await options.enterpriseSso!.authorize(connection, identity)) {
          response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ error: 'sso_authentication_mismatch' })); return
        }
      }
      let access
      if (login.organizationInviteHash) {
        if (!options.organizations?.acceptInvite) {
          response.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end(inviteResultPage('unavailable')); return
        }
        try {
          access = await options.organizations.acceptInvite(login.organizationInviteHash, identity)
        } catch (reason) {
          const code = reason instanceof Error ? reason.message : ''
          const kind = code === 'invite_verified_email_required' ? 'verified_email_required'
            : code === 'invite_email_mismatch' ? 'email_mismatch' : 'unavailable'
          response.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0` })
          response.end(inviteResultPage(kind)); return
        }
      } else {
        access = options.organizations ? await options.organizations.getOrCreateForIdentity(identity) : undefined
      }
      if (access && access.organization.status !== 'active') {
        denyInactiveOrganization(response, access.organization.status)
        return
      }
      const assignment = access ? { unitId: access.organization.unitId, identity } : await options.directory.getOrCreateForIdentity(identity)
      await options.provision?.(assignment.unitId)
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      await options.sessions.create({
        tokenHash: browserSessionTokenHash(token),
        identity,
        cacheNamespace: createHmac('sha256', options.cacheNamespaceSecret).update(access?.organization.id ?? `${identity.issuer}\0${identity.subject}`).digest('base64url').slice(0, 22),
        device: browserDeviceFromUserAgent(request.headers['user-agent']),
        createdAt: now,
        idleExpiresAt: now + 86_400_000,
        absoluteExpiresAt: now + 30 * 86_400_000,
        ...(authentication.refreshToken ? { refreshToken: options.secretBox.encrypt(authentication.refreshToken) } : {}),
        ...(authentication.accessTokenExpiresAt !== undefined ? { providerRefreshAfter: authentication.accessTokenExpiresAt - 5 * 60_000 } : {}),
      })
      response.writeHead(302, { location: login.organizationInviteHash ? '/auth/invite-result?status=accepted' : publicUrl.href, 'set-cookie': [`ak_session=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=2592000`, `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0`] }); response.end(); return
    }
    if (url.pathname === '/auth/me') {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' })
      const access = session && options.organizations ? await options.organizations.findAccess(session.identity) : undefined
      response.end(JSON.stringify(session ? {
        authenticated: true,
        profile: publicProfile(session.identity),
        ...(access ? { organization: { id: access.organization.id, name: access.organization.name, status: access.organization.status, role: access.membership.role } } : {}),
        cacheNamespace: session.cacheNamespace,
        expiresAt: new Date(Math.min(session.idleExpiresAt, session.absoluteExpiresAt)).toISOString(),
      } : { authenticated: false }))
      return
    }
    if (url.pathname === '/auth/logout') {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }); response.end(); return }
      const origin = request.headers.origin
      if (origin && origin !== requestPublicOrigin(request)) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (session) {
        await options.sessions.revoke(session.id, 'logout', Date.now())
        closeSockets((entry) => entry.sessionId === session.id)
      }
      const formNavigation = request.headers['sec-fetch-mode'] === 'navigate' || (request.headers.accept ?? '').includes('text/html')
      response.writeHead(formNavigation ? 303 : 204, {
        ...(formNavigation ? { location: '/auth/login?prompt=login' } : {}),
        'cache-control': 'no-store',
        'clear-site-data': '"cache"',
        'set-cookie': [
          `ak_session=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`,
          `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0`,
        ],
      })
      response.end(); return
    }
    if (url.pathname === '/auth/logout-all') {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }); response.end(); return }
      const origin = request.headers.origin
      if (origin && origin !== requestPublicOrigin(request)) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (!session) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
      await options.sessions.revokeAllForIdentity(session.identity, 'logout_all', Date.now())
      closeSocketsForIdentity(session.identity)
      response.writeHead(204, { 'cache-control': 'no-store', 'clear-site-data': '"cache"', 'set-cookie': `ak_session=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0` })
      response.end(); return
    }
    if (url.pathname === '/auth/sessions') {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (!session) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
      const sessions = await options.sessions.listForIdentity(session.identity, Date.now())
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ sessions: sessions.map((item) => ({ id: item.id, current: item.id === session.id, device: item.device, createdAt: new Date(item.createdAt).toISOString(), lastSeenAt: new Date(item.lastSeenAt).toISOString(), expiresAt: new Date(Math.min(item.idleExpiresAt, item.absoluteExpiresAt)).toISOString() })) }))
      return
    }
    const sessionDelete = url.pathname.match(/^\/auth\/sessions\/([^/]+)$/u)
    if (sessionDelete) {
      if (request.method !== 'DELETE') { response.writeHead(405, { allow: 'DELETE', 'cache-control': 'no-store' }); response.end(); return }
      const origin = request.headers.origin
      if (origin && origin !== requestPublicOrigin(request)) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (!session) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
      const owned = (await options.sessions.listForIdentity(session.identity, Date.now())).find((item) => item.id === sessionDelete[1])
      if (!owned) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return }
      await options.sessions.revoke(owned.id, 'remote_logout', Date.now())
      closeSockets((entry) => entry.sessionId === owned.id)
      response.writeHead(204, { 'cache-control': 'no-store', ...(owned.id === session.id ? { 'set-cookie': `ak_session=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0` } : {}) })
      response.end(); return
    }
    const session = await authenticate(request)
    const identity = session?.identity
    const organizationAccess = identity && options.organizations ? await options.organizations.findAccess(identity) : undefined
    // Apply the effective organization/contract status before management and
    // generic API handlers too, not only the fallback Runtime proxy.
    if (organizationAccess && organizationAccess.organization.status !== 'active') {
      denyInactiveOrganization(response, organizationAccess.organization.status)
      return
    }
    if (url.pathname === '/.well-known/kala/executor-replicas') {
      const deny = (status: number, error: string) => {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error }))
      }
      if (request.method !== 'GET') { response.setHeader('allow', 'GET'); deny(405, 'method_not_allowed'); return }
      if (request.headers.cookie || request.headers.authorization || !options.runtimeOriginResolver?.listReplicas) { deny(404, 'replica_discovery_unavailable'); return }
      const executorInvite = typeof request.headers['x-kala-executor-invite'] === 'string' ? request.headers['x-kala-executor-invite'] : undefined
      const routeHint = typeof request.headers['x-kala-executor-route'] === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(request.headers['x-kala-executor-route']) ? request.headers['x-kala-executor-route'] : undefined
      const unitId = executorInvite
        ? await options.directory.findUnitByExecutorInvite(executorInvite)
        : routeHint ? await options.directory.findUnitByExecutorRouteHint(routeHint) : undefined
      if (!unitId) { deny(401, 'executor_route_unauthorized'); return }
      const replicas = await options.runtimeOriginResolver.listReplicas(unitId)
      if (replicas === undefined) { deny(404, 'parallel_replicas_unavailable'); return }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ replicas }))
      return
    }
    if (url.pathname === '/runtime/route-ticket') {
      const deny = (status: number, error: string, retryAfter?: number) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
        })
        response.end(JSON.stringify({ error }))
      }
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); deny(405, 'method_not_allowed'); return }
      if (!options.runtimeRoutingTicketResolver) { deny(404, 'route_ticket_unavailable'); return }
      if (!session || !organizationAccess || request.headers.authorization) { deny(401, 'authentication_required'); return }
      if (organizationAccess.organization.status !== 'active'
        || !permits(organizationAccess.membership.role, 'runtime:write')) { deny(403, 'forbidden'); return }
      if (request.headers.origin !== requestPublicOrigin(request)) { deny(403, 'same_origin_required'); return }
      if (!enforceRateLimit(response, options.rateLimiter,
        `${organizationAccess.organization.id}:${identity!.issuer}:${identity!.subject}:route-ticket`)) return
      if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json'
        || Number(request.headers['content-length'] ?? 0) > 4_096) { deny(400, 'invalid_request'); return }
      let sessionId: string
      try {
        const body = JSON.parse((await readRequestBody(request, 4_096)).toString('utf8')) as unknown
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || !('sessionId' in body)
          || typeof body.sessionId !== 'string') throw new Error('invalid body')
        sessionId = body.sessionId
      } catch { deny(400, 'invalid_request'); return }
      try {
        const result = await options.runtimeRoutingTicketResolver.issueSessionTicketResultForOrganization(sessionId, {
          principalId: Buffer.from(`${identity!.issuer}\0${identity!.subject}`, 'utf8').toString('base64url'),
          organizationId: organizationAccess.organization.id,
          unitId: organizationAccess.organization.unitId,
        })
        if (result.status !== 'live') {
          if (result.status === 'deleting') deny(410, 'session_deleting')
          else if (result.status === 'missing') deny(404, 'session_missing')
          else deny(503, 'session_relocating', 1)
          return
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        response.end(JSON.stringify({ ticket: result.ticket }))
      } catch { deny(503, 'session_route_unavailable', 1) }
      return
    }
    if (url.pathname === '/api/v1/openapi.json') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD')
        apiGatewayError(response, 405, 'invalid_request', 'method not allowed')
        return
      }
      const requestId = randomBytes(16).toString('hex')
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
        'x-kala-api-version': 'v1',
        'x-kala-api-compatibility': '1',
      })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(enterpriseManagementOpenApi))
      return
    }
    const serviceAccountItem = url.pathname.match(/^\/api\/v1\/service-accounts\/([^/]+)$/u)
    const serviceAccountManagementRequest = url.pathname === '/api/v1/service-accounts' || serviceAccountItem !== null
    if (serviceAccountManagementRequest) {
      const bearer = typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
      if (bearer || !session || !organizationAccess || !options.serviceAccounts) {
        apiGatewayError(response, 401, 'authentication_required', 'browser administrator authentication is required')
        return
      }
      if (!permits(organizationAccess.membership.role, 'organization:manage')) {
        apiGatewayError(response, 403, 'forbidden', 'organization:manage permission is required')
        return
      }
      if (request.method === 'GET' && !serviceAccountItem) {
        try {
          const items = await options.serviceAccounts.list(organizationAccess.organization.id)
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': randomBytes(16).toString('hex'), 'x-kala-api-version': 'v1', 'x-kala-api-compatibility': '1' })
          response.end(JSON.stringify({ items }))
        } catch {
          apiGatewayError(response, 500, 'internal_error', 'service accounts could not be listed')
        }
        return
      }
      if (request.method === 'POST' && !serviceAccountItem) {
        if (request.headers.origin !== requestPublicOrigin(request)) {
          apiGatewayError(response, 403, 'forbidden', 'same-origin browser request is required')
          return
        }
        try {
          const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { name?: unknown; scopes?: unknown; expiresAt?: unknown }
          if (typeof raw.name !== 'string' || !Array.isArray(raw.scopes) || (raw.expiresAt !== undefined && typeof raw.expiresAt !== 'string')) {
            apiGatewayError(response, 400, 'invalid_request', 'name, scopes, and expiration are invalid')
            return
          }
          const created = await options.serviceAccounts.create({
            organizationId: organizationAccess.organization.id,
            name: raw.name,
            scopes: raw.scopes as ServiceAccountScope[],
            ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
          })
          response.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': randomBytes(16).toString('hex'), 'x-kala-api-version': 'v1', 'x-kala-api-compatibility': '1' })
          response.end(JSON.stringify(created))
        } catch (error) {
          if (error instanceof ServiceAccountInputError || error instanceof SyntaxError) apiGatewayError(response, 400, 'invalid_request', 'invalid service account')
          else apiGatewayError(response, 500, 'internal_error', 'service account could not be created')
        }
        return
      }
      if (request.method === 'DELETE' && serviceAccountItem) {
        if (request.headers.origin !== requestPublicOrigin(request)) {
          apiGatewayError(response, 403, 'forbidden', 'same-origin browser request is required')
          return
        }
        try {
          const revoked = await options.serviceAccounts.revoke(organizationAccess.organization.id, serviceAccountItem[1]!)
          if (!revoked) {
            apiGatewayError(response, 404, 'not_found', 'service account was not found')
            return
          }
          response.writeHead(204, { 'cache-control': 'no-store' })
          response.end()
        } catch {
          apiGatewayError(response, 500, 'internal_error', 'service account could not be revoked')
        }
        return
      }
      response.setHeader('allow', serviceAccountItem ? 'DELETE' : 'GET, POST')
      apiGatewayError(response, 405, 'invalid_request', 'method not allowed')
      return
    }
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      const authorization = request.headers.authorization
      const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : undefined
      const serviceAccount = bearer && options.serviceAccounts
        ? await options.serviceAccounts.authenticate(bearer)
        : undefined
      if (bearer && !serviceAccount) {
        apiGatewayError(response, 401, 'authentication_required', 'service account token is invalid or expired')
        return
      }
      if (!serviceAccount && (!session || !organizationAccess)) {
        apiGatewayError(response, 401, 'authentication_required', 'valid browser or service account authentication is required')
        return
      }
      const write = !['GET', 'HEAD'].includes(request.method ?? '')
      if (serviceAccount) {
        const requiredScope: ServiceAccountScope = write ? 'workspace:write' : 'workspace:read'
        if (!serviceAccount.scopes.includes(requiredScope)) {
          apiGatewayError(response, 403, 'forbidden', `${requiredScope} scope is required`)
          return
        }
        if (serviceAccount.organizationStatus !== 'active') {
          apiGatewayError(response, 403, 'forbidden', 'organization is not active')
          return
        }
      } else if (write && organizationAccess?.membership.role === 'viewer') {
        apiGatewayError(response, 403, 'forbidden', 'runtime:write permission is required')
        return
      }
      if (!serviceAccount && write && request.headers.origin !== requestPublicOrigin(request)) {
        apiGatewayError(response, 403, 'forbidden', 'same-origin browser request is required')
        return
      }
      const unitId = serviceAccount?.unitId ?? organizationAccess!.organization.unitId
      const organizationId = serviceAccount?.organizationId ?? organizationAccess!.organization.id
      const principal = serviceAccount?.principalId
        ?? Buffer.from(`${identity!.issuer}\0${identity!.subject}`, 'utf8').toString('base64url')
      if (!enforceRateLimit(response, options.rateLimiter, `${organizationId}:${principal}:api`, true)) return
      delete request.headers.cookie
      delete request.headers.authorization
      delete request.headers['x-agent-runlab-runtime-unit']
      delete request.headers['x-agent-runlab-ingress-secret']
      delete request.headers['x-agent-runlab-organization-id']
      delete request.headers['x-agent-runlab-organization-role']
      delete request.headers['x-agent-runlab-principal']
      request.headers['x-agent-runlab-runtime-unit'] = unitId
      request.headers['x-agent-runlab-ingress-secret'] = options.ingressSecret
      request.headers['x-agent-runlab-organization-id'] = organizationId
      request.headers['x-agent-runlab-organization-role'] = serviceAccount
        ? (write ? 'member' : 'viewer')
        : organizationAccess!.membership.role
      request.headers['x-agent-runlab-principal'] = principal
      const runtimeOrigin = await resolveRuntimeOrigin(unitId)
      proxy.web(request, response, { target: runtimeOrigin }, () => {
        if (!response.headersSent) apiGatewayError(response, 502, 'internal_error', 'Runtime API is unavailable')
      })
      return
    }
    if (url.pathname.startsWith('/auth/executor-pairings') && (/\/claim$/u.test(url.pathname) || (url.pathname === '/auth/executor-pairings' && request.method === 'POST'))) {
      // A caller without an organization assignment cannot safely choose a Runtime
      // Unit. Private Cloud enrollment uses a short-lived, organization-bound invite.
      response.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'executor_invite_required', message: 'Create an Executor invite in the authenticated workspace and reconnect with --invite.' }))
      return
    }
    if (url.pathname === '/organization' && request.method === 'GET' && organizationAccess && options.organizations) {
      const members = await options.organizations.listMembers(organizationAccess.organization.id)
      const [administration, invites] = await Promise.all([
        options.organizations.administrationSnapshot?.(organizationAccess.organization.id),
        options.organizations.listInvites?.(organizationAccess.organization.id) ?? Promise.resolve([]),
      ])
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({
        organization: { id: organizationAccess.organization.id, name: organizationAccess.organization.name }, role: organizationAccess.membership.role,
        permissions: ['runtime:read', 'runtime:write', 'workspace:manage', 'organization:manage', 'policy:manage'].filter((permission) => permits(organizationAccess.membership.role, permission as Parameters<typeof permits>[1])),
        members: members.map((member) => ({ issuer: member.identity.issuer, subject: member.identity.subject, displayName: member.identity.displayName, email: member.identity.email, role: member.role, createdAt: member.createdAt })),
        ...(administration ?? {}),
        invites,
      })); return
    }
    if (url.pathname === '/organization/retention' && request.method === 'PUT' && organizationAccess && options.organizations?.updateRetentionPolicy) {
      if (!requireSameOriginWhenPresent(request, response)) return
      if (!permits(organizationAccess.membership.role, 'policy:manage')) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }
      try {
        await options.organizations!.updateRetentionPolicy!(organizationAccess.organization.id, raw)
      } catch (reason) {
        if (reason instanceof Error && reason.message.startsWith('unsupported_retention_fields:')) {
          const unsupportedFields = reason.message.slice('unsupported_retention_fields:'.length).split(',')
          response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ error: 'unsupported_retention_fields', unsupportedFields, message: 'Only sessionDays is enforced; artifact, audit, backup, and deleted-resource retention require an approved compliance policy.' }))
          return
        }
        throw reason
      }
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return
    }
    if (url.pathname === '/organization/invites' && request.method === 'POST' && organizationAccess && options.organizations) {
      if (!requireSameOriginWhenPresent(request, response)) return
      if (!permits(organizationAccess.membership.role, 'organization:manage')) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'organization:manage' })); return }
      if (!options.organizations.createInvite) { response.writeHead(501, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'organization_invites_not_supported' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { email?: string; role?: 'admin' | 'member' | 'viewer'; expiresInDays?: number }
      const expiresInDays = raw.expiresInDays ?? 7
      if (!raw.email || !raw.role || !['admin', 'member', 'viewer'].includes(raw.role) || !Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
        response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'invalid_invite' })); return
      }
      try {
        const created = await options.organizations.createInvite(organizationAccess.organization.id, identity!, raw.email, raw.role, new Date(Date.now() + expiresInDays * 86_400_000).toISOString())
        const inviteUrl = new URL('/auth/login', requestPublicOrigin(request)); inviteUrl.searchParams.set('invite', created.token)
        response.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ invite: created.invite, inviteUrl: inviteUrl.href })); return
      } catch (reason) {
        if (reason instanceof Error && ['invalid_invite_email', 'invalid_invite_expiration'].includes(reason.message)) {
          response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: reason.message })); return
        }
        throw reason
      }
    }
    const inviteMatch = /^\/organization\/invites\/(oinv_[A-Za-z0-9_-]+)$/u.exec(url.pathname)
    if (inviteMatch && request.method === 'DELETE' && organizationAccess && options.organizations) {
      if (!requireSameOriginWhenPresent(request, response)) return
      if (!permits(organizationAccess.membership.role, 'organization:manage')) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'organization:manage' })); return }
      if (!options.organizations.revokeInvite) { response.writeHead(501, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'organization_invites_not_supported' })); return }
      try { await options.organizations.revokeInvite(organizationAccess.organization.id, inviteMatch[1]!) } catch (reason) {
        if (reason instanceof Error && reason.message === 'invite_not_found') { response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'invite_not_found' })); return }
        throw reason
      }
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return
    }
    if (url.pathname === '/organization/members' && request.method === 'POST' && organizationAccess) {
      response.writeHead(405, { allow: 'PATCH, DELETE', 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'member_invite_required' })); return
    }
    if (url.pathname === '/organization/members' && ['PATCH', 'DELETE'].includes(request.method ?? '') && organizationAccess && options.organizations) {
      if (!requireSameOriginWhenPresent(request, response)) return
      if (!permits(organizationAccess.membership.role, 'organization:manage')) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'organization:manage' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { issuer?: string; subject?: string; displayName?: string; email?: string; role?: 'admin' | 'member' | 'viewer' }
      if (!raw.issuer || !raw.subject || (request.method !== 'DELETE' && !raw.role)) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'invalid_member' })); return }
      const target = { issuer: raw.issuer, subject: raw.subject, ...(raw.displayName ? { displayName: raw.displayName } : {}), ...(raw.email ? { email: raw.email } : {}) }
      if (request.method === 'PATCH') await options.organizations.updateMemberRole(organizationAccess.organization.id, target, raw.role!)
      else await options.organizations.removeMember(organizationAccess.organization.id, target)
      closeSocketsForIdentity(target)
      // Authorization changes take effect immediately on every device. Existing
      // cookies cannot retain the removed or previous role until expiry.
      await options.sessions.revokeAllForIdentity(target, 'administrator', Date.now())
      response.writeHead(204, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(); return
    }
    if (url.pathname === '/organization/ownership' && request.method === 'POST' && organizationAccess && options.organizations) {
      if (!requireSameOriginWhenPresent(request, response)) return
      if (organizationAccess.membership.role !== 'owner') { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'owner_required' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { issuer?: string; subject?: string }
      if (!raw.issuer || !raw.subject) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'invalid_member' })); return }
      const nextOwner = { issuer: raw.issuer, subject: raw.subject }
      await options.organizations.transferOwnership(organizationAccess.organization.id, identity!, nextOwner)
      closeSocketsForIdentity(identity!)
      closeSocketsForIdentity(nextOwner)
      await Promise.all([
        options.sessions.revokeAllForIdentity(identity!, 'administrator', Date.now()),
        options.sessions.revokeAllForIdentity(nextOwner, 'administrator', Date.now()),
      ])
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return
    }
    if ((url.pathname === '/memo' || url.pathname === '/user/session-tabs') && ['GET', 'HEAD', 'PUT'].includes(request.method ?? '') && session && organizationAccess) {
      if (!enforceRateLimit(response, options.rateLimiter, `${organizationAccess.organization.id}:${session.identity.issuer}:${session.identity.subject}`)) return
      request.headers['x-agent-runlab-principal'] = Buffer.from(`${session.identity.issuer}\0${session.identity.subject}`, 'utf8').toString('base64url')
      request.headers['x-agent-runlab-organization-id'] = organizationAccess.organization.id
      const runtimeOrigin = await resolveRuntimeOrigin(organizationAccess.organization.unitId)
      proxy.web(request, response, { target: runtimeOrigin }, () => { if (!response.headersSent) response.writeHead(502); response.end() })
      return
    }
    if (session && organizationAccess && !enforceRateLimit(response, options.rateLimiter, `${organizationAccess.organization.id}:${session.identity.issuer}:${session.identity.subject}`)) return
    const assignment = organizationAccess ? { unitId: organizationAccess.organization.unitId, identity: identity! } : identity ? await options.directory.findByIdentity(identity) : undefined
    if (!identity || !assignment || identity.issuer !== assignment.identity.issuer || identity.subject !== assignment.identity.subject) {
      if (isDocumentNavigation(request)) response.writeHead(303, { location: '/auth/login', 'cache-control': 'no-store' })
      else { response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'authentication_required' })); return }
      response.end(); return
    }
    if (options.runtimeOriginResolver && url.pathname.startsWith('/socket.io/') && url.searchParams.get('transport') === 'polling') {
      // Engine.IO's sid is assigned in the upstream response, so this stateless
      // Gateway cannot prove that later polling requests remain on the same Pod.
      // Never fall back to another origin: require a direct WebSocket transport.
      response.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'runtime_origin_stickiness_required', message: 'Engine.IO polling is unavailable with Unit runtime routing; use WebSocket transport.' }))
      return
    }
    if (dashboardProxy && options.dashboardOrigin && isDashboardRequest(request, url.pathname)) {
      delete request.headers.cookie
      delete request.headers.authorization
      dashboardProxy.web(request, response, { target: options.dashboardOrigin }, () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end('dashboard upstream unavailable')
      })
      return
    }
    const requiredRuntimePermission = request.method === 'GET' || request.method === 'HEAD' ? 'runtime:read' : 'runtime:write'
    if (organizationAccess && !permits(organizationAccess.membership.role, requiredRuntimePermission)) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'forbidden', requiredPermission: requiredRuntimePermission })); return
    }
    delete request.headers.cookie
    delete request.headers.authorization
    delete request.headers['x-agent-runlab-runtime-unit']
    delete request.headers['x-agent-runlab-ingress-secret']
    delete request.headers['x-agent-runlab-organization-id']
    delete request.headers['x-agent-runlab-organization-role']
    delete request.headers['x-agent-runlab-principal']
    request.headers['x-agent-runlab-runtime-unit'] = assignment.unitId
    request.headers['x-agent-runlab-ingress-secret'] = options.ingressSecret
    if (organizationAccess) {
      request.headers['x-agent-runlab-organization-id'] = organizationAccess.organization.id
      request.headers['x-agent-runlab-organization-role'] = organizationAccess.membership.role
      request.headers['x-agent-runlab-principal'] = Buffer.from(`${identity.issuer}\0${identity.subject}`, 'utf8').toString('base64url')
    }
    const runtimeOrigin = await resolveRuntimeOrigin(assignment.unitId)
    if (url.pathname.startsWith('/auth/executor-pairings')) {
      const decision = /^\/auth\/executor-pairings\/[^/]+\/(approve|reject)$/u.test(url.pathname)
      if (decision && (!organizationAccess || !permits(organizationAccess.membership.role, 'workspace:manage'))) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'workspace:manage' })); return }
      const body = request.method === 'POST' ? await readRequestBody(request) : undefined
      const upstream = await requestRuntime(runtimeOrigin, url.pathname, request.method, { 'content-type': request.headers['content-type'] ?? 'application/json', ...(organizationAccess ? { 'x-agent-runlab-runtime-unit': assignment.unitId, 'x-agent-runlab-ingress-secret': options.ingressSecret } : {}) }, body, options.runtimeTls)
      response.writeHead(upstream.status, { 'content-type': upstream.contentType, 'cache-control': 'no-store' });response.end(upstream.body);return
    }
    if (url.pathname === '/auth/executor-invites' && request.method === 'POST') {
      if (!requireSameOriginWhenPresent(request, response)) return
      if (organizationAccess && !permits(organizationAccess.membership.role, 'workspace:manage')) { response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'workspace:manage' })); return }
      const body = await readRequestBody(request)
      const upstream = await requestRuntime(runtimeOrigin, url.pathname, 'POST', {
          'content-type': request.headers['content-type'] ?? 'application/json',
          'x-agent-runlab-runtime-unit': assignment.unitId,
          'x-agent-runlab-ingress-secret': options.ingressSecret,
          ...(organizationAccess ? {
            'x-agent-runlab-organization-id': organizationAccess.organization.id,
            'x-agent-runlab-organization-role': organizationAccess.membership.role,
            'x-agent-runlab-principal': Buffer.from(`${identity!.issuer}\0${identity!.subject}`, 'utf8').toString('base64url'),
          } : {}),
        }, body, options.runtimeTls)
      const text = upstream.body.toString('utf8')
      if (upstream.status >= 200 && upstream.status < 300) {
        const invite = JSON.parse(text) as { inviteToken?: string }
        if (invite.inviteToken) await options.directory.bindExecutorInvite(invite.inviteToken, assignment.unitId)
      }
      response.writeHead(upstream.status, { 'content-type': upstream.contentType, 'cache-control': 'no-store' })
      response.end(text)
      return
    }

    proxy.web(request, response, { target: runtimeOrigin }, () => { if (!response.headersSent) response.writeHead(502); response.end() })
  }
  const http = createServer((request, response) => {
    const access = validatePublicRequest(publicUrls!, request.headers.host, typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
    if (!access.ok) {
      response.writeHead(access.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: access.error }))
      return
    }
    request.headers['x-kala-public-origin'] = access.origin
    void handler(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ event: 'runtime_ingress_request_failed', method: request.method, path: request.url?.split('?')[0], error: message })}\n`)
    const organizationMissing = message === 'organization_not_provisioned'
    const runtimeOriginUnavailable = error instanceof RuntimeOriginUnavailableError
    if (!response.headersSent) response.writeHead(organizationMissing ? 403 : runtimeOriginUnavailable ? 503 : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(organizationMissing
      ? { error: 'organization_not_provisioned', message: 'Your identity is valid, but this account has not been enabled for an Kala organization.' }
      : runtimeOriginUnavailable ? { error: 'runtime_origin_unavailable' }
      : { error: 'internal_server_error' }))
    })
  })
  http.on('upgrade', (request, socket, head) => { void (async () => {
    const access = validatePublicRequest(publicUrls!, request.headers.host, typeof request.headers.origin === 'string' ? request.headers.origin : undefined)
    if (!access.ok) {
      socket.end(`HTTP/1.1 ${access.status} ${access.status === 400 ? 'Bad Request' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    request.headers['x-kala-public-origin'] = access.origin
    const requestUrl = new URL(request.url ?? '/', access.origin)
    const runtimeRouteTickets = requestUrl.searchParams.getAll('runtimeRouteTicket')
    const session = await authenticate(request)
    const identity = session?.identity
    const organizationAccess = identity && options.organizations ? await options.organizations.findAccess(identity) : undefined
    if (organizationAccess && organizationAccess.organization.status !== 'active') { socket.destroy(); return }
    const assignment = organizationAccess ? { unitId: organizationAccess.organization.unitId, identity: identity! } : identity ? await options.directory.findByIdentity(identity) : undefined
    const executorInvite = typeof request.headers['x-kala-executor-invite'] === 'string' ? request.headers['x-kala-executor-invite'] : undefined
    const routeHint = typeof request.headers['x-kala-executor-route'] === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(request.headers['x-kala-executor-route']) ? request.headers['x-kala-executor-route'] : undefined
    const executorReplica = typeof request.headers['x-kala-executor-replica'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.headers['x-kala-executor-replica']) ? request.headers['x-kala-executor-replica'] : undefined
    const inviteUnitId = !assignment && executorInvite ? await options.directory.findUnitByExecutorInvite(executorInvite) : undefined
    const routeUnitId = !assignment && !inviteUnitId && routeHint ? await options.directory.findUnitByExecutorRouteHint(routeHint) : undefined
    const executorEnrollment = !assignment && (inviteUnitId !== undefined || routeUnitId !== undefined)
    const unitId = assignment?.unitId ?? inviteUnitId ?? routeUnitId
    // Dashboard Socket.IO is a bidirectional command channel, not a read-only
    // stream. Viewer/read-only memberships must not reach mutating client events.
    // Executor enrollment uses a separate invite-authenticated path.
    const requiredPermission = executorEnrollment ? undefined : 'runtime:write'
    if (!unitId || (organizationAccess && requiredPermission && !permits(organizationAccess.membership.role, requiredPermission)) || (assignment && (!identity || identity.issuer !== assignment.identity.issuer || identity.subject !== assignment.identity.subject))) { socket.destroy(); return }
    let runtimeOrigin: string
    let routeSessionId: string | undefined
    if (runtimeRouteTickets.length > 0) {
      // Explicit resource routing is browser-only and never falls back to a Unit
      // origin. The organization and Unit come from current cookie authority, not
      // from ticket claims or Socket.IO auth payloads that arrive after upgrade.
      if (runtimeRouteTickets.length !== 1 || !options.runtimeRoutingTicketResolver || !session || !organizationAccess
        || !assignment || request.headers['x-kala-executor-invite'] !== undefined || request.headers['x-kala-executor-route'] !== undefined || executorEnrollment
        || !permits(organizationAccess.membership.role, 'runtime:write')) { socket.destroy(); return }
      let resolved: { origin: string; sessionId: string } | undefined
      try {
        const principalId = Buffer.from(`${identity!.issuer}\0${identity!.subject}`, 'utf8').toString('base64url')
        resolved = await options.runtimeRoutingTicketResolver.resolveSessionBindingForOrganization(runtimeRouteTickets[0], {
          principalId,
          organizationId: organizationAccess.organization.id,
          unitId: organizationAccess.organization.unitId,
        })
      } catch { socket.destroy(); return }
      if (!resolved) { socket.destroy(); return }
      try {
        const parsed = new URL(resolved.origin)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin')
        runtimeOrigin = parsed.origin
        routeSessionId = resolved.sessionId
      } catch { socket.destroy(); return }
      requestUrl.searchParams.delete('runtimeRouteTicket')
      request.url = `${requestUrl.pathname}${requestUrl.search}`
    } else if (executorReplica) {
      // Replica ids are opaque selectors. The route capability fixes the Unit,
      // and current PostgreSQL membership must resolve the exact member; stale
      // ids never fall back to the Unit's least-loaded control origin.
      if (!executorEnrollment || !options.runtimeOriginResolver?.resolveReplica) { socket.destroy(); return }
      const resolved = await options.runtimeOriginResolver.resolveReplica(unitId, executorReplica)
      if (!resolved) { socket.destroy(); return }
      runtimeOrigin = resolved
    } else {
      runtimeOrigin = await resolveRuntimeOrigin(unitId)
    }
    delete request.headers.cookie
    delete request.headers.authorization
    delete request.headers['x-agent-runlab-runtime-unit']
    delete request.headers['x-agent-runlab-ingress-secret']
    delete request.headers['x-agent-runlab-organization-id']
    delete request.headers['x-agent-runlab-organization-role']
    delete request.headers['x-agent-runlab-principal']
    delete request.headers['x-agent-runlab-route-session-id']
    if (routeSessionId) request.headers['x-agent-runlab-route-session-id'] = routeSessionId
    delete request.headers['x-kala-executor-route']
    delete request.headers['x-kala-executor-replica']
    if (!executorEnrollment) delete request.headers['x-kala-executor-invite']
    request.headers['x-agent-runlab-runtime-unit'] = unitId
    request.headers['x-agent-runlab-ingress-secret'] = options.ingressSecret
    if (organizationAccess && !executorEnrollment) {
      request.headers['x-agent-runlab-organization-id'] = organizationAccess.organization.id
      request.headers['x-agent-runlab-organization-role'] = organizationAccess.membership.role
      request.headers['x-agent-runlab-principal'] = Buffer.from(`${identity!.issuer}\0${identity!.subject}`, 'utf8').toString('base64url')
    }
    if (session && organizationAccess && !executorEnrollment) monitorBrowserSocket(socket, session, organizationAccess)
    else if (executorEnrollment) monitorExecutorSocket(socket, executorInvite ? inviteKey(executorInvite) : routeHint!, unitId)
    proxy.ws(request, socket, head, { target: runtimeOrigin }, () => socket.destroy())
  })().catch(() => socket.destroy()) })
  await new Promise<void>((resolve) => http.listen(options.port, options.listenHost ?? '127.0.0.1', resolve))
  const address = http.address(); const port = typeof address === 'object' && address ? address.port : options.port
  publicUrls ??= parsePublicUrls(publicUrl.port === '0' ? `http://127.0.0.1:${port}` : options.publicOrigin)
  return { http, port, async close() {
    closeSockets(() => true)
    for (const socket of executorSockets.keys()) closeExecutorSocket(socket)
    proxy.close(); dashboardProxy?.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  } }
}

export async function requestRuntime(
  origin: string,
  path: string,
  method: string | undefined,
  headers: Record<string, string>,
  body: Buffer | undefined,
  tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer; servername?: string } | undefined,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  if (!tls) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    })
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/json',
      body: Buffer.from(await response.arrayBuffer()),
    }
  }
  const url = new URL(path, origin)
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method,
      headers,
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      servername: tls.servername ?? url.hostname,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode ?? 502,
        contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : 'application/json',
        body: Buffer.concat(chunks),
      }))
    })
    request.once('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

function apiGatewayError(response: ServerResponse, status: number, code: string, message: string): void {
  const requestId = randomBytes(16).toString('hex')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
    'x-kala-api-version': 'v1',
    'x-kala-api-compatibility': '1',
  })
  response.end(JSON.stringify({ error: { code, message, requestId } }))
}
