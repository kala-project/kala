import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import type { LoginState } from '../auth/login-state-store.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import { MemoryRuntimeAssignmentStore, type AuthenticatedIdentity } from '../assignments/store.js'
import { SlidingWindowRateLimiter } from '../governance/rate-limit.js'
import { MemoryOrganizationStore } from '../organizations/store.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway } from './server.js'

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { while (running.length) await running.pop()!.close() })

describe('Dedicated Owner browser login', () => {
  it('uses the shared OIDC flow without admitting other identities, creating tenants, or enabling membership mutation', async () => {
    const owner = { issuer: 'https://identity.example.test', subject: 'explicit-owner' }
    let callbackIdentity = owner
    const organizations = new MemoryOrganizationStore()
    const access = await organizations.getOrCreateForIdentity(owner)
    const gateway = await createDedicatedGateway(owner, access.organization.id, organizations, () => callbackIdentity)
    const origin = `http://127.0.0.1:${gateway.port}`
    const signIn = async () => {
      const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
      expect(login.status).toBe(302)
      expect(login.headers.get('location')).toBe('https://identity.example.test/authorize')
      return fetch(`${origin}/auth/callback?code=verified`, {
        headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! }, redirect: 'manual',
      })
    }
    callbackIdentity = { ...owner, subject: 'unprovisioned-user' }
    const denied = await signIn()
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toEqual({ error: 'dedicated_owner_not_authorized' })
    expect(denied.headers.get('set-cookie')).not.toContain('ak_session=')
    expect(await organizations.findAccess(callbackIdentity)).toBeUndefined()
    await organizations.addMember(access.organization.id, callbackIdentity, 'viewer')
    expect((await signIn()).status).toBe(403)
    callbackIdentity = owner
    const accepted = await signIn()
    expect(accepted.status).toBe(302)
    const cookie = accepted.headers.getSetCookie().find((value) => value.startsWith('ak_session='))!.split(';')[0]!
    const me = await fetch(`${origin}/auth/me`, { headers: { cookie } })
    await expect(me.json()).resolves.toMatchObject({ authenticated: true, organization: { id: access.organization.id, role: 'owner' } })
    const mutation = await fetch(`${origin}/organization/invites`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-owner@example.test', role: 'admin' }),
    })
    expect(mutation.status).toBe(403)
    await expect(mutation.json()).resolves.toEqual({ error: 'dedicated_single_owner' })
    expect((await fetch(`${origin}/auth/login?invite=ak_org_invite_${'a'.repeat(43)}`, { redirect: 'manual' })).status).toBe(403)
    expect((await fetch(`${origin}/auth/owner-bootstrap?token=untrusted`, { redirect: 'manual' })).status).toBe(404)
    const legacy = await fetch(`${origin}/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=legacy', redirect: 'manual',
    })
    expect(legacy.status).toBe(405)
    expect(legacy.headers.get('set-cookie')).toBeNull()
  })

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

async function createDedicatedGateway(identity: AuthenticatedIdentity, organizationId: string, organizations: MemoryOrganizationStore, oidcIdentity?: () => AuthenticatedIdentity): Promise<RuntimeIngressGateway> {
  const directory = mkdtempSync(join(tmpdir(), 'dedicated-owner-login-'))
  const sessions = new FileBrowserSessionStore(join(directory, 'sessions.json'))
  await sessions.load()
  const states = new Map<string, LoginState>()
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
    singleTenantOwner: Boolean(oidcIdentity),
    authentication: oidcIdentity ? {
      kind: 'oidc',
      loginStates: { put: async (key, value) => { states.set(key, value) }, take: async (key) => { const value = states.get(key); states.delete(key); return value } },
      secretBox: createSessionSecretBox('test', [{ id: 'test', key: Buffer.alloc(32, 1) }]),
      oidc: {
        authorizationUrl: async () => ({ url: new URL('https://identity.example.test/authorize'), codeVerifier: 'verifier', state: 'state' }),
        callback: async () => ({ identity: oidcIdentity() }),
        refresh: async () => ({}), revokeRefreshToken: async () => {},
      },
    } : {
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
