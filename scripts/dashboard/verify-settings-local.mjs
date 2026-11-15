#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import puppeteer from 'puppeteer-core'

// Fictional loopback HTTP authorities exercise the real Settings components.
// This is not native SILO, real OIDC, a Session authority, or public TLS evidence.
const root = resolve(import.meta.dirname, '../..')
const artifacts = resolve(root, '.settings-test-work/browser')
const profile = join(artifacts, `browser-profile-${process.pid}`)
await mkdir(artifacts, { recursive: true })
const requireDashboard = createRequire(resolve(root, 'packages/dashboard/package.json'))
const { createServer, transformWithEsbuild } = await import(requireDashboard.resolve('vite'))
const requireHost = createRequire(resolve(root, 'packages/host/package.json'))
const { Server: SocketServer } = await import(requireHost.resolve('socket.io'))
process.env.TMPDIR = artifacts
const { tsImport, register } = await import(requireHost.resolve('tsx/esm/api'))
const { KalaStateStore } = await tsImport(resolve(root, 'packages/host/src/store/state-store.ts'), import.meta.url)
const { attachJsonRoutes } = await tsImport(resolve(root, 'packages/host/src/http/routes.ts'), import.meta.url)
const { defaultAgentRuntimeSettings, agentSettingsSnapshot, updateAgentRuntimeSettings } = await tsImport(resolve(root, 'packages/host/src/runtime-config.ts'), import.meta.url)
const { createServer: createHttpServer } = await import('node:http')
const authorityRoot = join(artifacts, `authority-${process.pid}`)
await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
const authority = new KalaStateStore(authorityRoot)
const agentPath = join(authorityRoot, 'agent.json')
await writeFile(agentPath, JSON.stringify(defaultAgentRuntimeSettings()), { mode: 0o600 })
const agentSnapshot = () => agentSettingsSnapshot(agentPath, authority)
const agentValue = () => {
  const value = agentSnapshot().value
  return {
    agentSettingsResourceId: 'fixture-agent',
    agentPrompt: { configPath: 'fixture-agent', selectedSlotId: value.selectedSlotId, slots: value.slots },
    desktopAccess: { manualAuthorizationRequired: value.desktopManualAuthorizationRequired },
  }
}
const configurationAuthority = createHttpServer()
attachJsonRoutes(configurationAuthority, {
  models: [], defaultModel: '', auth: { requireIngressIdentity: true }, settingsWriteProtocol: 'conditional-required',
  settingsRevision: kind => kind === 'agent' ? agentSnapshot().revision : undefined,
  settingsConfiguration: section => section === 'agent' || section === 'execution' ? {
    resource: { kind: 'agent', id: 'runtime', organizationId: 'org_local' }, revision: agentSnapshot().revision,
    capabilities: [], value: section === 'agent' ? { agentPrompt: agentValue().agentPrompt }
      : { agentSettingsResourceId: 'fixture-agent', desktopAccess: agentValue().desktopAccess },
    application: { state: 'unknown', desiredRevision: agentSnapshot().revision, effectiveRevision: null,
      applyMode: 'next-turn', scope: 'unit', reasonCode: 'fictional_fixture_has_no_sessions' },
  } : undefined,
  updateAgentPrompt: (input, _actor, options) => {
    updateAgentRuntimeSettings(agentPath, current => ({ ...current, ...input }), authority, options)
    return { providers: [], defaultModel: '', hooks: [], ...agentValue() }
  },
  updateDesktopAccess: (input, _actor, options) => {
    updateAgentRuntimeSettings(agentPath, current => ({ ...current, desktopManualAuthorizationRequired: input.manualAuthorizationRequired }), authority, options)
    return { providers: [], defaultModel: '', hooks: [], ...agentValue() }
  },
})
const configurationRequests = []
const portableTargets = []
const portableRequests = []
let dashboardOrigin
async function openPortableTarget(name) {
  const directory = join(authorityRoot, `portable-${name}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const store = new KalaStateStore(directory)
  const path = join(directory, 'agent.json')
  const initial = defaultAgentRuntimeSettings()
  initial.slots = initial.slots.map((slot, index) => index ? slot : { ...slot, prompt: `Original Portable ${name}` })
  await writeFile(path, JSON.stringify(initial), { mode: 0o600 })
  const snapshot = () => agentSettingsSnapshot(path, store)
  const value = () => {
    const current = snapshot().value
    return { agentPrompt: { configPath: `portable-${name}`, selectedSlotId: current.selectedSlotId, slots: current.slots } }
  }
  const inner = createHttpServer()
  attachJsonRoutes(inner, {
    settingsLayout: 'unified',
    models: [], defaultModel: '', auth: { requireIngressIdentity: true }, settingsWriteProtocol: 'conditional-required',
    settingsRevision: kind => kind === 'agent' ? snapshot().revision : undefined,
    settingsConfiguration: section => section === 'agent' ? {
      resource: { kind: 'agent', id: 'runtime' }, revision: snapshot().revision,
      capabilities: [], value: value(), application: { state: 'unknown', desiredRevision: snapshot().revision,
        effectiveRevision: null, applyMode: 'next-turn', scope: 'device' },
    } : undefined,
    updateAgentPrompt: (input, _actor, options) => {
      updateAgentRuntimeSettings(path, current => ({ ...current, ...input }), store, options)
      return { providers: [], defaultModel: '', hooks: [], ...value() }
    },
  })
  const target = { name, token: `fictional-portable-${name}`, store, snapshot, origin: '', holdNextRead: false, deferred: [] }
  target.connectionPings = 0
  target.executorPings = 0
  target.controlEvents = []
  target.server = createHttpServer((request, response) => {
    response.setHeader('access-control-allow-origin', dashboardOrigin)
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    response.setHeader('access-control-allow-headers', 'authorization, content-type, if-match')
    response.setHeader('access-control-expose-headers', 'etag')
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return }
    const observation = { target: name, path: request.url, method: request.method,
      authorizationMatches: request.headers.authorization === `Bearer ${target.token}`,
      cookieSent: Boolean(request.headers.cookie), precondition: request.headers['if-match'] ?? null }
    portableRequests.push(observation)
    if (!observation.authorizationMatches) { response.writeHead(401).end(); return }
    if (request.url === '/settings/capabilities') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ product: 'portable', capabilities }))
      return
    }
    request.headers['x-agent-runlab-principal'] = `fictional-portable-${name}`
    request.headers['x-agent-runlab-organization-id'] = `fictional-portable-${name}`
    request.headers['x-agent-runlab-organization-role'] = 'owner'
    if (target.holdNextRead && request.method === 'GET' && request.url === '/settings/sections/agent') {
      target.holdNextRead = false
      observation.deferred = true
      response.once('close', () => { observation.cancelled = !response.writableEnded })
      target.deferred.push(() => { if (!response.destroyed) inner.emit('request', request, response) })
      return
    }
    inner.emit('request', request, response)
  })
  target.sockets = new SocketServer(target.server, { cors: { origin: dashboardOrigin } })
  target.sockets.of('/dashboard').use((socket, next) => {
    next(socket.handshake.auth.token === target.token ? undefined : new Error('fictional_target_credential_required'))
  }).on('connection', socket => {
    socket.onAny(event => target.controlEvents.push(event))
    socket.on('client:connection_ping', (_at, acknowledge) => {
      target.connectionPings++
      setTimeout(() => acknowledge(Date.now()), 12)
    })
    socket.on('client:executor_ping', (_workspaceId, acknowledge) => {
      target.executorPings++
      acknowledge({ rttMs: 23 })
    })
    for (const event of ['client:subscribe_channels', 'client:restore_subscriptions', 'client:refresh_channels']) {
      socket.on(event, (request, acknowledge) => acknowledge?.({
        requestId: request.requestId, generation: request.generation, accepted: request.channels, rejected: [], cursors: {},
      }))
    }
  })
  await new Promise(resolve => target.server.listen(0, '127.0.0.1', resolve))
  target.origin = `http://127.0.0.1:${target.server.address().port}`
  portableTargets.push(target)
  return target
}
let loseNextAgentResponse = false
let loseNextPolicyResponse = false
let loseNextWebhookResponse = false
let controlFixture
let controlLoader
const controlRequests = []
const docker = promisify(execFile)
async function openControlFixture(origin) {
  controlLoader = register({ namespace: `settings-control-fixture-${process.pid}` })
  const load = path => controlLoader.import(resolve(root, `packages/runtime-ingress-gateway/src/${path}.ts`), import.meta.url)
  const { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } = await load('persistence/postgres')
  const { PostgresOrganizationStore } = await load('organizations/postgres-store')
  const { FileBrowserSessionStore, browserSessionTokenHash } = await load('auth/browser-session-store')
  const { createSessionSecretBox } = await load('auth/session-secret-box')
  const { startRuntimeIngressGateway } = await load('edge/server')
  const { PostgresWebhookSettingsStore } = await load('webhooks/settings-store')
  const fixture = controlFixture = { container: `kala-settings-browser-${randomUUID()}`, actor: { issuer: 'https://fixture.test', subject: 'control-owner' } }
  const password = randomUUID()
  await docker('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', fixture.container,
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--env', `POSTGRES_PASSWORD=${password}`,
    '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
  const { stdout } = await docker('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', fixture.container])
  const database = fixture.database = createPostgresControlPlaneDatabase({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${stdout.trim()}/postgres` })
  for (let attempt = 0; ; attempt++) {
    try { await database.query('SELECT 1'); break } catch (error) {
      if (attempt === 59) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  await migrateControlPlane(database, await readControlPlaneMigrations(resolve(root, 'packages/runtime-ingress-gateway/migrations')))
  await database.query("INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_local','Browser fixture','active','local-unit')")
  await database.query("INSERT INTO principals(id,kind,issuer,subject) VALUES('prn_fixture_owner','human','https://fixture.test','control-owner')")
  await database.query("INSERT INTO organization_memberships(organization_id,principal_id,role) VALUES('org_local','prn_fixture_owner','owner')")
  await database.query(`INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,seat_limit,concurrent_session_limit)
    VALUES('org_local','browser-fixture','standard',now()-interval '1 day',now()+interval '1 day',10,10)`)
  await database.query("INSERT INTO retention_policies(organization_id,session_days,artifact_days,audit_days,deleted_resource_grace_days) VALUES('org_local',30,90,365,30)")
  await database.query("INSERT INTO workspaces(id,organization_id,name) VALUES('ws_browser','org_local','Registered browser workspace')")
  await database.query(`INSERT INTO executor_pools(id,organization_id,name,mode)
    SELECT 'pool_browser_'||n,'org_local','Registry pool '||n,'organization' FROM generate_series(1,55) n`)
  await database.query(`INSERT INTO executors(id,organization_id,pool_id,name,platform,status,last_seen_at)
    VALUES('exe_browser','org_local','pool_browser_1','Registered browser Native',
      '{"nativeExecutorId":"native-browser","nativeWorkspaceId":"ws_browser"}','active',now())`)
  fixture.store = new PostgresOrganizationStore(database)
  await database.query(`INSERT INTO organization_webhook_secret_bindings(id,organization_id,label,secret_ref)
    VALUES('browser_binding','org_local','Browser signing binding','bao:organizations/org_local/webhooks/browser#key')`)
  fixture.webhooks = new PostgresWebhookSettingsStore(database, {
    publicOrigin: origin, allowedOrigins: [origin], allowLoopbackHttp: true,
  })
  const sessions = new FileBrowserSessionStore(join(authorityRoot, 'control-sessions.json'))
  await sessions.load()
  fixture.cookie = randomBytes(32).toString('base64url')
  const now = Date.now()
  await sessions.create({ tokenHash: browserSessionTokenHash(fixture.cookie), identity: fixture.actor,
    cacheNamespace: 'local-fixture', device: { label: 'fictional browser' }, createdAt: now,
    idleExpiresAt: now + 3_600_000, absoluteExpiresAt: now + 7_200_000 })
  fixture.runtime = createHttpServer((request, response) => {
    response.writeHead(request.url === '/internal/health' ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url === '/internal/health'
      ? { ok: true, state: 'ready' } : { error: 'Runtime route not found' }))
  })
  await new Promise(resolve => fixture.runtime.listen(0, '127.0.0.1', resolve))
  fixture.gateway = await startRuntimeIngressGateway({
    port: 0, listenHost: '127.0.0.1', publicOrigin: origin, hostOrigin: `http://127.0.0.1:${fixture.runtime.address().port}`,
    dashboardOrigin: origin,
    settingsWriteProtocol: 'conditional-required', sessions, cacheNamespaceSecret: randomBytes(32).toString('base64url'),
    ingressSecret: randomBytes(32).toString('base64url'), organizations: fixture.store, webhooks: fixture.webhooks,
    directory: { async getOrCreateForIdentity(identity) { return { unitId: 'local-unit', identity } } },
    authentication: { kind: 'oidc', loginStates: { async put() {}, async take() {} },
      secretBox: createSessionSecretBox('fixture', [{ id: 'fixture', key: randomBytes(32) }]),
      oidc: { async authorizationUrl() { throw new Error('fictional fixture has no IdP') },
        async callback() { throw new Error('fictional fixture has no IdP') }, async refresh() { return {} }, async revokeRefreshToken() {} } },
  })
}
const requests = []
const capabilities = ['models.read', 'models.configure', 'agent.configure', 'execution-policy.configure', 'attachment-policy.configure', 'retention-policy.configure', 'workspace.browse', 'service-accounts.manage', 'silo.open', 'services.read', 'consoles.open', 'integrations.read', 'members.manage', 'ownership.transfer', 'webhooks.configure'].map(id => ({
  id, scope: 'organization', supported: true, canRead: true, canWrite: true, management: 'dashboard',
}))
let tokenActive = false
let siloReads = 0
const ownerTransfers = []
const account = { id: 'principal-fixture', name: 'Local test', scopes: ['organization:read'], createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null }
const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsPage } from '/src/features/settings/SettingsPage.tsx'
import { useAppSection } from '/src/app-shell/section.ts'
import { openSettings } from '/src/features/settings/routes.ts'
import { i18n } from '/src/i18n/index.ts'
import { ConnectionStatus } from '/src/app.tsx'
import { ChatPanel } from '/src/features/chat/ChatPanel.tsx'
import { PREF_MESSAGE_TIMESTAMPS } from '/src/lib/prefs.ts'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import { io } from 'socket.io-client'
import '/src/index.css'
const parameters = new URLSearchParams(location.search)
await i18n.changeLanguage(parameters.get('language') ?? 'en')
const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
function Fixture() {
  const [section] = useAppSection()
  const [targetIndex,setTargetIndex] = React.useState(0)
  const portable = window.location.pathname==='/portable-fixture'
  const target = portable ? window.__localPortableTargets[targetIndex] : undefined
  return <QueryClientProvider client={client}><main style={{height:'100vh'}}>
    {portable ? <><button data-testid="portable-target-a" onClick={()=>setTargetIndex(0)}>Target A</button><button data-testid="portable-target-b" onClick={()=>setTargetIndex(1)}>Target B</button></> : null}
    {section === 'settings' ? <SettingsPage cacheNamespace="local-fixture" product={portable?'portable':['/ownership-fixture','/webhook-fixture'].includes(window.location.pathname)?'private-cloud':'dedicated'}
      organization={portable?undefined:{id:'org_local', name:'Local fixture', role:'owner', status:'active'}}
      profile={{displayName:'Fixture Owner', initials:'F', email:'fixture@example.test'}}
      executors={[]} host={target?.origin??''} token={target?.token} deploymentServices={{observability:false,siloConsolePath:'/silo/'}} />
      : <button onClick={()=>openSettings()}>Open Settings</button>}
  </main></QueryClientProvider>
}
function ConnectionFixture() {
  const [socket] = React.useState(()=>io({path:'/__settings_socket',transports:['websocket']}))
  const [ready,setReady] = React.useState(socket.connected)
  React.useEffect(()=>{
    socket.on('connect',()=>setReady(true))
    socket.on('disconnect',()=>setReady(false))
    return ()=>socket.close()
  },[socket])
  return <ConnectionStatus socket={socket} status={ready?'ready':'connecting'} transport="websocket"
    cursor={0} workspaceId="fixture-workspace" executorConnected onResync={()=>{}}/>
}
function ChatFixture() {
  const variant = Number(parameters.get('variant') ?? 0)
  localStorage.setItem(PREF_MESSAGE_TIMESTAMPS, parameters.get('timestamps') ?? 'auto')
  const texts = ['OK', '移动端时间不应覆盖消息正文。'.repeat(12), 'First line\\nSecond line\\n第三行\\nFinal line', 'unbroken'.repeat(80)]
  const summary = { turnId:'fixture-turn',status:variant===3?'cancelled':'failed',startedAt:'2020-01-02T01:00:00Z',completedAt:'2020-01-02T01:00:04Z',wallDurationMs:4000,estimated:false,
    queueDurationMs:0,activeDurationMs:4000,approvalWaitMs:0,llm:{wallDurationMs:4000,requestCount:1,firstTokenMs:100},tools:{wallDurationMs:0,aggregateDurationMs:0,callCount:0,peakConcurrency:0,partial:false},compactionDurationMs:0,retryDurationMs:0,recoveryDurationMs:0}
  return <main style={{height:'100vh'}}><ChatPanel toolCardMode="standard"
    items={[{kind:'message',seq:1,operationId:'fixture-op',ts:'2020-01-02T01:00:00Z',message:{role:'user',content:[{type:'text',text:texts[variant]}]},...(variant===1||variant===3?{turnTiming:summary}:{})}]}
    scheduledMessageTasks={variant===1?{'fixture-op':'fixture-task'}:{}}
    onOpenScheduledTask={id=>{window.__openedSchedule=id}}
    onEditAndRerun={(seq,text)=>{window.__chatEdits={seq,text}}}
    displayPrefs={{fontSize:variant===1?8:3,contentWidth:1,sideSpace:0,lineHeight:2}} /></main>
}
createRoot(document.getElementById('root')).render(window.location.pathname==='/chat-fixture'?<ChatFixture/>:window.location.pathname==='/connection-fixture'?<ConnectionFixture/>:<React.StrictMode><Fixture/></React.StrictMode>)
`
const fixture = {
  name: 'local-settings-authorities',
  resolveId(id) { if (id === '/__settings_fixture.tsx') return '\0settings_fixture.tsx' },
  async load(id) { if (id === '\0settings_fixture.tsx') return (await transformWithEsbuild(source, 'settings_fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
      if (controlFixture?.gateway && (['/runtime/deployment/status', '/organization/retention', '/organization/attachment-policy', '/organization/attachment-policy/configuration', '/organization/webhook-secret-bindings', '/organization/webhooks'].includes(url.pathname)
        || url.pathname === '/organization/settings-view' && url.searchParams.get('section') !== 'members'
        || url.pathname.startsWith('/organization/webhooks/'))) {
        const observation = { method: request.method, path: url.pathname, precondition: request.headers['if-match'] ?? null }
        controlRequests.push(observation)
        response.once('finish', () => { observation.status = response.statusCode })
        const loseWebhook = loseNextWebhookResponse && request.method === 'PATCH' && url.pathname.startsWith('/organization/webhooks/')
        if (loseNextPolicyResponse && request.method === 'PUT' || loseWebhook) {
          loseNextPolicyResponse = false
          if (loseWebhook) loseNextWebhookResponse = false
          let partial = false
          let truncated = false
          const writeHead = response.writeHead
          const end = response.end
          response.writeHead = function (status, ...arguments_) {
            if (status !== (loseWebhook ? 200 : 204)) return writeHead.call(this, status, ...arguments_)
            partial = true
            return writeHead.call(this, 200, { 'content-type': 'application/json', 'content-length': '512', 'cache-control': 'no-store' })
          }
          response.end = function (...arguments_) {
            if (!partial) return end.apply(this, arguments_)
            if (truncated) return this
            truncated = true
            this.write('{"')
            setTimeout(() => this.destroy(), 25)
            return this
          }
        }
        controlFixture.gateway.http.emit('request', request, response)
        return
      }
      if (['/settings/sections/agent', '/settings/sections/execution', '/settings/agent-prompt', '/settings/desktop-access'].includes(url.pathname)) {
        requests.push(url.pathname)
        const observation = { method: request.method, path: url.pathname, precondition: request.headers['if-match'] ?? null }
        configurationRequests.push(observation)
        response.once('finish', () => { observation.status = response.statusCode })
        response.once('close', () => { observation.closed = true })
        request.headers['x-agent-runlab-principal'] = 'fictional-owner'
        request.headers['x-agent-runlab-organization-id'] = 'org_local'
        request.headers['x-agent-runlab-organization-role'] = 'owner'
        if (loseNextAgentResponse && request.method === 'POST' && url.pathname === '/settings/agent-prompt') {
          loseNextAgentResponse = false
          response.end = function () {
            this.write('{"')
            setTimeout(() => this.destroy(), 25)
            return this
          }
        }
        configurationAuthority.emit('request', request, response)
        return
      }
      if (url.pathname === '/legacy-console-worker.js') {
        response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
        response.end(`self.addEventListener('install',event=>event.waitUntil(caches.open('ak-legacy-console-repro').then(cache=>cache.add('/legacy-console-shell')).then(()=>self.skipWaiting())));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{const path=new URL(event.request.url).pathname;if(event.request.mode==='navigate'&&(path.startsWith('/silo/')||path==='/auth/silo/open'))event.respondWith(caches.match('/legacy-console-shell'))})`)
        return
      }
      if (url.pathname === '/legacy-console-shell') {
        response.setHeader('content-type', 'text/html')
        void server.transformIndexHtml('/', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>').then(html => response.end(html))
        return
      }
      if (url.pathname === '/fixture' || url.pathname === '/chat-fixture' || url.pathname === '/connection-fixture' || url.pathname === '/ownership-fixture' || url.pathname === '/portable-fixture' || url.pathname === '/webhook-fixture') {
        response.setHeader('set-cookie', `fixture_product=${['/ownership-fixture', '/webhook-fixture'].includes(url.pathname) ? 'private-cloud' : 'dedicated'}; Path=/; HttpOnly; SameSite=Strict`)
        response.setHeader('content-type', 'text/html')
        void server.transformIndexHtml('/fixture', `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.__localPortableTargets=${JSON.stringify(portableTargets.map(({origin,token})=>({origin,token})))}</script><script type="module" src="/__settings_fixture.tsx"></script></body></html>`).then(html => response.end(html))
        return
      }
      if (url.pathname === '/settings/capabilities' || url.pathname === '/organization/capabilities') {
        requests.push(url.pathname)
        const privateCloud = request.headers.cookie?.includes('fixture_product=private-cloud')
        json({ product: privateCloud ? 'private-cloud' : 'dedicated', organizationId: 'org_local',
          capabilities: capabilities.filter(capability => capability.id !== 'webhooks.configure' || privateCloud && controlFixture) })
        return
      }
      if (url.pathname === '/organization/settings-view' && url.searchParams.get('section') === 'members') {
        json({ members: [
          { issuer: 'https://fixture.test', subject: 'current-owner', displayName: 'Current Owner', role: 'owner', createdAt: '2026-01-01' },
          { issuer: 'https://fixture.test', subject: 'next-owner', displayName: 'Next Owner', role: 'member', createdAt: '2026-01-01' },
        ], invites: [] })
        return
      }
      if (url.pathname === '/organization/ownership' && request.method === 'POST') {
        let body = ''
        request.on('data', chunk => { body += chunk })
        request.on('end', () => { ownerTransfers.push(JSON.parse(body)); response.writeHead(204).end() })
        return
      }
      if (url.pathname === '/auth/login') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        response.end('<!doctype html><h1>Fictional reauthentication entrance</h1>')
        return
      }
      if (url.pathname.startsWith('/settings/sections/')) {
        requests.push(url.pathname)
        json({ providers: [], defaultModel: '', ...(url.pathname === '/settings/sections/services' ? {
          configurationSources: [{ id: 'agent', sourceRef: 'fixture.actual-sqlite-serialized-agent-json',
            management: 'dashboard', revision: agentSnapshot().revision, effectiveRevision: null,
            observedAt: new Date().toISOString() }],
        } : {}) })
        return
      }
      if (url.pathname === '/api/v1/service-accounts') {
        requests.push(`${request.method} ${url.pathname}`)
        if (request.method === 'POST') { tokenActive = true; json({ ...account, token: 'fictional-loopback-token' }, 201) }
        else json({ items: tokenActive || account.revokedAt ? [account] : [], limits: { scopes: ['organization:read', 'audit:read'], maxNameLength: 200, defaultExpirationMs: 90 * 86_400_000, maxExpirationMs: 365 * 86_400_000 } })
        return
      }
      if (url.pathname === '/api/v1/service-accounts/principal-fixture' && request.method === 'DELETE') {
        requests.push(`${request.method} ${url.pathname}`)
        tokenActive = false; account.revokedAt = new Date().toISOString()
        response.writeHead(204).end()
        return
      }
      if (url.pathname === '/themes/marketplace/search') {
        json({ results: [] })
        return
      }
      if (url.pathname === '/auth/silo/open') {
        response.writeHead(303, { location: '/silo/', 'cache-control': 'no-store' }).end()
        return
      }
      if (url.pathname === '/silo/') {
        siloReads++
        response.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'self';" })
        response.end('<!doctype html><title>SILO Console</title><base href="/silo/"><h1>Local native-document fixture</h1><input aria-label="Fixture draft">')
        return
      }
      if (/^\/(?:auth|models|settings|runtime|organization|api|v2|docs|artifacts|eval|enhancement|router|admin)(?:\/|$)/u.test(url.pathname)) {
        // Never let an unimplemented fixture API fall through to the developer's
        // configured Runtime proxy, even if another local service is listening.
        json({ error: 'fixture_route_unavailable' }, 404)
        return
      }
      next()
    })
  },
}
let server, browser, socketServer
const rtt = { hostRequests: 0, executorRequests: 0 }
const evidence = { fixture: 'fictional-loopback-HTTP-with-real-Portable-SQLite-and-HTTP-preconditions', sandbox: true, checks: [], requests, configurationRequests, portableRequests, controlRequests, errors: [] }
try {
  server = await createServer({
    root: resolve(root, 'packages/dashboard'), configFile: resolve(root, 'packages/dashboard/vite.config.ts'), plugins: [fixture],
    // Crawl the actual App before exercising forms; late dependency discovery would
    // otherwise trigger a development-only full-page reload midway through a mutation.
    optimizeDeps: { entries: ['index.html'], include: ['@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-web-links', '@xterm/xterm', 'monaco-editor'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  socketServer = new SocketServer(server.httpServer, { path: '/__settings_socket', transports: ['websocket'] })
  socketServer.on('connection', socket => {
    socket.on('client:connection_ping', (_sentAt, ack) => { rtt.hostRequests++; ack(Date.now()) })
    socket.on('client:executor_ping', (_workspaceId, ack) => { rtt.executorRequests++; ack({ rttMs: 7 }) })
  })
  const address = server.httpServer.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  dashboardOrigin = origin
  if (process.env.KALA_RUN_POSTGRES_INTEGRATION === '1') await openControlFixture(origin)
  await openPortableTarget('A')
  await openPortableTarget('B')
  browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
    userDataDir: profile, headless: true,
    env: { ...process.env, TMPDIR: artifacts },
    args: ['--disable-dev-shm-usage', '--disable-background-networking'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(30_000)
  page.on('pageerror', error => evidence.errors.push(error.message))
  if (controlFixture) await page.setCookie({ url: origin, name: 'ak_session', value: controlFixture.cookie, httpOnly: true, sameSite: 'Strict' })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin || portableTargets.some(target => target.origin === url.origin)) void request.continue()
    else void request.abort()
  })
  const chatPage = await browser.newPage()
  chatPage.on('pageerror', error => evidence.errors.push(error.message))
  const chatCdp = await chatPage.createCDPSession()
  for (const language of ['en', 'zh']) {
    await chatCdp.send('Emulation.setLocaleOverride', { locale: language === 'zh' ? 'zh-CN' : 'en-US' })
    for (const width of [320, 390, 768, 1440]) {
      await chatPage.setViewport({ width, height: 900 })
      for (const variant of [0, 1, 2, 3]) {
        const timestamps = variant === 3 ? 'hidden' : variant === 0 ? 'auto' : 'always'
        await chatPage.goto(`${origin}/chat-fixture?language=${language}&variant=${variant}&timestamps=${timestamps}`)
        await chatPage.waitForSelector('[data-testid="user-message-surface"]')
        await chatPage.evaluate(() => document.fonts.ready)
        const geometry = await chatPage.evaluate(() => {
          const bubble = document.querySelector('[data-testid="user-message-surface"]').getBoundingClientRect()
          const metadata = document.querySelector('[data-testid="user-message-metadata"]').getBoundingClientRect()
          const timestamp = document.querySelector('[data-testid="message-timestamp"]')?.getBoundingClientRect()
          return {
            separated: metadata.top >= bubble.bottom && (!timestamp || timestamp.top >= bubble.bottom),
            fits: metadata.left >= 0 && metadata.right <= innerWidth + 1,
            timestampFits: !timestamp || timestamp.left >= 0 && timestamp.right <= innerWidth + 1,
            hasTimestamp: Boolean(timestamp), shortBubbleWidth: bubble.width,
          }
        })
        assert(geometry.separated && geometry.fits && geometry.timestampFits, `message/footer intersection or clipping: ${JSON.stringify({ language, width, variant, geometry })}`)
        assert.equal(geometry.hasTimestamp, timestamps !== 'hidden')
        if (variant === 0) assert(geometry.shortBubbleWidth < 100, 'metadata must not widen a short message bubble')
        if (width <= 390 && variant === 1) await chatPage.screenshot({ path: join(artifacts, `chat-footer-${language}-${width}.png`) })
      }
    }
  }
  await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  await chatPage.goto(`${origin}/chat-fixture?variant=0`)
  await chatPage.bringToFront()
  await chatPage.evaluate(() => navigator.clipboard.writeText('fixture clipboard reset'))
  await chatPage.waitForSelector('[data-testid="copy-message"]')
  await chatPage.click('[data-testid="copy-message"]')
  await chatPage.waitForFunction(() => document.querySelector('[data-testid="copy-message"]')?.getAttribute('aria-label') === 'Copied')
  assert.equal(await chatPage.evaluate(() => navigator.clipboard.readText()), 'OK')
  await chatPage.click('[data-testid="edit-message-0"]')
  await chatPage.waitForSelector('[data-testid="edit-message-input-0"]')
  await chatPage.focus('[data-testid="edit-message-input-0"]')
  await chatPage.keyboard.down('Control')
  await chatPage.keyboard.press('A')
  await chatPage.keyboard.up('Control')
  await chatPage.type('[data-testid="edit-message-input-0"]', 'OK edited')
  await chatPage.click('[data-testid="edit-message-submit-0"]')
  assert.deepEqual(await chatPage.evaluate(() => window.__chatEdits), { seq: 1, text: 'OK edited' })
  await chatPage.close()
  evidence.checks.push('32 actual ChatPanel geometry cases at320/390/768/1440px cover English/Chinese, short/multiline/unbroken text, large font, historical dates, scheduled/failed/cancelled metadata and auto/always/hidden timestamps; copy/edit retain the exact fictional message')
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${origin}/fixture?preserved=yes#/settings/personal/interface`)
  await page.waitForSelector('[data-testid="settings-page"]')
  await page.waitForFunction(() => document.querySelectorAll('.ak-settings-nav-row').length > 8)
  assert.equal(await page.evaluate(() => {
    const item = document.querySelector('.ak-settings-nav-row')
    return [...document.querySelectorAll('.ak-settings-sidebar h2')].every(heading =>
      Number.parseFloat(getComputedStyle(heading).fontSize) > Number.parseFloat(getComputedStyle(item).fontSize))
  }), true, 'Settings group titles must be larger than their navigation items')
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ak-settings-nav-row')].some(item => /SILO|This device/u.test(item.textContent))), false)
  for (const width of [320, 390]) {
    await page.setViewport({ width, height: 844 })
    const clippedControls = await page.$$eval('.ak-settings-task input, .ak-settings-task select, .ak-settings-task button', elements => elements.flatMap(element => {
      if (element.closest('details:not([open])') || !element.getClientRects().length) return []
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth + 1 ? [] : [{ testId: element.dataset.testid, tag: element.tagName, label: element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 60), left: bounds.left, right: bounds.right, width: bounds.width }]
    }))
    if (clippedControls.length) await page.screenshot({ path: join(artifacts, `appearance-clipped-${width}.png`) })
    assert.deepEqual(clippedControls, [], 'actual Appearance controls must fit, not merely be clipped inside a non-overflowing page')
  }
  assert.equal(await page.$eval('.ak-settings-task h3', heading => heading.getBoundingClientRect().height > 0), true, 'mobile tasks must retain their section heading')
  assert.equal(await page.$eval('.ak-settings-picker select', select => select.getBoundingClientRect().height >= 44), true)
  await page.screenshot({ path: join(artifacts, 'appearance-mobile.png') })
  await page.setViewport({ width: 1440, height: 900 })
  evidence.checks.push('short functional navigation, larger group titles, visible mobile task headings and44px mobile picker')
  assert(!requests.some(path => path.startsWith('/settings/sections/')))
  evidence.checks.push('personal page does not load organization settings payloads')
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    window.restoreFixtureStorage = () => { Storage.prototype.setItem = original }
    Storage.prototype.setItem = function(key, value) {
      if (key === 'ak-show-tool-call-tab') throw new DOMException('Fixture quota failure', 'QuotaExceededError')
      return original.call(this, key, value)
    }
  })
  await page.click('[data-testid="settings-toggle-tool-call-tab"]')
  await page.waitForSelector('[data-testid="settings-preference-error"]')
  assert.equal(await page.$eval('[data-testid="settings-toggle-tool-call-tab"]', element => element.getAttribute('aria-checked')), 'true')
  assert.equal(await page.evaluate(() => localStorage.getItem('ak-show-tool-call-tab')), null)
  await page.evaluate(() => { window.restoreFixtureStorage(); delete window.restoreFixtureStorage })
  await page.click('[data-testid="settings-toggle-tool-call-tab"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-preference-error"]'))
  await page.waitForSelector('[data-testid="settings-toggle-tool-call-tab"][aria-checked="false"]')
  assert.equal(await page.evaluate(() => localStorage.getItem('ak-show-tool-call-tab')), '0')
  await page.reload()
  await page.waitForSelector('[data-testid="settings-toggle-tool-call-tab"][aria-checked="false"]')
  evidence.checks.push('real browser storage failure is visible without applying the preference; explicit retry survives reload')
  await page.evaluate(() => { window.location.hash = '#/settings/deployment/configuration' })
  await page.waitForFunction(() => document.body.textContent.includes('fixture.actual-sqlite-serialized-agent-json'))
  assert.equal(await page.$eval('.ak-settings-task article', element => element.textContent.includes('Not observed')), true)
  assert.equal(await page.$eval('.ak-settings-task article', (element, revision) => element.textContent.includes(revision), agentSnapshot().revision), true)
  assert(requests.includes('/settings/sections/services'))
  assert(!requests.includes('/settings'))
  evidence.checks.push('deployment configuration renders a page-projected actual authority revision without inventing an effective consumer or a broad snapshot')
  if (controlFixture) {
    await page.evaluate(() => { window.location.hash = '#/settings/deployment/services' })
    await page.waitForSelector('[data-testid="settings-external-deployment"]')
    assert(controlRequests.some(request => request.path === '/runtime/deployment/status' && request.status === 200))
    assert.equal(await page.$('[data-testid="settings-dedicated-deployment"]'), null)
    evidence.checks.push('actual Gateway canonical deployment status renders external readiness for a fictional Compose-style Native HTTP fixture, without inventing supervisor slots or surfacing its unsupported route as404')
  }
  await page.evaluate(() => { window.location.hash = '#/settings/organization/models/providers' })
  await page.waitForFunction(() => document.body.textContent.includes('Providers'))
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => /add provider/i.test(button.textContent)))
  assert(requests.includes('/settings/sections/models'))
  assert(!requests.includes('/settings'))
  evidence.checks.push('active models page uses projected HTTP data, not broad settings snapshot')
  await page.evaluate(() => { window.location.hash = '#/settings/organization/models/prompts' })
  await page.waitForSelector('[data-testid="settings-agent-slot-prompt"]')
  const replacePrompt = async value => {
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="settings-agent-slot-prompt"]')
      return input && !input.disabled && !input.readOnly
    })
    await page.focus('[data-testid="settings-agent-slot-prompt"]')
    await page.keyboard.down('Control')
    await page.keyboard.press('A')
    await page.keyboard.up('Control')
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="settings-agent-slot-prompt"]')
      return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length
    })
    await page.keyboard.type(value)
    assert.equal(await page.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), value)
  }
  await replacePrompt('Browser retained conflict draft')
  updateAgentRuntimeSettings(agentPath, current => ({ ...current, slots: current.slots.map((slot, index) => index ? slot : { ...slot, prompt: 'Concurrent server version' }) }), authority)
  await page.click('[data-testid="settings-agent-slot-save"]')
  await page.waitForFunction(() => document.body.textContent.includes('The server version changed'))
  assert.equal(await page.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Browser retained conflict draft')
  assert.equal(agentSnapshot().value.slots[0].prompt, 'Concurrent server version')
  assert.equal(configurationRequests.filter(item => item.method === 'POST').at(-1).status, 412)
  evidence.checks.push('real browser sends If-Match; actual Host HTTP and SQLite reject a concurrent edit without losing the browser draft')
  const reloadVersion = async () => {
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload server version').click())
    await page.waitForSelector('[role="alertdialog"]')
    await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Reload server version').click())
    await page.waitForSelector('[data-testid="settings-agent-slot-prompt"]')
  }
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload server version').click())
  await page.waitForSelector('[role="alertdialog"]')
  await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Cancel').click())
  assert.equal(await page.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Browser retained conflict draft')
  await reloadVersion()
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-agent-slot-prompt"]')?.value === 'Concurrent server version')
  await replacePrompt('Browser committed prompt')
  await page.click('[data-testid="settings-agent-slot-save"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-agent-slot-save"]')?.disabled
    && document.body.textContent.includes('Saved · Not verified'))
  assert.equal(agentSnapshot().value.slots[0].prompt, 'Browser committed prompt')
  assert.equal(agentSnapshot().revision, '3')
  evidence.checks.push('explicit conflict reload is cancellable, then rereads the authority and commits against the fresh revision without claiming Session application')
  await replacePrompt('Committed with response lost')
  loseNextAgentResponse = true
  const submissionsBeforeLoss = configurationRequests.filter(item => item.method === 'POST').length
  await page.click('[data-testid="settings-agent-slot-save"]')
  await page.waitForFunction(() => document.body.textContent.includes('The response was lost'))
  assert.equal(agentSnapshot().revision, '4')
  assert.equal(agentSnapshot().value.slots[0].prompt, 'Committed with response lost')
  assert.equal(await page.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Committed with response lost')
  assert.equal(configurationRequests.filter(item => item.method === 'POST').length, submissionsBeforeLoss + 1)
  await reloadVersion()
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-agent-slot-prompt"]')?.value === 'Committed with response lost'
    && document.querySelector('[data-testid="settings-agent-slot-save"]')?.disabled)
  evidence.checks.push('actual post-commit HTTP response loss reports outcome unknown, retains the draft and never replays the committed SQLite mutation')
  if (controlFixture) {
    const labels = await page.evaluate(async () => {
      const { i18n } = await import('/src/i18n/index.ts')
      return Object.fromEntries(['editSessionRetention', 'reviewRetentionChange', 'applySessionRetention'].map(key => [key, i18n.t(`admin.${key}`)]))
    })
    const clickLabel = label => page.evaluate(label => [...document.querySelectorAll('button')].find(button => button.textContent === label && button.getClientRects().length).click(), label)
    const changeDays = async days => {
      await page.focus('#admin-session-retention-days')
      await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control')
      await page.type('#admin-session-retention-days', days)
    }
    const submitPolicy = async () => { await clickLabel(labels.reviewRetentionChange); await page.waitForSelector('[role="alertdialog"]'); await clickLabel(labels.applySessionRetention) }
    const policy = { sessionDays: 60, artifactDays: 90, auditDays: 365, deletedResourceGraceDays: 30 }
    await page.evaluate(() => { window.location.hash = '#/settings/organization/policies/retention' })
    await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent === label), {}, labels.editSessionRetention)
    await clickLabel(labels.editSessionRetention)
    await changeDays('45')
    await controlFixture.store.updateRetentionPolicy('org_local', policy, { expectedRevision: '1', actor: controlFixture.actor })
    await submitPolicy()
    await page.waitForFunction(() => document.body.textContent.includes('The server version changed'))
    assert.equal(await page.$eval('#admin-session-retention-days', element => element.value), '45')
    assert.equal((await controlFixture.store.retentionConfiguration('org_local')).revision, '2')
    evidence.checks.push('real Gateway handler and PostgreSQL reject browser retention CAS against a concurrent writer and retain the draft')
    const beforeReload = controlRequests.length
    page.once('dialog', dialog => dialog.dismiss())
    await clickLabel('Reload server version')
    assert.equal(controlRequests.length, beforeReload)
    assert.equal(await page.$eval('#admin-session-retention-days', element => element.value), '45')
    page.once('dialog', dialog => dialog.accept())
    await clickLabel('Reload server version')
    await page.waitForSelector('#admin-session-retention-days', { hidden: true })
    await clickLabel(labels.editSessionRetention)
    await changeDays('75')
    await submitPolicy()
    await page.waitForSelector('#admin-session-retention-days', { hidden: true })
    assert.deepEqual(await controlFixture.store.retentionConfiguration('org_local'), { revision: '3', value: { ...policy, sessionDays: 75 } })
    evidence.checks.push('confirmed policy reconstruction reloads the actual PostgreSQL revision; the next retained-form save commits without claiming cleaner application')
    await clickLabel(labels.editSessionRetention)
    await changeDays('90')
    const beforeLoss = controlRequests.filter(request => request.method === 'PUT').length
    loseNextPolicyResponse = true
    await submitPolicy()
    await page.waitForFunction(() => document.body.textContent.includes('The response was lost'))
    assert.equal((await controlFixture.store.retentionConfiguration('org_local')).revision, '4')
    assert.equal(await page.$eval('#admin-session-retention-days', element => element.value), '90')
    assert.equal(controlRequests.filter(request => request.method === 'PUT').length, beforeLoss + 1)
    page.once('dialog', dialog => dialog.accept())
    await clickLabel('Reload server version')
    await page.waitForSelector('#admin-session-retention-days', { hidden: true })
    evidence.checks.push('actual committed PostgreSQL policy plus truncated HTTP response is outcome-unknown; no mutation replay occurs')
    await page.screenshot({ path: join(artifacts, 'retention-real-postgres.png') })
    await page.evaluate(() => { window.location.hash = '#/settings/organization/policies/attachments' })
    await page.waitForSelector('#admin-attachment-limit')
    await page.select('#admin-attachment-limit', String(8 * 1024 * 1024))
    const attachmentLabel = await page.evaluate(async () => (await import('/src/i18n/index.ts')).i18n.t('attachmentPolicy.save'))
    await page.evaluate(() => {
      window.__settingsAttachmentSaveFinished = false
      window.addEventListener('kala:attachment-policy-updated', () => { window.__settingsAttachmentSaveFinished = true }, { once: true })
    })
    await clickLabel(attachmentLabel)
    await page.waitForFunction(label => window.__settingsAttachmentSaveFinished
      && [...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled, {}, attachmentLabel)
    assert.deepEqual(await controlFixture.store.attachmentConfiguration('org_local'), { revision: '2', value: { maxBytes: 8 * 1024 * 1024 } })
    assert(controlRequests.some(request => request.path === '/organization/attachment-policy' && request.method === 'PUT' && request.precondition && request.status === 204))
    evidence.checks.push('reused attachment form sends a scoped conditional request through the real Gateway handler and updates the actual PostgreSQL value/revision')
    await page.evaluate(() => { window.location.hash = '#/settings/organization/workspaces' })
    await page.waitForFunction(() => document.body.textContent.includes('Registered browser Native'))
    await clickLabel('Load more')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="settings-pool-list"] h3')].filter(element => /^Registry pool /u.test(element.textContent)).length === 55)
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-testid="settings-device-list"] li')].find(element => element.querySelector('h3')?.textContent === 'Registered browser Native')?.textContent.includes('Not observed')), true)
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewport({ width, height: 900 })
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-testid="settings-workspace-list"], [data-testid="settings-pool-list"], [data-testid="settings-device-list"]')].every(list => {
        const bounds = list.getBoundingClientRect()
        return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1
      })), true, 'workspace, pool and device cards must fit the actual task viewport')
      await page.$eval('[data-testid="settings-workspace-list"]', element => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: join(artifacts, `workspaces-directory-${width}.png`) })
      await page.$eval('[data-testid="settings-device-list"]', element => element.scrollIntoView({ block: 'end' }))
      assert.equal(await page.$eval('[data-testid="settings-device-list"]', element => {
        const bounds = element.getBoundingClientRect()
        return bounds.bottom <= innerHeight && bounds.top >= 0
      }), true, 'last directory section must be reachable inside the task scroller')
      if (width === 390) await page.screenshot({ path: join(artifacts, 'devices-directory-390.png') })
    }
    await clickLabel('Registered browser workspace')
    await page.waitForFunction(() => document.querySelector('.ak-settings-task h2')?.textContent === 'Registered browser workspace')
    assert(controlRequests.some(request => request.path === '/organization/settings-view' && request.status === 200))
    evidence.checks.push('actual Gateway/PostgreSQL paged pool directory retains all55 pools, displays historical registration without inventing liveness, and opens an exact scoped workspace detail')
    await page.screenshot({ path: join(artifacts, 'workspace-real-registry.png') })
  }
  await page.evaluate(() => { window.location.hash = '#/settings/organization/access/service-accounts' })
  await page.waitForSelector('input[maxlength="200"]')
  await page.type('input[maxlength="200"]', 'Local test')
  await page.click('input[type="checkbox"]')
  await page.click('button[type="submit"]')
  await page.waitForSelector('textarea[readonly]')
  await page.evaluate(() => { window.location.hash = '#/settings/deployment/storage' })
  await page.waitForSelector('[role="alertdialog"]')
  await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Cancel').click())
  assert(await page.$('textarea[readonly]'))
  evidence.checks.push('one-time service-account result survives canceled navigation')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('stored the Token')).click())
  page.once('dialog', dialog => dialog.accept())
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Revoke')).click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Revoke') && button.disabled))
  assert(!tokenActive)
  assert(requests.includes('DELETE /api/v1/service-accounts/principal-fixture'))
  evidence.checks.push('revoke targets returned principal identity through real HTTP')
  await page.evaluate(() => { window.location.hash = '#/settings/deployment/storage' })
  const dialog = await page.$('[role="alertdialog"]')
  if (dialog) await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent !== 'Cancel').click())
  await page.waitForSelector('[data-testid="settings-open-silo"]')
  assert.equal(await page.$('[data-testid="settings-silo"] iframe'), null)
  const firstReads = siloReads
  for (const width of [831, 832, 1100, 1440, 390]) {
    await page.setViewport({ width, height: 900 })
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(siloReads, firstReads, 'opening or resizing Settings must not load the native application')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `horizontal overflow at ${width}`)
    await page.screenshot({ path: join(artifacts, `settings-${width}.png`) })
  }
  evidence.checks.push('storage launch and independent-login guidance fit real responsive widths without embedding or loading the native application')
  assert.equal(new URL(page.url()).search, '?preserved=yes')
  evidence.checks.push('hash navigation preserves the entry query')
  const connectionPage = await browser.newPage()
  connectionPage.setDefaultTimeout(30_000)
  connectionPage.on('pageerror', error => evidence.errors.push(error.message))
  await connectionPage.setRequestInterception(true)
  connectionPage.on('request', request => {
    const url = new URL(request.url())
    if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin) void request.continue()
    else void request.abort()
  })
  await connectionPage.goto(`${origin}/connection-fixture`)
  await connectionPage.waitForFunction(() => document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') === 'ready')
  assert.equal(rtt.hostRequests, 1)
  assert.equal(rtt.executorRequests, 1)
  await connectionPage.click('[data-testid="connection-status"]')
  const headline = await connectionPage.$eval('[data-testid="connection-headline-latency"]', element => element.textContent)
  const hostSegment = await connectionPage.$eval('[data-testid="connection-segment-device-service"]', element => element.textContent)
  assert.equal(headline, hostSegment, 'the headline is the service RTT, not a sum including the synthetic Executor')
  assert.equal(await connectionPage.$('[data-testid="connection-sample-freshness"]'), null)
  assert.equal(await connectionPage.$eval('[data-testid="connection-status-popover"]', element => element.innerText.includes('Independent application RTTs')), false)
  await connectionPage.hover('[data-testid="connection-health-help"]')
  await connectionPage.waitForSelector('[role="tooltip"]')
  assert(await connectionPage.$eval('[role="tooltip"]', element => element.innerText.includes('Independent application RTTs') && element.innerText.includes('This open panel samples')))
  await connectionPage.mouse.move(0, 0)
  await connectionPage.waitForSelector('[role="tooltip"]', { hidden: true })
  evidence.checks.push('connection explanations and sample timestamps stay hidden until the actual information icon is hovered')
  await connectionPage.waitForFunction(() => document.querySelectorAll('[data-testid="connection-health-host-marker"]').length >= 2, { timeout: 10_000 })
  assert.equal(rtt.hostRequests, 2)
  assert.equal(rtt.executorRequests, 2)
  evidence.checks.push('real loopback WebSocket ACKs show independent RTTs with one shared five-second diagnostic sample')
  await connectionPage.screenshot({ path: join(artifacts, 'connection-diagnostics.png') })
  await connectionPage.click('[data-testid="connection-status"]')
  const closedCount = rtt.hostRequests
  await new Promise(resolve => setTimeout(resolve, 5_500))
  assert.equal(rtt.hostRequests, closedCount)
  assert.equal(rtt.executorRequests, closedCount)
  evidence.checks.push('closing real browser diagnostics stops application probes while the WebSocket stays connected')
  evidence.rtt = { ...rtt, route: 'loopback WebSocket; synthetic Executor; not public-ingress diagnosis' }
  await connectionPage.goto(`${origin}/ownership-fixture#/settings/organization/members`)
  await connectionPage.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Transfer ownership'))
  await connectionPage.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Transfer ownership').click())
  await connectionPage.waitForSelector('[role="alertdialog"]')
  await connectionPage.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Cancel').click())
  assert.equal(ownerTransfers.length, 0)
  await connectionPage.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Transfer ownership').click())
  await connectionPage.waitForSelector('[role="alertdialog"]')
  await Promise.all([
    connectionPage.waitForNavigation(),
    connectionPage.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Transfer ownership').click()),
  ])
  assert.equal(new URL(connectionPage.url()).pathname, '/auth/login')
  assert.equal(new URL(connectionPage.url()).search, '?prompt=login')
  assert.deepEqual(ownerTransfers, [{ issuer: 'https://fixture.test', subject: 'next-owner' }])
  evidence.checks.push('Owner transfer cancellation does not mutate; confirmed existing-member HTTP operation reaches reauthentication without an unload trap')
  const portablePage = await browser.newPage()
  portablePage.on('pageerror', error => evidence.errors.push(error.message))
  await portablePage.setRequestInterception(true)
  portablePage.on('request', request => {
    const url = new URL(request.url())
    if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin || portableTargets.some(target => target.origin === url.origin)) void request.continue()
    else void request.abort()
  })
  await portablePage.goto(`${origin}/portable-fixture#/settings/organization/models/prompts`)
  await portablePage.waitForSelector('[data-testid="settings-agent-slot-prompt"]')
  assert.equal(await portablePage.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Original Portable A')
  const replacePortablePrompt = async value => {
    await portablePage.focus('[data-testid="settings-agent-slot-prompt"]')
    await portablePage.keyboard.down('Control')
    await portablePage.keyboard.press('A')
    await portablePage.keyboard.up('Control')
    await portablePage.type('[data-testid="settings-agent-slot-prompt"]', value)
  }
  await replacePortablePrompt('Portable A private unsaved draft')
  await portablePage.waitForFunction(() => document.querySelector('[data-testid="settings-agent-slot-prompt"]')?.value === 'Portable A private unsaved draft'
    && !document.querySelector('[data-testid="settings-agent-slot-save"]')?.disabled)
  portableTargets[0].holdNextRead = true
  await portablePage.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload server version').click())
  await portablePage.waitForSelector('[role="alertdialog"]')
  await portablePage.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Reload server version').click())
  await portablePage.waitForFunction(() => !document.querySelector('[data-testid="settings-agent-slot-prompt"]'))
  await portablePage.click('[data-testid="portable-target-b"]')
  await portablePage.waitForSelector('[data-testid="settings-agent-slot-prompt"]')
  assert.equal(await portablePage.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Original Portable B')
  portableTargets[0].deferred.splice(0).forEach(release => release())
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await portablePage.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Original Portable B')
  assert(portableRequests.some(request => request.target === 'A' && request.deferred && request.cancelled))
  assert(portableRequests.every(request => request.authorizationMatches && !request.cookieSent))
  evidence.checks.push('two real Portable HTTP/SQLite targets retain separate bearer/cache authority, omit browser cookies and cancel old target reads/drafts')
  await replacePortablePrompt('Saved only to Portable B')
  await portablePage.click('[data-testid="settings-agent-slot-save"]')
  await portablePage.waitForFunction(() => document.querySelector('[data-testid="settings-agent-save-feedback"]')?.textContent.includes('Slot saved.'))
  assert.equal(portableTargets[1].snapshot().value.slots[0].prompt, 'Saved only to Portable B')
  assert.equal(portableTargets[0].snapshot().value.slots[0].prompt, 'Original Portable A')
  assert(portableRequests.some(request => request.target === 'B' && request.method === 'POST' && request.precondition))
  evidence.checks.push('real browser conditional write reaches only the selected Portable SQLite/JSON authority')
  await portablePage.screenshot({ path: join(artifacts, 'portable-target-isolation.png') })
  await portablePage.goto(`${origin}/?host=${encodeURIComponent(portableTargets[1].origin)}&token=${encodeURIComponent(portableTargets[1].token)}#/settings/organization/models/prompts`)
  await portablePage.waitForSelector('[data-testid="settings-page"]')
  await portablePage.waitForSelector('[data-testid="settings-agent-slot-prompt"]')
  assert.equal(new URL(portablePage.url()).searchParams.has('token'), false)
  assert.equal(await portablePage.$eval('[data-testid="settings-agent-slot-prompt"]', element => element.value), 'Saved only to Portable B')
  assert(portableRequests.some(request => request.target === 'B' && request.path === '/runtime/capabilities' && request.authorizationMatches))
  evidence.checks.push('actual Dashboard App enters unified Settings from the selected Portable Runtime opt-in and bootstrap credential, without an OIDC organization or direct component mounting')
  await portablePage.screenshot({ path: join(artifacts, 'portable-actual-app.png') })
  await portablePage.evaluate(() => { window.location.hash = '#/settings/personal/connection' })
  await portablePage.waitForSelector('[data-testid="personal-connection-panel"]')
  await portablePage.waitForFunction(() => document.querySelector('[data-testid="personal-connection-panel"] [data-testid="connection-health-host-marker"]'))
  const personalStarted = portableTargets[1].connectionPings
  await new Promise(resolve => setTimeout(resolve, 27_000))
  assert(portableTargets[1].connectionPings >= personalStarted + 5)
  assert(portableTargets[1].connectionPings <= personalStarted + 6)
  assert.equal(portableTargets[1].executorPings, 0)
  assert.equal(await portablePage.$('[data-testid="connection-status-popover"]'), null)
  assert.equal(await portablePage.$('[data-testid="personal-connection-panel"] [data-testid="connection-segment-service-executor"]'), null)
  for (const width of [390, 1440]) {
    await portablePage.setViewport({ width, height: 900 })
    assert.equal(await portablePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.equal(await portablePage.evaluate(() => document.body.innerText.includes('appShell.nav.settings')), false, 'actual mobile App header must resolve the Settings route label')
    await portablePage.screenshot({ path: join(artifacts, `personal-connection-${width}.png`) })
  }
  await portablePage.evaluate(() => { window.location.hash = '#/settings/personal/interface' })
  await portablePage.waitForFunction(() => !document.querySelector('[data-testid="personal-connection-panel"]'))
  const personalStopped = portableTargets[1].connectionPings
  await new Promise(resolve => setTimeout(resolve, 5_500))
  assert.equal(portableTargets[1].connectionPings, personalStopped)
  assert.equal(portableTargets[1].sockets.of('/dashboard').sockets.size, 1)
  assert(!portableTargets[1].controlEvents.some(event => /create_session|send_message|session_takeover/u.test(event)))
  evidence.personalConnection = { samples: personalStopped - personalStarted, namespace: '/dashboard', intervalWindowMs: 27_000,
    sessionSelected: false, executorSamples: portableTargets[1].executorPings, controlSocketSurvivesNavigation: true }
  evidence.checks.push('actual cold-entry Dashboard App Personal connection panel obtains at least five real selected-target control ACKs in27s without opening a dialog, fabricating an Executor leg or sending a Session message; route exit stops probes without closing the socket')
  if (controlFixture) {
    const webhookPage = await browser.newPage()
    webhookPage.on('pageerror', error => evidence.errors.push(error.message))
    await webhookPage.setRequestInterception(true)
    webhookPage.on('request', request => {
      const url = new URL(request.url())
      if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin) void request.continue()
      else void request.abort()
    })
    await webhookPage.goto(`${origin}/webhook-fixture#/settings/organization/integrations/webhooks`)
    await webhookPage.waitForSelector('form input[type="url"]')
    const replaceUrl = async value => {
      await webhookPage.focus('form input[type="url"]')
      await webhookPage.keyboard.down('Control'); await webhookPage.keyboard.press('A'); await webhookPage.keyboard.up('Control')
      await webhookPage.type('form input[type="url"]', value)
    }
    const outboxCount = async () => (await controlFixture.database.query('SELECT count(*)::text AS count FROM outbox_events')).rows[0].count
    const beforeSaveOutbox = await outboxCount()
    await replaceUrl(`${origin}/business-events`)
    await webhookPage.select('form select', 'browser_binding')
    await webhookPage.evaluate(() => [...document.querySelectorAll('form input[type="checkbox"]')].find(input => input.parentElement.textContent === 'organization.provisioned').click())
    await webhookPage.click('button[type="submit"]')
    await webhookPage.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled
      && [...document.querySelectorAll('li h3')].some(element => element.textContent.endsWith('/business-events')))
    let rows = await controlFixture.webhooks.list('org_local', { limit: 50 })
    assert.equal(rows.endpoints.length, 1)
    const created = rows.endpoints[0]
    assert.equal(created.secretBindingId, 'browser_binding')
    assert.equal(await outboxCount(), beforeSaveOutbox)
    const keys = await webhookPage.evaluate(async () => (await fetch('/organization/webhook-secret-bindings')).json())
    assert.equal(keys.bindings[0].label, 'Browser signing binding')
    assert(!JSON.stringify(keys).includes('bao:'))
    evidence.checks.push('Private Cloud browser creates through the actual authenticated Gateway/PostgreSQL authority using only binding IDs; no test event or secret reference is exposed')
    await replaceUrl(`${origin}/retained-webhook-draft`)
    await controlFixture.webhooks.patch('org_local', controlFixture.actor, created.id, { enabled: true }, created.etag)
    await webhookPage.click('button[type="submit"]')
    await webhookPage.waitForFunction(() => document.body.textContent.includes('The server version changed'))
    assert.equal(await webhookPage.$eval('form input[type="url"]', element => element.value), `${origin}/retained-webhook-draft`)
    assert.equal((await controlFixture.webhooks.list('org_local', { limit: 50 })).endpoints[0].revision, '2')
    webhookPage.once('dialog', dialog => dialog.accept())
    await webhookPage.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload server version').click())
    await webhookPage.waitForFunction(() => document.querySelector('form input[type="url"]')?.value === '')
    await webhookPage.evaluate(() => [...document.querySelectorAll('li button')].find(button => button.textContent === 'Edit endpoint').click())
    await replaceUrl(`${origin}/committed-response-lost`)
    loseNextWebhookResponse = true
    const beforeLoss = controlRequests.filter(request => request.method === 'PATCH').length
    await webhookPage.click('button[type="submit"]')
    await webhookPage.waitForFunction(() => document.body.textContent.includes('The response was lost'))
    rows = await controlFixture.webhooks.list('org_local', { limit: 50 })
    assert.equal(rows.endpoints[0].revision, '3')
    assert.equal(rows.endpoints[0].url, `${origin}/committed-response-lost`)
    assert.equal(controlRequests.filter(request => request.method === 'PATCH').length, beforeLoss + 1)
    assert.equal(await webhookPage.$eval('form input[type="url"]', element => element.value), `${origin}/committed-response-lost`)
    evidence.checks.push('actual PostgreSQL Webhook CAS conflicts retain drafts; committed truncated HTTP receipts stay outcome-unknown and are never replayed')
    const headers = { cookie: `ak_session=${controlFixture.cookie}`, origin, 'content-type': 'application/json' }
    assert.equal((await fetch(`${origin}/organization/webhooks`, { method: 'PUT', headers, body: '{}' })).status, 405)
    assert.equal((await fetch(`${origin}/organization/webhooks`, { method: 'POST',
      headers: { ...headers, origin: 'https://foreign.test' }, body: '{}' })).status, 403)
    await controlFixture.database.query("UPDATE organization_memberships SET role='member' WHERE organization_id='org_local'")
    assert.equal((await fetch(`${origin}/organization/webhooks`, { headers })).status, 403)
    assert.equal((await fetch(`${origin}/organization/webhook-secret-bindings`, { headers })).status, 403)
    await controlFixture.database.query("UPDATE organization_memberships SET role='owner' WHERE organization_id='org_local'")
    evidence.checks.push('real Webhook HTTP routes reject unsupported methods, foreign-Origin writes and freshly downgraded member reads/binding enumeration')
    for (const width of [390, 1440]) {
      await webhookPage.setViewport({ width, height: 900 })
      assert.equal(await webhookPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      await webhookPage.screenshot({ path: join(artifacts, `webhooks-${width}.png`) })
    }
  }
  const recoveryContext = await browser.createBrowserContext()
  let recoveryPage = await recoveryContext.newPage()
  recoveryPage.on('pageerror', error => evidence.errors.push(error.message))
  const installLegacyWorker = async page => {
    await page.goto(`${origin}/fixture`)
    await page.evaluate(async () => {
      localStorage.setItem('console-recovery-retained', 'keep')
      await (await caches.open('unrelated-console-cache')).put('/unrelated-fixture', new Response('keep'))
      await navigator.serviceWorker.register('/legacy-console-worker.js')
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Legacy fixture worker activation timed out')), 10_000))])
    })
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  }
  await installLegacyWorker(recoveryPage)
  await recoveryPage.goto(`${origin}/fixture#/settings/deployment/storage`)
  await recoveryPage.waitForSelector('[data-testid="settings-open-silo"]')
  assert.equal(await recoveryPage.$('[data-testid="settings-silo"] iframe'), null, 'Settings must not embed the native application')
  const consoleTarget = browser.waitForTarget(target => target.opener() === recoveryPage.target())
  await recoveryPage.click('[data-testid="settings-open-silo"]')
  recoveryPage = await (await consoleTarget).page()
  recoveryPage.on('pageerror', error => evidence.errors.push(error.message))
  await recoveryPage.waitForFunction(() => document.body.textContent.includes('Object storage opened the wrong page.'))
  assert.equal(new URL(recoveryPage.url()).pathname, '/auth/silo/open')
  assert.equal(await recoveryPage.$('[data-testid="settings-page"]'), null, 'a cached native-path shell must never mount the Dashboard App')
  await recoveryPage.screenshot({ path: join(artifacts, 'native-console-legacy-worker-recovery.png') })
  await Promise.all([
    recoveryPage.waitForNavigation(),
    recoveryPage.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload application').click()),
  ])
  await recoveryPage.waitForFunction(() => document.title === 'SILO Console' && document.querySelector('h1')?.textContent === 'Local native-document fixture')
  assert.equal(new URL(recoveryPage.url()).pathname, '/silo/')
  assert.deepEqual(await recoveryPage.evaluate(async () => ({
    retained: localStorage.getItem('console-recovery-retained'),
    unrelated: await (await caches.match('/unrelated-fixture')).text(),
    legacyCache: (await caches.keys()).includes('ak-legacy-console-repro'),
  })), { retained: 'keep', unrelated: 'keep', legacyCache: false })
  evidence.checks.push('Settings never embeds the native application; its actual new-window control under a genuinely controlling legacy worker reaches bootstrap recovery, refuses App, and deliberate refresh restores native navigation while retaining local settings/unrelated caches')
  await recoveryContext.close()
  assert.deepEqual(evidence.errors, [])
  evidence.browser = await browser.version()
  evidence.siloReads = siloReads
  console.log(JSON.stringify({ passed: evidence.checks.length, browser: evidence.browser, artifacts }, null, 2))
} finally {
  const page = browser ? (await browser.pages()).at(-1) : undefined
  if (page) evidence.lastVisibleText = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '')
  if (browser) evidence.pageStates = await Promise.all((await browser.pages()).map(page => page.evaluate(() => ({
    path: location.pathname, hash: location.hash, state: document.readyState, roots: document.querySelector('#root')?.childElementCount,
    scripts: [...document.scripts].map(script => new URL(script.src || location.origin).pathname),
  })).catch(() => ({ closed: true }))))
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
  await browser?.close()
  if (socketServer) await new Promise(resolve => socketServer.close(resolve))
  await server?.close()
  await controlFixture?.gateway?.close()
  if (controlFixture?.runtime) {
    controlFixture.runtime.closeAllConnections()
    await new Promise(resolve => controlFixture.runtime.close(resolve))
  }
  await controlFixture?.database?.close()
  if (controlFixture) await docker('docker', ['rm', '--force', controlFixture.container]).catch(() => undefined)
  await controlLoader?.()
  for (const target of portableTargets) {
    await new Promise(resolve => target.sockets.close(resolve))
    target.server.closeAllConnections()
    await new Promise(resolve => target.server.close(resolve))
    target.store.close()
  }
  authority.close()
  await rm(authorityRoot, { recursive: true, force: true })
  await rm(profile, { recursive: true, force: true })
}
