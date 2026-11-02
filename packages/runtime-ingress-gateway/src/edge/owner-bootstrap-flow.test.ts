import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryRuntimeAssignmentStore, type AuthenticatedIdentity } from '../assignments/store.js'
import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import type { LoginState, LoginStateStore } from '../auth/login-state-store.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import type { OwnerBootstrapGateway } from '../organizations/owner-bootstrap.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway } from './server.js'

class LoginStates implements LoginStateStore {
  readonly values = new Map<string, LoginState>()
  async put(key: string, value: LoginState): Promise<void> { this.values.set(key, value) }
  async take(key: string): Promise<LoginState | undefined> { const value = this.values.get(key); this.values.delete(key); return value }
}

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(running.splice(0).map((gateway) => gateway.close())) })

describe('owner bootstrap HTTP flow', () => {
  it('uses nonce-protected OIDC, captures a candidate, and does not provision or sign in before operator confirmation', async () => {
    let callbackNonce: string | undefined
    let captured: AuthenticatedIdentity | undefined
    let provisionCalls = 0
    const ownerBootstrap: OwnerBootstrapGateway = {
      async assertAvailable() {},
      async captureCandidate(_hash, identity) { captured = identity; return { bootstrapId: 'ob_1234567890123456789012', confirmationCode: 'AbCdEf012345' } },
    }
    const gateway = await gatewayWith(ownerBootstrap, {
      issuer: 'https://idp.example.test', subject: 'opaque-sub', email: 'owner@example.test', emailVerified: true,
    }, (nonce) => { callbackNonce = nonce }, () => { provisionCalls += 1 })
    const token = `ak_owner_bootstrap_${'A'.repeat(43)}`
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/owner-bootstrap?token=${token}`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    expect(login.headers.get('referrer-policy')).toBe('no-referrer')
    const loginCookie = cookieValue(login.headers.getSetCookie(), 'ak_login')
    expect(loginCookie).toBeTruthy()

    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${loginCookie}` }, redirect: 'manual' })
    expect(callback.status).toBe(200)
    const page = await callback.text()
    expect(page).toContain('Operator confirmation required')
    expect(page).toContain('AbCdEf012345')
    expect(captured?.subject).toBe('opaque-sub')
    expect(callbackNonce).toMatch(/^[A-Za-z0-9_-]{32}$/u)
    expect(provisionCalls).toBe(0)
    expect(callback.headers.getSetCookie().join(';')).not.toContain('ak_session=')

    const replay = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${loginCookie}` } })
    expect(replay.status).toBe(400)
  })

  it('returns a failed callback when candidate validation rejects the verified identity', async () => {
    const ownerBootstrap: OwnerBootstrapGateway = {
      async assertAvailable() {},
      async captureCandidate() { throw new Error('owner_bootstrap_verified_email_required') },
    }
    const gateway = await gatewayWith(ownerBootstrap, { issuer: 'https://idp.example.test', subject: 'opaque-sub', email: 'owner@example.test', emailVerified: false })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/owner-bootstrap?token=ak_owner_bootstrap_${'B'.repeat(43)}`, { redirect: 'manual' })
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${cookieValue(login.headers.getSetCookie(), 'ak_login')}` } })
    expect(callback.status).toBe(403)
    await expect(callback.json()).resolves.toEqual({ error: 'owner_bootstrap_verified_email_required' })
  })
})

async function gatewayWith(ownerBootstrap: OwnerBootstrapGateway, identity: AuthenticatedIdentity, nonceSeen?: (nonce: string | undefined) => void, provision?: () => void): Promise<RuntimeIngressGateway> {
  const directory = mkdtempSync(join(tmpdir(), 'owner-bootstrap-http-'))
  const sessions = new FileBrowserSessionStore(join(directory, 'sessions.json'))
  await sessions.load()
  const gateway = await startRuntimeIngressGateway({
    port: 0, listenHost: '127.0.0.1', publicOrigin: 'http://127.0.0.1:0', hostOrigin: 'http://127.0.0.1:9',
    directory: new MemoryRuntimeAssignmentStore(), sessions,
    cacheNamespaceSecret: 'owner-bootstrap-test-secret-with-entropy', ingressSecret: 'test-ingress-secret',
    authentication: {
      kind: 'oidc', ownerBootstrap, loginStates: new LoginStates(),
      secretBox: createSessionSecretBox('test', [{ id: 'test', key: Buffer.alloc(32, 5) }]),
      oidc: {
        async authorizationUrl(_redirect, options) { return { url: new URL('https://idp.example.test/authorize'), codeVerifier: 'verifier', state: 'state' + (options?.nonce ?? '') } },
        async callback(_url, _redirect, _verifier, _state, nonce) { nonceSeen?.(nonce); return { identity } },
        async refresh() { return {} }, async revokeRefreshToken() {},
      },
    },
    ...(provision ? { provision: async () => { provision() } } : {}),
  })
  running.push(gateway)
  running.push({ close: async () => { rmSync(directory, { recursive: true, force: true }) } })
  return gateway
}

function cookieValue(headers: string[], name: string): string {
  return headers.map((header) => header.match(new RegExp(`^${name}=([^;]*)`, 'u'))?.[1]).find(Boolean) ?? ''
}
