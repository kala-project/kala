import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { issueRuntimeRoutingTicket } from '@agent-kernel/shared'
import { migratePostgres } from '../postgres-migrations.js'
import { createPostgresRuntimeUnitPlacementStore } from './postgres-runtime-unit-placement-store.js'
import { createPostgresRuntimeResourceOwnershipStore } from './postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from './unit.js'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations, type SqlExecutor } from '../../../runtime-ingress-gateway/src/persistence/postgres.js'
import { PostgresRuntimeOriginResolver, assertPostgresRuntimeReader } from '../../../runtime-ingress-gateway/src/runtime-origin/postgres-runtime-origin-resolver.js'
import { PostgresRuntimeResourceOwnerResolver } from '../../../runtime-ingress-gateway/src/runtime-origin/postgres-runtime-resource-owner-resolver.js'
import { RuntimeRoutingTicketResolver } from '../../../runtime-ingress-gateway/src/runtime-origin/runtime-routing-ticket-resolver.js'
import { MemoryOrganizationStore } from '../../../runtime-ingress-gateway/src/organizations/store.js'
import { MemoryRuntimeAssignmentStore, inviteKey } from '../../../runtime-ingress-gateway/src/assignments/store.js'
import { FileBrowserSessionStore } from '../../../runtime-ingress-gateway/src/auth/browser-session-store.js'
import { FileLoginStateStore } from '../../../runtime-ingress-gateway/src/auth/login-state-store.js'
import { createSessionSecretBox } from '../../../runtime-ingress-gateway/src/auth/session-secret-box.js'
import { startRuntimeIngressGateway } from '../../../runtime-ingress-gateway/src/edge/server.js'

// Match Host's existing pg loading pattern; do not add a new package/type dependency for this opt-in gate.
type DatabasePool = SqlExecutor & {
  end(): Promise<void>
  on(event: 'error', listener: () => void): void
}
const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (options: { connectionString: string; max: number; statement_timeout?: number }) => DatabasePool
}
const integrationIt = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? it : it.skip
const execFileAsync = promisify(execFile)
const docker = (...args: string[]) => execFileAsync('sudo', ['-n', 'docker', ...args], { timeout: 60_000, maxBuffer: 128 * 1024 })

integrationIt('withdraws only stale PG-backed Session/replica activations, preserves renewals beyond ticket TTL and closes both sides on reader uncertainty', async () => {
  const id = randomUUID(); const container = `kala-route-lifetime-${id}`
  const cleanup: Array<() => void | Promise<void>> = []
  try {
    await docker('run', '--detach', '--rm', '--name', container, '--label', `dev.kala.test.project=${id}`,
      '--cpus', '1', '--memory', '512m', '--memory-swap', '512m',
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${id}`, '--publish', '127.0.0.1::5432', 'postgres:16-alpine')
    cleanup.push(async () => { await docker('rm', '--force', container) })
    const port = (await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container)).stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('Missing isolated PostgreSQL port')
    const connection = (database: string, user = 'postgres', password = id) => {
      const url = new URL(`postgresql://127.0.0.1:${port}/${database}`); url.username = user; url.password = password; return url.toString()
    }
    const admin = new Pool({ connectionString: connection('postgres'), max: 1 })
    cleanup.push(() => admin.end()); admin.on('error', () => {})
    await vi.waitFor(async () => { await admin.query('SELECT 1') }, { timeout: 30_000 })
    await admin.query('CREATE DATABASE kala_route_runtime'); await admin.query('CREATE DATABASE kala_route_control')
    const runtimeConnection = connection('kala_route_runtime'); const controlConnection = connection('kala_route_control')
    await migratePostgres({ connectionString: runtimeConnection })
    const control = createPostgresControlPlaneDatabase({ connectionString: controlConnection, maxConnections: 1 })
    cleanup.push(() => control.close())
    await migrateControlPlane(control, await readControlPlaneMigrations(resolve(import.meta.dirname, '../../../runtime-ingress-gateway/migrations')))
    const runtime = new Pool({ connectionString: runtimeConnection, max: 1 }); cleanup.push(() => runtime.end()); runtime.on('error', () => {})
    const root = await mkdtemp(join(tmpdir(), 'kala-route-lifetime-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const upstream = async () => {
      const peers = new Set<Socket>(); const inputs: Buffer[] = []; const state = { held: false }
      const server: Server = createServer()
      server.on('upgrade', (_request, socket) => {
        const peer = socket as Socket; peers.add(peer); peer.on('error', () => {}); peer.once('close', () => peers.delete(peer))
        if (!state.held) peer.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
        peer.on('data', (bytes) => { inputs.push(Buffer.from(bytes)); peer.write(Buffer.from([0x81, 2, 0x6f, 0x6b])) })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      cleanup.push(async () => { for (const peer of peers) peer.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) })
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing upstream port')
      return { origin: `http://127.0.0.1:${address.port}`, peers, inputs, state }
    }
    const [a, b] = await Promise.all([upstream(), upstream()])
    const organizations = new MemoryOrganizationStore()
    const identity = { issuer: 'http://identity.example', subject: 'route-user' }
    const access = await organizations.getOrCreateForIdentity(identity)
    const organizationId = access.organization.id; const unitId = parseTenantRuntimeUnitId(access.organization.unitId)
    await control.query('INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES($1,$2,$3,$4)', [organizationId, 'Route fixture', 'active', unitId])
    await control.query('INSERT INTO runtime_unit_placements(runtime_unit_id,organization_id,desired_state,generation,last_operation_id) VALUES($1,$2,$3,1,$4)', [unitId, organizationId, 'ready', id])
    const placements = createPostgresRuntimeUnitPlacementStore({ connectionString: runtimeConnection }); cleanup.push(() => placements.close())
    const legacy = await placements.acquire({ organizationId, unitId, nodeId: 'legacy', ownerToken: randomUUID(), origin: a.origin }, 60_000)
    await placements.release(legacy)
    await placements.promoteToParallel({ organizationId, unitId }, legacy.generation + 1n)
    const owners = createPostgresRuntimeResourceOwnershipStore({ connectionString: runtimeConnection, maxConnections: 1 }); cleanup.push(() => owners.close())
    const memberA = await owners.registerReplica({ organizationId, unitId, replicaId: 'replica-a', membershipToken: randomUUID(), origin: a.origin }, 60_000)
    const memberB = await owners.registerReplica({ organizationId, unitId, replicaId: 'replica-b', membershipToken: randomUUID(), origin: b.origin }, 60_000)
    const scopeA = { organizationId, unitId, resourceType: 'session' as const, resourceId: 'session-a' }
    const scopeB = { ...scopeA, resourceId: 'session-b' }
    const ownerA = await owners.acquireResourceOwner(scopeA, memberA, randomUUID(), 60_000)
    let ownerB = await owners.acquireResourceOwner(scopeB, memberB, randomUUID(), 60_000)
    for (const scope of [scopeA, scopeB]) await runtime.query('INSERT INTO tenant_session_latest_projection(tenant_id,session_id,version,document) VALUES($1,$2,1,$3::jsonb)', [organizationId, scope.resourceId, JSON.stringify({ sessionId: scope.resourceId, organizationId })])
    const readerRole = `route_reader_${id.replaceAll('-', '')}`; const readerPassword = randomUUID()
    await admin.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}'`)
    for (const database of [runtime, control]) {
      await database.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
      await database.query(`GRANT USAGE ON SCHEMA public TO ${readerRole}`)
      await database.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${readerRole}`)
    }
    const readRuntime = new Pool({ connectionString: connection('kala_route_runtime', readerRole, readerPassword), max: 2, statement_timeout: 1000 })
    const readControl = new Pool({ connectionString: connection('kala_route_control', readerRole, readerPassword), max: 2, statement_timeout: 1000 })
    for (const pool of [readRuntime, readControl]) { pool.on('error', () => {}); cleanup.push(() => pool.end()) }
    const reader = (pool: DatabasePool): SqlExecutor => ({ query: (text, values) => pool.query(text, values as unknown[] | undefined) })
    await assertPostgresRuntimeReader(reader(readRuntime))
    const allowed = new Set([a.origin, b.origin])
    const originResolver = new PostgresRuntimeOriginResolver(reader(readRuntime), reader(readControl), allowed)
    const key = Buffer.alloc(32, 31)
    const routeResolver = new RuntimeRoutingTicketResolver({ key, audience: 'route-fixture', maxTtlMs: 15_000, ownerResolver: new PostgresRuntimeResourceOwnerResolver(reader(readRuntime), reader(readControl), allowed) })
    const sessions = new FileBrowserSessionStore(join(root, 'sessions.json')); await sessions.load()
    const states = new FileLoginStateStore(join(root, 'states.json')); await states.load()
    const directory = new MemoryRuntimeAssignmentStore(); await directory.bindExecutorInvite('fixture-executor', unitId)
    const gateway = await startRuntimeIngressGateway({ port: 0, hostOrigin: a.origin, runtimeOriginResolver: originResolver, runtimeRoutingTicketResolver: routeResolver,
      organizations, directory, sessions, loginStates: states, publicOrigin: 'http://127.0.0.1:0', ingressSecret: 'fixture-secret', socketRecheckMs: 20,
      cacheNamespaceSecret: 'fixture-session-secret-with-sufficient-entropy', secretBox: createSessionSecretBox('fixture', [{ id: 'fixture', key }]),
      oidc: { async authorizationUrl() { return { url: new URL('http://identity.example/authorize'), codeVerifier: 'fixture', state: 'fixture' } }, async callback() { return { identity } }, async refresh() { return {} }, async revokeRefreshToken() {} },
    }); cleanup.push(() => gateway.close())
    const endpoint = `http://127.0.0.1:${gateway.port}`
    const cookie = (response: Response, name: string) => { const result = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))?.split(';')[0]; if (!result) throw new Error('Missing cookie'); return result }
    const login = await fetch(`${endpoint}/auth/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback?code=fixture`, { redirect: 'manual', headers: { cookie: cookie(login, 'ak_login') } })
    const browserCookie = cookie(callback, 'ak_session')
    const principalId = Buffer.from(`${identity.issuer}\0${identity.subject}`).toString('base64url')
    const ticket = (sessionId: string, replicaId: string, generation: bigint) => issueRuntimeRoutingTicket({ audience: 'route-fixture', principalId, organizationId, unitId, resourceKind: 'session', resourceId: sessionId, ownerReplicaId: replicaId, ownerGeneration: generation, ttlMs: 500 }, { key, maxTtlMs: 15_000 })
    const connect = async (headers: Record<string, string>, transportTicket?: string) => {
      const path = `/socket.io/?EIO=4&transport=websocket${transportTicket ? `&runtimeRouteTicket=${encodeURIComponent(transportTicket)}` : ''}`
      const pending = request(`${endpoint}${path}`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'), origin: endpoint, ...headers } })
      cleanup.push(() => { pending.destroy() })
      const socket = await new Promise<Socket>((resolve, reject) => { pending.once('error', reject); pending.once('response', () => reject(new Error('Upgrade rejected'))); pending.once('upgrade', (_response, socket) => resolve(socket)); pending.end() })
      cleanup.push(() => { socket.destroy() }); socket.on('error', () => {})
      const output: Buffer[] = []; socket.on('data', (bytes) => output.push(Buffer.from(bytes)))
      return { socket, output }
    }
    const first = await connect({ cookie: browserCookie }, ticket('session-a', 'replica-a', ownerA.generation))
    const other = await connect({ cookie: browserCookie }, ticket('session-b', 'replica-b', ownerB.generation))
    const executor = await connect({ 'x-kala-executor-route': inviteKey('fixture-executor'), 'x-kala-executor-replica': 'replica-a' })
    expect(a.peers.size).toBe(2); expect(b.peers.size).toBe(1)
    const maskedFrame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2])
    first.socket.write(maskedFrame)
    await vi.waitFor(() => expect(Buffer.concat(first.output)).toEqual(Buffer.from([0x81, 2, 0x6f, 0x6b])))
    expect(a.inputs).toEqual([maskedFrame])
    await owners.renewResourceOwner(ownerA, 60_000); ownerB = await owners.renewResourceOwner(ownerB, 60_000)
    await owners.renewReplica(memberA, 60_000); await owners.renewReplica(memberB, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 650)) // Handshake ticket expired; healthy activations remain connected.
    expect(first.socket.destroyed).toBe(false); expect(other.socket.destroyed).toBe(false); expect(executor.socket.destroyed).toBe(false)
    await owners.releaseResourceOwner(ownerA)
    const successor = await owners.acquireResourceOwner(scopeA, memberB, randomUUID(), 60_000)
    expect(successor.generation).toBeGreaterThan(ownerA.generation)
    await vi.waitFor(() => expect(first.socket.destroyed).toBe(true))
    await vi.waitFor(() => expect(a.peers.size).toBe(1))
    expect(other.socket.destroyed).toBe(false); expect(executor.socket.destroyed).toBe(false)
    const replacement = await connect({ cookie: browserCookie }, ticket('session-a', 'replica-b', successor.generation))
    expect(b.inputs).toHaveLength(0) // No command/frame replay to successor.
    await owners.releaseReplica(memberA)
    const restarted = await owners.registerReplica({ ...memberA, membershipToken: randomUUID(), origin: a.origin }, 60_000)
    expect(restarted.generation).toBeGreaterThan(memberA.generation) // Same origin and replica id, different activation.
    await vi.waitFor(() => expect(executor.socket.destroyed).toBe(true))
    await vi.waitFor(() => expect(a.peers.size).toBe(0))
    expect(other.socket.destroyed).toBe(false); expect(replacement.socket.destroyed).toBe(false)
    await owners.releaseResourceOwner(ownerB)
    const previousBGeneration = ownerB.generation
    ownerB = await owners.acquireResourceOwner(scopeB, memberB, randomUUID(), 60_000)
    expect(ownerB.generation).toBeGreaterThan(previousBGeneration) // Same origin AND same replica; origin-only checks are insufficient.
    await vi.waitFor(() => expect(other.socket.destroyed).toBe(true))
    expect(replacement.socket.destroyed).toBe(false)
    const newOther = await connect({ cookie: browserCookie }, ticket('session-b', 'replica-b', ownerB.generation))
    const newExecutor = await connect({ 'x-kala-executor-route': inviteKey('fixture-executor'), 'x-kala-executor-replica': 'replica-a' })
    a.state.held = true
    const pendingUpgrade = connect({ 'x-kala-executor-route': inviteKey('fixture-executor'), 'x-kala-executor-replica': 'replica-a' }).then(() => false, () => true)
    await vi.waitFor(() => expect(a.peers.size).toBe(2)) // One completed and one deliberately unacknowledged upgrade.
    await runtime.query(`REVOKE SELECT ON tenant_runtime_unit_replica_memberships FROM ${readerRole}`)
    await vi.waitFor(() => expect([newOther, replacement, newExecutor].every((value) => value.socket.destroyed)).toBe(true))
    await vi.waitFor(() => { expect(a.peers.size).toBe(0); expect(b.peers.size).toBe(0) })
    expect(await pendingUpgrade).toBe(true)
    await runtime.query(`GRANT SELECT ON tenant_runtime_unit_replica_memberships TO ${readerRole}`)
    const recovered = await connect({ cookie: browserCookie }, ticket('session-b', 'replica-b', ownerB.generation))
    expect(recovered.socket.destroyed).toBe(false); expect(other.socket.destroyed).toBe(true)
    expect(a.inputs).toEqual([maskedFrame]); expect(b.inputs).toHaveLength(0)
  } finally {
    const errors: unknown[] = []
    for (const close of cleanup.reverse()) { try { await close() } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, 'Isolated route-lifetime fixture cleanup failed')
  }
}, 120_000)
