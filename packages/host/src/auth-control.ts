import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HandshakeAuth } from '@agent-kernel/shared'
import { ExecutorIdentityStore, type ExecutorIdentityStorage } from './store/executor-identity.js'

export type GithubOAuthConfig = {
  required: boolean
  clientId?: string
  clientSecret?: string
  callbackUrl?: string
  usernameWhitelist?: readonly string[]
  sessionSecret?: string
}

export type ExecutorTokenScope = {
  token: string
  workspaceId?: string
  label?: string
}

export type AuthConfig = {
  sharedToken?: string
  github?: GithubOAuthConfig
  executorTokens?: readonly ExecutorTokenScope[]
  executorIdentityStore?: ExecutorIdentityStorage
}

export type DashboardActor =
  | { kind: 'anonymous' }
  | { kind: 'token' }
  | { kind: 'github_user'; login: string; id?: number }
  | { kind: 'ingress'; principal: string; organizationId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }

export type ExecutorIdentity = {
  accepted: boolean
  label?: string
  workspaceId?: string
  installId?: string
  inviteToken?: string
  token?: string
  reason?: string
}

export type GithubSession = {
  login: string
  id?: number
}

const COOKIE_NAME = 'ak_session'
const OAUTH_STATE_COOKIE = 'ak_oauth_state'

export function dashboardAuthRequired(config: AuthConfig | undefined): boolean {
  return Boolean(config?.github?.required || config?.sharedToken)
}

export function authenticateDashboardHandshake(
  auth: HandshakeAuth | undefined,
  req: IncomingMessage,
  config: AuthConfig | undefined,
): { ok: true; actor: DashboardActor } | { ok: false; reason: string } {
  const principal = header(req, 'x-agent-runlab-principal')
  const organizationId = header(req, 'x-agent-runlab-organization-id')
  const role = header(req, 'x-agent-runlab-organization-role')
  if (principal && organizationId && isOrganizationRole(role)) return { ok: true, actor: { kind: 'ingress', principal, organizationId, role } }
  if (!config?.github?.required && !config?.sharedToken) return { ok: true, actor: { kind: 'anonymous' } }
  if (config.github?.required) {
    const session = readGithubSession(req, config.github)
    if (!session) return { ok: false, reason: 'auth_failed' }
    if (!githubUserAllowed(session.login, config.github)) return { ok: false, reason: 'auth_failed' }
    return { ok: true, actor: { kind: 'github_user', login: session.login, ...(session.id !== undefined ? { id: session.id } : {}) } }
  }
  if (config.sharedToken && auth?.token === config.sharedToken) return { ok: true, actor: { kind: 'token' } }
  return { ok: false, reason: 'auth_failed' }
}

export async function authenticateExecutorToken(
  auth: HandshakeAuth | undefined,
  config: AuthConfig | undefined,
): Promise<ExecutorIdentity> {
  const token = auth?.token
  // After initial enrollment the Executor retains its route hint, but its
  // durable device credential must take precedence over an expired invite.
  const stored = await config?.executorIdentityStore?.resolveToken(token)
  if (stored) return { accepted: true, workspaceId: stored.workspaceId, ...(stored.installId ? { installId: stored.installId } : {}), ...(stored.label ? { label: stored.label } : {}), ...(token ? { token } : {}) }
  if (auth?.invite) return { accepted: true, inviteToken: auth.invite }
  const scoped = config?.executorTokens ?? []
  if (scoped.length > 0) {
    const match = scoped.find((entry) => token !== undefined && safeEqual(entry.token, token))
    if (!match) return { accepted: false, reason: 'auth_failed' }
    return { accepted: true, ...(match.label ? { label: match.label } : {}), ...(match.workspaceId ? { workspaceId: match.workspaceId } : {}), ...(token ? { token } : {}) }
  }
  if (config?.executorIdentityStore) return { accepted: false, reason: 'auth_failed' }
  if (config?.sharedToken && token !== config.sharedToken) return { accepted: false, reason: 'auth_failed' }
  return { accepted: true }
}

export function validateExecutorAnnouncement(
  identity: ExecutorIdentity,
  announcedWorkspaceId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!identity.accepted) return { ok: false, reason: identity.reason ?? 'auth_failed' }
  if (identity.workspaceId && identity.workspaceId !== announcedWorkspaceId) {
    return { ok: false, reason: 'workspace_identity_mismatch' }
  }
  return { ok: true }
}

export function readGithubSession(req: IncomingMessage, config: GithubOAuthConfig): GithubSession | null {
  const raw = readCookie(req, COOKIE_NAME)
  if (!raw || !config.sessionSecret) return null
  const [body, sig] = raw.split('.')
  if (!body || !sig) return null
  const expected = sign(body, config.sessionSecret)
  if (!safeEqual(expected, sig)) return null
  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as GithubSession & { exp?: number }
    if (typeof decoded.login !== 'string' || decoded.login.length === 0) return null
    if (typeof decoded.exp === 'number' && decoded.exp < Date.now()) return null
    return { login: decoded.login, ...(typeof decoded.id === 'number' ? { id: decoded.id } : {}) }
  } catch {
    return null
  }
}

export function setGithubSessionCookie(res: ServerResponse, config: GithubOAuthConfig, session: GithubSession): void {
  if (!config.sessionSecret) throw new Error('KALA_AUTH_SESSION_SECRET is required')
  const body = Buffer.from(JSON.stringify({ ...session, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }), 'utf8').toString('base64url')
  const value = `${body}.${sign(body, config.sessionSecret)}`
  appendSetCookie(res, `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`)
}

export function clearGithubSessionCookie(res: ServerResponse): void {
  appendSetCookie(res, `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export function buildGithubStart(config: GithubOAuthConfig, res: ServerResponse): string {
  if (!config.clientId || !config.callbackUrl || !config.sessionSecret) throw new Error('github oauth is not configured')
  const state = randomBytes(18).toString('base64url')
  appendSetCookie(res, `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`)
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.callbackUrl)
  url.searchParams.set('scope', 'read:user')
  url.searchParams.set('state', state)
  return url.toString()
}

export async function finishGithubOAuth(
  req: IncomingMessage,
  config: GithubOAuthConfig,
): Promise<{ ok: true; session: GithubSession } | { ok: false; reason: string }> {
  if (!config.clientId || !config.clientSecret || !config.callbackUrl) return { ok: false, reason: 'github oauth is not configured' }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state || readCookie(req, OAUTH_STATE_COOKIE) !== state) return { ok: false, reason: 'invalid oauth state' }
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.callbackUrl }),
  })
  const tokenBody = await tokenResponse.json() as { access_token?: string; error_description?: string }
  if (!tokenResponse.ok || !tokenBody.access_token) return { ok: false, reason: tokenBody.error_description ?? 'github token exchange failed' }
  const userResponse = await fetch('https://api.github.com/user', {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${tokenBody.access_token}`, 'user-agent': 'kala-host' },
  })
  const user = await userResponse.json() as { login?: string; id?: number; message?: string }
  if (!userResponse.ok || !user.login) return { ok: false, reason: user.message ?? 'github user lookup failed' }
  if (!githubUserAllowed(user.login, config)) return { ok: false, reason: 'github user is not allowed' }
  return { ok: true, session: { login: user.login, ...(typeof user.id === 'number' ? { id: user.id } : {}) } }
}

export function githubUserAllowed(login: string, config: GithubOAuthConfig): boolean {
  const list = config.usernameWhitelist ?? []
  return list.length === 0 || list.includes(login)
}

export function authSettings(config: AuthConfig | undefined): {
  dashboardAuthRequired: boolean
  githubOAuth: { required: boolean; configured: boolean; usernameWhitelistEnabled: boolean; usernameWhitelist: readonly string[] }
  executorIdentity: { tokenScoped: boolean; tokenCount: number; inviteCount: number }
} {
  const github = config?.github
  const whitelist = github?.usernameWhitelist ?? []
  const tokens = config?.executorTokens ?? []
  // Settings construction is a synchronous compatibility API. Remote stores
  // are reported as configured without issuing unawaited queries; authoritative
  // management routes query their state asynchronously.
  const localStore = config?.executorIdentityStore instanceof ExecutorIdentityStore ? config.executorIdentityStore : undefined
  const persisted = localStore?.snapshot() ?? []
  const invites = localStore?.inviteSnapshot() ?? []
  return {
    dashboardAuthRequired: dashboardAuthRequired(config),
    githubOAuth: {
      required: github?.required === true,
      configured: Boolean(github?.clientId && github?.clientSecret && github?.callbackUrl && github?.sessionSecret),
      usernameWhitelistEnabled: whitelist.length > 0,
      usernameWhitelist: whitelist,
    },
    executorIdentity: {
      tokenScoped: tokens.some((t) => t.workspaceId !== undefined) || persisted.length > 0 || Boolean(config?.executorIdentityStore),
      tokenCount: tokens.length + persisted.length,
      inviteCount: invites.filter((invite) => !invite.revoked).length,
    },
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isOrganizationRole(value: string | undefined): value is 'owner' | 'admin' | 'member' | 'viewer' {
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer'
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return undefined
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const prev = res.getHeader('set-cookie')
  if (Array.isArray(prev)) res.setHeader('set-cookie', [...prev, value])
  else if (typeof prev === 'string') res.setHeader('set-cookie', [prev, value])
  else res.setHeader('set-cookie', value)
}
