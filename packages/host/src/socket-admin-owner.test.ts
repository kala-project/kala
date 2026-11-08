import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { createConfig } from '@agent-kernel/kernel'
import { DEDICATED_DEPLOYMENT, PRIVATE_CLOUD_DEPLOYMENT } from '@agent-kernel/shared'
import { io as client, type Socket } from 'socket.io-client'
import { afterEach, expect, it, vi } from 'vitest'

import { startHostServer, type HostServer } from './server.js'
import { loadGatewayOwnerSocketAdminConfig } from './socket-admin.js'
import { MemoryRuntimeAssignmentStore } from '../../runtime-ingress-gateway/src/assignments/store.js'
import { browserSessionTokenHash, FileBrowserSessionStore } from '../../runtime-ingress-gateway/src/auth/browser-session-store.js'
import { SlidingWindowRateLimiter } from '../../runtime-ingress-gateway/src/governance/rate-limit.js'
import { MemoryOrganizationStore } from '../../runtime-ingress-gateway/src/organizations/store.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway } from '../../runtime-ingress-gateway/src/edge/server.js'

const hosts: HostServer[] = []
const gateways: RuntimeIngressGateway[] = []
const clients: Socket[] = []
const directories: string[] = []
afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close()
  for (const gateway of gateways.splice(0)) await gateway.close()
  for (const host of hosts.splice(0)) await host.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const ownerHeaders = {
  'x-agent-runlab-runtime-unit': 'tenant_owner',
  'x-agent-runlab-organization-id': 'org_owner',
  'x-agent-runlab-organization-role': 'owner',
  'x-agent-runlab-principal': 'authenticated-owner',
}

async function start(
  deployment = DEDICATED_DEPLOYMENT,
  unitId = 'tenant_owner',
  embeddedSocketAdminAssets?: readonly { path: string; contentBase64: string }[],
) {
  const directory = mkdtempSync(join(process.cwd(), '.socket-admin-owner-'))
  directories.push(directory)
  const dashboardDir = join(directory, 'dashboard')
  mkdirSync(dashboardDir)
  writeFileSync(join(dashboardDir, 'index.html'), '<!doctype html><title>Dedicated Dashboard fixture</title>')
  const host = await startHostServer({
    port: 0,
    listenHost: '127.0.0.1',
    deployment,
    requireIngressIdentity: true,
    resourceUnitId: unitId,
    sessionsDir: join(directory, 'sessions'),
    staticDir: dashboardDir,
    ...(embeddedSocketAdminAssets ? { embeddedSocketAdminAssets } : {}),
    llm: { name: 'unused', async call() { throw new Error('No model calls expected') } },
    defaultConfig: createConfig({ tools: [] }),
    settings: {
      providers: [], defaultModel: '', hooks: [],
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: directory },
      mcp: { supported: false, note: '' },
    },
  })
  hosts.push(host)
  return `http://127.0.0.1:${host.port}`
}

function connect(origin: string, headers: Record<string, string>): Promise<Socket> {
  const socket = client(`${origin}/admin`, { transports: ['websocket'], extraHeaders: headers, forceNew: true, reconnection: false, autoConnect: false })
  clients.push(socket)
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
    socket.connect()
  })
}

it('serves the installed official UI and connects a Dedicated Owner through existing trusted ingress without a second password', async () => {
  const origin = await start()
  const headers = ownerHeaders
  const redirect = await fetch(`${origin}/admin/socket.io`, { headers, redirect: 'manual' })
  expect(redirect.status).toBe(308)
  expect(redirect.headers.get('location')).toBe('/admin/socket.io/')
  const page = await fetch(`${origin}/admin/socket.io/`, { headers })
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
  const html = await page.text()
  expect(html).toContain('Socket.IO Admin UI')
  expect(html).toContain('kala-bootstrap.js')
  expect(html).not.toContain('https://')
  expect(html).toContain('css/materialdesignicons.min.css')
  for (const [asset, mime, content] of [
    [html.match(/<script src="(js\/[^"]+)"/)![1]!, 'application/javascript', 'webpackJsonp'],
    [html.match(/href="(css\/app\.[^"]+\.css)"/)![1]!, 'text/css', '.'],
    ['favicon.png', 'image/png', '\x89PNG'],
    ['css/materialdesignicons.min.css', 'text/css', 'mdi-home-outline'],
    ['fonts/materialdesignicons-webfont.woff2', 'font/woff2', 'wOF2'],
  ] as const) {
    const response = await fetch(`${origin}/admin/socket.io/${asset}`, { headers })
    expect(response.status, asset).toBe(200)
    expect(response.headers.get('content-type'), asset).toContain(mime)
    const body = Buffer.from(await response.arrayBuffer())
    expect(body.byteLength, asset).toBeGreaterThan(100)
    expect(body.toString('latin1'), asset).toContain(content)
    expect(response.headers.get('content-security-policy'), asset).toContain("default-src 'self'")
    if (asset === 'css/materialdesignicons.min.css') {
      expect(body.toString()).toContain('url("../fonts/materialdesignicons-webfont.woff2")')
      expect(body.toString()).toContain('.mdi-server::before')
      expect(body.toString()).not.toContain('https://cdn.jsdelivr.net')
    }
  }
  const head = await fetch(`${origin}/admin/socket.io/fonts/materialdesignicons-webfont.woff2`, { headers, method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-type')).toBe('font/woff2')
  expect(Number(head.headers.get('content-length'))).toBeGreaterThan(100)
  const bootstrap = await (await fetch(`${origin}/admin/socket.io/kala-bootstrap.js`, { headers })).text()
  expect(bootstrap).toContain('location.origin')
  expect(bootstrap).toContain('"/admin"')
  expect(bootstrap).toContain('"ws_only", "true"')
  expect(bootstrap).not.toMatch(/password|token|admin\.socket\.io/)
  const settings = await (await fetch(`${origin}/settings`, { headers })).json()
  expect(settings.socketAdmin).toMatchObject({ authentication: 'gateway-owner', active: true, initialized: true, runtimeMode: 'development' })
  const admin = await connect(origin, headers)
  expect(admin.connected).toBe(true)
})

it('serves embedded official CSS, JS and favicon alongside the bundled local icon font', async () => {
  const require = createRequire(import.meta.url)
  const dist = join(require.resolve('@socket.io/admin-ui/package.json'), '../ui/dist')
  const html = readFileSync(join(dist, 'index.html'))
  const index = html.toString()
  const css = index.match(/href="(css\/app\.[^"]+\.css)"/)![1]!
  const js = index.match(/<script src="(js\/app\.[^"]+\.js)"/)![1]!
  const assets = ['index.html', css, js, 'favicon.png'].map(path => ({
    path, contentBase64: readFileSync(join(dist, path)).toString('base64'),
  }))
  const origin = await start(DEDICATED_DEPLOYMENT, 'tenant_owner', assets)
  for (const [path, mime] of [
    [css, 'text/css'], [js, 'application/javascript'], ['favicon.png', 'image/png'],
    ['css/materialdesignicons.min.css', 'text/css'], ['fonts/materialdesignicons-webfont.woff2', 'font/woff2'],
  ]) {
    const response = await fetch(`${origin}/admin/socket.io/${path}`, { headers: ownerHeaders })
    expect(response.status, path).toBe(200)
    expect(response.headers.get('content-type'), path).toContain(mime)
    expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(100)
    expect((await fetch(`${origin}/admin/socket.io/${path}`)).status, path).toBe(403)
  }
})

it.each([
  ['anonymous', {}],
  ['member', { ...ownerHeaders, 'x-agent-runlab-organization-role': 'member' }],
  ['foreign Unit', { ...ownerHeaders, 'x-agent-runlab-runtime-unit': 'tenant_foreign' }],
])('denies %s on both official assets and the real admin namespace', async (_name, headers) => {
  const origin = await start()
  for (const path of ['/', '/kala-bootstrap.js', '/js/app.js', '/css/app.6e3b9661.css', '/favicon.png', '/css/materialdesignicons.min.css', '/fonts/materialdesignicons-webfont.woff2']) {
    expect((await fetch(`${origin}/admin/socket.io${path}`, { headers })).status).toBe(403)
  }
  await expect(connect(origin, headers)).rejects.toThrow('deployment_owner_required')
})

it('never promotes a Private Cloud organization Owner to deployment administrator', async () => {
  const origin = await start(PRIVATE_CLOUD_DEPLOYMENT)
  expect((await fetch(`${origin}/admin/socket.io/`, { headers: ownerHeaders })).status).toBe(403)
  await expect(connect(origin, ownerHeaders)).rejects.toThrow()
  const settings = await (await fetch(`${origin}/settings`, { headers: ownerHeaders })).json()
  expect(settings.socketAdmin).toBeUndefined()
})

it('allows an explicit Dedicated production opt-out', () => {
  const before = process.env.KALA_SOCKET_ADMIN_MODE
  process.env.KALA_SOCKET_ADMIN_MODE = 'production'
  try {
    const config = loadGatewayOwnerSocketAdminConfig({ currentModulePath: import.meta.url })
    expect(config.runtime?.mode).toBe('production')
    expect(config.runtime?.authentication).toBe('gateway-owner')
  } finally {
    if (before === undefined) delete process.env.KALA_SOCKET_ADMIN_MODE
    else process.env.KALA_SOCKET_ADMIN_MODE = before
  }
})

it('advertises the effective default development mode only to the Dedicated Owner', async () => {
  const before = process.env.KALA_SOCKET_ADMIN_MODE
  delete process.env.KALA_SOCKET_ADMIN_MODE
  try {
    const origin = await start()
    const owner = await (await fetch(`${origin}/settings`, { headers: ownerHeaders })).json()
    expect(owner.socketAdmin).toMatchObject({
      authentication: 'gateway-owner', active: true,
      runtimeMode: 'development', configuredMode: 'development',
    })
    const member = await (await fetch(`${origin}/settings`, {
      headers: { ...ownerHeaders, 'x-agent-runlab-organization-role': 'member' },
    })).json()
    expect(member.socketAdmin).toBeUndefined()
    expect((await connect(origin, ownerHeaders)).connected).toBe(true)
  } finally {
    if (before === undefined) delete process.env.KALA_SOCKET_ADMIN_MODE
    else process.env.KALA_SOCKET_ADMIN_MODE = before
  }
})

it('reports an explicit production opt-out from the running Dedicated Host', async () => {
  const before = process.env.KALA_SOCKET_ADMIN_MODE
  process.env.KALA_SOCKET_ADMIN_MODE = 'production'
  try {
    const origin = await start()
    const owner = await (await fetch(`${origin}/settings`, { headers: ownerHeaders })).json()
    expect(owner.socketAdmin).toMatchObject({
      authentication: 'gateway-owner', runtimeMode: 'production', configuredMode: 'production',
    })
    expect((await connect(origin, ownerHeaders)).connected).toBe(true)
  } finally {
    if (before === undefined) delete process.env.KALA_SOCKET_ADMIN_MODE
    else process.env.KALA_SOCKET_ADMIN_MODE = before
  }
})

it('routes official assets and the real admin handshake using only the revocable Gateway Owner cookie, not spoofed browser headers', async () => {
  const organizations = new MemoryOrganizationStore()
  const identity = { issuer: 'urn:kala:dedicated-owner', subject: 'owner' }
  const access = await organizations.getOrCreateForIdentity(identity)
  const hostOrigin = await start(DEDICATED_DEPLOYMENT, access.organization.unitId)
  const sessions = new FileBrowserSessionStore(join(directories[0]!, 'browser-sessions.json'))
  await sessions.load()
  const token = 'a'.repeat(43)
  const now = Date.now()
  const session = await sessions.create({
    tokenHash: browserSessionTokenHash(token), identity, cacheNamespace: 'owner',
    device: { label: 'test browser' }, createdAt: now, idleExpiresAt: now + 60_000, absoluteExpiresAt: now + 60_000,
  })
  const gateway = await startRuntimeIngressGateway({
    port: 0, listenHost: '127.0.0.1', publicOrigin: 'http://127.0.0.1:0',
    hostOrigin, dashboardOrigin: hostOrigin, singleTenantOwner: true,
    ingressSecret: 'fixture-only-ingress-secret', cacheNamespaceSecret: 'fixture-only-cache-secret',
    directory: new MemoryRuntimeAssignmentStore(), organizations, sessions, socketRecheckMs: 20,
    authentication: {
      kind: 'dedicated-owner', owner: { async authenticate() { return undefined } },
      loginRateLimiter: new SlidingWindowRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    },
  })
  gateways.push(gateway)
  const origin = `http://127.0.0.1:${gateway.port}`
  const cookie = `ak_session=${token}`
  const spoofed = { cookie, ...ownerHeaders, 'x-agent-runlab-runtime-unit': 'tenant_foreign', 'x-agent-runlab-organization-role': 'member' }
  const dashboard = await fetch(`${origin}/`, { headers: { cookie, accept: 'text/html', 'sec-fetch-dest': 'document' } })
  expect(dashboard.status).toBe(200)
  expect(await dashboard.text()).toContain('Dedicated Dashboard fixture')
  const page = await fetch(`${origin}/admin/socket.io/`, {
    headers: { ...spoofed, accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
  })
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('Socket.IO Admin UI')
  const appScript = html.match(/<script src="(js\/[^"]+)"/)![1]!
  const script = await fetch(`${origin}/admin/socket.io/${appScript}`, { headers: spoofed })
  expect(script.status).toBe(200)
  expect(script.headers.get('content-type')).toContain('application/javascript')
  expect(await script.text()).toContain('webpackJsonp')
  for (const [path, mime] of [
    ['css/materialdesignicons.min.css', 'text/css'],
    ['fonts/materialdesignicons-webfont.woff2', 'font/woff2'],
    ['favicon.png', 'image/png'],
  ]) {
    const asset = await fetch(`${origin}/admin/socket.io/${path}`, { headers: spoofed })
    expect(asset.status, path).toBe(200)
    expect(asset.headers.get('content-type'), path).toContain(mime)
  }
  expect((await fetch(`${origin}/admin/socket.io/kala-bootstrap.js`, { headers: spoofed })).status).toBe(200)
  const admin = await connect(origin, spoofed)
  expect(admin.connected).toBe(true)
  expect((await fetch(`${origin}/admin/socket.io/`, { headers: ownerHeaders })).status).toBe(401)
  expect((await fetch(`${origin}/admin/socket.io/fonts/materialdesignicons-webfont.woff2`, { headers: ownerHeaders })).status).toBe(401)
  await expect(connect(origin, ownerHeaders)).rejects.toThrow()
  await sessions.revoke(session.id, 'logout', Date.now())
  await vi.waitFor(() => expect(admin.connected).toBe(false))
  expect((await fetch(`${origin}/admin/socket.io/`, { headers: { cookie } })).status).toBe(401)
  expect((await fetch(`${origin}/admin/socket.io/css/materialdesignicons.min.css`, { headers: { cookie } })).status).toBe(401)
})
