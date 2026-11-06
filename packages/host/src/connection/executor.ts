/**
 * Executor connection tracking + tool dispatch bridge.
 *
 * An executor is a daemon: it announces once (with a stable `workspaceId`),
 * then serves `tool:call`s for any session the host routes to it. The
 * registry maps `executorId → Bind`, with per-session pending call lists
 * inside each Bind (so cancel/redispatch can iterate one session at a time
 * without touching unrelated sessions).
 *
 * Routing: each session carries a `workspaceId` (set at create time from the
 * "New" flow, see ADR 0014). `callTool` matches that workspaceId against a
 * live executor's announced workspaceId. If none is attached, the call fails
 * loudly — sessions do not "fall over" to a different machine. Sessions
 * predating the workspaceId field pass undefined and get the first available
 * executor as a legacy fallback.
 */

import type { Server, Socket } from 'socket.io'
import { createTerminalRequestManager, TERMINAL_CREATE_ACK_TIMEOUT_MS, APP_DEBUG_ACK_MS, appDebugFailure, appDebugWait } from '@agent-kernel/shared'
import type { AppDebugTarget } from './app-debug.js'

import type {
  CallToolEffect,
} from '@agent-kernel/kernel'
import type {
  WorkspaceExecRequest,
  WorkspaceExecResponse,
  WorkspaceReadBinaryRequest,
  WorkspaceReadBinaryResponse,
} from '@agent-kernel/shared/workspace-exec'
import type {
  AttachedExecutor,
  BgKillResult,
  BgListResult,
  BgOutputResult,
  ClientKillBgTask,
  ClientListBgTasks,
  ClientListDirs,
  ClientListFiles,
  ClientReadBgOutput,
  ClientReadOverflow,
  ClientTerminalCloseSession,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  CopyOverflowSession,
  CopyOverflowSessionResult,
  CreateDirectoryResult,
  DeleteOverflowSession,
  DeleteOverflowSessionResult,
  DirListResult,
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorMcpConfigStatusAck,
  ExecutorMcpConfigureAck,
  ExecutorMcpConfigureRequest,
  ExecutorServerToClientEvents,
  FileListResult,
  OverflowContentsResult,
  ServerExecutorChangedPayload,
  TerminalCreateResult,
  TerminalKillResult,
  ToolResultAck,
  ComputerRequest,
  ComputerResponse,
} from '@agent-kernel/shared'

import type { ToolDispatcher } from '../loop.js'
import type { AuditLogger } from '../audit-log.js'
import { isUnavailableMcpTool } from '../mcp-tools.js'

export const DEFAULT_TOOL_ACK_TIMEOUT_MS = 60_000
export const TERMINAL_ACK_TIMEOUT_MS = 5_000
// Executor bounds a candidate configuration to 30 seconds; allow transport and cleanup slack.
export const MCP_MANAGEMENT_ACK_TIMEOUT_MS = 45_000

/**
 * How long to hold a detached executor's pending calls and its "attached"
 * state visible to dashboards, waiting for the process to reconnect with the
 * same workspaceId. Covers routine executor restarts (systemd/tmux respawn,
 * user Ctrl+C+re-run, transient socket drops) so in-flight tool calls survive
 * and the UI doesn't flicker offline.
 */
export const DETACH_GRACE_MS = 5_000
export const PLANNED_CONTINUATION_EXECUTOR_WAIT_MS = 30_000

type Pending = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
  resolve: (result: { ok: boolean; content: string; failure?: import('@agent-kernel/kernel').ToolFailure }) => void
  timer: NodeJS.Timeout
  deadlineAt: number
}

export type ExecutorChangeListener = (change: ServerExecutorChangedPayload) => void

/**
 * Lets the registry look up a session's target workspace without a store
 * dependency. Wired at registry-construction time from server.ts, backed by
 * `SessionStore.get(sessionId)?.workspaceId`.
 */
export type WorkspaceResolver = {
  workspaceIdFor(sessionId: string): string | undefined
  desktopManualAuthorizationRequired?(sessionId: string): boolean
  desktopFeaturePolicy?(sessionId: string): { computerUseEnabled: boolean; desktopPreviewEnabled: boolean }
  assertSessionEffectOwner?(sessionId: string): Promise<void | { ownerGeneration: string }>
  /** Session-snapshotted MCP input schema; never substitute a new same-name tool. */
  mcpSchemaHashFor?(sessionId: string, toolName: string): string | undefined
}

type PublishLocalImageRequest = { requestId: string; path: string; cwd?: string }
type PublishLocalImageResponse = { requestId: string; path: string; base64?: string; mediaType?: string; size?: number; error?: string }

export type ExecutorLookup = {
  updateDesktopFeaturePolicy?(sessionId: string): Promise<void>
  computerRequest(payload: ComputerRequest, owner: string): Promise<ComputerResponse>
  executorForSession(sessionId: string): AttachedExecutor | undefined
  listDirs(workspaceId: string, path: string | undefined, requestId: string): Promise<DirListResult>
  createDirectory(workspaceId: string, parentPath: string, name: string, requestId: string): Promise<CreateDirectoryResult>
  listFiles(payload: ClientListFiles): Promise<FileListResult>
  readOverflow(payload: ClientReadOverflow, workspaceId: string): Promise<OverflowContentsResult>
  copyOverflowSession(workspaceId: string, sourceSessionId: string, targetSessionId: string): Promise<CopyOverflowSessionResult>
  deleteOverflowSession(workspaceId: string, sessionId: string): Promise<DeleteOverflowSessionResult>
  listBg(payload: ClientListBgTasks): Promise<BgListResult>
  readBg(payload: ClientReadBgOutput): Promise<BgOutputResult>
  killBg(payload: ClientKillBgTask): Promise<BgKillResult>
  createTerminal(payload: ClientTerminalCreate, signal?: AbortSignal): Promise<TerminalCreateResult>
  inputTerminal(payload: ClientTerminalInput): void
  resizeTerminal(payload: ClientTerminalResize): void
  killTerminal(payload: ClientTerminalKill): Promise<TerminalKillResult>
  closeSessionTerminals(payload: ClientTerminalCloseSession): void
  workspaceExec(payload: WorkspaceExecRequest): Promise<WorkspaceExecResponse>
  workspaceReadBinary(payload: WorkspaceReadBinaryRequest): Promise<WorkspaceReadBinaryResponse>
  publishLocalImage(payload: PublishLocalImageRequest & { workspaceId: string }): Promise<PublishLocalImageResponse>
}

type ExecutorInvalidationReason = 'credential_revoked' | 'identity_authority_unavailable'

export type ExecutorRegistry = ToolDispatcher & ExecutorLookup & {
  appDebugTarget(workspaceId: string): AppDebugTarget | undefined
  attach(
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
    announcement: ExecutorAnnounce,
    clientVersion?: string,
  ): void
  detach(
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
  ): void
  /** Immediately evict one unauthorized socket without reconnect grace. */
  revoke(
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
    reason?: ExecutorInvalidationReason,
  ): void
  activeSessions(): string[]
  snapshot(): AttachedExecutor[]
  hasTrustedManagedExecutor(workspaceId: string, installId: string): boolean
  hasTrustedWorkspaceExecutor(workspaceId: string, executorId: string): boolean
  measureLatency(workspaceId: string): Promise<{ rttMs?: number; error?: string }>
  mcpConfigStatus(workspaceId: string, target: ExecutorMcpTarget, requestId: string): Promise<ExecutorMcpConfigStatusAck>
  configureMcp(workspaceId: string, target: ExecutorMcpTarget, payload: ExecutorMcpConfigureRequest): Promise<ExecutorMcpConfigureAck>
  renameWorkspace(workspaceId: string, workspaceName: string): AttachedExecutor | undefined
  onChange(listener: ExecutorChangeListener): () => void
  /** Wait at a planned pre-dispatch checkpoint until its bound Executor is online. */
  waitForSessionExecutor(sessionId: string, timeoutMs?: number): Promise<boolean>
}

export type ExecutorMcpTarget = string | { executorId: string }

export function createExecutorRegistry(
  _io: Server,
  resolver: WorkspaceResolver,
  toolAckTimeoutMs = DEFAULT_TOOL_ACK_TIMEOUT_MS,
  audit?: AuditLogger,
  detachGraceMs = DETACH_GRACE_MS,
  authorizeSocket?: (
    socket: Socket<ExecutorClientToServerEvents, ExecutorServerToClientEvents>,
  ) => Promise<boolean>,
): ExecutorRegistry {
  type Bind = {
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >
    announcement: ExecutorAnnounce
    attachedAt: string
    clientVersion?: string
    /** Serialized [sessionId, callId] to pending call. */
    pending: Map<string, Pending>
  }
  const byExecutor = new Map<string, Bind>()
  const terminalCreates = new WeakMap<Bind, ReturnType<typeof createTerminalRequestManager>>()
  const terminalQueues = new WeakMap<Bind, Promise<void>>()
  const socketToExecutor = new Map<string, string>()
  const listeners = new Set<ExecutorChangeListener>()
  // Retain names after removal so active Session snapshots fail before dispatch.
  // This is process-local by design; after a Host restart an unknown stale call
  // still goes only to its bound workspace Executor, which rejects it.
  const knownMcpToolNames = new Set<string>()
  type ExecutorWaiter = { resolve(online: boolean): void; timer: NodeJS.Timeout }
  const executorWaiters = new Map<string, Set<ExecutorWaiter>>()

  /**
   * Workspaces whose executor socket just went away but where we're still
   * within the grace window. Pending calls are kept in `bind.pending` so a
   * fast reconnect can pick them up via `redispatchPending`. Keyed by
   * workspaceId so a restarted process with a fresh executorId can find its
   * predecessor.
   */
  type Detaching = { bind: Bind; timer: NodeJS.Timeout }
  const detaching = new Map<string, Detaching>()

  function emitChange(change: ServerExecutorChangedPayload): void {
    for (const l of listeners) l(change)
  }

  function resolveExecutorWaiters(workspaceId: string): void {
    for (const key of [workspaceId, '*']) {
      const waiters = executorWaiters.get(key)
      if (!waiters) continue
      executorWaiters.delete(key)
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(true)
      }
    }
  }

  function toAttached(bind: Bind): AttachedExecutor {
    const out: AttachedExecutor = {
      ...bind.announcement,
      attachedAt: bind.attachedAt,
    }
    if (bind.clientVersion !== undefined) out.clientVersion = bind.clientVersion
    return out
  }

  function synthesizeFailure(bind: Bind, reason: string): void {
    for (const p of bind.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, content: reason })
    }
    bind.pending.clear()
  }

  function synthesizeRevocation(bind: Bind, reason: ExecutorInvalidationReason): void {
    for (const p of bind.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({
        ok: false,
        content: reason === 'credential_revoked'
          ? 'executor credential revoked while tool call outcome was unknown'
          : 'executor identity authority unavailable while tool call outcome was unknown',
        failure: { code: reason === 'credential_revoked' ? 'executor_credential_revoked' : 'executor_identity_unavailable', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system' },
      })
    }
    bind.pending.clear()
  }

  function isCurrent(bind: Bind): boolean {
    return byExecutor.get(bind.announcement.executorId) === bind && bind.socket.connected
  }

  /** Keep the no-validator path synchronous for portable callers and existing ordering. */
  function authorizeCurrent(bind: Bind): boolean | Promise<boolean> {
    if (!isCurrent(bind)) return false
    if (!authorizeSocket) return true
    return authorizeSocket(bind.socket).then(
      (authorized) => authorized && isCurrent(bind),
      () => false,
    )
  }

  function enqueueTerminal<T>(bind: Bind, operation: () => T | Promise<T>): Promise<T> {
    const previous = terminalQueues.get(bind) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    terminalQueues.set(bind, current.then(() => undefined, () => undefined))
    return current
  }

  function runTerminalOperation<T>(bind: Bind, onDenied: () => T, operation: () => T): T | Promise<T> {
    if (!authorizeSocket) return isCurrent(bind) ? operation() : onDenied()
    return enqueueTerminal(bind, async () => await authorizeCurrent(bind) ? operation() : onDenied())
  }

  function ignoreAsync(result: unknown): void {
    if (result instanceof Promise) void result.catch(() => {})
  }

  /**
   * Move outstanding pending calls from the old bind to the new one and
   * re-emit `tool:call` over the fresh socket. Timers are recreated so the
   * timeout window restarts from the reconnect.
   *
   * Session identity is baked into each Pending, so the new socket gets the
   * same sessionId in the payload — the daemon doesn't know or care which
   * session moved.
   */
  function redispatchPending(oldBind: Bind, newBind: Bind): void {
    for (const p of oldBind.pending.values()) {
      const key = JSON.stringify([p.sessionId, p.callId])
      clearTimeout(p.timer)
      if (isUnavailableMcpTool(newBind.announcement, p.name, knownMcpToolNames, resolver.mcpSchemaHashFor?.(p.sessionId, p.name))) {
        p.resolve({
          ok: false,
          content: `MCP tool ${p.name} is no longer available in this workspace`,
          failure: { code: 'mcp_tool_unavailable', category: 'precondition', outcome: 'blocked', retryable: true, responsibility: 'workspace' },
        })
        continue
      }
      const ackTimeoutMs = ackTimeoutMsFor(p.name, p.input, toolAckTimeoutMs)
      // Preserve the original absolute deadline. A reconnect must not grant a
      // fresh timeout window; repeated network flaps would otherwise keep an
      // orphaned tool call pending forever.
      const remainingMs = Math.max(0, p.deadlineAt - Date.now())
      const timer = setTimeout(() => {
        if (newBind.pending.delete(key)) {
          p.resolve({
            ok: false,
            content: `tool call ack timed out after ${ackTimeoutMs}ms (post-reconnect); execution outcome is unknown. Inspect current state before retrying; do not blindly repeat side effects.`,
            failure: { code: 'tool_ack_timeout', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system', timeoutStage: 'acknowledgement' },
          })
        }
      }, remainingMs)
      newBind.pending.set(key, {
        sessionId: p.sessionId,
        callId: p.callId,
        name: p.name,
        input: p.input,
        ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
        resolve: p.resolve,
        timer,
        deadlineAt: p.deadlineAt,
      })
      let ownerGeneration: string | undefined
      const emit = (authorized: boolean): void => {
        const pending = newBind.pending.get(key)
        if (!pending) return
        const desktopManualAuthorizationRequired = p.name === 'computer_use'
          ? resolver.desktopManualAuthorizationRequired?.(p.sessionId) ?? true : undefined
        const features = p.name === 'computer_use' ? resolver.desktopFeaturePolicy?.(p.sessionId) : undefined
        const desktopUpdateRequired = (desktopManualAuthorizationRequired === false && newBind.announcement.computerUsePolicyVersion !== 1) ||
          (features !== undefined && newBind.announcement.computerUseFeaturePolicyVersion !== 1)
        if (!authorized || desktopUpdateRequired || features?.computerUseEnabled === false) {
          clearTimeout(pending.timer)
          newBind.pending.delete(key)
          pending.resolve({
            ok: false,
            content: desktopUpdateRequired
              ? 'Update this Executor for automatic desktop authorization before continuing; previous desktop operation outcome is unknown'
              : 'executor unavailable before reconnect dispatch; previous outcome unknown',
            failure: { code: 'executor_reconnect_unavailable', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system' },
          })
          return
        }
        newBind.socket.emit(
          'tool:call',
          {
            ...(features && newBind.announcement.computerUseFeaturePolicyVersion === 1
              ? { desktopComputerUseEnabled: features.computerUseEnabled, desktopPreviewEnabled: features.desktopPreviewEnabled } : {}),
            ...(desktopManualAuthorizationRequired !== undefined ? { desktopManualAuthorizationRequired } : {}),
            sessionId: p.sessionId,
            callId: p.callId,
            name: p.name,
            input: p.input,
            ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
            ackTimeoutMs,
            ...(ownerGeneration !== undefined ? { ownerGeneration } : {}),
          },
          (ack: ToolResultAck) => {
            if (ack.callId !== p.callId) return
            const acknowledged = newBind.pending.get(key)
            if (!acknowledged) return
            clearTimeout(acknowledged.timer)
            newBind.pending.delete(key)
            acknowledged.resolve({ ok: ack.ok, content: ack.content, ...(ack.failure ? { failure: ack.failure } : {}) })
          },
        )
      }
      const authorization = authorizeCurrent(newBind)
      if (resolver.assertSessionEffectOwner) {
        void Promise.resolve(authorization).then(async (authorized) => {
          if (!authorized) return false
          const owner = await resolver.assertSessionEffectOwner!(p.sessionId)
          ownerGeneration = owner?.ownerGeneration
          return isCurrent(newBind)
        }).then(emit, () => emit(false))
      } else if (typeof authorization === 'boolean') emit(authorization)
      else void authorization.then(emit)
    }
    oldBind.pending.clear()
  }

  function findBindByWorkspace(workspaceId: string): Bind | undefined {
    for (const bind of byExecutor.values()) {
      if (bind.announcement.workspaceId === workspaceId) return bind
    }
    return undefined
  }

  function findManagedBind(workspaceId: string, installId: string): Bind | undefined {
    const bind = findBindByWorkspace(workspaceId)
    if (bind?.announcement.installId !== installId) return undefined
    const identity = bind.socket.data.executorIdentity as { workspaceId?: unknown; installId?: unknown } | undefined
    return identity?.workspaceId === workspaceId && identity.installId === installId ? bind : undefined
  }

  function findMcpBind(workspaceId: string, target: ExecutorMcpTarget): Bind | undefined {
    if (typeof target === 'string') return findManagedBind(workspaceId, target)
    if (!authorizeSocket) return undefined
    const bind = findBindByWorkspace(workspaceId)
    const identity = bind?.socket.data.executorIdentity as { accepted?: unknown; workspaceId?: unknown } | undefined
    return bind?.announcement.executorId === target.executorId && identity?.accepted === true && identity.workspaceId === workspaceId ? bind : undefined
  }

  function allPendingBinds(): Iterable<Bind> {
    return (function* () {
      yield* byExecutor.values()
      for (const entry of detaching.values()) yield entry.bind
    })()
  }

  function defaultDirList(
    requestId: string,
    workspaceId: string,
    path: string | undefined,
    error: string,
  ): DirListResult {
    return {
      requestId,
      workspaceId,
      path: path ?? '',
      roots: [],
      entries: [],
      error,
    }
  }

  /**
   * Sessions predating the workspaceId field carry no target. Route them to
   * whichever executor is online. Kept only for legacy JSONL headers — new
   * sessions always have `workspaceId` set at create time.
   */
  function pickAnyBind(): Bind | undefined {
    return byExecutor.values().next().value as Bind | undefined
  }

  function pickBindFor(sessionId: string):
    | { ok: true; bind: Bind }
    | { ok: false; reason: string } {
    const targetWorkspace = resolver.workspaceIdFor(sessionId)
    if (targetWorkspace === undefined) {
      const any = pickAnyBind()
      if (!any) return { ok: false, reason: 'no executor connected' }
      return { ok: true, bind: any }
    }
    const bind = findBindByWorkspace(targetWorkspace)
    if (!bind)
      return {
        ok: false,
        reason: `workspace ${targetWorkspace} is offline — start its executor to run tools`,
      }
    return { ok: true, bind }
  }

  /**
   * Host-initiated internal tool RPC. Sent as an ordinary `tool:call`; the
   * executor runs the tool identically to a kernel-initiated call, while host
   * keeps the result out of the kernel FSM and returns it to the caller.
   */
  async function callInternalTool<T>(
    bind: Bind,
    workspaceId: string,
    name: string,
    input: Record<string, unknown>,
    onError: (msg: string) => T,
  ): Promise<T> {
    const authorization = authorizeCurrent(bind)
    const authorized = typeof authorization === 'boolean' ? authorization : await authorization
    if (!authorized) return onError(`${name} unavailable`)
    return new Promise<T>((resolve) => {
      const callId = `direct-${Math.random().toString(36).slice(2, 10)}`
      const timer = setTimeout(() => {
        resolve(onError(`${name} ack timed out after ${toolAckTimeoutMs}ms`))
        audit?.log({ action: 'internal_tool.result', actor: { kind: 'system' }, target: { workspaceId, callId, toolName: name }, outcome: 'error', error: 'timeout' })
      }, toolAckTimeoutMs)
      // sessionId here is a routing convenience for executor-side overflow
      // paths and audit correlation. It never mutates a real session.
      bind.socket.emit(
        'tool:call',
        {
          origin: 'host',
          sessionId: `__internal:${workspaceId}`,
          callId,
          name,
          input,
          ackTimeoutMs: toolAckTimeoutMs,
        },
        (ack: ToolResultAck) => {
          clearTimeout(timer)
          audit?.log({ action: 'internal_tool.result', actor: { kind: 'system' }, target: { workspaceId, callId, toolName: name }, outcome: ack.ok ? 'ok' : 'error', metadata: { contentBytes: Buffer.byteLength(ack.content, 'utf8') }, ...(ack.ok ? {} : { error: ack.content.slice(0, 200) }) })
          if (!ack.ok) {
            resolve(onError(ack.content || `${name} failed`))
            return
          }
          try {
            resolve(JSON.parse(ack.content) as T)
          } catch (err) {
            resolve(
              onError(
                `${name} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
          }
        },
      )
    })
  }

  async function emitMcpManagement<T>(
    bind: Bind,
    event: 'executor:mcp_configure' | 'executor:mcp_config_status',
    payload: ExecutorMcpConfigureRequest | { requestId: string },
    onUnavailable: () => T,
  ): Promise<T> {
    const authorization = authorizeCurrent(bind)
    const authorized = typeof authorization === 'boolean' ? authorization : await authorization
    if (!authorized) return onUnavailable()
    return new Promise<T>((resolve) => {
      let settled = false
      const finish = (value: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(onUnavailable()), MCP_MANAGEMENT_ACK_TIMEOUT_MS)
      const ack = (result: ExecutorMcpConfigureAck | ExecutorMcpConfigStatusAck): void => {
        const current = byExecutor.get(bind.announcement.executorId)
        if (current !== bind || !bind.socket.connected) {
          finish(onUnavailable())
          return
        }
        finish(result as T)
      }
      if (event === 'executor:mcp_configure') {
        bind.socket.emit(event, payload as ExecutorMcpConfigureRequest, ack)
      } else {
        bind.socket.emit(event, payload as { requestId: string }, ack)
      }
    })
  }

  return {
    hasTrustedManagedExecutor(workspaceId, installId) {
      return findManagedBind(workspaceId, installId) !== undefined
    },
    hasTrustedWorkspaceExecutor(workspaceId, executorId) {
      return findMcpBind(workspaceId, { executorId }) !== undefined
    },
    async measureLatency(workspaceId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) return { error: 'workspace offline' }
      const authorization = authorizeCurrent(bind)
      const authorized = typeof authorization === 'boolean' ? authorization : await authorization
      if (!authorized) return { error: 'workspace offline' }
      return await new Promise((resolve) => {
        const started = performance.now()
        let settled = false
        const timer = setTimeout(() => { settled = true; resolve({ error: 'no response' }) }, 3_000)
        bind.socket.emit('executor:health_ping', Date.now(), () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ rttMs: Math.max(0, Math.round(performance.now() - started)) })
        })
      })
    },
    async mcpConfigStatus(workspaceId, target, requestId) {
      const bind = findMcpBind(workspaceId, target)
      if (!bind) return { ok: false, error: 'managed executor offline' }
      return await emitMcpManagement<ExecutorMcpConfigStatusAck>(
        bind,
        'executor:mcp_config_status',
        { requestId },
        () => ({ ok: false, error: 'managed executor unavailable' }),
      )
    },
    async configureMcp(workspaceId, target, payload) {
      const bind = findMcpBind(workspaceId, target)
      if (!bind) return { ok: false, error: 'managed executor offline' }
      return await emitMcpManagement<ExecutorMcpConfigureAck>(
        bind,
        'executor:mcp_configure',
        payload,
        () => ({ ok: false, error: 'managed executor unavailable' }),
      )
    },
    attach(socket, announcement, clientVersion) {
      const executorId = announcement.executorId
      const workspaceId = announcement.workspaceId
      for (const tool of announcement.mcpTools ?? []) knownMcpToolNames.add(tool.name)
      const newBind: Bind = {
        socket,
        announcement,
        attachedAt: new Date().toISOString(),
        pending: new Map(),
        ...(clientVersion !== undefined ? { clientVersion } : {}),
      }

      // Case 1: same executorId already attached → normal reconnect. Preserve
      // outstanding calls and swap in the new socket. This is the path
      // triggered when a single executor process restarts or its socket
      // briefly disconnects.
      const existingSame = byExecutor.get(executorId)
      if (existingSame) {
        socketToExecutor.delete(existingSame.socket.id)
        byExecutor.set(executorId, newBind)
        socketToExecutor.set(socket.id, executorId)
        redispatchPending(existingSame, newBind)
        emitChange({
          change: 'updated',
          executorId,
          executor: toAttached(newBind),
        })
        resolveExecutorWaiters(workspaceId)
        return
      }

      // Case 1b: an earlier bind for this workspaceId is inside the detach
      // grace window (process restarted with a fresh executorId, or the
      // socket dropped and reconnected before the timer fired). Cancel the
      // pending detach, move any in-flight pending calls to the new bind,
      // and surface the swap as `updated` — the dashboard never sees a
      // detach flicker.
      const pendingDetach = detaching.get(workspaceId)
      if (pendingDetach) {
        clearTimeout(pendingDetach.timer)
        detaching.delete(workspaceId)
        byExecutor.set(executorId, newBind)
        socketToExecutor.set(socket.id, executorId)
        redispatchPending(pendingDetach.bind, newBind)
        emitChange({
          change: 'updated',
          executorId,
          executor: toAttached(newBind),
        })
        resolveExecutorWaiters(workspaceId)
        return
      }

      // Case 2: different executorId but same workspaceId AND the previous
      // claimant is still actively attached (no detach in flight). A
      // *different* process is claiming the same workspace — duplicate
      // `~/.kala/workspace-id` copied to another machine, or two
      // processes racing before the local lockfile takes effect.
      //
      // Arbitration: if the current claimant's socket is still connected,
      // reject the newcomer with a permanent error. If it's already gone
      // (a disconnect event that hasn't propagated, or a race), let the
      // newcomer take over.
      const wsClaimant = findBindByWorkspace(workspaceId)
      if (wsClaimant && wsClaimant.announcement.executorId !== executorId) {
        if (wsClaimant.socket.connected) {
          socket.emit('executor:host_reject', {
            code: 'workspace_id_conflict',
            message:
              `workspace ${workspaceId} is already claimed by ` +
              `executor ${wsClaimant.announcement.executorId} ` +
              `(from ${wsClaimant.announcement.hostname ?? '?'}). ` +
              `Two executors cannot hold the same workspaceId simultaneously — ` +
              `check for a duplicate ~/.kala/workspace-id file across machines.`,
          })
          // Server-initiated disconnect: the executor's socket.io client sees
          // this as `disconnect('io server disconnect')` and, with the retry
          // logic in fix 3, will stop reconnecting instead of hot-looping.
          socket.disconnect(true)
          return
        }
        // Stale claimant: take over. Cancel its in-flight calls, evict it
        // from the registry, then fall through to normal attach.
        synthesizeFailure(wsClaimant, 'workspace claimed by new executor')
        byExecutor.delete(wsClaimant.announcement.executorId)
        socketToExecutor.delete(wsClaimant.socket.id)
        emitChange({
          change: 'detached',
          executorId: wsClaimant.announcement.executorId,
        })
      }

      // Case 3: brand-new executor + fresh workspaceId. Normal attach.
      byExecutor.set(executorId, newBind)
      socketToExecutor.set(socket.id, executorId)
      emitChange({
        change: 'attached',
        executorId,
        executor: toAttached(newBind),
      })
      resolveExecutorWaiters(workspaceId)
    },
    detach(socket) {
      const executorId = socketToExecutor.get(socket.id)
      if (!executorId) return
      const bind = byExecutor.get(executorId)
      if (!bind || bind.socket.id !== socket.id) return
      const workspaceId = bind.announcement.workspaceId

      // Move the bind out of the active registry and into the grace window.
      // We keep `bind.pending` intact so `redispatchPending` can resurrect
      // in-flight tool calls if the executor reconnects within DETACH_GRACE_MS.
      // Routing (findBindByWorkspace / pickBindFor) skips detaching binds —
      // new tool calls fail with "workspace offline" until reconnect.
      byExecutor.delete(executorId)
      socketToExecutor.delete(socket.id)
      const prior = detaching.get(workspaceId)
      if (prior) {
        clearTimeout(prior.timer)
        synthesizeFailure(prior.bind, 'executor disconnected')
      }
      const timer = setTimeout(() => {
        detaching.delete(workspaceId)
        synthesizeFailure(bind, 'executor disconnected')
        emitChange({
          change: 'detached',
          executorId,
        })
      }, detachGraceMs)
      detaching.set(workspaceId, { bind, timer })
    },
    revoke(socket, reason = 'credential_revoked') {
      const executorId = socketToExecutor.get(socket.id)
      const active = executorId ? byExecutor.get(executorId) : undefined
      if (active?.socket === socket) {
        byExecutor.delete(executorId!)
        socketToExecutor.delete(socket.id)
        synthesizeRevocation(active, reason)
        emitChange({ change: 'detached', executorId: active.announcement.executorId })
        return
      }
      for (const [workspaceId, entry] of detaching) {
        if (entry.bind.socket !== socket) continue
        clearTimeout(entry.timer)
        detaching.delete(workspaceId)
        socketToExecutor.delete(socket.id)
        synthesizeRevocation(entry.bind, reason)
        emitChange({ change: 'detached', executorId: entry.bind.announcement.executorId })
        return
      }
    },
    async callTool(sessionId, eff: CallToolEffect, turnId?: string) {
      const picked = pickBindFor(sessionId)
      if (!picked.ok) return { ok: false, content: picked.reason, failure: { code: 'workspace_offline', category: 'precondition', outcome: 'blocked', retryable: true, responsibility: 'workspace' } }
      const bind = picked.bind
      const authorization = authorizeCurrent(bind)
      const authorized = typeof authorization === 'boolean' ? authorization : await authorization
      if (!authorized) return { ok: false, content: 'executor unavailable' }
      if (isUnavailableMcpTool(bind.announcement, eff.name, knownMcpToolNames, resolver.mcpSchemaHashFor?.(sessionId, eff.name))) {
        return {
          ok: false,
          content: `MCP tool ${eff.name} is no longer available in this workspace`,
          failure: { code: 'mcp_tool_unavailable', category: 'precondition' as const, outcome: 'blocked' as const, retryable: true, responsibility: 'workspace' as const },
        }
      }
      const ackTimeoutMs = ackTimeoutMsFor(eff.name, eff.input, toolAckTimeoutMs)
      const owner = resolver.assertSessionEffectOwner ? await resolver.assertSessionEffectOwner(sessionId) : undefined
      if (!isCurrent(bind)) return { ok: false, content: 'executor unavailable before dispatch' }
      const desktopManualAuthorizationRequired = eff.name === 'computer_use'
        ? resolver.desktopManualAuthorizationRequired?.(sessionId) ?? true : undefined
      const features = eff.name === 'computer_use' ? resolver.desktopFeaturePolicy?.(sessionId) : undefined
      if (features?.computerUseEnabled === false) {
        return { ok: false, content: 'Computer Use is disabled in administrator Settings.',
          failure: { code: 'computer_use_disabled', category: 'precondition', outcome: 'blocked', retryable: false, responsibility: 'user' } }
      }
      if (features && bind.announcement.computerUseFeaturePolicyVersion !== 1) {
        return { ok: false, content: 'Update this Executor to use configured Computer Use options.',
          failure: { code: 'executor_update_required', category: 'precondition', outcome: 'blocked', retryable: true, responsibility: 'workspace' } }
      }
      if (desktopManualAuthorizationRequired === false && bind.announcement.computerUsePolicyVersion !== 1) {
        return {
          ok: false, content: 'Update this Executor in place to use desktop operations without extra Computer-panel authorization. Keep its existing workspace and credentials.',
          failure: { code: 'executor_update_required', category: 'precondition', outcome: 'blocked', retryable: true, responsibility: 'workspace' },
        }
      }
      const key = JSON.stringify([sessionId, eff.callId])
      audit?.log({ action: 'tool.dispatch', actor: { kind: 'system' }, target: { sessionId, workspaceId: bind.announcement.workspaceId, callId: eff.callId, toolName: eff.name }, outcome: 'ok', metadata: { cwd: eff.cwd } })
      return await new Promise<{ ok: boolean; content: string; failure?: import('@agent-kernel/kernel').ToolFailure; durationMs?: number }>((resolve) => {
        const deadlineAt = Date.now() + ackTimeoutMs
        const timer = setTimeout(() => {
          if (bind.pending.delete(key)) {
            audit?.log({ action: 'tool.result', actor: { kind: 'executor', executorId: bind.announcement.executorId, workspaceId: bind.announcement.workspaceId }, target: { sessionId, callId: eff.callId, toolName: eff.name }, outcome: 'error', error: 'timeout' })
            resolve({
              ok: false,
              content: `tool call ack timed out after ${ackTimeoutMs}ms; execution outcome is unknown. Inspect current state before retrying; do not blindly repeat side effects.`,
              failure: { code: 'tool_ack_timeout', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system', timeoutStage: 'acknowledgement' },
            })
          }
        }, ackTimeoutMs)
        bind.pending.set(key, {
          sessionId,
          callId: eff.callId,
          name: eff.name,
          input: eff.input,
          ...(eff.cwd !== undefined ? { cwd: eff.cwd } : {}),
          resolve,
          timer,
          deadlineAt,
        })
        bind.socket.emit(
          'tool:call',
          {
            ...(features ? { desktopComputerUseEnabled: features.computerUseEnabled, desktopPreviewEnabled: features.desktopPreviewEnabled } : {}),
            ...(desktopManualAuthorizationRequired !== undefined ? { desktopManualAuthorizationRequired } : {}),
            sessionId,
            callId: eff.callId,
            name: eff.name,
            input: eff.input,
            ...(eff.cwd !== undefined ? { cwd: eff.cwd } : {}),
            ackTimeoutMs,
            ...(turnId ? { turnId } : {}),
            ...(owner ? { ownerGeneration: owner.ownerGeneration } : {}),
          },
          (ack: ToolResultAck) => {
            if (ack.callId !== eff.callId) return
            const pending = bind.pending.get(key)
            if (!pending) return
            clearTimeout(pending.timer)
            bind.pending.delete(key)
            if (eff.name === 'computer_use' && resolver.desktopFeaturePolicy?.(sessionId).computerUseEnabled === false) {
              pending.resolve({ ok: false, content: 'Computer Use was disabled; desktop results are not forwarded.',
                failure: { code: 'computer_use_disabled', category: 'precondition', outcome: 'indeterminate', retryable: false, responsibility: 'user' } })
              return
            }
            audit?.log({ action: 'tool.result', actor: { kind: 'executor', executorId: bind.announcement.executorId, workspaceId: bind.announcement.workspaceId }, target: { sessionId, callId: ack.callId, toolName: eff.name }, outcome: ack.ok ? 'ok' : 'error', metadata: { contentBytes: Buffer.byteLength(ack.content, 'utf8') }, ...(ack.ok ? {} : { error: ack.content.slice(0, 200) }) })
            pending.resolve({ ok: ack.ok, content: ack.content, ...(ack.failure ? { failure: ack.failure } : {}), ...(ack.durationMs !== undefined ? { durationMs: ack.durationMs } : {}) })
          },
        )
      })
    },
    async callToolWhenAvailable(sessionId, eff, turnId) {
      const deadlineAt = Date.now() + PLANNED_CONTINUATION_EXECUTOR_WAIT_MS
      while (true) {
        const result = await this.callTool(sessionId, eff, turnId)
        // `workspace_offline` is produced before tool:call is emitted, so this
        // is the only failure that is safe to retry. Once a call was sent, the
        // Executor receipt/idempotency protocol owns recovery and this method
        // must not guess whether an external side effect occurred.
        if (result.failure?.code !== 'workspace_offline') return result
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0 || !await this.waitForSessionExecutor(sessionId, remainingMs)) return result
      }
    },
    cancelPending(sessionId) {
      // Detached binds retain calls during the reconnect grace window. They
      // must remain cancellable or a cancelled call can be redispatched when
      // the executor returns. Emitting to a disconnected socket is harmless;
      // resolving/removing the pending entry is the authoritative action.
      for (const bind of allPendingBinds()) {
        for (const p of [...bind.pending.values()]) {
          if (p.sessionId !== sessionId) continue
          clearTimeout(p.timer)
          bind.pending.delete(JSON.stringify([p.sessionId, p.callId]))
          p.resolve({ ok: false, content: 'cancelled by user' })
          const authorization = authorizeCurrent(bind)
          const emitCancel = (authorized: boolean): void => {
            if (authorized) bind.socket.emit('tool:cancel', { sessionId, callId: p.callId })
          }
          if (typeof authorization === 'boolean') emitCancel(authorization)
          else void authorization.then(emitCancel)
        }
      }
    },
    activeSessions() {
      const out = new Set<string>()
      for (const bind of allPendingBinds()) {
        for (const p of bind.pending.values()) out.add(p.sessionId)
      }
      return [...out]
    },
    snapshot() {
      return [...byExecutor.values()].map(toAttached)
    },
    renameWorkspace(workspaceId, workspaceName) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) return undefined
      bind.announcement = { ...bind.announcement, workspaceName }
      const executor = toAttached(bind)
      emitChange({
        change: 'updated',
        executorId: bind.announcement.executorId,
        executor,
      })
      return executor
    },
    executorForSession(sessionId) {
      const picked = pickBindFor(sessionId)
      return picked.ok ? toAttached(picked.bind) : undefined
    },
    async listDirs(workspaceId, path, requestId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) {
        return defaultDirList(requestId, workspaceId, path, 'workspace offline')
      }
      return await callInternalTool<DirListResult>(
        bind,
        workspaceId,
        '__fs_list_dirs',
        { requestId, workspaceId, ...(path !== undefined ? { path } : {}) },
        (msg) => defaultDirList(requestId, workspaceId, path, msg),
      )
    },
    async createDirectory(workspaceId, parentPath, name, requestId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) {
        return { requestId, workspaceId, path: parentPath, parentPath, roots: [], created: false, error: 'workspace offline' }
      }
      return await callInternalTool<CreateDirectoryResult>(
        bind,
        workspaceId,
        '__fs_create_directory',
        { requestId, workspaceId, parentPath, name },
        (msg) => ({ requestId, workspaceId, path: parentPath, parentPath, roots: [], created: false, error: msg }),
      )
    },
    async listFiles(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          files: [],
          truncated: false,
          error: 'workspace offline',
        }
      }
      return await callInternalTool<FileListResult>(
        bind,
        payload.workspaceId,
        '__fs_list_files',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          files: [],
          truncated: false,
          error: msg,
        }),
      )
    },
    async readOverflow(payload, workspaceId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          sessionId: payload.sessionId,
          callId: payload.callId,
          error: 'workspace offline',
        }
      }
      return await callInternalTool<OverflowContentsResult>(
        bind,
        workspaceId,
        '__fs_read_overflow',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          sessionId: payload.sessionId,
          callId: payload.callId,
          error: msg,
        }),
      )
    },
    async copyOverflowSession(workspaceId, sourceSessionId, targetSessionId) {
      const bind = findBindByWorkspace(workspaceId)
      const payload: CopyOverflowSession = {
        requestId: `${Date.now()}-${sourceSessionId}-${targetSessionId}`,
        sourceSessionId,
        targetSessionId,
      }
      if (!bind) return { ...payload, copied: false, error: 'workspace offline' }
      return await callInternalTool<CopyOverflowSessionResult>(
        bind,
        workspaceId,
        '__fs_copy_overflow_session',
        payload as unknown as Record<string, unknown>,
        (msg) => ({ ...payload, copied: false, error: msg }),
      )
    },
    async deleteOverflowSession(workspaceId, sessionId) {
      const bind = findBindByWorkspace(workspaceId)
      const payload: DeleteOverflowSession = {
        requestId: `${Date.now()}-${sessionId}`,
        sessionId,
      }
      if (!bind) return { ...payload, deleted: false, error: 'workspace offline' }
      return await callInternalTool<DeleteOverflowSessionResult>(
        bind,
        workspaceId,
        '__fs_delete_overflow_session',
        payload as unknown as Record<string, unknown>,
        (msg) => ({ ...payload, deleted: false, error: msg }),
      )
    },
    async listBg(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          tasks: [],
          error: 'workspace offline',
        }
      }
      return await callInternalTool<BgListResult>(
        bind,
        payload.workspaceId,
        '__bg_list',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          tasks: [],
          error: msg,
        }),
      )
    },
    async readBg(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          content: '',
          nextOffset: 0,
          done: true,
          status: 'exited',
          bytesTruncated: 0,
          error: 'workspace offline',
        }
      }
      return await callInternalTool<BgOutputResult>(
        bind,
        payload.workspaceId,
        '__bg_output',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          content: '',
          nextOffset: 0,
          done: true,
          status: 'exited',
          bytesTruncated: 0,
          error: msg,
        }),
      )
    },
    async killBg(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          killed: false,
          error: 'workspace offline',
        }
      }
      return await callInternalTool<BgKillResult>(
        bind,
        payload.workspaceId,
        '__bg_kill',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          killed: false,
          error: msg,
        }),
      )
    },
    async createTerminal(payload, signal) {
      const unavailable = { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'workspace offline' }
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) return unavailable
      if (signal?.aborted) return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'terminal create cancelled' }
      const started = runTerminalOperation(bind, () => undefined, () => {
        let requests = terminalCreates.get(bind)
        if (!requests) {
          requests = createTerminalRequestManager({
            timeoutMs: TERMINAL_CREATE_ACK_TIMEOUT_MS,
            emit: (body, ack) => { bind.socket.emit('terminal:create', body, ack) },
            dispose: (body, result) => {
              ignoreAsync(runTerminalOperation(bind, () => undefined, () => {
                bind.socket.emit('terminal:kill', { requestId: body.requestId, workspaceId: body.workspaceId, sessionId: body.sessionId, terminalId: result.terminalId! }, () => {})
              }))
            },
          })
          terminalCreates.set(bind, requests)
        }
        return requests.request(payload)
      })
      const request = started instanceof Promise ? await started : started
      if (!request) return unavailable
      const onAbort = (): void => request.cancel()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await request.result
        request.accept()
        return result
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
    inputTerminal(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (bind) ignoreAsync(runTerminalOperation(bind, () => undefined, () => { bind.socket.emit('terminal:input', payload) }))
    },
    resizeTerminal(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (bind) ignoreAsync(runTerminalOperation(bind, () => undefined, () => { bind.socket.emit('terminal:resize', payload) }))
    },
    async killTerminal(payload) {
      const unavailable: TerminalKillResult = {
        requestId: payload.requestId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        terminalId: payload.terminalId,
        killed: false,
        error: 'workspace offline',
      }
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) return unavailable
      const started = runTerminalOperation(bind, () => undefined, () => ({
        result: new Promise<TerminalKillResult>((resolve) => {
          let settled = false
          const timer = setTimeout(() => {
            settled = true
            resolve({ requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'terminal kill acknowledgement timed out' })
          }, TERMINAL_ACK_TIMEOUT_MS)
          bind.socket.emit('terminal:kill', payload, (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
          })
        }),
      }))
      const request = started instanceof Promise ? await started : started
      return request ? await request.result : unavailable
    },
    closeSessionTerminals(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (bind) ignoreAsync(runTerminalOperation(bind, () => undefined, () => { bind.socket.emit('terminal:close_session', payload) }))
    },
    async updateDesktopFeaturePolicy(sessionId) {
      const policy = resolver.desktopFeaturePolicy?.(sessionId)
      if (!policy) return
      for (const bind of allPendingBinds()) {
        for (const [key, pending] of bind.pending) {
          if (pending.sessionId !== sessionId || pending.name !== 'computer_use' || policy.computerUseEnabled) continue
          bind.socket.emit('tool:cancel', { sessionId, callId: pending.callId })
          clearTimeout(pending.timer)
          bind.pending.delete(key)
          pending.resolve({ ok: false, content: 'Computer Use was disabled; any already-delivered input cannot be undone.',
            failure: { code: 'computer_use_disabled', category: 'precondition', outcome: 'indeterminate', retryable: false, responsibility: 'user' } })
        }
      }
      const bind = pickBindFor(sessionId)
      if (!bind.ok || bind.bind.announcement.computerUseFeaturePolicyVersion !== 1) return
      const fail = (message: string): ComputerResponse => ({ requestId: 'desktop-policy-refresh', error: { code: 'unavailable', message } })
      const response = await callInternalTool<ComputerResponse>(bind.bind, bind.bind.announcement.workspaceId, '__computer_use', {
        owner: 'host-policy', request: { operation: 'status', requestId: 'desktop-policy-refresh', workspaceId: bind.bind.announcement.workspaceId, sessionId, policyStatusVersion: 2 },
        desktopManualAuthorizationRequired: resolver.desktopManualAuthorizationRequired?.(sessionId) ?? true,
        desktopComputerUseEnabled: policy.computerUseEnabled, desktopPreviewEnabled: policy.desktopPreviewEnabled,
      }, fail)
      if (response.error) throw new Error(response.error.message)
    },
    async computerRequest(payload, owner) {
      const fail = (message: string): ComputerResponse => ({ requestId: payload.requestId, error: { code: 'unavailable', message } })
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) return fail('Workspace is offline')
      if (!bind.announcement.tools.includes('__computer_use')) return fail('This Executor needs an update before it can share its desktop')
      const features = resolver.desktopFeaturePolicy?.(payload.sessionId)
      const disabled = features && (!features.computerUseEnabled || !features.desktopPreviewEnabled)
      if (disabled && payload.operation !== 'stop') {
        const reason = !features.computerUseEnabled ? 'Computer Use is disabled in administrator Settings.' : 'Desktop preview is disabled in administrator Settings.'
        return payload.operation === 'status' ? { requestId: payload.requestId, status: { available: false, platform: 'executor', reason, active: false, allowAgent: false,
          ...(payload.policyStatusVersion ? { manualAuthorizationRequired: resolver.desktopManualAuthorizationRequired?.(payload.sessionId) ?? true, automatic: false } : {}),
          ...(payload.policyStatusVersion === 2 ? features : {}) } }
          : { requestId: payload.requestId, error: { code: 'denied', message: reason } }
      }
      if (features && bind.announcement.computerUseFeaturePolicyVersion !== 1 && payload.operation !== 'stop') return fail('Update this Executor to use configured desktop preview options')
      const request = { ...payload }
      if (bind.announcement.computerUsePolicyVersion !== 1 ||
        (request.policyStatusVersion === 2 && bind.announcement.computerUseFeaturePolicyVersion !== 1)) delete request.policyStatusVersion
      const response = await callInternalTool<ComputerResponse>(bind, payload.workspaceId, '__computer_use', {
        request, owner,
        desktopManualAuthorizationRequired: resolver.desktopManualAuthorizationRequired?.(payload.sessionId) ?? true,
        ...(features ? { desktopComputerUseEnabled: features.computerUseEnabled, desktopPreviewEnabled: features.desktopPreviewEnabled } : {}),
      }, fail)
      const current = resolver.desktopFeaturePolicy?.(payload.sessionId)
      if (payload.operation !== 'stop' && current && (!current.computerUseEnabled || !current.desktopPreviewEnabled)) return { requestId: payload.requestId, error: { code: 'denied', message: 'Desktop preview was disabled in administrator Settings.' } }
      return response
    },
    appDebugTarget(workspaceId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind?.socket.connected || bind.announcement.appDebugVersion !== 1) return undefined
      return {
        executorId: bind.announcement.executorId,
        connectionId: bind.socket.id,
        request: async (request) => {
          if (!bind.socket.connected || findBindByWorkspace(workspaceId)?.socket !== bind.socket) return appDebugFailure('Executor connection changed. Forwarding stopped without migrating or replaying application data.')
          return appDebugWait(() => bind.socket.timeout(APP_DEBUG_ACK_MS).emitWithAck('executor:app_debug_request', request))
        },
      }
    },
    async workspaceExec(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: 0,
          error: { code: 'EACCES', message: 'workspace offline' },
        }
      }
      return await callInternalTool<WorkspaceExecResponse>(
        bind,
        payload.workspaceId,
        '__workspace_exec',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: 0,
          error: { code: 'EIO', message: msg },
        }),
      )
    },
    async workspaceReadBinary(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          base64: '',
          mime: 'application/octet-stream',
          size: 0,
          error: { code: 'EACCES', message: 'workspace offline' },
        }
      }
      return await callInternalTool<WorkspaceReadBinaryResponse>(
        bind,
        payload.workspaceId,
        '__workspace_read_binary',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          base64: '',
          mime: 'application/octet-stream',
          size: 0,
          error: { code: 'EIO', message: msg },
        }),
      )
    },
    async publishLocalImage(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) return { requestId: payload.requestId, path: payload.path, error: 'workspace offline' }
      return await callInternalTool<PublishLocalImageResponse>(
        bind,
        payload.workspaceId,
        '__publish_local_image',
        payload as unknown as Record<string, unknown>,
        (msg) => ({ requestId: payload.requestId, path: payload.path, error: msg }),
      )
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async waitForSessionExecutor(sessionId, timeoutMs = PLANNED_CONTINUATION_EXECUTOR_WAIT_MS) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Executor wait timeout must be a positive integer')
      const workspaceId = resolver.workspaceIdFor(sessionId)
      if (workspaceId === undefined ? pickAnyBind() !== undefined : findBindByWorkspace(workspaceId) !== undefined) return true
      const key = workspaceId ?? '*'
      return await new Promise<boolean>((resolve) => {
        const waiter: ExecutorWaiter = {
          resolve,
          timer: setTimeout(() => {
            const current = executorWaiters.get(key)
            current?.delete(waiter)
            if (current?.size === 0) executorWaiters.delete(key)
            resolve(false)
          }, timeoutMs),
        }
        const current = executorWaiters.get(key) ?? new Set<ExecutorWaiter>()
        current.add(waiter)
        executorWaiters.set(key, current)
        // Close the attach-before-register race without polling.
        if (workspaceId === undefined ? pickAnyBind() !== undefined : findBindByWorkspace(workspaceId) !== undefined) {
          current.delete(waiter)
          if (current.size === 0) executorWaiters.delete(key)
          clearTimeout(waiter.timer)
          resolve(true)
        }
      })
    },
  }
}

function ackTimeoutMsFor(
  toolName: string,
  input: Record<string, unknown>,
  defaultAckTimeoutMs: number,
): number {
  let toolTimeoutMs: number | undefined
  if (toolName === 'bash_output' && input['block'] === true) {
    toolTimeoutMs = positiveInt(input['timeout_ms']) ?? 30_000
  } else if (
    toolName === 'process' &&
    (input['action'] === 'poll' || input['action'] === undefined) &&
    input['block'] === true
  ) {
    toolTimeoutMs = Math.min(positiveInt(input['timeout_ms']) ?? positiveInt(input['timeoutMs']) ?? 30_000, 300_000)
  } else if (toolName === 'bash' || toolName === 'shell') {
    if (input['run_in_background'] === true || input['background'] === true) return defaultAckTimeoutMs
    const yieldTimeMs = positiveInt(input['yield_time_ms']) ?? positiveInt(input['yieldTimeMs'])
    toolTimeoutMs = yieldTimeMs ?? bashToolTimeoutMs(input)
  } else {
    return defaultAckTimeoutMs
  }
  if (toolTimeoutMs === undefined) return defaultAckTimeoutMs
  return Math.max(defaultAckTimeoutMs, toolTimeoutMs + Math.min(Math.max(Math.round(toolTimeoutMs * 0.1), 5_000), 60_000))
}

function bashToolTimeoutMs(input: Record<string, unknown>): number | undefined {
  const seconds = positiveInt(input['timeout_seconds']) ?? positiveInt(input['timeoutSeconds'])
  if (seconds !== undefined) return seconds * 1000
  return positiveInt(input['timeout_ms']) ?? positiveInt(input['timeoutMs'])
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
