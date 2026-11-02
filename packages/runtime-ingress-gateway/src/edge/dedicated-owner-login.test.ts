import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import { MemoryRuntimeAssignmentStore, type AuthenticatedIdentity } from '../assignments/store.js'
import { SlidingWindowRateLimiter } from '../governance/rate-limit.js'
import { MemoryOrganizationStore } from '../organizations/store.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway } from './server.js'

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { while (running.length) await running.pop()!.close() })

describe('Dedicated Owner browser login', () => {
  it('issues a revocable opaque session only for the pre-provisioned Owner', async () => {
    const identity: AuthenticatedIdentity = { issuer: 'urn:kala:dedicated-owner', subject: 'owner', displayName: 'Owner' }
    const organizations = new MemoryOrganizationStore()
    const access = await organizations.getOrCreateForIdentity(identity)
    const gateway = await createDedicatedGateway(identity, access.organization.id, organizations)
    const origin = `http://127.0.0.1:${gateway.port}`

    const form = await fetch(`${origin}/auth/login`)
    expect(form.status).toBe(200)
    // no-referrer makes a browser navigation POST send Origin: null.
    expect(await form.text()).toContain('name="referrer" content="same-origin"')
    for (const rejectedOrigin of ['null', 'https://evil.example.test']) {
      const rejected = await fetch(`${origin}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: rejectedOrigin },
        body: new URLSearchParams({ password: 'never-verified' }), redirect: 'manual',
      })
      expect(rejected.status).toBe(403)
      expect(rejected.headers.get('set-cookie')).toBeNull()
    }

    const wrong = await fetch(`${origin}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'password=wrong-password-value', redirect: 'manual',
    })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()

    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'password=correct-owner-password', redirect: 'manual',
    })
    expect(login.status).toBe(303)
    const cookie = login.headers.get('set-cookie')?.match(/ak_session=([^;]+)/u)?.[1]
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    const authenticated = await fetch(`${origin}/auth/me`, { headers: { cookie: `ak_session=${cookie}` } })
    await expect(authenticated.json()).resolves.toMatchObject({ authenticated: true, organization: { role: 'owner' } })

    const invite = await fetch(`${origin}/organization/invites`, {
      method: 'POST', headers: { cookie: `ak_session=${cookie}`, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other@example.test', role: 'admin' }),
    })
    await expect(invite.json()).resolves.toEqual({ error: 'dedicated_single_owner' })

    const logout = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: `ak_session=${cookie}`, origin } })
    expect(logout.status).toBe(204)
    const revoked = await fetch(`${origin}/auth/me`, { headers: { cookie: `ak_session=${cookie}` } })
    await expect(revoked.json()).resolves.toEqual({ authenticated: false })
    expect(await fetch(`${origin}/auth/callback?code=oidc-is-disabled`)).toMatchObject({ status: 404 })
  })

  it('rate limits repeated password attempts before running unbounded verification work', async () => {
    const identity: AuthenticatedIdentity = { issuer: 'urn:kala:dedicated-owner', subject: 'owner' }
    const organizations = new MemoryOrganizationStore()
    const access = await organizations.getOrCreateForIdentity(identity)
    const gateway = await createDedicatedGateway(identity, access.organization.id, organizations)
    const origin = `http://127.0.0.1:${gateway.port}`
    const attempt = () => fetch(`${origin}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'password=incorrect-owner-password', redirect: 'manual',
    })
    for (let index = 0; index < 5; index += 1) expect((await attempt()).status).toBe(401)
    const limited = await attempt()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })

  it('rejects a valid password when the credential is not bound to the current Owner Organization', async () => {
    const identity: AuthenticatedIdentity = { issuer: 'urn:kala:dedicated-owner', subject: 'owner' }
    const organizations = new MemoryOrganizationStore()
    await organizations.getOrCreateForIdentity(identity)
    const gateway = await createDedicatedGateway(identity, 'org_different', organizations)
    const origin = `http://127.0.0.1:${gateway.port}`
    const response = await fetch(`${origin}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'password=correct-owner-password', redirect: 'manual',
    })
    expect(response.status).toBe(401)
  })
})

async function createDedicatedGateway(identity: AuthenticatedIdentity, organizationId: string, organizations: MemoryOrganizationStore): Promise<RuntimeIngressGateway> {
  const directory = mkdtempSync(join(tmpdir(), 'dedicated-owner-login-'))
  const sessions = new FileBrowserSessionStore(join(directory, 'sessions.json'))
  await sessions.load()
  const gateway = await startRuntimeIngressGateway({
    port: 0,
    listenHost: '127.0.0.1',
    publicOrigin: 'http://127.0.0.1:0',
    hostOrigin: 'http://127.0.0.1:9',
    directory: new MemoryRuntimeAssignmentStore(),
    organizations,
    sessions,
    cacheNamespaceSecret: 'dedicated-owner-session-secret-with-entropy',
    ingressSecret: 'test-ingress-secret',
    authentication: {
      kind: 'dedicated-owner',
      loginRateLimiter: new SlidingWindowRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
      owner: { authenticate: async (password) => password === 'correct-owner-password' ? { identity, organizationId } : undefined },
    },
    provision: async () => undefined,
  })
  running.push(gateway)
  running.push({ close: async () => { rmSync(directory, { recursive: true, force: true }) } })
  return gateway
}
