import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '../../packages/shared/dist/index.js'
import { hashToken } from '../../packages/host/dist/src/store/executor-identity.js'
import { startRuntimeIngressGateway } from '../../packages/runtime-ingress-gateway/dist/src/edge/server.js'
import { FileBrowserSessionStore } from '../../packages/runtime-ingress-gateway/dist/src/auth/browser-session-store.js'
import { createSessionSecretBox } from '../../packages/runtime-ingress-gateway/dist/src/auth/session-secret-box.js'
import { MemoryOrganizationStore } from '../../packages/runtime-ingress-gateway/dist/src/organizations/store.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hostRelease = resolve(process.env.PRODUCT_E2E_WINDOWS_HOST_RELEASE_DIR ?? join(root, 'release'))
const executorRelease = resolve(process.env.PRODUCT_E2E_WINDOWS_EXECUTOR_RELEASE_DIR ?? join(root, 'release'))
const runtimeService = join(root, 'packages', 'host', 'dist', 'bin', 'kala-runtime-service.js')
const topologyPreflight = process.env.PRODUCT_E2E_PRIVATE_CLOUD_TOPOLOGY_PREFLIGHT === '1'
const sourceRuntime = topologyPreflight && process.env.PRODUCT_E2E_PRIVATE_CLOUD_SOURCE_RUNTIME === '1'
const executor = join(executorRelease, 'kala-executor.cjs')
const serviceHost = join(executorRelease, 'kala-executor-service-host-win32-x64.exe')
const stateRoot = mkdtempSync(join(tmpdir(), 'kala-private-cloud-windows-invite-'))
const hostDataRoot = join(stateRoot, 'host-data')
const sessionRoot = join(stateRoot, 'browser-sessions')
const deploymentPath = join(stateRoot, 'deployment.json')
const ingressSecret = 'private-cloud-windows-e2e-ingress-secret'
const serviceName = 'KalaExecutor'
const serviceInstallDir = join(process.env.ProgramFiles ?? '', 'Kala', 'Executor')
const serviceDataDir = join(process.env.ProgramData ?? '', 'Kala', 'Executor')
const diagnostics = []
let runtimeHost
let gateway
let dashboard
let serviceOwned = false
let ownerSessionCookie

class MemoryLoginStates {
  values = new Map()
  async put(nonce, state) { this.values.set(nonce, state) }
  async take(nonce) { const value = this.values.get(nonce); this.values.delete(nonce); return value }
}

try {
  if (!topologyPreflight && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('verify-private-cloud-windows-invite.mjs requires a real Windows x64 runner')
  assertFiles([
    sourceRuntime ? join(root, 'packages', 'host', 'bin', 'kala-runtime-service.ts') : runtimeService,
    ...(topologyPreflight ? [] : [executor, serviceHost]),
    join(hostRelease, 'SHA256SUMS'),
    join(hostRelease, 'kala-executor.cjs'),
    join(hostRelease, 'kala-executor-service-host-win32-x64.exe'),
    join(hostRelease, 'node-pty-win32-x64.tar.gz'),
    join(hostRelease, 'install-executor.ps1'),
  ], 'source-built Private Cloud Windows fixture')
  if (!topologyPreflight) {
    await assertServiceAbsent()
    if (existsSync(serviceInstallDir) || existsSync(serviceDataDir)) throw new Error('managed Windows Executor directories must be absent before invite acceptance')
  }

  writeFileSync(deploymentPath, `${JSON.stringify({ schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' }, null, 2)}\n`)
  const hostPort = await reservePort()
  runtimeHost = start(sourceRuntime ? join(root, 'packages', 'host', 'node_modules', '.bin', 'tsx') : process.execPath,
    [sourceRuntime ? join(root, 'packages', 'host', 'bin', 'kala-runtime-service.ts') : runtimeService], {
    KALA_DEPLOYMENT_CONFIG: deploymentPath,
    KALA_RUNTIME_KALA_PORT: String(hostPort),
    KALA_RUNTIME_KALA_BIND_HOST: '127.0.0.1',
    KALA_INGRESS_SHARED_SECRET: ingressSecret,
    KALA_RUNTIME_HOST_DATA_ROOT: hostDataRoot,
    KALA_RUNTIME_HOST_RELEASE_ASSETS_DIR: hostRelease,
    KALA_RUNTIME_HOST_LLM_API_KEY: 'unused-private-cloud-e2e-key',
    KALA_RUNTIME_HOST_LLM_MODEL: 'unused-private-cloud-e2e-model',
    KALA_RUNTIME_HOST_LLM_BASE_URL: 'http://127.0.0.1:9',
  }, 'runtime-host')
  await waitForOutput(runtimeHost, 'tenant_runtime_service_ready', 30_000, 'Private Cloud runtime Host readiness')

  const gatewayPort = await reservePort()
  const origin = `http://127.0.0.1:${gatewayPort}`
  const hostOrigin = `http://127.0.0.1:${hostPort}`
  const sessions = new FileBrowserSessionStore(join(sessionRoot, 'sessions.json'))
  await sessions.load()
  const organizations = new MemoryOrganizationStore()
  gateway = await startRuntimeIngressGateway({
    port: gatewayPort,
    listenHost: '127.0.0.1',
    hostOrigin,
    publicOrigin: origin,
    sessions,
    cacheNamespaceSecret: 'private-cloud-windows-e2e-cache-secret',
    ingressSecret,
    organizations,
    directory: {
      async getOrCreateForIdentity(identity) { const access = await organizations.getOrCreateForIdentity(identity); return { unitId: access.organization.unitId, identity } },
      async findByIdentity(identity) { const access = await organizations.findAccess(identity); return access ? { unitId: access.organization.unitId, identity } : undefined },
      bindExecutorInvite: (token, unitId) => organizations.bindExecutorInvite(token, unitId),
      findUnitByExecutorInvite: (token) => organizations.findUnitByExecutorInvite(token),
      findUnitByExecutorRouteHint: (hint) => organizations.findUnitByExecutorRouteHint(hint),
    },
    authentication: {
      kind: 'oidc',
      loginStates: new MemoryLoginStates(),
      secretBox: createSessionSecretBox('e2e', [{ id: 'e2e', key: Buffer.alloc(32, 19) }]),
      oidc: {
        async authorizationUrl() { return { url: new URL('http://identity.example/authorize'), codeVerifier: 'verifier', state: 'state' } },
        async callback() { return { identity: { issuer: 'http://identity.example', subject: 'windows-e2e-owner', displayName: 'Windows E2E Owner', email: 'windows-e2e@example.test', emailVerified: true } } },
        async refresh() { return {} },
        async revokeRefreshToken() {},
      },
    },
    provision: async (unitId) => {
      const response = await fetch(`${hostOrigin}/internal/runtime-units`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': ingressSecret },
        body: JSON.stringify({ unitId, operationId: `provision:${unitId}`, generation: 1 }),
      })
      if (!response.ok) {
        const body = await response.text()
        // Only report a fixed error class, never a raw Host response or filesystem path.
        const cause = /\b(EPERM|EISDIR|ENOENT|EACCES)\b/u.exec(body)?.[1]
          ?? (/invalid TenantRuntimeUnit id/u.test(body) ? 'invalid_unit_id' : undefined)
          ?? (/invalid provisioning request/u.test(body) ? 'invalid_request' : undefined)
          ?? 'other'
        throw new Error(`Private Cloud runtime unit provisioning failed (${response.status}, ${cause})`)
      }
    },
  })

  const { cookie, unitId } = await authenticateOwner(origin, organizations)
  dashboard = io(`${origin}/dashboard`, {
    transports: ['websocket'],
    auth: { sessionId: 'private-cloud-windows-invite-e2e', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
    extraHeaders: { Cookie: `ak_session=${cookie}`, Origin: origin },
    reconnection: false,
  })
  await once(dashboard, 'session:ready', 20_000)

  if (topologyPreflight) {
    const capabilitiesResponse = await fetch(`${origin}/api/executor-install-capabilities`, { headers: { cookie: `ak_session=${ownerSessionCookie}` } })
    const capabilities = await capabilitiesResponse.json()
    if (!capabilitiesResponse.ok || capabilities?.platforms?.windows?.available !== true) throw new Error('Private Cloud topology did not serve checksum-verified Windows assets through ingress')
    const invite = await createInvite(origin)
    const bootstrap = await fetch(`${origin}/install/invite.ps1`)
    const script = await bootstrap.text()
    if (!bootstrap.ok || !script.includes(`${origin}/install/assets`) || script.includes(invite.token)) throw new Error(`Private Cloud public Windows bootstrap failed safety check (status=${bootstrap.status}, bytes=${Buffer.byteLength(script)}, expectedOrigin=${script.includes(origin)})`)
    for (const name of ['SHA256SUMS', 'kala-executor.cjs', 'kala-executor-service-host-win32-x64.exe', 'node-pty-win32-x64.tar.gz', 'install-executor.ps1']) {
      const asset = await fetch(`${origin}/install/assets/${name}`)
      const bytes = Buffer.from(await asset.arrayBuffer())
      if (!asset.ok || !bytes.equals(readFileSync(join(hostRelease, name)))) throw new Error(`Private Cloud public installer asset mismatch: ${name} (${asset.status})`)
    }
    const forbidden = await fetch(`${hostOrigin}/api/executor-installs`, { headers: { 'x-agent-runlab-runtime-unit': 'public-installer', 'x-agent-runlab-ingress-secret': ingressSecret } })
    if (forbidden.status !== 404) throw new Error(`Public installer Unit unexpectedly accepted a tenant API (${forbidden.status})`)
    if (existsSync(unitIdentityPath('public-installer'))) throw new Error('Public installer Unit must not provision an Executor identity')
    console.log('PASS local Private Cloud tenant topology, authenticated invite, isolated public asset downloads and anonymous PowerShell bootstrap (no Windows binary executed)')
  } else {
    await verifyTemporaryInvite({ origin, unitId })
    await verifyServiceInvite({ origin, unitId })
    console.log('PASS Private Cloud real Windows x64 valid invite temporary/service enrollment, routeHint reconnect, and uninstall')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(`Private Cloud Windows invite diagnostics: ${JSON.stringify(summarizeDiagnostics())}`)
  process.exitCode = 1
} finally {
  dashboard?.close()
  await gateway?.close().catch(() => undefined)
  await stop(runtimeHost)
  if (serviceOwned) await emergencyServiceCleanup()
  rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function verifyTemporaryInvite({ origin, unitId }) {
  const invite = await createInvite(origin)
  const home = join(stateRoot, 'temporary-home')
  const workspace = join(stateRoot, 'temporary-workspace')
  const tokenFile = join(home, 'executor-token')
  const workspaceIdFile = join(home, 'workspace-id')
  mkdirSync(workspace, { recursive: true })
  const child = startInvitePowerShell(origin, invite.token, 'temporary', workspace, {
    HOME: home,
    USERPROFILE: home,
    KALA_EXECUTOR_TOKEN_FILE: tokenFile,
    KALA_WORKSPACE_ID_FILE: workspaceIdFile,
  }, 'temporary-installer')
  try {
    const state = await waitForInviteState(unitId, invite.id, child)
    const workspaceId = state.invite.workspaceId
    await waitForExecutor(workspaceId, true, 'temporary Executor ingress connection')
    const routeHintFile = join(home, 'executor-route-hint')
    await waitFor(() => existsSync(tokenFile) && existsSync(routeHintFile), 15_000, 'temporary device token and routeHint persistence')
    const token = readFileSync(tokenFile, 'utf8').trim()
    const routeHint = readFileSync(routeHintFile, 'utf8').trim()
    assertDeviceCredential(state, workspaceId, token)
    if (routeHint !== invite.routeHint) throw new Error('temporary Executor did not persist the tenant routeHint')
  } finally {
    await stop(child)
  }
  await waitForExecutor(readWorkspaceId(unitId, invite.id), false, 'temporary Executor shutdown')
}

async function verifyServiceInvite({ origin, unitId }) {
  const invite = await createInvite(origin)
  const workspace = join(stateRoot, 'service-workspace')
  mkdirSync(workspace, { recursive: true })
  serviceOwned = true
  const result = await runInvitePowerShell(origin, invite.token, 'service', workspace)
  if (result.code !== 0) throw new Error(`service invite installer failed (${summarizeResult(result)})`)
  const state = await waitForInviteState(unitId, invite.id)
  const workspaceId = state.invite.workspaceId
  await waitForExecutor(workspaceId, true, 'service Executor ingress connection')

  const configPath = join(serviceDataDir, 'config.json')
  const credentialPath = join(serviceDataDir, 'credential')
  assertFiles([configPath, credentialPath, join(serviceInstallDir, 'kala-executor.cjs'), join(serviceInstallDir, 'kala-executor-service.exe')], 'managed invite service')
  const configText = readFileSync(configPath, 'utf8')
  const config = JSON.parse(configText)
  const credential = readFileSync(credentialPath, 'utf8').trim()
  if (Object.hasOwn(config, 'invite') || configText.includes('ak_invite_') || credential.startsWith('ak_invite_')) throw new Error('managed service retained an invite credential')
  if (config.host !== origin || config.workspaceId !== workspaceId || config.routeHint !== invite.routeHint || config.installationSource !== 'private-cloud-invite') throw new Error('managed service config is not bound to the enrolled ingress route')
  assertDeviceCredential(state, workspaceId, credential)

  const stopped = await run('sc.exe', ['stop', serviceName])
  if (stopped.code !== 0) throw new Error(`SCM could not stop the managed Executor (${summarizeResult(stopped)})`)
  await waitForServiceState('STOPPED')
  await waitForExecutor(workspaceId, false, 'service stop through ingress')
  const beforeRestart = executorState(unitId, workspaceId)?.lastSeenAt

  const started = await run('sc.exe', ['start', serviceName])
  if (started.code !== 0) throw new Error(`SCM could not restart the managed Executor (${summarizeResult(started)})`)
  await waitForServiceState('RUNNING')
  await waitForExecutor(workspaceId, true, 'service routeHint reconnect through ingress')
  await waitFor(() => {
    const lastSeenAt = executorState(unitId, workspaceId)?.lastSeenAt
    return lastSeenAt && (!beforeRestart || Date.parse(lastSeenAt) > Date.parse(beforeRestart))
  }, 30_000, 'device token activity after service routeHint reconnect')

  await uninstallService()
  serviceOwned = false
  await assertServiceAbsent()
  if (existsSync(serviceInstallDir) || existsSync(serviceDataDir)) throw new Error('service uninstall left managed Windows Executor directories')
}

async function authenticateOwner(origin, organizations) {
  const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
  if (login.status !== 302) throw new Error(`OIDC fixture login did not start (${login.status})`)
  const loginCookie = cookieValue(login.headers, 'ak_login')
  const callback = await fetch(`${origin}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${loginCookie}` }, redirect: 'manual' })
  if (![302, 303].includes(callback.status)) throw new Error(`OIDC fixture callback failed (${callback.status})`)
  const cookie = cookieValue(callback.headers, 'ak_session')
  const access = await organizations.findAccess({ issuer: 'http://identity.example', subject: 'windows-e2e-owner' })
  if (!access || access.membership.role !== 'owner') throw new Error('OIDC fixture did not create an authenticated organization owner')
  return { cookie, unitId: access.organization.unitId }
}

async function createInvite(origin) {
  const response = await fetch(`${origin}/auth/executor-invites`, {
    method: 'POST',
    headers: { cookie: `ak_session=${cookieValueFromDashboard()}`, origin, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`authenticated Private Cloud invite creation failed (${response.status})`)
  const value = await response.json()
  if (typeof value.id !== 'string' || typeof value.inviteToken !== 'string' || !/^ak_invite_[A-Za-z0-9_-]+$/u.test(value.inviteToken)) throw new Error('Private Cloud invite API returned an invalid contract')
  return { id: value.id, token: value.inviteToken, routeHint: createHash('sha256').update(value.inviteToken).digest('base64url') }
}

function cookieValueFromDashboard() {
  if (!ownerSessionCookie) throw new Error('owner session cookie is unavailable')
  return ownerSessionCookie
}

function cookieValue(headers, name) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? '']
  const match = values.join(';').match(new RegExp(`(?:^|[;,]\\s*)${name}=([^;]+)`, 'u'))
  if (!match) throw new Error(`authentication fixture omitted ${name}`)
  if (name === 'ak_session') ownerSessionCookie = match[1]
  return match[1]
}

function startInvitePowerShell(origin, invite, mode, cwd, extraEnv = {}, label) {
  return start('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `irm '${origin}/install/invite.ps1' | iex`], {
    HOST_URL: origin,
    KALA_RELEASE_BASE_URL: `${origin}/install/assets`,
    KALA_RELEASE_TRUST: 'host',
    EXECUTOR_INVITE: invite,
    KALA_INVITE_INSTALL_MODE: mode,
    ...extraEnv,
  }, label, cwd)
}

async function runInvitePowerShell(origin, invite, mode, cwd) {
  return await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `irm '${origin}/install/invite.ps1' | iex`], {
    cwd,
    env: {
      HOST_URL: origin,
      KALA_RELEASE_BASE_URL: `${origin}/install/assets`,
      KALA_RELEASE_TRUST: 'host',
      EXECUTOR_INVITE: invite,
      KALA_INVITE_INSTALL_MODE: mode,
    },
  })
}

function unitIdentityPath(unitId) { return join(hostDataRoot, 'tenant-runtime-units', unitId, 'executor-identities.json') }
function readUnitState(unitId) { return JSON.parse(readFileSync(unitIdentityPath(unitId), 'utf8')) }
function readWorkspaceId(unitId, inviteId) { return readUnitState(unitId).invites.find((entry) => entry.id === inviteId)?.workspaceId }
function executorState(unitId, workspaceId) { return readUnitState(unitId).executors.find((entry) => entry.workspaceId === workspaceId && !entry.revokedAt) }

async function waitForInviteState(unitId, inviteId, child) {
  return await waitFor(() => {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`temporary PowerShell invite installer exited before enrollment (code=${child.exitCode ?? 'signal'})`)
    const path = unitIdentityPath(unitId)
    if (!existsSync(path)) return false
    const state = readUnitState(unitId)
    const invite = state.invites?.find((entry) => entry.id === inviteId)
    const identity = invite?.workspaceId && state.executors?.find((entry) => entry.workspaceId === invite.workspaceId && !entry.revokedAt)
    return invite?.lastUsedAt && identity ? { state, invite, identity } : false
  }, 90_000, 'invite workspace binding, lastUsedAt, and device identity')
}

function assertDeviceCredential(state, workspaceId, credential) {
  if (!/^ak_exec_[A-Za-z0-9_-]+$/u.test(credential)) throw new Error('Executor did not replace the invite with a device token')
  const expectedHash = hashToken(credential)
  const identity = state.state.executors.find((entry) => entry.workspaceId === workspaceId && !entry.revokedAt)
  if (!identity || identity.tokenHash !== expectedHash) throw new Error('persisted device token is not active for the invited workspace')
}

async function waitForExecutor(workspaceId, expected, name) {
  if (!workspaceId) throw new Error(`${name} has no workspaceId`)
  await waitFor(async () => {
    const listed = await emitAcklessResponse(dashboard, 'client:list_executors', 'server:executors', {})
    return listed.executors.some((entry) => entry.workspaceId === workspaceId) === expected
  }, 45_000, name)
}

async function waitForServiceState(expected) {
  await waitFor(async () => {
    const result = await run('sc.exe', ['query', serviceName])
    return result.code === 0 && new RegExp(`STATE\\s*:\\s*\\d+\\s+${expected}`, 'u').test(result.stdout)
  }, 30_000, `SCM ${expected} state`)
}

async function uninstallService() {
  const installedExecutor = join(serviceInstallDir, 'kala-executor.cjs')
  const result = await run(process.execPath, [installedExecutor, 'service', 'uninstall'])
  const statusName = result.stdout.match(/Removal status file: (kala-executor-uninstall-[A-Za-z0-9]+\.status)/u)?.[1]
  if (result.code !== 0 || !statusName) throw new Error(`managed service uninstall was not scheduled (${summarizeResult(result)})`)
  const statusPath = join(tmpdir(), statusName)
  await waitFor(() => existsSync(statusPath) && readFileSync(statusPath, 'utf8') === 'removed' && !existsSync(serviceInstallDir) && !existsSync(serviceDataDir), 60_000, 'managed service self-removal')
  rmSync(statusPath, { force: true })
}

async function assertServiceAbsent() {
  const result = await run('sc.exe', ['query', serviceName])
  if (result.code === 0 || !result.stdout.includes('1060')) throw new Error('KalaExecutor service must be absent before and after the isolated invite E2E')
}

async function emergencyServiceCleanup() {
  try {
    if (existsSync(join(serviceInstallDir, 'kala-executor.cjs'))) {
      try {
        await uninstallService()
        console.error('Private Cloud invite E2E used managed service cleanup after failure')
        return
      } catch {
        // A partial install may not support self-uninstall; stop SCM before removing credentials.
      }
    }
    const query = await run('sc.exe', ['query', serviceName])
    if (query.code === 0) {
      if (!/STATE\s*:\s*\d+\s+STOPPED/u.test(query.stdout)) {
        const stopped = await run('sc.exe', ['stop', serviceName])
        if (stopped.code !== 0) throw new Error('SCM stop failed')
        await waitForServiceState('STOPPED')
      }
      const deleted = await run('sc.exe', ['delete', serviceName])
      if (deleted.code !== 0) throw new Error('SCM delete failed')
      await waitFor(async () => {
        const status = await run('sc.exe', ['query', serviceName])
        return status.code !== 0 && status.stdout.includes('1060')
      }, 30_000, 'SCM service deletion')
    } else if (!query.stdout.includes('1060')) {
      throw new Error('SCM service state could not be verified')
    }
    rmSync(serviceInstallDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(serviceDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    if (existsSync(serviceInstallDir) || existsSync(serviceDataDir)) throw new Error('managed service directories remain')
    console.error('Private Cloud invite E2E used emergency service cleanup after failure')
  } catch (error) {
    console.error(`Private Cloud invite E2E emergency cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

function start(file, args, env, label, cwd = root) {
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const record = { label, stdoutBytes: 0, stderrBytes: 0, signals: new Set() }
  diagnostics.push(record)
  observe(child.stdout, record, 'stdoutBytes')
  observe(child.stderr, record, 'stderrBytes')
  child.once('error', () => record.signals.add('spawn-error'))
  return child
}

function observe(stream, record, bytesKey) {
  stream.on('data', (chunk) => {
    record[bytesKey] += chunk.length
    const text = chunk.toString()
    for (const [name, pattern] of [['access-denied', /access denied|UnauthorizedAccessException/iu], ['missing-file', /cannot find|not found|FileNotFoundException/iu], ['credential-error', /Invalid Executor credential|auth_failed|workspace_identity_mismatch/iu], ['native-load-error', /Failed to load native module/iu]]) if (pattern.test(text)) record.signals.add(name)
    record.buffer = `${record.buffer ?? ''}${text}`.slice(-8192)
  })
}

async function waitForOutput(child, marker, timeoutMs, name) {
  await waitFor(() => {
    const record = diagnostics.find((entry) => entry.label === 'runtime-host')
    if (record?.buffer?.includes(marker)) return true
    if (child.exitCode !== null) throw new Error(`${name} process exited (${child.exitCode})`)
    return false
  }, timeoutMs, name)
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  })
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: options.cwd ?? root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options, env: { ...process.env, ...options.env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

function summarizeResult(result) {
  const output = `${result.stdout}\n${result.stderr}`
  return JSON.stringify({
    code: result.code, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
    downloadStarted: /Downloading verified Windows Executor assets/u.test(output),
    assetsVerified: /Windows ConPTY archive verified/u.test(output),
    nativeLaunchStarted: /Starting verified Windows Executor/u.test(output),
    inviteEnrollmentStarted: /Starting Private Cloud invite enrollment/u.test(output),
    inviteEnrolled: /Private Cloud invited device enrolled/u.test(output),
    serviceInstallStarted: /Installing Private Cloud Windows service/u.test(output),
    serviceStarted: /Windows service started and connected/u.test(output),
    elevationRejected: /requires an elevated Administrator/iu.test(output),
    existingInstallation: /Refusing to replace an existing Windows Executor installation/iu.test(output),
    enrollmentFailed: /Executor invite enrollment failed|Executor invite enrollment timed out/iu.test(output),
    accessDenied: /access denied|UnauthorizedAccessException/iu.test(output),
    missingFile: /cannot find|not found|FileNotFoundException/iu.test(output),
  })
}
function summarizeDiagnostics() { return diagnostics.map(({ label, stdoutBytes, stderrBytes, signals }) => ({ label, stdoutBytes, stderrBytes, signals: [...signals] })) }
function assertFiles(paths, label) { const missing = paths.filter((path) => !existsSync(path) || statSync(path).size === 0); if (missing.length) throw new Error(`${label} is incomplete (${missing.length} missing files)`) }
function once(socket, event, timeoutMs) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs); socket.once(event, (value) => { clearTimeout(timer); resolvePromise(value) }); socket.once('connect_error', () => { clearTimeout(timer); reject(new Error(`${event} failed before connection`)) }) }) }
function emitAcklessResponse(socket, requestEvent, responseEvent, payload) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${responseEvent} timed out`)), 15_000); socket.once(responseEvent, (value) => { clearTimeout(timer); resolvePromise(value) }); socket.emit(requestEvent, payload) }) }
async function waitFor(check, timeoutMs, name) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); } throw new Error(`${name} timed out`) }
async function reservePort() { const server = createServer(); await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolvePromise) => server.close(resolvePromise)); if (!port) throw new Error('could not reserve a loopback port'); return port }
