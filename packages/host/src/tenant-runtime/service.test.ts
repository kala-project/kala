import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { AGENT_RUNTIME_CAPABILITIES, PROTOCOL_VERSION, type ServerSessionsPayload } from '@agent-kernel/shared'
import { io as connect, type Socket } from 'socket.io-client'

import type { LLMAdapter } from '../llm/adapter.js'
import { startLoopbackHostRuntimeUnit } from './loopback-host-unit.js'
import { startTenantRuntimeService, type TenantRuntimeService } from './service.js'
import type { RuntimeUnitPlacementOwnership } from './runtime-unit-placement-ownership.js'
import type { RuntimeReplicaMembership } from './runtime-replica-membership.js'
import type { TenantRuntimeUnitId } from './unit.js'
import { RuntimeUnitMaterializationStore, type RuntimeUnitMaterialization } from './materialization-store.js'

const roots: string[] = []
const sockets: Socket[] = []
let host: TenantRuntimeService | undefined
const llm: LLMAdapter = { name: 'tenant-test', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } } }

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await host?.close(); host = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('multi-tenant Host composition', () => {
  it('rejects direct traffic without the trusted Gateway service credential', async () => {
    host = await startTenantRuntimeService({ port: 0, ingressSecret: 'secret', resolveUnitId: () => 'a', factory: async () => { throw new Error('must not load') } })
    const response = await fetch(`http://127.0.0.1:${host.port}/runtime/capabilities`, { headers: { 'x-agent-runlab-runtime-unit': 'a' } })
    expect(response.status).toBe(404)
    expect(host.units.list()).toHaveLength(0)
  })

  it('requires a trusted client certificate on the Gateway-to-Runtime listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-mtls-')); roots.push(root)
    const tls = await createTestMtls(root)
    host = await startTenantRuntimeService({
      port: 0,
      ingressSecret: 'secret',
      tls: { key: tls.serverKey, cert: tls.serverCert, ca: tls.ca },
      resolveUnitId: () => undefined,
      factory: async () => { throw new Error('must not load') },
    })
    await expect(httpsGet(host.port, tls.ca)).rejects.toThrow()
    expect((await httpsGet(host.port, tls.ca, tls.clientCert, tls.clientKey)).status).toBe(404)
  })

  it('routes two complete Socket.IO runtimes with identical session ids without leakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-tenant-host-')); roots.push(root)
    host = await startTenantRuntimeService({
      port: 0,
      resolveUnitId: (request) => String(request.headers['x-runtime-unit'] ?? ''),
      factory: async (id) => startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(root, id, 'sessions'),
        llm,
        defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
        capabilities: AGENT_RUNTIME_CAPABILITIES,
      }),
    })

    const origin = `http://127.0.0.1:${host.port}`
    const a = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': 'a' }, auth: { sessionId: 'same-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
    const b = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': 'b' }, auth: { sessionId: 'same-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
    sockets.push(a, b)
    await Promise.all([a, b].map((socket) => new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })))

    await a.timeout(2_000).emitWithAck('client:create_session', { sessionId: 'only-a', workspaceId: 'same-workspace', workspaceName: 'A' })
    const list = async (socket: Socket): Promise<ServerSessionsPayload> => await new Promise((resolve) => {
      socket.once('server:sessions', resolve)
      socket.emit('client:list_sessions', {})
    })
    expect((await list(a)).sessions.some((session) => session.sessionId === 'only-a')).toBe(true)
    expect((await list(b)).sessions.some((session) => session.sessionId === 'only-a')).toBe(false)
    expect(host.units.list()).toHaveLength(2)
    expect(host.status().state).toBe('ready')
    await host.suspendUnit('a')
    expect(host.units.list().map((unit) => unit.id)).toEqual(['b'])
    expect(b.connected).toBe(true)
  })

  it('isolates HTTP artifacts when tenants reuse the same session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-tenant-artifacts-')); roots.push(root)
    host = await startTenantRuntimeService({
      port: 0,
      resolveUnitId: (request) => String(request.headers['x-runtime-unit'] ?? ''),
      factory: async (id) => startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(root, id, 'sessions'), llm,
        defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }), capabilities: AGENT_RUNTIME_CAPABILITIES,
      }),
    })
    const origin = `http://127.0.0.1:${host.port}`
    const headers = (unit: string): Record<string, string> => ({ 'x-runtime-unit': unit, 'content-type': 'application/json' })
    for (const unit of ['a', 'b']) {
      const socket = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': unit }, auth: { sessionId: 'shared', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
      sockets.push(socket); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
      await socket.timeout(2_000).emitWithAck('client:create_session', { sessionId: 'shared', workspaceId: 'shared', workspaceName: unit })
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII='
    const registered = await fetch(`${origin}/session-artifacts/register`, { method: 'POST', headers: headers('a'), body: JSON.stringify({ sessionId: 'shared', fileName: 'a.png', data: png }) })
    expect(registered.status).toBe(200)
    const { artifactId } = await registered.json() as { artifactId: string }
    expect((await fetch(`${origin}/session-artifacts/${artifactId}?sessionId=shared`, { headers: { 'x-runtime-unit': 'a' } })).status).toBe(200)
    expect((await fetch(`${origin}/session-artifacts/${artifactId}?sessionId=shared`, { headers: { 'x-runtime-unit': 'b' } })).status).toBe(404)
    expect(host.units.list()).toHaveLength(2)
    // Push/VAPID state is constructed below each Unit root, never globally.
    expect(join(root, 'a', 'push-vapid.json')).not.toBe(join(root, 'b', 'push-vapid.json'))
  })

  it('checks live placement on the handshake and closes an established Unit when its lease is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-placement-gate-')); roots.push(root)
    let leaseLost: ((unitId: TenantRuntimeUnitId) => Promise<void>) | undefined
    const ownership: RuntimeUnitPlacementOwnership = {
      activate: vi.fn(async () => undefined),
      isCurrent: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
      releaseAll: vi.fn(async () => undefined),
      setLeaseLostHandler(handler) { leaseLost = handler },
    }
    host = await startTenantRuntimeService({
      port: 0,
      requireProvisioning: true,
      placementOwnership: ownership,
      resolveUnitId: () => 'placed-unit',
      factory: async (id) => startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(root, 'sessions'), llm,
        defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }), capabilities: AGENT_RUNTIME_CAPABILITIES,
      }),
    })
    await host.markRoutable('placed-unit', 'org-a')
    const socket = connect(`http://127.0.0.1:${host.port}/dashboard`, {
      transports: ['websocket'], auth: { sessionId: 'placed-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
    })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
    expect(ownership.activate).toHaveBeenCalledWith('placed-unit', 'org-a')
    expect(ownership.isCurrent).toHaveBeenCalled()

    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()))
    await leaseLost!('placed-unit' as TenantRuntimeUnitId)
    await disconnected
    vi.mocked(ownership.isCurrent).mockResolvedValue(false)
    expect(host.units.list()).toHaveLength(0)
    expect((await fetch(`http://127.0.0.1:${host.port}/runtime/capabilities`)).status).toBe(503)
  })

  it('keeps Unit placement mandatory and stops the Unit when its replica membership is lost', async () => {
    const placement: RuntimeUnitPlacementOwnership = {
      activate: vi.fn(async () => undefined), isCurrent: vi.fn(async () => true),
      release: vi.fn(async () => undefined), releaseAll: vi.fn(async () => undefined), setLeaseLostHandler: vi.fn(),
    }
    let membershipLost: ((id: TenantRuntimeUnitId) => Promise<void>) | undefined
    const membership: RuntimeReplicaMembership = {
      activate: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
      releaseAll: vi.fn(async () => undefined), setLeaseLostHandler(handler) { membershipLost = handler },
      activeLease: vi.fn(() => ({ unitId, organizationId: 'org-a', replicaId: 'replica-a', origin: 'https://runtime-a.example', membershipToken: 'fixture-membership', generation: 1n, expiresAt: new Date(Date.now() + 15_000) })),
    }
    const unitId = 'shadow-membership' as TenantRuntimeUnitId
    const close = vi.fn(async () => undefined)
    host = await startTenantRuntimeService({
      port: 0, placementOwnership: placement, replicaMembership: membership,
      requireProvisioning: true, resolveUnitId: () => unitId,
      factory: async () => ({ id: unitId, state: 'ready', origin: 'http://127.0.0.1:9', drain: async () => undefined, close }),
    })
    await host.markRoutable(unitId, 'org-a')
    expect(placement.activate).toHaveBeenCalledWith(unitId, 'org-a')
    expect(membership.activate).toHaveBeenCalledWith(unitId, 'org-a')
    await host.units.getOrLoad(unitId)
    await membershipLost!(unitId)
    expect(close).toHaveBeenCalledTimes(1)
    expect(membership.release).toHaveBeenCalledWith(unitId)
    expect(placement.release).toHaveBeenCalledWith(unitId)
    expect(host.units.list()).toHaveLength(0)
  })

  it('rejects shadow replica membership without exclusive Unit placement', async () => {
    const membership: RuntimeReplicaMembership = {
      activate: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
      releaseAll: vi.fn(async () => undefined), setLeaseLostHandler: vi.fn(),
    }
    await expect(startTenantRuntimeService({
      port: 0, replicaMembership: membership,
      resolveUnitId: () => 'unit-a', factory: async () => { throw new Error('must not load') },
    })).rejects.toThrow('requires Unit placement')
    expect(membership.activate).not.toHaveBeenCalled()
  })

  it('releases Unit placement and refuses routing when membership registration fails', async () => {
    const placement: RuntimeUnitPlacementOwnership = {
      activate: vi.fn(async () => undefined), isCurrent: vi.fn(async () => true),
      release: vi.fn(async () => undefined), releaseAll: vi.fn(async () => undefined), setLeaseLostHandler: vi.fn(),
    }
    const membership: RuntimeReplicaMembership = {
      activate: vi.fn(async () => { throw new Error('replica unavailable') }),
      release: vi.fn(async () => undefined), releaseAll: vi.fn(async () => undefined), setLeaseLostHandler: vi.fn(),
    }
    host = await startTenantRuntimeService({
      port: 0, placementOwnership: placement, replicaMembership: membership, requireProvisioning: true,
      resolveUnitId: () => 'unit-a', factory: async () => { throw new Error('must not load') },
    })
    await expect(host.markRoutable('unit-a', 'org-a')).rejects.toThrow('replica unavailable')
    expect(placement.release).toHaveBeenCalledWith('unit-a')
    expect((await fetch(`http://127.0.0.1:${host.port}/runtime/capabilities`)).status).toBe(404)
  })

  it('reconciles live loss after teardown without blocking peers or overriding remote lifecycle changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-reconcile-')); roots.push(root)
    const unitId = 'rejoining-unit' as TenantRuntimeUnitId
    const peerId = 'independent-unit' as TenantRuntimeUnitId
    const entry = (id: TenantRuntimeUnitId): RuntimeUnitMaterialization => ({
      schemaVersion: 1, unitId: id, organizationId: 'org-a', routingKeyDigest: 'fixture', routingKeyVersion: 1,
      generation: 1, desiredState: 'ready', dataRoot: root, capabilities: AGENT_RUNTIME_CAPABILITIES,
      lastOperationId: `provision-${id}`, updatedAt: new Date().toISOString(),
    })
    let authority = [entry(unitId)]
    const catalog = new RuntimeUnitMaterializationStore(join(root, 'unused-cached-catalog.json'))
    vi.spyOn(catalog, 'scan').mockImplementation(async () => [...authority])
    vi.spyOn(catalog, 'refresh').mockImplementation(async (id) => authority.find((item) => item.unitId === id))
    let lost: ((id: TenantRuntimeUnitId) => Promise<void>) | undefined
    let finishClose: (() => void) | undefined
    let finishActivation: (() => void) | undefined
    let blockClose = false
    let blockActivation = false
    const placement: RuntimeUnitPlacementOwnership = {
      activate: vi.fn(async (id) => {
        if (id === unitId && blockActivation) await new Promise<void>((resolve) => { finishActivation = resolve })
      }),
      isCurrent: vi.fn(async () => true), release: vi.fn(async () => undefined), releaseAll: vi.fn(async () => undefined),
      setLeaseLostHandler(handler) { lost = handler },
    }
    const factory = vi.fn(async (id: TenantRuntimeUnitId) => ({
      id, state: 'ready' as const, origin: 'http://127.0.0.1:9', drain: async () => undefined,
      close: async () => {
        if (blockClose) { blockClose = false; await new Promise<void>((resolve) => { finishClose = resolve }) }
      },
    }))
    host = await startTenantRuntimeService({ port: 0, requireProvisioning: true, catalog, placementOwnership: placement, resolveUnitId: () => unitId, factory })
    const activationCount = (): number => vi.mocked(placement.activate).mock.calls.filter(([id]) => id === unitId).length
    const routeStatus = async (): Promise<number> => (await fetch(`http://127.0.0.1:${host!.port}/runtime/capabilities`)).status
    await host.reconcile()
    // 502 means the Unit was admitted but its fixture upstream is unavailable.
    await vi.waitFor(async () => expect(await routeStatus()).toBe(502))
    expect(factory).toHaveBeenCalledTimes(1)
    const old = host.units.get(unitId)

    blockClose = true
    const withdrawn = lost!(unitId)
    await vi.waitFor(() => expect(finishClose).toBeDefined())
    authority.push(entry(peerId))
    await Promise.all([host.reconcile(), host.reconcile()])
    await vi.waitFor(() => expect(placement.activate).toHaveBeenCalledWith(peerId, 'org-a'))
    expect(activationCount()).toBe(1)
    expect(await routeStatus()).toBe(404)
    finishClose!()
    await withdrawn
    await vi.waitFor(async () => expect(await routeStatus()).toBe(502))
    expect(activationCount()).toBe(2)
    expect(host.units.get(unitId)).not.toBe(old)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(authority[0]!.generation).toBe(1) // recovery is not an operator resume

    await host.suspendUnit(unitId)
    blockActivation = true
    const refused = expect(host.markRoutable(unitId, 'org-a')).rejects.toThrow('lifecycle changed')
    await vi.waitFor(() => expect(finishActivation).toBeDefined())
    authority[0] = { ...authority[0]!, generation: 2, desiredState: 'suspended' }
    await host.reconcile()
    finishActivation!()
    await refused
    await host.reconcile()
    expect(await routeStatus()).toBe(404)
    expect(activationCount()).toBe(3)

    blockActivation = false
    authority[0] = { ...authority[0]!, generation: 3, desiredState: 'ready' }
    await host.reconcile()
    await vi.waitFor(async () => expect(await routeStatus()).toBe(502))
    expect(activationCount()).toBe(4)
    expect(authority[0]!.generation).toBe(3)
    await host.drain()
    await host.reconcile()
    await expect(host.markRoutable(unitId, 'org-a')).rejects.toThrow('not accepting activations')
    expect(activationCount()).toBe(4)
  })

  it('leaves an explicitly exempt public Unit outside placement and organization binding', async () => {
    const ownership: RuntimeUnitPlacementOwnership = {
      activate: vi.fn(async () => undefined), isCurrent: vi.fn(async () => false),
      release: vi.fn(async () => undefined), releaseAll: vi.fn(async () => undefined), setLeaseLostHandler: vi.fn(),
    }
    host = await startTenantRuntimeService({
      port: 0, requireProvisioning: true, placementOwnership: ownership,
      requiresPlacement: (id) => id !== 'public-installer', resolveUnitId: () => 'public-installer',
      factory: async () => { throw new Error('request need not load for this assertion') },
    })

    await host.markRoutable('public-installer')
    expect(ownership.activate).not.toHaveBeenCalled()
    await fetch(`http://127.0.0.1:${host.port}/missing`)
    expect(ownership.isCurrent).not.toHaveBeenCalled()
  })

  it('does not apply tenant-native storage to an explicitly disabled shared installer engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-installer-native-')); roots.push(root)
    const previous = process.env.KALA_NATIVE_POSIX_ROOT
    process.env.KALA_NATIVE_POSIX_ROOT = join(root, 'must-not-mount-tenant-storage')
    try {
      const unit = await startLoopbackHostRuntimeUnit('public-installer', {
        sessionsDir: join(root, 'sessions'), llm,
        defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
        capabilities: AGENT_RUNTIME_CAPABILITIES, copilot: { enabled: false },
      })
      await unit.close()
    } finally {
      if (previous === undefined) delete process.env.KALA_NATIVE_POSIX_ROOT
      else process.env.KALA_NATIVE_POSIX_ROOT = previous
    }
  })

  it('interrupts unfinished checkpoints on Unit close and disposes its resource exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-unit-resource-')); roots.push(root)
    let closeCount = 0
    const unit = await startLoopbackHostRuntimeUnit('resource-unit', {
      sessionsDir: join(root, 'sessions'), llm,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      capabilities: AGENT_RUNTIME_CAPABILITIES,
      closeResource: async () => { closeCount += 1 },
    })
    const snapshot = unit.server.loop.drainSnapshot('draining-session')
    vi.spyOn(unit.server.store, 'list').mockReturnValueOnce([{ sessionId: 'draining-session' }])
    vi.spyOn(unit.server.loop, 'drainSnapshot').mockReturnValueOnce({ ...snapshot, safe: false })
    vi.spyOn(unit.server.loop, 'waitForCheckpoint').mockImplementationOnce(async () => await new Promise(() => undefined))
    const interrupted = expect(unit.drain()).rejects.toThrow('closed before drain checkpoint')
    await unit.close()
    await interrupted
    await unit.close()
    expect(closeCount).toBe(1)
  })

  it('closes an owned Unit resource when Host startup fails', async () => {
    let closeCount = 0
    await expect(startLoopbackHostRuntimeUnit('failed-resource-unit', {
      sessionsDir: '\0', llm,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      capabilities: AGENT_RUNTIME_CAPABILITIES,
      closeResource: async () => { closeCount += 1 },
    })).rejects.toThrow()
    expect(closeCount).toBe(1)
  })

  it('attaches a Unit-local executor and executes filesystem tools inside its workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-unit-workspace-')); roots.push(root)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir)
    const unit = await startLoopbackHostRuntimeUnit('workspace-unit', {
      sessionsDir: join(root, 'sessions'), workspaceDir, llm,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      capabilities: AGENT_RUNTIME_CAPABILITIES,
    })
    const attached = unit.server.executorsSnapshot()
    expect(attached).toHaveLength(1)
    expect(attached[0]).toMatchObject({
      workspaceId: unit.executor!.workspaceId,
      workspaceName: 'Workspace',
      sandboxRoots: [workspaceDir],
    })
    expect(attached[0]!.tools).toEqual(expect.arrayContaining(['write_file', 'read_file', 'bash']))
    await unit.close()
  })

  it('isolates executor registries when tenants reuse workspace ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-tenant-executors-')); roots.push(root)
    host = await startTenantRuntimeService({ port: 0, resolveUnitId: (request) => String(request.headers['x-runtime-unit'] ?? ''), factory: async (id) => startLoopbackHostRuntimeUnit(id, { sessionsDir: join(root, id, 'sessions'), llm, defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }), capabilities: AGENT_RUNTIME_CAPABILITIES }) })
    const origin = `http://127.0.0.1:${host.port}`
    for (const unit of ['a', 'b']) {
      const executor = connect(`${origin}/executor`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': unit }, auth: { role: 'executor', clientVersion: PROTOCOL_VERSION } })
      sockets.push(executor); await new Promise<void>((resolve, reject) => { executor.once('connect', resolve); executor.once('connect_error', reject) })
      executor.emit('executor:announce', { executorId: `executor-${unit}`, workspaceId: 'same-workspace', workspaceName: unit, tools: ['read'], runtime: 'node', runtimeVersion: '22' })
      const dashboard = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': unit }, auth: { sessionId: 'same', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
      sockets.push(dashboard); await new Promise<void>((resolve, reject) => { dashboard.once('connect', resolve); dashboard.once('connect_error', reject) })
      const payload = await new Promise<{ executors: { executorId: string }[] }>((resolve) => { dashboard.once('server:executors', resolve); dashboard.emit('client:list_executors', {}) })
      expect(payload.executors.map((entry) => entry.executorId)).toEqual([`executor-${unit}`])
    }
  })
})

async function createTestMtls(root: string): Promise<{
  ca: Buffer
  serverKey: Buffer
  serverCert: Buffer
  clientKey: Buffer
  clientCert: Buffer
}> {
  const run = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  }
  await writeFile(join(root, 'server.ext'), 'subjectAltName=DNS:runtime-host\nextendedKeyUsage=serverAuth\n')
  await writeFile(join(root, 'client.ext'), 'extendedKeyUsage=clientAuth\n')
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=runtime-host', '-keyout', 'server.key', '-out', 'server.csr')
  run('x509', '-req', '-days', '1', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'server.ext', '-out', 'server.pem')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=gateway', '-keyout', 'client.key', '-out', 'client.csr')
  run('x509', '-req', '-days', '1', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'client.ext', '-out', 'client.pem')
  return {
    ca: await readFile(join(root, 'ca.pem')),
    serverKey: await readFile(join(root, 'server.key')),
    serverCert: await readFile(join(root, 'server.pem')),
    clientKey: await readFile(join(root, 'client.key')),
    clientCert: await readFile(join(root, 'client.pem')),
  }
}

function httpsGet(port: number, ca: Buffer, cert?: Buffer, key?: Buffer): Promise<{ status: number }> {
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1',
      port,
      path: '/runtime/capabilities',
      servername: 'runtime-host',
      ca,
      ...(cert && key ? { cert, key } : {}),
      minVersion: 'TLSv1.3',
      headers: { 'x-agent-runlab-ingress-secret': 'secret' },
    }, (response) => {
      response.resume()
      response.once('end', () => resolveRequest({ status: response.statusCode ?? 0 }))
    })
    request.once('error', reject)
    request.end()
  })
}
