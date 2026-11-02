import { createServer, type Socket as TcpSocket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { issueRuntimeRoutingTicket, PROTOCOL_VERSION, type AppDebugControl, type AppDebugFrame, type AppDebugReply, type DashboardClientToServerEvents, type DashboardServerToClientEvents } from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'
import { ulid } from 'ulid'
import { startExecutor } from './client.js'
import type { HostServerOptions } from '../../host/src/server.js'
import { startDedicatedRuntimeUnit } from '../../host/src/tenant-runtime/dedicated-unit.js'
import { readDedicatedRouteState, writeDedicatedRouteState } from '../../host/src/tenant-runtime/dedicated-slot-state.js'
import { startLoopbackHostRuntimeUnit } from '../../host/src/tenant-runtime/loopback-host-unit.js'
import { parseTenantRuntimeUnitId } from '../../host/src/tenant-runtime/unit.js'
import { startTenantRuntimeService } from '../../host/src/tenant-runtime/service.js'
import { RuntimeSessionOwnership } from '../../host/src/tenant-runtime/runtime-session-ownership.js'
import { RuntimeResourceOwnershipManager, type RuntimeResourceOwnershipStore } from '../../host/src/tenant-runtime/runtime-resource-ownership.js'
import type { RuntimeUnitReplicaMembership } from '../../host/src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { UnitScheduler } from '../../host/src/scheduled-tasks/scheduler.js'
import { startRuntimeIngressGateway } from '../../runtime-ingress-gateway/src/edge/server.js'
import { MemoryRuntimeAssignmentStore } from '../../runtime-ingress-gateway/src/assignments/store.js'
import { MemoryOrganizationStore } from '../../runtime-ingress-gateway/src/organizations/store.js'
import { FileBrowserSessionStore } from '../../runtime-ingress-gateway/src/auth/browser-session-store.js'
import { FileLoginStateStore } from '../../runtime-ingress-gateway/src/auth/login-state-store.js'
import { createSessionSecretBox } from '../../runtime-ingress-gateway/src/auth/session-secret-box.js'
import { RuntimeRoutingTicketResolver } from '../../runtime-ingress-gateway/src/runtime-origin/runtime-routing-ticket-resolver.js'

type Dashboard = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks() } })
const config = createConfig({ tools: [], systemPrompt: 'Application debugging must not invoke a model' })
const sessionId = 'debug-session'
const control = (socket: Dashboard, request: AppDebugControl): Promise<AppDebugReply> => socket.timeout(3000).emitWithAck('app_debug:control', request)
const frame = (socket: Dashboard, request: AppDebugFrame): Promise<AppDebugReply> => socket.timeout(3000).emitWithAck('app_debug:frame', request)
async function dashboard(origin: string, extra: { query?: Record<string, string>; extraHeaders?: Record<string, string> } = {}) {
  const socket: Dashboard = io(`${origin}/dashboard`, {
    transports: ['websocket'], auth: { role: 'dashboard', clientVersion: PROTOCOL_VERSION, sessionId, token: 'fixture-executor-token' },
    reconnection: false, retries: 0, autoConnect: false, forceNew: true, ...extra,
  })
  cleanup.push(() => { socket.close() })
  const received: AppDebugFrame[] = []
  socket.on('app_debug:frame', (value, ack) => { received.push(value); ack({ ok: true }) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard fixture did not become ready')), 3000)
    socket.once('session:ready', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
    socket.connect()
  })
  return { socket, received }
}
async function fixture(options: Pick<HostServerOptions, 'assertSessionEffectOwner' | 'captureSessionEffectOwner'> & { unitId?: string; organizationId?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kala-debug-platform-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const peers = new Set<TcpSocket>(); const input: Buffer[] = []
  const service = createServer((socket) => {
    peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket))
    socket.on('data', (data) => { input.push(data); socket.write(data) })
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const peer of peers) peer.destroy(); await new Promise<void>((resolve) => service.close(() => resolve())) })
  const address = service.address(); if (!address || typeof address === 'string') throw new Error('No service port')
  const hostOptions = {
    sessionsDir: join(root, 'sessions'), authToken: 'fixture-executor-token', defaultConfig: config,
    llm: { name: 'unused', async call(): Promise<never> { throw new Error('No model effects allowed') } },
    ...(options.assertSessionEffectOwner ? { assertSessionEffectOwner: options.assertSessionEffectOwner } : {}),
    ...(options.captureSessionEffectOwner ? { captureSessionEffectOwner: options.captureSessionEffectOwner } : {}),
  }
  const unit = options.unitId
    ? await startLoopbackHostRuntimeUnit(parseTenantRuntimeUnitId(options.unitId), hostOptions)
    : await startDedicatedRuntimeUnit(hostOptions)
  cleanup.push(() => unit.close())
  const workspaceId = ulid()
  await unit.server.store.ensure({ sessionId, workspaceId, defaultConfig: config, ...(options.organizationId ? { organizationId: options.organizationId } : {}) })
  const attachExecutor = async (origin: string) => {
    const executor = startExecutor({ host: origin, token: 'fixture-executor-token', workspaceId, workspaceName: 'debug-fixture', sandboxRoots: [root] })
    cleanup.push(() => executor.close())
    await Promise.race([executor.ready, executor.permanentError.then((error) => { throw new Error(error.code) }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Executor fixture timeout')), 3000); timer.unref(); executor.ready.finally(() => clearTimeout(timer)).catch(() => {}) })])
    await vi.waitFor(() => expect(unit.server.executorsSnapshot().some((item) => item.workspaceId === workspaceId)).toBe(true))
    return executor
  }
  return { unit, root, port: address.port, peers, input, workspaceId, attachExecutor }
}
async function start(socket: Dashboard, executorId: string, port: number): Promise<string> {
  const reply = await control(socket, { op: 'start', sessionId, executorId, ports: [port] })
  expect(reply).toMatchObject({ ok: true, grantId: expect.any(String) })
  if (!reply.ok || !reply.grantId) throw new Error('No grant')
  return reply.grantId
}
async function open(socket: Dashboard, grantId: string, port: number) {
  expect(await frame(socket, { op: 'open', grantId, streamId: 'live', port })).toMatchObject({ ok: true })
}
const data = (grantId: string, seq: number): AppDebugFrame => ({ op: 'data', grantId, streamId: 'live', seq, data: Buffer.from(`effect-${seq}`).toString('base64') })

it('pins authenticated Dedicated Gateway connections across route publication, revokes on actual cutover and before blocked shutdown', async () => {
  const identity = { issuer: 'http://identity.example', subject: 'fixture-owner' }
  const organizations = new MemoryOrganizationStore()
  const ownerOrganization = await organizations.getOrCreateForIdentity(identity)
  const organizationId = ownerOrganization.organization.id
  const f = await fixture({ organizationId })
  const candidate = await fixture({ organizationId })
  const routePath = join(f.root, 'route.json')
  const publish = (generation: number, activeSlot: 'blue' | 'green') => writeDedicatedRouteState(routePath, {
    schemaVersion: 1, generation, activeSlot,
    slots: { blue: { origin: f.unit.origin, releaseId: 'old' }, green: { origin: candidate.unit.origin, releaseId: 'next' } }, updatedAt: new Date().toISOString(),
  })
  await publish(1, 'blue')
  const sessions = new FileBrowserSessionStore(join(f.root, 'browser-sessions.json')); await sessions.load()
  const loginStates = new FileLoginStateStore(join(f.root, 'login-states.json')); await loginStates.load()
  const ingress = await startRuntimeIngressGateway({
    port: 0, publicOrigin: 'http://127.0.0.1:0', hostOrigin: f.unit.origin,
    ingressSecret: 'fixture-ingress-secret', cacheNamespaceSecret: 'fixture-session-secret-with-sufficient-entropy',
    singleTenantOwner: true, organizations, directory: new MemoryRuntimeAssignmentStore(), sessions,
    runtimeOriginResolver: { async resolve() {
      const state = await readDedicatedRouteState(routePath)
      return state.slots[state.activeSlot].origin
    } },
    authentication: {
      kind: 'oidc', loginStates, secretBox: createSessionSecretBox('fixture', [{ id: 'fixture', key: Buffer.alloc(32, 17) }]),
      oidc: { async authorizationUrl() { return { url: new URL('http://identity.example/authorize'), codeVerifier: 'fixture', state: 'fixture' } }, async callback() { return { identity } }, async refresh() { return {} }, async revokeRefreshToken() {} },
    },
  })
  cleanup.push(() => ingress.close())
  const publicOrigin = `http://127.0.0.1:${ingress.port}`
  const executor = await f.attachExecutor(f.unit.origin)
  await expect(dashboard(publicOrigin)).rejects.toThrow()
  const login = await fetch(`${publicOrigin}/auth/login`, { redirect: 'manual' })
  const loginCookie = login.headers.getSetCookie().find(value => value.startsWith('ak_login='))?.split(';')[0]
  if (!loginCookie) throw new Error('Missing fixture login cookie')
  const callback = await fetch(`${publicOrigin}/auth/callback?code=fixture`, { redirect: 'manual', headers: { cookie: loginCookie } })
  const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('ak_session='))?.split(';')[0]
  if (!sessionCookie) throw new Error('Missing fixture session cookie')
  const ownerHeaders = { cookie: sessionCookie, origin: publicOrigin }
  const owner = await dashboard(publicOrigin, { extraHeaders: ownerHeaders })
  const grantId = await start(owner.socket, executor.executorId!, f.port)
  await open(owner.socket, grantId, f.port)
  expect(await frame(owner.socket, data(grantId, 0))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(owner.received.filter((item) => item.op === 'data')).toHaveLength(1))
  expect((await fetch(`${f.unit.origin}/internal/runtime/quiescence`)).status).toBe(200)
  expect(f.unit.server.loop.isDraining()).toBe(false)
  await publish(2, 'green') // Staging/publication is not drain and does not migrate a live Engine.IO connection.
  const fresh = await dashboard(publicOrigin, { extraHeaders: ownerHeaders })
  expect(candidate.unit.origin).not.toBe(f.unit.origin)
  expect([...candidate.unit.server.io.of('/dashboard').sockets.keys()]).toContain(fresh.socket.id)
  expect(f.unit.server.io.of('/dashboard').sockets.has(owner.socket.id!)).toBe(true)
  expect(await frame(owner.socket, data(grantId, 1))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(Buffer.concat(f.input).toString()).toBe('effect-0effect-1'))
  expect(candidate.input).toHaveLength(0)
  const closed = new Promise((resolve) => owner.socket.once('app_debug:closed', resolve))
  expect((await fetch(`${f.unit.origin}/internal/runtime/cutover/reserve`, { method: 'POST' })).status).toBe(200)
  await closed
  await vi.waitFor(() => expect(f.peers.size).toBe(0))
  expect(await frame(owner.socket, data(grantId, 2))).toMatchObject({ ok: false })
  expect(await control(owner.socket, { op: 'start', sessionId, executorId: executor.executorId!, ports: [f.port] })).toMatchObject({ ok: false })
  expect((await fetch(`${f.unit.origin}/internal/runtime/cutover/release`, { method: 'POST' })).status).toBe(200)
  const restarted = await start(owner.socket, executor.executorId!, f.port)
  expect(restarted).not.toBe(grantId)
  expect(await frame(owner.socket, data(grantId, 2))).toMatchObject({ ok: false })
  await open(owner.socket, restarted, f.port)
  expect(Buffer.concat(f.input).toString()).toBe('effect-0effect-1') // No replay on route/drain release.
  let release!: () => void; let waiting = false
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const originalStop = UnitScheduler.prototype.stop
  vi.spyOn(UnitScheduler.prototype, 'stop').mockImplementationOnce(async function (this: UnitScheduler) { waiting = true; await blocked; await originalStop.call(this) })
  const closing = f.unit.server.close()
  cleanup.push(async () => { release(); await closing })
  try {
    await vi.waitFor(() => expect(waiting).toBe(true))
    expect(owner.socket.connected).toBe(true) // io.close has not run yet.
    await vi.waitFor(() => expect(f.peers.size).toBe(0))
    expect(await frame(owner.socket, data(restarted, 0))).toMatchObject({ ok: false })
    expect(await control(owner.socket, { op: 'context', sessionId })).toMatchObject({ ok: false })
    expect(Buffer.concat(f.input).toString()).toBe('effect-0effect-1')
  } finally { release(); await closing }
}, 15_000)

it('uses actual signed Gateway Session routing, pins healthy local owner activations and terminates live channels on role revocation', async () => {
  // In-memory authority adapters prove transport/fencing composition, not PostgreSQL or HA certification.
  const organizations = new MemoryOrganizationStore()
  const owner = await organizations.getOrCreateForIdentity({ issuer: 'http://identity.example', subject: 'owner' })
  const alice = { issuer: 'http://identity.example', subject: 'alice' }
  await organizations.addMember(owner.organization.id, alice, 'member')
  const unitId = parseTenantRuntimeUnitId(owner.organization.unitId); const organizationId = owner.organization.id
  const member: RuntimeUnitReplicaMembership = { organizationId, unitId, replicaId: 'replica-a', membershipToken: 'member-a', generation: 1n, origin: 'http://replica.test', expiresAt: new Date(Date.now() + 60_000) }
  const makeOwnership = (generation: bigint) => {
    const store: RuntimeResourceOwnershipStore = {
      async acquireResourceOwner(scope, replica, ownerToken, ttlMs) { return { ...scope, replicaId: replica.replicaId, membershipGeneration: replica.generation, membershipToken: replica.membershipToken, ownerToken, generation, expiresAt: new Date(Date.now() + ttlMs) } },
      async renewResourceOwner(lease, ttlMs) { return { ...lease, expiresAt: new Date(Date.now() + ttlMs) } }, async releaseResourceOwner() {},
    }
    const ownership = new RuntimeSessionOwnership(organizationId, unitId, { activeLease: () => member }, new RuntimeResourceOwnershipManager(store), () => {})
    cleanup.push(() => ownership.close())
    return ownership
  }
  let ownership = makeOwnership(1n)
  const assertOwner = vi.fn(async (id: string) => { await ownership.ensure(id) })
  const f = await fixture({ organizationId, unitId, assertSessionEffectOwner: assertOwner, captureSessionEffectOwner: (id) => ownership.captureEffectFence(id) })
  const executor = await f.attachExecutor(f.unit.origin) // Private fixture enrollment; Gateway browser path below is real.
  const runtime = await startTenantRuntimeService({ port: 0, ingressSecret: 'fixture-ingress-secret', resolveUnitId: (request) => request.headers['x-agent-runlab-runtime-unit'] as string | undefined, factory: async (id) => { if (id !== f.unit.id) throw new Error('Wrong Unit'); return f.unit } })
  cleanup.push(() => runtime.close())
  const runtimeOrigin = `http://127.0.0.1:${runtime.port}`
  expect((await fetch(`${runtimeOrigin}/runtime/capabilities`, { headers: { 'x-agent-runlab-runtime-unit': unitId } })).status).toBe(404)
  const key = Buffer.alloc(32, 17)
  const resolver = new RuntimeRoutingTicketResolver({ key, audience: 'fixture-gateway', maxTtlMs: 15_000, ownerResolver: {
    async resolveResourceOwnerBinding(input) {
      const lease = ownership.activeLease(input.resourceId)
      return input.organizationId === organizationId && input.unitId === unitId && input.resourceId === sessionId && lease
        ? { origin: runtimeOrigin, replicaId: lease.replicaId, generation: lease.generation } : undefined
    },
  } })
  const sessions = new FileBrowserSessionStore(join(f.root, 'browser-sessions.json')); await sessions.load()
  const loginStates = new FileLoginStateStore(join(f.root, 'login-states.json')); await loginStates.load()
  const fallback = vi.fn(async () => runtimeOrigin)
  const gateway = await startRuntimeIngressGateway({
    port: 0, hostOrigin: runtimeOrigin, runtimeOriginResolver: { resolve: fallback }, runtimeRoutingTicketResolver: resolver,
    organizations, directory: new MemoryRuntimeAssignmentStore(), sessions,
    cacheNamespaceSecret: 'fixture-session-secret-with-sufficient-entropy',
    publicOrigin: 'http://127.0.0.1:0', ingressSecret: 'fixture-ingress-secret', socketRecheckMs: 20,
    authentication: {
      kind: 'oidc', loginStates, secretBox: createSessionSecretBox('fixture', [{ id: 'fixture', key }]),
      oidc: { async authorizationUrl() { return { url: new URL('http://identity.example/authorize'), codeVerifier: 'fixture', state: 'fixture' } }, async callback() { return { identity: alice } }, async refresh() { return {} }, async revokeRefreshToken() {} },
    },
  })
  cleanup.push(() => gateway.close())
  const origin = `http://127.0.0.1:${gateway.port}`
  const cookie = (response: Response, name: string) => { const value = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`))?.split(';')[0]; if (!value) throw new Error('Missing fixture cookie'); return value }
  const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
  const callback = await fetch(`${origin}/auth/callback?code=fixture`, { redirect: 'manual', headers: { cookie: cookie(login, 'ak_login') } })
  const headers = { cookie: cookie(callback, 'ak_session'), origin }
  await ownership.ensure(sessionId)
  const ticket = (generation: bigint, tenant = organizationId) => issueRuntimeRoutingTicket({ audience: 'fixture-gateway', principalId: Buffer.from(`${alice.issuer}\0${alice.subject}`).toString('base64url'), organizationId: tenant, unitId, resourceKind: 'session', resourceId: sessionId, ownerReplicaId: member.replicaId, ownerGeneration: generation, ttlMs: 15_000 }, { key, maxTtlMs: 15_000 })
  const connect = (value: string) => dashboard(origin, { query: { runtimeRouteTicket: value }, extraHeaders: { ...headers, 'x-agent-runlab-route-session-id': 'forged-session', 'x-agent-runlab-organization-role': 'owner' } })
  const fallbackCount = fallback.mock.calls.length
  await expect(connect(ticket(1n, 'other-organization'))).rejects.toThrow()
  expect(fallback).toHaveBeenCalledTimes(fallbackCount)
  let ownerSocket = await connect(ticket(1n))
  const upstream = f.unit.server.io.of('/dashboard').sockets.get(ownerSocket.socket.id!)!
  expect(upstream.request.headers['x-agent-runlab-route-session-id']).toBe(sessionId)
  expect(upstream.request.headers['x-agent-runlab-organization-role']).toBe('member')
  expect(upstream.request.headers.cookie).toBeUndefined()
  expect(upstream.request.url).not.toContain('runtimeRouteTicket')
  for (const cancel of ['stop', 'drain'] as const) {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let waiting = false
    assertOwner.mockImplementationOnce(async (id) => { waiting = true; await blocked; await ownership.ensure(id) })
    const pending = control(ownerSocket.socket, { op: 'start', sessionId, executorId: executor.executorId!, ports: [f.port] })
    try {
      await vi.waitFor(() => expect(waiting).toBe(true))
      if (cancel === 'stop') expect(await control(ownerSocket.socket, { op: 'stop' })).toMatchObject({ ok: true })
      else { f.unit.server.loop.beginDrain('checkpoint'); f.unit.server.loop.endDrain() }
    } finally { release() }
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
    expect(f.peers.size).toBe(0)
  }
  const before = structuredClone(f.unit.server.store.get(sessionId)!.state)
  const first = await start(ownerSocket.socket, executor.executorId!, f.port)
  await open(ownerSocket.socket, first, f.port)
  const authorityCalls = assertOwner.mock.calls.length
  expect(await frame(ownerSocket.socket, data(first, 0))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(ownerSocket.received.filter((item) => item.op === 'data')).toHaveLength(1))
  expect(assertOwner).toHaveBeenCalledTimes(authorityCalls)
  await ownership.close()
  expect(await frame(ownerSocket.socket, data(first, 1)).catch(() => ({ ok: false }))).toMatchObject({ ok: false })
  expect(assertOwner).toHaveBeenCalledTimes(authorityCalls)
  await vi.waitFor(() => expect(f.peers.size).toBe(0))
  expect(Buffer.concat(f.input).toString()).toBe('effect-0')
  await vi.waitFor(() => expect(ownerSocket.socket.connected).toBe(false))
  ownership = makeOwnership(2n); await ownership.ensure(sessionId)
  ownerSocket = await connect(ticket(2n)) // New activation requires a freshly authenticated route/transport.
  const second = await start(ownerSocket.socket, executor.executorId!, f.port)
  expect(second).not.toBe(first)
  await open(ownerSocket.socket, second, f.port)
  await vi.waitFor(() => expect(f.peers.size).toBe(1))
  const count = ownerSocket.received.length
  const calls = assertOwner.mock.calls.length
  await ownership.close()
  for (const peer of f.peers) peer.write('must-not-reach-desktop')
  await vi.waitFor(() => expect(f.peers.size).toBe(0))
  expect(ownerSocket.received).toHaveLength(count)
  expect(assertOwner).toHaveBeenCalledTimes(calls)
  ownership = makeOwnership(3n); await ownership.ensure(sessionId)
  await expect(connect(ticket(1n))).rejects.toThrow() // Correct signature, obsolete owner: no Unit fallback.
  expect(fallback).toHaveBeenCalledTimes(fallbackCount)
  const latest = await connect(ticket(3n))
  const third = await start(latest.socket, executor.executorId!, f.port)
  await open(latest.socket, third, f.port)
  await organizations.updateMemberRole(organizationId, alice, 'viewer')
  await vi.waitFor(() => expect(latest.socket.connected).toBe(false))
  await vi.waitFor(() => expect(f.peers.size).toBe(0))
  await expect(connect(ticket(3n))).rejects.toThrow()
  expect(Buffer.concat(f.input).toString()).toBe('effect-0')
  expect(f.unit.server.store.get(sessionId)!.state).toEqual(before)
}, 15_000)
