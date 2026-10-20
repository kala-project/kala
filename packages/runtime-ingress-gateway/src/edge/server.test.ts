import { createServer, request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueRuntimeRoutingTicket } from '@agent-kernel/shared'

import { inviteKey, MemoryRuntimeAssignmentStore, type AuthenticatedIdentity } from '../assignments/store.js'
import type { LoginState, LoginStateStore } from '../auth/login-state-store.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway, type RuntimeOriginResolver } from './server.js'
import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import { MemoryEnterpriseSsoResolver } from '../auth/enterprise-sso.js'
import { MemoryOrganizationStore, type OrganizationStore, type OrganizationStatus } from '../organizations/store.js'
import { SlidingWindowRateLimiter } from '../governance/rate-limit.js'
import { RuntimeRoutingTicketResolver } from '../runtime-origin/runtime-routing-ticket-resolver.js'
import { ServiceAccountService, type ServiceAccountScope } from '../api/service-accounts.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class MemoryLoginStates implements LoginStateStore {
  private readonly values = new Map<string, LoginState>()
  async put(nonce: string, state: LoginState): Promise<void> { this.values.set(nonce, state) }
  async take(nonce: string): Promise<LoginState | undefined> { const value = this.values.get(nonce); this.values.delete(nonce); return value }
}

class TestOrganizationStore extends MemoryOrganizationStore {
  readonly retentionUpdates: Array<{ organizationId: string; sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }> = []

  setStatus(organizationId: string, status: OrganizationStatus): void {
    const organization = this.organizations.get(organizationId)
    if (!organization) throw new Error('organization not found')
    this.organizations.set(organizationId, { ...organization, status })
  }

  async updateRetentionPolicy(organizationId: string, policy: { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }): Promise<void> {
    this.retentionUpdates.push({ organizationId, ...policy })
  }
}

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())) })

describe('Private Cloud edge request path', () => {
  it('serves the versioned OpenAPI contract and envelopes method errors', async () => {
    const gateway = await createGateway('http://127.0.0.1:9')
    const openApi = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/openapi.json`)
    expect(openApi.status).toBe(200)
    expect(openApi.headers.get('x-request-id')).toEqual(expect.any(String))
    await expect(openApi.json()).resolves.toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/api/v1/service-accounts': expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }),
        '/api/v1/service-accounts/{id}': expect.objectContaining({ delete: expect.any(Object) }),
      },
    })

    const invalid = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/openapi.json`, { method: 'POST' })
    expect(invalid.status).toBe(405)
    expect(invalid.headers.get('allow')).toBe('GET, HEAD')
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'invalid_request', requestId: expect.any(String) },
    })
  })

  it('requires a tenant-bound invite instead of forwarding anonymous pairing to an arbitrary Runtime Unit', async () => {
    const gateway = await createGateway('http://127.0.0.1:9')
    for (const path of ['/auth/executor-pairings', '/auth/executor-pairings/example/claim']) {
      const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: 'executor_invite_required', message: expect.stringContaining('--invite') })
    }
  })

  it('serves immutable installer assets through the public Unit without granting a tenant route', async () => {
    const requests: Array<{ url?: string; unit?: string; secret?: string }> = []
    const upstream = createServer((request, response) => {
      requests.push({ url: request.url, unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined, secret: request.headers['x-agent-runlab-ingress-secret'] as string | undefined })
      response.writeHead(200, { 'content-type': 'text/x-shellscript' })
      response.end('#!/bin/sh\n')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const upstreamPort = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const gateway = await createGateway(`http://127.0.0.1:${upstreamPort}`)

    const asset = await fetch(`http://127.0.0.1:${gateway.port}/install/assets/run.sh`, { headers: { 'x-agent-runlab-runtime-unit': 'tenant_forged', 'x-agent-runlab-ingress-secret': 'forged' } })
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('#!/bin/sh\n')
    expect(requests).toEqual([{ url: '/install/assets/run.sh', unit: 'public-installer', secret: 'gateway-secret' }])
    const inviteScript = await fetch(`http://127.0.0.1:${gateway.port}/install/invite.ps1`)
    expect(inviteScript.status).toBe(200)
    const inviteHead = await fetch(`http://127.0.0.1:${gateway.port}/install/invite.ps1`, { method: 'HEAD' })
    expect(inviteHead.status).toBe(200)
    expect(requests.map((request) => request.url)).toEqual(['/install/assets/run.sh', '/install/invite.ps1', '/install/invite.ps1'])
    expect(requests.every((request) => request.unit === 'public-installer' && request.secret === 'gateway-secret')).toBe(true)
    const inviteWrite = await fetch(`http://127.0.0.1:${gateway.port}/install/invite.ps1`, { method: 'POST' })
    expect(inviteWrite.status).toBe(405)
    expect(inviteWrite.headers.get('allow')).toBe('GET, HEAD')
    expect((await fetch(`http://127.0.0.1:${gateway.port}/install/invite.ps1?invite=forbidden`)).status).toBe(400)
    const assetWrite = await fetch(`http://127.0.0.1:${gateway.port}/install/assets/run.sh`, { method: 'POST' })
    expect(assetWrite.status).toBe(401)
    const session = await fetch(`http://127.0.0.1:${gateway.port}/install/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(session.status).toBe(401)
    expect(requests).toHaveLength(3)
  })

  it('binds administrator-created Executor invites to one organization and rejects anonymous, member, and cross-origin creation', async () => {
    const upstreamRequests: Array<{ unit?: string; organization?: string; role?: string; principal?: string }> = []
    const upstream = createServer((request, response) => {
      upstreamRequests.push({ unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined, organization: request.headers['x-agent-runlab-organization-id'] as string | undefined, role: request.headers['x-agent-runlab-organization-role'] as string | undefined, principal: request.headers['x-agent-runlab-principal'] as string | undefined })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'inv_org_a', inviteToken: 'ak_invite_org_a' }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const upstreamPort = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })

    const organizations = new TestOrganizationStore()
    const access = await organizations.getOrCreateForIdentity({ issuer: 'http://identity.example', subject: 'alice' })
    await organizations.addMember(access.organization.id, { issuer: 'http://identity.example', subject: 'bob' }, 'member')
    const directory = new MemoryRuntimeAssignmentStore()
    const ownerGateway = await createGateway(`http://127.0.0.1:${upstreamPort}`, undefined, { organizations, directory })
    const ownerLogin = await fetch(`http://127.0.0.1:${ownerGateway.port}/auth/login`, { redirect: 'manual' })
    const ownerNonce = cookieValue(ownerLogin.headers.getSetCookie(), 'ak_login')
    const ownerCallback = await fetch(`http://127.0.0.1:${ownerGateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${ownerNonce}` }, redirect: 'manual' })
    const ownerSession = cookieValue(ownerCallback.headers.getSetCookie(), 'ak_session')
    const ownerOrigin = `http://127.0.0.1:${ownerGateway.port}`

    const anonymous = await fetch(`${ownerOrigin}/auth/executor-invites`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ownerOrigin }, body: '{}' })
    expect(anonymous.status).toBe(401)
    const crossOrigin = await fetch(`${ownerOrigin}/auth/executor-invites`, { method: 'POST', headers: { cookie: `ak_session=${ownerSession}`, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    expect(crossOrigin.status).toBe(403)
    const created = await fetch(`${ownerOrigin}/auth/executor-invites`, { method: 'POST', headers: { cookie: `ak_session=${ownerSession}`, 'content-type': 'application/json', origin: ownerOrigin }, body: '{}' })
    expect(created.status).toBe(200)
    expect(await directory.findUnitByExecutorInvite('ak_invite_org_a')).toBe(access.organization.unitId)
    expect(upstreamRequests).toEqual([{ unit: access.organization.unitId, organization: access.organization.id, role: 'owner', principal: Buffer.from('http://identity.example\0alice').toString('base64url') }])

    const memberGateway = await createGateway(`http://127.0.0.1:${upstreamPort}`, undefined, { organizations, directory, callbackIdentity: () => ({ issuer: 'http://identity.example', subject: 'bob' }) })
    const memberLogin = await fetch(`http://127.0.0.1:${memberGateway.port}/auth/login`, { redirect: 'manual' })
    const memberNonce = cookieValue(memberLogin.headers.getSetCookie(), 'ak_login')
    const memberCallback = await fetch(`http://127.0.0.1:${memberGateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${memberNonce}` }, redirect: 'manual' })
    const memberSession = cookieValue(memberCallback.headers.getSetCookie(), 'ak_session')
    const memberOrigin = `http://127.0.0.1:${memberGateway.port}`
    const member = await fetch(`${memberOrigin}/auth/executor-invites`, { method: 'POST', headers: { cookie: `ak_session=${memberSession}`, 'content-type': 'application/json', origin: memberOrigin }, body: '{}' })
    expect(member.status).toBe(403)
    await expect(member.json()).resolves.toMatchObject({ error: 'forbidden', requiredPermission: 'workspace:manage' })
    expect(upstreamRequests).toHaveLength(1)
  })

  it('creates copyable organization invites and accepts only the matching verified OIDC identity once', async () => {
    const organizations = new TestOrganizationStore()
    let callbackIdentity: AuthenticatedIdentity = { issuer: 'http://identity.example', subject: 'alice', displayName: 'Alice' }
    const gateway = await createGateway('http://127.0.0.1:9', undefined, { organizations, callbackIdentity: () => callbackIdentity })
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const ownerLogin = await fetch(`${endpoint}/auth/login`, { redirect: 'manual' })
    const ownerNonce = cookieValue(ownerLogin.headers.getSetCookie(), 'ak_login')
    const ownerCallback = await fetch(`${endpoint}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${ownerNonce}` }, redirect: 'manual' })
    const ownerSession = cookieValue(ownerCallback.headers.getSetCookie(), 'ak_session')
    const adminHeaders = { cookie: `ak_session=${ownerSession}`, origin: endpoint, 'x-kala-public-origin': endpoint, 'content-type': 'application/json' }

    const legacy = await fetch(`${endpoint}/organization/members`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ issuer: 'guessed', subject: 'guessed', role: 'member' }) })
    expect(legacy.status).toBe(405)
    const createdResponse = await fetch(`${endpoint}/organization/invites`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: 'Invitee@Example.Test', role: 'admin', expiresInDays: 7 }) })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { invite: { id: string; email: string }; inviteUrl: string }
    expect(created.invite.email).toBe('invitee@example.test')
    expect(created.inviteUrl).toMatch(new RegExp(`^${endpoint.replaceAll('.', '\\.')}/auth/login\\?invite=ak_org_invite_`))

    const listed = await fetch(`${endpoint}/organization`, { headers: { cookie: `ak_session=${ownerSession}` } })
    const listedText = await listed.text()
    expect(listedText).toContain(created.invite.id)
    expect(listedText).not.toContain(new URL(created.inviteUrl).searchParams.get('invite')!)

    callbackIdentity = { issuer: 'http://identity.example', subject: 'real-invitee-sub', email: 'invitee@example.test', emailVerified: true }
    const inviteLogin = await fetch(created.inviteUrl, { redirect: 'manual' })
    const inviteNonce = cookieValue(inviteLogin.headers.getSetCookie(), 'ak_login')
    const accepted = await fetch(`${endpoint}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${inviteNonce}` }, redirect: 'manual' })
    expect(accepted.status).toBe(302)
    expect(accepted.headers.get('location')).toBe('/auth/invite-result?status=accepted')
    await expect(organizations.findAccess(callbackIdentity)).resolves.toMatchObject({ membership: { role: 'admin' } })

    const replayLogin = await fetch(created.inviteUrl, { redirect: 'manual' })
    const replayNonce = cookieValue(replayLogin.headers.getSetCookie(), 'ak_login')
    const replay = await fetch(`${endpoint}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${replayNonce}` }, redirect: 'manual' })
    expect(replay.status).toBe(403)
    expect(await replay.text()).toContain('invalid, expired, revoked, or already used')
  })

  it('fails invitation acceptance when the IdP does not attest the email and supports tenant-bound revocation', async () => {
    const organizations = new TestOrganizationStore()
    let callbackIdentity: AuthenticatedIdentity = { issuer: 'http://identity.example', subject: 'alice' }
    const gateway = await createGateway('http://127.0.0.1:9', undefined, { organizations, callbackIdentity: () => callbackIdentity })
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const login = await fetch(`${endpoint}/auth/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${cookieValue(login.headers.getSetCookie(), 'ak_login')}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const headers = { cookie: `ak_session=${session}`, origin: endpoint, 'x-kala-public-origin': endpoint, 'content-type': 'application/json' }
    const createdResponse = await fetch(`${endpoint}/organization/invites`, { method: 'POST', headers, body: JSON.stringify({ email: 'invitee@example.test', role: 'member' }) })
    const created = await createdResponse.json() as { invite: { id: string }; inviteUrl: string }

    callbackIdentity = { issuer: 'http://identity.example', subject: 'invitee', email: 'invitee@example.test' }
    const inviteLogin = await fetch(created.inviteUrl, { redirect: 'manual' })
    const denied = await fetch(`${endpoint}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${cookieValue(inviteLogin.headers.getSetCookie(), 'ak_login')}` }, redirect: 'manual' })
    expect(denied.status).toBe(403)
    expect(await denied.text()).toContain('did not attest that your email is verified')

    const revoked = await fetch(`${endpoint}/organization/invites/${created.invite.id}`, { method: 'DELETE', headers })
    expect(revoked.status).toBe(204)
    callbackIdentity = { ...callbackIdentity, emailVerified: true }
    const revokedLogin = await fetch(created.inviteUrl, { redirect: 'manual' })
    const revokedCallback = await fetch(`${endpoint}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${cookieValue(revokedLogin.headers.getSetCookie(), 'ak_login')}` }, redirect: 'manual' })
    expect(revokedCallback.status).toBe(403)
  })

  it('authenticates scoped service accounts and injects one Runtime Unit authority', async () => {
    const upstreamRequests: Array<{ authorization?: string; unit?: string; organization?: string; principal?: string }> = []
    const upstream = createServer((request, response) => {
      upstreamRequests.push({
        authorization: request.headers.authorization,
        unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined,
        organization: request.headers['x-agent-runlab-organization-id'] as string | undefined,
        principal: request.headers['x-agent-runlab-principal'] as string | undefined,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: [] }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const port = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const serviceAccounts = new ServiceAccountService(new ServiceAccountAuthDatabase())
    const gateway = await createGateway(`http://127.0.0.1:${port}`, undefined, { serviceAccounts })

    const listed = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, {
      headers: { authorization: 'Bearer ak_sa_test' },
    })
    expect(listed.status).toBe(200)
    expect(upstreamRequests).toEqual([{
      authorization: undefined,
      unit: 'tenant_api',
      organization: 'org_api',
      principal: 'prn_api',
    }])

    const denied = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer ak_sa_test', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'forbidden', requestId: expect.any(String) } })
    expect(upstreamRequests).toHaveLength(1)
  })

  it('manages finite Service Account lifecycles within the browser administrator organization', async () => {
    const organizations = new TestOrganizationStore()
    const database = new LifecycleServiceAccountDatabase()
    const serviceAccounts = new ServiceAccountService(database)
    const other = await serviceAccounts.create({ organizationId: 'org_other', name: 'other automation', scopes: ['workspace:read'] })
    const gateway = await createGateway('http://127.0.0.1:9', undefined, { organizations, serviceAccounts })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const access = await organizations.findAccess({ issuer: 'http://identity.example', subject: 'alice' })
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const browserHeaders = { cookie: `ak_session=${session}`, origin: endpoint, 'content-type': 'application/json' }

    const invalidExpiration = await fetch(`${endpoint}/api/v1/service-accounts`, {
      method: 'POST', headers: browserHeaders, body: JSON.stringify({ name: 'invalid', scopes: ['workspace:read'], expiresAt: 123 }),
    })
    expect(invalidExpiration.status).toBe(400)

    const createdResponse = await fetch(`${endpoint}/api/v1/service-accounts`, {
      method: 'POST', headers: browserHeaders, body: JSON.stringify({ name: 'deploy automation', scopes: ['workspace:read'] }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string; token: string; name: string; scopes: string[]; createdAt: string; expiresAt: string; revokedAt: null }
    expect(created).toMatchObject({
      id: expect.stringMatching(/^prn_/u),
      token: expect.stringMatching(/^ak_sa_/u),
      name: 'deploy automation',
      scopes: ['workspace:read'],
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      revokedAt: null,
    })
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.parse(created.createdAt))

    const bearerManagement = await fetch(`${endpoint}/api/v1/service-accounts`, {
      headers: { cookie: `ak_session=${session}`, authorization: `Bearer ${created.token}` },
    })
    expect(bearerManagement.status).toBe(401)

    const listed = await fetch(`${endpoint}/api/v1/service-accounts`, { headers: { cookie: `ak_session=${session}` } })
    expect(listed.status).toBe(200)
    const listedBody = await listed.json() as { items: Array<Record<string, unknown>> }
    expect(listedBody.items).toEqual([{
      id: created.id,
      name: 'deploy automation',
      scopes: ['workspace:read'],
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      revokedAt: null,
    }])
    expect(JSON.stringify(listedBody)).not.toContain(created.token)
    expect(JSON.stringify(listedBody)).not.toMatch(/tokenHash|token_hash/iu)
    expect(database.lastListedOrganizationId).toBe(access!.organization.id)

    const crossTenant = await fetch(`${endpoint}/api/v1/service-accounts/${other.id}`, { method: 'DELETE', headers: browserHeaders })
    expect(crossTenant.status).toBe(404)
    await expect(serviceAccounts.authenticate(other.token)).resolves.toBeDefined()

    const crossOrigin = await fetch(`${endpoint}/api/v1/service-accounts/${created.id}`, {
      method: 'DELETE', headers: { cookie: `ak_session=${session}`, origin: 'https://evil.example' },
    })
    expect(crossOrigin.status).toBe(403)
    await expect(serviceAccounts.authenticate(created.token)).resolves.toBeDefined()

    const revoked = await fetch(`${endpoint}/api/v1/service-accounts/${created.id}`, { method: 'DELETE', headers: browserHeaders })
    expect(revoked.status).toBe(204)
    const denied = await fetch(`${endpoint}/api/v1/sessions`, { headers: { authorization: `Bearer ${created.token}` } })
    expect(denied.status).toBe(401)
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'authentication_required' } })

    database.failure = new Error('postgres connection secret')
    const failedList = await fetch(`${endpoint}/api/v1/service-accounts`, { headers: { cookie: `ak_session=${session}` } })
    expect(failedList.status).toBe(500)
    expect(await failedList.text()).not.toContain('postgres connection secret')
  })

  it('returns the versioned error envelope for Product API rate limits', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: [] }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const port = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const gateway = await createGateway(`http://127.0.0.1:${port}`, undefined, {
      serviceAccounts: new ServiceAccountService(new ServiceAccountAuthDatabase()),
      rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 1 }),
    })
    const headers = { authorization: `Bearer ${['ak', 'sa', 'test-token'].join('_')}` }

    expect(await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, { headers }).then((response) => response.status)).toBe(200)
    const limited = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, { headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('x-kala-api-version')).toBe('v1')
    expect(limited.headers.get('x-kala-api-compatibility')).toBe('1')
    expect(limited.headers.get('x-request-id')).toEqual(expect.any(String))
    await expect(limited.json()).resolves.toMatchObject({
      error: {
        code: 'rate_limited',
        requestId: expect.any(String),
        details: { retryAfterMs: expect.any(Number) },
      },
    })
  })

  it('proxies installer and release assets without browser authentication', async () => {
    const seen: string[] = []
    const upstream = createServer((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200, { 'content-type': request.url === '/install.ps1' ? 'text/plain' : 'application/javascript' })
      response.end(request.url === '/install.ps1' ? "$ErrorActionPreference='Stop'" : '#!/usr/bin/env node')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address(); const port = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const gateway = await createGateway(`http://127.0.0.1:${port}`)
    const installer = await fetch(`http://127.0.0.1:${gateway.port}/install.ps1`)
    expect(installer.status).toBe(200)
    expect(await installer.text()).toContain('ErrorActionPreference')
    const asset = await fetch(`http://127.0.0.1:${gateway.port}/release-assets/kala-executor.cjs`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('/usr/bin/env node')
    expect(seen).toEqual(['/install.ps1', '/release-assets/kala-executor.cjs'])
  })

  it('binds login to one Unit, strips browser authority, and exposes account profile', async () => {
    const upstreamRequests: Array<{ headers: Record<string, string | string[] | undefined>; url?: string }> = []
    const upstream = createServer((request, response) => {
      upstreamRequests.push({ headers: request.headers, url: request.url })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamAddress = upstream.address()
    const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })

    const provision = vi.fn().mockResolvedValue(undefined)
    const gateway = await createGateway(`http://127.0.0.1:${upstreamPort}`, provision)
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const loginCookie = cookieValue(login.headers.getSetCookie(), 'ak_login')
    expect(login.status).toBe(302)

    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, {
      headers: { cookie: `ak_login=${loginCookie}` }, redirect: 'manual',
    })
    const sessionCookie = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    expect(callback.status).toBe(302)
    expect(provision).toHaveBeenCalledOnce()

    const me = await fetch(`http://127.0.0.1:${gateway.port}/auth/me`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(await me.json()).toMatchObject({ authenticated: true, profile: { displayName: 'Alice Example', email: 'alice@example.test' } })
    const sessions = await fetch(`http://127.0.0.1:${gateway.port}/auth/sessions`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(await sessions.json()).toMatchObject({ sessions: [expect.objectContaining({ current: true, device: expect.any(Object) })] })

    const proxied = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, {
      headers: {
        cookie: `ak_session=${sessionCookie}; attacker=1`,
        authorization: 'Bearer browser-token',
        'x-agent-runlab-runtime-unit': 'tenant_forged',
        'x-agent-runlab-ingress-secret': 'forged',
      },
    })
    expect(proxied.status).toBe(200)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.headers.cookie).toBeUndefined()
    expect(upstreamRequests[0]?.headers.authorization).toBeUndefined()
    expect(upstreamRequests[0]?.headers['x-agent-runlab-runtime-unit']).toMatch(/^tenant_[a-f0-9]{26}$/u)
    expect(upstreamRequests[0]?.headers['x-agent-runlab-ingress-secret']).toBe('gateway-secret')
    // Authority headers are generated by Gateway, never accepted from the browser.
    expect(upstreamRequests[0]?.headers['x-agent-runlab-principal']).toBeUndefined()

    const logout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, { method: 'POST', headers: { cookie: `ak_session=${sessionCookie}`, origin: `http://127.0.0.1:${gateway.port}` } })
    expect(logout.status).toBe(204)
    const afterLogout = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(afterLogout.status).toBe(401)

    const replay = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=replay`, { headers: { cookie: `ak_login=${loginCookie}` } })
    expect(replay.status).toBe(400)
  })

  it('overwrites forged WebSocket actor headers, rejects read-only upgrades, and strips actor headers from executor enrollment', async () => {
    const upgrades: Array<Record<string, string | string[] | undefined>> = []
    const upstream = createServer()
    upstream.on('upgrade', (request, socket) => {
      upgrades.push(request.headers)
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const upstreamPort = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })

    const organizations = new TestOrganizationStore()
    const owner = await organizations.getOrCreateForIdentity({ issuer: 'http://identity.example', subject: 'owner' })
    const alice = { issuer: 'http://identity.example', subject: 'alice' }
    await organizations.addMember(owner.organization.id, alice, 'member')
    const directory = new MemoryRuntimeAssignmentStore()
    await directory.bindExecutorInvite('executor-invite', 'tenant_executor')
    const gateway = await createGateway(`http://127.0.0.1:${upstreamPort}`, undefined, { organizations, directory })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const forgedActor = {
      'x-agent-runlab-organization-id': 'org_attacker',
      'x-agent-runlab-organization-role': 'owner',
      'x-agent-runlab-principal': 'principal_attacker',
    }

    await openWebSocket(gateway.port, { cookie: `ak_session=${session}`, 'x-kala-executor-invite': 'executor-invite', ...forgedActor })
    expect(upgrades[0]).toMatchObject({
      'x-agent-runlab-runtime-unit': owner.organization.unitId,
      'x-agent-runlab-ingress-secret': 'gateway-secret',
      'x-agent-runlab-organization-id': owner.organization.id,
      'x-agent-runlab-organization-role': 'member',
      'x-agent-runlab-principal': Buffer.from('http://identity.example\0alice', 'utf8').toString('base64url'),
    })
    expect(upgrades[0]?.cookie).toBeUndefined()
    expect(upgrades[0]?.authorization).toBeUndefined()
    expect(upgrades[0]?.['x-kala-executor-invite']).toBeUndefined()

    await organizations.updateMemberRole(owner.organization.id, alice, 'viewer')
    await expect(openWebSocket(gateway.port, { cookie: `ak_session=${session}`, 'x-kala-executor-invite': 'executor-invite', ...forgedActor })).rejects.toThrow()
    expect(upgrades).toHaveLength(1)

    await openWebSocket(gateway.port, { 'x-kala-executor-invite': 'executor-invite', ...forgedActor })
    expect(upgrades[1]).toMatchObject({
      'x-agent-runlab-runtime-unit': 'tenant_executor',
      'x-agent-runlab-ingress-secret': 'gateway-secret',
    })
    expect(upgrades[1]?.['x-agent-runlab-organization-id']).toBeUndefined()
    expect(upgrades[1]?.['x-agent-runlab-organization-role']).toBeUndefined()
    expect(upgrades[1]?.['x-agent-runlab-principal']).toBeUndefined()

    await openWebSocket(gateway.port, { 'x-kala-executor-route': inviteKey('executor-invite'), ...forgedActor })
    expect(upgrades[2]).toMatchObject({ 'x-agent-runlab-runtime-unit': 'tenant_executor', 'x-agent-runlab-ingress-secret': 'gateway-secret' })
    expect(upgrades[2]?.['x-kala-executor-route']).toBeUndefined()
    expect(upgrades[2]?.['x-agent-runlab-organization-id']).toBeUndefined()
    await expect(openWebSocket(gateway.port, { 'x-kala-executor-route': inviteKey('unbound-invite') })).rejects.toThrow()
    expect(upgrades).toHaveLength(3)
  })

  it('discovers opaque active replicas and routes an Executor to the exact current member', async () => {
    const upgrades: Array<{ pod: string; replicaHeader?: string }> = []
    const startRuntime = async (pod: string) => {
      const runtime = createServer()
      runtime.on('upgrade', (request, socket) => {
        upgrades.push({ pod, replicaHeader: request.headers['x-kala-executor-replica'] as string | undefined })
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      })
      await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
      running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
      const address = runtime.address()
      return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    }
    const [originX, originY] = await Promise.all([startRuntime('x'), startRuntime('y')])
    const directory = new MemoryRuntimeAssignmentStore()
    await directory.bindExecutorInvite('executor-invite', 'tenant_executor')
    const runtimeOriginResolver: RuntimeOriginResolver = {
      async resolve() { return originX },
      async listReplicas(unitId) { return unitId === 'tenant_executor' ? ['runtime-x', 'runtime-y'] : undefined },
      async resolveReplica(unitId, replicaId) {
        if (unitId !== 'tenant_executor') return undefined
        return replicaId === 'runtime-x' ? originX : replicaId === 'runtime-y' ? originY : undefined
      },
    }
    const gateway = await createGateway('http://127.0.0.1:9', undefined, { directory, runtimeOriginResolver })
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const route = inviteKey('executor-invite')

    const membership = await fetch(`${endpoint}/.well-known/kala/executor-replicas`, { headers: { 'x-kala-executor-route': route } })
    expect(membership.status).toBe(200)
    await expect(membership.json()).resolves.toEqual({ replicas: ['runtime-x', 'runtime-y'] })
    const unauthorized = await fetch(`${endpoint}/.well-known/kala/executor-replicas`)
    expect(unauthorized.status).toBe(401)

    await openWebSocket(gateway.port, { 'x-kala-executor-route': route, 'x-kala-executor-replica': 'runtime-y' })
    expect(upgrades).toEqual([{ pod: 'y', replicaHeader: undefined }])
    await expect(openWebSocket(gateway.port, { 'x-kala-executor-route': route, 'x-kala-executor-replica': 'stale-runtime' })).rejects.toThrow()
    expect(upgrades).toHaveLength(1)
  })

  it('routes browser HTTP and browser or Executor upgrades by trusted Unit and fails closed without a route', async () => {
    const httpRequests: Array<{ pod: string; path?: string; unit?: string }> = []
    const upgrades: Array<{ pod: string; unit?: string }> = []
    const startRuntime = async (pod: string) => {
      const runtime = createServer((request, response) => {
        httpRequests.push({ pod, path: request.url, unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(request.url === '/auth/executor-invites' ? JSON.stringify({ inviteToken: 'issued-executor-invite' }) : JSON.stringify({ pod }))
      })
      runtime.on('upgrade', (request, socket) => {
        upgrades.push({ pod, unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined })
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      })
      await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
      running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
      const address = runtime.address()
      return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    }
    const [browserOrigin, executorOrigin] = await Promise.all([startRuntime('browser'), startRuntime('executor')])

    const organizations = new TestOrganizationStore()
    const access = await organizations.getOrCreateForIdentity({ issuer: 'http://identity.example', subject: 'alice' })
    const directory = new MemoryRuntimeAssignmentStore()
    await directory.bindExecutorInvite('executor-invite', 'tenant_executor')
    const origins = new Map([[access.organization.unitId, browserOrigin], ['tenant_executor', executorOrigin]])
    const resolvedUnits: string[] = []
    const runtimeOriginResolver: RuntimeOriginResolver = {
      async resolve(unitId) { resolvedUnits.push(unitId); return origins.get(unitId) },
    }
    const gateway = await createGateway('http://127.0.0.1:9', undefined, { organizations, directory, runtimeOriginResolver })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, {
      headers: { cookie: `ak_login=${cookieValue(login.headers.getSetCookie(), 'ak_login')}` }, redirect: 'manual',
    })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const endpoint = `http://127.0.0.1:${gateway.port}`

    const browserHttp = await fetch(`${endpoint}/runtime/capabilities`, { headers: { cookie: `ak_session=${session}`, 'x-agent-runlab-runtime-unit': 'tenant_executor' } })
    expect(await browserHttp.json()).toEqual({ pod: 'browser' })
    const internalApi = await fetch(`${endpoint}/auth/executor-invites`, {
      method: 'POST', headers: { cookie: `ak_session=${session}`, origin: endpoint, 'content-type': 'application/json' }, body: '{}',
    })
    expect(internalApi.status).toBe(200)
    await openWebSocket(gateway.port, { cookie: `ak_session=${session}` })
    await openWebSocket(gateway.port, { 'x-kala-executor-invite': 'executor-invite' })

    expect(httpRequests).toEqual([
      { pod: 'browser', path: '/runtime/capabilities', unit: access.organization.unitId },
      { pod: 'browser', path: '/auth/executor-invites', unit: access.organization.unitId },
    ])
    expect(upgrades).toEqual([
      { pod: 'browser', unit: access.organization.unitId },
      { pod: 'executor', unit: 'tenant_executor' },
    ])
    expect(resolvedUnits).toContain(access.organization.unitId)
    expect(resolvedUnits).toContain('tenant_executor')

    const polling = await fetch(`${endpoint}/socket.io/?EIO=4&transport=polling`, { headers: { cookie: `ak_session=${session}` } })
    expect(polling.status).toBe(409)
    await expect(polling.json()).resolves.toMatchObject({ error: 'runtime_origin_stickiness_required' })
    expect(httpRequests).toHaveLength(2)

    const unavailable = await createGateway(browserOrigin, undefined, {
      organizations,
      directory,
      runtimeOriginResolver: { async resolve() { return undefined } },
    })
    const unavailableLogin = await fetch(`http://127.0.0.1:${unavailable.port}/auth/login`, { redirect: 'manual' })
    const unavailableCallback = await fetch(`http://127.0.0.1:${unavailable.port}/auth/callback?code=ok`, {
      headers: { cookie: `ak_login=${cookieValue(unavailableLogin.headers.getSetCookie(), 'ak_login')}` }, redirect: 'manual',
    })
    const unavailableSession = cookieValue(unavailableCallback.headers.getSetCookie(), 'ak_session')
    const denied = await fetch(`http://127.0.0.1:${unavailable.port}/runtime/capabilities`, {
      headers: { cookie: `ak_session=${unavailableSession}`, 'x-agent-runlab-runtime-unit': 'tenant_executor', 'x-kala-runtime-origin': executorOrigin },
    })
    expect(denied.status).toBe(503)
    await expect(denied.json()).resolves.toEqual({ error: 'runtime_origin_unavailable' })
    expect(httpRequests).toHaveLength(2)
  })

  it('routes only authorized single WS tickets to live Session owners and never falls back to the Unit origin', async () => {
    const upgrades: Array<{ target: string; path: string; unit?: string; cookie?: string; routedSession?: string }> = []
    const startRuntime = async (target: string) => {
      const runtime = createServer()
      runtime.on('upgrade', (request, socket) => {
        upgrades.push({
          target,
          path: request.url ?? '',
          unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined,
          cookie: request.headers.cookie,
          routedSession: request.headers['x-agent-runlab-route-session-id'] as string | undefined,
        })
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      })
      await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
      running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
      const address = runtime.address()
      return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    }
    const [unitOrigin, sessionAOrigin, sessionBOrigin] = await Promise.all([
      startRuntime('unit'), startRuntime('session-a'), startRuntime('session-b'),
    ])

    const organizations = new TestOrganizationStore()
    const owner = await organizations.getOrCreateForIdentity({ issuer: 'http://identity.example', subject: 'owner' })
    const alice = { issuer: 'http://identity.example', subject: 'alice' }
    await organizations.addMember(owner.organization.id, alice, 'member')
    const directory = new MemoryRuntimeAssignmentStore()
    await directory.bindExecutorInvite('executor-invite', 'tenant_executor')
    const key = new Uint8Array(32).fill(9)
    const nowMs = 1_900_000_000_000
    const owners = new Map([
      ['session_a', { origin: sessionAOrigin, replicaId: 'replica_a', generation: 3n }],
      ['session_b', { origin: sessionBOrigin, replicaId: 'replica_b', generation: 7n }],
    ])
    const resolveResourceOwnerBinding = vi.fn(async (input: { resourceId: string }) => owners.get(input.resourceId))
    const runtimeRoutingTicketResolver = new RuntimeRoutingTicketResolver({
      key,
      audience: 'gateway.internal',
      maxTtlMs: 10_000,
      ownerResolver: { resolveResourceOwnerBinding },
      now: () => nowMs + 1,
    })
    const runtimeOriginResolver: RuntimeOriginResolver = { async resolve() { return unitOrigin } }
    const gateway = await createGateway('http://127.0.0.1:9', undefined, {
      organizations, directory, runtimeOriginResolver, runtimeRoutingTicketResolver,
    })
    const loginSession = async (targetGateway: RuntimeIngressGateway): Promise<string> => {
      const login = await fetch(`http://127.0.0.1:${targetGateway.port}/auth/login`, { redirect: 'manual' })
      const callback = await fetch(`http://127.0.0.1:${targetGateway.port}/auth/callback?code=ok`, {
        headers: { cookie: `ak_login=${cookieValue(login.headers.getSetCookie(), 'ak_login')}` }, redirect: 'manual',
      })
      return cookieValue(callback.headers.getSetCookie(), 'ak_session')
    }
    const sessionCookie = await loginSession(gateway)
    const alicePrincipalId = Buffer.from(`${alice.issuer}\0${alice.subject}`, 'utf8').toString('base64url')
    const issueTicket = (resourceId: string, overrides: Partial<{
      principalId: string; organizationId: string; unitId: string; resourceKind: 'session' | 'task'
      ownerReplicaId: string; ownerGeneration: bigint; ttlMs: number; issuedAt: number
    }> = {}) => issueRuntimeRoutingTicket({
      audience: 'gateway.internal',
      principalId: overrides.principalId ?? alicePrincipalId,
      organizationId: overrides.organizationId ?? owner.organization.id,
      unitId: overrides.unitId ?? owner.organization.unitId,
      resourceKind: overrides.resourceKind ?? 'session',
      resourceId,
      ownerReplicaId: overrides.ownerReplicaId ?? (resourceId === 'session_b' ? 'replica_b' : 'replica_a'),
      ownerGeneration: overrides.ownerGeneration ?? (resourceId === 'session_b' ? 7n : 3n),
      ttlMs: overrides.ttlMs ?? 5_000,
    }, { key, maxTtlMs: 10_000, nowMs: overrides.issuedAt ?? nowMs })
    const ticketPath = (ticket: string) => `/socket.io/?EIO=4&transport=websocket&runtimeRouteTicket=${encodeURIComponent(ticket)}`
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const postTicket = (sessionId: string, headers: Record<string, string> = {}) => fetch(`${endpoint}/runtime/route-ticket`, {
      method: 'POST',
      headers: { cookie: `ak_session=${sessionCookie}`, origin: endpoint, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ sessionId }),
    })
    const issued = await postTicket('session_a')
    expect(issued.status).toBe(200)
    expect(issued.headers.get('cache-control')).toBe('no-store')
    const ticketA = (await issued.json() as { ticket: string }).ticket
    const ticketB = issueTicket('session_b')
    expect(resolveResourceOwnerBinding).toHaveBeenCalledWith({
      organizationId: owner.organization.id, unitId: owner.organization.unitId,
      resourceType: 'session', resourceId: 'session_a',
    })
    expect((await postTicket('missing')).status).toBe(404)
    expect((await postTicket('session_a', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await postTicket('session_a', { authorization: 'Bearer forged' })).status).toBe(401)
    expect((await fetch(`${endpoint}/runtime/route-ticket`, { method: 'POST', headers: { origin: endpoint, 'content-type': 'application/json' }, body: '{"sessionId":"session_a"}' })).status).toBe(401)
    expect((await fetch(`${endpoint}/runtime/route-ticket`, { method: 'GET', headers: { cookie: `ak_session=${sessionCookie}` } })).status).toBe(405)
    expect((await postTicket('../session_a')).status).toBe(404)
    expect((await fetch(`${endpoint}/runtime/route-ticket`, {
      method: 'POST', headers: { cookie: `ak_session=${sessionCookie}`, origin: endpoint, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session_a', organizationId: 'org_other', principalId: 'forged' }),
    })).status).toBe(400)
    resolveResourceOwnerBinding.mockRejectedValueOnce(new Error('postgres unavailable'))
    expect((await postTicket('session_a')).status).toBe(503)

    await openWebSocket(gateway.port, { cookie: `ak_session=${sessionCookie}` }, ticketPath(ticketA))
    await openWebSocket(gateway.port, { cookie: `ak_session=${sessionCookie}` }, ticketPath(ticketB))
    await openWebSocket(gateway.port, { cookie: `ak_session=${sessionCookie}`, 'x-agent-runlab-route-session-id': 'forged_session' })
    expect(upgrades).toEqual([
      { target: 'session-a', path: '/socket.io/?EIO=4&transport=websocket', unit: owner.organization.unitId, cookie: undefined, routedSession: 'session_a' },
      { target: 'session-b', path: '/socket.io/?EIO=4&transport=websocket', unit: owner.organization.unitId, cookie: undefined, routedSession: 'session_b' },
      { target: 'unit', path: '/socket.io/?EIO=4&transport=websocket', unit: owner.organization.unitId, cookie: undefined, routedSession: undefined },
    ])

    const expectDenied = async (ticket: string, headers: Record<string, string> = { cookie: `ak_session=${sessionCookie}` }, path = ticketPath(ticket)) => {
      await expect(openWebSocket(gateway.port, headers, path)).rejects.toThrow()
      expect(upgrades).toHaveLength(3)
    }
    await expectDenied(`${ticketA.slice(0, -1)}${ticketA.endsWith('a') ? 'b' : 'a'}`)
    await expectDenied(issueTicket('session_a', { ownerGeneration: 2n }))
    await expectDenied(issueTicket('session_a', { issuedAt: nowMs - 10_000 }))
    await expectDenied(issueTicket('session_a', { organizationId: 'org_other', unitId: 'unit_other' }))
    await expectDenied(issueTicket('session_a', { principalId: 'another_principal' }))
    await expectDenied(issueTicket('session_a', { resourceKind: 'task' }))
    await expectDenied(ticketA, { cookie: `ak_session=${sessionCookie}` }, `${ticketPath(ticketA)}&runtimeRouteTicket=${encodeURIComponent(ticketB)}`)
    await expectDenied(ticketA, {})
    await expectDenied(ticketA, { 'x-kala-executor-invite': 'executor-invite' })
    await expectDenied(ticketA, { 'x-kala-executor-route': inviteKey('executor-invite') })

    await organizations.updateMemberRole(owner.organization.id, alice, 'viewer')
    expect((await postTicket('session_a')).status).toBe(403)
    await expectDenied(ticketA)
    await organizations.updateMemberRole(owner.organization.id, alice, 'member')
    await organizations.removeMember(owner.organization.id, alice)
    expect((await postTicket('session_a')).status).toBe(401)
    await expectDenied(ticketA)
    await organizations.addMember(owner.organization.id, alice, 'member')

    const disabledGateway = await createGateway(unitOrigin, undefined, { organizations, directory, runtimeOriginResolver })
    const disabledCookie = await loginSession(disabledGateway)
    expect((await fetch(`http://127.0.0.1:${disabledGateway.port}/runtime/route-ticket`, {
      method: 'POST', headers: { cookie: `ak_session=${disabledCookie}`, origin: `http://127.0.0.1:${disabledGateway.port}`, 'content-type': 'application/json' },
      body: '{"sessionId":"session_a"}',
    })).status).toBe(404)
    await expect(openWebSocket(disabledGateway.port, { cookie: `ak_session=${disabledCookie}` }, ticketPath(ticketA))).rejects.toThrow()
    expect(upgrades).toHaveLength(3)
  })

  it('requires same-origin browser organization writes while preserving origin-less clients', async () => {
    const organizations = new TestOrganizationStore()
    const gateway = await createGateway('http://127.0.0.1:9', undefined, { organizations })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const access = await organizations.findAccess({ issuer: 'http://identity.example', subject: 'alice' })
    const bob = { issuer: 'http://identity.example', subject: 'bob' }
    await organizations.addMember(access!.organization.id, bob, 'admin')
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const crossOriginHeaders = { cookie: `ak_session=${session}`, origin: 'https://evil.example', 'content-type': 'application/json' }

    const crossOrigin = await Promise.all([
      fetch(`${endpoint}/organization/retention`, { method: 'PUT', headers: crossOriginHeaders, body: JSON.stringify({ sessionDays: 1, artifactDays: 2, auditDays: 3, deletedResourceGraceDays: 4 }) }),
      fetch(`${endpoint}/organization/invites`, { method: 'POST', headers: crossOriginHeaders, body: JSON.stringify({ email: 'intruder@example.test', role: 'admin' }) }),
      fetch(`${endpoint}/organization/ownership`, { method: 'POST', headers: crossOriginHeaders, body: JSON.stringify(bob) }),
    ])
    expect(crossOrigin.map((response) => response.status)).toEqual([403, 403, 403])
    expect(organizations.retentionUpdates).toHaveLength(0)
    expect(await organizations.findAccess({ issuer: 'http://identity.example', subject: 'intruder' })).toBeUndefined()
    expect((await organizations.findAccess({ issuer: 'http://identity.example', subject: 'alice' }))?.membership.role).toBe('owner')

    const sameOriginHeaders = { cookie: `ak_session=${session}`, origin: endpoint, 'content-type': 'application/json' }
    expect((await fetch(`${endpoint}/organization/retention`, { method: 'PUT', headers: sameOriginHeaders, body: JSON.stringify({ sessionDays: 10, artifactDays: 20, auditDays: 30, deletedResourceGraceDays: 40 }) })).status).toBe(204)
    expect((await fetch(`${endpoint}/organization/invites`, { method: 'POST', headers: sameOriginHeaders, body: JSON.stringify({ email: 'charlie@example.test', role: 'member' }) })).status).toBe(201)
    expect(organizations.retentionUpdates).toHaveLength(1)
    vi.spyOn(organizations, 'updateRetentionPolicy').mockRejectedValueOnce(new Error('unsupported_retention_fields:artifactDays,auditDays'))
    const unsupported = await fetch(`${endpoint}/organization/retention`, { method: 'PUT', headers: sameOriginHeaders, body: JSON.stringify({ sessionDays: 10, artifactDays: 7, auditDays: 30, deletedResourceGraceDays: 40 }) })
    expect(unsupported.status).toBe(400)
    await expect(unsupported.json()).resolves.toMatchObject({ error: 'unsupported_retention_fields', unsupportedFields: ['artifactDays', 'auditDays'] })

    await organizations.addMember(access!.organization.id, { issuer: 'http://identity.example', subject: 'charlie' }, 'member')
    const originLess = await fetch(`${endpoint}/organization/members`, {
      method: 'PATCH',
      headers: { cookie: `ak_session=${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: 'http://identity.example', subject: 'charlie', role: 'viewer' }),
    })
    expect(originLess.status).toBe(204)
    expect((await organizations.findAccess({ issuer: 'http://identity.example', subject: 'charlie' }))?.membership.role).toBe('viewer')

    expect((await fetch(`${endpoint}/organization/ownership`, { method: 'POST', headers: sameOriginHeaders, body: JSON.stringify(bob) })).status).toBe(204)
    expect((await organizations.findAccess(bob))?.membership.role).toBe('owner')
  })

  it('serves authenticated Dashboard assets from the independent Dashboard service while APIs stay on Runtime', async () => {
    const runtimePaths: string[] = []
    const runtime = createServer((request, response) => { runtimePaths.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"runtime":true}') })
    const dashboardPaths: string[] = []
    const dashboard = createServer((request, response) => { dashboardPaths.push(request.url ?? ''); response.writeHead(200, { 'content-type': request.url?.endsWith('.js') ? 'application/javascript' : 'text/html' }); response.end(request.url?.endsWith('.js') ? 'globalThis.dashboard=true' : '<title>independent dashboard</title>') })
    await Promise.all([
      new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve)),
    ])
    running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
    running.push({ close: () => new Promise<void>((resolve) => dashboard.close(() => resolve())) })
    const runtimeAddress = runtime.address(); const dashboardAddress = dashboard.address()
    const runtimePort = typeof runtimeAddress === 'object' && runtimeAddress ? runtimeAddress.port : 0
    const dashboardPort = typeof dashboardAddress === 'object' && dashboardAddress ? dashboardAddress.port : 0
    const gateway = await createGateway(`http://127.0.0.1:${runtimePort}`, undefined, { dashboardOrigin: `http://127.0.0.1:${dashboardPort}` })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const headers = { cookie: `ak_session=${session}` }
    const document = await fetch(`http://127.0.0.1:${gateway.port}/workspace`, { headers: { ...headers, accept: 'text/html' } })
    expect(await document.text()).toContain('independent dashboard')
    expect(await fetch(`http://127.0.0.1:${gateway.port}/assets/app.12345678.js`, { headers }).then((value) => value.text())).toContain('dashboard=true')
    expect(await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers }).then((value) => value.json())).toEqual({ runtime: true })
    expect(dashboardPaths).toEqual(['/workspace', '/assets/app.12345678.js'])
    expect(runtimePaths).toEqual(['/runtime/capabilities'])
  })

  it('denies runtime access for inactive organizations without proxying upstream', async () => {
    const runtimePaths: string[] = []
    const runtime = createServer((request, response) => {
      runtimePaths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"runtime":true}')
    })

    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
    const runtimeAddress = runtime.address()
    const runtimePort = typeof runtimeAddress === 'object' && runtimeAddress ? runtimeAddress.port : 0
    const organizations = new TestOrganizationStore()
    const gateway = await createGateway(`http://127.0.0.1:${runtimePort}`, undefined, { organizations })

    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const access = await organizations.findAccess({ issuer: 'http://identity.example', subject: 'alice' })
    organizations.setStatus(access!.organization.id, 'suspended')

    const me = await fetch(`http://127.0.0.1:${gateway.port}/auth/me`, { headers: { cookie: `ak_session=${session}` } })
    expect(await me.json()).toMatchObject({ authenticated: true, organization: { status: 'suspended' } })
    const runtimeResponse = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers: { cookie: `ak_session=${session}` } })
    expect(runtimeResponse.status).toBe(403)
    expect(await runtimeResponse.json()).toEqual({ error: 'organization_not_active', status: 'suspended' })
    expect(runtimePaths).toEqual([])
  })

  it('rate limits authenticated tenant requests before proxying upstream', async () => {
    const runtimePaths: string[] = []
    const runtime = createServer((request, response) => {
      runtimePaths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"runtime":true}')
    })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
    const runtimeAddress = runtime.address()
    const runtimePort = typeof runtimeAddress === 'object' && runtimeAddress ? runtimeAddress.port : 0
    const gateway = await createGateway(`http://127.0.0.1:${runtimePort}`, undefined, {
      organizations: new TestOrganizationStore(),
      rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 1 }),
    })

    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const headers = { cookie: `ak_session=${session}` }

    expect(await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers }).then((response) => response.status)).toBe(200)
    const limited = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    await expect(limited.json()).resolves.toMatchObject({ error: 'rate_limited' })
    expect(runtimePaths).toEqual(['/runtime/capabilities'])
  })

  it('directs enterprise login through a server-resolved IdP and rejects mismatched callbacks', async () => {
    let callbackProvider = 'idp_enterprise'
    const authorizationOptions: Array<{ idpHint?: string; loginHint?: string }> = []
    const enterpriseSso = new MemoryEnterpriseSsoResolver([{ id: 'sso_acme', providerId: 'idp_enterprise', loginHint: 'employee@acme.test' }])
    const gateway = await createGateway('http://127.0.0.1:9', undefined, {
      enterpriseSso,
      authorizationOptions,
      callbackIdentity: () => ({ issuer: 'http://identity.example', subject: 'alice', upstreamProviderId: callbackProvider }),
    })

    const unknown = await fetch(`http://127.0.0.1:${gateway.port}/auth/login?sso=unknown`, { redirect: 'manual' })
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toEqual({ error: 'sso_connection_not_found' })

    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login?sso=sso_acme`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    expect(authorizationOptions.at(-1)).toEqual({ idpHint: 'idp_enterprise', loginHint: 'employee@acme.test' })
    const firstNonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    callbackProvider = 'idp_attacker'
    const mismatch = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=bad`, { headers: { cookie: `ak_login=${firstNonce}` }, redirect: 'manual' })
    expect(mismatch.status).toBe(403)
    await expect(mismatch.json()).resolves.toEqual({ error: 'sso_authentication_mismatch' })

    callbackProvider = 'idp_enterprise'
    const acceptedLogin = await fetch(`http://127.0.0.1:${gateway.port}/auth/login?sso=sso_acme`, { redirect: 'manual' })
    const acceptedNonce = cookieValue(acceptedLogin.headers.getSetCookie(), 'ak_login')
    const accepted = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${acceptedNonce}` }, redirect: 'manual' })
    expect(accepted.status).toBe(302)
  })

  it('fails closed for unauthenticated APIs and enforces same-origin POST logout', async () => {
    const gateway = await createGateway('http://127.0.0.1:9')
    const api = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { redirect: 'manual' })
    expect(api.status).toBe(401)
    await expect(api.json()).resolves.toEqual({ error: 'authentication_required' })

    const navigation = await fetch(`http://127.0.0.1:${gateway.port}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(navigation.status).toBe(303)
    expect(navigation.headers.get('location')).toBe('/auth/login')

    const getLogout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`)
    expect(getLogout.status).toBe(405)
    const crossOrigin = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(crossOrigin.status).toBe(403)
    const logout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${gateway.port}`, accept: 'text/html', 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toBe('/auth/login?prompt=login')
    expect(logout.headers.getSetCookie().join(';')).toContain('ak_session=')
    expect(logout.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    const forcedLogin = await fetch(`http://127.0.0.1:${gateway.port}${logout.headers.get('location')}`, { redirect: 'manual' })
    expect(forcedLogin.status).toBe(302)
    expect(forcedLogin.headers.get('location')).toContain('prompt=login')
  })
})

async function createGateway(
  hostOrigin: string,
  provision?: (unitId: string) => Promise<void>,
  auth?: {
    enterpriseSso?: MemoryEnterpriseSsoResolver
    authorizationOptions?: Array<{ idpHint?: string; loginHint?: string }>
    callbackIdentity?(): AuthenticatedIdentity
    dashboardOrigin?: string
    organizations?: OrganizationStore
    rateLimiter?: SlidingWindowRateLimiter
    serviceAccounts?: ServiceAccountService
    directory?: MemoryRuntimeAssignmentStore
    runtimeOriginResolver?: RuntimeOriginResolver
    runtimeRoutingTicketResolver?: RuntimeRoutingTicketResolver
  },
): Promise<RuntimeIngressGateway> {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-sessions-'))
  const sessions = new FileBrowserSessionStore(join(dir, 'sessions.json'))
  await sessions.load()
  const gateway = await startRuntimeIngressGateway({
    port: 0,
    listenHost: '127.0.0.1',
    hostOrigin,
    ...(auth?.runtimeOriginResolver ? { runtimeOriginResolver: auth.runtimeOriginResolver } : {}),
    ...(auth?.runtimeRoutingTicketResolver ? { runtimeRoutingTicketResolver: auth.runtimeRoutingTicketResolver } : {}),
    ...(auth?.dashboardOrigin ? { dashboardOrigin: auth.dashboardOrigin } : {}),
    publicOrigin: 'http://127.0.0.1:0',
    sessions,
    cacheNamespaceSecret: 'test-session-secret-with-sufficient-entropy',
    secretBox: createSessionSecretBox('test', [{ id: 'test', key: Buffer.alloc(32, 7) }]),
    ingressSecret: 'gateway-secret',
    ...(auth?.organizations ? { organizations: auth.organizations } : {}),
    ...(auth?.rateLimiter ? { rateLimiter: auth.rateLimiter } : {}),
    ...(auth?.serviceAccounts ? { serviceAccounts: auth.serviceAccounts } : {}),
    directory: auth?.directory ?? new MemoryRuntimeAssignmentStore(),
    loginStates: new MemoryLoginStates(),
    ...(auth?.enterpriseSso ? { enterpriseSso: auth.enterpriseSso } : {}),
    oidc: {
      async authorizationUrl(_redirectUri, authorizationOptions) {
        const url = new URL('http://identity.example/authorize')
        if (authorizationOptions?.prompt) url.searchParams.set('prompt', authorizationOptions.prompt)
        if (authorizationOptions?.idpHint) url.searchParams.set('idp_hint', authorizationOptions.idpHint)
        auth?.authorizationOptions?.push({ ...(authorizationOptions?.idpHint ? { idpHint: authorizationOptions.idpHint } : {}), ...(authorizationOptions?.loginHint ? { loginHint: authorizationOptions.loginHint } : {}) })
        return { url, codeVerifier: 'verifier', state: 'state' }
      },
      async callback() { return { identity: auth?.callbackIdentity?.() ?? { issuer: 'http://identity.example', subject: 'alice', displayName: 'Alice Example', email: 'alice@example.test' } } },
      async refresh() { return {} },
      async revokeRefreshToken() {},
    },
    ...(provision ? { provision } : {}),
  })
  running.push(gateway)
  running.push({ close: async () => { rmSync(dir, { recursive: true, force: true }) } })
  return gateway
}

class LifecycleServiceAccountDatabase implements SqlExecutor {
  readonly principals = new Map<string, string>()
  readonly tokens: Array<{
    organizationId: string
    principalId: string
    tokenHash: string
    scopes: ServiceAccountScope[]
    createdAt: Date
    expiresAt: Date | null
    revokedAt: Date | null
  }> = []
  lastListedOrganizationId?: string
  failure?: Error

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    if (this.failure) throw this.failure
    const sql = text.trim().replace(/\s+/gu, ' ')
    if (sql.startsWith('SELECT COUNT(*)')) {
      const organizationId = values[0] as string
      const count = this.tokens.filter((token) => token.organizationId === organizationId && token.revokedAt === null && (token.expiresAt === null || token.expiresAt.getTime() > Date.now())).length
      return sqlResult([{ count: String(count) } as unknown as Row])
    }
    if (sql.startsWith('INSERT INTO principals')) {
      this.principals.set(values[0] as string, values[1] as string)
      return sqlResult([], 1)
    }
    if (sql.startsWith('INSERT INTO service_account_tokens')) {
      this.tokens.push({
        organizationId: values[1] as string,
        principalId: values[2] as string,
        tokenHash: values[3] as string,
        scopes: values[4] as ServiceAccountScope[],
        createdAt: values[5] as Date,
        expiresAt: values[6] as Date | null,
        revokedAt: null,
      })
      return sqlResult([], 1)
    }
    if (sql.startsWith('SELECT tokens.principal_id AS id')) {
      const organizationId = values[0] as string
      this.lastListedOrganizationId = organizationId
      return sqlResult(this.tokens
        .filter((token) => token.organizationId === organizationId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map((token) => ({
          id: token.principalId,
          name: this.principals.get(token.principalId) ?? '',
          scopes: token.scopes,
          created_at: token.createdAt,
          expires_at: token.expiresAt,
          revoked_at: token.revokedAt,
        }) as unknown as Row))
    }
    if (sql.startsWith('UPDATE service_account_tokens')) {
      const token = this.tokens.find((candidate) => candidate.organizationId === values[0] && candidate.principalId === values[1] && candidate.revokedAt === null)
      if (!token) return sqlResult([], 0)
      token.revokedAt = new Date()
      return sqlResult([], 1)
    }
    if (sql.startsWith('SELECT tokens.principal_id')) {
      const token = this.tokens.find((candidate) => candidate.tokenHash === values[0] && candidate.revokedAt === null && (candidate.expiresAt === null || candidate.expiresAt.getTime() > Date.now()))
      if (!token) return sqlResult([])
      return sqlResult([{
        principal_id: token.principalId,
        organization_id: token.organizationId,
        runtime_unit_id: `tenant_${token.organizationId}`,
        organization_status: 'active',
        scopes: token.scopes,
      } as unknown as Row])
    }
    return sqlResult([])
  }
}

class ServiceAccountAuthDatabase implements SqlExecutor {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
    return {
      rows: [{
        principal_id: 'prn_api',
        organization_id: 'org_api',
        runtime_unit_id: 'tenant_api',
        organization_status: 'active',
        scopes: ['workspace:read'],
      } as unknown as Row],
      rowCount: 1,
      command: '',
      oid: 0,
      fields: [],
    }
  }
}

function sqlResult<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}

function openWebSocket(port: number, headers: Record<string, string>, path = '/socket.io/?EIO=4&transport=websocket'): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers },
    })
    request.once('upgrade', (_response, socket) => { socket.destroy(); resolve() })
    request.once('response', (response) => { response.resume(); reject(new Error(`upgrade rejected with HTTP ${response.statusCode ?? 0}`)) })
    request.once('error', reject)
    request.end()
  })
}

function cookieValue(headers: readonly string[], name: string): string {
  const header = headers.find((value) => value.startsWith(`${name}=`))
  if (!header) throw new Error(`missing ${name} cookie`)
  return header.slice(name.length + 1).split(';')[0] ?? ''
}
