/**
 * Socket.IO client that connects to the host's `/executor` namespace, announces
 * the local tool set, and services `tool:call` events by dispatching them to
 * the local tool registry.
 *
 * Every in-flight call gets its own `AbortController`; `tool:cancel` from host
 * aborts it. Tool failures become `{ ok: false, content: 'ERROR: …' }` — we
 * never let a runner exception cross the wire.
 *
 * Filesystem RPC handlers (list_dirs / list_files / read_file) live in
 * `./fs-handlers.ts`; machine metadata (os / ip list) lives in
 * `./announce-info.ts`. Both are pure and independently testable.
 */

import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type {
  BuildMetadata,
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ToolCallMessage,
  ToolCancelMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { io as clientIO, type Socket } from 'socket.io-client'
import { ulid } from 'ulid'

import { createSandbox } from './sandbox.js'
import type { Sandbox } from './sandbox.js'
import { allTools as defaultTools } from './tools/index.js'
import type { Tool } from './tools/registry.js'
import { ToolError, createToolRegistry } from './tools/registry.js'
import {
  maybeOverflow,
  overflowConfigFromEnv,
  type OverflowConfig,
} from './tools/overflow.js'
import { loadOrCreateWorkspaceId } from './workspace-id.js'
import { collectIpAddresses, normalizeOs } from './announce-info.js'
import { subscribeBackgroundTasks } from './tools/background-shell.js'
import { createTerminalManager } from './terminal-manager.js'
import { ExecutionReceiptStore } from './execution-receipts.js'
import type { RuntimeLogger } from './logger.js'
import { executorReleaseVersion } from './build-info.js'
import { failureForToolError } from './tool-failure.js'
import { McpClientManager, type McpToolDescriptor } from './mcp-client.js'
import { parseDashboardMcpServers, type DashboardMcpServerConfig, type McpServerConfig } from './mcp-config.js'
import { readDashboardMcpServers, writeDashboardMcpServers } from './mcp-managed-config.js'

const noopLogger: Pick<RuntimeLogger, 'debug' | 'info' | 'warn'> = {
  debug() {},
  info() {},
  warn() {},
}

const SENSITIVE_KEY = /(?:password|passwd|token|api[_-]?key|secret|authorization|cookie|credential|private[_-]?key|setup[_-]?code)/iu
const LARGE_VALUE_KEY = /^(?:content|patch|stdin|oldText|newText)$/u
const LOG_STRING_LIMIT = 500
const CONNECTION_ERROR_LIMIT = 300
const CONNECTION_DIAGNOSTIC_LIMIT = 1_500

function compactLogText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function connectionErrorSummary(error: unknown): { errorType: string; reason: string; code?: string | number } {
  const value = error as { name?: unknown; type?: unknown; message?: unknown; description?: unknown; code?: unknown }
  const description = value?.description as { message?: unknown; code?: unknown } | undefined
  const innerReason = description && typeof description === 'object' ? description.message : description
  const outerReason = value?.message ?? error
  const reason = compactLogText(innerReason || outerReason || 'unknown connection error', CONNECTION_ERROR_LIMIT)
  const errorType = compactLogText(value?.type || value?.name || 'ConnectionError', 80)
  const code = description && typeof description === 'object' ? description.code : value?.code
  return { errorType, reason, ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) }
}

function compactDiagnostic(error: unknown): string {
  const value = error as { stack?: unknown; message?: unknown }
  return compactLogText(value?.stack || value?.message || error, CONNECTION_DIAGNOSTIC_LIMIT)
}

function safeToolInput(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (depth > 4) return '[TRUNCATED depth]'
  if (typeof value === 'string') {
    const scrubbed = value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
      .replace(/(https?:\/\/[^\s/:]+:)[^@\s]+@/giu, '$1[REDACTED]@')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    if (LARGE_VALUE_KEY.test(key) || scrubbed.length > LOG_STRING_LIMIT) {
      return `${scrubbed.slice(0, LOG_STRING_LIMIT)}… [TRUNCATED ${scrubbed.length} chars]`
    }
    return scrubbed
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeToolInput(item, key, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([childKey, child]) => [childKey, safeToolInput(child, childKey, depth + 1)]))
  }
  return value
}

export type ExecutorOptions = {
  /** Host URL (e.g. `wss://host.example.com` or `http://localhost:3000`). */
  host: string
  /**
   * Stable workspace identity. If omitted, the executor loads (or on first
   * launch mints) one from `~/.kala/workspace-id`. Passing this
   * explicitly is the escape hatch for tests or multi-tenant deployments.
   */
  workspaceId?: string
  /**
   * Display label for the workspace (a workspace = a machine). Free to
   * rename — routing goes by workspaceId, not this. If omitted,
   * `os.hostname()` is used.
   */
  workspaceName?: string
  /**
   * Optional filesystem jail. Empty / omitted = executor trusts the whole
   * machine (defers to OS user permissions). Passing one or more roots
   * restricts file tools to those subtrees.
   */
  sandboxRoots?: readonly string[]
  token?: string
  invite?: string
  /** One-way invite hash used only to route an already enrolled device. */
  routeHint?: string
  /** Opaque active Runtime replica selected through the Gateway. */
  replicaId?: string
  /** Shared by every replica socket in one Executor process. */
  sharedExecution?: ExecutorSharedExecution
  executorId?: string
  installId?: string
  onToken?(token: string): void
  tools?: readonly Tool[]
  logger?: Pick<RuntimeLogger, 'debug' | 'info' | 'warn'>
  /** Injectable Socket.IO factory — used by tests. */
  ioFactory?: typeof clientIO
  receiptStorePath?: string | false
  networkPolicy?: import('@agent-kernel/shared').NetworkPolicy
  mcpServers?: readonly McpServerConfig[]
  /** Capability supplied only by the CLI after parsing a native managed config. */
  managedMcpConfig?: {
    path: string
    installationSource: 'dashboard-native'
    installationId: string
    configurationSource: 'managed-config'
  }
  mcpInitializeTimeoutMs?: number
  mcpCallTimeoutMs?: number
}

export type ExecutorSharedExecution = {
  readonly receiptStore: ExecutionReceiptStore | null
  readonly receiptStoreReady: Promise<void>
  readonly completedCalls: Map<string, ToolResultAck>
  readonly inFlight: Map<string, AbortController>
  readonly inFlightAcks: Map<string, Array<(result: ToolResultAck) => void>>
}

export function createExecutorSharedExecution(receiptStorePath: string | false): ExecutorSharedExecution {
  const receiptStore = receiptStorePath === false ? null : new ExecutionReceiptStore(receiptStorePath)
  return {
    receiptStore,
    receiptStoreReady: receiptStore?.load() ?? Promise.resolve(),
    completedCalls: new Map(),
    inFlight: new Map(),
    inFlightAcks: new Map(),
  }
}

export type PermanentError = {
  code: 'workspace_id_conflict' | 'workspace_identity_mismatch' | 'version_incompatible' | 'auth_failed'
  message: string
}

export type ExecutorHandle = {
  readonly executorId: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly socket: Socket<
    ExecutorServerToClientEvents,
    ExecutorClientToServerEvents
  >
  readonly ready: Promise<void>
  /**
   * Resolves when the executor decides to give up reconnecting — either the
   * host emitted `executor:host_reject`, a `connect_error` reported an
   * unrecoverable message. Transient transport failures never resolve this;
   * the executor is a daemon and keeps reconnecting until it is explicitly
   * stopped or the host rejects its identity/auth/version.
   * Never resolves during normal operation.
   */
  readonly permanentError: Promise<PermanentError>
  readonly activeToolCount: () => number
  readonly activeTerminalCount: () => number
  readonly draining: () => boolean
  beginDrain(): void
  resume(): void
  close(): Promise<void>
}

function strictRequest(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request must be an object')
  const request = value as Record<string, unknown>
  const unknown = Object.keys(request).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`request contains unknown field: ${unknown}`)
  if (typeof request.requestId !== 'string' || request.requestId.length < 1 || request.requestId.length > 128 || /[\0\r\n]/u.test(request.requestId)) {
    throw new Error('requestId must be a non-empty string of at most 128 characters')
  }
  return request
}

function dashboardServersRequest(value: unknown): DashboardMcpServerConfig[] {
  const request = strictRequest(value, ['requestId', 'servers'])
  return parseDashboardMcpServers(request.servers)
}

export function startExecutor(options: ExecutorOptions): ExecutorHandle {
  const logger = options.logger ?? noopLogger
  const sandboxRoots = options.sandboxRoots ?? []
  const sandbox: Sandbox = createSandbox({ roots: sandboxRoots })
  const tools = createToolRegistry(options.tools ?? defaultTools)
  const executorId = options.executorId ?? ulid()
  const workspaceId = options.workspaceId ?? loadOrCreateWorkspaceId()
  const workspaceName = options.workspaceName ?? hostname()
  const workspaceRoot = sandboxRoots[0] ?? process.cwd()
  const overflowConfig = overflowConfigFromEnv(
    join(workspaceRoot, '.kala', 'overflow'),
  )
  const sharedExecution = options.sharedExecution ?? createExecutorSharedExecution(
    options.receiptStorePath === false ? false : options.receiptStorePath ?? join(workspaceRoot, '.kala', 'execution-receipts.json'),
  )
  const { receiptStore, receiptStoreReady, completedCalls, inFlight, inFlightAcks } = sharedExecution

  const factory = options.ioFactory ?? clientIO
  const socket = factory(`${options.host}/executor`, {
    transports: ['websocket'],
    auth: {
      role: 'executor',
      clientVersion: PROTOCOL_VERSION,
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.invite !== undefined ? { invite: options.invite } : {}),
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 60_000,   // keep recovery bounded while retaining jitter
    reconnectionAttempts: Infinity,
    randomizationFactor: 0.5,       // +/-50% jitter, avoid thundering-herd reconnect
    ...(options.invite || options.routeHint || options.replicaId ? { extraHeaders: { ...(options.invite ? { 'x-kala-executor-invite': options.invite } : {}), ...(options.routeHint ? { 'x-kala-executor-route': options.routeHint } : {}), ...(options.replicaId ? { 'x-kala-executor-replica': options.replicaId } : {}) } } : {})
  }) as Socket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>

  const localInFlight = new Set<string>()
  let drainRequested = false
  // A reconnect or owner handoff can redispatch through a different replica
  // socket. Shared maps coalesce it inside this one Executor process.
  const COMPLETED_CALL_CACHE_MAX = 500
  const receiptKey = (sessionId: string, callId: string): string => `${sessionId}:${callId}`
  const rememberCompleted = (key: string, ack: ToolResultAck): void => {
    completedCalls.set(key, ack)
    while (completedCalls.size > COMPLETED_CALL_CACHE_MAX) {
      const oldest = completedCalls.keys().next().value
      if (oldest === undefined) break
      completedCalls.delete(oldest)
    }
  }

  let mcpDescriptors: readonly McpToolDescriptor[] = []
  let mcpInitialized = false
  const mcpToolNames = new Set<string>()
  const knownMcpToolNames = new Set<string>()
  type AnnounceWithMcp = ExecutorAnnounce & { mcpTools?: McpToolDescriptor[] }
  const createAnnouncement = (): AnnounceWithMcp => ({
    executorId,
    ...(options.installId ? { installId: options.installId } : {}),
    executorVersion: executorReleaseVersion(),
    build: executorBuildInfo(),
    capabilities: executorCapabilities(tools, sandboxRoots),
    workspaceId,
    workspaceName,
    tools: [...tools.keys()],
    toolImplementations: Object.fromEntries([...tools.keys()].map((name) => [name, { version: '1.0.0' }])),
    ...(mcpDescriptors.length > 0 ? { mcpTools: [...mcpDescriptors] } : {}),
    ...(sandboxRoots.length > 0 ? { sandboxRoots: [...sandboxRoots] } : {}),
    defaultCwd: workspaceRoot,
    runtime: 'node',
    runtimeVersion: process.version,
    hostname: hostname(),
    os: normalizeOs(platform()),
    ipAddresses: collectIpAddresses(),
    pid: process.pid,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
  })
  const applyMcpCatalog = (nextTools: readonly Tool[], descriptors: readonly McpToolDescriptor[]): void => {
    for (const name of mcpToolNames) tools.delete(name)
    mcpToolNames.clear()
    for (const tool of nextTools) {
      tools.set(tool.name, tool)
      mcpToolNames.add(tool.name)
      knownMcpToolNames.add(tool.name)
    }
    mcpDescriptors = descriptors
    if (mcpInitialized && socket.connected) socket.emit('executor:announce', createAnnouncement())
  }

  type McpCatalog = { tools: readonly Tool[]; descriptors: readonly McpToolDescriptor[] }
  let activeMcp: McpClientManager
  const allMcpManagers = new Set<McpClientManager>()
  const createMcpManager = (servers: readonly McpServerConfig[], requireAllServers: boolean): { manager: McpClientManager; catalog: () => McpCatalog } => {
    let latest: McpCatalog = { tools: [], descriptors: [] }
    let manager: McpClientManager
    manager = new McpClientManager({
      servers,
      reservedToolNames: new Set([...tools.keys()].filter((name) => !mcpToolNames.has(name))),
      ...(options.mcpInitializeTimeoutMs !== undefined ? { initializeTimeoutMs: options.mcpInitializeTimeoutMs } : {}),
      ...(options.mcpCallTimeoutMs !== undefined ? { callTimeoutMs: options.mcpCallTimeoutMs } : {}),
      ...(requireAllServers ? { requireAllServers: true } : {}),
      logger,
      onCatalogChanged(nextTools, descriptors) {
        latest = { tools: nextTools, descriptors }
        if (manager === activeMcp) applyMcpCatalog(nextTools, descriptors)
      },
    })
    allMcpManagers.add(manager)
    return { manager, catalog: () => latest }
  }
  const initialMcp = createMcpManager(options.mcpServers ?? [], false)
  activeMcp = initialMcp.manager
  const mcpReady = activeMcp.initialize().then(() => { mcpInitialized = true })

  const ready = new Promise<void>((resolve) => {
    socket.on('connect', async () => {
      await mcpReady
      if (!socket.connected) return
      const announcement = createAnnouncement()
      logger.info({ socketId: socket.id, workspaceId, workspaceName, ...(options.installId ? { installId: options.installId } : {}), executorVersion: announcement.executorVersion }, 'socket connected; announcing workspace')
      socket.emit('executor:announce', announcement)
      resolve()
    })
  })

  socket.on('connect_error', (err) => {
    const summary = connectionErrorSummary(err)
    logger.warn(summary, 'host connection failed; retrying')
    logger.debug({ ...summary, diagnostic: compactDiagnostic(err) }, 'host connection failure diagnostic')
  })
  socket.on('disconnect', (reason) => {
    logger.info({ reason }, 'socket disconnected')
    // Interactive terminals cannot be safely resumed after losing their output
    // transport. Close them eagerly so shells do not continue consuming CPU or
    // mutating the workspace invisibly while the dashboard is disconnected.
    terminals.closeAll()
  })
  socket.io.on('reconnect_attempt', (n) => {
    logger.info({ attempt: n }, 'socket reconnect attempt')
  })
  socket.io.on('reconnect_failed', () => {
    logger.warn('socket reconnect attempt budget exhausted unexpectedly; executor will remain alive')
  })

  logger.info({ host: options.host, namespace: '/executor' }, 'dialing host executor namespace')

  // Permanent-error latch. Any handler that discovers we cannot recover
  // resolves this once — the CLI awaits it to exit with a specific code.
  let permanentErrorResolver: ((e: PermanentError) => void) | null = null
  const permanentError = new Promise<PermanentError>((resolve) => {
    permanentErrorResolver = resolve
  })
  const givePermanentError = (e: PermanentError): void => {
    if (permanentErrorResolver) {
      permanentErrorResolver(e)
      permanentErrorResolver = null
    }
    // Kill socket.io's own retry loop; otherwise it will keep dialing on a
    // situation the caller has already decided is unrecoverable.
    socket.disconnect()
  }

  // Host-initiated permanent rejects (workspaceId conflict, wrong version,
  // bad auth). Server emits `executor:host_reject` immediately before it
  // calls `socket.disconnect(true)`, so we route the code + message into
  // the permanent-error latch.
  socket.on('executor:host_reject', (payload) => {
    givePermanentError({ code: payload.code, message: payload.message })
  })

  socket.on('executor:welcome', (payload) => {
    logger.info('welcome from host; token saved, ready for tool calls')
    options.onToken?.(payload.token)
    socket.auth = {
      role: 'executor',
      clientVersion: PROTOCOL_VERSION,
      token: payload.token,
    }
  })

  // Handshake failures (auth, version). These come through connect_error
  // with the error's `.message` being the reason middleware called
  // `next(new Error(reason))` on the host side.
  socket.on('connect_error', (err) => {
    const msg = (err as Error).message || String(err)
    if (msg === 'version_incompatible') {
      givePermanentError({ code: 'version_incompatible', message: msg })
    } else if (msg === 'auth_failed') {
      givePermanentError({ code: 'auth_failed', message: msg })
    }
    // Other connect_errors (network transient, DNS, host down) are
    // recoverable — let socket.io keep retrying.
  })

  socket.on('tool:call', async (payload: ToolCallMessage, ack) => {
    const internal = payload.name.startsWith('__')
    // Internal control-plane reads must never depend on a writable workspace
    // receipt directory. Agent tools keep the durable exactly-once barrier.
    if (!internal) await receiptStoreReady
    const key = receiptKey(payload.sessionId, payload.callId)
    const cached = completedCalls.get(key) ?? (!internal ? receiptStore?.get(key) : undefined)
    if (cached) {
      logger.debug({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name }, 'tool result served from execution cache')
      ack(cached)
      return
    }
    if (drainRequested) {
      logger.warn({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name }, 'tool rejected while Executor is draining')
      ack({ callId: payload.callId, ok: false, content: 'ERROR: EBUSY: executor is draining for a managed update; retry after reconnect' })
      return
    }
    if (inFlight.has(key)) {
      const waiters = inFlightAcks.get(key) ?? []
      waiters.push(ack)
      inFlightAcks.set(key, waiters)
      return
    }

    const controller = new AbortController()
    inFlight.set(key, controller)
    localInFlight.add(key)
    inFlightAcks.set(key, [ack])
    const started = performance.now()
    logger.info({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name, internal, ...(!knownMcpToolNames.has(payload.name) ? { input: safeToolInput(payload.input) } : {}), ...(payload.cwd ? { cwd: payload.cwd } : {}) }, 'tool execution started')
    const rawResult = await runOne(tools, sandbox, controller.signal, payload, overflowConfig, options.networkPolicy, async (event) => {
      await new Promise<void>((resolve, reject) => socket.timeout(5_000).emit('executor:network_audit', event, (error, result) => error || !result?.accepted ? reject(error ?? new Error('network audit rejected')) : resolve()))
    })
    const result = { ...rawResult, durationMs: Math.max(0, Math.round(performance.now() - started)) }
    let replyResult = result
    try {
      if (!internal) await receiptStore?.set(key, result)
      rememberCompleted(key, result)
    } catch (error) {
      logger.warn({ err: error, sessionId: payload.sessionId, callId: payload.callId, tool: payload.name, durationMs: result.durationMs }, 'tool result durability failed; returning an explicit failure instead of timing out')
      replyResult = {
        callId: payload.callId,
        ok: false,
        content: `ERROR: EDURABILITY: tool completed but its execution receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: result.durationMs,
      }
      rememberCompleted(key, replyResult)
    } finally {
      inFlight.delete(key)
      localInFlight.delete(key)
      const waiters = inFlightAcks.get(key) ?? []
      inFlightAcks.delete(key)
      logger.info({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name, internal, ok: replyResult.ok, durationMs: result.durationMs, resultBytes: Buffer.byteLength(replyResult.content, 'utf8') }, 'tool execution completed')
      for (const reply of waiters) reply(replyResult)
    }
  })

  socket.on('tool:cancel', (payload: ToolCancelMessage) => {
    const ctrl = inFlight.get(receiptKey(payload.sessionId, payload.callId))
    logger.info({ sessionId: payload.sessionId, callId: payload.callId, found: Boolean(ctrl) }, 'tool cancellation requested')
    if (ctrl) ctrl.abort()
  })

  socket.on('executor:health_ping', (_sentAt, ack) => ack(Date.now()))

  const managedMcp = options.managedMcpConfig
  const dashboardMcpAllowed = Boolean(
    managedMcp &&
    managedMcp.installationSource === 'dashboard-native' &&
    managedMcp.configurationSource === 'managed-config' &&
    managedMcp.installationId.length > 0 &&
    managedMcp.installationId === options.installId &&
    managedMcp.path.length > 0,
  )
  let mcpConfigQueue: Promise<void> = Promise.resolve()
  let executorClosing = false
  const serializedMcpConfig = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mcpConfigQueue.then(operation, operation)
    mcpConfigQueue = result.then(() => undefined, () => undefined)
    return result
  }

  socket.on('executor:mcp_config_status', (payload, ack) => {
    void serializedMcpConfig(async () => {
      if (!dashboardMcpAllowed || !managedMcp || executorClosing) {
        ack({ ok: false, error: 'Dashboard MCP configuration is unavailable for this Executor' })
        return
      }
      try {
        strictRequest(payload, ['requestId'])
        const servers = readDashboardMcpServers(managedMcp.path)
        ack({ ok: true, servers: servers.map(({ name }) => ({ name })) })
      } catch {
        ack({ ok: false, error: 'managed Executor MCP config is invalid or unsafe' })
      }
    })
  })

  socket.on('executor:mcp_configure', (payload, ack) => {
    void serializedMcpConfig(async () => {
      if (!dashboardMcpAllowed || !managedMcp || executorClosing) {
        ack({ ok: false, error: 'Dashboard MCP configuration is unavailable for this Executor' })
        return
      }

      let servers: DashboardMcpServerConfig[]
      try {
        servers = dashboardServersRequest(payload)
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : 'invalid Dashboard MCP config' })
        return
      }

      const candidate = createMcpManager(servers, true)
      let initializationTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          candidate.manager.initialize(),
          new Promise<never>((_resolve, reject) => {
            initializationTimer = setTimeout(() => reject(new Error('MCP initialization deadline exceeded')), 30_000)
          }),
        ])
      } catch {
        allMcpManagers.delete(candidate.manager)
        await candidate.manager.close()
        ack({ ok: false, error: 'one or more MCP servers could not be initialized' })
        return
      } finally {
        if (initializationTimer) clearTimeout(initializationTimer)
      }

      try {
        writeDashboardMcpServers(managedMcp.path, servers)
      } catch {
        allMcpManagers.delete(candidate.manager)
        await candidate.manager.close()
        ack({ ok: false, error: 'managed Executor MCP config could not be persisted safely' })
        return
      }

      const retired = activeMcp
      activeMcp = candidate.manager
      const catalog = candidate.catalog()
      applyMcpCatalog(catalog.tools, catalog.descriptors)
      void retired.closeWhenIdle().finally(() => allMcpManagers.delete(retired))
      ack({ ok: true })
    })
  })

  const terminals = createTerminalManager({
    sandbox,
    emitOutput(payload) {
      socket.emit('executor:terminal_output', payload)
    },
    emitExit(payload) {
      socket.emit('executor:terminal_exit', payload)
    },
  })

  socket.on('terminal:create', async (payload, ack) => {
    if (process.env.KALA_TERMINAL_DIAGNOSTICS === '1') logger.info('terminal create event received')
    if (payload.workspaceId !== workspaceId) {
      ack({ requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'workspace mismatch' })
      return
    }
    const result = await terminals.create(payload)
    if (process.env.KALA_TERMINAL_DIAGNOSTICS === '1') logger.info({ ok: Boolean(result.terminalId) }, 'terminal create event completed')
    ack(result)
  })

  socket.on('terminal:input', (payload) => {
    if (payload.workspaceId === workspaceId) terminals.input(payload)
  })

  socket.on('terminal:resize', (payload) => {
    if (payload.workspaceId === workspaceId) terminals.resize(payload)
  })

  socket.on('terminal:kill', (payload, ack) => {
    if (payload.workspaceId !== workspaceId) {
      ack({ requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'workspace mismatch' })
      return
    }
    ack(terminals.kill(payload))
  })

  socket.on('terminal:close_session', (payload) => {
    if (payload.workspaceId === workspaceId) terminals.closeSession(payload)
  })

  // Host-internal filesystem/background RPCs also arrive as ordinary
  // `tool:call` messages. The executor executes tools only; the host decides
  // whether the result enters the agent transcript or returns to a dashboard RPC.

  const unsubscribeBg = subscribeBackgroundTasks((change) => {
    if (change.kind === 'evicted') {
      socket.emit('executor:bg_task_evicted', {
        workspaceId,
        sessionId: change.sessionId,
        taskId: change.taskId,
      })
      return
    }
    socket.emit('executor:bg_task_updated', {
      workspaceId,
      sessionId: change.task.sessionId,
      task: change.task,
      ...(change.kind === 'output' ? { delta: change.delta } : {}),
    })
  })

  return {
    executorId,
    workspaceId,
    workspaceName,
    socket,
    ready,
    permanentError,
    activeToolCount: () => inFlight.size,
    activeTerminalCount: () => terminals.activeCount(),
    draining: () => drainRequested,
    beginDrain() { drainRequested = true },
    resume() { drainRequested = false },
    async close() {
      executorClosing = true
      unsubscribeBg()
      terminals.closeAll()
      for (const key of localInFlight) {
        inFlight.get(key)?.abort()
        inFlight.delete(key)
      }
      localInFlight.clear()
      socket.disconnect()
      await mcpConfigQueue
      await Promise.allSettled([...allMcpManagers].map((manager) => manager.close()))
      allMcpManagers.clear()
    },
  }
}

function executorCapabilities(tools: ReadonlyMap<string, Tool>, sandboxRoots: readonly string[]): ExecutorAnnounce['capabilities'] {
  return {
    schemaVersion: 1,
    features: {
      backgroundShell: tools.has('bash_output') && tools.has('kill_shell'),
      filePicker: tools.has('__fs_list_dirs') && tools.has('__fs_list_files') && tools.has('__workspace_read_binary'),
      overflowFiles: tools.has('__fs_read_overflow'),
      workspaceSandbox: sandboxRoots.length > 0,
    },
  }
}

function executorBuildInfo(): BuildMetadata {
  const globalValue = (globalThis as typeof globalThis & {
    __KALA_BUILD_INFO__?: unknown
  }).__KALA_BUILD_INFO__
  return parseBuildInfo(globalValue) ?? {
    releaseTag: process.env.KALA_RELEASE_TAG ?? 'local',
    productVersion: executorReleaseVersion(),
    gitCommit: process.env.KALA_GIT_COMMIT ?? 'unknown',
    builtAt: process.env.KALA_BUILT_AT ?? 'unknown',
    artifactKind: 'source',
    dashboardMode: 'none',
  }
}

function parseBuildInfo(value: unknown): BuildMetadata | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const artifactKind = record.artifactKind
  const dashboardMode = record.dashboardMode
  if (artifactKind !== 'source' && artifactKind !== 'cjs' && artifactKind !== 'native') return null
  if (dashboardMode !== 'vite' && dashboardMode !== 'static' && dashboardMode !== 'embedded' && dashboardMode !== 'none') return null
  return {
    releaseTag: typeof record.releaseTag === 'string' ? record.releaseTag : 'unknown',
    ...(typeof record.productVersion === 'string' ? { productVersion: record.productVersion } : {}),
    gitCommit: typeof record.gitCommit === 'string' ? record.gitCommit : 'unknown',
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : 'unknown',
    artifactKind,
    dashboardMode,
    ...(typeof record.embeddedDashboardFiles === 'number' ? { embeddedDashboardFiles: record.embeddedDashboardFiles } : {}),
  }
}

const OVERFLOW_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'memory',
  'bash_output',
])

async function runOne(
  tools: Map<string, Tool>,
  sandbox: Sandbox,
  signal: AbortSignal,
  payload: ToolCallMessage,
  overflowConfig: OverflowConfig,
  networkPolicy?: import('@agent-kernel/shared').NetworkPolicy,
  emitNetworkAudit?: (event: import('@agent-kernel/shared').NetworkAuditEvent) => Promise<void>,
): Promise<ToolResultAck> {
  const tool = tools.get(payload.name)
  if (!tool) {
    return {
      callId: payload.callId,
      ok: false,
      content: `ERROR: EINVAL: unknown tool: ${payload.name}`,
    }
  }
  try {
    const content = await tool.run(payload.input, {
      sessionId: payload.sessionId,
      callId: payload.callId,
      sandbox,
      signal,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      ...(networkPolicy ? { networkPolicy } : {}),
      ...(emitNetworkAudit ? { emitNetworkAudit } : {}),
    })
    if (OVERFLOW_EXEMPT_TOOLS.has(payload.name) || payload.name.startsWith('__')) {
      return { callId: payload.callId, ok: true, content }
    }
    const overflow = await maybeOverflow(content, {
      sessionId: payload.sessionId,
      callId: payload.callId,
      config: overflowConfig,
    })
    return { callId: payload.callId, ok: true, content: overflow.content }
  } catch (err) {
    if (err instanceof ToolError) {
      return {
        callId: payload.callId,
        ok: false,
        content: `ERROR: ${err.message}`,
        failure: failureForToolError(err.code),
      }
    }
    return {
      callId: payload.callId,
      ok: false,
      content: `ERROR: EIO: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
