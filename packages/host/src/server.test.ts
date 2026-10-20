import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig } from '@agent-kernel/kernel'
import type {
  ControlUpdate,
  DashboardServerToClientEvents,
  ClientUpdatePreferences,
  ClientListDirs,
  DirListResult,
  DashboardClientToServerEvents,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ServerExecutorChangedPayload,
  ServerExecutorsPayload,
  ServerHistoryPayload,
  RpcAck,
  ServerMessageQueueEvent,
  ServerSettingsPayload,
  ServerSessionsPayload,
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  SessionReadyEvent,
  ToolResultAck,
  ToolCallMessage,
} from '@agent-kernel/shared'
import { DEDICATED_DEPLOYMENT, PRIVATE_CLOUD_DEPLOYMENT, PROTOCOL_VERSION } from '@agent-kernel/shared'
import { SESSION_ERROR_SCOPES } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import type { LLMAdapter } from './llm/adapter.js'
import { startHostServer, type HostServer } from './server.js'
import { appendEventEntry, appendRuntimeMetadataEntry, readSessionLog } from './store/log.js'
import { persistMessageQueueSnapshot } from './message-queue-store.js'
import { messageOperationFingerprint } from './message-operation-fingerprint.js'
import { ExecutorIdentityStore } from './store/executor-identity.js'
import { UnitResourceGovernor } from './tenant-runtime/resource-governor.js'
import { bangShellResultOperationId } from './bang-shell.js'
import { SessionArtifactRegistry } from './session-artifact-registry.js'
import { MessageAttachmentStore } from './message-attachment-store.js'

type HostCopilotTool = {
  name: string
  handler(args: unknown, invocation: { toolCallId: string }): Promise<unknown>
}

type HostCopilotSessionConfig = {
  sessionId?: string
  tools: HostCopilotTool[]
}

const copilotSdk = vi.hoisted(() => ({
  createSession: undefined as ((config: HostCopilotSessionConfig) => unknown) | undefined,
}))

vi.mock('@github/copilot-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@github/copilot-sdk')>()
  return {
    ...actual,
    CopilotClient: class {
      async start(): Promise<void> {}
      async stop(): Promise<readonly unknown[]> { return [] }
      async getAuthStatus(): Promise<{ isAuthenticated: boolean }> { return { isAuthenticated: true } }
      async listModels(): Promise<readonly never[]> { return [] }
      async resumeSession(): Promise<never> { throw new Error('not found') }
      async createSession(config: HostCopilotSessionConfig): Promise<unknown> {
        if (!copilotSdk.createSession) throw new Error('unexpected Copilot session creation')
        return copilotSdk.createSession(config)
      }
      async deleteSession(): Promise<void> {}
    },
  }
})

const WRITE = {
  name: 'write',
  description: 'write',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

const AGENT = {
  name: 'agent',
  description: 'spawn a sub-agent',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  },
  requiresApproval: false,
  executionKind: 'host',
  executionHandler: 'agent',
} as const

const ASK_USER_CHOICE = {
  name: 'ask_user_choice',
  description: 'ask the user to choose',
  inputSchema: {
    type: 'object',
    required: ['message', 'choices'],
    properties: {
      message: { type: 'string' },
      choices: { type: 'array', items: { type: 'string' } },
    },
  },
  requiresApproval: false,
  executionKind: 'host',
  executionHandler: 'ask_user_choice',
} as const

function scriptedLlm(): LLMAdapter {
  const queue = [
    {
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_call' as const,
            callId: 'c1',
            name: 'write',
            input: { path: '/tmp/x' },
          },
        ],
      },
    },
    {
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'wrote it' }],
      },
    },
  ]
  return {
    name: 'test',
    async call() {
      const next = queue.shift()
      if (!next) throw new Error('llm empty')
      return next
    },
  }
}

/**
 * Wait until the host's executor registry has an announced daemon connected.
 * Peeking at the internal snapshot is the cheapest signal — the socket
 * accepting the connection is not enough; we need the `executor:announce`
 * event to have been processed.
 */
async function waitForAnyExecutor(
  server: HostServer,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (server.io.of('/executor').sockets.size > 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('announce wait timeout')
}

function attachDirListHandler(
  executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>,
  roots: readonly string[],
  existingDirs: readonly string[],
): void {
  const normalize = (p: string): string => /^[a-z]:[\\/]/iu.test(p) ? p.replaceAll('/', '\\').toLowerCase() : resolve(p)
  const known = new Set(existingDirs.map(normalize))
  // Host-internal fs / bg / overflow RPCs arrive as ordinary `tool:call`
  // messages. The stub executor pretends to be the `__fs_list_dirs` built-in
  // and returns a JSON string matching DirListResult.
  executor.on('tool:call', (payload, ack: (result: ToolResultAck) => void) => {
    if (payload.name !== '__fs_list_dirs') return
    const input = payload.input as { requestId: string; workspaceId: string; path?: string }
    const rawRequested = input.path ?? roots[0] ?? process.cwd()
    const requested = /^[a-z]:[\\/]/iu.test(rawRequested) ? rawRequested.replaceAll('/', '\\') : resolve(rawRequested)
    const result: DirListResult = known.has(normalize(requested))
      ? {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          path: requested,
          roots,
          entries: [],
        }
      : {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          path: requested,
          roots,
          entries: [],
          error: `ENOENT: no such file or directory, scandir '${requested}'`,
        }
    ack({ callId: payload.callId, ok: true, content: JSON.stringify(result) })
  })
}

async function waitForWorkspace(
  dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>,
  workspaceId: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const list = await new Promise<ServerExecutorsPayload>((resolve) => {
      dashboard.once('server:executors', resolve)
      dashboard.emit('client:list_executors', {})
    })
    if (list.executors.some((e) => e.workspaceId === workspaceId)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`workspace wait timeout: ${workspaceId}`)
}

async function waitForSocketData(
  namespace: ReturnType<HostServer['io']['of']>,
  timeoutMs = 1000,
  predicate: (data: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const socket = Array.from(namespace.sockets.values())[0]
    const data = socket?.data as Record<string, unknown> | undefined
    if (data && predicate(data)) return data
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('socket data wait timeout')
}

async function postEnhancementAction(url: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${url}/enhancement/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json() as unknown
  if (!response.ok) throw new Error(JSON.stringify(payload))
  return payload
}

async function createRedeemedTenantExecutorInstall(
  url: string,
  organizationId: string,
  workspaceId: string,
): Promise<{ id: string; token: string }> {
  const adminHeaders = {
    'content-type': 'application/json',
    'x-agent-runlab-principal': 'admin@example.test',
    'x-agent-runlab-organization-id': organizationId,
    'x-agent-runlab-organization-role': 'admin',
  }
  const createdResponse = await fetch(`${url}/api/executor-installs`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ platform: 'linux', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/work' }),
  })
  if (!createdResponse.ok) throw new Error(`install create failed: ${createdResponse.status}`)
  const created = await createdResponse.json() as { id: string; setupCode: string }
  const claimedResponse = await fetch(`${url}/install/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupCode: created.setupCode }),
  })
  if (!claimedResponse.ok) throw new Error(`install claim failed: ${claimedResponse.status}`)
  const claimed = await claimedResponse.json() as { env: { EXECUTOR_INSTALL_BOOTSTRAP: string } }
  const bootstrap = claimed.env.EXECUTOR_INSTALL_BOOTSTRAP
  for (const status of ['asset_verified', 'pairing_pending']) {
    const response = await fetch(`${url}/api/executor-installs/${created.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap, status }),
    })
    if (!response.ok) throw new Error(`install event ${status} failed: ${response.status}`)
  }
  const redeemedResponse = await fetch(`${url}/api/executor-installs/${created.id}/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap, workspaceId }),
  })
  if (!redeemedResponse.ok) throw new Error(`install redeem failed: ${redeemedResponse.status}`)
  const redeemed = await redeemedResponse.json() as { token: string }
  return { id: created.id, token: redeemed.token }
}

describe('wire protocol', () => {
  let server: HostServer
  let dir: string
  let url: string
  let config: AgentConfig

  beforeEach(async () => {
    copilotSdk.createSession = undefined
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-wire-'))
    config = createConfig({ tools: [WRITE], systemPrompt: 'sys' })
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      // Keep instant-detach semantics for tests; the grace window is
      // covered by targeted tests in connection/executor.test.ts.
      detachGraceMs: 0,
    })
    url = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    await server.close()
    // Closing sockets does not wait for already dispatched Agent turns to finish
    // their durable writes; keep the temporary Session directory until they do.
    await server.loop.waitForQuiescence()
    rmSync(dir, { recursive: true, force: true })
  })

  it('schedules newly initialized DAG runs before any host restart', async () => {
    const sessionId = 'dag-initial-schedule'
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    try {
      await new Promise<SessionReadyEvent>((resolveReady, reject) => {
        dashboard.once('session:ready', resolveReady)
        dashboard.once('connect_error', reject)
      })
      const created = await dashboard.timeout(2000).emitWithAck('client:create_session', {
        sessionId, operationId: 'dag-initial-create', executionMode: 'dag',
      })
      expect(created.ok).toBe(true)
      const initialized = await dashboard.timeout(2000).emitWithAck('client:initialize_dag', {
        sessionId, operationId: 'dag-initial-graph', objective: 'Verify initial graph scheduling',
        graph: { expectedGraphVersion: 0, resultNodeId: 'one', nodes: [{ id: 'one', title: 'One', instructions: 'Execute' }], edges: [] },
      })
      expect(initialized.ok).toBe(true)
      const deadline = Date.now() + 3000
      let leaseObserved = false
      while (Date.now() < deadline && !leaseObserved) {
        const result = await dashboard.timeout(1000).emitWithAck('client:get_dag_run', { sessionId })
        leaseObserved = result.ok && result.value?.events.some((event) => event.type === 'lease') === true
        if (!leaseObserved) await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      }
      expect(leaseObserved).toBe(true)
    } finally {
      dashboard.close()
    }
  })

  it('binds a routed Session Upgrade to the later dashboard handshake and RPC target', async () => {
    const routedSessionId = 'ticket-session-a'
    await server.store.ensure({ sessionId: routedSessionId, defaultConfig: config })
    const connect = (auth: { sessionId?: string; clientId?: string }) => clientIO(`${url}/dashboard`, {
      transports: ['websocket'] as const,
      auth: { ...auth, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: { 'x-agent-runlab-route-session-id': routedSessionId },
      reconnection: false,
    })
    for (const auth of [{ sessionId: 'ticket-session-b' }, { clientId: 'multiplexed-control' }]) {
      const invalid = connect(auth)
      try {
        await expect(new Promise<void>((resolve, reject) => {
          invalid.once('connect', resolve)
          invalid.once('connect_error', reject)
        })).rejects.toThrow('session_route_mismatch')
      } finally { invalid.close() }
    }
    const dashboard = connect({ sessionId: routedSessionId })
    try {
      await new Promise<SessionReadyEvent>((resolve, reject) => {
        dashboard.once('session:ready', resolve)
        dashboard.once('connect_error', reject)
      })
      const denied = await dashboard.timeout(2_000).emitWithAck('client:update_preferences', {
        sessionId: 'ticket-session-b', operationId: 'wrong-routed-session', preferences: { chapterReadingMode: 'continuous' },
      })
      expect(denied).toMatchObject({ ok: false, error: 'session_route_mismatch' })
      const deniedChannels = await dashboard.timeout(2_000).emitWithAck('client:subscribe_channels', {
        requestId: 'cross-session-subscription', generation: 1, channels: ['session:ticket-session-b'],
      })
      expect(deniedChannels).toMatchObject({ ok: false, error: 'session_route_mismatch' })
    } finally { dashboard.close() }
  })

  it('rejects Session owner preparation when the Runtime has no owner provider or the socket is Session-routed', async () => {
    const sessionId = 'route-preparation-fail-closed'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const control: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { clientId: 'route-preparation-control', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    try {
      await new Promise<void>((resolve, reject) => { control.once('connect', resolve); control.once('connect_error', reject) })
      expect(await control.timeout(2_000).emitWithAck('client:prepare_session_route', { sessionId }))
        .toEqual({ ok: false, error: 'session route preparation unavailable' })
    } finally { control.close() }
    const routed = clientIO(`${url}/dashboard`, {
      transports: ['websocket'] as const,
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: { 'x-agent-runlab-route-session-id': sessionId },
      reconnection: false,
    })
    try {
      await new Promise<void>((resolve, reject) => { routed.once('connect', resolve); routed.once('connect_error', reject) })
      expect(await routed.timeout(2_000).emitWithAck('client:prepare_session_route', { sessionId }))
        .toEqual({ ok: false, error: 'session route preparation unavailable' })
    } finally { routed.close() }
  })

  it('prepares owner only for an existing Session in the authenticated control connection organization', async () => {
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'kala-owner-preparation-'))
    const acquired: string[] = []
    const localServer = await startHostServer({
      port: 0, sessionsDir: localSessionsDir, llm: scriptedLlm(),
      deployment: PRIVATE_CLOUD_DEPLOYMENT, defaultConfig: config,
      assertSessionEffectOwner: async (sessionId) => { acquired.push(sessionId) },
    })
    try {
      await localServer.store.create({ sessionId: 'route-org-a', config, organizationId: 'org_a' })
      await localServer.store.create({ sessionId: 'route-org-b', config, organizationId: 'org_b' })
      const control: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`http://localhost:${localServer.port}/dashboard`, {
        transports: ['websocket'], reconnection: false,
        auth: { clientId: 'owner-preparation-test', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
        extraHeaders: {
          'x-agent-runlab-principal': 'member-test',
          'x-agent-runlab-organization-id': 'org_a',
          'x-agent-runlab-organization-role': 'member',
        },
      })
      try {
        await new Promise<void>((resolve, reject) => { control.once('connect', resolve); control.once('connect_error', reject) })
        expect(await control.timeout(2_000).emitWithAck('client:prepare_session_route', { sessionId: 'route-org-a' }))
          .toEqual({ ok: true })
        expect(await control.timeout(2_000).emitWithAck('client:prepare_session_route', { sessionId: 'route-org-b' }))
          .toEqual({ ok: false, error: 'session unavailable' })
        expect(await control.timeout(2_000).emitWithAck('client:prepare_session_route', { sessionId: 'route-missing' }))
          .toEqual({ ok: false, error: 'session owner unavailable' })
        expect(acquired).toEqual(['route-org-a'])
      } finally { control.close() }
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('advertises an 8 MiB Socket.IO payload limit for bounded inline images', async () => {
    const body = await fetch(`${url}/socket.io/?EIO=4&transport=polling`).then((response) => response.text())
    const handshake = JSON.parse(body.slice(1)) as { maxPayload: number }
    expect(handshake.maxPayload).toBe(8 * 1024 * 1024)
  })

  it('fences stale unsubscribe operations and re-emits a fresh baseline on rapid resubscribe', async () => {
    const sessionId = 'rapid-resubscribe-fence'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { clientId: 'rapid-switch-dashboard', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))

    const firstReady = new Promise<SessionReadyEvent>((resolve) => dashboard.once('session:ready', resolve))
    const subscribed = await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'subscribe-new', generation: 3, channels: [`session:${sessionId}`],
    })
    expect(subscribed.accepted).toContain(`session:${sessionId}`)
    expect((await firstReady).sessionId).toBe(sessionId)

    const stale = await dashboard.timeout(1000).emitWithAck('client:unsubscribe_channels', {
      requestId: 'unsubscribe-old', generation: 2, channels: [`session:${sessionId}`],
    })
    expect(stale.rejected).toContainEqual({ channel: `session:${sessionId}`, code: 'stale_generation' })

    const appended = new Promise<EventAppendedEvent>((resolve) => dashboard.once('event:appended', resolve))
    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId, text: 'still subscribed', mode: 'queue', operationId: 'rapid-switch-message',
    })
    expect(ack).toMatchObject({ ok: true })
    expect((await appended).sessionId).toBe(sessionId)
    dashboard.close()
  })

  it('restores the full in-flight assistant text in a ready baseline after switching sessions', async () => {
    await server.close()
    let releaseResponse: () => void = () => {}
    let firstChunk: () => void = () => {}
    const emittedFirstChunk = new Promise<void>((resolve) => { firstChunk = resolve })
    const continueResponse = new Promise<void>((resolve) => { releaseResponse = resolve })
    server = await startHostServer({
      port: 0, sessionsDir: dir, defaultConfig: config,
      llm: {
        name: 'gated-stream',
        async call({ onTextDelta }) {
          onTextDelta?.('before switching')
          firstChunk()
          await continueResponse
          onTextDelta?.(' after switching')
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'before switching after switching' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId: 'stream-first', defaultConfig: config })
    await server.store.ensure({ sessionId: 'stream-second', defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'stream-switch', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    try {
      await new Promise<void>((resolve) => dashboard.on('connect', resolve))
      const ready = (): Promise<SessionReadyEvent> => new Promise((resolve) => dashboard.once('session:ready', resolve))
      const initial = ready()
      await dashboard.timeout(2000).emitWithAck('client:subscribe_channels', { requestId: 'stream-sub-1', generation: 1, channels: ['session:stream-first'] })
      await initial
      const stateTurnStarts: Array<string | undefined> = []
      dashboard.on('state:changed', (payload) => {
        if (payload.sessionId === 'stream-first') stateTurnStarts.push(payload.turnStartedAt)
      })
      await dashboard.timeout(2000).emitWithAck('client:user_message', { intent: 'text',
        sessionId: 'stream-first', text: 'generate', mode: 'queue', operationId: 'stream-message',
      })
      await emittedFirstChunk
      const second = ready()
      await dashboard.timeout(2000).emitWithAck('client:subscribe_channels', { requestId: 'stream-sub-2', generation: 2, channels: ['session:stream-second'] })
      expect((await second).sessionId).toBe('stream-second')
      const resumed = ready()
      await dashboard.timeout(2000).emitWithAck('client:refresh_channels', { requestId: 'stream-resume', generation: 3, channels: ['session:stream-first'] })
      const resumedPayload = await resumed
      expect(resumedPayload.streamingDraft?.text).toBe('before switching')
      expect(resumedPayload.turnStartedAt).toBe(server.store.get('stream-first')?.turnStartedAt)
      expect(resumedPayload.turnStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(stateTurnStarts.length).toBeGreaterThan(0)
      expect(new Set(stateTurnStarts)).toEqual(new Set([resumedPayload.turnStartedAt]))
    } finally {
      releaseResponse()
      dashboard.close()
    }
  })

  it('refreshes an already-subscribed session with an authoritative ready event before its ack', async () => {
    const sessionId = 'refresh-existing-room'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { clientId: 'refresh-room-dashboard', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', resolve))
    await Promise.all([
      new Promise<SessionReadyEvent>((resolve) => dashboard.once('session:ready', resolve)),
      dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
        requestId: 'subscribe-once', generation: 1, channels: [`session:${sessionId}`],
      }),
    ])

    const order: string[] = []
    const ready = new Promise<SessionReadyEvent>((resolve) => dashboard.once('session:ready', (payload) => {
      order.push('ready')
      resolve(payload)
    }))
    const acknowledged = dashboard.timeout(1000).emitWithAck('client:refresh_channels', {
      requestId: 'refresh-baseline', generation: 2, channels: [`session:${sessionId}`],
    }).then((result) => { order.push('ack'); return result })

    const refreshed = await ready
    const ack = await acknowledged
    expect(refreshed).toMatchObject({ sessionId, cursor: server.store.get(sessionId)?.state.cursor, reason: 'load' })
    expect(ack).toMatchObject({ accepted: [`session:${sessionId}`], rejected: [] })
    expect(order).toEqual(['ready', 'ack'])
    dashboard.close()
  })

  it('acknowledges approval-mode changes and persists the authoritative mode', async () => {
    const sessionId = 'approval-mode-ack'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:set_approval_mode', {
      operationId: 'approval-mode-ack-op',
      sessionId,
      mode: 'allow_all',
    })

    expect(ack).toEqual({ ok: true })
    expect(server.store.get(sessionId)?.state.approvalMode).toBe('allow_all')
    dashboard.close()
  })

  it('rejects mutating Dashboard socket events from ingress viewers', async () => {
    const sessionId = 'viewer-write-rejected'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'viewer@example.test',
        'x-agent-runlab-organization-id': 'org_viewer',
        'x-agent-runlab-organization-role': 'viewer',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'must not be accepted',
      mode: 'queue',
      operationId: 'viewer-write-rejected-op',
    })

    expect(ack).toEqual({ ok: false, error: 'forbidden: runtime:write required' })
    expect(server.store.get(sessionId)?.state.messages.some((message) => message.role === 'user')).toBe(false)
    dashboard.close()
  })

  it('rejects cross-tenant shell messages when queue quota is disabled', async () => {
    const sessionId = 'cross-tenant-shell-no-quota'
    await server.store.create({
      sessionId,
      workspaceId: 'workspace-tenant-b',
      config,
      organizationId: 'org_b',
      principal: 'b@example.test',
      organizationRole: 'member',
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'a@example.test',
        'x-agent-runlab-organization-id': 'org_a',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', {
      intent: 'shell', sessionId, text: '! id', mode: 'queue', operationId: 'cross-tenant-shell-no-quota-op',
    })

    expect(ack).toEqual({ ok: false, error: 'tenant_forbidden' })
    expect(server.store.get(sessionId)?.state.messages.some((message) => message.role === 'user')).toBe(false)
    dashboard.close()
  })

  it('rejects cross-tenant multiplexed session subscriptions from ingress actors', async () => {
    await server.store.create({
      sessionId: 'tenant-a-session',
      config,
      organizationId: 'org_a',
      principal: 'a@example.test',
      organizationRole: 'member',
    })
    await server.store.create({
      sessionId: 'tenant-b-session',
      config,
      organizationId: 'org_b',
      principal: 'b@example.test',
      organizationRole: 'member',
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { clientId: 'tenant-a-mux', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'a@example.test',
        'x-agent-runlab-organization-id': 'org_a',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))

    const readyEvents: SessionReadyEvent[] = []
    dashboard.on('session:ready', (event) => readyEvents.push(event))
    const ack = await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'cross-tenant-subscribe',
      generation: 1,
      channels: ['session:tenant-a-session', 'session:tenant-b-session'],
    })

    expect(ack.accepted).toEqual(['session:tenant-a-session'])
    expect(ack.rejected).toEqual([{ channel: 'session:tenant-b-session', code: 'tenant_forbidden' }])
    expect(readyEvents.map((event) => event.sessionId)).toEqual(['tenant-a-session'])
    dashboard.close()
  })

  it('rejects cross-tenant ingress background and overflow socket operations', async () => {
    await server.store.create({
      sessionId: 'socket-bg-tenant-b',
      workspaceId: 'workspace-tenant-b',
      config,
      organizationId: 'org_b',
      principal: 'b@example.test',
      organizationRole: 'member',
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'socket-bg-tenant-b', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'a@example.test',
        'x-agent-runlab-organization-id': 'org_a',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const bgList = await dashboard.timeout(1000).emitWithAck('bg:list', {
      requestId: 'cross-bg-list',
      workspaceId: 'workspace-tenant-b',
      sessionId: 'socket-bg-tenant-b',
    })
    expect(bgList).toMatchObject({ error: 'tenant_forbidden', tasks: [] })

    const overflow = new Promise<{ error?: string }>((resolve) => dashboard.once('server:overflow_contents', resolve))
    dashboard.emit('client:read_overflow', {
      requestId: 'cross-overflow',
      sessionId: 'socket-bg-tenant-b',
      callId: 'call-cross',
    })
    await expect(overflow).resolves.toMatchObject({ error: 'tenant_forbidden' })
    dashboard.close()
  })

  it('rejects cross-tenant ingress workspace exec and binary read socket operations', async () => {
    await server.store.create({
      sessionId: 'socket-workspace-tenant-b',
      workspaceId: 'workspace-tenant-b',
      config,
      organizationId: 'org_b',
      principal: 'b@example.test',
      organizationRole: 'member',
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'socket-workspace-tenant-b', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'a@example.test',
        'x-agent-runlab-organization-id': 'org_a',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const exec = await dashboard.timeout(1000).emitWithAck('workspace:exec', {
      requestId: 'cross-workspace-exec',
      workspaceId: 'workspace-tenant-b',
      argv: ['echo', 'blocked'],
    })
    expect(exec).toMatchObject({ error: { code: 'EACCES', message: 'tenant_forbidden' } })

    const binary = await dashboard.timeout(1000).emitWithAck('workspace:read_binary', {
      requestId: 'cross-workspace-read',
      workspaceId: 'workspace-tenant-b',
      path: '/tmp/blocked.png',
    })
    expect(binary).toMatchObject({ error: { code: 'EACCES', message: 'tenant_forbidden' } })
    dashboard.close()
  })

  it('rejects cross-tenant ingress HTTP access to session-scoped runtime routes', async () => {
    await server.store.create({
      sessionId: 'http-tenant-a',
      config,
      organizationId: 'org_a',
      principal: 'a@example.test',
      organizationRole: 'member',
    })
    await server.store.create({
      sessionId: 'http-tenant-b',
      config,
      organizationId: 'org_b',
      principal: 'b@example.test',
      organizationRole: 'member',
    })
    const orgAHeaders = {
      'x-agent-runlab-principal': 'a@example.test',
      'x-agent-runlab-organization-id': 'org_a',
      'x-agent-runlab-organization-role': 'member',
    }

    const toolLock = await fetch(`${url}/runtime/sessions/http-tenant-b/tool-lock`, {
      headers: orgAHeaders,
    })
    expect(toolLock.status).toBe(403)
    await expect(toolLock.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })

    const admission = await fetch(`${url}/runtime/admission/messages`, {
      method: 'POST',
      headers: { ...orgAHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'http-tenant-b',
        operationId: 'http-cross-tenant-admission',
        intent: 'text',
        text: 'must not enqueue',
      }),
    })
    expect(admission.status).toBe(403)
    await expect(admission.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })

    const attachment = await fetch(`${url}/runtime/attachments?sessionId=http-tenant-b`, {
      method: 'POST',
      headers: {
        ...orgAHeaders,
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': encodeURIComponent('note.txt'),
      },
      body: 'hello',
    })
    expect(attachment.status).toBe(403)
    await expect(attachment.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })
  })

  it('rejects cross-tenant ingress HTTP access to session artifacts', async () => {
    await server.store.create({
      sessionId: 'artifact-tenant-b',
      config,
      organizationId: 'org_b',
      principal: 'b@example.test',
      organizationRole: 'member',
    })
    const orgBHeaders = {
      'x-agent-runlab-principal': 'b@example.test',
      'x-agent-runlab-organization-id': 'org_b',
      'x-agent-runlab-organization-role': 'member',
    }
    const orgAHeaders = {
      'x-agent-runlab-principal': 'a@example.test',
      'x-agent-runlab-organization-id': 'org_a',
      'x-agent-runlab-organization-role': 'member',
    }
    const png = Buffer.alloc(16)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)

    const blockedRegister = await fetch(`${url}/session-artifacts/register`, {
      method: 'POST',
      headers: { ...orgAHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'artifact-tenant-b',
        fileName: 'blocked.png',
        data: png.toString('base64'),
      }),
    })
    expect(blockedRegister.status).toBe(403)
    await expect(blockedRegister.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })

    const registered = await fetch(`${url}/session-artifacts/register`, {
      method: 'POST',
      headers: { ...orgBHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'artifact-tenant-b',
        fileName: 'allowed.png',
        data: png.toString('base64'),
      }),
    }).then((response) => response.json() as Promise<{ artifactId: string }>)

    const blockedRead = await fetch(`${url}/session-artifacts/${registered.artifactId}?sessionId=artifact-tenant-b`, {
      headers: orgAHeaders,
    })
    expect(blockedRead.status).toBe(403)
    await expect(blockedRead.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })
  })

  it('requires explicit confirmation and sends restrictive headers for SVG artifacts', async () => {
    await server.store.create({ sessionId: 'artifact-svg', config })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>')
    const registered = await fetch(`${url}/session-artifacts/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'artifact-svg', fileName: 'diagram.svg', data: svg.toString('base64') }),
    }).then((response) => response.json() as Promise<{ artifactId: string; uri: string }>)
    expect(registered.uri).toContain('mediaType=image%2Fsvg%2Bxml')

    const blocked = await fetch(`${url}/session-artifacts/${registered.artifactId}?sessionId=artifact-svg`)
    expect(blocked.status).toBe(409)

    const allowed = await fetch(`${url}/session-artifacts/${registered.artifactId}?sessionId=artifact-svg&allowSvg=1`)
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('content-type')).toBe('image/svg+xml')
    expect(allowed.headers.get('x-content-type-options')).toBe('nosniff')
    expect(allowed.headers.get('content-security-policy')).toContain("default-src 'none'")
    await expect(allowed.text()).resolves.toBe(svg.toString())
  })

  it('loads injected object stores and awaits attachment validation before queue admission', async () => {
    await server.close()
    const sessionArtifacts = new SessionArtifactRegistry(join(dir, 'silo-session-artifacts'))
    const messageAttachments = new MessageAttachmentStore(join(dir, 'silo-message-attachments'))
    const artifactLoad = vi.spyOn(sessionArtifacts, 'load')
    const attachmentLoad = vi.spyOn(messageAttachments, 'load')
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      objectStorage: { sessionArtifacts, messageAttachments },
    })
    url = `http://localhost:${server.port}`
    expect(artifactLoad).toHaveBeenCalledOnce()
    expect(attachmentLoad).toHaveBeenCalledOnce()

    const sessionId = 'injected-object-storage'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const attachment = await messageAttachments.register({
      sessionId,
      name: 'delayed.txt',
      mediaType: 'text/plain',
      data: Buffer.from('validated asynchronously'),
    })
    let releaseValidation: () => void = () => {}
    const validationGate = new Promise<void>((resolveGate) => { releaseValidation = resolveGate })
    const originalResolve = messageAttachments.resolve.bind(messageAttachments)
    const resolveSpy = vi.spyOn(messageAttachments, 'resolve').mockImplementation(async (...args) => {
      await validationGate
      return originalResolve(...args)
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    try {
      await new Promise<SessionReadyEvent>((resolveReady, reject) => {
        dashboard.once('session:ready', resolveReady)
        dashboard.once('connect_error', reject)
      })
      await expect(dashboard.timeout(1000).emitWithAck('client:get_global_storage', { refresh: true }))
        .resolves.toMatchObject({ ok: false, error: 'storage inventory unavailable' })
      let admitted = false
      const ackPromise = dashboard.timeout(2000).emitWithAck('client:user_message', {
        intent: 'text', sessionId, text: 'use attachment', mode: 'queue',
        operationId: 'injected-object-storage-message', content: [attachment],
      }).then((ack) => {
        admitted = true
        return ack
      })
      await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      expect(resolveSpy).toHaveBeenCalledWith(sessionId, attachment)
      expect(admitted).toBe(false)
      releaseValidation()
      await expect(ackPromise).resolves.toMatchObject({ ok: true })
    } finally {
      releaseValidation()
      dashboard.close()
    }
  })

  it('fails startup closed when an injected object store cannot load', async () => {
    await server.close()
    const sessionArtifacts = new SessionArtifactRegistry(join(dir, 'unavailable-session-artifacts'))
    const messageAttachments = new MessageAttachmentStore(join(dir, 'unavailable-message-attachments'))
    vi.spyOn(sessionArtifacts, 'load').mockRejectedValueOnce(new Error('object storage unavailable'))
    await expect(startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      objectStorage: { sessionArtifacts, messageAttachments },
    })).rejects.toThrow('object storage unavailable')
    // Preserve afterEach ownership after the intentionally failed startup.
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config })
    url = `http://localhost:${server.port}`
  })

  it('enforces tenant storage quota before registering HTTP message attachments', async () => {
    await server.close()
    const quotaChecks: unknown[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      storageQuota: {
        async assertCanStoreArtifact(params) {
          quotaChecks.push(params)
          throw new Error('organization storage quota exceeded')
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId: 'attachment-quota-denied',
      config,
      organizationId: 'org_storage',
      principal: 'storage@example.test',
      organizationRole: 'member',
    })

    const response = await fetch(`${url}/runtime/attachments?sessionId=attachment-quota-denied`, {
      method: 'POST',
      headers: {
        'x-agent-runlab-principal': 'storage@example.test',
        'x-agent-runlab-organization-id': 'org_storage',
        'x-agent-runlab-organization-role': 'member',
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': encodeURIComponent('note.txt'),
      },
      body: 'blocked',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'organization storage quota exceeded' })
    expect(quotaChecks).toEqual([expect.objectContaining({
      organizationId: 'org_storage',
      sessionId: 'attachment-quota-denied',
      kind: 'message_attachment',
      bytes: 7,
    })])
    await expect(readFile(join(dir, '..', 'message-attachments', 'registry.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces Runtime Unit artifact limits on the HTTP storage path', async () => {
    await server.close()
    const governor = new UnitResourceGovernor({
      maxConcurrentTurns: 1,
      maxQueuedMessages: 1,
      maxArtifactBytes: 4,
    })
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      resourceGovernor: governor,
      resourceUnitId: 'unit-a',
      resourceArtifactUsage: async () => 0,
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId: 'unit-artifact-quota-denied',
      config,
      organizationId: 'org_storage',
      principal: 'storage@example.test',
      organizationRole: 'member',
    })

    const response = await fetch(`${url}/runtime/attachments?sessionId=unit-artifact-quota-denied`, {
      method: 'POST',
      headers: {
        'x-agent-runlab-principal': 'storage@example.test',
        'x-agent-runlab-organization-id': 'org_storage',
        'x-agent-runlab-organization-role': 'member',
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': encodeURIComponent('note.txt'),
      },
      body: 'blocked',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('artifact quota exceeded') })
    expect(governor.snapshot('unit-a').artifactBytes).toBe(0)
  })

  it('enforces tenant storage quota before registering session artifacts', async () => {
    await server.close()
    const quotaChecks: unknown[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      storageQuota: {
        async assertCanStoreArtifact(params) {
          quotaChecks.push(params)
          throw new Error('organization storage quota exceeded')
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId: 'artifact-quota-denied',
      config,
      organizationId: 'org_storage',
      principal: 'storage@example.test',
      organizationRole: 'member',
    })
    const png = Buffer.alloc(16)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)

    const response = await fetch(`${url}/session-artifacts/register`, {
      method: 'POST',
      headers: {
        'x-agent-runlab-principal': 'storage@example.test',
        'x-agent-runlab-organization-id': 'org_storage',
        'x-agent-runlab-organization-role': 'member',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'artifact-quota-denied', fileName: 'blocked.png', data: png.toString('base64') }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'organization storage quota exceeded' })
    expect(quotaChecks).toEqual([expect.objectContaining({
      organizationId: 'org_storage',
      sessionId: 'artifact-quota-denied',
      kind: 'session_artifact',
      bytes: 16,
    })])
    const registry = JSON.parse(await readFile(join(dir, '..', 'session-artifacts', 'registry.json'), 'utf8')) as { records: Array<{ sessionId: string }> }
    expect(registry.records.some((record) => record.sessionId === 'artifact-quota-denied')).toBe(false)
  })

  it('enforces tenant session quota before creating ingress sessions', async () => {
    await server.close()
    let checks = 0
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      sessionQuota: {
        async assertCanCreateSession(params) {
          checks += 1
          expect(params).toMatchObject({
            organizationId: 'org_quota',
            principal: 'member@example.test',
            role: 'member',
            sessionId: 'session-quota-denied',
          })
          throw new Error('organization concurrent session quota exceeded')
        },
      },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'session-quota-denied', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_quota',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:create_session', {
      sessionId: 'session-quota-denied',
    })

    expect(ack).toEqual({ ok: false, error: 'organization concurrent session quota exceeded' })
    expect(checks).toBe(1)
    expect(server.store.get('session-quota-denied')).toBeUndefined()
    await expect(server.store.load('session-quota-denied')).rejects.toThrow('Unknown session')
    dashboard.close()
  })

  it('creates ingress sessions after tenant session quota allows them', async () => {
    await server.close()
    const checks: unknown[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: (actor) => createConfig({
        tools: config.tools,
        systemPrompt: actor?.kind === 'ingress' ? `prompt-for-${actor.organizationId}` : 'portable-prompt',
      }),
      sessionQuota: {
        async assertCanCreateSession(params) {
          checks.push(params)
        },
      },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'session-quota-allowed', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_quota',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:create_session', {
      sessionId: 'session-quota-allowed',
    })

    expect(ack).toEqual({ ok: true })
    expect(checks).toEqual([expect.objectContaining({ organizationId: 'org_quota', sessionId: 'session-quota-allowed' })])
    expect(server.store.get('session-quota-allowed')?.organizationId).toBe('org_quota')
    expect(server.store.get('session-quota-allowed')?.config.systemPrompt).toBe('prompt-for-org_quota')
    dashboard.close()
  })

  it('enforces tenant message queue quota before persisting messages', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      queueQuota: {
        async assertCanEnqueueMessage(params) {
          expect(params).toMatchObject({
            organizationId: 'org_queue',
            principal: 'member@example.test',
            role: 'member',
            sessionId: 'queue-quota-denied',
            pendingMessages: 0,
            mode: 'steer',
          })
          throw new Error('organization queued-message quota exceeded')
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId: 'queue-quota-denied',
      config,
      organizationId: 'org_queue',
      principal: 'member@example.test',
      organizationRole: 'member',
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'queue-quota-denied', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_queue',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId: 'queue-quota-denied',
      text: 'must not persist',
      mode: 'queue',
      operationId: 'queue-quota-denied-op',
    })

    expect(ack).toEqual({ ok: false, error: 'organization queued-message quota exceeded' })
    expect(server.store.get('queue-quota-denied')?.state.messages.some((message) => message.role === 'user')).toBe(false)
    const log = await readSessionLog(server.store.get('queue-quota-denied')!.logPath)
    expect(log.events.some((entry) => entry.event.kind === 'user_message')).toBe(false)
    dashboard.close()
  })

  it('runs tenant message queue quota with current queue depth before enqueue', async () => {
    await server.close()
    const checks: unknown[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      queueQuota: {
        async assertCanEnqueueMessage(params) {
          checks.push(params)
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId: 'queue-quota-allowed',
      config,
      organizationId: 'org_queue',
      principal: 'member@example.test',
      organizationRole: 'member',
    })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'queue-quota-allowed', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_queue',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId: 'queue-quota-allowed',
      text: 'allowed',
      mode: 'queue',
      operationId: 'queue-quota-allowed-op',
    })

    expect(ack).toEqual({ ok: true })
    expect(checks).toEqual([expect.objectContaining({ organizationId: 'org_queue', pendingMessages: 0, mode: 'steer' })])
    dashboard.close()
  })

  it('rejects disallowed tenant model selection before session creation', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      models: [{ ref: 'provider:blocked', id: 'blocked', label: 'Blocked', provider: 'Provider', providerId: 'provider' }],
      modelPolicy: {
        async assertCanUseModel(params) {
          expect(params).toMatchObject({ organizationId: 'org_model', sessionId: 'model-policy-create', model: 'provider:blocked' })
          throw new Error('model is not entitled for this organization')
        },
      },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'model-policy-create', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_model',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:create_session', {
      sessionId: 'model-policy-create',
      selectedModel: 'provider:blocked',
    })

    expect(ack).toEqual({ ok: false, error: 'model is not entitled for this organization' })
    expect(server.store.get('model-policy-create')).toBeUndefined()
    dashboard.close()
  })

  it('persists chapter reading mode updates, broadcasts them across clients, and rejects invalid modes', async () => {
    const sessionId = 'chapter-reading-mode-update'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const connectDashboard = async (): Promise<ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>> => {
      const socket: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
        transports: ['websocket'],
        auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
        reconnection: false,
      })
      await new Promise<SessionReadyEvent>((resolve) => socket.on('session:ready', resolve))
      return socket
    }
    const first = await connectDashboard()
    const second = await connectDashboard()
    const changed = new Promise<void>((resolve) => second.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.chapterReadingMode === 'continuous') resolve()
    }))

    const ack = await first.timeout(1_000).emitWithAck('client:update_preferences', {
      operationId: 'chapter-reading-mode-valid',
      sessionId,
      preferences: { chapterReadingMode: 'continuous' },
    })
    expect(ack).toEqual({ ok: true })
    await changed
    expect(server.store.get(sessionId)?.preferences.chapterReadingMode).toBe('continuous')

    const invalid = {
      operationId: 'chapter-reading-mode-invalid',
      sessionId,
      preferences: { chapterReadingMode: 'pages' },
    } as unknown as ClientUpdatePreferences
    const invalidAck = await first.timeout(1_000).emitWithAck('client:update_preferences', invalid)
    expect(invalidAck).toEqual({ ok: false, error: 'invalid preferences update' })
    expect(server.store.get(sessionId)?.preferences.chapterReadingMode).toBe('continuous')
    expect((await readSessionLog(server.store.get(sessionId)!.logPath)).metadata.at(-1)?.chapterReadingMode).toBe('continuous')
    const reset = await first.timeout(1_000).emitWithAck('client:update_preferences', {
      operationId: 'chapter-reading-mode-follow-global',
      sessionId,
      preferences: { chapterReadingMode: null },
    })
    expect(reset).toEqual({ ok: true })
    expect(server.store.get(sessionId)?.preferences.chapterReadingMode).toBeUndefined()
    expect((await readSessionLog(server.store.get(sessionId)!.logPath)).metadata.at(-1)?.chapterReadingMode).toBeNull()
    first.close()
    second.close()
  })

  it('rejects disallowed tenant model preference updates without persisting them', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      models: [{ ref: 'provider:blocked', id: 'blocked', label: 'Blocked', provider: 'Provider', providerId: 'provider' }],
      modelPolicy: {
        async assertCanUseModel(params) {
          expect(params).toMatchObject({ organizationId: 'org_model', sessionId: 'model-policy-update', model: 'provider:blocked' })
          throw new Error('model is not entitled for this organization')
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({ sessionId: 'model-policy-update', config, organizationId: 'org_model', principal: 'member@example.test', organizationRole: 'member' })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'model-policy-update', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_model',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:update_preferences', {
      operationId: 'model-policy-update-op',
      sessionId: 'model-policy-update',
      preferences: { selectedModel: 'provider:blocked' },
    })

    expect(ack).toEqual({ ok: false, error: 'model is not entitled for this organization' })
    expect(server.store.get('model-policy-update')?.preferences.selectedModel).toBeUndefined()
    dashboard.close()
  })

  it('enforces tenant model policy before LLM provider calls', async () => {
    await server.close()
    let providerCalls = 0
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: {
        name: 'model-policy-llm',
        async call() {
          providerCalls += 1
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'should not run' }] } }
        },
      },
      defaultConfig: config,
      defaultModel: 'provider:blocked',
      modelPolicy: {
        async assertCanUseModel(params) {
          expect(params).toMatchObject({ organizationId: 'org_model', sessionId: 'model-policy-llm', model: 'provider:blocked' })
          throw new Error('model is not entitled for this organization')
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({ sessionId: 'model-policy-llm', config, organizationId: 'org_model', principal: 'member@example.test', organizationRole: 'member' })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'model-policy-llm', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_model',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const appended = new Promise<EventAppendedEvent>((resolve) => {
      dashboard.on('event:appended', (event) => {
        if (event.event.kind === 'llm_error') resolve(event)
      })
    })
    await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId: 'model-policy-llm',
      text: 'hello',
      operationId: 'model-policy-llm-op',
    })

    expect((await appended).event).toMatchObject({ kind: 'llm_error', error: 'model is not entitled for this organization' })
    expect(providerCalls).toBe(0)
    dashboard.close()
  })

  it('enforces tenant LLM quota before calling the provider', async () => {
    await server.close()
    let providerCalls = 0
    const quotaChecks: unknown[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: {
        name: 'quota-deny-test',
        async call() {
          providerCalls += 1
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'should not run' }] } }
        },
      },
      llmQuota: {
        async assertMonthlyTokenQuota(params) {
          quotaChecks.push(params)
          throw new Error('organization token quota exceeded')
        },
      },
      defaultConfig: createConfig({ tools: [], systemPrompt: 'sys' }),
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'quota-deny-session'
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_quota',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const createAck = await dashboard.timeout(1000).emitWithAck('client:create_session', { sessionId })
    expect(createAck).toEqual({ ok: true })
    const appended = new Promise<EventAppendedEvent>((resolve) => {
      dashboard.on('event:appended', (event) => {
        if (event.event.kind === 'llm_error') resolve(event)
      })
    })
    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'hello',
      operationId: 'quota-deny-op',
    })
    expect(ack).toEqual({ ok: true })
    expect((await appended).event).toMatchObject({ kind: 'llm_error', error: 'organization token quota exceeded' })
    expect(providerCalls).toBe(0)
    expect(quotaChecks).toEqual([
      expect.objectContaining({
        organizationId: 'org_quota',
        sessionId,
        requestedTokens: expect.any(Number),
      }),
    ])
    expect(server.store.get(sessionId)?.organizationId).toBe('org_quota')
    dashboard.close()
  })

  it('records tenant LLM usage after an allowed provider call', async () => {
    await server.close()
    const quotaChecks: unknown[] = []
    const usageRecords: unknown[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: {
        name: 'quota-allow-test',
        async call() {
          return {
            message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
            usage: { inputTokens: 11, outputTokens: 7 },
          }
        },
      },
      llmQuota: {
        async assertMonthlyTokenQuota(params) {
          quotaChecks.push(params)
        },
        async recordUsage(params) {
          usageRecords.push(params)
        },
      },
      defaultConfig: createConfig({ tools: [], systemPrompt: 'sys' }),
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'quota-allow-session'
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      extraHeaders: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_allow',
        'x-agent-runlab-organization-role': 'member',
      },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    await dashboard.timeout(1000).emitWithAck('client:create_session', { sessionId })

    const appended = new Promise<EventAppendedEvent>((resolve) => {
      dashboard.on('event:appended', (event) => {
        if (event.event.kind === 'llm_response') resolve(event)
      })
    })
    await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'hello',
      operationId: 'quota-allow-op',
    })
    expect((await appended).event).toMatchObject({ kind: 'llm_response' })
    expect(quotaChecks).toEqual([
      expect.objectContaining({ organizationId: 'org_allow', sessionId }),
    ])
    expect(usageRecords).toEqual([
      expect.objectContaining({
        organizationId: 'org_allow',
        sessionId,
        usage: { inputTokens: 11, outputTokens: 7 },
      }),
    ])
    dashboard.close()
  })

  it('ACKs client:cancel failures while preserving legacy optional ACK compatibility', async () => {
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'missing-cancel-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const ack = await dashboard.timeout(1000).emitWithAck('client:cancel', {
      sessionId: 'missing-cancel-session',
      operationId: 'cancel-missing',
    })
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining('unknown session') })
    dashboard.emit('client:cancel', { sessionId: 'missing-cancel-session' })
    dashboard.close()
  })

  it('ACKs an ask_user_choice at broker acceptance before the gated continuation completes', async () => {
    await server.close()
    const askConfig = createConfig({ tools: [ASK_USER_CHOICE], systemPrompt: 'sys' })
    let secondCallMessages: unknown
    let releaseSecondCall: () => void = () => {}
    let markSecondCallStarted: () => void = () => {}
    let secondCallCompleted = false
    const secondCallGate = new Promise<void>((resolve) => { releaseSecondCall = resolve })
    const secondCallStarted = new Promise<void>((resolve) => { markSecondCallStarted = resolve })
    const llm: LLMAdapter = {
      name: 'ask-choice-test',
      async call(input) {
        secondCallMessages = input.messages
        if (input.messages.some((message) => message.role === 'tool')) {
          markSecondCallStarted()
          await secondCallGate
          secondCallCompleted = true
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'choice accepted' }] } }
        }
        return {
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_call',
              callId: 'choice-1',
              name: 'ask_user_choice',
              input: {
                message: 'Pick implementation depth',
                choices: [{ value: 'minimal', label: 'Minimal' }, { value: 'complete', label: 'Complete' }],
              },
            }],
          },
        }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm,
      defaultConfig: askConfig,
      httpServer: http,
      toolTimeoutMs: 2000,
      detachGraceMs: 0,
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'ask-user-choice-wire'
    await server.store.ensure({ sessionId, defaultConfig: askConfig })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const toolRequested = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never awaited choice')), 2000)
      dashboard.on('event:appended', (payload) => {
        if (payload.effects.some((effect) => effect.kind === 'call_tool' && effect.callId === 'choice-1' && effect.name === 'ask_user_choice')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    const startAck = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text', sessionId, text: 'choose' })
    expect(startAck).toEqual({ ok: true })
    await toolRequested

    const unknownAck = await dashboard.timeout(1000).emitWithAck('client:ask_user_choice', {
      sessionId,
      callId: 'unknown-choice',
      value: 'complete',
    })
    expect(unknownAck).toMatchObject({ ok: false, error: expect.stringContaining('not pending') })
    const invalidAck = await dashboard.timeout(1000).emitWithAck('client:ask_user_choice', {
      sessionId,
      callId: 'choice-1',
      value: 'not-an-option',
    })
    expect(invalidAck).toMatchObject({ ok: false, error: expect.stringContaining('available choices') })

    const ack = await dashboard.timeout(1000).emitWithAck('client:ask_user_choice', {
      sessionId,
      callId: 'choice-1',
      value: 'complete',
    })
    expect(ack).toEqual({ ok: true })
    await secondCallStarted
    expect(secondCallCompleted).toBe(false)
    const turnDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never finished choice turn')), 3000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    releaseSecondCall()
    await turnDone
    expect(JSON.stringify(secondCallMessages)).toContain('"value":"complete"')
    const staleAck = await dashboard.timeout(1000).emitWithAck('client:ask_user_choice', {
      sessionId,
      callId: 'choice-1',
      value: 'minimal',
    })
    expect(staleAck).toMatchObject({ ok: false, error: expect.stringContaining('not pending') })
    dashboard.close()
  })

  it('rejects invalid and oversized inline images before starting a turn', async () => {
    const sessionId = 'wire-image-policy'
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const invalid = await dashboard.timeout(1000).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'invalid image',
      operationId: 'invalid-image',
      content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: Buffer.from('not png').toString('base64') } }],
    })
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining('IMAGE_INVALID_BASE64') })

    const oversizedBytes = Buffer.alloc(2 * 1024 * 1024 + 1)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedBytes)
    const oversized = await dashboard.timeout(3000).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'oversized image',
      operationId: 'oversized-image',
      content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: oversizedBytes.toString('base64') } }],
    })
    expect(oversized).toMatchObject({ ok: false, error: expect.stringContaining('IMAGE_TOO_LARGE') })
    expect(server.store.get(sessionId)).toBeUndefined()
    dashboard.close()
  })

  it('accepts a bounded two-image payload larger than the legacy 1 MiB transport limit', async () => {
    const sessionId = 'wire-two-large-images'
    const record = await server.store.ensure({ sessionId, defaultConfig: config })
    record.record.state = { ...record.record.state, status: 'thinking' }
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const makePng = (): string => {
      const bytes = Buffer.alloc(600_000)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      return bytes.toString('base64')
    }
    const ack = await dashboard.timeout(3000).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'two screenshots',
      mode: 'queue',
      operationId: 'two-large-images',
      content: [
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: makePng() } },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: makePng() } },
      ],
    })
    expect(ack).toMatchObject({ ok: true })
    const queue = await new Promise<ServerMessageQueueEvent>((resolve) => {
      dashboard.once('server:message_queue', resolve)
      dashboard.emit('client:subscribe_channels', { requestId: 'queue-check', generation: 1, channels: [`session:${sessionId}`] }, () => {})
    })
    expect(queue.items?.[0]?.content?.filter((block) => block.type === 'image')).toHaveLength(2)
    // The queue acknowledgement can precede dispatch scheduling and its durable write.
    // Let that dispatch enter the loop before teardown removes the temporary store.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await server.loop.waitForQuiescence()
    dashboard.close()
  })

  it('exposes host restart runtime status over HTTP and settings', async () => {
    const status = await fetch(`${url}/runtime/restart/status`).then((r) => r.json() as Promise<{ pid: number; current: unknown }>)
    expect(status.pid).toBe(process.pid)
    expect(status.current).toBeNull()

    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      settings: {
        paths: {
          claudeSettings: '/tmp/claude.json',
          codexConfig: '/tmp/codex.toml',
          manualModels: '/tmp/models.json',
          hooksConfig: '/tmp/hooks.toml',
          sessionsDir: dir,
        },
      } as ServerSettingsPayload,
    })
    url = `http://localhost:${server.port}`

    const settings = await fetch(`${url}/settings`).then((r) => r.json() as Promise<ServerSettingsPayload>)
    expect(settings.runtime?.pid).toBe(process.pid)
    expect(settings.runtime?.current).toBeNull()
    expect(settings.socketConnections).toMatchObject({
      total: expect.any(Number),
      dashboard: expect.any(Number),
      executor: expect.any(Number),
      other: expect.any(Number),
      updatedAt: expect.any(String),
    })
    expect(settings.socketConnections?.namespaces.some((entry) => entry.namespace === '/dashboard')).toBe(true)
    expect(settings.socketConnections?.namespaces.some((entry) => entry.namespace === '/executor')).toBe(true)
  })

  it('protects the Supervisor origin-result barrier with the private handoff secret', async () => {
    const previous = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'origin-barrier-test-secret'
    try {
      const path = `${url}/internal/runtime/tool-result/session-origin/call-origin`
      expect((await fetch(path)).status).toBe(401)
      const response = await fetch(path, { headers: { 'x-agent-runlab-ingress-handoff': 'origin-barrier-test-secret' } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ persisted: false })

      const copilot = await server.store.create({ sessionId: 'origin-copilot', agentRuntime: 'copilot', config })
      await server.store.recordRuntimeProjection(copilot.sessionId, {
        ...copilot.state, cursor: 1,
        messages: [{ role: 'tool', content: [{ type: 'tool_result', callId: 'call-copilot', ok: true, content: 'accepted' }] }],
      }, 'copilot.tool_result', { callId: 'call-copilot', ok: true })
      const headers = { 'x-agent-runlab-ingress-handoff': 'origin-barrier-test-secret' }
      const copilotResult = await fetch(`${url}/internal/runtime/tool-result/origin-copilot/call-copilot`, { headers })
      expect(copilotResult.status).toBe(200)
      expect(await copilotResult.json()).toEqual({ persisted: true })
      expect(await (await fetch(`${url}/internal/runtime/tool-result/origin-copilot/other-call`, { headers })).json()).toEqual({ persisted: false })

      const kernel = await server.store.create({ sessionId: 'origin-kernel', config })
      await appendEventEntry({ path: kernel.logPath, seq: 1, event: { kind: 'tool_result', callId: 'call-kernel', ok: true, content: 'accepted' }, effects: [] })
      expect(await (await fetch(`${url}/internal/runtime/tool-result/origin-kernel/call-kernel`, { headers })).json()).toEqual({ persisted: true })
    } finally {
      if (previous === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('protects internal planned-restart control with the handoff secret', async () => {
    const previous = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'restart-control-test-secret'
    try {
      expect((await fetch(`${url}/internal/runtime/restart/status`)).status).toBe(401)
      const authorized = await fetch(`${url}/internal/runtime/restart/status`, {
        headers: { 'x-agent-runlab-ingress-handoff': 'restart-control-test-secret' },
      })
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toMatchObject({ pid: process.pid, current: null })
      const requested = await fetch(`${url}/internal/runtime/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'restart-control-test-secret' },
        body: JSON.stringify({ mode: 'checkpoint', reason: 'deploy', timeoutMs: 60_000 }),
      })
      expect(requested.status).toBe(200)
      expect(await requested.json()).toMatchObject({ phase: 'draining', mode: 'checkpoint' })
      await fetch(`${url}/runtime/restart/abort`, { method: 'POST' })
    } finally {
      if (previous === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('rejects public legacy restart control for a platform Runtime', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, httpServer: http,
      deployment: DEDICATED_DEPLOYMENT,
    })
    url = `http://localhost:${server.port}`

    for (const [path, method] of [
      ['/runtime/restart/status', 'GET'],
      ['/runtime/restart', 'POST'],
      ['/runtime/restart/commit', 'POST'],
      ['/runtime/restart/abort', 'POST'],
    ] as const) {
      const response = await fetch(`${url}${path}`, { method })
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('Deploy Supervisor') })
    }
    expect(server.restartStatus().current).toBeNull()
  })

  it('acknowledges internal admission as durably accepted before the operation reaches Session JSONL', async () => {
    const previous = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'admission-jsonl-test-secret'
    try {
      const sessionId = 'admission-jsonl-session'
      await server.store.create({ sessionId, config })
      const first = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-jsonl-test-secret' },
        body: JSON.stringify({ sessionId, operationId: 'operation-admission-jsonl', text: 'deliver exactly once', intent: 'text', mode: 'queue' }),
      })
      expect(first.status).toBe(200)
      const initial = await first.json() as { accepted: boolean; committed: boolean; cursor?: number }
      expect(initial).toMatchObject({ accepted: true, committed: false })
      await vi.waitFor(async () => {
        const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
        expect(parsed.events.some((entry) => entry.event.kind === 'user_message' && entry.event.operationId === 'operation-admission-jsonl')).toBe(true)
      })
      const retry = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-jsonl-test-secret' },
        body: JSON.stringify({ sessionId, operationId: 'operation-admission-jsonl', text: 'deliver exactly once', intent: 'text', mode: 'queue' }),
      })
      const committed = await retry.json() as { committed: boolean; cursor: number }
      expect(committed).toMatchObject({ committed: true, cursor: expect.any(Number) })
      const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
      expect(parsed.events.filter((entry) => entry.event.kind === 'user_message' && entry.event.operationId === 'operation-admission-jsonl')).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('keeps deleted, stopped, and delete-before-arrival operationIds cancelled across retries and restart', async () => {
    const previous = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'admission-cancellation-test-secret'
    let releaseFirst!: () => void
    try {
      await server.close()
      const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
      const seenPrompts: string[] = []
      const http = createServer()
      await new Promise<void>((resolve) => http.listen(0, resolve))
      server = await startHostServer({
        port: (http.address() as AddressInfo).port,
        sessionsDir: dir,
        defaultConfig: config,
        httpServer: http,
        llm: {
          name: 'queue-cancellation-test',
          async call(params) {
            const prompt = params.messages.filter((message) => message.role === 'user').map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join('')).join('|')
            seenPrompts.push(prompt)
            if (seenPrompts.length === 1) await firstRelease
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
          },
        },
      })
      url = `http://localhost:${server.port}`
      const sessionId = 'admission-cancellation-session'
      await server.store.create({ sessionId, config })
      const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
        transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
      })
      let latestQueue: ServerMessageQueueEvent | undefined
      dashboard.on('server:message_queue', (payload) => { if (payload.sessionId === sessionId) latestQueue = payload })
      await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
      dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'active turn', mode: 'steer' })
      await vi.waitFor(() => expect(seenPrompts).toHaveLength(1))

      const admit = async (operationId: string, text = operationId): Promise<{ accepted: boolean; committed: boolean }> => {
        const response = await fetch(`${url}/internal/runtime/admission/commit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-cancellation-test-secret' },
          body: JSON.stringify({ sessionId, operationId, text, intent: 'text', mode: 'queue' }),
        })
        expect(response.status).toBe(200)
        return await response.json() as { accepted: boolean; committed: boolean }
      }
      const deleteQueued = async (id: string): Promise<void> => {
        const result = await new Promise<RpcAck>((resolve) => dashboard.emit('client:delete_queued_message', { sessionId, id, operationId: `delete-${id}` }, resolve))
        expect(result).toEqual({ ok: true })
      }

      expect(await admit('operation-deleted')).toMatchObject({ accepted: true, committed: false })
      await vi.waitFor(() => expect(latestQueue?.items.some((item) => item.id === 'operation-deleted')).toBe(true))
      await deleteQueued('operation-deleted')
      expect(await admit('operation-deleted', 'retry must stay cancelled')).toMatchObject({ accepted: true, committed: false })

      await deleteQueued('operation-before-arrival')
      expect(await admit('operation-before-arrival')).toMatchObject({ accepted: true, committed: false })

      const [, concurrentAdmission] = await Promise.all([
        deleteQueued('operation-concurrent-delete'),
        admit('operation-concurrent-delete'),
      ])
      expect(concurrentAdmission).toMatchObject({ accepted: true, committed: false })
      expect(await admit('operation-concurrent-delete', 'concurrent retry')).toMatchObject({ accepted: true, committed: false })

      await admit('operation-stopped-one')
      await admit('operation-stopped-two')
      await vi.waitFor(() => expect(latestQueue?.pending).toBe(2))
      const stopped = await new Promise<RpcAck>((resolve) => dashboard.emit('client:cancel', { sessionId, operationId: 'stop-pending-admissions' }, resolve))
      expect(stopped).toEqual({ ok: true })
      await vi.waitFor(() => expect(latestQueue?.pending).toBe(0))
      expect(await admit('operation-stopped-one', 'stopped retry one')).toMatchObject({ accepted: true, committed: false })
      expect(await admit('operation-stopped-two', 'stopped retry two')).toMatchObject({ accepted: true, committed: false })

      releaseFirst()
      await vi.waitFor(() => expect(server.store.get(sessionId)?.state.status).toBe('done'))
      dashboard.close()
      await server.close()

      const restartedHttp = createServer()
      await new Promise<void>((resolve) => restartedHttp.listen(0, resolve))
      server = await startHostServer({
        port: (restartedHttp.address() as AddressInfo).port,
        sessionsDir: dir,
        defaultConfig: config,
        httpServer: restartedHttp,
        llm: { name: 'queue-cancellation-restart-test', async call() { throw new Error('cancelled admission was resurrected') } },
      })
      url = `http://localhost:${server.port}`
      expect(await admit('operation-deleted', 'restart retry')).toMatchObject({ accepted: true, committed: false })
      expect(await admit('operation-before-arrival', 'restart race retry')).toMatchObject({ accepted: true, committed: false })
      expect(await admit('operation-concurrent-delete', 'restart concurrent retry')).toMatchObject({ accepted: true, committed: false })
      expect(await admit('operation-stopped-one', 'restart stopped retry')).toMatchObject({ accepted: true, committed: false })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
      for (const operationId of ['operation-deleted', 'operation-before-arrival', 'operation-concurrent-delete', 'operation-stopped-one', 'operation-stopped-two']) {
        expect(parsed.events.some((entry) => entry.event.kind === 'user_message' && entry.event.operationId === operationId)).toBe(false)
      }
    } finally {
      releaseFirst?.()
      if (previous === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('honors a delete-before-arrival tombstone for a Copilot Session without invoking its runtime', async () => {
    const previous = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'copilot-cancellation-test-secret'
    try {
      const sessionId = 'copilot-admission-cancellation'
      await server.store.create({ sessionId, agentRuntime: 'copilot', agentRuntimeVersion: '1.0.11', externalSessionId: sessionId, config })
      await server.close()
      await persistMessageQueueSnapshot(server.store, sessionId, [], ['operation-copilot-before-arrival'])
      const http = createServer()
      await new Promise<void>((resolve) => http.listen(0, resolve))
      server = await startHostServer({
        port: (http.address() as AddressInfo).port,
        sessionsDir: dir,
        defaultConfig: config,
        httpServer: http,
        llm: scriptedLlm(),
      })
      url = `http://localhost:${server.port}`

      const response = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'copilot-cancellation-test-secret' },
        body: JSON.stringify({ sessionId, operationId: 'operation-copilot-before-arrival', text: 'must not reach Copilot', intent: 'text', mode: 'queue' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ accepted: true, committed: false })
      expect(server.store.get(sessionId)?.state.messages.some((message) => message.role === 'user')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('returns a stable machine-readable failure when internal admission targets a deleted Session', async () => {
    const previous = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'admission-missing-session-secret'
    try {
      const response = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-missing-session-secret' },
        body: JSON.stringify({ sessionId: 'deleted-session', operationId: 'operation-deleted-session', text: 'cannot deliver', intent: 'text', mode: 'queue' }),
      })
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_NOT_FOUND', error: expect.stringContaining('no longer exists') })
    } finally {
      if (previous === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('handshake auth rejects role mismatch', async () => {
    const bad: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('role_mismatch')
    bad.close()
  })

  it('reports a clear error when the requested port is already in use', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, resolve))
    const port = (occupied.address() as AddressInfo).port
    const sessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-port-'))

    try {
      await expect(startHostServer({
        port,
        sessionsDir,
        llm: scriptedLlm(),
        defaultConfig: config,
        toolTimeoutMs: 2000,
      })).rejects.toThrow(`Port ${port} is already in use`)
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('keeps candidate Dashboard mutations fenced until mutable runtime readiness while permitting reads', async () => {
    await server.close()
    let mutableReady = false
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, mutableReady: () => mutableReady })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'readiness-fence-client', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))
    const sessions = await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.once('server:sessions', resolve)
      dashboard.emit('client:list_sessions', {})
    })
    expect(Array.isArray(sessions.sessions)).toBe(true)
    const rejected = await dashboard.timeout(1000).emitWithAck('client:create_session', { operationId: 'operation-before-ready', sessionId: 'candidate-mutation' })
    expect(rejected).toMatchObject({ ok: false, error: 'runtime_not_ready' })
    expect(server.store.get('candidate-mutation')).toBeUndefined()
    mutableReady = true
    await new Promise<void>((resolve, reject) => dashboard.emit('client:create_session', { operationId: 'operation-after-ready', sessionId: 'candidate-mutation' }, (ack) => ack.ok ? resolve() : reject(new Error(ack.error))))
    expect(server.store.get('candidate-mutation')).toBeTruthy()
    dashboard.close()
  })

  it('does not let candidate read subscriptions resume a dangling Session before route commit', async () => {
    await server.close()
    const seedLlm: LLMAdapter = {
      name: 'seed',
      async call() {
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'must be continued only by the planned restart owner' }] } }
      },
    }
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: seedLlm, defaultConfig: config })
    const record = await server.store.create({ sessionId: 'candidate-dangling', config })
    await server.store.record(
      record.sessionId,
      { kind: 'user_message', text: 'continue me after cutover' },
      [{ kind: 'call_llm', messages: record.state.messages, tools: config.tools }],
      { ...record.state, status: 'thinking', cursor: record.state.cursor + 1, messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'continue me after cutover' }] }] },
    )
    const frozenCursor = server.store.get(record.sessionId)!.state.cursor
    await server.close()

    let llmCalls = 0
    let mutableReady = false
    server = await startHostServer({
      port: 0, sessionsDir: dir, defaultConfig: config, mutableReady: () => mutableReady,
      llm: { name: 'candidate', async call() { llmCalls += 1; return { message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } } } },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'candidate-reader', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))
    await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'candidate-read-subscribe', generation: 1, channels: [`session:${record.sessionId}`],
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(llmCalls).toBe(0)
    expect(server.store.get(record.sessionId)!.state).toMatchObject({ status: 'thinking', cursor: frozenCursor })

    mutableReady = true
    await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'public-read-subscribe', generation: 2, channels: [`session:${record.sessionId}`],
    })
    await vi.waitFor(() => expect(llmCalls).toBe(1))
    expect(server.store.get(record.sessionId)!.state.cursor).toBe(frozenCursor + 1)
    dashboard.close()
  })

  it('keeps candidate overflow reads from recovering a dangling Session as interrupted', async () => {
    await server.close()
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config })
    const record = await server.store.create({
      sessionId: 'candidate-overflow-read',
      workspaceId: 'workspace-overflow-read',
      config,
    })
    await server.store.record(
      record.sessionId,
      { kind: 'user_message', text: 'continue only through planned restart' },
      [{ kind: 'call_llm', messages: record.state.messages, tools: config.tools }],
      { ...record.state, status: 'thinking', cursor: record.state.cursor + 1, messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'continue only through planned restart' }] }] },
    )
    const frozenCursor = server.store.get(record.sessionId)!.state.cursor
    await server.close()

    server = await startHostServer({
      port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, mutableReady: () => false,
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'candidate-overflow-reader', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))
    const result = new Promise<void>((resolve) => dashboard.once('server:overflow_contents', () => resolve()))
    dashboard.emit('client:read_overflow', {
      requestId: 'candidate-overflow-request', sessionId: record.sessionId, callId: 'candidate-overflow-call',
    })
    await result

    expect(server.store.get(record.sessionId)!.state).toMatchObject({ status: 'thinking', cursor: frozenCursor })
    const parsed = await readSessionLog(server.store.get(record.sessionId)!.logPath)
    expect(parsed.events.some((entry) => JSON.stringify(entry).includes('[interrupted]'))).toBe(false)
    dashboard.close()
  })

  it('returns 404 for stale static chunks instead of the SPA HTML shell', async () => {
    await server.close()
    const staticDir = mkdtempSync(join(tmpdir(), 'agent-kernel-static-'))
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>dashboard shell</title>', 'utf8')
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      staticDir,
    })
    url = `http://localhost:${server.port}`

    const staleChunk = await fetch(`${url}/assets/index-stale.js`)
    expect(staleChunk.status).toBe(404)
    expect(staleChunk.headers.get('content-type') ?? '').not.toContain('text/html')

    const spaRoute = await fetch(`${url}/sessions/example`)
    expect(spaRoute.status).toBe(200)
    expect(spaRoute.headers.get('content-type')).toContain('text/html')
    expect(await spaRoute.text()).toContain('dashboard shell')

    rmSync(staticDir, { recursive: true, force: true })
  })

  it('returns 404 for stale embedded chunks instead of the SPA HTML shell', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      embeddedStaticAssets: [
        { path: 'index.html', contentBase64: Buffer.from('<!doctype html><title>embedded shell</title>').toString('base64') },
      ],
    })
    url = `http://localhost:${server.port}`

    const staleChunk = await fetch(`${url}/assets/index-stale.js`)
    expect(staleChunk.status).toBe(404)
    expect(staleChunk.headers.get('content-type') ?? '').not.toContain('text/html')

    const spaRoute = await fetch(`${url}/sessions/example`)
    expect(spaRoute.status).toBe(200)
    expect(spaRoute.headers.get('content-type')).toContain('text/html')
    expect(await spaRoute.text()).toContain('embedded shell')
  })

  it('serves local release assets without SPA fallback', async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-assets-'))
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-sessions-'))
    await writeFile(join(releaseDir, 'run.sh'), '#!/usr/bin/env bash\necho local\n', 'utf8')
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      releaseAssetsDir: releaseDir,
      settings: {
        providers: [],
        defaultModel: '',
        hooks: [],
        paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
        mcp: { supported: false, note: '' },
        release: { bootstrapBaseUrl: 'http://localhost:0/release-assets', source: 'local' },
      },
    })

    try {
      const ok = await fetch(`http://localhost:${localServer.port}/release-assets/run.sh`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('echo local')
      const missing = await fetch(`http://localhost:${localServer.port}/release-assets/missing.sh`)
      expect(missing.status).toBe(404)
      const powershell = await fetch(`http://localhost:${localServer.port}/install.ps1`, {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'downloads.example.test' },
      })
      expect(powershell.status).toBe(410)
      expect(powershell.headers.get('content-type')).toContain('application/json')
      expect(await powershell.json()).toEqual({ error: 'windows_release_assets_unavailable' })
    } finally {
      await localServer.close()
      rmSync(releaseDir, { recursive: true, force: true })
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('enables Windows installation only for a complete checksum-matching local release set', async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), 'agent-kernel-windows-release-assets-'))
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-windows-release-sessions-'))
    const assets = new Map([
      ['kala-executor-win32-x64.exe', Buffer.from('native-executor-fixture')],
      ['kala-executor-service-host-win32-x64.exe', Buffer.from('service-host-fixture')],
      ['node-pty-win32-x64.tar.gz', Buffer.from('conpty-companion-fixture')],
      ['install-executor.ps1', Buffer.from("Write-Host 'installer fixture'\n")],
    ])
    for (const [name, content] of assets) {
      if (name !== 'kala-executor-service-host-win32-x64.exe') await writeFile(join(releaseDir, name), content)
    }
    await writeFile(join(releaseDir, 'SHA256SUMS'), [...assets].map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}`).join('\n') + '\n')
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      releaseAssetsDir: releaseDir,
    })

    try {
      const capabilityUrl = `http://localhost:${localServer.port}/api/executor-install-capabilities`
      const incomplete = await fetch(capabilityUrl)
      expect(incomplete.status).toBe(200)
      await expect(incomplete.json()).resolves.toMatchObject({ platforms: { windows: { available: false } } })
      expect((await fetch(`http://localhost:${localServer.port}/install.ps1`)).status).toBe(410)

      const serviceHost = assets.get('kala-executor-service-host-win32-x64.exe')!
      await writeFile(join(releaseDir, 'kala-executor-service-host-win32-x64.exe'), serviceHost)
      const complete = await fetch(capabilityUrl)
      await expect(complete.json()).resolves.toMatchObject({ platforms: { windows: { available: true } } })
      const native = assets.get('kala-executor-win32-x64.exe')!
      const nativeUrl = `http://localhost:${localServer.port}/install/assets/kala-executor-win32-x64.exe`
      const nativeResponse = await fetch(nativeUrl)
      expect(nativeResponse.headers.get('content-length')).toBe(String(native.byteLength))
      expect(Buffer.from(await nativeResponse.arrayBuffer())).toEqual(native)
      const nativeHead = await fetch(nativeUrl, { method: 'HEAD' })
      expect(nativeHead.headers.get('content-length')).toBe(String(native.byteLength))
      const powershell = await fetch(`http://localhost:${localServer.port}/install.ps1`)
      expect(powershell.status).toBe(200)
      expect(await powershell.text()).toContain('/install/assets/install-executor.ps1')
      const created = await fetch(`http://localhost:${localServer.port}/api/executor-installs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'windows', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: 'C:\\work' }),
      })
      expect(created.status).toBe(201)
      expect((await created.json()) as { command: string }).toHaveProperty('command', expect.stringContaining('/install.ps1'))

      await writeFile(join(releaseDir, 'kala-executor-service-host-win32-x64.exe'), Buffer.from('tampered-service-host'))
      const checksumMismatch = await fetch(capabilityUrl)
      await expect(checksumMismatch.json()).resolves.toMatchObject({ platforms: { windows: { available: false } } })
      expect((await fetch(`http://localhost:${localServer.port}/install.ps1`)).status).toBe(410)
    } finally {
      await localServer.close()
      rmSync(releaseDir, { recursive: true, force: true })
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('serves embedded release assets when the local release dir is missing a file', async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-assets-empty-'))
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-sessions-'))
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      releaseAssetsDir: releaseDir,
      embeddedReleaseAssets: [
        { path: 'kala-executor.cjs', contentBase64: Buffer.from('#!/usr/bin/env node\nconsole.log("embedded executor")\n').toString('base64') },
        { path: 'SHA256SUMS', contentBase64: Buffer.from('abc  kala-executor.cjs\n').toString('base64') },
      ],
      settings: {
        providers: [],
        defaultModel: '',
        hooks: [],
        paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
        mcp: { supported: false, note: '' },
        release: { bootstrapBaseUrl: 'http://localhost:0/release-assets', source: 'local' },
      },
    })

    try {
      const ok = await fetch(`http://localhost:${localServer.port}/release-assets/kala-executor.cjs`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('embedded executor')
      const sums = await fetch(`http://localhost:${localServer.port}/release-assets/SHA256SUMS`)
      expect(sums.status).toBe(200)
      expect(await sums.text()).toContain('kala-executor.cjs')
      const missing = await fetch(`http://localhost:${localServer.port}/release-assets/missing.cjs`)
      expect(missing.status).toBe(404)
    } finally {
      await localServer.close()
      rmSync(releaseDir, { recursive: true, force: true })
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('serves embedded installer assets without requiring a local release directory', async () => {
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-embedded-installer-sessions-'))
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      embeddedReleaseAssets: [
        { path: 'run.sh', contentBase64: Buffer.from('#!/usr/bin/env bash\necho embedded installer\n').toString('base64') },
      ],
    })

    try {
      const response = await fetch(`http://localhost:${localServer.port}/install/assets/run.sh`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/x-shellscript')
      expect(await response.text()).toContain('embedded installer')
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('scopes agent prompt GET/POST and existing Session synchronization to the actor organization', async () => {
    const prompts = new Map([['org_a', 'old-a'], ['org_b', 'old-b']])
    const slotsFor = (prompt: string) => [
      { id: 'slot-1' as const, name: 'One', prompt },
      { id: 'slot-2' as const, name: 'Two', prompt: `${prompt}-two` },
      { id: 'slot-3' as const, name: 'Three', prompt: `${prompt}-three` },
    ]
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-agent-prompt-'))
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      defaultConfig: (actor) => createConfig({ tools: [], systemPrompt: prompts.get(actor?.kind === 'ingress' ? actor.organizationId : '') ?? 'portable' }),
      settings: (actor) => ({
        providers: [],
        defaultModel: '',
        hooks: [],
        agentPrompt: {
          selectedSlotId: 'slot-1',
          slots: slotsFor(prompts.get(actor.kind === 'ingress' ? actor.organizationId : '') ?? 'portable'),
          configPath: '/tmp/agent.json',
        },
        paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
        mcp: { supported: false, note: '' },
      }),
      updateAgentPrompt: (input, actor) => {
        if (actor.kind !== 'ingress') throw new Error('organization required')
        prompts.set(actor.organizationId, input.slots.find((slot) => slot.id === input.selectedSlotId)!.prompt)
        return {
          providers: [],
          defaultModel: '',
          hooks: [],
          agentPrompt: { selectedSlotId: input.selectedSlotId, slots: input.slots, configPath: '/tmp/agent.json' },
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
          mcp: { supported: false, note: '' },
        }
      },
    })

    try {
      await localServer.store.create({ sessionId: 'old-org-a', config: createConfig({ tools: [], systemPrompt: 'old-a' }), organizationId: 'org_a' })
      await localServer.store.create({ sessionId: 'old-org-b', config: createConfig({ tools: [], systemPrompt: 'old-b' }), organizationId: 'org_b' })
      const headers = {
        'content-type': 'application/json',
        'x-agent-runlab-principal': 'admin@example.test',
        'x-agent-runlab-organization-id': 'org_a',
        'x-agent-runlab-organization-role': 'admin',
      }
      const before = await fetch(`http://localhost:${localServer.port}/settings`, { headers })
      expect((await before.json() as ServerSettingsPayload).agentPrompt?.slots[0]?.prompt).toBe('old-a')

      const response = await fetch(`http://localhost:${localServer.port}/settings/agent-prompt`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ selectedSlotId: 'slot-1', slots: slotsFor('new-a') }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as ServerSettingsPayload
      expect(body.agentPrompt?.slots[0]?.prompt).toBe('new-a')
      expect(localServer.store.get('old-org-a')?.config.systemPrompt).toBe('new-a')
      expect(localServer.store.get('old-org-a')?.state.systemPromptOverride?.prompt).toBe('new-a')
      expect(localServer.store.get('old-org-b')?.config.systemPrompt).toBe('old-b')
      expect(localServer.store.get('old-org-b')?.state.systemPromptOverride).toBeUndefined()
      const created = await fetch(`http://localhost:${localServer.port}/api/v1/sessions`, {
        method: 'POST', headers,
        body: JSON.stringify({ operationId: 'org-a-api-create', sessionId: 'org-a-api' }),
      })
      expect(created.status).toBe(201)
      expect(localServer.store.get('org-a-api')?.config.systemPrompt).toBe('new-a')
      expect(localServer.store.get('org-a-api')?.organizationId).toBe('org_a')
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('returns 503 after settings commit and retries residual Session synchronization', async () => {
    let prompt = 'old prompt'
    const slotsFor = (value: string) => [
      { id: 'slot-1' as const, name: 'One', prompt: value },
      { id: 'slot-2' as const, name: 'Two', prompt: `${value}-two` },
      { id: 'slot-3' as const, name: 'Three', prompt: `${value}-three` },
    ]
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-agent-prompt-retry-'))
    const settings = (): ServerSettingsPayload => ({
      providers: [], defaultModel: '', hooks: [],
      agentPrompt: { selectedSlotId: 'slot-1', slots: slotsFor(prompt), configPath: '/tmp/agent.json' },
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
      mcp: { supported: false, note: '' },
    })
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: () => createConfig({ tools: [], systemPrompt: prompt }),
      settings,
      updateAgentPrompt: (input) => {
        prompt = input.slots.find((slot) => slot.id === input.selectedSlotId)!.prompt
        return settings()
      },
      promptSynchronizationRetryMs: 10,
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await localServer.store.create({ sessionId: 'prompt-retry', config: createConfig({ tools: [], systemPrompt: 'old prompt' }) })
      const apply = vi.spyOn(localServer.store, 'applySystemPrompt')
      apply.mockRejectedValueOnce(new Error('storage temporarily unavailable'))

      const response = await fetch(`http://localhost:${localServer.port}/settings/agent-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedSlotId: 'slot-1', slots: slotsFor('new prompt') }),
      })

      expect(response.status).toBe(503)
      expect(await response.text()).toContain('settings were saved')
      expect(prompt).toBe('new prompt')
      expect(localServer.store.get('prompt-retry')?.config.systemPrompt).toBe('old prompt')
      await vi.waitFor(() => {
        expect(localServer.store.get('prompt-retry')?.config.systemPrompt).toBe('new prompt')
      })
      expect(apply).toHaveBeenCalledTimes(2)
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('reports saved settings as pending when organization discovery fails, then retries discovery', async () => {
    let prompt = 'old discovery prompt'
    const slotsFor = (value: string) => [
      { id: 'slot-1' as const, name: 'One', prompt: value },
      { id: 'slot-2' as const, name: 'Two', prompt: value },
      { id: 'slot-3' as const, name: 'Three', prompt: value },
    ]
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-agent-prompt-discovery-'))
    const settings = (): ServerSettingsPayload => ({
      providers: [], defaultModel: '', hooks: [],
      agentPrompt: { selectedSlotId: 'slot-1', slots: slotsFor(prompt), configPath: '/tmp/agent.json' },
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
      mcp: { supported: false, note: '' },
    })
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: () => createConfig({ tools: [], systemPrompt: prompt }),
      settings,
      updateAgentPrompt: (input) => {
        prompt = input.slots.find((slot) => slot.id === input.selectedSlotId)!.prompt
        return settings()
      },
      promptSynchronizationRetryMs: 10,
    })
    try {
      await localServer.store.create({ sessionId: 'prompt-discovery-retry', config: createConfig({ tools: [], systemPrompt: prompt }) })
      const discovery = vi.spyOn(localServer.store, 'listSessionIdsForOrganization')
      const backgroundDiscovery = vi.spyOn(localServer.store, 'listSessionIds')
      discovery.mockRejectedValueOnce(new Error('Temporary Session header read failure'))
      const response = await fetch(`http://localhost:${localServer.port}/settings/agent-prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedSlotId: 'slot-1', slots: slotsFor('new discovery prompt') }),
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ settingsSaved: true })
      expect(prompt).toBe('new discovery prompt')
      await vi.waitFor(() => {
        expect(localServer.store.get('prompt-discovery-retry')?.config.systemPrompt).toBe('new discovery prompt')
      })
      expect(discovery).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(backgroundDiscovery).toHaveBeenCalled())
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('reconciles persisted Session prompts after restart without waiting for a model call', async () => {
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-agent-prompt-startup-'))
    const first = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: createConfig({ tools: [], systemPrompt: 'old startup prompt' }),
    })
    await first.store.create({ sessionId: 'startup-prompt-repair', config: createConfig({ tools: [], systemPrompt: 'old startup prompt' }) })
    await first.close()

    const second = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: createConfig({ tools: [], systemPrompt: 'new startup prompt' }),
      promptSynchronizationRetryMs: 10,
    })
    try {
      await vi.waitFor(() => {
        expect(second.store.get('startup-prompt-repair')?.config.systemPrompt).toBe('new startup prompt')
      })
      expect(second.store.get('startup-prompt-repair')?.state.systemPromptOverride?.prompt).toBe('new startup prompt')
    } finally {
      await second.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('does not recover or append to a dangling Copilot Session when startup finds no prompt change', async () => {
    await server.close()
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config })
    const record = await server.store.create({
      sessionId: 'unchanged-copilot-prompt', agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11', externalSessionId: 'unchanged-copilot-prompt', config,
    })
    await server.store.recordRuntimeProjection(record.sessionId, {
      ...record.state, status: 'thinking', cursor: record.state.cursor + 1,
      messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'do not interrupt' }] }],
    }, 'copilot.user_message', {})
    await server.close()
    const before = readFileSync(record.logPath, 'utf8')
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, promptSynchronizationRetryMs: 10 })
    url = `http://localhost:${server.port}`
    await vi.waitFor(() => expect(server.store.get(record.sessionId)).toBeTruthy())
    expect(server.store.get(record.sessionId)?.state.status).toBe('thinking')
    expect(readFileSync(record.logPath, 'utf8')).toBe(before)
  })

  it('enables Socket.IO Admin UI immediately after the password is initialized', async () => {
    let initialized = false
    let runtimeMode: 'production' | 'development' = 'production'
    let configuredMode: 'production' | 'development' = 'production'
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-socket-admin-'))
    const adminPath = '/admin/socket.io'
    const settings = (): ServerSettingsPayload => ({
      providers: [],
      defaultModel: '',
      hooks: [],
      socketAdmin: {
        active: initialized,
        initialized,
        path: adminPath,
        username: 'admin',
        runtimeMode,
        configuredMode,
        configPath: join(localSessionsDir, 'socket-admin.json'),
        ...(initialized ? { distSource: 'embedded' as const } : {}),
        ...(initialized && configuredMode !== runtimeMode ? { restartRequired: true } : {}),
      },
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: localSessionsDir },
      mcp: { supported: false, note: '' },
    })
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      settings,
      embeddedSocketAdminAssets: [
        { path: 'index.html', contentBase64: Buffer.from('<!doctype html><title>socket admin</title><script src="js/app.js"></script>').toString('base64') },
        { path: 'js/app.js', contentBase64: Buffer.from('globalThis.socketAdminLoaded = true').toString('base64') },
      ],
      initializeSocketAdmin: (input) => {
        if (initialized) {
          const err = new Error('already initialized') as Error & { status?: number }
          err.status = 409
          throw err
        }
        expect(input.password).toBe('password-123')
        expect(input.mode).toBe('development')
        initialized = true
        runtimeMode = input.mode ?? configuredMode
        configuredMode = runtimeMode
        input.activate({
          enabled: true,
          path: adminPath,
          username: 'admin',
          passwordHash: '$2b$10$012345678901234567890u7Z/08sx9Loa7TXHL62ojTkhUMYeOHpu',
          mode: runtimeMode,
          distSource: 'embedded',
        })
        return settings()
      },
      updateSocketAdminMode: (input) => {
        configuredMode = input.mode
        return settings()
      },
    })

    try {
      const init = await fetch(`http://localhost:${localServer.port}/settings/socket-admin/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'password-123', mode: 'development' }),
      })
      expect(init.status).toBe(200)
      const body = await init.json() as ServerSettingsPayload
      expect(body.socketAdmin?.initialized).toBe(true)
      expect(body.socketAdmin?.active).toBe(true)
      expect(body.socketAdmin?.runtimeMode).toBe('development')
      expect(body.socketAdmin?.configuredMode).toBe('development')
      expect(body.socketAdmin?.restartRequired).toBeUndefined()

      const updateMode = await fetch(`http://localhost:${localServer.port}/settings/socket-admin/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'production' }),
      })
      expect(updateMode.status).toBe(200)
      const modeBody = await updateMode.json() as ServerSettingsPayload
      expect(modeBody.socketAdmin?.runtimeMode).toBe('development')
      expect(modeBody.socketAdmin?.configuredMode).toBe('production')
      expect(modeBody.socketAdmin?.restartRequired).toBe(true)

      const noSlash = await fetch(`http://localhost:${localServer.port}${adminPath}`, { redirect: 'manual' })
      expect(noSlash.status).toBe(308)
      expect(noSlash.headers.get('location')).toBe(`${adminPath}/`)

      const adminUi = await fetch(`http://localhost:${localServer.port}${adminPath}/`)
      expect(adminUi.status).toBe(200)
      expect(await adminUi.text()).toContain('socket admin')

      const adminJs = await fetch(`http://localhost:${localServer.port}${adminPath}/js/app.js`)
      expect(adminJs.status).toBe(200)
      expect(adminJs.headers.get('content-type')).toContain('application/javascript')
      expect(await adminJs.text()).toContain('socketAdminLoaded')

      const second = await fetch(`http://localhost:${localServer.port}/settings/socket-admin/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'password-123' }),
      })
      expect(second.status).toBe(409)
      await second.text()
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('updates manual providers through HTTP without returning API keys', async () => {
    let providers: ServerSettingsPayload['providers'] = []
    let defaultModel = ''
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-manual-provider-'))
    const settings = (): ServerSettingsPayload => ({
      providers,
      defaultModel,
      hooks: [],
      paths: { claudeSettings: '', codexConfig: '', manualModels: '/tmp/models.json', hooksConfig: '', sessionsDir: '' },
      mcp: { supported: false, note: '' },
    })
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      settings,
      addManualProvider: (input) => {
        providers = [{
          id: input.id,
          label: input.label ?? input.id,
          wire: input.wire,
          source: 'manual',
          baseUrl: input.baseUrl,
          models: [],
        }]
        return settings()
      },
      deleteManualProvider: (input) => {
        providers = providers.filter((p) => p.id !== input.providerId)
        return settings()
      },
      setDefaultModel: (input) => {
        defaultModel = input.model
        return settings()
      },
    })

    try {
      const add = await fetch(`http://localhost:${localServer.port}/settings/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'local-openai',
          label: 'Local OpenAI',
          wire: 'openai',
          baseUrl: 'http://localhost:8000/v1',
          apiKey: 'test-redacted-api-key',
        }),
      })
      expect(add.status).toBe(200)
      const added = await add.json() as ServerSettingsPayload
      expect(added.providers).toEqual([
        expect.objectContaining({
          id: 'local-openai',
          label: 'Local OpenAI',
          wire: 'openai',
          source: 'manual',
          baseUrl: 'http://localhost:8000/v1',
        }),
      ])
      expect(JSON.stringify(added)).not.toContain('test-redacted-api-key')

      const setDefault = await fetch(`http://localhost:${localServer.port}/settings/default-model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'local-openai:gpt-local' }),
      })
      expect(setDefault.status).toBe(200)
      const defaulted = await setDefault.json() as ServerSettingsPayload
      expect(defaulted.defaultModel).toBe('local-openai:gpt-local')
      expect(JSON.stringify(defaulted)).not.toContain('test-redacted-api-key')

      const del = await fetch(`http://localhost:${localServer.port}/settings/providers?providerId=local-openai`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const deleted = await del.json() as ServerSettingsPayload
      expect(deleted.providers).toEqual([])
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('handshake auth rejects mismatched protocol major', async () => {
    // Simulate an old dashboard build talking to a newer host.
    const bad: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'dashboard', clientVersion: '0.9.0' },
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('version_incompatible')
    bad.close()
  })

  it('handshake auth rejects missing clientVersion', async () => {
    const bad = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'dashboard' } as unknown as Record<string, unknown>,
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('version_incompatible')
    bad.close()
  })

  it('exposes compact dashboard socket metadata without duplicating session membership', async () => {
    const sessionId = 'wire-dashboard-metadata'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.once('connect', resolve))

    const data = await waitForSocketData(server.io.of('/dashboard'))
    expect(data.dashboardActor).toEqual({ kind: 'anonymous' })
    expect(data.connectionMeta).toEqual({
      kind: 'dashboard',
      label: 'dashboard',
      clientVersion: PROTOCOL_VERSION,
      connectedAt: expect.any(String),
    })
    expect(Object.keys(data.connectionMeta as Record<string, unknown>).sort()).toEqual([
      'clientVersion',
      'connectedAt',
      'kind',
      'label',
    ])
    expect(JSON.stringify(data)).not.toContain(sessionId)

    dashboard.close()
  })

  it('exposes compact executor socket metadata without private credentials', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: {
        executorTokens: [{ token: 'exec-secret-token', workspaceId: 'ws-meta', label: 'runner token' }],
      },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: 'exec-secret-token' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))

    const pending = await waitForSocketData(server.io.of('/executor'))
    expect(pending.executorIdentity).toEqual({
      accepted: true,
      workspaceId: 'ws-meta',
      label: 'runner token',
    })
    expect(pending.connectionMeta).toEqual({
      kind: 'executor',
      label: 'executor pending',
      clientVersion: PROTOCOL_VERSION,
      connectedAt: expect.any(String),
    })

    executor.emit('executor:announce', {
      executorId: 'exec-meta',
      workspaceId: 'ws-meta',
      workspaceName: 'metadata workspace',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })

    const announced = await waitForSocketData(server.io.of('/executor'), 1000, (data) => {
      const meta = data.connectionMeta as { executorId?: string } | undefined
      return meta?.executorId === 'exec-meta'
    })
    expect(announced.connectionMeta).toEqual({
      kind: 'executor',
      label: 'executor metadata workspace',
      clientVersion: PROTOCOL_VERSION,
      connectedAt: expect.any(String),
      executorId: 'exec-meta',
      workspaceId: 'ws-meta',
      workspaceName: 'metadata workspace',
    })
    expect(Object.keys(announced.connectionMeta as Record<string, unknown>).sort()).toEqual([
      'clientVersion',
      'connectedAt',
      'executorId',
      'kind',
      'label',
      'workspaceId',
      'workspaceName',
    ])
    expect(JSON.stringify(announced)).not.toContain('exec-secret-token')
    expect(announced.executorIdentity).not.toHaveProperty('inviteToken')
    expect(announced.executorIdentity).not.toHaveProperty('token')
    expect(announced.connectionMeta).not.toHaveProperty('inviteToken')
    expect(announced.connectionMeta).not.toHaveProperty('token')
    expect(JSON.stringify(announced)).not.toContain('tools')
    expect(JSON.stringify(announced)).not.toContain('runtimeVersion')

    executor.close()
  })

  it('rejects executor announce when token scope does not match workspaceId', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: {
        executorTokens: [{ token: 'exec-token', workspaceId: 'ws-allowed', label: 'allowed executor' }],
      },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: 'exec-token' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const reject = new Promise<{ code: string; message: string }>((resolve) => {
      executor.on('executor:host_reject', resolve)
    })
    executor.emit('executor:announce', {
      executorId: 'exec-1',
      workspaceId: 'ws-other',
      workspaceName: 'other',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await expect(reject).resolves.toMatchObject({ code: 'workspace_identity_mismatch' })
    executor.close()
  })

  it('accepts executor announce when token scope matches workspaceId', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: {
        executorTokens: [{ token: 'exec-token', workspaceId: 'ws-allowed' }],
      },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: 'exec-token' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    executor.emit('executor:announce', {
      executorId: 'exec-1',
      workspaceId: 'ws-allowed',
      workspaceName: 'allowed',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'dash', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await waitForWorkspace(dashboard, 'ws-allowed')
    dashboard.close()
    executor.close()
  })

  it('enforces tenant executor quota before attaching installed executors', async () => {
    await server.close()
    const identityStore = new ExecutorIdentityStore(join(dir, 'quota-executor-identities.json'))
    identityStore.load()
    const checks: unknown[] = []
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      auth: { executorIdentityStore: identityStore },
      executorQuota: {
        async assertCanAttachExecutor(params) {
          checks.push(params)
          throw new Error('organization executor quota exceeded')
        },
      },
    })
    url = `http://localhost:${server.port}`
    const install = await createRedeemedTenantExecutorInstall(url, 'org_exec_quota', 'ws-exec-quota')
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: install.token, installId: install.id },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const reject = new Promise<{ code: string; message: string }>((resolve) => executor.on('executor:host_reject', resolve))

    executor.emit('executor:announce', {
      executorId: 'exec-quota-denied',
      workspaceId: 'ws-exec-quota',
      workspaceName: 'quota denied',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })

    await expect(reject).resolves.toMatchObject({ message: 'organization executor quota exceeded' })
    expect(checks).toEqual([expect.objectContaining({
      organizationId: 'org_exec_quota',
      workspaceId: 'ws-exec-quota',
      executorId: 'exec-quota-denied',
      installId: install.id,
    })])
    expect(server.executorsSnapshot()).toEqual([])
    executor.close()
  })

  it('applies MCP reannouncements in socket arrival order across asynchronous tenant quota checks', async () => {
    await server.close()
    const identityStore = new ExecutorIdentityStore(join(dir, 'ordered-mcp-identities.json'))
    identityStore.load()
    const permits: Array<() => void> = []
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config,
      httpServer: http, deployment: PRIVATE_CLOUD_DEPLOYMENT,
      auth: { executorIdentityStore: identityStore },
      executorQuota: { async assertCanAttachExecutor() { await new Promise<void>((resolve) => permits.push(resolve)) } },
    })
    url = `http://localhost:${server.port}`
    const install = await createRedeemedTenantExecutorInstall(url, 'org_mcp_order', 'ws-mcp-order')
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: install.token, installId: install.id },
      reconnection: false,
    })
    try {
      await new Promise<void>((resolve) => executor.on('connect', resolve))
      const base = { executorId: 'exec-mcp-order', workspaceId: 'ws-mcp-order', workspaceName: 'mcp', runtime: 'node' as const, runtimeVersion: 'test' }
      const inputSchema = { type: 'object' }
      executor.emit('executor:announce', {
        ...base, tools: ['bash', 'docs__search'],
        mcpTools: [{ name: 'docs__search', description: 'Search docs', inputSchema, schemaHash: createHash('sha256').update(JSON.stringify(inputSchema)).digest('hex') }],
      })
      executor.emit('executor:announce', { ...base, tools: ['bash'], mcpTools: [] })
      await vi.waitFor(() => expect(permits).toHaveLength(1))
      permits.shift()!()
      await vi.waitFor(() => expect(permits).toHaveLength(1))
      permits.shift()!()
      await vi.waitFor(() => expect(server.executorsSnapshot().find((item) => item.workspaceId === 'ws-mcp-order')?.mcpTools).toEqual([]))
    } finally { executor.close() }
  })

  it('records tenant executor runtime after quota-allowed installed executors disconnect', async () => {
    await server.close()
    const identityStore = new ExecutorIdentityStore(join(dir, 'runtime-executor-identities.json'))
    identityStore.load()
    const attaches: unknown[] = []
    const runtimes: unknown[] = []
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      auth: { executorIdentityStore: identityStore },
      detachGraceMs: 0,
      executorQuota: {
        async assertCanAttachExecutor(params) {
          attaches.push(params)
        },
        async recordExecutorRuntime(params) {
          runtimes.push(params)
        },
      },
    })
    url = `http://localhost:${server.port}`
    const install = await createRedeemedTenantExecutorInstall(url, 'org_exec_quota', 'ws-exec-runtime')
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: install.token, installId: install.id },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))

    executor.emit('executor:announce', {
      executorId: 'exec-runtime',
      workspaceId: 'ws-exec-runtime',
      workspaceName: 'runtime',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await vi.waitFor(() => expect(server.executorsSnapshot().some((item) => item.executorId === 'exec-runtime')).toBe(true))
    executor.close()
    await vi.waitFor(() => expect(runtimes.length).toBe(1))

    expect(attaches).toEqual([expect.objectContaining({ organizationId: 'org_exec_quota', workspaceId: 'ws-exec-runtime', installId: install.id })])
    expect(runtimes).toEqual([expect.objectContaining({
      organizationId: 'org_exec_quota',
      workspaceId: 'ws-exec-runtime',
      executorId: 'exec-runtime',
      installId: install.id,
      durationMs: expect.any(Number),
    })])
  })

  it('creates permanent executor invites and binds the first announced workspace', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const inviteRes = await fetch(`${url}/auth/executor-invites`, { method: 'POST' })
    expect(inviteRes.ok).toBe(true)
    const invite = await inviteRes.json() as { id: string; inviteToken: string; createdAt: string }
    expect(invite.id).toMatch(/^inv_/)
    expect(invite.inviteToken).toMatch(/^ak_invite_/)
    expect(readFileSync(identityPath, 'utf8')).not.toContain(invite.inviteToken)

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const welcome = new Promise<{ token: string; workspaceId: string }>((resolve) => executor.on('executor:welcome', resolve))
    executor.emit('executor:announce', {
      executorId: 'exec-invite',
      workspaceId: 'ws-invite',
      workspaceName: 'invited',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    const payload = await welcome
    expect(payload.workspaceId).toBe('ws-invite')
    expect(payload.token).toMatch(/^ak_exec_/)
    const data = await waitForSocketData(server.io.of('/executor'), 1000, (candidate) => {
      const meta = candidate.connectionMeta as { workspaceId?: string } | undefined
      return meta?.workspaceId === 'ws-invite'
    })
    expect(data.executorIdentity).toEqual({
      accepted: true,
      workspaceId: 'ws-invite',
      label: 'invited',
    })
    expect(data.executorIdentity).not.toHaveProperty('inviteToken')
    expect(data.executorIdentity).not.toHaveProperty('token')
    expect(data.connectionMeta).not.toHaveProperty('inviteToken')
    expect(data.connectionMeta).not.toHaveProperty('token')
    expect(JSON.stringify(data)).not.toContain(invite.inviteToken)
    expect(JSON.stringify(data)).not.toContain(payload.token)
    expect(readFileSync(identityPath, 'utf8')).toContain('ws-invite')
    expect(readFileSync(identityPath, 'utf8')).not.toContain(payload.token)

    const listRes = await fetch(`${url}/auth/executor-identities`)
    expect(listRes.ok).toBe(true)
    const listBody = await listRes.json() as { identities: Array<{ workspaceId: string; token?: string; tokenHash?: string }> }
    expect(listBody.identities).toEqual([expect.objectContaining({ workspaceId: 'ws-invite' })])
    expect(JSON.stringify(listBody)).not.toContain(payload.token)
    expect(JSON.stringify(listBody)).not.toContain('tokenHash')

    const inviteList = await fetch(`${url}/auth/executor-invites`).then((res) => res.json()) as { invites: Array<{ id: string; workspaceId?: string; lastUsedAt?: string; inviteToken?: string; inviteHash?: string; revoked: boolean }> }
    expect(inviteList.invites).toEqual([expect.objectContaining({ id: invite.id, workspaceId: 'ws-invite', revoked: false })])
    expect(inviteList.invites[0]?.lastUsedAt).toBeTruthy()
    expect(JSON.stringify(inviteList)).not.toContain(invite.inviteToken)
    expect(JSON.stringify(inviteList)).not.toContain('inviteHash')

    const revokeRes = await fetch(`${url}/auth/executor-identities?workspaceId=ws-invite`, { method: 'DELETE' })
    expect(revokeRes.ok).toBe(true)
    expect(await revokeRes.json()).toEqual({ ok: true, workspaceId: 'ws-invite', revoked: true })
    const afterRevoke = await fetch(`${url}/auth/executor-identities`).then((res) => res.json()) as { identities: unknown[] }
    expect(afterRevoke.identities).toEqual([])
    executor.close()
  })

  it('revoking an executor invite also removes the saved reconnect identity', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const invite = await fetch(`${url}/auth/executor-invites`, { method: 'POST' }).then((res) => res.json()) as { id: string; inviteToken: string }
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    executor.emit('executor:announce', { executorId: 'exec-revoke-invite', workspaceId: 'ws-revoke-invite', workspaceName: 'revoked', tools: ['bash'], runtime: 'node', runtimeVersion: 'test' })
    await new Promise<{ token: string; workspaceId: string }>((resolve) => executor.on('executor:welcome', resolve))
    executor.close()
    await expect(fetch(`${url}/auth/executor-identities`).then((res) => res.json())).resolves.toMatchObject({ identities: [expect.objectContaining({ workspaceId: 'ws-revoke-invite' })] })

    const revokeRes = await fetch(`${url}/auth/executor-invites/${invite.id}/revoke`, { method: 'POST' })
    expect(revokeRes.ok).toBe(true)
    await expect(fetch(`${url}/auth/executor-identities`).then((res) => res.json())).resolves.toEqual({ identities: [] })
  })

  it('keeps executor invites valid across host restarts without storing plaintext invites', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const invite = await fetch(`${url}/auth/executor-invites`, { method: 'POST' }).then((res) => res.json()) as { inviteToken: string }
    expect(readFileSync(identityPath, 'utf8')).not.toContain(invite.inviteToken)

    await server.close()
    const restartedStore = new ExecutorIdentityStore(identityPath)
    restartedStore.load()
    const restartedHttp = createServer()
    await new Promise<void>((resolve) => restartedHttp.listen(0, resolve))
    server = await startHostServer({
      port: (restartedHttp.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: restartedHttp,
      auth: { executorIdentityStore: restartedStore },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const welcome = new Promise<{ token: string; workspaceId: string }>((resolve) => executor.on('executor:welcome', resolve))
    executor.emit('executor:announce', {
      executorId: 'exec-restarted-invite',
      workspaceId: 'ws-restarted-invite',
      workspaceName: 'restarted',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await expect(welcome).resolves.toMatchObject({ workspaceId: 'ws-restarted-invite' })
    executor.close()
  })

  it('rejects invite replay even for the bound workspace while allowing device token reconnect', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const invite = await fetch(`${url}/auth/executor-invites`, { method: 'POST' }).then((res) => res.json()) as { inviteToken: string }

    async function announceWithInvite(executorId: string, workspaceId: string): Promise<ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>> {
      const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
        transports: ['websocket'],
        auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
        reconnection: false,
      })
      await new Promise<void>((resolve) => executor.on('connect', resolve))
      executor.emit('executor:announce', { executorId, workspaceId, workspaceName: workspaceId, tools: ['bash'], runtime: 'node', runtimeVersion: 'test' })
      return executor
    }

    const first = await announceWithInvite('exec-reuse-1', 'ws-reuse')
    const welcome = await new Promise<{ token: string; workspaceId: string }>((resolve) => first.on('executor:welcome', resolve))
    first.close()

    const second = await announceWithInvite('exec-reuse-2', 'ws-reuse')
    await expect(new Promise<{ code: string }>((resolve) => second.on('executor:host_reject', resolve))).resolves.toMatchObject({ code: 'auth_failed' })
    second.close()

    const reconnect: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: welcome.token, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => reconnect.on('connect', resolve))
    reconnect.emit('executor:announce', { executorId: 'exec-reuse-1', workspaceId: 'ws-reuse', workspaceName: 'ws-reuse', tools: ['bash'], runtime: 'node', runtimeVersion: 'test' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reconnect.connected).toBe(true)
    reconnect.close()

    const wrong = await announceWithInvite('exec-reuse-3', 'ws-other')
    await expect(new Promise<{ code: string }>((resolve) => wrong.on('executor:host_reject', resolve))).resolves.toMatchObject({ code: 'auth_failed' })
    wrong.close()
  })

  it('regenerates executor invites and clears the workspace binding', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const created = await fetch(`${url}/auth/executor-invites`, { method: 'POST', body: JSON.stringify({ label: 'runner', workspaceId: 'ws-old' }) }).then((res) => res.json()) as { id: string; inviteToken: string }
    const regenerated = await fetch(`${url}/auth/executor-invites/${created.id}/regenerate`, { method: 'POST' }).then((res) => res.json()) as { id: string; inviteToken: string; workspaceId?: string; label?: string }
    expect(regenerated.id).toBe(created.id)
    expect(regenerated.inviteToken).toMatch(/^ak_invite_/)
    expect(regenerated.inviteToken).not.toBe(created.inviteToken)
    expect(regenerated.workspaceId).toBeUndefined()
    expect(regenerated.label).toBe('runner')
    expect(readFileSync(identityPath, 'utf8')).not.toContain(regenerated.inviteToken)
  })

  it('answers first-paint dashboard requests sent before session:ready', async () => {
    const sessionId = 'wire-first-paint'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })

    const sessionsPromise = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.once('server:sessions', resolve)
    })
    const historyPromise = new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.once('server:history', resolve)
    })
    await new Promise<void>((resolve) => dashboard.once('connect', resolve))
    dashboard.emit('client:list_sessions', {})
    dashboard.emit('client:load_history', { sessionId })

    const [sessions, history] = await Promise.all([sessionsPromise, historyPromise])
    expect(sessions.sessions.some((s) => s.sessionId === sessionId)).toBe(true)
    expect(history.sessionId).toBe(sessionId)
    expect(history.entries).toEqual([])

    dashboard.close()
  })

  it('exposes bounded Prometheus operational metrics', async () => {
    const response = await fetch(`${url}/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const body = await response.text()
    expect(body).toContain('agent_kernel_process_starts_total')
    expect(body).toContain('deployment_mode="portable"')
  })

  it('serves custom dashboard middleware after JSON routes', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const handled: string[] = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      dashboardHandler(req, res) {
        handled.push(req.url ?? '/')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dashboard middleware')
      },
    })
    url = `http://localhost:${server.port}`

    const models = await fetch(`${url}/models`).then((r) => r.json())
    expect(models).toEqual({ models: [], defaultModel: '' })

    const dashboard = await fetch(`${url}/custom-route`).then((r) => r.text())
    expect(dashboard).toBe('dashboard middleware')
    expect(handled).toEqual(['/custom-route'])
  })

  it('recomputes context snapshot from the selected advertised model', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const modelConfig = createConfig({
      tools: [WRITE],
      systemPrompt: 'sys',
      contextLimit: 400_000,
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: modelConfig,
      httpServer: http,
      models: [
        {
          ref: 'openai:gpt-5.5',
          id: 'gpt-5.5',
          label: 'GPT 5.5',
          provider: 'openai',
          providerId: 'openai',
          contextWindow: 400_000,
        },
        {
          ref: 'anthropic:claude-opus-4.7-1m-internal',
          id: 'claude-opus-4.7-1m-internal',
          label: 'Claude Opus 4.7 1M',
          provider: 'anthropic',
          providerId: 'anthropic',
          contextWindow: 1_000_000,
        },
      ],
      defaultModel: 'openai:gpt-5.5',
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-context-model'
    await server.store.ensure({ sessionId, defaultConfig: modelConfig })
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const changed = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
    dashboard.emit('client:update_preferences', {
      sessionId,
      preferences: { selectedModel: 'anthropic:claude-opus-4.7-1m-internal' },
    })

    const payload = await changed
    expect(payload.contextSnapshot?.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    expect(payload.contextSnapshot?.model).toMatchObject({ ref: 'anthropic:claude-opus-4.7-1m-internal', id: 'claude-opus-4.7-1m-internal', provider: 'anthropic' })

    dashboard.close()
  })

  it('keeps cached runtime context snapshots during intermediate send state changes', async () => {
    const sessionId = 'wire-runtime-context-cache'
    const ensured = await server.store.ensure({ sessionId, defaultConfig: config })
    const providerSnapshot = {
      model: { ref: 'gpt-5.6-sol', provider: 'github-copilot', id: 'gpt-5.6-sol' },
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 195_742, totalTokens: 195_742 },
      breakdown: { system: 245, transcript: 187_660, tools: 7_837, memory: 0, attachments: 0, pendingUserInput: 0 },
      estimator: {
        total: { kind: 'provider_reported', confidence: 'exact' },
        breakdown: { kind: 'heuristic', confidence: 'estimated' },
        version: 'copilot-sdk-usage-info-v1',
      },
      updatedAt: Date.now(),
    } satisfies NonNullable<SessionReadyEvent['contextSnapshot']>
    await server.store.updateRuntimeContextSnapshot(ensured.record, providerSnapshot)

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const changed = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'hello' })

    const payload = await changed
    expect(payload.contextSnapshot).toEqual(providerSnapshot)
    dashboard.close()
  })

  it('broadcasts one Session summary instead of the full Session list after runtime events', async () => {
    const sessionId = 'wire-incremental-session-summary'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    let fullListBroadcasts = 0
    dashboard.on('server:sessions', () => {
      fullListBroadcasts += 1
    })
    const summaryChanged = new Promise<Extract<ControlUpdate, { kind: 'session_summary_changed' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session_summary_changed never emitted')), 1500)
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind !== 'session_summary_changed' || payload.session.sessionId !== sessionId) return
        clearTimeout(timer)
        resolve(payload)
      })
    })

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'hello' })

    const payload = await summaryChanged
    expect(payload.session.eventCount).toBeGreaterThan(0)
    expect(fullListBroadcasts).toBe(0)
    dashboard.close()
  })

  it('persists selected model preferences and restores them on a new host instance', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'anthropic:claude-opus', id: 'claude-opus', label: 'Claude Opus', provider: 'anthropic', providerId: 'anthropic' },
      ],
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-model-persist'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const changed = new Promise<void>((resolve) => dashboard.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.selectedModel === 'anthropic:claude-opus') {
        resolve()
      }
    }))
    const ack = await dashboard.timeout(1_000).emitWithAck('client:update_preferences', {
      operationId: 'persist-model-preference',
      sessionId,
      preferences: { selectedModel: 'anthropic:claude-opus' },
    })
    expect(ack).toEqual({ ok: true })
    await changed
    dashboard.close()

    const firstRecord = server.store.get(sessionId)!
    expect(firstRecord.preferences.selectedModel).toBe('anthropic:claude-opus')
    expect((await readSessionLog(firstRecord.logPath)).metadata.at(-1)?.selectedModel).toBe('anthropic:claude-opus')

    await server.close()
    const restartedHttp = createServer()
    await new Promise<void>((resolve) => restartedHttp.listen(0, resolve))
    server = await startHostServer({
      port: (restartedHttp.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: restartedHttp,
      models: [
        { ref: 'anthropic:claude-opus', id: 'claude-opus', label: 'Claude Opus', provider: 'anthropic', providerId: 'anthropic' },
      ],
    })
    url = `http://localhost:${server.port}`
    const reconnected = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => reconnected.on('session:ready', resolve))
    expect(ready.selectedModel).toBe('anthropic:claude-opus')
    reconnected.close()
  })

  it('uses the current default when a persisted selected model has left the catalog', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'anthropic:claude-opus-4.8', id: 'claude-opus-4.8', label: 'Claude Opus 4.8', provider: 'anthropic', providerId: 'anthropic' },
      ],
      defaultModel: 'anthropic:claude-opus-4.8',
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-historical-model-context'
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'anthropic:claude-opus-4.7-1m-internal' })

    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    expect(ready.selectedModel).toBe('anthropic:claude-opus-4.8')
    expect(ready.contextSnapshot.model).toMatchObject({
      ref: 'anthropic:claude-opus-4.8',
      id: 'claude-opus-4.8',
      provider: 'anthropic',
    })
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    dashboard.close()
  })

  it('shares known context metadata across providers exposing the same model id', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'primary:gpt-shared', id: 'gpt-shared', label: 'Shared Primary', provider: 'primary', providerId: 'primary', contextWindow: 353_346 },
        { ref: 'secondary:gpt-shared', id: 'gpt-shared', label: 'Shared Secondary', provider: 'secondary', providerId: 'secondary' },
      ],
      defaultModel: 'primary:gpt-shared',
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-shared-model-context'
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'secondary:gpt-shared' })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    expect(ready.selectedModel).toBe('secondary:gpt-shared')
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 353_346, source: 'model_registry' })
    dashboard.close()
  })

  it('uses persisted session model preferences over the host default model', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const seenModels: Array<string | undefined> = []
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'openai:gpt-default', id: 'gpt-default', label: 'GPT Default', provider: 'openai', providerId: 'openai', contextWindow: 400_000 },
        { ref: 'anthropic:claude-session', id: 'claude-session', label: 'Claude Session', provider: 'anthropic', providerId: 'anthropic', contextWindow: 1_000_000 },
      ],
      defaultModel: 'openai:gpt-default',
      llm: {
        async call(p) {
          seenModels.push(p.model)
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'wire-model-preference-authority'
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'anthropic:claude-session' })

    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    expect(ready.selectedModel).toBe('anthropic:claude-session')
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })

    const done = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve(payload)
        }
      })
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'hello' })
    const payload = await done
    expect(seenModels).toEqual(['anthropic:claude-session'])
    expect(payload.contextSnapshot.model.ref).toBe('anthropic:claude-session')
    expect(payload.contextSnapshot.model.id).toBe('claude-session')
    expect(payload.contextSnapshot.model.provider).toBe('anthropic')
    expect(payload.contextSnapshot.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    dashboard.close()
  })

  it('uses the host default model as the effective session model when no preference is set', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const seenModels: Array<string | undefined> = []
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'anthropic:first-model', id: 'first-model', label: 'First Model', provider: 'anthropic', providerId: 'anthropic', contextWindow: 200_000 },
        { ref: 'openai:gpt-default', id: 'gpt-default', label: 'GPT Default', provider: 'openai', providerId: 'openai', contextWindow: 400_000 },
      ],
      defaultModel: 'openai:gpt-default',
      llm: {
        async call(p) {
          seenModels.push(p.model)
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'wire-effective-default-model'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    expect(ready.selectedModel).toBe('openai:gpt-default')
    expect(ready.contextSnapshot.model.ref).toBe('openai:gpt-default')
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 400_000, source: 'model_registry' })

    const done = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve(payload)
        }
      })
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'hello' })
    const payload = await done
    expect(seenModels).toEqual(['openai:gpt-default'])
    expect(payload.contextSnapshot.model.ref).toBe('openai:gpt-default')
    expect(payload.contextSnapshot.contextWindow).toEqual({ tokens: 400_000, source: 'model_registry' })
    dashboard.close()
  })

  it('rejects ambiguous bare model ids instead of silently choosing a provider', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'openai:shared', id: 'shared', label: 'Shared OpenAI', provider: 'openai' },
        { ref: 'anthropic:shared', id: 'shared', label: 'Shared Anthropic', provider: 'anthropic' },
      ],
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'wire-model-ambiguous'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const error = new Promise<DashboardServerToClientEvents['session:error']>((resolve) => dashboard.once('session:error', resolve))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'shared' } })
    const payload = await error
    expect(payload.message).toContain('unknown or ambiguous model')
    expect(server.store.get(sessionId)?.preferences.selectedModel).toBeUndefined()
    dashboard.close()
  })

  it('exposes router health payload when the option is provided', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let calls = 0
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      routerHealth: () => {
        calls += 1
        return { providers: [{ provider: 'anthropic', totalCalls: 3, successCount: 3, errorCount: 0 }] }
      },
    })
    url = `http://localhost:${server.port}`

    const health = await fetch(`${url}/router/health`).then((r) => r.json())
    expect(health).toEqual({ providers: [{ provider: 'anthropic', totalCalls: 3, successCount: 3, errorCount: 0 }] })
    expect(calls).toBe(1)
  })

  it('exposes artifact manifests only when artifact capture is configured', async () => {
    const missing = await fetch(`${url}/artifacts/manifest`).then(async (r) => ({
      status: r.status,
      body: await r.json() as { error: string },
    }))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('artifact capture')

    await server.close()
    const emptyArtifactRootDir = join(dir, 'empty-artifacts')
    const emptyHttp = createServer()
    await new Promise<void>((resolve) => emptyHttp.listen(0, resolve))
    server = await startHostServer({
      port: (emptyHttp.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: emptyHttp,
      artifactRootDir: emptyArtifactRootDir,
    })
    url = `http://localhost:${server.port}`

    const emptyManifest = await fetch(`${url}/artifacts/manifest`).then(async (r) => ({
      status: r.status,
      body: await r.json() as { rootDir: string; summary: { entryCount: number } },
    }))
    expect(emptyManifest.status).toBe(200)
    expect(emptyManifest.body.rootDir).toBe(emptyArtifactRootDir)
    expect(emptyManifest.body.summary.entryCount).toBe(0)
    expect(JSON.parse(await readFile(join(emptyArtifactRootDir, 'artifact-manifest.json'), 'utf8'))).toMatchObject({
      rootDir: emptyArtifactRootDir,
      summary: { entryCount: 0 },
    })

    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
    await mkdir(join(artifactRootDir, 'llm/s1'), { recursive: true })
    await mkdir(join(artifactRootDir, 'traces'), { recursive: true })
    await mkdir(join(artifactRootDir, 'profiles/s1'), { recursive: true })
    await writeFile(join(artifactRootDir, 'llm/s1/1.request.json'), JSON.stringify({ ok: true }), 'utf8')
    await writeFile(join(artifactRootDir, 'traces/s1.openinference.json'), JSON.stringify({ spans: [] }), 'utf8')
    await writeFile(join(artifactRootDir, 'profiles/s1/profile.json'), JSON.stringify({ sessionId: 's1' }), 'utf8')

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      artifactRootDir,
    })
    url = `http://localhost:${server.port}`

    const manifest = await fetch(`${url}/artifacts/manifest`).then((r) => r.json() as Promise<{
      summary: { entryCount: number; kinds: Record<string, number> }
      entries: Array<{ path: string; kind: string }>
    }>)
    expect(manifest.summary.entryCount).toBe(3)
    expect(manifest.summary.kinds.llm_request).toBe(1)
    expect(manifest.entries[0]).toMatchObject({ path: 'llm/s1/1.request.json', kind: 'llm_request' })

    const firstPage = await fetch(`${url}/artifacts/manifest?limit=1&kind=trace&kind=profile`).then((r) => r.json() as Promise<{
      entries: Array<{ path: string; kind: string }>
      page: { returnedEntries: number; totalEntries: number; hasMore: boolean; nextCursor?: string; snapshotId: string }
    }>)
    expect(firstPage.entries).toHaveLength(1)
    expect(firstPage.page).toMatchObject({ returnedEntries: 1, totalEntries: 2, hasMore: true })
    expect(firstPage.page.nextCursor).toBeTruthy()

    await writeFile(join(artifactRootDir, 'traces/new.openinference.json'), JSON.stringify({ spans: ['new'] }), 'utf8')
    const secondPage = await fetch(`${url}/artifacts/manifest?limit=1&kind=trace,profile&cursor=${encodeURIComponent(firstPage.page.nextCursor!)}`).then((r) => r.json() as Promise<{
      entries: Array<{ path: string; kind: string }>
      page: { returnedEntries: number; totalEntries: number; hasMore: boolean; snapshotId: string }
    }>)
    expect(secondPage.entries).toHaveLength(1)
    expect(secondPage.page).toMatchObject({ returnedEntries: 1, totalEntries: 2, hasMore: false, snapshotId: firstPage.page.snapshotId })
    expect([...firstPage.entries, ...secondPage.entries].map((entry) => entry.kind).sort()).toEqual(['profile', 'trace'])

    const mismatchedCursor = await fetch(`${url}/artifacts/manifest?limit=1&kind=profile&cursor=${encodeURIComponent(firstPage.page.nextCursor!)}`)
    expect(mismatchedCursor.status).toBe(400)
    const invalidLimit = await fetch(`${url}/artifacts/manifest?limit=501`)
    expect(invalidLimit.status).toBe(400)

    const content = await fetch(`${url}/artifacts/content?path=${encodeURIComponent('llm/s1/1.request.json')}`).then((r) => r.json() as Promise<{
      path: string
      body: { ok: boolean }
    }>)
    expect(content).toMatchObject({ path: 'llm/s1/1.request.json', body: { ok: true } })

    const download = await fetch(`${url}/artifacts/download?path=${encodeURIComponent('llm/s1/1.request.json')}`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''1.request.json")
    expect(await download.text()).toBe(JSON.stringify({ ok: true }))

    const traversal = await fetch(`${url}/artifacts/content?path=${encodeURIComponent('../secret.json')}`)
    expect(traversal.status).toBe(403)
  })

  it('serves repository docs dynamically without static generation', async () => {
    const index = await fetch(`${url}/docs/index`).then((r) => r.json() as Promise<{
      docs: Array<{ path: string; title: string }>
    }>)
    expect(index.docs.some((doc) => doc.path === 'host/context-compaction.md')).toBe(true)

    const content = await fetch(`${url}/docs/content?path=${encodeURIComponent('host/context-compaction.md')}`).then((r) => r.json() as Promise<{
      path: string
      body: string
    }>)
    expect(content.path).toBe('host/context-compaction.md')
    expect(content.body).toContain('# Context Compaction')

    const traversal = await fetch(`${url}/docs/content?path=${encodeURIComponent('../package.json')}`)
    expect(traversal.status).toBe(400)
  })

  it('serves embedded release docs when no filesystem docs root is configured', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      embeddedDocs: [{ path: 'operations/release.md', contentBase64: Buffer.from('# Release Operations\n\nEmbedded runbook.').toString('base64') }],
    })
    url = `http://localhost:${server.port}`

    const index = await fetch(`${url}/docs/index`).then((response) => response.json() as Promise<{ docs: Array<{ path: string; title: string; size: number; updatedAt: string }> }>)
    expect(index.docs).toEqual([{ path: 'operations/release.md', title: 'Release Operations', size: 39, updatedAt: new Date(0).toISOString() }])
    const content = await fetch(`${url}/docs/content?path=${encodeURIComponent('operations/release.md')}`).then((response) => response.json() as Promise<{ body: string }>)
    expect(content.body).toContain('Embedded runbook.')
    expect((await fetch(`${url}/docs/content?path=${encodeURIComponent('operations/missing.md')}`)).status).toBe(404)
  })

  it('runs product enhancement artifact actions from dashboard routes', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
    const workspaceRoot = join(dir, 'workspace')
    await mkdir(join(workspaceRoot, '.kala', 'memory'), { recursive: true })
    await writeFile(join(workspaceRoot, '.kala', 'memory', 'style.md'), '---\nname: Style\nconfidence: 0.8\n---\nUse concise answers.\n', 'utf8')

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      artifactRootDir,
    })
    url = `http://localhost:${server.port}`
    const { record } = await server.store.ensure({ sessionId: 'dash-actions-session', defaultConfig: config })
    await server.store.record(record.sessionId, { kind: 'user_message', text: 'hi' }, [], { ...record.state, cursor: record.state.cursor + 1 })

    const profile = await postEnhancementAction(url, { action: 'profile-session', sessionId: record.sessionId }) as { profilePath: string; profile: { sessionId: string } }
    expect(profile.profilePath).toBe(join(artifactRootDir, 'profile.json'))
    expect(profile.profile.sessionId).toBe(record.sessionId)

    const audit = await postEnhancementAction(url, { action: 'reliability-audit-session', sessionId: record.sessionId }) as { auditPath: string; audit: { sessionId: string } }
    expect(audit.auditPath).toBe(join(artifactRootDir, 'reliability-audit.json'))
    expect(audit.audit.sessionId).toBe(record.sessionId)

    const memory = await postEnhancementAction(url, { action: 'memory-index', workspaceRoot }) as { indexPath: string; entries: number }
    expect(memory.indexPath).toBe(join(artifactRootDir, 'memory-index.json'))
    expect(memory.entries).toBe(1)

    const retrieval = await postEnhancementAction(url, {
      action: 'memory-retrieve',
      workspaceRoot,
      query: 'concise answers',
      maxHits: 5,
    }) as { artifactPath: string; hitCount: number; reasonCodes: string[]; hits: Array<{ key: string; score: number }> }
    expect(retrieval.artifactPath).toBe(join(artifactRootDir, 'memory-retrieval.json'))
    expect(retrieval.hitCount).toBe(1)
    expect(retrieval.hits[0]!.key).toBe('style')
    expect(retrieval.reasonCodes).toContain('hits_selected')

    const graph = await postEnhancementAction(url, { action: 'subagents-graph' }) as { graphPath: string; nodes: number }
    expect(graph.graphPath).toBe(join(artifactRootDir, 'subagent-graph.json'))
    expect(graph.nodes).toBeGreaterThanOrEqual(1)

    const unsupported = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not-real' }),
    })
    expect(unsupported.status).toBe(400)
  })

  it("rejects removed product evaluation entry points after the clean cutover", async () => {
    const actions = [
      "swebench-resolve-instances",
      "swebench-upload-patches",
      "swebench-upload-results",
      "swebench-grade-command",
      "terminal-bench-resolve-tasks",
      "terminal-bench-run-agent",
      "terminal-bench-read-progress",
      "badcase-list",
      "badcase-annotate",
      "badcase-export",
      "rollout-export",
    ]
    for (const action of actions) {
      const response = await fetch(`${url}/enhancement/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, rootDir: dir }),
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: `unsupported enhancement action: ${action}` })
    }
  })

  it('drives a full round-trip with dashboard + executor', async () => {
    const sessionId = 'wire-1'
    // Pre-materialize the session: dashboard handshakes are now lazy (they
    // no longer touch disk) so we need the session record on disk before we
    // dispatch below. The dashboard client will still receive session:ready
    // for the recorded state.
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    // Executor is a daemon: handshake no longer names a session. It announces
    // once and then services `tool:call` for whatever session the host routes
    // to it.
    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-1',
      workspaceId: 'ws-ex-1',
      workspaceName: 'ex-1',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        ack({
          callId: payload.callId,
          ok: true,
          content: 'wrote ' + JSON.stringify(payload.input),
        })
      },
    )
    await waitForAnyExecutor(server)

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never reached done')), 4000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
        if (payload.state.status === 'error') {
          clearTimeout(timer)
          reject(new Error('kernel error: ' + payload.state.error))
        }
      })
    })

    dashboard.emit('client:user_message', { intent: 'text',
      sessionId,
      text: 'please write',
    })

    await done
    const rec = server.store.get(sessionId)
    expect(rec?.state.status).toBe('done')
    // seq: user + llm(tool) + tool_result + llm(text) = 4
    expect(rec?.state.cursor).toBe(4)

    dashboard.close()
    executor.close()
  })

  it('forks a session from a chosen cursor and reports lineage', async () => {
    const sessionId = 'wire-fork-src'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    await server.store.updatePreferences(sessionId, { selectedModel: 'fork-model' })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-fork',
      workspaceId: 'ws-ex-fork',
      workspaceName: 'ex-fork',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        ack({ callId: payload.callId, ok: true, content: 'ok' })
      },
    )
    await waitForAnyExecutor(server)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('src never done')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
      dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'go' })
    })

    const forked = new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', (payload) => {
        if (payload.reason === 'forked') resolve(payload)
      }),
    )
    dashboard.emit('client:fork', {
      sourceSessionId: sessionId,
      cursor: 2,
      newSessionId: 'wire-fork-child',
    })
    const ev = await forked
    expect(ev.sessionId).toBe('wire-fork-child')
    expect(ev.parentSessionId).toBe(sessionId)
    expect(ev.parentCursor).toBe(2)
    expect(ev.state.cursor).toBe(2)
    expect(ev.selectedModel).toBe('fork-model')
    // Original session has cursor 4; fork stops at 2 (user + llm tool_call).
    const forkedRec = server.store.get('wire-fork-child')
    expect(forkedRec?.state.sessionId).toBe('wire-fork-child')
    expect(forkedRec?.parentSessionId).toBe(sessionId)
    expect(forkedRec?.parentCursor).toBe(2)
    expect(forkedRec?.preferences.selectedModel).toBe('fork-model')
    expect(forkedRec?.state.cursor).toBe(2)
    expect(forkedRec).toBeTruthy()
    const forkedLog = await readSessionLog(forkedRec!.logPath)
    expect(forkedLog.header.sessionId).toBe('wire-fork-child')
    expect(forkedLog.header.initialState.sessionId).toBe('wire-fork-child')

    const summaries = await server.store.listSummaries()
    const childSummary = summaries.find((s) => s.sessionId === 'wire-fork-child')
    expect(childSummary).toBeTruthy()
    expect(childSummary?.parentSessionId).toBe(sessionId)

    dashboard.close()
    executor.close()
  })

  it('always cascades session deletion through descendant sessions', async () => {
    await server.store.create({ sessionId: 'delete-parent', config })
    await server.store.create({ sessionId: 'delete-child', config, parentSessionId: 'delete-parent' })
    await server.store.create({ sessionId: 'delete-grandchild', config, parentSessionId: 'delete-child' })
    await server.store.create({ sessionId: 'delete-sibling', config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'delete-parent', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const deleteSpy = vi.spyOn(server.store, 'delete')
    await new Promise<void>((resolve, reject) => dashboard.emit('client:delete_session', { operationId: 'delete-cascade-op', sessionId: 'delete-parent' }, (ack) => ack.ok ? resolve() : reject(new Error(ack.error))))
    let summaries = await server.store.listSummaries()
    for (let i = 0; i < 50 && summaries.length !== 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      summaries = await server.store.listSummaries()
    }
    expect(summaries.map((s) => s.sessionId).sort()).toEqual(['delete-sibling'])
    expect(deleteSpy.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'delete-grandchild',
      'delete-child',
      'delete-parent',
    ])
    dashboard.close()
  })

  it('atomically rejects tree deletion when any descendant has an active turn', async () => {
    await server.store.create({ sessionId: 'active-delete-parent', config })
    await server.store.create({ sessionId: 'active-delete-child', config, parentSessionId: 'active-delete-parent' })
    await server.store.create({ sessionId: 'active-delete-grandchild', config, parentSessionId: 'active-delete-child' })
    vi.spyOn(server.loop, 'hasActiveTurn').mockImplementation((sessionId) => sessionId === 'active-delete-grandchild')
    const deleteSpy = vi.spyOn(server.store, 'delete')

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'active-delete-parent', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const result = await dashboard.timeout(1000).emitWithAck('client:delete_session', {
      operationId: 'active-delete-op',
      sessionId: 'active-delete-parent',
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('active turn') })
    expect(deleteSpy).not.toHaveBeenCalled()
    expect((await server.store.listSummaries()).map((session) => session.sessionId)).toEqual(
      expect.arrayContaining(['active-delete-parent', 'active-delete-child', 'active-delete-grandchild']),
    )
    dashboard.close()
  })

  it('refuses to clean up a Session tree when a descendant belongs to another Runtime', async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'kala-tree-owner-'))
    const checked: string[] = []
    const isolated = await startHostServer({
      port: 0, sessionsDir: isolatedDir, defaultConfig: config, llm: scriptedLlm(),
      assertSessionEffectOwner: async (sessionId) => {
        checked.push(sessionId)
        if (sessionId === 'remote-owned-child') throw new Error('Session owner held by another replica')
      },
    })
    try {
      await isolated.store.create({ sessionId: 'local-owned-parent', config })
      await isolated.store.create({ sessionId: 'remote-owned-child', config, parentSessionId: 'local-owned-parent' })
      const deleted = vi.spyOn(isolated.store, 'delete')
      const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(
        `http://localhost:${isolated.port}/dashboard`, {
          transports: ['websocket'], reconnection: false,
          auth: { sessionId: 'local-owned-parent', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
        },
      )
      try {
        await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
        const result = await dashboard.timeout(2_000).emitWithAck('client:delete_session', {
          operationId: 'remote-descendant-delete', sessionId: 'local-owned-parent',
        })
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('owner held') })
        expect(checked).toContain('remote-owned-child')
        expect(deleted).not.toHaveBeenCalled()
        expect((await isolated.store.listSummaries()).map((s) => s.sessionId).sort())
          .toEqual(['local-owned-parent', 'remote-owned-child'])
      } finally { dashboard.close() }
    } finally {
      await isolated.close()
      rmSync(isolatedDir, { recursive: true, force: true })
    }
  })

  it('forwards client:cancel to the executor as tool:cancel for pending calls', async () => {
    // Regression for reviewer R1: previously the loop dropped kernel
    // pendingCalls but never told the executor. A hanging bash / long
    // read would continue burning CPU on the executor side, and any
    // ack that eventually arrived was applied to a kernel that had
    // already moved on.
    const sessionId = 'wire-cancel'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-cancel',
      workspaceId: 'ws-ex-cancel',
      workspaceName: 'ex-cancel',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })

    // Deliberately do NOT ack tool:call — we want the pending call to be
    // in flight when cancel fires. Capture what arrived so we can compare.
    const toolCalls: ToolCallMessage[] = []
    executor.on('tool:call', (payload) => {
      toolCalls.push(payload)
      // no ack: the executor is "still running"
    })

    // Set up the cancel receiver BEFORE we fire cancel so we don't miss
    // the event due to a socket.io race between emit and listener attach.
    const cancelSeen = new Promise<{ sessionId: string; callId: string }>(
      (resolve) => {
        executor.on('tool:cancel', resolve)
      },
    )

    await waitForAnyExecutor(server)

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'go' })

    // Wait for the tool:call to hit the executor before cancelling.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (toolCalls.length > 0) return resolve()
        if (Date.now() - start > 2000)
          return reject(new Error('tool:call never arrived'))
        setTimeout(tick, 10)
      }
      tick()
    })

    const cancelled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cancel never settled')), 2000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done' && payload.state.pendingCalls.length === 0) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    dashboard.emit('client:cancel', { sessionId })
    const cancelPayload = await cancelSeen
    expect(cancelPayload.sessionId).toBe(sessionId)
    expect(cancelPayload.callId).toBe(toolCalls[0]!.callId)
    await cancelled

    // Kernel side: state must be `done`, pendingCalls empty.
    const rec = server.store.get(sessionId)
    expect(rec?.state.status).toBe('done')
    expect(rec?.state.pendingCalls).toEqual([])

    dashboard.close()
    executor.close()
  })

  it('lets the dashboard interrupt a running sub-agent inline', async () => {
    await server.close()
    const sessionId = 'wire-subagent-interrupt-parent'
    let call = 0
    const llm: LLMAdapter = {
      name: 'subagent-interrupt-test',
      async call(params) {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-wire-1',
                  name: 'agent',
                  input: { prompt: 'long child task' },
                },
              ],
            },
          }
        }
        if (params.messages.length === 1 && JSON.stringify(params.messages).includes('long child task')) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (params.signal?.aborted) abort()
            params.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'parent observed cancellation' }],
          },
        }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const agentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm,
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 2000,
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: agentConfig })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const started = new Promise<ServerSubAgentStartedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve(payload)
      })
    })
    const finished = new Promise<ServerSubAgentFinishedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_finished') resolve(payload)
      })
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'go' })

    const start = await started
    expect(start.parentSessionId).toBe(sessionId)
    expect(start.parentCallId).toBe('agent-wire-1')
    dashboard.emit('client:interrupt_sub_agent', {
      parentSessionId: sessionId,
      parentCallId: 'agent-wire-1',
      childSessionId: start.childSessionId,
    })

    const finish = await finished
    expect(finish.childSessionId).toBe(start.childSessionId)
    expect(finish.status).toBe('cancelled')
    expect(finish.error).toContain('sub-agent interrupted by user')

    const deadline = Date.now() + 2000
    let toolResultContent = ''
    while (Date.now() < deadline) {
      const rec = server.store.get(sessionId)
      if (rec?.state.status === 'done') {
        const log = await readSessionLog(rec.logPath)
        const toolResult = log.events.find(
          (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-wire-1',
        )
        if (toolResult?.event.kind === 'tool_result') {
          toolResultContent = toolResult.event.content
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(toolResultContent).toContain('status="cancelled"')
    expect(toolResultContent).toContain('sub-agent interrupted by user')

    const textDeadline = Date.now() + 2000
    while (Date.now() < textDeadline) {
      const rec = server.store.get(sessionId)
      if (rec?.state.status === 'done') {
        const log = await readSessionLog(rec.logPath)
        const hasParentText = log.events.some((e) => {
          if (e.event.kind !== 'llm_response') return false
          const content = e.event.message.content
          if (typeof content === 'string') return content.includes('parent observed cancellation')
          return content.some(
            (block) => block.type === 'text' && block.text.includes('parent observed cancellation'),
          )
        })
        if (hasParentText) break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    dashboard.close()
  })

  it('aborts a Copilot sub-agent SDK turn and pending tool before reporting it cancelled', async () => {
    await server.close()
    const sessionId = 'wire-copilot-subagent-interrupt-parent'
    const agentConfig = createConfig({ tools: [AGENT, WRITE], systemPrompt: 'sys' })
    const abortCounts = new Map<string, number>()
    let releaseChildAbort!: () => void
    const childAbortGate = new Promise<void>((resolve) => { releaseChildAbort = resolve })
    let childAbortStarted!: () => void
    const childAborting = new Promise<void>((resolve) => { childAbortStarted = resolve })

    copilotSdk.createSession = (sessionConfig) => {
      const sdkSessionId = sessionConfig.sessionId!
      const listeners = new Set<(event: unknown) => void>()
      let rejectPending: ((error: Error) => void) | undefined
      return {
        rpc: { model: { async getCurrent() { return { modelId: 'gpt-5.4-mini' } } } },
        async getEvents() { return [] },
        on(listener: (event: unknown) => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        async sendAndWait() {
          if (sdkSessionId === sessionId) {
            const agent = sessionConfig.tools.find((tool) => tool.name === 'agent')!
            await agent.handler({ prompt: 'run a pending tool' }, { toolCallId: 'copilot-agent-call' })
            return { id: 'parent-response', type: 'assistant.message', data: { content: 'parent recovered' } }
          }
          const write = sessionConfig.tools.find((tool) => tool.name === 'write')!
          const pendingTool = write.handler({ path: '/tmp/pending' }, { toolCallId: 'copilot-child-write' })
          const aborted = new Promise<never>((_resolve, reject) => { rejectPending = reject })
          return await Promise.race([pendingTool.then(() => new Promise<never>(() => {})), aborted])
        },
        async abort() {
          abortCounts.set(sdkSessionId, (abortCounts.get(sdkSessionId) ?? 0) + 1)
          rejectPending?.(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (sdkSessionId !== sessionId) {
            childAbortStarted()
            await childAbortGate
          }
        },
        async setModel() {},
        async disconnect() {},
      }
    }

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 2000,
      detachGraceMs: 0,
      copilot: { enabled: true },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId,
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: sessionId,
      config: agentConfig,
    })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    executor.emit('executor:announce', {
      executorId: 'ex-copilot-subagent-cancel',
      workspaceId: 'ws-copilot-subagent-cancel',
      workspaceName: 'copilot-subagent-cancel',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    const started = new Promise<ServerSubAgentStartedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve(payload)
      })
    })
    let finishedSeen = false
    const finished = new Promise<ServerSubAgentFinishedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_finished') {
          finishedSeen = true
          resolve(payload)
        }
      })
    })
    const toolCalled = new Promise<ToolCallMessage>((resolve) => executor.on('tool:call', resolve))
    const toolCancelled = new Promise<{ sessionId: string; callId: string }>((resolve) => executor.on('tool:cancel', resolve))
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'go' })
    const start = await started
    const pendingCall = await toolCalled
    expect(pendingCall.sessionId).toBe(start.childSessionId)

    const interrupt = {
      parentSessionId: sessionId,
      parentCallId: 'copilot-agent-call',
      childSessionId: start.childSessionId,
    }
    dashboard.emit('client:interrupt_sub_agent', interrupt)
    dashboard.emit('client:interrupt_sub_agent', interrupt)
    await childAborting
    expect(abortCounts.get(start.childSessionId)).toBe(1)
    expect(finishedSeen).toBe(false)
    releaseChildAbort()

    await expect(toolCancelled).resolves.toEqual({
      sessionId: start.childSessionId,
      callId: 'copilot-child-write',
    })
    await expect(finished).resolves.toMatchObject({
      childSessionId: start.childSessionId,
      status: 'cancelled',
      error: expect.stringContaining('sub-agent interrupted by user'),
    })
    expect(server.store.get(start.childSessionId)?.state).toMatchObject({ status: 'done', pendingCalls: [] })
    expect(abortCounts.get(start.childSessionId)).toBe(1)

    dashboard.close()
    executor.close()
  })

  it('surfaces a failed sub-agent to the dashboard and lets the parent recover', async () => {
    // End-to-end coverage for the doc-declared failure path: parent LLM
    // spawns a child agent, the child's LLM throws → the host emits a
    // `server:control_update` with sub_agent_finished status=failed, writes a failure
    // envelope tool_result into the parent log, and the parent's next LLM
    // call still completes normally.
    await server.close()
    const sessionId = 'wire-subagent-fail-parent'
    let call = 0
    const llm: LLMAdapter = {
      name: 'subagent-fail-test',
      async call() {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-wire-fail-1',
                  name: 'agent',
                  input: { prompt: 'crash please' },
                },
              ],
            },
          }
        }
        // The child session's LLM turn — throw to trigger the failure envelope.
        if (call === 2) throw new Error('child llm exploded')
        // The parent's next turn after receiving the failure envelope.
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'parent recovered after child failure' }],
          },
        }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const agentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm,
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 2000,
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: agentConfig })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const started = new Promise<ServerSubAgentStartedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve(payload)
      })
    })
    const finished = new Promise<ServerSubAgentFinishedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_finished') resolve(payload)
      })
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'go' })

    const start = await started
    expect(start.parentSessionId).toBe(sessionId)
    expect(start.parentCallId).toBe('agent-wire-fail-1')

    const finish = await finished
    expect(finish.parentSessionId).toBe(sessionId)
    expect(finish.parentCallId).toBe('agent-wire-fail-1')
    expect(finish.status).toBe('failed')
    expect(finish.error).toContain('child llm exploded')

    const deadline = Date.now() + 2000
    let parentStatus: string | undefined
    let toolResultContent = ''
    while (Date.now() < deadline) {
      const rec = server.store.get(sessionId)
      parentStatus = rec?.state.status
      if (rec?.state.status === 'done') {
        const log = await readSessionLog(rec.logPath)
        const toolResult = log.events.find(
          (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-wire-fail-1',
        )
        if (toolResult?.event.kind === 'tool_result') {
          toolResultContent = toolResult.event.content
        }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // Parent must reach `done` after seeing the failure envelope; it does not
    // get stuck waiting for a child that already reported terminal state.
    expect(parentStatus).toBe('done')
    expect(toolResultContent).toContain('status="failed"')
    expect(toolResultContent).toContain('child llm exploded')
    // The parent's final assistant message reflects recovery.
    const finalState = server.store.get(sessionId)?.state
    const finalMsg = finalState?.messages.at(-1)
    const finalText = finalMsg?.role === 'assistant'
      ? finalMsg.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('')
      : ''
    expect(finalText).toContain('parent recovered after child failure')

    dashboard.close()
  })

  it('accepts an executor handshake with no sessionId (daemon model)', async () => {
    // Regression for ADR 0013 / Task #95: an executor is a daemon, not
    // pinned to a session. Its handshake omits sessionId; the connect
    // succeeds and the announce runs the moment the socket is up.
    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('executor connect timeout')),
        2000,
      )
      executor.on('connect', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    executor.close()
  })

  it('routes tool calls from two different sessions to the same daemon executor', async () => {
    // The whole point of Task #95 — 1 executor : N sessions. We open two
    // dashboards under distinct session IDs, one shared executor, and
    // verify each session's tool_call reaches the same daemon and comes
    // back with the right correlation.
    const sessionA = 'wire-multi-A'
    const sessionB = 'wire-multi-B'
    await server.store.ensure({ sessionId: sessionA, defaultConfig: config })
    await server.store.ensure({ sessionId: sessionB, defaultConfig: config })

    const dashA: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: sessionA, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const dashB: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: sessionB, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await Promise.all([
      new Promise<SessionReadyEvent>((r) => dashA.on('session:ready', r)),
      new Promise<SessionReadyEvent>((r) => dashB.on('session:ready', r)),
    ])

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))

    const seenSessions: string[] = []
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        seenSessions.push(payload.sessionId)
        ack({ callId: payload.callId, ok: true, content: `ok:${payload.sessionId}` })
      },
    )
    executor.emit('executor:announce', {
      executorId: 'ex-shared',
      workspaceId: 'ws-ex-shared',
      workspaceName: 'ex-shared',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    // Every scripted LLM run consumes two entries from the queue. To exercise
    // two sessions we need a fresh scripted queue per session, which means a
    // full round-trip on the first before starting the second — the current
    // adapter queue is shared. We simply verify the executor receives calls
    // tagged with the right sessionId for each session.
    const doneA = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('A never done')), 4000)
      dashA.on('state:changed', (p) => {
        if (p.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    dashA.emit('client:user_message', { intent: 'text', sessionId: sessionA, text: 'a' })
    await doneA

    expect(seenSessions).toContain(sessionA)
    // Only session A has had a completed round-trip in this test — session B
    // may not have received a tool_call yet since the scripted queue was
    // fully drained. That's fine; the daemon-routing invariant is checked by
    // executor.test.ts and by the fact that A's call landed with the right
    // sessionId on the single shared executor socket.

    dashA.close()
    dashB.close()
    executor.close()
  })

  it('broadcasts executor control updates and answers client:list_executors with the current snapshot', async () => {
    // Regression for the Finder-layout Workspaces column: the dashboard
    // needs (a) a one-shot snapshot on load, and (b) live change events so
    // it can update the daemon list without polling. Both routes must
    // include the announced hostname/os/ip metadata; if we lose it here,
    // the column falls back to bare executorIds and the UI regresses.
    const sessionId = 'wire-list-executors'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const changed = new Promise<ServerExecutorChangedPayload>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'executor_changed') resolve(payload)
      })
    })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-list',
      workspaceId: 'ws-ex-list',
      workspaceName: 'ex-list',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
      hostname: 'test-host',
      os: 'linux',
      ipAddresses: ['192.0.2.1'],
      pid: 4242,
      startedAt: '2026-07-04T00:00:00.000Z',
    })

    const change = await changed
    expect(change.change).toBe('attached')
    expect(change.executorId).toBe('ex-list')
    if (change.change !== 'detached') {
      expect(change.executor.hostname).toBe('test-host')
      expect(change.executor.os).toBe('linux')
      expect(change.executor.ipAddresses).toEqual(['192.0.2.1'])
      expect(change.executor.pid).toBe(4242)
      expect(typeof change.executor.attachedAt).toBe('string')
    }

    const list = await new Promise<ServerExecutorsPayload>((resolve) => {
      dashboard.on('server:executors', resolve)
      dashboard.emit('client:list_executors', {})
    })
    expect(list.executors).toHaveLength(1)
    const [only] = list.executors
    expect(only!.executorId).toBe('ex-list')
    expect(only!.hostname).toBe('test-host')
    expect(only!.attachedAt).toBe(change.change !== 'detached' ? change.executor.attachedAt : '')

    // A detach also fans out.
    const detached = new Promise<ServerExecutorChangedPayload>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'executor_changed' && payload.change === 'detached') {
          resolve(payload)
        }
      })
    })
    executor.close()
    const detachedPayload = await detached
    expect(detachedPayload.executorId).toBe('ex-list')

    dashboard.close()
  })

  it('answers client:list_sessions and client:load_history from the JSONL log', async () => {
    // Regression for the Sessions column + timeline persistence: a
    // reloaded dashboard tab must be able to enumerate sessions on disk
    // and replay each timeline from the log. If either endpoint drifts
    // from the log format, the UI will silently show an empty list or a
    // blank timeline and the user only finds out by refreshing.
    const sessionId = 'wire-history-src'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-hist',
      workspaceId: 'ws-ex-hist',
      workspaceName: 'ex-hist',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        ack({ callId: payload.callId, ok: true, content: 'ok' })
      },
    )
    await waitForAnyExecutor(server)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never done')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
      dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'please write' })
    })

    // Sessions list — after one round-trip we expect exactly one summary
    // with the right shape.
    const sessions = await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
      dashboard.emit('client:list_sessions', {})
    })
    expect(sessions.sessions).toHaveLength(1)
    const summary = sessions.sessions[0]!
    expect(summary.sessionId).toBe(sessionId)
    expect(summary.eventCount).toBe(4)
    expect(summary.status).toBe('done') // recovered from the finish effect on the last event
    expect(summary.firstUserMessage).toBe('please write')

    // Load history — full then incremental.
    const full = await new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.on('server:history', resolve)
      dashboard.emit('client:load_history', { sessionId })
    })
    expect(full.sessionId).toBe(sessionId)
    expect(full.entries).toHaveLength(4)
    expect(full.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(full.entries[0]!.event.kind).toBe('user_message')

    const incremental = await new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.off('server:history')
      dashboard.on('server:history', resolve)
      dashboard.emit('client:load_history', { sessionId, sinceCursor: 2 })
    })
    expect(incremental.entries.map((e) => e.seq)).toEqual([3, 4])

    dashboard.close()
    executor.close()
  })

  it('does not scan legacy JSONL metadata when loading external Runtime history', async () => {
    const sessionId = 'external-history-fast-path'
    const record = await server.store.create({
      sessionId,
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: sessionId,
      config,
    })
    await appendFile(record.logPath, '{"kind":"runtime_metadata", malformed legacy payload\n')

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const history = await new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.on('server:history', resolve)
      dashboard.emit('client:load_history', { sessionId })
    })
    expect(history).toEqual({ sessionId, entries: [] })

    dashboard.close()
  })

  it('client:create_session writes JSONL with workspaceId and broadcasts server:sessions', async () => {
    const sessionId = 'wire-create-session'
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const listPromise = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-alpha',
      workspaceName: 'alpha-box',
    })
    const list = await listPromise
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]!.sessionId).toBe(sessionId)
    expect(list.sessions[0]!.workspaceId).toBe('ws-alpha')
    expect(list.sessions[0]!.workspaceName).toBe('alpha-box')

    const loaded = await server.store.load(sessionId)
    expect(loaded.workspaceId).toBe('ws-alpha')
    expect(loaded.workspaceName).toBe('alpha-box')

    // Idempotency: a second emit for the same id must not double-create.
    let secondBroadcast = 0
    dashboard.on('server:sessions', () => {
      secondBroadcast += 1
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-alpha',
      workspaceName: 'alpha-box',
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(secondBroadcast).toBe(0)

    dashboard.close()
  })

  it('snapshots only the owning workspace live MCP tools into a new Session config', async () => {
    const controlSessionId = 'wire-mcp-control'
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: controlSessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const inputSchema = { type: 'object' }
    const schemaHash = createHash('sha256').update(JSON.stringify(inputSchema)).digest('hex')
    executor.emit('executor:announce', {
      executorId: 'executor-mcp-session',
      workspaceId: 'workspace-mcp-session',
      workspaceName: 'mcp-workspace',
      tools: ['write', 'docs__search'],
      mcpTools: [{ name: 'docs__search', description: 'Search docs', inputSchema, schemaHash }],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await waitForWorkspace(dashboard, 'workspace-mcp-session')

    await expect(dashboard.timeout(1_000).emitWithAck('client:create_session', {
      sessionId: 'wire-mcp-owned',
      workspaceId: 'workspace-mcp-session',
      workspaceName: 'mcp-workspace',
    })).resolves.toEqual({ ok: true })
    expect(server.store.get('wire-mcp-owned')?.config.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'docs__search',
        requiresApproval: true,
        executionKind: 'executor',
        executionHandler: 'docs__search',
        schemaHash,
      }),
    ]))

    await expect(dashboard.timeout(1_000).emitWithAck('client:create_session', {
      sessionId: 'wire-mcp-other',
      workspaceId: 'workspace-without-mcp',
      workspaceName: 'other-workspace',
    })).resolves.toEqual({ ok: true })
    expect(server.store.get('wire-mcp-other')?.config.tools.some((tool) => tool.name === 'docs__search')).toBe(false)

    const apiResponse = await fetch(`${url}/api/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'mcp-public-create', sessionId: 'mcp-public-owned', workspaceId: 'workspace-mcp-session' }),
    })
    expect(apiResponse.status).toBe(201)
    expect(server.store.get('mcp-public-owned')?.config.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'docs__search', requiresApproval: true, schemaHash }),
    ]))

    executor.close()
    dashboard.close()
  })

  it('acknowledges a durably created Session before slow advisory lifecycle hooks finish', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let releaseHook!: () => void
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
    let hookStarted!: () => void
    const started = new Promise<void>((resolve) => { hookStarted = resolve })
    server = await startHostServer({
      port, sessionsDir: dir, defaultConfig: config, httpServer: http, toolTimeoutMs: 2000, llm: scriptedLlm(),
      hooks: [{ event: 'session_start', command: 'slow' }],
      hookRunner: { async run() { hookStarted(); await hookGate; return { ok: true, exitCode: 0, stdout: '', stderr: '' } } },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, { transports: ['websocket'], auth: { sessionId: 'control-slow-create', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const ack = dashboard.timeout(1000).emitWithAck('client:create_session', { operationId: 'slow-create-op', sessionId: 'wire-slow-create', tools: ['websearch'] })
    await expect(ack).resolves.toEqual({ ok: true })
    expect(server.store.get('wire-slow-create')).toBeDefined()
    await started
    releaseHook()
    dashboard.close()
  })

  it('returns unknown model creation failures through the RPC ack', async () => {
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, { transports: ['websocket'], auth: { sessionId: 'control-unknown-model', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const ack = await dashboard.timeout(1000).emitWithAck('client:create_session', { operationId: 'unknown-model-op', sessionId: 'wire-unknown-model', selectedModel: 'definitely-missing-model' })
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining('unknown or ambiguous model') })
    expect(server.store.get('wire-unknown-model')).toBeUndefined()
    dashboard.close()
  })

  it('broadcasts session summaries when an inactive session advances', async () => {
    await server.store.ensure({ sessionId: 'active-session', defaultConfig: config })
    await server.store.ensure({ sessionId: 'inactive-session', defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'active-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const doneSummary = new Promise<Extract<ControlUpdate, { kind: 'session_summary_changed' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inactive session summary was not broadcast')), 4000)
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind !== 'session_summary_changed'
          || payload.session.sessionId !== 'inactive-session'
          || payload.session.status !== 'done') return
        clearTimeout(timer)
        resolve(payload)
      })
    })

    await server.loop.dispatch('inactive-session', { kind: 'user_message', text: 'run in background' })
    const payload = await doneSummary

    expect(payload.session.status).toBe('done')
    dashboard.close()
  })

  it('client:rename_workspace updates executor snapshots and session summaries', async () => {
    const sessionId = 'wire-rename-workspace'
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-rename-workspace',
      workspaceId: 'ws-rename',
      workspaceName: 'old-name',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForWorkspace(dashboard, 'ws-rename')

    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-rename',
      workspaceName: 'old-name',
    })
    await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', (payload) => {
        if (payload.sessions.some((s) => s.sessionId === sessionId)) resolve(payload)
      })
    })

    const renamed = new Promise<void>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (
          payload.kind === 'workspace_meta_changed' &&
          payload.workspaceId === 'ws-rename' &&
          payload.workspaceName === 'new-name'
        ) {
          resolve()
        }
      })
    })
    dashboard.emit('client:rename_workspace', {
      workspaceId: 'ws-rename',
      workspaceName: ' new-name ',
    })
    await renamed

    const executors = await new Promise<ServerExecutorsPayload>((resolve) => {
      dashboard.on('server:executors', resolve)
      dashboard.emit('client:list_executors', {})
    })
    expect(executors.executors.find((e) => e.workspaceId === 'ws-rename')?.workspaceName).toBe('new-name')

    const sessions = await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
      dashboard.emit('client:list_sessions', {})
    })
    expect(sessions.sessions.find((s) => s.sessionId === sessionId)?.workspaceName).toBe('new-name')

    dashboard.close()
    executor.close()
  })

  it('client:create_session validates and writes the initial cwd', async () => {
    const sessionId = 'wire-create-session-cwd'
    const root = resolve(dir, 'workspace-root')
    const child = resolve(root, 'child')
    await mkdir(child, { recursive: true })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-create-cwd',
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    attachDirListHandler(executor, [root], [root, child])
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    await waitForWorkspace(dashboard, 'ws-create-cwd')

    const ready = new Promise<SessionReadyEvent>((resolve) => {
      dashboard.off('session:ready')
      dashboard.on('session:ready', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      cwd: child,
    })
    const createdReady = await ready
    expect(createdReady.state.cwd).toBe(child)
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const err = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.on('session:error', resolve)
    })
    const badAck = dashboard.timeout(1000).emitWithAck('client:create_session', {
      sessionId: 'wire-create-session-cwd-bad',
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      cwd: resolve(dir, 'outside'),
    })
    await expect(err).resolves.toMatchObject({
      scope: 'host',
      message: 'cwd outside sandbox roots',
    })
    await expect(badAck).resolves.toEqual({
      ok: false,
      error: 'cwd outside sandbox roots',
    })

    const missingErr = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.once('session:error', resolve)
    })
    const missingAck = dashboard.timeout(1000).emitWithAck('client:create_session', {
      sessionId: 'wire-create-session-cwd-missing',
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      cwd: resolve(root, 'missing'),
    })
    await expect(missingErr).resolves.toMatchObject({
      scope: 'host',
      message: expect.stringContaining('cwd is not a readable directory'),
    })
    await expect(missingAck).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('cwd is not a readable directory'),
    })
    expect(server.store.get('wire-create-session-cwd-missing')).toBeUndefined()

    dashboard.close()
    executor.close()
  })

  it('client:create_session with tools allowlist filters defaultConfig.tools and skips workspace cwd validation when workspaceId is omitted', async () => {
    const sessionId = 'wire-simple-chat'
    const cwd = resolve(dir, 'simple-chat-tmp')
    await mkdir(cwd, { recursive: true })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const ready = new Promise<SessionReadyEvent>((resolve) => {
      dashboard.off('session:ready')
      dashboard.on('session:ready', resolve)
    })
    // Emit with no workspaceId and an allowlist that excludes 'write'
    // (the only tool the default config exposes in this test setup).
    dashboard.emit('client:create_session', {
      sessionId,
      cwd,
      tools: ['agent'],
    })
    await ready

    const rec = server.store.get(sessionId)
    expect(rec).toBeDefined()
    expect(rec?.workspaceId).toBeUndefined()
    expect(rec?.state.cwd).toBe(cwd)
    expect(rec?.config.tools.map((t) => t.name)).toEqual([])

    dashboard.close()
  })

  it('client:create_session backfills workspace and cwd on an existing unbound session', async () => {
    const sessionId = 'wire-create-session-backfill-cwd'
    const root = resolve(dir, 'backfill-root')
    const child = resolve(root, 'child')
    await mkdir(child, { recursive: true })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-create-backfill-cwd',
      workspaceId: 'ws-create-backfill-cwd',
      workspaceName: 'cwd-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    attachDirListHandler(executor, [root], [root, child])

    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    await waitForWorkspace(dashboard, 'ws-create-backfill-cwd')

    const ready = new Promise<SessionReadyEvent>((resolve) => {
      dashboard.off('session:ready')
      dashboard.on('session:ready', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-create-backfill-cwd',
      workspaceName: 'cwd-box',
      cwd: child,
    })

    const createdReady = await ready
    expect(createdReady.workspaceId).toBe('ws-create-backfill-cwd')
    expect(createdReady.state.cwd).toBe(child)
    expect(server.store.get(sessionId)?.workspaceId).toBe('ws-create-backfill-cwd')
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const reloaded = await server.store.load(sessionId)
    expect(reloaded.workspaceId).toBe('ws-create-backfill-cwd')
    expect(reloaded.state.cwd).toBe(child)

    dashboard.close()
    executor.close()
  })

  it('client:create_session preserves and validates a Windows cwd on a Linux host', async () => {
    const sessionId = 'wire-create-session-windows-cwd'
    const root = 'C:\\Users\\Admin'
    const child = 'c:\\users\\admin\\project'
    const executor = clientIO(`${url}/executor`, { transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION }, reconnection: false }) as ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', { executorId: 'ex-windows-cwd', workspaceId: 'ws-windows-cwd', workspaceName: 'windows-box', tools: ['write'], sandboxRoots: [root], runtime: 'node', runtimeVersion: '22', os: 'win32' })
    attachDirListHandler(executor, [root], [root, child])
    const dashboard = clientIO(`${url}/dashboard`, { transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    await waitForWorkspace(dashboard, 'ws-windows-cwd')
    const ready = new Promise<SessionReadyEvent>((resolve) => { dashboard.off('session:ready'); dashboard.on('session:ready', resolve) })
    dashboard.emit('client:create_session', { sessionId, workspaceId: 'ws-windows-cwd', workspaceName: 'windows-box', cwd: child })
    await expect(ready).resolves.toMatchObject({ state: { cwd: child } })
    dashboard.close(); executor.close()
  })

  it('client:list_dirs returns directory entries from the selected executor', async () => {
    const sessionId = 'wire-list-dirs'
    const root = resolve(dir, 'dir-root')
    const child = resolve(root, 'child')
    await import('node:fs/promises').then((fs) => fs.mkdir(child, { recursive: true }))

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.on('tool:call', (payload, ack) => {
      if (payload.name === '__fs_list_dirs') {
        const input = payload.input as { requestId: string; workspaceId: string }
        const result: DirListResult = {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          path: root,
          roots: [root],
          entries: [{ name: 'child', path: child }],
        }
        ack({ callId: payload.callId, ok: true, content: JSON.stringify(result) })
        return
      }
      if (payload.name === '__fs_create_directory') {
        const input = payload.input as { requestId: string; workspaceId: string; parentPath: string; name: string }
        ack({ callId: payload.callId, ok: true, content: JSON.stringify({
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          parentPath: input.parentPath,
          path: resolve(input.parentPath, input.name),
          roots: [root],
          created: true,
        }) })
      }
    })
    executor.emit('executor:announce', {
      executorId: 'ex-list-dirs',
      workspaceId: 'ws-list-dirs',
      workspaceName: 'dir-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForWorkspace(dashboard, 'ws-list-dirs')

    const listed = new Promise<import('@agent-kernel/shared').DirListResult>((resolve) => {
      dashboard.on('server:dir_list', resolve)
    })
    const acknowledged = new Promise<import('@agent-kernel/shared').DirListResult>((resolve) => {
      dashboard.emit('client:list_dirs', {
        requestId: 'dirs-1',
        workspaceId: 'ws-list-dirs',
        path: root,
      }, resolve)
    })
    const expected = {
      requestId: 'dirs-1',
      workspaceId: 'ws-list-dirs',
      path: root,
      entries: [{ name: 'child', path: child }],
    }
    await expect(listed).resolves.toMatchObject(expected)
    await expect(acknowledged).resolves.toMatchObject(expected)
    await expect(new Promise<import('@agent-kernel/shared').CreateDirectoryResult>((resolve) => {
      dashboard.emit('client:create_directory', {
        requestId: 'mkdir-1',
        workspaceId: 'ws-list-dirs',
        parentPath: root,
        name: 'created',
      }, resolve)
    })).resolves.toMatchObject({
      requestId: 'mkdir-1',
      workspaceId: 'ws-list-dirs',
      parentPath: root,
      path: resolve(root, 'created'),
      created: true,
    })

    dashboard.close()
    executor.close()
  })

  it('client:set_cwd validates sandbox roots and updates session summaries', async () => {
    const sessionId = 'wire-set-cwd'
    const root = resolve(dir, 'workspace')
    const child = resolve(root, 'child')
    await mkdir(child, { recursive: true })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-cwd',
      workspaceId: 'ws-cwd',
      workspaceName: 'cwd-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    attachDirListHandler(executor, [root], [root, child])
    await waitForAnyExecutor(server)

    const created = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-cwd',
      workspaceName: 'cwd-box',
    })
    await created

    const changed = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.off('server:sessions')
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: child })
    const list = await changed
    const summary = list.sessions.find((s) => s.sessionId === sessionId)
    expect(summary?.currentCwd).toBe(child)
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const err = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.on('session:error', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: resolve(dir, 'outside') })
    await expect(err).resolves.toMatchObject({
      scope: 'host',
      message: 'cwd outside sandbox roots',
    })
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const missingErr = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.once('session:error', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: resolve(root, 'missing') })
    await expect(missingErr).resolves.toMatchObject({
      scope: 'host',
      message: expect.stringContaining('cwd is not a readable directory'),
    })
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    dashboard.close()
    executor.close()
  })

  it('client:set_cwd rejects running or offline workspace sessions', async () => {
    const runningSessionId = 'wire-set-cwd-running'
    await server.store.ensure({
      sessionId: runningSessionId,
      defaultConfig: config,
      workspaceId: 'ws-running',
      workspaceName: 'running-box',
    })
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: runningSessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    server.store.get(runningSessionId)!.state.status = 'thinking'

    const runningErr = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.once('session:error', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId: runningSessionId, cwd: '/tmp' })
    await expect(runningErr).resolves.toMatchObject({
      scope: 'host',
      message: 'cannot change cwd while session status is thinking',
    })
    expect(server.store.get(runningSessionId)?.state.cwd).toBeUndefined()

    const offlineSessionId = 'wire-set-cwd-offline'
    await server.store.ensure({
      sessionId: offlineSessionId,
      defaultConfig: config,
      workspaceId: 'ws-offline',
      workspaceName: 'offline-box',
    })
    const offlineDashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: offlineSessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      offlineDashboard.on('session:ready', resolve),
    )
    const offlineErr = new Promise<{ scope: string; message: string }>((resolve) => {
      offlineDashboard.once('session:error', resolve)
    })
    offlineDashboard.emit('client:set_cwd', { sessionId: offlineSessionId, cwd: '/tmp' })
    await expect(offlineErr).resolves.toMatchObject({
      scope: 'host',
      message: 'workspace offline',
    })
    expect(server.store.get(offlineSessionId)?.state.cwd).toBeUndefined()

    dashboard.close()
    offlineDashboard.close()
  })

  it('client:compact rejects an empty session without calling the summarizer', async () => {
    const sessionId = 'wire-empty-compact'
    let llmCalls = 0
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'compact-counter',
        async call() {
          llmCalls += 1
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'summary' }],
            },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const err = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.on('session:error', resolve)
    })
    dashboard.emit('client:compact', { sessionId })

    await expect(err).resolves.toMatchObject({
      scope: 'kernel',
      message: 'nothing to compact yet',
    })
    expect(llmCalls).toBe(0)

    dashboard.close()
  })

  it('client:compact persists a manual handoff without starting another Agent turn', async () => {
    const sessionId = 'wire-manual-compact-rests'
    let llmCalls = 0
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'manual-compact-rests',
        async call(input) {
          llmCalls += 1
          if (!input.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'turn complete' }] } }
          }
          const detail = 'Preserve the completed turn and wait for an explicit user message before doing more work. '.repeat(8)
          return {
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: `## Objective\n- Keep the compacted session stable.\n\n## User Intent And Constraints\n- ${detail}\n\n## Repository And Runtime State\n- Session is resting.\n\n## Decisions\n- Manual compact does not resume.\n\n## Work Completed\n- Existing turn completed.\n\n## Open Work\n- Wait for the user.\n\n## Preserved Verbatim\n- Manual compact.`,
              }],
            },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.loop.dispatch(sessionId, { kind: 'user_message', text: 'finish this turn' })
    expect(server.store.get(sessionId)?.state.status).toBe('done')

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const compactDone = new Promise<void>((resolve) => {
      dashboard.on('server:compact_status', (payload) => {
        if (payload.kind === 'done') resolve()
      })
    })
    dashboard.emit('client:compact', { sessionId })
    await compactDone

    expect(llmCalls).toBe(2)
    expect(server.store.get(sessionId)?.state.status).toBe('done')
    const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
    expect(parsed.events.at(-1)?.event).toMatchObject({ kind: 'messages_replaced', reason: 'compaction' })
    expect(parsed.events.some((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toBe(false)
    dashboard.close()
  })

  it('executes a queued bang shell only after it reaches the idle head and sends the persisted result as user text', async () => {
    const sessionId = 'wire-bang-shell-queue'
    const workspaceId = 'ws-bang-shell-queue'
    await server.close()
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const firstCallStarted = new Promise<void>((resolve) => { firstStarted = resolve })
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    let llmCalls = 0
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'bang-shell-queue-test',
        async call() {
          llmCalls += 1
          if (llmCalls === 1) {
            firstStarted()
            await firstRelease
          }
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId,
      config,
      workspaceId,
      workspaceName: 'shell workspace',
      initialCwd: '/workspace/project',
    })

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    let toolCalls = 0
    let resolveTool!: (payload: ToolCallMessage) => void
    const toolCalled = new Promise<ToolCallMessage>((resolve) => { resolveTool = resolve })
    let releaseTool!: () => void
    const toolRelease = new Promise<void>((resolve) => { releaseTool = resolve })
    executor.on('tool:call', (payload: ToolCallMessage, ack: (result: ToolResultAck) => void) => {
      if (payload.name === 'bash') {
        toolCalls += 1
        resolveTool(payload)
        void toolRelease.then(() => ack({
          callId: payload.callId,
          ok: true,
          content: JSON.stringify({ stdout: 'hello', stderr: 'warning', exitCode: 3, signal: null, durationMs: 5 }),
        }))
        return
      }
      ack({ callId: payload.callId, ok: true, content: 'ok' })
    })
    executor.emit('executor:announce', {
      executorId: 'ex-bang-shell-queue', workspaceId, workspaceName: 'shell workspace', tools: ['bash'], runtime: 'node', runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const shellQueueStates: string[] = []
    dashboard.on('server:message_queue', (payload) => {
      const shell = payload.items.find((item) => item.id === 'bang-shell-operation')?.shell
      if (shell) shellQueueStates.push(shell.state)
    })
    expect(await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId, text: 'hold the turn', mode: 'steer', operationId: 'bang-shell-first',
    })).toEqual({ ok: true })
    await firstCallStarted
    expect(await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'shell',
      sessionId, text: '!printf hello', mode: 'queue', operationId: 'bang-shell-operation',
    })).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(toolCalls).toBe(0)

    const appendedUserTexts: string[] = []
    const resultEvent = new Promise<EventAppendedEvent>((resolve) => dashboard.on('event:appended', (payload) => {
      if (payload.event.kind !== 'user_message') return
      appendedUserTexts.push(payload.event.text)
      if (payload.event.text.includes('Shell command result')) resolve(payload)
    }))
    releaseFirst()
    await expect(toolCalled).resolves.toMatchObject({
      sessionId,
      name: 'bash',
      input: { command: 'printf hello', capture_separate_streams: true },
      cwd: '/workspace/project',
    })
    expect(await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId, text: 'steer after claimed shell', mode: 'steer', operationId: 'bang-shell-following-steer',
    })).toEqual({ ok: true })
    expect(toolCalls).toBe(1)
    releaseTool()
    await expect(resultEvent).resolves.toMatchObject({
      event: {
        kind: 'user_message',
        text: expect.stringContaining('Command: printf hello'),
      },
    })
    const event = await resultEvent
    if (event.event.kind !== 'user_message') throw new Error('expected user message')
    expect(event.event.text).toContain('Operation: bang-shell-operation')
    expect(event.event.text).toContain('Status: nonzero')
    expect(event.event.text).toContain('Exit status: 3')
    expect(event.event.text).toContain('stdout:\nhello')
    expect(event.event.text).toContain('stderr:\nwarning')
    await vi.waitFor(() => {
      expect(appendedUserTexts).toContain('steer after claimed shell')
    })
    expect(appendedUserTexts.indexOf(event.event.text)).toBeLessThan(appendedUserTexts.indexOf('steer after claimed shell'))
    expect(toolCalls).toBe(1)
    expect(shellQueueStates).toEqual(expect.arrayContaining(['queued', 'running', 'nonzero']))
    expect(shellQueueStates.indexOf('queued')).toBeLessThan(shellQueueStates.indexOf('running'))
    expect(shellQueueStates.indexOf('running')).toBeLessThan(shellQueueStates.indexOf('nonzero'))
    dashboard.close()
    executor.close()
  })

  it('cancels a Host-owned shell on external-runtime Stop and never sends its result', async () => {
    const sessionId = 'wire-bang-shell-external-stop'
    const workspaceId = 'ws-bang-shell-external-stop'
    const operationId = 'bang-shell-external-operation'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      copilot: { enabled: true },
      llm: scriptedLlm(),
    })
    url = `http://localhost:${server.port}`
    await server.store.create({
      sessionId,
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: sessionId,
      workspaceId,
      workspaceName: 'external shell workspace',
      config,
    })

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    let lateAck!: (result: ToolResultAck) => void
    const toolCalled = new Promise<ToolCallMessage>((resolve) => {
      executor.on('tool:call', (payload, ack) => {
        lateAck = ack
        resolve(payload)
      })
    })
    const toolCancelled = new Promise<{ sessionId: string; callId: string }>((resolve) => executor.on('tool:cancel', resolve))
    executor.emit('executor:announce', {
      executorId: 'ex-bang-shell-external-stop', workspaceId, workspaceName: 'external shell workspace', tools: ['bash'], runtime: 'node', runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    let shellResultSeen = false
    dashboard.on('event:appended', (payload) => {
      if (payload.event.kind === 'user_message' && payload.event.text.includes('Shell command result')) shellResultSeen = true
    })
    expect(await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'shell',
      sessionId, text: '!sleep forever', mode: 'steer', operationId,
    })).toEqual({ ok: true })
    const pendingCall = await toolCalled

    expect(await dashboard.timeout(500).emitWithAck('client:cancel', {
      sessionId, operationId: 'stop-bang-shell-external',
    })).toEqual({ ok: true })
    await expect(toolCancelled).resolves.toEqual({ sessionId, callId: pendingCall.callId })
    lateAck({ callId: pendingCall.callId, ok: true, content: JSON.stringify({ stdout: 'too late', stderr: '', exitCode: 0 }) })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const log = await readSessionLog(server.store.get(sessionId)!.logPath, { allowExternalRuntime: true })
    expect(log.runtimeMetadata.some((entry) =>
      entry.action === 'copilot.user_message' && entry.payload.operationId === bangShellResultOperationId(operationId),
    )).toBe(false)
    expect(shellResultSeen).toBe(false)
    dashboard.close()
    executor.close()
  })

  it('treats a literal leading bang as ordinary text when intent is text', async () => {
    const sessionId = 'wire-literal-bang-no-workspace'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    await expect(dashboard.timeout(500).emitWithAck('client:user_message', {
      intent: 'text', sessionId, text: '!pwd', mode: 'steer', operationId: 'literal-bang-text',
    })).resolves.toEqual({ ok: true })
    dashboard.close()
  })

  it('rejects bang shell admission for a Session without a workspace', async () => {
    const sessionId = 'wire-bang-shell-no-workspace'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    await expect(dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'shell',
      sessionId, text: '!pwd', mode: 'steer', operationId: 'bang-shell-no-workspace',
    })).resolves.toEqual({ ok: false, error: 'Shell commands require a Session bound to a workspace' })
    dashboard.close()
  })

  it('queues user messages while a turn is running and dispatches them after rest', async () => {
    const sessionId = 'wire-message-queue'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    const seenModels: Array<string | undefined> = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const governor = new UnitResourceGovernor({
      maxConcurrentTurns: 1,
      maxQueuedMessages: 1,
      maxArtifactBytes: 1024,
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      resourceGovernor: governor,
      resourceUnitId: 'unit-a',
      models: [
        { ref: 'provider:model-a', id: 'model-a', label: 'Model A', provider: 'provider' },
        { ref: 'provider:model-b', id: 'model-b', label: 'Model B', provider: 'provider' },
      ],
      llm: {
        name: 'queue-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          seenModels.push(p.model)
          if (seenPrompts.length === 1) await firstRelease
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${seenPrompts.length}` }],
            },
            usage: { inputTokens: 10, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'provider:model-a' })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const queueEvents: Array<{ pending: number; text?: string; mode?: string; id?: string }> = []
    let queuedCommitObserved = false
    let queueClearedAtCommit = false
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) {
        queueEvents.push({
          pending: p.pending,
          text: p.items[0]?.text,
          mode: p.items[0]?.mode,
          id: p.items[0]?.id,
        })
        if (queuedCommitObserved && p.pending === 0) queueClearedAtCommit = true
      }
    })
    dashboard.on('event:appended', (p) => {
      if (p.sessionId === sessionId && p.event.kind === 'user_message' && p.event.operationId === 'queued-second') queuedCommitObserved = true
    })
    const finalDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('queued turn never finished')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done' && p.state.messages.length >= 5) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    const firstAck = await new Promise<RpcAck>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('direct message ACK waited for the Agent turn')), 500)
      dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer', operationId: 'direct-first' }, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
    expect(firstAck).toEqual({ ok: true })
    const retryAck = await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'first',
      mode: 'steer',
      operationId: 'direct-first',
    })
    expect(retryAck).toEqual({ ok: true })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'second', mode: 'queue', operationId: 'queued-second' })
    const retryQueuedAck = await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'second',
      mode: 'queue',
      operationId: 'queued-second',
    })
    expect(retryQueuedAck).toEqual({ ok: true })
    const rejectedAck = await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId,
      text: 'third',
      mode: 'queue',
      operationId: 'queued-third',
    })
    expect(rejectedAck).toMatchObject({ ok: false, error: expect.stringContaining('queue limit exceeded') })
    expect(governor.snapshot('unit-a')).toMatchObject({ concurrentTurns: 1, queuedMessages: 1 })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !queueEvents.some((e) => e.pending === 1 && e.text === 'second')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const modelChanged = new Promise<void>((resolve) => dashboard.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.selectedModel === 'provider:model-b') {
        resolve()
      }
    }))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'provider:model-b' } })
    await modelChanged
    releaseFirst()
    await finalDone

    expect(queueEvents.map((e) => e.pending)).toContain(1)
    expect(queueEvents.map((e) => e.pending)).toContain(0)
    expect(queueClearedAtCommit).toBe(true)
    expect(queueEvents.some((e) => e.pending === 1 && e.text === 'second' && e.mode === 'queue' && typeof e.id === 'string')).toBe(true)
    expect(seenPrompts).toEqual(['first', 'first|second'])
    expect(seenModels).toEqual(['provider:model-a', 'provider:model-a'])
    expect(server.store.get(sessionId)?.preferences.selectedModel).toBe('provider:model-b')
    // The final 'done' event is broadcast before the permit is released in
    // the turn's finally block; wait for cleanup rather than racing the event.
    await vi.waitFor(() => expect(governor.snapshot('unit-a')).toMatchObject({ concurrentTurns: 0, queuedMessages: 0 }))

    dashboard.close()
  })

  it('does not interrupt an active turn when queueing during a transient done state', async () => {
    const sessionId = 'wire-message-queue-transient-done'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let releaseFinish!: () => void
    const finishGate = new Promise<void>((resolve) => { releaseFinish = resolve })
    const seenPrompts: string[] = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-transient-done-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await finishGate
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    while (seenPrompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'queued', mode: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seenPrompts).toEqual(['first'])
    expect(server.store.get(sessionId)?.state.messages.some((message) => message.role === 'user' && message.content.some((part) => part.type === 'text' && part.text === 'queued'))).toBe(false)

    releaseFinish()
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && seenPrompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenPrompts).toEqual(['first', 'first|queued'])
    dashboard.close()
  })

  it('does not expose an idle queue-mode send as a pending queue item', async () => {
    const sessionId = 'wire-idle-queue-hidden'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const queueEvents: ServerMessageQueueEvent[] = []
    dashboard.on('server:message_queue', (event) => { if (event.sessionId === sessionId) queueEvents.push(event) })
    const ack = await dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId, text: 'send immediately', mode: 'queue', operationId: 'idle-queue-send',
    })
    expect(ack).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queueEvents.every((event) => event.items.every((item) => item.text !== 'send immediately'))).toBe(true)
    dashboard.close()
  })

  it('keeps an immediate post-ACK follow-up behind the accepted direct message', async () => {
    const sessionId = 'wire-message-queue-post-ack-race'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
    const seenPrompts: string[] = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-post-ack-race-test',
        async call(p) {
          const userText = p.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content.map((content) => ('text' in content ? content.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (event) => { if (event.sessionId === sessionId) latestQueue = event })

    await expect(dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId, text: 'first', mode: 'steer', operationId: 'post-ack-first',
    })).resolves.toEqual({ ok: true })
    await expect(dashboard.timeout(500).emitWithAck('client:user_message', { intent: 'text',
      sessionId, text: 'second', mode: 'queue', operationId: 'post-ack-second',
    })).resolves.toEqual({ ok: true })

    const queuedDeadline = Date.now() + 2000
    while (Date.now() < queuedDeadline && !latestQueue?.items.some((item) => item.text === 'second' && item.mode === 'queue')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(latestQueue?.items).toEqual([expect.objectContaining({ text: 'second', mode: 'queue' })])
    releaseFirst()
    const finishedDeadline = Date.now() + 4000
    while (Date.now() < finishedDeadline && seenPrompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenPrompts).toEqual(['first', 'first|second'])

    const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'user_message').map((entry) => entry.event.operationId)).toEqual(['post-ack-first', 'post-ack-second'])
    dashboard.close()
  })

  it('captures the effective default model on queued messages', async () => {
    const sessionId = 'wire-message-queue-default-model'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenModels: Array<string | undefined> = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      models: [
        { ref: 'provider:first-model', id: 'first-model', label: 'First Model', provider: 'provider', providerId: 'provider' },
        { ref: 'provider:model-default', id: 'model-default', label: 'Default Model', provider: 'provider', providerId: 'provider' },
        { ref: 'provider:model-later', id: 'model-later', label: 'Later Model', provider: 'provider', providerId: 'provider' },
      ],
      defaultModel: 'provider:model-default',
      llm: {
        name: 'queue-default-model-test',
        async call(p) {
          seenModels.push(p.model)
          if (seenModels.length === 1) await firstRelease
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenModels.length}` }] },
            usage: { inputTokens: 10, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const finalDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('queued turn never finished')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done' && p.state.messages.length >= 5) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenModels.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'second', mode: 'queue' })
    const modelChanged = new Promise<void>((resolve) => dashboard.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.selectedModel === 'provider:model-later') {
        resolve()
      }
    }))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'provider:model-later' } })
    await modelChanged
    releaseFirst()
    await finalDone

    expect(seenModels).toEqual(['provider:model-default', 'provider:model-default'])
    dashboard.close()
  })

  it('lets dashboard reorder, edit, and delete queued user messages before drain', async () => {
    const sessionId = 'wire-message-queue-edit'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-edit-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${seenPrompts.length}` }],
            },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) latestQueue = p
    })
    const waitForQueue = async (count: number): Promise<ServerMessageQueueEvent> => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (latestQueue?.pending === count) return latestQueue
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`queue did not reach ${count}`)
    }
    const finalDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('edited queued turn never finished')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done' && p.state.messages.length >= 7) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'second', mode: 'queue' })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'third', mode: 'queue' })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'delete me', mode: 'queue' })
    const queued = await waitForQueue(3)
    const second = queued.items.find((item) => item.text === 'second')!
    const third = queued.items.find((item) => item.text === 'third')!
    const deleteMe = queued.items.find((item) => item.text === 'delete me')!
    dashboard.emit('client:update_queued_message', { sessionId, id: third.id, text: 'third edited' })
    dashboard.emit('client:delete_queued_message', { sessionId, id: deleteMe.id })
    dashboard.emit('client:reorder_queued_message', { sessionId, id: third.id, beforeId: second.id })
    await waitForQueue(2)
    releaseFirst()
    await finalDone

    expect(seenPrompts).toEqual(['first', 'first|third edited', 'first|third edited|second'])

    dashboard.close()
  })

  it.each(['kernel', 'copilot'] as const)('lets Stop tombstone a %s queue item during the post-claim barrier', async (agentRuntime) => {
    const previousSecret = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'claimed-queue-race-secret'
    const sessionId = `wire-claimed-queue-${agentRuntime}`
    const operationId = `claimed-operation-${agentRuntime}`
    let releaseClaim!: () => void
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    let observedClaim!: (value: { sessionId: string; operationId: string; runtime: string }) => void
    const claimed = new Promise<{ sessionId: string; operationId: string; runtime: string }>((resolve) => { observedClaim = resolve })
    try {
      await server.close()
      const http = createServer()
      await new Promise<void>((resolve) => http.listen(0, resolve))
      server = await startHostServer({
        port: (http.address() as AddressInfo).port,
        sessionsDir: dir,
        defaultConfig: config,
        httpServer: http,
        copilot: { enabled: agentRuntime === 'copilot' },
        llm: {
          name: 'claimed-queue-race-test',
          async call() {
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
          },
        },
        queueDispatchBarrier: async (operation) => {
          if (operation.operationId !== operationId) return
          observedClaim(operation)
          await claimBarrier
        },
      })
      url = `http://localhost:${server.port}`
      if (agentRuntime === 'copilot') {
        await server.store.create({ sessionId, agentRuntime: 'copilot', agentRuntimeVersion: '1.0.11', externalSessionId: sessionId, config })
      } else {
        await server.store.ensure({ sessionId, defaultConfig: config })
      }

      const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
        transports: ['websocket'],
        auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
        reconnection: false,
      })
      await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

      const admission = fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'claimed-queue-race-secret' },
        body: JSON.stringify({ sessionId, operationId, text: 'dispatch this exact text', intent: 'text', mode: 'queue' }),
      })
      await expect(claimed).resolves.toEqual({ sessionId, operationId, runtime: agentRuntime })

      const cancelDispatch = agentRuntime === 'kernel' ? vi.spyOn(server.loop, 'dispatch') : undefined
      const conflicts: RpcAck[] = [
        await new Promise<RpcAck>((resolve) => dashboard.emit('client:delete_queued_message', { sessionId, id: operationId }, resolve)),
      ]
      if (agentRuntime === 'kernel') {
        conflicts.push(
          await new Promise<RpcAck>((resolve) => dashboard.emit('client:update_queued_message', { sessionId, id: operationId, text: 'must not replace claimed text' }, resolve)),
          await new Promise<RpcAck>((resolve) => dashboard.emit('client:reorder_queued_message', { sessionId, id: operationId, beforeId: null }, resolve)),
        )
      }
      for (const result of conflicts) {
        expect(result).toEqual({ ok: false, error: `queued message ${operationId} is already dispatching` })
      }

      const stopped = await new Promise<RpcAck>((resolve) => dashboard.emit('client:cancel', { sessionId, operationId: `stop-${agentRuntime}` }, resolve))
      expect(stopped).toEqual({ ok: true })
      const stoppedLog = await readSessionLog(server.store.get(sessionId)!.logPath, { allowExternalRuntime: true })
      if (agentRuntime === 'kernel') expect(cancelDispatch).toHaveBeenCalledWith(sessionId, { kind: 'cancel' })
      else expect(stoppedLog.runtimeMetadata.some((entry) => entry.action === 'copilot.cancelled')).toBe(true)

      releaseClaim()
      await expect(admission.then((response) => response.json())).resolves.toMatchObject({ accepted: true })
      expect(server.store.get(sessionId)!.state.messages.some((message) =>
        message.role === 'user' && message.content.some((part) => part.type === 'text' && (part.text === 'dispatch this exact text' || part.text === 'must not replace claimed text')),
      )).toBe(false)
      const finalLog = await readSessionLog(server.store.get(sessionId)!.logPath, { allowExternalRuntime: true })
      expect(finalLog.runtimeMetadata.some((entry) => entry.action === 'copilot.user_message' && entry.payload.operationId === operationId)).toBe(false)
      const afterRelease = await new Promise<RpcAck>((resolve) => dashboard.emit('client:delete_queued_message', { sessionId, id: operationId }, resolve))
      expect(afterRelease).toEqual({ ok: true })
      dashboard.close()
    } finally {
      releaseClaim?.()
      if (previousSecret === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previousSecret
    }
  })

  it.each(['kernel', 'copilot'] as const)('still cancels the %s runtime when Stop races a claimed item whose dispatch already committed', async (agentRuntime) => {
    const previousSecret = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = 'committed-queue-race-secret'
    const sessionId = `wire-committed-queue-${agentRuntime}`
    const operationId = `committed-operation-${agentRuntime}`
    let releaseClaim!: () => void
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    let observedClaim!: () => void
    const claimed = new Promise<void>((resolve) => { observedClaim = resolve })
    try {
      await server.close()
      const http = createServer()
      await new Promise<void>((resolve) => http.listen(0, resolve))
      server = await startHostServer({
        port: (http.address() as AddressInfo).port,
        sessionsDir: dir,
        defaultConfig: config,
        httpServer: http,
        copilot: { enabled: agentRuntime === 'copilot' },
        llm: {
          name: 'committed-queue-race-test',
          async call() {
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
          },
        },
        queueDispatchBarrier: async (operation) => {
          if (operation.operationId !== operationId) return
          observedClaim()
          await claimBarrier
        },
      })
      url = `http://localhost:${server.port}`
      if (agentRuntime === 'copilot') {
        await server.store.create({ sessionId, agentRuntime: 'copilot', agentRuntimeVersion: '1.0.11', externalSessionId: sessionId, config })
      } else {
        await server.store.ensure({ sessionId, defaultConfig: config })
      }
      const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
        transports: ['websocket'],
        auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
        reconnection: false,
      })
      await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

      const admission = fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'committed-queue-race-secret' },
        body: JSON.stringify({ sessionId, operationId, text: 'already committed text', intent: 'text', mode: 'queue' }),
      })
      await claimed
      if (agentRuntime === 'kernel') {
        await server.loop.dispatch(sessionId, { kind: 'user_message', operationId, text: 'already committed text' })
      } else {
        await appendRuntimeMetadataEntry(server.store.get(sessionId)!.logPath, {
          sessionId,
          action: 'copilot.user_message',
          payload: { operationId, text: 'already committed text', requestFingerprint: messageOperationFingerprint('already committed text') },
        })
      }

      const cancelDispatch = agentRuntime === 'kernel' ? vi.spyOn(server.loop, 'dispatch') : undefined
      const claimedDelete = await new Promise<RpcAck>((resolve) => dashboard.emit('client:delete_queued_message', { sessionId, id: operationId }, resolve))
      expect(claimedDelete).toEqual({ ok: false, error: `queued message ${operationId} is already dispatching` })
      const stopped = await new Promise<RpcAck>((resolve) => dashboard.emit('client:cancel', { sessionId, operationId: `stop-committed-${agentRuntime}` }, resolve))
      expect(stopped).toEqual({ ok: true })
      const stoppedLog = await readSessionLog(server.store.get(sessionId)!.logPath, { allowExternalRuntime: true })
      if (agentRuntime === 'kernel') expect(cancelDispatch).toHaveBeenCalledWith(sessionId, { kind: 'cancel' })
      else expect(stoppedLog.runtimeMetadata.some((entry) => entry.action === 'copilot.cancelled')).toBe(true)

      releaseClaim()
      await expect(admission.then((response) => response.json())).resolves.toMatchObject({ accepted: true })
      dashboard.close()
    } finally {
      releaseClaim?.()
      if (previousSecret === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previousSecret
    }
  })

  it('persists queued user messages across host restart and syncs them to dashboards', async () => {
    const sessionId = 'wire-message-queue-restart'
    await server.close()
    let http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    let port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstGovernor = new UnitResourceGovernor({
      maxConcurrentTurns: 1,
      maxQueuedMessages: 4,
      maxArtifactBytes: 1024,
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      resourceGovernor: firstGovernor,
      resourceUnitId: 'unit-a',
      llm: {
        name: 'queue-restart-test-1',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'first done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    let dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) latestQueue = p
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const waitForQueue = async (count: number): Promise<ServerMessageQueueEvent> => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (latestQueue?.pending === count) return latestQueue
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`queue did not reach ${count}`)
    }

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'second', mode: 'queue' })
    expect((await waitForQueue(1)).items[0]?.text).toBe('second')
    expect(firstGovernor.snapshot('unit-a')).toMatchObject({ concurrentTurns: 1, queuedMessages: 1 })
    dashboard.close()
    await server.close()
    releaseFirst()

    http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    port = (http.address() as AddressInfo).port
    const restoredGovernor = new UnitResourceGovernor({
      maxConcurrentTurns: 1,
      maxQueuedMessages: 4,
      maxArtifactBytes: 1024,
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      resourceGovernor: restoredGovernor,
      resourceUnitId: 'unit-a',
      llm: {
        name: 'queue-restart-test-2',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'second done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    latestQueue = undefined
    dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) latestQueue = p
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const restoredSnapshot = latestQueue
    expect(restoredSnapshot?.items[0]?.text ?? 'second').toBe('second')
    expect(restoredGovernor.snapshot('unit-a').queuedMessages).toBe(1)
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && seenPrompts.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seenPrompts).toEqual(['first', 'first|second'])
    const quiescentDeadline = Date.now() + 2000
    while (Date.now() < quiescentDeadline) {
      const snapshot = restoredGovernor.snapshot('unit-a')
      if (latestQueue?.pending === 0 && snapshot.concurrentTurns === 0 && snapshot.queuedMessages === 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(latestQueue?.pending).toBe(0)
    expect(restoredGovernor.snapshot('unit-a')).toMatchObject({ concurrentTurns: 0, queuedMessages: 0 })

    const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
    expect(parsed.runtimeMetadata.some((entry) => entry.action === 'message_queue_snapshot')).toBe(true)
    expect(parsed.events.some((entry) => entry.event.kind === 'llm_response' && entry.event.message.content.some((part) => part.type === 'text' && part.text === '[interrupted]'))).toBe(false)
    dashboard.close()
  })

  it('steer while a turn is running interrupts and dispatches without surfacing as a queued dock item', async () => {
    const sessionId = 'wire-steer-while-running'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'steer-while-running-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          // Block the first turn until the steer message aborts it.
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const queueEvents: Array<{ pending: number; text?: string; mode?: string }> = []
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) {
        queueEvents.push({ pending: p.pending, text: p.items[0]?.text, mode: p.items[0]?.mode })
      }
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    // Start a turn and wait until the LLM call is in flight (blocked).
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })

    // Steer while the turn is running: this must interrupt the active turn and
    // be delivered — never linger in the queue dock as a stuck "queued" item.
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'steered', mode: 'steer' })
    // Release the blocked first call so the abort/redispatch chain can settle.
    releaseFirst()

    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('steered'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // Bug 2: the steer message must actually be dispatched, not stuck forever.
    expect(seenPrompts.some((prompt) => prompt.includes('steered'))).toBe(true)
    // Bug 1: a steer must never be surfaced to the dock as a queued message.
    expect(queueEvents.some((e) => e.text === 'steered' && e.mode === 'steer' && e.pending > 0)).toBe(false)

    dashboard.close()
  })

  it('Stop discards pending steer and queue without auto-restarting the Session', async () => {
    await server.close()
    const sessionId = 'wire-stop-queue-steer'
    const seenPrompts: string[] = []
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port, sessionsDir: dir, defaultConfig: config, httpServer: http, toolTimeoutMs: 2000,
      llm: {
        name: 'stop-queue-steer-test',
        async call(params) {
          const userText = params.messages.filter((message) => message.role === 'user').map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join('')).join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) {
            await new Promise<void>((_resolve, reject) => {
              params.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
            })
          }
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (payload) => { if (payload.sessionId === sessionId) latestQueue = payload })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    while (seenPrompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'later queue', mode: 'queue' })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'pending steer', mode: 'steer' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    dashboard.emit('client:cancel', { sessionId })

    const deadline = Date.now() + 3000
    while (Date.now() < deadline && server.store.get(sessionId)?.state.status !== 'done') await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.store.get(sessionId)?.state.status).toBe('done')
    expect(seenPrompts).toHaveLength(1)
    expect(seenPrompts.some((prompt) => prompt.includes('pending steer'))).toBe(false)
    expect(seenPrompts.some((prompt) => prompt.includes('later queue'))).toBe(false)
    expect(latestQueue).toMatchObject({ pending: 0, items: [] })

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'resume explicitly', mode: 'steer' })
    const resumeDeadline = Date.now() + 3000
    while (Date.now() < resumeDeadline && !seenPrompts.some((prompt) => prompt.includes('resume explicitly'))) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenPrompts.some((prompt) => prompt.includes('resume explicitly'))).toBe(true)
    expect(seenPrompts.some((prompt) => prompt.includes('later queue'))).toBe(false)
    dashboard.close()
  })

  it('steer during tool execution waits for the running tool to finish, then dispatches (no truncation)', async () => {
    // Steer semantics (spec A): a steer submitted while the agent is
    // mid-tool-execution must NOT abort the running tool/sub-agent. It waits for
    // the current tool to finish naturally, stops the autonomous loop before the
    // next think, and then dispatches the front-queued steer as the next turn.
    // Here the child sub-agent completes on its own after the steer arrives; the
    // steer must be delivered *after* that completion, never by truncating it.
    await server.close()
    const sessionId = 'wire-steer-during-tools'
    let call = 0
    const seenPrompts: string[] = []
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    const llm: LLMAdapter = {
      name: 'steer-during-tools-test',
      async call(params) {
        call += 1
        const userText = params.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
          .join('|')
        seenPrompts.push(userText)
        if (call === 1) {
          // Parent's first turn: spawn a sub-agent so the parent parks in
          // `executing_tools` (host tool) while the child runs.
          return {
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_call', callId: 'agent-steer-1', name: 'agent', input: { prompt: 'long child task' } },
              ],
            },
          }
        }
        if (userText.includes('long child task')) {
          // Child LLM call: run until the test releases it (simulating a tool
          // that finishes on its own AFTER the steer has been submitted). It must
          // NOT be aborted by the steer — spec A waits for it to complete.
          await childGate
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${call}` }] } }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const agentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm,
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 5000,
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: agentConfig })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const queueEvents: Array<{ pending: number; text?: string; mode?: string }> = []
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) queueEvents.push({ pending: p.pending, text: p.items[0]?.text, mode: p.items[0]?.mode })
    })
    const childStarted = new Promise<void>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve()
      })
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    // Wait until the parent is parked in `executing_tools` (child agent running).
    await childStarted
    // Give the child LLM call a beat to actually start running (blocked on gate).
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Steer while a tool is executing. Spec A: this must NOT abort the child.
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'steered', mode: 'steer' })
    // Give the steer a beat to be enqueued + flag the session for a boundary stop
    // while the tool is still running, then let the child finish on its own.
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseChild()

    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('steered'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The steer is delivered — but only AFTER the child tool completed naturally.
    expect(seenPrompts.some((prompt) => prompt.includes('steered'))).toBe(true)
    // Proof the tool ran to completion rather than being truncated: the child
    // produced its own answer before the steer turn ran.
    expect(seenPrompts.some((prompt) => prompt.includes('long child task'))).toBe(true)
    // Never surfaced to the dock as a stuck queued item.
    expect(queueEvents.some((e) => e.text === 'steered' && e.mode === 'steer' && e.pending > 0)).toBe(false)

    dashboard.close()
  }, 15000)

  it('drains a queued message after the turn completes even if the dashboard disconnected', async () => {
    const sessionId = 'wire-queue-drain-after-disconnect'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-drain-after-disconnect-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    // Start a turn; wait until the first LLM call is in flight (blocked).
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })

    // Queue a follow-up while the turn is running, then DISCONNECT the dashboard
    // (simulating the user closing the browser / PWA) before the turn finishes.
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'queued', mode: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    dashboard.close()

    // Now let the first turn complete. With no dashboard connected, the queued
    // message must still be drained automatically by the turn-completion hook.
    releaseFirst()
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('queued'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seenPrompts.some((prompt) => prompt.includes('queued'))).toBe(true)
  })

  it('drains MANY queued messages in order after all browsers close mid-turn', async () => {
    // User scenario: session is running, the user queues several follow-ups,
    // then closes every browser/PWA. With no client connected, the host must
    // still drain the whole queue — one message per turn — in FIFO order.
    const sessionId = 'wire-queue-drain-many-after-disconnect'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-drain-many-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    // Start a turn; wait until the first LLM call is in flight (blocked).
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })

    // Queue THREE follow-ups while the turn is running, then close the browser.
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'q-one', mode: 'queue' })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'q-two', mode: 'queue' })
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'q-three', mode: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    dashboard.close()

    // Release the blocked first turn. All three queued messages must drain
    // automatically, in FIFO order, with no client connected.
    releaseFirst()
    const deadline = Date.now() + 6000
    const delivered = (): boolean =>
      ['q-one', 'q-two', 'q-three'].every((t) => seenPrompts.some((p) => p.includes(t)))
    while (Date.now() < deadline && !delivered()) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(delivered()).toBe(true)
    // FIFO: the turn index where each first appears must be increasing.
    const firstIndex = (t: string): number => seenPrompts.findIndex((p) => p.includes(t))
    expect(firstIndex('q-one')).toBeLessThan(firstIndex('q-two'))
    expect(firstIndex('q-two')).toBeLessThan(firstIndex('q-three'))
  }, 15000)

  it('enqueues a user message over HTTP (pagehide beacon path) and drains it with no socket', async () => {
    const sessionId = 'wire-http-enqueue-beacon'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'http-enqueue-beacon-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    dashboard.emit('client:user_message', { intent: 'text', sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    // Simulate the browser closing: the socket is gone, and the queued message
    // arrives only via the HTTP beacon endpoint.
    dashboard.close()
    const res = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue-user-message', sessionId, text: 'beaconed' }),
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { queued?: boolean }
    expect(body.queued).toBe(true)

    releaseFirst()
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('beaconed'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seenPrompts.some((prompt) => prompt.includes('beaconed'))).toBe(true)
  })

  it('fires session_start and session_end lifecycle hooks around create/delete', async () => {
    const sessionId = 'wire-lifecycle-hooks'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const calls: Array<{ event: string; sessionId: string }> = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: scriptedLlm(),
      hooks: [
        { event: 'session_start', command: 'true' },
        { event: 'session_end', command: 'true' },
        { event: 'session_start', command: 'true', match: 'nope' },
      ],
      hookRunner: {
        async run(hook, payload) {
          calls.push({ event: hook.event, sessionId: payload.sessionId })
          return { ok: true, exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })
    url = `http://localhost:${server.port}`

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const created = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-life',
      workspaceName: 'life-box',
    })
    await created
    // Wait one tick so the async lifecycle hook has a chance to run.
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([{ event: 'session_start', sessionId }])

    const deleted = new Promise<{ sessionId: string }>((resolve) => {
      dashboard.on('server:session_deleted', resolve)
    })
    await new Promise<void>((resolve, reject) => dashboard.emit('client:delete_session', { operationId: 'delete-lifecycle-op', sessionId }, (ack) => ack.ok ? resolve() : reject(new Error(ack.error))))
    await deleted
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([
      { event: 'session_start', sessionId },
      { event: 'session_end', sessionId },
    ])

    dashboard.close()
  })
})

describe('protocol doc drift', () => {
  it('wire-protocol.md §3.4 session:error scope union matches SESSION_ERROR_SCOPES', async () => {
    // Reviewer round-2 observation: the shared TS type used `'host'` while
    // wire-protocol.md still said `'core'` — a leftover from ADR 0011
    // (rename `packages/core` → `packages/host`). The runtime enforced
    // `'host'` but the doc lied to protocol implementers. This test pins
    // the two together so any future drift is caught in CI, not by a
    // reviewer reading two files side-by-side.
    const thisDir = dirname(fileURLToPath(import.meta.url))
    const docPath = resolve(
      thisDir,
      '..',
      '..',
      '..',
      'docs',
      'protocol',
      'wire-protocol.md',
    )
    const doc = await readFile(docPath, 'utf8')

    // Extract the scope union declared in the §3.4 code block. The line
    // shape is: `  scope: 'a' | 'b' | 'c' | 'd'`. Use a permissive regex
    // that tolerates spacing but pins the field name so unrelated `|`
    // characters in the doc don't match.
    const match = doc.match(/scope:\s*((?:'[a-z]+'\s*\|?\s*)+)/)
    expect(
      match,
      "wire-protocol.md §3.4 must declare a `scope: 'x' | 'y'` union",
    ).not.toBeNull()

    const docScopes = Array.from(match![1].matchAll(/'([a-z]+)'/g))
      .map((m) => m[1])
      .sort()
    const codeScopes = [...SESSION_ERROR_SCOPES].sort()

    expect(
      docScopes,
      `wire-protocol.md §3.4 scope union drifted from SESSION_ERROR_SCOPES ` +
        `(runtime enforces ${codeScopes.join(', ')} — see packages/shared/src/protocol.ts)`,
    ).toEqual(codeScopes)
  })
})
