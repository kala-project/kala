/**
 * Dashboard Socket.IO namespace wiring.
 *
 * One socket per connected browser tab. The connection is bound to a
 * `sessionId` at handshake time (via `auth.sessionId`); the browser sees
 * `session:ready` up front and subscribes to a room named `session:<id>`.
 *
 * Every `client:*` event on this namespace maps to a call into the host
 * loop, the session store, or the executor registry. Nothing here decides
 * *what* the kernel does — that stays in the kernel. This file is protocol
 * mapping only.
 */

import type {
  ClientCancel,
  ClientCancelStream,
  ClientClear,
  ClientCompact,
  ClientConsolidateMemory,
  ClientCreateSession,
  ClientCreateDirectory,
  ClientDeleteSession,
  ClientFork,
  ClientInterruptSubAgent,
  ClientKillBgTask,
  ClientListAgentTypes,
  ClientListBgTasks,
  ClientListDirs,
  ClientListExecutors,
  ClientListFiles,
  ClientListSessions,
  ClientListSubAgents,
  ClientLoadHistory,
  ClientPrepareSessionRoute,
  ClientLoadLogArtifact,
  ClientReadBgOutput,
  ClientReadOverflow,
  ClientDeleteQueuedMessage,
  ClientReorderQueuedMessage,
  ClientRenameWorkspace,
  ClientRenameSession,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  ClientUpdateQueuedMessage,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientSubscribeChannels,
  ClientUnsubscribeChannels,
  ChannelSubscriptionResult,
  DashboardChannel,
  ClientAskUserChoice,
  ClientAnswerDagDecision,
  ClientGetDagRun,
  ClientGetGlobalStorage,
  ClientGetSessionStorage,
  ClientPrepareStorageCleanup,
  ClientExecuteStorageCleanup,
  ClientListDagRuns,
  ClientInitializeDag,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  CreateDirectoryResult,
  DirListResult,
  RpcAck,
  EventAppendedEvent,
  CompactionMetadata,
  CompactStatusEvent,
  HandshakeAuth,
  AttachedExecutor,
  ServerHistoryPayload,
  ServerMessageQueueEvent,
  SessionErrorScope,
  SessionReadyEvent,
  SubAgentSummary,
  AgentRuntimeCapabilities,
  RuntimeCompactionPolicy,
  GlobalStorageSnapshot,
  SessionStorageEntry,
  SessionStorageSnapshot,
  SessionTokenUsage,
  StorageCleanupPlanPreview,
  StorageCleanupResult,
} from '@agent-kernel/shared'
import {
  COPILOT_RUNTIME_COMPACTION_POLICY,
  COPILOT_AGENT_RUNTIME_CAPABILITIES,
  KERNEL_AGENT_RUNTIME_CAPABILITIES,
  isCompatibleVersion,
  kernelRuntimeCompactionPolicy,
  schema,
  validateClientMessagePayload,
  validateInlineMessageFiles,
  validateInlineMessageImages,
  ComputerRequestSchema,
} from '@agent-kernel/shared'
import { SUB_AGENT_ROLE_TEMPLATES } from '@agent-kernel/shared/enhancement'
import type { RuntimeMetadataEntry } from '@agent-kernel/shared'
import type { SessionSummary } from '@agent-kernel/shared'
import type {
  WorkspaceExecRequest,
  WorkspaceReadBinaryRequest,
} from '@agent-kernel/shared/workspace-exec'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  MessageContent,
} from '@agent-kernel/kernel'
import { createInitialState } from '@agent-kernel/kernel'
import type { Namespace } from 'socket.io'
import { ulid } from 'ulid'

import type { HostLoopDeps, LoopHandle } from '../loop.js'
import { createBuiltinExtensionRegistry } from '../extensions/builtin-registry.js'
import type { ConsolidationOutcome } from '../extensions/memory-consolidation.js'
import { activeSubAgentFor, interruptSubAgentAfterRuntimeCancel, markSubAgentInterrupted } from '../extensions/agent-tool.js'
import { resetCompactRuntime } from '../extensions/compaction.js'
import { SessionStore, type SessionRecord } from '../store/session.js'
import { createExecutorRegistry } from './executor.js'
import { dirname, resolve as resolvePath, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AuthConfig } from '../auth-control.js'
import { authenticateDashboardHandshake } from '../auth-control.js'
import type { AuditActor, AuditLogger } from '../audit-log.js'
import type { DashboardActor } from '../auth-control.js'
import { parseWire, type WireValidationContext } from '../wire-validation.js'
import { contextSnapshot, snapshotFromConfig, type ContextWindowOverride } from '../context/manager.js'
import { sessionRoom, terminalOwnerSessionId } from './rooms.js'
import { dashboardConnectionMeta, type ConnectionMeta } from './socket-metadata.js'
import { OperationDeduper } from './operation-deduper.js'
import type { AgentRuntimeRegistry } from '../agent-runtime/types.js'
import { validateMessageAttachmentReferences } from '../message-attachment-resolver.js'
import { S3MessageAttachmentStore } from '../message-attachments/s3-message-attachment-store.js'
import { askUserChoiceRequestFromPendingCall, type AskUserChoiceBroker } from '../ask-user-choice.js'
import type { DagStorage } from '../dag/storage.js'
import type { StorageInventory } from '../store/storage-inventory.js'
import type { SafeCleanupEngine } from '../store/safe-cleanup.js'
import { DAG_PLANNER_INSTRUCTION, DAG_PLAN_TOOL } from '../dag/tool.js'
import { parseBangShellRequest } from '../bang-shell.js'
import { mcpToolsForWorkspace, mergeMcpTools } from '../mcp-tools.js'

export type QueuedUserMessage = {
  id: string
  /** Client operation identity; stable across ACK loss and reconnect retry. */
  operationId: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
  content?: readonly MessageContent[]
  model?: string
  /** Host-owned shell escape. State and result are persisted before Agent dispatch. */
  shell?: {
    command: string
    state?: 'queued' | 'running' | 'completed' | 'nonzero' | 'failed' | 'unknown'
    result?: string
    /** Operator-facing detail for a shell effect whose completion cannot be established safely. */
    error?: string
  }
}

async function safeRuntimeAction(
  deps: DashboardDeps,
  sessionId: string,
  action: (
    runtime: ReturnType<AgentRuntimeRegistry['require']>,
    record: SessionRecord,
  ) => Promise<void>,
): Promise<void> {
  try {
    const record = await loadRecordForDashboard(deps, sessionId)
    if (!record) {
      deps.broadcastError(sessionId, 'host', 'unknown session')
      return
    }
    await action(deps.agentRuntimes.require(record.agentRuntime), record)
  } catch (err) {
    deps.broadcastError(sessionId, 'host', err instanceof Error ? err.message : String(err))
  }
}

async function requireRuntimeCapability(
  deps: DashboardDeps,
  sessionId: string,
  capability: keyof AgentRuntimeCapabilities,
  operation: string,
): Promise<SessionRecord | undefined> {
  const record = await loadRecordForDashboard(deps, sessionId)
  if (!record) {
    deps.broadcastError(sessionId, 'host', 'unknown session')
    return undefined
  }
  const descriptor = deps.agentRuntimes.require(record.agentRuntime).descriptor()
  if (!descriptor.capabilities[capability]) {
    deps.broadcastError(sessionId, 'host', `${descriptor.label} sessions do not support ${operation}`)
    return undefined
  }
  return record
}

export type MessageQueueManager = {
  hydrate(sessionId: string): Promise<void>
  isStable(): boolean
  waitForStable(): Promise<void>
  enqueue(sessionId: string, msg: QueuedUserMessage, priority?: 'front', admission?: 'atomic-attachments'): Promise<void>
  reorder(sessionId: string, id: string, beforeId?: string | null): Promise<void>
  update(sessionId: string, id: string, text: string, content?: readonly MessageContent[]): Promise<void>
  delete(sessionId: string, id: string): Promise<void>
  /** Stop control: discard queued steers and pause ordinary follow-ups until the next explicit send. */
  stop(sessionId: string): Promise<void>
  pending(sessionId: string): number
  snapshot(sessionId: string): ServerMessageQueueEvent
  drain(sessionId: string): Promise<void>
}

export type DashboardNs = Namespace<
  DashboardClientToServerEvents,
  DashboardServerToClientEvents
>

export function isRestingStatus(status: AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

export type DashboardDeps = {
  store: SessionStore
  loop: LoopHandle
  loopDeps: HostLoopDeps
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig | ((actor?: DashboardActor) => AgentConfig)
  auth?: AuthConfig
  audit?: AuditLogger
  sessionQuota?: TenantSessionQuotaEnforcer
  queueQuota?: TenantQueueQuotaEnforcer
  modelPolicy?: TenantModelPolicyEnforcer
  allowAllApprovalMode?: boolean
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  contextWindowForModel?(model: string | undefined): ContextWindowOverride | undefined
  effectiveDefaultModel?(): string | undefined
  effectiveModelForSession?(record: SessionRecord): string | undefined
  normalizeModelRef?(model: string): string | undefined
  dashboardNs: DashboardNs
  messageQueues: MessageQueueManager
  streamingDraftSnapshot?(sessionId: string): { text: string; afterSeq: number; messageCount: number } | undefined
  agentRuntimes: AgentRuntimeRegistry
  askUserChoice?: AskUserChoiceBroker
  dagStore?: DagStorage
  storageInventory?: StorageInventory
  safeCleanup?: SafeCleanupEngine
  executorSnapshot?(): readonly AttachedExecutor[]
  onSessionCreated?(record: SessionRecord): void | Promise<void>
  onSessionDeleted?(record: SessionRecord): void | Promise<void>
  renameWorkspace?(workspaceId: string, workspaceName: string): Promise<string>
  mutableReady?(): boolean
}

export type TenantSessionQuotaEnforcer = {
  assertCanCreateSession(params: {
    organizationId: string
    principal: string
    role: 'owner' | 'admin' | 'member' | 'viewer'
    sessionId: string
  }): Promise<void>
}

export type TenantQueueQuotaEnforcer = {
  assertCanEnqueueMessage(params: {
    organizationId: string
    principal: string
    role: 'owner' | 'admin' | 'member' | 'viewer'
    sessionId: string
    pendingMessages: number
    mode: 'steer' | 'queue'
  }): Promise<void>
}

export type TenantModelPolicyEnforcer = {
  assertCanUseModel(params: {
    organizationId: string
    sessionId: string
    model: string
    principal?: string
  }): Promise<void>
}

const READ_ONLY_DASHBOARD_EVENTS = new Set([
  'client:connection_ping', 'client:executor_ping', 'client:list_executors', 'client:list_sessions',
  'client:load_history', 'client:load_log_artifact', 'client:get_session_storage', 'client:get_global_storage', 'client:subscribe_channels', 'client:refresh_channels', 'client:restore_subscriptions',
  'client:unsubscribe_channels', 'subscribe', 'unsubscribe', 'client:list_dirs', 'client:list_files',
  'workspace:read_binary', 'client:read_overflow', 'client:get_dag_run', 'client:list_dag_runs', 'bg:list', 'bg:output', 'sub_agent:list', 'agent_types:list',
])

export function recoverSubAgentOutcome(
  parentState: AgentState,
  parentCallId: string,
): { status: SubAgentSummary['status']; turns: number; durationMs: number; error?: string } | undefined {
  for (let messageIndex = parentState.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = parentState.messages[messageIndex]
    if (!message) continue
    for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      const content = message.content[contentIndex]
      if (content?.type !== 'tool_result' || content.callId !== parentCallId) continue
      const header = /^<sub_agent\b([\s\S]*?)>/.exec(content.content.trimStart())
      if (!header) return undefined
      const attrs = Object.fromEntries(
        [...(header[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)]
          .map((match) => [match[1]!, match[2]!]),
      )
      const rawStatus = attrs.status
      if (
        rawStatus !== 'completed'
        && rawStatus !== 'failed'
        && rawStatus !== 'cancelled'
        && rawStatus !== 'timed_out_with_partial_result'
      ) return undefined
      const status: SubAgentSummary['status'] =
        rawStatus === 'timed_out_with_partial_result' ? 'failed' : rawStatus
      const errorMatch = /<(?:error|warning)>([\s\S]*?)<\/(?:error|warning)>/.exec(content.content)
      const error = errorMatch?.[1]
        ?.replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .trim()
      return {
        status,
        turns: nonNegativeNumber(attrs.turns),
        durationMs: nonNegativeNumber(attrs.duration_ms),
        ...(error ? { error } : {}),
      }
    }
  }
  return undefined
}

function nonNegativeNumber(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function configureDashboardNamespace(
  ns: DashboardNs,
  deps: DashboardDeps,
): void {
  const operations = new OperationDeduper()
  const cleanupPlans = new Map<string, { principal: string; sessionIds: readonly string[] }>()
  const getDefaultConfig = (actor?: DashboardActor): AgentConfig => typeof deps.defaultConfig === 'function'
    ? deps.defaultConfig(actor)
    : deps.defaultConfig
  const mutableRuntimeReady = (): boolean => deps.mutableReady?.() !== false
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'dashboard') {
      nextFn(new Error('role_mismatch'))
      return
    }
    if (typeof auth.clientVersion !== 'string' || !isCompatibleVersion(auth.clientVersion)) {
      nextFn(new Error('version_incompatible'))
      return
    }
    const authResult = authenticateDashboardHandshake(auth, socket.request, deps.auth)
    if (!authResult.ok) {
      deps.audit?.log({ action: 'dashboard.socket_reject', actor: { kind: 'anonymous' }, target: { sessionId: auth.sessionId }, outcome: 'denied', error: authResult.reason })
      nextFn(new Error(authResult.reason))
      return
    }
    if (!auth.sessionId && !auth.clientId) {
      nextFn(new Error('missing_connection_identity'))
      return
    }
    const routedSessionId = socket.handshake.headers['x-agent-runlab-route-session-id']
    if (routedSessionId !== undefined && (typeof routedSessionId !== 'string' || auth.clientId || auth.sessionId !== routedSessionId)) {
      nextFn(new Error('session_route_mismatch'))
      return
    }
    const connectionMeta = dashboardConnectionMeta({
      actor: authResult.actor,
      clientVersion: auth.clientVersion,
    })
    socket.data.dashboardActor = authResult.actor
    socket.data.readOnly = authResult.actor.kind === 'ingress' && authResult.actor.role === 'viewer'
    socket.data.connectionMeta = connectionMeta
    deps.audit?.log({ action: 'dashboard.socket_accept', actor: authResult.actor, target: { sessionId: auth.sessionId }, outcome: 'ok', metadata: auditConnectionMeta(connectionMeta) })
    nextFn()
  })

  ns.on('connection', (socket) => {
    // Socket.IO does not await async connection listeners. Hydration failures
    // (including disconnects during shutdown) must not become unhandled rejections.
    void (async () => {
    const auth = socket.handshake.auth as HandshakeAuth
    const multiplexed = Boolean(auth.clientId)
    // Legacy clients bind transport to one Session; multiplexed clients use a control placeholder until subscribing.
    const sessionId = auth.sessionId ?? `control:${auth.clientId}`
    socket.emit('server:agent_runtimes', { runtimes: deps.agentRuntimes.catalog() })
    socket.use(([event, ...args], next) => {
      const routedSessionId = socket.handshake.headers['x-agent-runlab-route-session-id']
      if (typeof routedSessionId === 'string') {
        const payload = args[0]
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const scoped = payload as Record<string, unknown>
          if ((scoped.sessionId !== undefined && scoped.sessionId !== routedSessionId)
            || (scoped.sessionIds !== undefined && (!Array.isArray(scoped.sessionIds)
              || scoped.sessionIds.some((id) => id !== routedSessionId)))
            || (scoped.channels !== undefined && (!Array.isArray(scoped.channels)
              || scoped.channels.some((channel) => channel !== `session:${routedSessionId}`)))) {
            const ack = args.at(-1)
            if (typeof ack === 'function') (ack as (value: RpcAck) => void)({ ok: false, error: 'session_route_mismatch' })
            next(new Error('session_route_mismatch'))
            return
          }
        }
      }
      if (deps.mutableReady?.() === false && !READ_ONLY_DASHBOARD_EVENTS.has(String(event))) {
        const ack = args.at(-1)
        if (typeof ack === 'function') (ack as (value: RpcAck) => void)({ ok: false, error: 'runtime_not_ready' })
        next(new Error('runtime_not_ready'))
        return
      }
      next()
    })
    socket.on('client:connection_ping', (_sentAt, ack) => ack(Date.now()))

    // Local `vparse` — closes over `socket.id` + the connected sessionId so
    // handlers can call `vparse(schema.X, raw, 'client:x')` in one line.
    const vparse = <T>(
      s: import('zod').ZodType<T>,
      raw: unknown,
      channel: string,
      overrideSessionId?: string,
    ): T | undefined => {
      const ctx: WireValidationContext = {
        channel,
        peer: socket.id,
        sessionId: overrideSessionId ?? sessionId,
      }
      return parseWire(s, raw, ctx)
    }
    const runOperation = <T>(
      eventKind: string,
      targetSessionId: string,
      operationId: string | undefined,
      payload: unknown,
      operation: () => Promise<T>,
    ): Promise<RpcAck<T>> => operations.run(operationId, {
      principal: operationPrincipal(socket.data.dashboardActor as DashboardActor | undefined),
      sessionId: targetSessionId,
      eventKind,
    }, payload, operation)
    const subscribedSessions = new Set<string>()
    const subscribedWorkspaces = new Set<string>()
    socket.on('client:executor_ping', async (workspaceId, ack) => {
      const error = await validateWorkspaceSocketAccess(workspaceId)
      if (error) { ack({ error }); return }
      ack(await deps.executors.measureLatency(workspaceId))
    })
    const subscribedWorkspaceOwner = async (workspaceId: string): Promise<SessionRecord | undefined> => {
      const candidates = multiplexed ? [...subscribedSessions] : [sessionId]
      for (const candidate of candidates) {
        const record = deps.store.get(candidate) ?? (await deps.store.load(candidate, { recoverDangling: false }).catch(() => undefined))
        if (record?.workspaceId === workspaceId) return record
      }
      return undefined
    }
    const validateWorkspaceSocketAccess = async (workspaceId: string): Promise<string | undefined> => {
      if (multiplexed && !subscribedWorkspaces.has(workspaceId)) return 'workspace is not subscribed'
      const owner = await subscribedWorkspaceOwner(workspaceId)
      if (!owner) return 'workspace has no subscribed session'
      const tenantError = validateIngressSessionAccess(socket, owner)
      if (tenantError) return tenantError
      return undefined
    }
    const validateBgSessionAccess = async (targetSessionId: string, workspaceId: string): Promise<string | undefined> => {
      if (multiplexed ? !subscribedSessions.has(targetSessionId) : targetSessionId !== sessionId) {
        return 'This workspace operation belongs to an unsubscribed session.'
      }
      if (multiplexed && !subscribedWorkspaces.has(workspaceId)) return 'workspace is not subscribed'

      const record = deps.store.get(targetSessionId) ?? (await deps.store.load(targetSessionId, { recoverDangling: false }).catch(() => undefined))
      if (!record) return 'unknown session'
      const tenantError = validateIngressSessionAccess(socket, record)
      if (tenantError) return tenantError
      if (record.workspaceId !== workspaceId) return 'session does not belong to workspace'
      return undefined
    }
    const validateTerminalSessionAccess = async (targetSessionId: string, workspaceId: string): Promise<string | undefined> => {
      const ownerSessionId = terminalOwnerSessionId(targetSessionId)
      if (!ownerSessionId) return 'invalid temporary workspace terminal identity'
      return validateBgSessionAccess(ownerSessionId, workspaceId)
    }
    // A connected socket can outlive its SQL lease. Recheck before external effects.
    const validateEffectOwner = async (targetSessionId: string): Promise<string | undefined> => {
      try {
        await deps.loopDeps.assertSessionEffectOwner?.(targetSessionId)
      } catch (error) {
        return error instanceof Error ? error.message : 'Session owner is no longer active'
      }
      return undefined
    }
    const validateWorkspaceEffectOwner = async (workspaceId: string): Promise<string | undefined> => {
      // Pre-session directory picking is a dedicated, non-ingress feature.
      // Ingress cannot infer tenant access from a client-supplied workspaceId.
      if (!deps.loopDeps.assertSessionEffectOwner && auditActor(socket).kind !== 'ingress') return undefined
      // A workspace-only request cannot select an arbitrary session from a
      // multiplexed socket in parallel-v1 or another tenant's control socket.
      if (multiplexed) return 'Workspace effect requires a session-scoped connection'
      const record = deps.store.get(sessionId) ?? (await deps.store.load(sessionId, { recoverDangling: false }).catch(() => undefined))
      if (!record || record.workspaceId !== workspaceId) return 'Session is not bound to this workspace'
      return validateIngressSessionAccess(socket, record) ?? await validateEffectOwner(record.sessionId)
    }
    const auditScopedAccessDenied = (action: string, targetSessionId: string, workspaceId: string, error: string): void => {
      deps.audit?.log({ action, actor: auditActor(socket), target: { sessionId: targetSessionId, workspaceId }, outcome: 'denied', error })
    }
    if (socket.data.readOnly === true) {
      const writeEvents = [
        'client:user_message', 'client:user_approve', 'client:user_reject', 'client:ask_user_choice', 'client:cancel', 'client:interrupt_sub_agent',
        'client:clear', 'client:compact', 'client:cancel_stream', 'client:set_approval_mode', 'client:fork',
        'client:create_session', 'client:delete_session', 'client:prepare_storage_cleanup', 'client:execute_storage_cleanup', 'client:update_preferences', 'client:set_cwd',
        'client:prepare_session_route',
        'client:reorder_queued_message', 'client:update_queued_message', 'client:delete_queued_message',
        'client:rename_session', 'client:rename_workspace', 'client:create_directory', 'client:consolidate_memory', 'bg:kill',
        'client:initialize_dag', 'client:answer_dag_decision',
        'terminal:create', 'terminal:input', 'terminal:resize', 'terminal:kill', 'workspace:exec',
      ] as const
      socket.use(([event, ...args], next) => {
        if (!writeEvents.includes(event as typeof writeEvents[number])) { next(); return }
        const ack = args.at(-1)
        if (typeof ack === 'function') (ack as (value: { ok: false; error: string }) => void)({ ok: false, error: 'forbidden: runtime:write required' })
        deps.audit?.log({ action: `dashboard.${event}`, actor: auditActor(socket), outcome: 'denied', error: 'runtime:write required' })
        next(new Error('forbidden: runtime:write required'))
      })
    }

    // Register first-paint request handlers before any awaited session load.
    // The dashboard emits these immediately after the websocket connects or
    // after `session:ready`; if we install handlers later, those one-shot
    // requests can be lost and the UI stays on "no session selected".
    socket.on('client:list_executors', (raw: ClientListExecutors) => {
      if (!vparse(schema.ClientListExecutorsSchema, raw, 'client:list_executors')) return
      socket.emit('server:executors', { executors: executorSnapshotFor(deps) })
    })

    socket.on('client:list_sessions', async (raw: ClientListSessions) => {
      if (!vparse(schema.ClientListSessionsSchema, raw, 'client:list_sessions')) return
      const sessions = withQueuedCounts(deps, await deps.store.listSummaries())
      socket.emit('server:sessions', { sessions })
      socket.emit('server:agent_runtimes', { runtimes: deps.agentRuntimes.catalog() })
    })

    socket.on('client:get_session_storage', async (
      raw: ClientGetSessionStorage,
      ack: (result: RpcAck<SessionStorageSnapshot>) => void,
    ) => {
      const p = vparse(
        schema.ClientGetSessionStorageSchema,
        raw,
        'client:get_session_storage',
        (raw as ClientGetSessionStorage | undefined)?.sessionId,
      )
      if (!p) {
        ack({ ok: false, error: 'invalid request' })
        return
      }
      try {
        if (!deps.storageInventory) throw new Error('storage inventory unavailable')
        const record = await loadRecordForDashboard(deps, p.sessionId)
        const accessError = validateIngressSessionAccess(socket, record)
        if (!record || accessError) throw new Error(accessError ?? 'unknown session')
        if (p.refresh) await deps.storageInventory.reconcile()
        const session = deps.storageInventory.getCachedTree(p.sessionId)
        if (!session) throw new Error('storage inventory has not measured this session yet')
        let descendants = deps.storageInventory.getCachedDescendants(p.sessionId)
        if (auditActor(socket).kind === 'ingress') {
          const allowed = new Set<string>()
          for (const descendant of descendants) {
            const child = await loadRecordForDashboard(deps, descendant.sessionId)
            if (!validateIngressSessionAccess(socket, child)) allowed.add(descendant.sessionId)
          }
          descendants = descendants.filter((descendant) => allowed.has(descendant.sessionId))
        }
        const descendantRecords = await Promise.all(descendants.map(async (descendant) => {
          const child = await loadRecordForDashboard(deps, descendant.sessionId)
          if (!child) throw new Error(`unknown descendant session: ${descendant.sessionId}`)
          return child
        }))
        ack({
          ok: true,
          value: {
            session: storageEntry(session),
            descendants: descendants.map((entry) => storageEntry(entry)),
            tokenUsage: sessionTreeTokenUsage(record, descendantRecords),
            state: deps.storageInventory.getCachedGlobal().state,
          },
        })
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    socket.on('client:get_global_storage', async (
      raw: ClientGetGlobalStorage,
      ack: (result: RpcAck<GlobalStorageSnapshot>) => void,
    ) => {
      const p = vparse(schema.ClientGetGlobalStorageSchema, raw, 'client:get_global_storage')
      if (!p) {
        ack({ ok: false, error: 'invalid request' })
        return
      }
      try {
        if (auditActor(socket).kind === 'ingress') throw new Error('global storage inventory is host-administrator only')
        if (!deps.storageInventory) throw new Error('storage inventory unavailable')
        if (p.refresh) await deps.storageInventory.reconcile()
        const global = deps.storageInventory.getCachedGlobal()
        const largestTrees = deps.storageInventory.getCachedLargestTrees()
        const summaries = new Map((await deps.store.listSummaries()).map((summary) => [summary.sessionId, summary]))
        ack({
          ok: true,
          value: {
            ...global,
            largestSessionTrees: largestTrees.map((entry) => storageEntry(entry, summaries.get(entry.sessionId))),
          },
        })
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    socket.on('client:prepare_storage_cleanup', async (
      raw: ClientPrepareStorageCleanup,
      ack: (result: RpcAck<StorageCleanupPlanPreview>) => void,
    ) => {
      const p = vparse(schema.ClientPrepareStorageCleanupSchema, raw, 'client:prepare_storage_cleanup')
      if (!p) {
        ack({ ok: false, error: 'invalid request' })
        return
      }
      try {
        if (!deps.safeCleanup) throw new Error('safe cleanup unavailable')
        const actor = auditActor(socket)
        if (actor.kind === 'ingress' && (p.operation === 'orphan-artifacts' || p.operation === 'derived-artifacts')) {
          throw new Error('host-wide cleanup is host-administrator only')
        }
        if (p.operation === 'subagent-details' || p.operation === 'session-tree') {
          const target = await loadRecordForDashboard(deps, p.targetId)
          const accessError = validateIngressSessionAccess(socket, target)
          if (!target || accessError) throw new Error(accessError ?? 'unknown session')
        }
        const plan = await deps.safeCleanup.prepare(p.operation, p.targetId, activeStorageSessions(deps))
        if (actor.kind === 'ingress') {
          for (const sessionId of plan.sessionIds) {
            const target = await loadRecordForCleanup(deps.store, sessionId)
            const accessError = validateIngressSessionAccess(socket, target)
            if (!target || accessError) throw new Error(accessError ?? 'cleanup plan crosses tenant boundary')
          }
        }
        cleanupPlans.set(plan.planId, {
          principal: operationPrincipal(socket.data.dashboardActor as DashboardActor | undefined),
          sessionIds: plan.sessionIds,
        })
        deps.audit?.log({
          action: 'dashboard.prepare_storage_cleanup',
          actor,
          target: { sessionId: p.targetId },
          outcome: 'ok',
          metadata: { planId: plan.planId, operation: plan.operation, estimatedBytes: plan.estimatedBytes },
        })
        ack({
          ok: true,
          value: {
            planId: plan.planId,
            operation: plan.operation,
            targetId: plan.targetId,
            sessionIds: plan.sessionIds,
            estimatedBytes: plan.estimatedBytes,
            itemCount: plan.manifest.length,
            expiresAt: plan.expiresAt,
          },
        })
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    socket.on('client:execute_storage_cleanup', async (
      raw: ClientExecuteStorageCleanup,
      ack: (result: RpcAck<StorageCleanupResult>) => void,
    ) => {
      const p = vparse(schema.ClientExecuteStorageCleanupSchema, raw, 'client:execute_storage_cleanup')
      if (!p) {
        ack({ ok: false, error: 'invalid request' })
        return
      }
      try {
        if (!deps.safeCleanup) throw new Error('safe cleanup unavailable')
        const principal = operationPrincipal(socket.data.dashboardActor as DashboardActor | undefined)
        const prepared = cleanupPlans.get(p.planId)
        if (!prepared || prepared.principal !== principal) throw new Error('cleanup plan is not owned by this principal')
        const records = (await Promise.all(prepared.sessionIds.map(async (sessionId) => await loadRecordForCleanup(deps.store, sessionId))))
          .filter((record): record is SessionRecord => record !== undefined)
        const result = await deps.safeCleanup.execute(p.planId, () => activeStorageSessions(deps))
        cleanupPlans.delete(p.planId)
        for (const record of records) {
          try {
            await deps.agentRuntimes.get(record.agentRuntime)?.delete?.(record)
          } catch (error) {
            emitPostCleanupWarning('runtime cleanup', record.sessionId, error)
          }
          if (deps.onSessionDeleted) {
            try {
              await deps.onSessionDeleted(record)
            } catch (error) {
              emitPostCleanupWarning('session deletion hook', record.sessionId, error)
            }
          }
          if (record.workspaceId) {
            deps.executors.closeSessionTerminals({ workspaceId: record.workspaceId, sessionId: record.sessionId })
            try {
              await deps.executors.deleteOverflowSession(record.workspaceId, record.sessionId)
            } catch (error) {
              emitPostCleanupWarning('overflow cleanup', record.sessionId, error)
            }
          }
          resetCompactRuntime(record.sessionId)
          ns.emit('server:session_deleted', { sessionId: record.sessionId })
        }
        try {
          await deps.storageInventory?.reconcile()
        } catch (error) {
          emitPostCleanupWarning('storage inventory reconcile', result.targetId, error)
        }
        ack({
          ok: true,
          value: {
            planId: result.planId,
            operation: result.operation,
            targetId: result.targetId,
            logicalDeletion: true,
            bytesQuarantined: result.bytesQuarantined,
            completedAt: result.completedAt,
          },
        })
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    socket.on('client:prepare_session_route', async (raw: ClientPrepareSessionRoute, ack: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientPrepareSessionRouteSchema, raw, 'client:prepare_session_route', (raw as ClientPrepareSessionRoute | undefined)?.sessionId)
      if (!p) { ack({ ok: false, error: 'invalid session route request' }); return }
      // Only the Unit-affine, authenticated control channel may initialize an
      // existing Session owner; a routed Session socket must not acquire others.
      if (!multiplexed || auditActor(socket).kind !== 'ingress'
        || !deps.loopDeps.assertSessionEffectOwner || !mutableRuntimeReady()) {
        ack({ ok: false, error: 'session route preparation unavailable' })
        return
      }
      try {
        const record = deps.store.get(p.sessionId)
          ?? await deps.store.load(p.sessionId, { recoverDangling: false })
        if (!record || validateIngressSessionAccess(socket, record)) {
          ack({ ok: false, error: 'session unavailable' })
          return
        }
        await deps.loopDeps.assertSessionEffectOwner(p.sessionId)
        ack({ ok: true })
      } catch {
        ack({ ok: false, error: 'session owner unavailable' })
      }
    })

    socket.on('client:load_history', async (raw: ClientLoadHistory) => {
      const p = vparse(schema.ClientLoadHistorySchema, raw, 'client:load_history', (raw as ClientLoadHistory | undefined)?.sessionId)
      if (!p) return
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) {
          try {
            target = await deps.store.load(p.sessionId, { recoverDangling: false })
          } catch {
            // Session hasn't been persisted yet — reply with an empty
            // history rather than broadcasting an error the dashboard would
            // render as a red banner. This is the expected state for a
            // freshly-connected new session.
            const empty: ServerHistoryPayload = {
              sessionId: p.sessionId,
              entries: [],
            }
            socket.emit('server:history', empty)
            return
          }
        }
        // External runtimes project their authoritative transcript through
        // snapshots and live events. Their JSONL may contain large legacy
        // runtime metadata, but no replayable Kernel events, so scanning it
        // here only delays control actions and can exhaust the Host heap.
        const parsed = target.agentRuntime === 'kernel'
          ? await deps.store.readHistory(target.sessionId)
          : { events: [], runtimeMetadata: [] }
        const since = p.sinceCursor ?? 0
        const compactionMetadataByReplaceRange = buildCompactionMetadataIndex(parsed.runtimeMetadata)
        const entries: EventAppendedEvent[] = parsed.events
          .filter((e) => e.seq > since)
          .map((e) => {
            const meta =
              e.event.kind === 'messages_replaced' && e.event.reason === 'compaction'
                ? consumeCompactionMetadata(compactionMetadataByReplaceRange, e.event.replaceRange)
                : undefined
            return {
              sessionId: p.sessionId,
              seq: e.seq,
              ts: e.ts,
              event: e.event,
              effects: e.effects,
              ...(e.effectsArtifact ? { hasEffectsArtifact: true } : {}),
              ...(e.llmTraceArtifact ? { hasLlmTraceArtifact: true } : {}),
              ...(e.llmTrace ? { llmTrace: e.llmTrace } : {}),
              ...(e.model ? { model: e.model } : {}),
              ...(e.timing ? { timing: e.timing } : {}),
              ...(meta ? { compactionMetadata: meta } : {}),
            }
          })
        const payload: ServerHistoryPayload = { sessionId: p.sessionId, entries }
        socket.emit('server:history', payload)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:load_log_artifact', async (raw: ClientLoadLogArtifact) => {
      const p = vparse(schema.ClientLoadLogArtifactSchema, raw, 'client:load_log_artifact', (raw as ClientLoadLogArtifact | undefined)?.sessionId)
      if (!p) return
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) target = await deps.store.load(p.sessionId, { recoverDangling: false })
        if (target.agentRuntime !== 'kernel') {
          socket.emit('server:log_artifact', { sessionId: p.sessionId, seq: p.seq, error: 'event not found' })
          return
        }
        const events = await deps.store.readEventEntries(target.sessionId)
        const entry = events.find((e) => e.seq === p.seq)
        if (!entry) {
          socket.emit('server:log_artifact', { sessionId: p.sessionId, seq: p.seq, error: 'event not found' })
          return
        }
        const payload: { effects?: unknown; llmTrace?: unknown } = {}
        if (deps.store.usesPostgresAuthority && (entry.effectsArtifact || entry.llmTraceArtifact)) {
          throw new Error('Local trace artifacts are unavailable with PostgreSQL Session authority')
        }
        if (entry.effectsArtifact) {
          payload.effects = await readJsonLogArtifact(target.logPath, entry.effectsArtifact.path)
        }
        if (entry.llmTraceArtifact) {
          payload.llmTrace = await readJsonLogArtifact(target.logPath, entry.llmTraceArtifact.path)
        } else if (entry.llmTrace) {
          payload.llmTrace = entry.llmTrace
        }
        socket.emit('server:log_artifact', {
          sessionId: p.sessionId,
          seq: p.seq,
          ...(payload.effects ? { effects: payload.effects as never } : {}),
          ...(payload.llmTrace ? { llmTrace: payload.llmTrace as never } : {}),
        })
      } catch (err) {
        socket.emit('server:log_artifact', {
          sessionId: p.sessionId,
          seq: p.seq,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    const channelTails = new Map<DashboardChannel, Promise<void>>()
    const channelGenerations = new Map<DashboardChannel, number>()
    const emitSessionReady = (payload: SessionReadyEvent): void => {
      const streamingDraft = payload.state.status === 'thinking' ? deps.streamingDraftSnapshot?.(payload.sessionId) : undefined
      socket.emit('session:ready', streamingDraft ? { ...payload, streamingDraft } : payload)
    }
    const serializeChannel = async <T>(channel: DashboardChannel, operation: () => Promise<T>): Promise<T> => {
      const previous = channelTails.get(channel) ?? Promise.resolve()
      let result!: T
      const current = previous.catch(() => undefined).then(async () => { result = await operation() })
      channelTails.set(channel, current)
      try { await current; return result } finally { if (channelTails.get(channel) === current) channelTails.delete(channel) }
    }

    const subscribeSession = async (targetSessionId: string, joinRoom = true): Promise<number> => {
      let target: SessionRecord | undefined
      try { target = await loadDashboardSession(deps.store, targetSessionId, getDefaultConfig()) } catch { target = undefined }
      const tenantError = validateIngressSessionAccess(socket, target)
      if (tenantError) throw new Error(tenantError)
      if (target) await refreshSessionSkillsIfNeeded(deps, target)
      if (joinRoom) {
        await socket.join(sessionRoom(targetSessionId))
        subscribedSessions.add(targetSessionId)
      }
      await deps.messageQueues.hydrate(targetSessionId)
      const defaultModel = effectiveDefaultModel(deps)
      const payload: SessionReadyEvent = target
        ? readyEventFor(target, effectiveModelForRecord(deps, target), 'load', contextWindowForSession(deps, target), runtimeCompactionPolicyFor(deps, target), runtimeCompactStatusFor(deps, target))
        : ephemeralReadyEventFor(targetSessionId, getDefaultConfig(), defaultModel, contextWindowForModelRef(deps, defaultModel))
      emitSessionReady(payload)
      socket.emit('server:message_queue', deps.messageQueues.snapshot(targetSessionId))
      // Candidate sockets may inspect the authoritative state during private
      // verification, but only the RestartCoordinator owns continuation before
      // the route-generation fence is publicly committed. A read subscription
      // must never become a second resume/drain path.
      if (joinRoom && mutableRuntimeReady()) {
        if (target?.agentRuntime === 'kernel' && !isRestingStatus(target.state.status)) void deps.loop.resumeSession(targetSessionId)
        void deps.messageQueues.drain(targetSessionId)
      }
      return payload.cursor
    }

    const channelResult = async (raw: ClientSubscribeChannels | ClientUnsubscribeChannels, remove: boolean): Promise<ChannelSubscriptionResult | undefined> => {
      const parsed = remove ? vparse(schema.ClientUnsubscribeChannelsSchema, raw, 'client:unsubscribe_channels') : vparse(schema.ClientSubscribeChannelsSchema, raw, 'client:subscribe_channels')
      if (!parsed) return undefined
      const accepted: DashboardChannel[] = [], rejected: Array<{ channel: DashboardChannel; code: string }> = [], cursors: Record<string, number> = {}
      const uniqueChannels = [...new Set(parsed.channels)]
      if (uniqueChannels.length > 128 || subscribedSessions.size + subscribedWorkspaces.size + uniqueChannels.length > 256) {
        return { requestId: parsed.requestId, generation: parsed.generation, accepted, rejected: uniqueChannels.map((channel) => ({ channel, code: 'subscription_limit' })), cursors }
      }
      for (const channel of uniqueChannels) {
        if (channel === 'global') { accepted.push(channel); continue }
        const [kind, id] = channel.split(':', 2) as ['workspace' | 'session', string]
        if (!id) { rejected.push({ channel, code: 'invalid_channel' }); continue }
        await serializeChannel(channel, async () => {
          const latestGeneration = channelGenerations.get(channel) ?? Number.NEGATIVE_INFINITY
          if (parsed.generation < latestGeneration) { rejected.push({ channel, code: 'stale_generation' }); return }
          channelGenerations.set(channel, parsed.generation)
          if (kind === 'workspace') { if (remove) subscribedWorkspaces.delete(id); else subscribedWorkspaces.add(id); accepted.push(channel); return }
          if (remove) { subscribedSessions.delete(id); await socket.leave(sessionRoom(id)); accepted.push(channel); return }
          // Every successful subscribe emits a fresh baseline, even when this
          // socket was already in the room. A new client-side selection
          // generation must never wait on a one-shot ready event from an older
          // binding.
          try {
            cursors[channel] = await subscribeSession(id); accepted.push(channel)
          } catch (err) {
            rejected.push({ channel, code: err instanceof Error ? err.message : String(err) })
          }
        })
      }
      return { requestId: parsed.requestId, generation: parsed.generation, accepted, rejected, cursors }
    }
    const refreshChannelResult = async (raw: ClientSubscribeChannels): Promise<ChannelSubscriptionResult | undefined> => {
      const parsed = vparse(schema.ClientSubscribeChannelsSchema, raw, 'client:refresh_channels')
      if (!parsed) return undefined
      const accepted: DashboardChannel[] = [], rejected: Array<{ channel: DashboardChannel; code: string }> = [], cursors: Record<string, number> = {}
      const uniqueChannels = [...new Set(parsed.channels)]
      if (uniqueChannels.length > 128) {
        return { requestId: parsed.requestId, generation: parsed.generation, accepted, rejected: uniqueChannels.map((channel) => ({ channel, code: 'subscription_limit' })), cursors }
      }
      for (const channel of uniqueChannels) {
        const [kind, id] = channel.split(':', 2) as ['workspace' | 'session', string]
        if (kind !== 'session' || !id) { rejected.push({ channel, code: 'invalid_channel' }); continue }
        await serializeChannel(channel, async () => {
          const latestGeneration = channelGenerations.get(channel) ?? Number.NEGATIVE_INFINITY
          if (parsed.generation < latestGeneration) { rejected.push({ channel, code: 'stale_generation' }); return }
          channelGenerations.set(channel, parsed.generation)
          if (!subscribedSessions.has(id)) { rejected.push({ channel, code: 'not_subscribed' }); return }
          try {
            // Emit the ready event before acknowledging, but do not join again:
            // this socket's existing room and all shared preview refs stay live.
            cursors[channel] = await subscribeSession(id, false)
            accepted.push(channel)
          } catch (err) {
            rejected.push({ channel, code: err instanceof Error ? err.message : String(err) })
          }
        })
      }
      return { requestId: parsed.requestId, generation: parsed.generation, accepted, rejected, cursors }
    }
    socket.on('client:subscribe_channels', async (raw, ack) => ack((await channelResult(raw, false)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))
    socket.on('client:refresh_channels', async (raw, ack) => ack((await refreshChannelResult(raw)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))
    socket.on('client:restore_subscriptions', async (raw, ack) => ack((await channelResult(raw, false)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))
    socket.on('client:unsubscribe_channels', async (raw, ack) => ack((await channelResult(raw, true)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))

    if (!multiplexed) {
    // Do NOT auto-create the session on connect. A dashboard opening a fresh
    // random UUID must not materialize a JSONL file on disk — otherwise
    // "click New" and "delete last session" both silently resurrect an empty
    // session behind the user's back. Lazy-create instead: the first
    // dispatched user event (`client:user_message` / `client:fork`) is what
    // commits a session to disk. Until then the dashboard sees an ephemeral
    // initial state.
    let record: SessionRecord | undefined
    try { record = await loadDashboardSession(deps.store, sessionId) } catch { record = undefined }
    if (record) await refreshSessionSkillsIfNeeded(deps, record)
    await socket.join(sessionRoom(sessionId))
    await deps.messageQueues.hydrate(sessionId)
    const defaultModel = effectiveDefaultModel(deps)
    const ready: SessionReadyEvent = record
      ? readyEventFor(record, effectiveModelForRecord(deps, record), 'load', contextWindowForSession(deps, record), runtimeCompactionPolicyFor(deps, record), runtimeCompactStatusFor(deps, record))
        : ephemeralReadyEventFor(
          sessionId,
          getDefaultConfig(),
          defaultModel,
          contextWindowForModelRef(deps, defaultModel),
        )
    emitSessionReady(ready)
    socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))
    // A service-manager restart has no persisted RestartCoordinator marker for
    // the active turn. Resume any dangling LLM/tool state on first hydration;
    // resumeSession is idempotent while a live serialized turn exists.
    if (mutableRuntimeReady()) {
      if (record?.agentRuntime === 'kernel' && !isRestingStatus(record.state.status)) void deps.loop.resumeSession(sessionId)
      void deps.messageQueues.drain(sessionId)
    }

    const desiredPreviewSessions = new Set<string>()
    socket.on('subscribe', async (raw: ClientSubscribe) => {
      const p = vparse(schema.ClientSubscribeSchema, raw, 'subscribe', (raw as ClientSubscribe | undefined)?.sessionId)
      if (!p) return
      const { sessionId } = p
      desiredPreviewSessions.add(sessionId)
      let target: SessionRecord | undefined
      try { target = await loadDashboardSession(deps.store, sessionId, getDefaultConfig()) } catch { target = undefined }
      const tenantError = validateIngressSessionAccess(socket, target)
      if (tenantError) {
        deps.audit?.log({ action: 'dashboard.subscribe', actor: auditActor(socket), target: { sessionId }, outcome: 'denied', error: tenantError })
        socket.emit('session:error', { sessionId, scope: 'host', message: tenantError })
        return
      }
      if (target) {
        await refreshSessionSkillsIfNeeded(deps, target)
      }
      if (!desiredPreviewSessions.has(sessionId)) return
      await socket.join(sessionRoom(sessionId))
      await deps.messageQueues.hydrate(sessionId)
      const defaultModel = effectiveDefaultModel(deps)
      const payload: SessionReadyEvent = target
        ? readyEventFor(target, effectiveModelForRecord(deps, target), 'load', contextWindowForSession(deps, target), runtimeCompactionPolicyFor(deps, target), runtimeCompactStatusFor(deps, target))
        : ephemeralReadyEventFor(
            sessionId,
            getDefaultConfig(),
            defaultModel,
            contextWindowForModelRef(deps, defaultModel),
          )
      emitSessionReady(payload)
      socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))
      if (mutableRuntimeReady()) {
        if (target?.agentRuntime === 'kernel' && !isRestingStatus(target.state.status)) void deps.loop.resumeSession(sessionId)
        void deps.messageQueues.drain(sessionId)
      }
    })

    socket.on('unsubscribe', async (raw: ClientUnsubscribe) => {
      const p = vparse(schema.ClientUnsubscribeSchema, raw, 'unsubscribe', (raw as ClientUnsubscribe | undefined)?.sessionId)
      if (!p || p.sessionId === sessionId) return
      desiredPreviewSessions.delete(p.sessionId)
      await socket.leave(sessionRoom(p.sessionId))
    })

    }

    socket.on('client:user_message', async (raw: ClientUserMessage, ack) => {
      const payloadError = validateClientMessagePayload(raw)
      if (payloadError) { ack?.({ ok: false, error: `${payloadError.code}: ${payloadError.message}` }); return }
      const p = vparse(schema.ClientUserMessageSchema, raw, 'client:user_message', (raw as ClientUserMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'INVALID_MESSAGE: invalid payload' }); return }
      const imageValidation = validateInlineMessageImages(p.content)
      if (!imageValidation.ok) { ack?.({ ok: false, error: `${imageValidation.error.code}: ${imageValidation.error.message}` }); return }
      const fileValidation = validateInlineMessageFiles(p.content)
      if (!fileValidation.ok) { ack?.({ ok: false, error: `${fileValidation.error.code}: ${fileValidation.error.message}` }); return }
      const result = await runOperation('client:user_message', p.sessionId, p.operationId, p, async () => {
        deps.audit?.log({ action: 'dashboard.user_message', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { messageBytes: Buffer.byteLength(p.text, 'utf8'), mode: p.mode ?? 'steer', intent: p.intent } })
        await handleUserMessage(deps, p, socket.data.dashboardActor as DashboardActor | undefined)
      })
      ack?.(result)
    })
    socket.on('client:user_approve', async (raw: ClientUserApprove) => {
      const p = vparse(schema.ClientUserApproveSchema, raw, 'client:user_approve', (raw as ClientUserApprove | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_approve', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      await safeRuntimeAction(deps, p.sessionId, (runtime, record) => runtime.approve(record, p.callId))
    })
    socket.on('client:user_reject', async (raw: ClientUserReject) => {
      const p = vparse(schema.ClientUserRejectSchema, raw, 'client:user_reject', (raw as ClientUserReject | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_reject', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok', metadata: { reasonBytes: p.reason ? Buffer.byteLength(p.reason, 'utf8') : 0 } })
      await safeRuntimeAction(deps, p.sessionId, (runtime, record) => runtime.reject(record, p.callId, p.reason))
    })
    socket.on('client:ask_user_choice', async (raw: ClientAskUserChoice, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientAskUserChoiceSchema, raw, 'client:ask_user_choice', (raw as ClientAskUserChoice | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid ask_user_choice payload' }); return }
      const result = await runOperation('client:ask_user_choice', p.sessionId, p.operationId, p, async () => {
        if (!deps.askUserChoice) throw new Error('ask_user_choice is not configured on this host')
        const response = p.customText !== undefined
          ? { kind: 'custom' as const, text: p.customText }
          : p.values !== undefined
            ? { kind: 'choices' as const, values: p.values }
            : { kind: 'choice' as const, value: p.value ?? '' }
        const resolved = deps.askUserChoice.respond(p.sessionId, p.callId, response)
        if (!resolved.ok && resolved.error === 'ask_user_choice request is not pending') {
          const record = await loadRecordForDashboard(deps, p.sessionId)
          const call = record?.state.pendingCalls.find((candidate) => (
            candidate.callId === p.callId
            && candidate.name === 'ask_user_choice'
            && (candidate.status === 'dispatched' || candidate.status === 'approved')
          ))
          const request = call ? askUserChoiceRequestFromPendingCall({
            sessionId: p.sessionId,
            callId: call.callId,
            name: call.name,
            input: call.input,
            intent: call.intent,
          }) : null
          if (!request) throw new Error('ask_user_choice request is not pending')
          const early = deps.askUserChoice.respondEarly(request, response)
          if (!early.ok) throw new Error(early.error)
          return
        }
        if (!resolved.ok) throw new Error(resolved.error)
      })
      // This ACK confirms broker acceptance only. Resolving the broker wakes the
      // agent continuation, but the continuation intentionally runs independently.
      ack?.(result)
      deps.audit?.log({
        action: 'dashboard.ask_user_choice',
        actor: auditActor(socket),
        target: { sessionId: p.sessionId, callId: p.callId },
        outcome: result.ok ? 'ok' : 'error',
        metadata: {
          responseType: p.customText !== undefined ? 'custom_text' : p.values !== undefined ? 'choices' : 'choice',
          ...(p.value !== undefined
            ? { value: p.value }
            : p.values !== undefined
              ? { valueCount: p.values.length }
              : { customTextBytes: Buffer.byteLength(p.customText ?? '', 'utf8') }),
        },
        ...(!result.ok ? { error: result.error } : {}),
      })
    })
    socket.on('client:cancel', async (raw: ClientCancel, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientCancelSchema, raw, 'client:cancel', (raw as ClientCancel | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid cancel payload' }); return }
      const result = await runOperation('client:cancel', p.sessionId, p.operationId, p, async () => {
        // Establish the queue boundary before cancelling the turn. Otherwise the
        // queue drainer can observe the resulting resting state and immediately
        // start a queued steer/follow-up, making Stop appear ineffective.
        await deps.messageQueues.stop(p.sessionId)
        // Host-owned bang-shell calls use the Executor registry even when the
        // Agent Runtime itself is external. Cancel those calls before cancelling
        // the Runtime so a stopped command cannot keep modifying the workspace.
        await deps.loopDeps.tools.cancelPending(p.sessionId)
        const record = await loadRecordForDashboard(deps, p.sessionId)
        if (!record) throw new Error('unknown session')
        await deps.agentRuntimes.require(record.agentRuntime).cancel(record)
      })
      ack?.(result)
      if (!result.ok) deps.broadcastError(p.sessionId, 'host', result.error)
    })
    socket.on('client:interrupt_sub_agent', async (raw: ClientInterruptSubAgent) => {
      const p = vparse(schema.ClientInterruptSubAgentSchema, raw, 'client:interrupt_sub_agent')
      if (!p) return
      try {
        const active = activeSubAgentFor(p.parentSessionId, p.parentCallId)
        if (!active) throw new Error('sub-agent is not running')
        if (p.childSessionId && active.childSessionId !== p.childSessionId) {
          throw new Error('sub-agent child session mismatch')
        }
        const child = await loadRecordForDashboard(deps, active.childSessionId)
        if (!child) throw new Error('unknown sub-agent session')
        // A late or repeated click after the child reached a terminal state is a
        // no-op; do not rewrite a naturally completed wrapper as cancelled.
        if (child.state.status === 'done' || child.state.status === 'error') return
        const runtime = deps.agentRuntimes.require(child.agentRuntime)
        // Kernel cancellation must mark first: its serialized dispatch can wait
        // for the agent tool wrapper to settle. External runtimes abort their
        // SDK generation/tools directly and can therefore confirm cancellation
        // before the wrapper tells the dashboard it was stopped.
        const result = child.agentRuntime === 'kernel'
          ? await (async () => {
              await deps.loopDeps.assertSessionEffectOwner?.(child.sessionId)
              const interrupted = markSubAgentInterrupted(p.parentSessionId, p.parentCallId, p.childSessionId)
              if (interrupted.ok) await runtime.cancel(child)
              return interrupted
            })()
          : await interruptSubAgentAfterRuntimeCancel(
              p.parentSessionId,
              p.parentCallId,
              p.childSessionId,
              async () => {
                await deps.loopDeps.assertSessionEffectOwner?.(child.sessionId)
                await runtime.cancel(child)
              },
            )
        if (!result.ok) {
          deps.broadcastError(p.parentSessionId, 'host', result.error ?? 'sub-agent interrupt failed')
          return
        }
      } catch (err) {
        deps.broadcastError(
          p.parentSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:clear', async (raw: ClientClear) => {
      const p = vparse(schema.ClientClearSchema, raw, 'client:clear', (raw as ClientClear | undefined)?.sessionId)
      if (!p) return
      try {
        if (!await requireRuntimeCapability(deps, p.sessionId, 'clear', 'clear')) return
        await deps.loopDeps.assertSessionEffectOwner?.(p.sessionId)
        await deps.loopDeps.tools.cancelPending(p.sessionId)
        await deps.loopDeps.assertSessionEffectOwner?.(p.sessionId)
        deps.loopDeps.askUserChoice?.cancelSession(p.sessionId, 'ask_user_choice request was cleared')
        deps.loop.cancelStream(p.sessionId)
        const evt: AgentEvent = { kind: 'clear' }
        await safeDispatch(deps, p.sessionId, evt)
        deps.audit?.log({ action: 'dashboard.session_clear', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok' })
      } catch (err) {
        deps.broadcastError(p.sessionId, 'host', err instanceof Error ? err.message : String(err))
      }
    })
    socket.on('client:compact', async (raw: ClientCompact) => {
      const p = vparse(schema.ClientCompactSchema, raw, 'client:compact', (raw as ClientCompact | undefined)?.sessionId)
      if (!p) return
      try {
        let record: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!record) {
          try {
            record = await deps.store.load(p.sessionId)
          } catch {
            record = undefined
          }
        }
        if (!record) {
          deps.broadcastError(
            p.sessionId,
            'host',
            'session not created — nothing to compact',
          )
          return
        }
        const runtime = deps.agentRuntimes.require(record.agentRuntime)
        if (!runtime.descriptor().capabilities.compact) {
          throw new Error(`${record.agentRuntime} sessions do not support compaction`)
        }
        deps.store.assertStorageWritable(record.sessionId)
        await deps.loopDeps.assertSessionEffectOwner?.(record.sessionId)
        await runtime.compact(record)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          deps.store.get(p.sessionId)?.agentRuntime === 'kernel' ? 'kernel' : 'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:cancel_stream', async (raw: ClientCancelStream) => {
      const p = vparse(schema.ClientCancelStreamSchema, raw, 'client:cancel_stream', (raw as ClientCancelStream | undefined)?.sessionId)
      if (!p) return
      // cancelStream remains a no-op when nothing is streaming, but ownership
      // loss is surfaced because this replica must not abort another owner's turn.
      try {
        const record = await requireRuntimeCapability(deps, p.sessionId, 'compact', 'stream cancellation')
        if (!record) return
        await deps.loopDeps.assertSessionEffectOwner?.(record.sessionId)
        deps.loop.cancelStream(record.sessionId)
      } catch (err) {
        deps.broadcastError(p.sessionId, 'host', err instanceof Error ? err.message : String(err))
      }
    })
    socket.on('client:set_approval_mode', async (raw: ClientSetApprovalMode, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientSetApprovalModeSchema, raw, 'client:set_approval_mode', (raw as ClientSetApprovalMode | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid approval mode request' }); return }
      // Host-owned guard rail. Portable and Dedicated composition enable this by
      // default; embedders may disable it explicitly. Executor installation and
      // environment never control Session approval policy.
      if (p.mode === 'allow_all' && deps.allowAllApprovalMode === false) {
        deps.audit?.log({ action: 'dashboard.approval_mode_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'denied', metadata: { mode: p.mode }, error: 'allow_all is disabled by the host' })
        deps.broadcastError(p.sessionId, 'host', 'approval mode "allow_all" is disabled by the host')
        ack?.({ ok: false, error: 'approval mode "allow_all" is disabled by the host' })
        return
      }
      const result = await runOperation('client:set_approval_mode', p.sessionId, p.operationId, p, async () => {
        const record = await loadRecordForDashboard(deps, p.sessionId)
        if (!record) throw new Error('unknown session')
        const runtime = deps.agentRuntimes.require(record.agentRuntime)
        await runtime.setApprovalMode(record, p.mode)
        // Changing to allow_all must also unblock calls already parked by the
        // previous mode; otherwise the selector appears to do nothing.
        if (p.mode === 'allow_all') {
          for (const call of record.state.pendingCalls) {
            if (call.status === 'awaiting_approval') {
              await runtime.approve(record, call.callId)
            }
          }
        }
      })
      ack?.(result)
      deps.audit?.log({ action: 'dashboard.approval_mode_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: result.ok ? 'ok' : 'error', metadata: { mode: p.mode }, ...(!result.ok ? { error: result.error } : {}) })
    })
    socket.on('client:set_cwd', async (raw: ClientSetCwd) => {
      const p = vparse(schema.ClientSetCwdSchema, raw, 'client:set_cwd', (raw as ClientSetCwd | undefined)?.sessionId)
      if (!p) return
      const record = await loadRecordForDashboard(deps, p.sessionId)
      if (!record) {
        deps.broadcastError(p.sessionId, 'host', 'unknown session')
        return
      }
      if (!deps.agentRuntimes.require(record.agentRuntime).descriptor().capabilities.cwdMutation) {
        deps.broadcastError(p.sessionId, 'host', `${record.agentRuntime} sessions do not support working-directory changes`)
        return
      }
      if (!isRestingStatus(record.state.status)) {
        deps.broadcastError(
          p.sessionId,
          'host',
          `cannot change cwd while session status is ${record.state.status}`,
        )
        return
      }
      const validation = await validateSessionCwd(deps, record, p.cwd)
      if (!validation.ok) {
        deps.audit?.log({ action: 'dashboard.cwd_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'denied', metadata: { cwd: p.cwd }, error: validation.reason })
        deps.broadcastError(p.sessionId, 'host', validation.reason)
        return
      }
      await safeDispatch(deps, p.sessionId, {
        kind: 'cwd_changed',
        cwd: validation.cwd,
      })
      deps.audit?.log({ action: 'dashboard.cwd_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { cwd: validation.cwd } })
      await broadcastSessionList(deps)
    })
    socket.on('client:reorder_queued_message', async (raw: ClientReorderQueuedMessage, ack) => {
      const p = vparse(schema.ClientReorderQueuedMessageSchema, raw, 'client:reorder_queued_message', (raw as ClientReorderQueuedMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid payload' }); return }
      if (!await requireRuntimeCapability(deps, p.sessionId, 'queue', 'message queues')) { ack?.({ ok: false, error: 'runtime does not support message queues' }); return }
      const result = await runOperation('client:reorder_queued_message', p.sessionId, p.operationId, p, () => deps.messageQueues.reorder(p.sessionId, p.id, p.beforeId))
      ack?.(result)
    })
    socket.on('client:update_queued_message', async (raw: ClientUpdateQueuedMessage, ack) => {
      const p = vparse(schema.ClientUpdateQueuedMessageSchema, raw, 'client:update_queued_message', (raw as ClientUpdateQueuedMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid payload' }); return }
      if (!await requireRuntimeCapability(deps, p.sessionId, 'queue', 'message queues')) { ack?.({ ok: false, error: 'runtime does not support message queues' }); return }
      const result = await runOperation('client:update_queued_message', p.sessionId, p.operationId, p, () => deps.messageQueues.update(p.sessionId, p.id, p.text, p.content))
      ack?.(result)
    })
    socket.on('client:delete_queued_message', async (raw: ClientDeleteQueuedMessage, ack) => {
      const p = vparse(schema.ClientDeleteQueuedMessageSchema, raw, 'client:delete_queued_message', (raw as ClientDeleteQueuedMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid payload' }); return }
      if (!await requireRuntimeCapability(deps, p.sessionId, 'queue', 'message queues')) { ack?.({ ok: false, error: 'runtime does not support message queues' }); return }
      const result = await runOperation('client:delete_queued_message', p.sessionId, p.operationId, p, () => deps.messageQueues.delete(p.sessionId, p.id))
      ack?.(result)
    })
    socket.on('client:rename_session', async (raw: ClientRenameSession) => {
      const p = vparse(schema.ClientRenameSessionSchema, raw, 'client:rename_session', (raw as ClientRenameSession | undefined)?.sessionId)
      if (!p) return
      try {
        const applied = await deps.store.rename(p.sessionId, p.label)
        deps.dashboardNs.emit('server:control_update', {
          kind: 'session_meta_changed',
          sessionId: p.sessionId,
          label: applied,
        })
        await broadcastSessionList(deps)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:rename_workspace', async (raw: ClientRenameWorkspace) => {
      const p = vparse(schema.ClientRenameWorkspaceSchema, raw, 'client:rename_workspace')
      if (!p) return
      try {
        const applied = deps.renameWorkspace
          ? await deps.renameWorkspace(p.workspaceId, p.workspaceName)
          : p.workspaceName.trim()
        deps.dashboardNs.emit('server:control_update', {
          kind: 'workspace_meta_changed',
          workspaceId: p.workspaceId,
          workspaceName: applied,
        })
        deps.dashboardNs.emit('server:executors', { executors: executorSnapshotFor(deps) })
        await broadcastSessionList(deps)
      } catch (err) {
        deps.broadcastError(
          p.workspaceId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:list_dirs', async (raw: ClientListDirs, ack?: (result: DirListResult) => void) => {
      const p = vparse(schema.ClientListDirsSchema, raw, 'client:list_dirs') as ClientListDirs | undefined
      if (!p) return
      const respond = (result: DirListResult): void => {
        socket.emit('server:dir_list', result)
        ack?.(result)
      }
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.list_dirs', p.sessionId, p.workspaceId, error)
          respond({ requestId: p.requestId, workspaceId: p.workspaceId, path: p.path ?? '', roots: [], entries: [], error })
          return
        }
      }
      deps.audit?.log({ action: 'internal_tool.list_dirs', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path } })
      const result = await deps.executors.listDirs(p.workspaceId, p.path, p.requestId)
      respond(result)
    })
    socket.on('client:create_directory', async (raw: ClientCreateDirectory, ack?: (result: CreateDirectoryResult) => void) => {
      const p = vparse(schema.ClientCreateDirectorySchema, raw, 'client:create_directory') as ClientCreateDirectory | undefined
      if (!p) return
      const deny = (error: string): void => ack?.({ requestId: p.requestId, workspaceId: p.workspaceId, path: p.parentPath, parentPath: p.parentPath, roots: [], created: false, error })
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.create_directory', p.sessionId, p.workspaceId, error)
          deny(error)
          return
        }
      }
      // Dedicated mode retains pre-session directory picking. Shared Runtimes
      // require a live bound owner even when the request omits sessionId.
      const ownerError = p.sessionId
        ? await validateEffectOwner(p.sessionId)
        : await validateWorkspaceEffectOwner(p.workspaceId)
      if (ownerError) {
        auditScopedAccessDenied('internal_tool.create_directory', p.sessionId ?? sessionId, p.workspaceId, ownerError)
        deny(ownerError)
        return
      }
      deps.audit?.log({ action: 'internal_tool.create_directory', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { parentPath: p.parentPath } })
      const result = await deps.executors.createDirectory(p.workspaceId, p.parentPath, p.name, p.requestId)
      ack?.(result)
    })
    socket.on('client:list_files', async (raw: ClientListFiles) => {
      const p = vparse(schema.ClientListFilesSchema, raw, 'client:list_files') as ClientListFiles | undefined
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.list_files', p.sessionId, p.workspaceId, error)
          socket.emit('server:file_list', { requestId: p.requestId, workspaceId: p.workspaceId, files: [], truncated: false, error })
          return
        }
      }
      const result = await deps.executors.listFiles(p)
      socket.emit('server:file_list', result)
    })
    // Generic dashboard-initiated workspace exec + binary read. See
    // docs/planning/roadmap-notes/workspace-exec-refactor.md for the
    // trust story: same sandbox rules as the agent-facing `bash`; the
    // difference is the actor (human at a dashboard button, not the LLM).
    // Audit records argv.slice(0, 3) so post-hoc review has a searchable
    // shape without unbounded metadata size.
    const desktopLeases = new Map<string, { workspaceId: string; sessionId: string; leaseId: string }>()
    let desktopWindow = Date.now()
    let desktopRequests = 0
    let desktopCapturePending = false
    const stopDesktopLease = async (lease: { workspaceId: string; sessionId: string; leaseId: string }) => {
      try {
        const result = await deps.executors.computerRequest({ ...lease, operation: 'stop', requestId: ulid() }, socket.id)
        if (result.error) throw new Error(result.error.message)
      } catch (error) {
        deps.audit?.log({ action: 'computer.disconnect', actor: auditActor(socket), target: { sessionId: lease.sessionId, workspaceId: lease.workspaceId }, outcome: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
    socket.on('disconnect', () => {
      for (const lease of desktopLeases.values()) {
        void stopDesktopLease(lease)
      }
      desktopLeases.clear()
    })
    socket.on('computer:request', async (raw, ack) => {
      if (typeof ack !== 'function') return
      const parsed = ComputerRequestSchema.safeParse(raw)
      if (!parsed.success) return ack({ requestId: typeof raw?.requestId === 'string' ? raw.requestId : '', error: { code: 'invalid_request', message: 'Invalid desktop request' } })
      const request = parsed.data
      const deny = (message: string) => ack({ requestId: request.requestId, error: { code: 'denied', message } })
      if (socket.data.readOnly === true) return deny('Desktop access requires runtime:write')
      const error = await validateBgSessionAccess(request.sessionId, request.workspaceId) ?? await validateEffectOwner(request.sessionId)
      if (error) {
        auditScopedAccessDenied('computer.request', request.sessionId, request.workspaceId, error)
        return deny(error)
      }
      if (!socket.connected) return deny('The desktop controller disconnected')
      const urgent = request.operation === 'stop' || (request.operation === 'agent' && !request.allowAgent)
      if (!urgent) {
        if (Date.now() - desktopWindow >= 1_000) { desktopWindow = Date.now(); desktopRequests = 0 }
        if (++desktopRequests > 60) return deny('Desktop request rate exceeded')
        if (request.operation === 'capture' && desktopCapturePending) return deny('A desktop capture is already in progress')
      }
      if (request.operation === 'capture') desktopCapturePending = true
      try {
        const result = await deps.executors.computerRequest(request, socket.id)
        if (request.operation === 'start' && result.leaseId) {
          const lease = { workspaceId: request.workspaceId, sessionId: request.sessionId, leaseId: result.leaseId }
          if (socket.connected) desktopLeases.set(request.workspaceId, lease)
          else await stopDesktopLease(lease)
        }
        if (request.operation === 'stop' && !result.error) desktopLeases.delete(request.workspaceId)
        if (request.operation !== 'capture' && request.operation !== 'status' && request.operation !== 'renew') {
          deps.audit?.log({ action: `computer.${request.operation}`, actor: auditActor(socket), target: { sessionId: request.sessionId, workspaceId: request.workspaceId }, outcome: result.error ? 'error' : 'ok', metadata: { ...(request.operation === 'input' ? { inputType: request.action.type } : {}), ...(request.operation === 'start' || request.operation === 'agent' ? { allowAgent: request.allowAgent } : {}) } })
        }
        ack(result)
      } catch (error) {
        deps.audit?.log({ action: 'computer.request', actor: auditActor(socket), target: { sessionId: request.sessionId, workspaceId: request.workspaceId }, outcome: 'error', error: error instanceof Error ? error.message : String(error) })
        ack({ requestId: request.requestId, error: { code: 'execution_error', message: 'Desktop request failed' } })
      } finally {
        if (request.operation === 'capture') desktopCapturePending = false
      }
    })
    socket.on('workspace:exec', async (raw: WorkspaceExecRequest, ack) => {
      // No zod schema in shared yet; validate minimally by hand.
      if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string' || typeof raw.workspaceId !== 'string' || !Array.isArray(raw.argv) || raw.argv.length === 0) {
        deps.audit?.log({ action: 'workspace.exec', actor: auditActor(socket), target: { workspaceId: raw?.workspaceId ?? 'unknown' }, outcome: 'denied', error: 'invalid payload' })
        return ack?.({ requestId: raw?.requestId ?? '', stdout: '', stderr: '', exitCode: null, durationMs: 0, error: { code: 'EINVAL', message: 'invalid payload' } })
      }
      if (multiplexed && !subscribedWorkspaces.has(raw.workspaceId)) {
        return ack?.({ requestId: raw.requestId, stdout: '', stderr: '', exitCode: null, durationMs: 0, error: { code: 'EACCES', message: 'workspace is not subscribed' } })
      }
      const workspaceError = await validateWorkspaceSocketAccess(raw.workspaceId) ?? await validateWorkspaceEffectOwner(raw.workspaceId)
      if (workspaceError) {
        deps.audit?.log({ action: 'workspace.exec', actor: auditActor(socket), target: { workspaceId: raw.workspaceId }, outcome: 'denied', error: workspaceError })
        return ack?.({ requestId: raw.requestId, stdout: '', stderr: '', exitCode: null, durationMs: 0, error: { code: 'EACCES', message: workspaceError } })
      }
      const argvHead = raw.argv.slice(0, 3).map((arg) => typeof arg === 'string' ? arg : String(arg))
      deps.audit?.log({
        action: 'workspace.exec',
        actor: auditActor(socket),
        target: { workspaceId: raw.workspaceId },
        outcome: 'ok',
        metadata: { argv: argvHead, cwd: raw.cwd ?? null },
      })
      const result = await deps.executors.workspaceExec(raw as WorkspaceExecRequest)
      ack?.(result)
    })
    socket.on('workspace:read_binary', async (raw: WorkspaceReadBinaryRequest, ack) => {
      if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string' || typeof raw.workspaceId !== 'string' || typeof raw.path !== 'string') {
        deps.audit?.log({ action: 'workspace.read_binary', actor: auditActor(socket), target: { workspaceId: raw?.workspaceId ?? 'unknown' }, outcome: 'denied', error: 'invalid payload' })
        return ack?.({ requestId: raw?.requestId ?? '', base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'EINVAL', message: 'invalid payload' } })
      }
      if (multiplexed && !subscribedWorkspaces.has(raw.workspaceId)) {
        return ack?.({ requestId: raw.requestId, base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'EACCES', message: 'workspace is not subscribed' } })
      }
      const workspaceError = await validateWorkspaceSocketAccess(raw.workspaceId)
      if (workspaceError) {
        deps.audit?.log({ action: 'workspace.read_binary', actor: auditActor(socket), target: { workspaceId: raw.workspaceId }, outcome: 'denied', error: workspaceError })
        return ack?.({ requestId: raw.requestId, base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'EACCES', message: workspaceError } })
      }
      deps.audit?.log({
        action: 'workspace.read_binary',
        actor: auditActor(socket),
        target: { workspaceId: raw.workspaceId },
        outcome: 'ok',
        metadata: { path: raw.path, cwd: raw.cwd ?? null },
      })
      const result = await deps.executors.workspaceReadBinary(raw as WorkspaceReadBinaryRequest)
      ack?.(result)
    })
    socket.on('client:read_overflow', async (raw: ClientReadOverflow) => {
      const p = vparse(schema.ClientReadOverflowSchema, raw, 'client:read_overflow', (raw as ClientReadOverflow | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'internal_tool.read_overflow', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      const record = deps.store.get(p.sessionId) ?? (await deps.store.load(p.sessionId, { recoverDangling: false }).catch(() => undefined))
      const tenantError = validateIngressSessionAccess(socket, record)
      if (tenantError) {
        deps.audit?.log({ action: 'internal_tool.read_overflow', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'denied', error: tenantError })
        socket.emit('server:overflow_contents', {
          requestId: p.requestId,
          sessionId: p.sessionId,
          callId: p.callId,
          error: tenantError,
        })
        return
      }
      const workspaceId = record?.workspaceId
      if (!workspaceId) {
        socket.emit('server:overflow_contents', {
          requestId: p.requestId,
          sessionId: p.sessionId,
          callId: p.callId,
          error: 'unknown session or session has no workspace',
        })
        return
      }
      const result = await deps.executors.readOverflow(p, workspaceId)
      socket.emit('server:overflow_contents', result)
    })
    socket.on('bg:list', async (raw: ClientListBgTasks, ack) => {
      const p = vparse(schema.ClientListBgTasksSchema, raw, 'bg:list', (raw as ClientListBgTasks | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.list', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, tasks: [], error })
      }
      const result = await deps.executors.listBg(p)
      ack(result)
    })
    socket.on('bg:output', async (raw: ClientReadBgOutput, ack) => {
      const p = vparse(schema.ClientReadBgOutputSchema, raw, 'bg:output', (raw as ClientReadBgOutput | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.output', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, taskId: p.taskId, content: '', nextOffset: 0, done: true, status: 'exited', bytesTruncated: 0, error })
      }
      const result = await deps.executors.readBg(p)
      ack(result)
    })
    socket.on('bg:kill', async (raw: ClientKillBgTask, ack) => {
      const p = vparse(schema.ClientKillBgTaskSchema, raw, 'bg:kill', (raw as ClientKillBgTask | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId) ?? await validateEffectOwner(p.sessionId)
      if (error) {
        auditScopedAccessDenied('background_task.kill', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, taskId: p.taskId, killed: false, error })
      }
      const result = await deps.executors.killBg(p)
      ack(result)
    })
    socket.on('terminal:create', async (raw: ClientTerminalCreate, ack) => {
      const p = vparse(schema.ClientTerminalCreateSchema, raw, 'terminal:create', (raw as ClientTerminalCreate | undefined)?.sessionId)
      if (!p) return
      const error = await validateTerminalSessionAccess(p.sessionId, p.workspaceId)
        ?? await validateEffectOwner(terminalOwnerSessionId(p.sessionId)!)
      if (error) {
        auditScopedAccessDenied('terminal.create', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, error })
      }
      const controller = new AbortController()
      const onDisconnect = (): void => controller.abort()
      socket.once('disconnect', onDisconnect)
      try {
        if (!socket.connected) controller.abort()
        const result = await deps.executors.createTerminal(p, controller.signal)
        ack(result)
      } finally {
        socket.off('disconnect', onDisconnect)
      }
    })
    socket.on('terminal:input', async (raw: ClientTerminalInput) => {
      const p = vparse(schema.ClientTerminalInputSchema, raw, 'terminal:input', (raw as ClientTerminalInput | undefined)?.sessionId)
      if (!p) return
      const error = await validateTerminalSessionAccess(p.sessionId, p.workspaceId)
        ?? await validateEffectOwner(terminalOwnerSessionId(p.sessionId)!)
      if (error) {
        auditScopedAccessDenied('terminal.input', p.sessionId, p.workspaceId, error)
        return
      }
      deps.executors.inputTerminal(p)
    })
    socket.on('terminal:resize', async (raw: ClientTerminalResize) => {
      const p = vparse(schema.ClientTerminalResizeSchema, raw, 'terminal:resize', (raw as ClientTerminalResize | undefined)?.sessionId)
      if (!p) return
      const error = await validateTerminalSessionAccess(p.sessionId, p.workspaceId)
        ?? await validateEffectOwner(terminalOwnerSessionId(p.sessionId)!)
      if (error) {
        auditScopedAccessDenied('terminal.resize', p.sessionId, p.workspaceId, error)
        return
      }
      deps.executors.resizeTerminal(p)
    })
    socket.on('terminal:kill', async (raw: ClientTerminalKill, ack) => {
      const p = vparse(schema.ClientTerminalKillSchema, raw, 'terminal:kill', (raw as ClientTerminalKill | undefined)?.sessionId)
      if (!p) return
      const error = await validateTerminalSessionAccess(p.sessionId, p.workspaceId)
        ?? await validateEffectOwner(terminalOwnerSessionId(p.sessionId)!)
      if (error) {
        auditScopedAccessDenied('terminal.kill', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, terminalId: p.terminalId, killed: false, error })
      }
      const result = await deps.executors.killTerminal(p)
      ack(result)
    })
    socket.on('sub_agent:list', async (raw: ClientListSubAgents, ack) => {
      const p = vparse(schema.ClientListSubAgentsSchema, raw, 'sub_agent:list')
      if (!p) return
      const children: SubAgentSummary[] = []
      const parent = deps.store.get(p.parentSessionId)
      for (const rec of await deps.store.listChildren(p.parentSessionId)) {
        const outcome = rec.parentCallId && parent
          ? recoverSubAgentOutcome(parent.state, rec.parentCallId)
          : undefined
        const active = rec.parentCallId
          ? activeSubAgentFor(p.parentSessionId, rec.parentCallId)
          : null
        const status: SubAgentSummary['status'] =
          outcome?.status ??
          (active?.cancelled
            ? 'cancelled'
            : rec.state.status === 'done'
            ? 'completed'
            : rec.state.status === 'error'
              ? 'failed'
              : 'running')
        const startedAt = rec.subAgentStartedAt
        const finishedAt = status !== 'running' ? rec.lastEventAt : undefined
        const durationMs = outcome?.durationMs ??
          (startedAt && finishedAt
            ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
            : undefined)
        children.push({
          childSessionId: rec.sessionId,
          ...(rec.parentCallId !== undefined ? { parentCallId: rec.parentCallId } : {}),
          ...(rec.agentType !== undefined ? { agentType: rec.agentType } : {}),
          status,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(finishedAt !== undefined ? { finishedAt } : {}),
          ...(outcome?.turns !== undefined ? { turns: outcome.turns } : {}),
          ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
          ...(outcome?.error
            ? { error: outcome.error }
            : status === 'failed' && rec.state.error
              ? { error: rec.state.error }
              : active?.cancelled && active.cancelReason
                ? { error: active.cancelReason }
                : {}),
        })
      }
      ack({ requestId: p.requestId, parentSessionId: p.parentSessionId, children })
    })
    socket.on('agent_types:list', (raw: ClientListAgentTypes, ack) => {
      const p = vparse(schema.ClientListAgentTypesSchema, raw, 'agent_types:list')
      if (!p) return
      ack({
        requestId: p.requestId,
        types: Object.values(SUB_AGENT_ROLE_TEMPLATES).map((template) => ({
          name: template.role,
          description: template.purpose,
          tools: [...template.defaultAllowedTools],
        })),
      })
    })
    socket.on('client:consolidate_memory', async (raw: ClientConsolidateMemory) => {
      const p = vparse(schema.ClientConsolidateMemorySchema, raw, 'client:consolidate_memory', (raw as ClientConsolidateMemory | undefined)?.sessionId)
      if (!p) return
      if (!await requireRuntimeCapability(deps, p.sessionId, 'memoryConsolidation', 'memory consolidation')) {
        socket.emit('server:memory_consolidated', {
          requestId: p.requestId,
          sessionId: p.sessionId,
          saved: [],
          skipped: 0,
          error: 'runtime does not support memory consolidation',
        })
        return
      }

      const record = deps.store.get(p.sessionId) ?? (await deps.store.load(p.sessionId, { recoverDangling: false }).catch(() => undefined))
      const accessError = (multiplexed ? !subscribedSessions.has(p.sessionId) : p.sessionId !== sessionId)
        ? 'session is not subscribed'
        : !record ? 'unknown session' : validateIngressSessionAccess(socket, record) ?? await validateEffectOwner(p.sessionId)
      if (accessError) {
        auditScopedAccessDenied('memory.consolidate', p.sessionId, '', accessError)
        socket.emit('server:memory_consolidated', { requestId: p.requestId, sessionId: p.sessionId, saved: [], skipped: 0, error: accessError })
        return
      }
      const extensions = deps.loopDeps.extensions ?? createBuiltinExtensionRegistry()
      const outcome = await extensions.consolidateMemory(deps.loopDeps, p.sessionId).catch(
        (err: unknown): ConsolidationOutcome => ({
          saved: [],
          skipped: 0,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      const payload = {
        requestId: p.requestId,
        sessionId: p.sessionId,
        saved: outcome.saved,
        skipped: outcome.skipped,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }
      socket.emit('server:memory_consolidated', payload)
    })
    socket.on('client:get_dag_run', async (raw: ClientGetDagRun, ack) => {
      const p = vparse(schema.ClientGetDagRunSchema, raw, 'client:get_dag_run', (raw as ClientGetDagRun | undefined)?.sessionId)
      if (!p) {
        ack({ ok: false, error: 'invalid payload' })
        return
      }
      const record = deps.store.get(p.sessionId)
      const accessError = validateIngressSessionAccess(socket, record)
      if (accessError) {
        ack({ ok: false, error: accessError })
        return
      }
      ack({ ok: true, value: deps.dagStore ? await deps.dagStore.runForSession(p.sessionId) ?? null : null })
    })
    socket.on('client:list_dag_runs', async (raw: ClientListDagRuns, ack) => {
      const p = vparse(schema.ClientListDagRunsSchema, raw, 'client:list_dag_runs', (raw as ClientListDagRuns | undefined)?.sessionId)
      if (!p) {
        ack({ ok: false, error: 'invalid payload' })
        return
      }
      const record = deps.store.get(p.sessionId)
      const accessError = validateIngressSessionAccess(socket, record)
      if (accessError) {
        ack({ ok: false, error: accessError })
        return
      }
      ack({ ok: true, value: deps.dagStore ? await deps.dagStore.runsForSession(p.sessionId) : [] })
    })
    socket.on('client:initialize_dag', async (raw: ClientInitializeDag, ack) => {
      const p = vparse(schema.ClientInitializeDagSchema, raw, 'client:initialize_dag', (raw as ClientInitializeDag | undefined)?.sessionId)
      if (!p) {
        ack({ ok: false, error: 'invalid payload' })
        return
      }
      try {
        if (!deps.dagStore) throw new Error('DAG store is unavailable')
        const record = deps.store.get(p.sessionId)
        if (!record) throw new Error('Session is unavailable')
        const accessError = validateIngressSessionAccess(socket, record)
        if (accessError) throw new Error(accessError)
        if (record.executionMode !== 'dag') throw new Error('Session is not in DAG-First mode')
        const run = await deps.dagStore.createRun(p.sessionId, p.objective, `${p.operationId}:run`)
        const updated = await deps.dagStore.installGraph(run.id, p.graph, `${p.operationId}:graph`)
        deps.dashboardNs.to(sessionRoom(p.sessionId)).emit('server:dag_run', { sessionId: p.sessionId, run: updated })
        deps.loopDeps.dagScheduler?.schedule(p.sessionId)
        ack({ ok: true, value: updated })
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    socket.on('client:answer_dag_decision', async (raw: ClientAnswerDagDecision, ack) => {
      const p = vparse(schema.ClientAnswerDagDecisionSchema, raw, 'client:answer_dag_decision', (raw as ClientAnswerDagDecision | undefined)?.sessionId)
      if (!p) {
        ack({ ok: false, error: 'invalid payload' })
        return
      }
      try {
        if (!deps.dagStore) throw new Error('DAG store is unavailable')
        const record = deps.store.get(p.sessionId)
        if (!record) throw new Error('Session is unavailable')
        const accessError = validateIngressSessionAccess(socket, record)
        if (accessError) throw new Error(accessError)
        const run = await deps.dagStore.runForSession(p.sessionId)
        if (!run || run.id !== p.runId) throw new Error('DAG run is unavailable')
        const updated = await deps.dagStore.answerDecision(p.runId, p.decisionId, p.answer, p.operationId)
        deps.dashboardNs.to(sessionRoom(p.sessionId)).emit('server:dag_run', { sessionId: p.sessionId, run: updated })
        deps.loopDeps.dagScheduler?.schedule(p.sessionId)
        ack({ ok: true, value: updated })
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    socket.on('client:create_session', async (raw: ClientCreateSession, ack) => {
      const parsed = vparse(schema.ClientCreateSessionSchema, raw, 'client:create_session', (raw as ClientCreateSession | undefined)?.sessionId)
      if (!parsed) { ack?.({ ok: false, error: 'invalid payload' }); return }
      let p: ClientCreateSession = parsed
      try {
        const agentRuntime = p.agentRuntime ?? 'kernel'
        const executionMode = p.executionMode ?? 'chat'
        const registeredMode = deps.loopDeps.extensions?.getSessionMode(executionMode)
        if (!registeredMode) {
          ack?.({ ok: false, error: `unsupported session execution mode: ${executionMode}` })
          return
        }
        const runtime = deps.agentRuntimes.require(agentRuntime)
        const selectedModel = p.selectedModel?.trim()
        const normalizedSelectedModel = agentRuntime === 'kernel' && selectedModel
          ? normalizeIncomingModel(deps, selectedModel)
          : selectedModel
        if (selectedModel && !normalizedSelectedModel) {
          const message = `unknown or ambiguous model: ${selectedModel}`
          socket.emit('session:error', { sessionId: p.sessionId, scope: 'host', message })
          ack?.({ ok: false, error: message })
          return
        }
        const actor = socket.data.dashboardActor as DashboardActor
        if (normalizedSelectedModel) {
          await assertTenantModelAllowed(deps, actor, p.sessionId, normalizedSelectedModel)
        }
        const cwd = p.cwd?.trim()
        if (cwd && cwd.length > 0 && p.workspaceId) {
          const validation = await validateWorkspaceCwd(deps, p.workspaceId, cwd)
          if (!validation.ok) {
            deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: p.sessionId, workspaceId: p.workspaceId }, outcome: 'denied', metadata: { cwd }, error: validation.reason })
            socket.emit('session:error', {
              sessionId: p.sessionId,
              scope: 'host',
              message: validation.reason,
            })
            ack?.({ ok: false, error: validation.reason })
            return
          }
          p = { ...p, cwd: validation.cwd }
        }
        if (deps.sessionQuota) {
          if (actor.kind !== 'ingress') {
            throw new Error('missing organization attribution for session quota enforcement')
          }
          await deps.sessionQuota.assertCanCreateSession({
            organizationId: actor.organizationId,
            principal: actor.principal,
            role: actor.role,
            sessionId: p.sessionId,
          })
        }
        const sessionBaseConfig = mergeMcpTools(
          getDefaultConfig(actor),
          mcpToolsForWorkspace(executorSnapshotFor(deps), p.workspaceId),
        )
        const sessionConfig = deriveSessionConfig(sessionBaseConfig, p.tools, executionMode)
        const { record, created } = await deps.store.ensure({
          sessionId: p.sessionId,
          agentRuntime,
          executionMode,
          ...(runtime.descriptor().version ? { agentRuntimeVersion: runtime.descriptor().version } : {}),
          ...(agentRuntime === 'copilot' ? { externalSessionId: p.sessionId } : {}),
          defaultConfig: sessionConfig,
          runtimeConfig: sessionConfig,
          ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
          ...(p.workspaceName !== undefined
            ? { workspaceName: p.workspaceName }
            : {}),
          ...(actor.kind === 'ingress'
            ? {
                organizationId: actor.organizationId,
                principal: actor.principal,
                organizationRole: actor.role,
              }
            : {}),
          ...(p.cwd !== undefined ? { initialCwd: p.cwd } : {}),
          ...(normalizedSelectedModel !== undefined ? { preferences: { selectedModel: normalizedSelectedModel } } : {}),
        })
        // `ensure` is the durable commit point. Acknowledge immediately so a
        // slow Session-list refresh, skill scan, or advisory lifecycle hook can
        // never turn a successful create into a client-visible timeout.
        ack?.({ ok: true })
        void (async () => {
          try {
            await refreshSessionSkillsIfNeeded(deps, record)
            await socket.join(sessionRoom(record.sessionId))
            emitSessionReady(readyEventFor(record, effectiveModelForRecord(deps, record), created ? 'created' : 'load', contextWindowForSession(deps, record), runtimeCompactionPolicyFor(deps, record), runtimeCompactStatusFor(deps, record)))
            if (!created) return
            deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: record.sessionId, workspaceId: record.workspaceId }, outcome: 'ok', metadata: { cwd: record.state.cwd } })
            await broadcastSessionList(deps)
            void Promise.resolve(deps.onSessionCreated?.(record)).catch(() => {})
          } catch (error) {
            deps.broadcastError(record.sessionId, 'host', error instanceof Error ? error.message : String(error))
          }
        })()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.broadcastError(p.sessionId, 'host', message)
        ack?.({ ok: false, error: message })
      }
    })

    socket.on('client:fork', async (raw: ClientFork) => {
      const p = vparse(schema.ClientForkSchema, raw, 'client:fork', (raw as ClientFork | undefined)?.sourceSessionId)
      if (!p) return
      try {
        const source = await deps.store.load(p.sourceSessionId)
        if (source.executionMode === 'dag') {
          throw new Error('DAG-First Sessions cannot be forked; create a new DAG-First Session instead')
        }
        if (!deps.agentRuntimes.require(source.agentRuntime).descriptor().capabilities.fork) {
          throw new Error(`${source.agentRuntime} sessions do not support fork`)
        }
        const accessError = validateIngressSessionAccess(socket, source)
        if (accessError) throw new Error(accessError)
        await deps.loopDeps.assertSessionEffectOwner?.(source.sessionId)
        const newId = p.newSessionId ?? ulid()
        const parentModel = effectiveModelForRecord(deps, source)
        const record = await deps.store.fork({
          sourceSessionId: source.sessionId,
          cursor: p.cursor,
          sessionId: newId,
          ...(parentModel ? { preferences: { selectedModel: parentModel } } : {}),
        })
        await refreshSessionSkillsIfNeeded(deps, record)
        if (source.workspaceId) {
          await deps.executors.copyOverflowSession(
            source.workspaceId,
            p.sourceSessionId,
            record.sessionId,
          ).catch(() => undefined)
        }
        await socket.join(sessionRoom(record.sessionId))
        const forked: SessionReadyEvent = {
          sessionId: record.sessionId,
          agentRuntime: 'kernel',
          executionMode: record.executionMode,
          agentRuntimeCapabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
          runtimeCompactionPolicy: kernelRuntimeCompactionPolicy(
            record.config.softThreshold,
            record.config.hardThreshold,
          ),
          reason: 'forked',
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          cursor: record.state.cursor,
          state: record.state,
          config: record.config,
          contextSnapshot: record.runtimeContextSnapshot
            ?? contextSnapshot(record, record.state.messages, contextWindowForSession(deps, record), parentModel),
          ...(record.turnStartedAt ? { turnStartedAt: record.turnStartedAt } : {}),
          ...(parentModel ? { selectedModel: parentModel } : {}),
          ...(record.workspaceId !== undefined
            ? { workspaceId: record.workspaceId }
            : {}),
          ...(record.workspaceName !== undefined
            ? { workspaceName: record.workspaceName }
            : {}),
        }
        socket.emit('session:ready', forked)
        deps.audit?.log({ action: 'dashboard.session_fork', actor: auditActor(socket), target: { sessionId: record.sessionId, sourceSessionId: p.sourceSessionId }, outcome: 'ok', refs: { parentCursor: p.cursor } })
        await broadcastSessionList(deps)
        if (typeof p.seedMessage === 'string' && p.seedMessage.trim().length > 0) {
          await deps.loop.dispatch(record.sessionId, {
            kind: 'user_message',
            text: p.seedMessage,
          }, parentModel ? { model: parentModel } : undefined)
        }
      } catch (err) {
        deps.broadcastError(
          p.sourceSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:delete_session', async (raw: ClientDeleteSession, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientDeleteSessionSchema, raw, 'client:delete_session', (raw as ClientDeleteSession | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid delete session request' }); return }
      const result = await runOperation('client:delete_session', p.sessionId, p.operationId, p, async () => {
        // A child Session has no independent lifecycle: deleting its root while
        // retaining descendants produces unreachable sub-agent records. Resolve
        // the complete tree first, reject the whole operation if any member is
        // active, then delete leaves before their parents.
        const targetIds = collectSessionDescendants(await deps.store.listSummaries(), p.sessionId)
        for (const targetSessionId of targetIds) {
          // A descendant can run on another replica even when no local Loop
          // turn exists. Abort the entire tree before any external cleanup.
          await deps.loopDeps.assertSessionEffectOwner?.(targetSessionId)
          if (deps.loop.hasActiveTurn(targetSessionId)) throw new Error('session tree has an active turn; stop it before deleting')
        }
        for (const targetSessionId of targetIds.reverse()) {
          await deps.loopDeps.assertSessionEffectOwner?.(targetSessionId)
          const record = deps.store.get(targetSessionId) ?? (await deps.store.load(targetSessionId).catch(() => undefined))
          // The PostgreSQL tombstone is the global routing/write barrier. Commit
          // it before any non-transactional Queue, Executor or Runtime cleanup.
          if (deps.store.usesExternalAuthority && !await deps.store.requestDeletion(targetSessionId)) continue
          await deps.messageQueues.stop(targetSessionId)
          await deps.loopDeps.tools.cancelPending(targetSessionId)
          if (record) await deps.agentRuntimes.get(record.agentRuntime)?.delete?.(record)
          if (record && deps.onSessionDeleted) {
            try {
              await deps.onSessionDeleted(record)
            } catch {
              // Lifecycle hook errors are advisory — swallow.
            }
          }
          if (record?.workspaceId) {
            deps.executors.closeSessionTerminals({ workspaceId: record.workspaceId, sessionId: targetSessionId })
            await deps.executors.deleteOverflowSession(record.workspaceId, targetSessionId).catch(() => undefined)
          }
          await deps.store.delete(targetSessionId)
          resetCompactRuntime(targetSessionId)
          deps.audit?.log({ action: 'dashboard.session_delete', actor: auditActor(socket), target: { sessionId: targetSessionId, workspaceId: record?.workspaceId }, outcome: 'ok', refs: { rootSessionId: p.sessionId } })
          ns.emit('server:session_deleted', { sessionId: targetSessionId })
        }
      })
      ack?.(result)
      if (!result.ok) deps.broadcastError(p.sessionId, 'host', result.error)
    })

    socket.on('client:update_preferences', async (raw, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientUpdatePreferencesSchema, raw, 'client:update_preferences', (raw as { sessionId?: string } | undefined)?.sessionId)
      if (!p) {
        ack?.({ ok: false, error: 'invalid preferences update' })
        return
      }
      const result = await runOperation('client:update_preferences', p.sessionId, p.operationId, p, async () => {
        if ('selectedModel' in p.preferences) {
          if (!await requireRuntimeCapability(deps, p.sessionId, 'modelSelection', 'model selection')) {
            throw new Error('model selection is unavailable for this Session Runtime')
          }
        }
        await applyPreferencesUpdate(deps, p.sessionId, p.preferences, auditActor(socket))
        if ('selectedModel' in p.preferences) {
          deps.audit?.log({ action: 'dashboard.model_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { model: p.preferences.selectedModel?.trim() ?? '' } })
        }
      })
      ack?.(result)
      if (!result.ok) deps.broadcastError(p.sessionId, 'host', result.error)
    })
    })().catch((error: unknown) => {
      if (!socket.connected) return
      const auth = socket.handshake.auth as HandshakeAuth
      deps.audit?.log({ action: 'dashboard.socket_init_error', actor: auditActor(socket), target: { sessionId: auth.sessionId ?? `control:${auth.clientId}` }, outcome: 'error', error: error instanceof Error ? error.message : String(error) })
      socket.disconnect(true)
    })
  })
}

function executorSnapshotFor(deps: DashboardDeps): readonly AttachedExecutor[] {
  return deps.executorSnapshot ? deps.executorSnapshot() : deps.executors.snapshot()
}

export function deriveSessionConfig(
  base: AgentConfig,
  toolAllowlist: readonly string[] | undefined,
  executionMode: import('@agent-kernel/shared').SessionExecutionMode = 'chat',
): AgentConfig {
  const tools = toolAllowlist
    ? base.tools.filter((tool) => toolAllowlist.includes(tool.name))
    : [...base.tools]
  if (executionMode === 'chat') return { ...base, tools }
  const plannerTools = tools.filter((tool) => tool.name === 'ask_user_choice' || tool.name === DAG_PLAN_TOOL.name)
  return {
    ...base,
    systemPrompt: `${base.systemPrompt}\n\n${DAG_PLANNER_INSTRUCTION}`,
    tools: plannerTools.some((tool) => tool.name === DAG_PLAN_TOOL.name) ? plannerTools : [...plannerTools, DAG_PLAN_TOOL],
  }
}

async function refreshSessionSkillsIfNeeded(
  deps: DashboardDeps,
  record: SessionRecord,
): Promise<void> {
  await (deps.loopDeps.extensions ?? createBuiltinExtensionRegistry())
    .sessionLoaded({ deps: deps.loopDeps, record })
}

function storageEntry(entry: {
  sessionId: string
  parentSessionId?: string
  runtime?: string
  directBytes: number
  treeBytes: number
  descendantCount: number
  categories: SessionStorageEntry['categories']
  treeCategories: SessionStorageEntry['treeCategories']
}, summary?: Pick<SessionSummary, 'label' | 'firstUserMessage' | 'workspaceId' | 'workspaceName'>): SessionStorageEntry {
  const sessionLabel = summary?.label?.trim() || summary?.firstUserMessage?.trim()
  return {
    sessionId: entry.sessionId,
    ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(sessionLabel ? { sessionLabel } : {}),
    ...(summary?.workspaceId ? { workspaceId: summary.workspaceId } : {}),
    ...(summary?.workspaceName ? { workspaceName: summary.workspaceName } : {}),
    directBytes: entry.directBytes,
    treeBytes: entry.treeBytes,
    descendantCount: entry.descendantCount,
    categories: entry.categories,
    treeCategories: entry.treeCategories,
  }
}

export function sessionTreeTokenUsage(
  record: SessionRecord,
  descendants: readonly SessionRecord[],
): NonNullable<SessionStorageSnapshot['tokenUsage']> {
  const direct = sessionTokenUsage(record)
  const tree = descendants.reduce<SessionTokenUsage>(
    (total, descendant) => addSessionTokenUsage(total, sessionTokenUsage(descendant)),
    direct,
  )
  return { direct, tree }
}

function sessionTokenUsage(record: SessionRecord): SessionTokenUsage {
  const usage = record.state.usage
  const currentContextTokens = (
    record.runtimeContextSnapshot ?? contextSnapshot(record)
  ).usage.totalTokens
  return {
    currentContextTokens,
    cumulativeInputTokens: usage.inputTokens,
    cumulativeOutputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    sessionCount: 1,
  }
}

function addSessionTokenUsage(left: SessionTokenUsage, right: SessionTokenUsage): SessionTokenUsage {
  return {
    currentContextTokens: left.currentContextTokens + right.currentContextTokens,
    cumulativeInputTokens: left.cumulativeInputTokens + right.cumulativeInputTokens,
    cumulativeOutputTokens: left.cumulativeOutputTokens + right.cumulativeOutputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    sessionCount: left.sessionCount + right.sessionCount,
  }
}

function activeStorageSessions(deps: DashboardDeps): ReadonlySet<string> {
  return new Set(
    deps.store.list()
      .filter((record) => (
        !isRestingStatus(record.state.status)
        || deps.agentRuntimes.get(record.agentRuntime)?.currentCompactStatus?.(record.sessionId)?.kind === 'running'
      ))
      .map((record) => record.sessionId),
  )
}

function emitPostCleanupWarning(action: string, sessionId: string, error: unknown): void {
  process.emitWarning(
    `${action} failed after storage cleanup committed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    { code: 'KALA_POST_CLEANUP' },
  )
}

function auditActor(socket: { data: Record<string, unknown> }): AuditActor {
  const actor = socket.data.dashboardActor as AuditActor | undefined
  return actor ?? { kind: 'anonymous' }
}

function operationPrincipal(actor: DashboardActor | undefined): string {
  if (!actor || actor.kind === 'anonymous') return 'anonymous'
  if (actor.kind === 'token') return 'token'
  if (actor.kind === 'github_user') return `github:${actor.id ?? actor.login}`
  return `ingress:${actor.organizationId}:${actor.principal}`
}

function validateIngressSessionAccess(
  socket: { data: Record<string, unknown> },
  record: SessionRecord | undefined,
): string | undefined {
  const actor = auditActor(socket)
  if (actor.kind !== 'ingress' || !record) return undefined
  if (!record.organizationId) return 'tenant_attribution_missing'
  return record.organizationId === actor.organizationId ? undefined : 'tenant_forbidden'
}

async function assertTenantModelAllowed(
  deps: DashboardDeps,
  actor: AuditActor,
  sessionId: string,
  model: string,
): Promise<void> {
  if (!deps.modelPolicy) return
  if (actor.kind !== 'ingress') throw new Error('missing organization attribution for model policy enforcement')
  await deps.modelPolicy.assertCanUseModel({
    organizationId: actor.organizationId,
    sessionId,
    model,
    principal: actor.principal,
  })
}

function auditConnectionMeta(meta: ConnectionMeta): Record<string, unknown> {
  return {
    connectionKind: meta.kind,
    connectionLabel: meta.label,
    clientVersion: meta.clientVersion,
  }
}

/**
 * Apply a partial preferences patch. Empty string on `selectedModel` clears
 * it (back to the host default) and emits a control-plane update.
 */
async function applyPreferencesUpdate(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferencesPatch,
  actor: AuditActor = { kind: 'anonymous' },
): Promise<void> {
  const normalizedPatch = normalizePreferencesPatch(deps, sessionId, patch)
  if (!normalizedPatch) throw new Error('invalid Session preferences')
  const record = deps.store.get(sessionId)
  const previousModel = record?.preferences.selectedModel
  const requestedModel = normalizedPatch.selectedModel
  if (requestedModel) await assertTenantModelAllowed(deps, actor, sessionId, requestedModel)
  const runtime = record?.agentRuntime === 'copilot' ? deps.agentRuntimes.require('copilot') : undefined
  if (record?.agentRuntime === 'copilot' && normalizedPatch.selectedModel) {
    await runtime?.setModel?.(record, normalizedPatch.selectedModel)
  }
  let effective: import('@agent-kernel/shared').SessionPreferences
  try {
    effective = await deps.store.updatePreferences(sessionId, normalizedPatch)
  } catch (error) {
    const rollbackModel = previousModel
      ?? runtime?.descriptor().models?.find((model) => model.id === 'auto' || model.ref === 'auto')?.ref
    if (record && requestedModel && rollbackModel && rollbackModel !== requestedModel) {
      try {
        await runtime?.setModel?.(record, rollbackModel)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to persist model ${requestedModel} and failed to restore ${rollbackModel}`,
        )
      }
    }
    throw error
  }
  deps.dashboardNs.emit('server:control_update', {
    kind: 'session_meta_changed',
    sessionId,
    preferences: effective,
  })
  if (record && runtime && requestedModel && previousModel !== requestedModel) {
    try {
      await runtime.confirmModelChange?.(record, previousModel, requestedModel)
    } catch (error) {
      deps.broadcastError(sessionId, 'host', `model changed, but its transcript notice could not be persisted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const updatedRecord = deps.store.get(sessionId)
  if (updatedRecord) {
    deps.dashboardNs.to(sessionRoom(sessionId)).emit('state:changed', {
      sessionId,
      cursor: updatedRecord.state.cursor,
      state: updatedRecord.state,
      contextSnapshot: contextSnapshot(updatedRecord, updatedRecord.state.messages, contextWindowForSession(deps, updatedRecord), effectiveModelForRecord(deps, updatedRecord)),
      ...(updatedRecord.turnStartedAt ? { turnStartedAt: updatedRecord.turnStartedAt } : {}),
    })
  }
}

function contextWindowForSession(deps: DashboardDeps, record: SessionRecord): ContextWindowOverride | undefined {
  return deps.contextWindowForModel?.(effectiveModelForRecord(deps, record))
}

function contextWindowForModelRef(deps: DashboardDeps, model: string | undefined): ContextWindowOverride | undefined {
  return deps.contextWindowForModel?.(model)
}

function selectedModelForRecord(record: SessionRecord): string | undefined {
  return record.preferences.selectedModel
}

function effectiveModelForRecord(deps: DashboardDeps, record: SessionRecord): string | undefined {
  return deps.effectiveModelForSession?.(record) ?? selectedModelForRecord(record)
}

function effectiveDefaultModel(deps: DashboardDeps): string | undefined {
  return deps.effectiveDefaultModel?.()
}

function normalizePreferencesPatch(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferencesPatch,
): import('@agent-kernel/shared').SessionPreferencesPatch | null {
  if (!('selectedModel' in patch)) return patch
  const selectedModel = patch.selectedModel?.trim()
  if (!selectedModel) return { ...patch, selectedModel: '' }
  const record = deps.store.get(sessionId)
  if (record?.agentRuntime === 'copilot') {
    const models = deps.agentRuntimes.get('copilot')?.descriptor().models ?? []
    const exact = models.find((model) => model.ref === selectedModel || model.id === selectedModel)
    if (!exact) {
      deps.broadcastError(sessionId, 'host', `unknown Copilot model: ${selectedModel}`)
      return null
    }
    return { ...patch, selectedModel: exact.ref }
  }
  const normalized = normalizeIncomingModel(deps, selectedModel)
  if (!normalized) {
    deps.broadcastError(sessionId, 'host', `unknown or ambiguous model: ${selectedModel}`)
    return null
  }
  return { ...patch, selectedModel: normalized }
}

function normalizeIncomingModel(deps: DashboardDeps, model: string): string | undefined {
  return deps.normalizeModelRef ? deps.normalizeModelRef(model) : model.trim()
}

async function safeDispatch(
  deps: DashboardDeps,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  try {
    // Sessions must be materialised via `client:create_session` (which binds
    // a workspaceId) or via `client:fork`. A user event arriving against an
    // unknown sessionId means either a stale dashboard URL or a bug — either
    // way we refuse to lazy-create, because a lazy-created session has no
    // workspaceId, cannot route tool calls, and lands in the Explorer's
    // Unassigned bucket forever. Surface the miss so the user notices.
    const record = await loadRecordForDashboard(deps, sessionId)
    if (!record) {
      deps.broadcastError(
        sessionId,
        'host',
        'session not created — click "New" in the sidebar to start a session bound to a workspace',
      )
      return
    }
    await deps.loopDeps.assertSessionEffectOwner?.(record.sessionId)
    await deps.loop.dispatch(sessionId, event)
  } catch (err) {
    deps.broadcastError(
      sessionId,
      'kernel',
      err instanceof Error ? err.message : String(err),
    )
  }
}

function assertActorSessionUnit(actor: DashboardActor | undefined, record: SessionRecord): void {
  if (actor?.kind === 'ingress') {
    if (!record.organizationId) throw new Error('tenant_attribution_missing')
    if (actor.organizationId !== record.organizationId) throw new Error('tenant_forbidden')
  } else if (record.organizationId) {
    throw new Error('missing organization attribution for Session mutation')
  }
}

export async function handleUserMessage(
  deps: DashboardDeps,
  p: ClientUserMessage,
  actor?: DashboardActor,
): Promise<void> {
  let record = deps.store.get(p.sessionId)
  if (!record) record = await loadRecordForDashboard(deps, p.sessionId)
  if (!record) {
    deps.broadcastError(
      p.sessionId,
      'host',
      'session not created — click "New" in the sidebar to start a session bound to a workspace',
    )
    return
  }
  assertActorSessionUnit(actor, record)
  const shell = p.intent === 'shell' ? parseBangShellRequest(p.text) : undefined
  if (p.intent === 'shell' && !shell) throw new Error('Shell intent requires a leading ! command')
  if (shell && p.content?.length) throw new Error('Shell commands cannot include attachments or structured content')
  if (shell && !record.workspaceId) throw new Error('Shell commands require a Session bound to a workspace')
  const capabilities = deps.agentRuntimes.require(record.agentRuntime).descriptor().capabilities
  if (p.mode === 'queue' && !capabilities.queue) {
    deps.broadcastError(p.sessionId, 'host', `${record.agentRuntime} sessions do not support queued messages`)
    return
  }
  if (p.content?.some((block) => block.type === 'image' || block.type === 'file') && !capabilities.attachments) {
    deps.broadcastError(p.sessionId, 'host', `${record.agentRuntime} sessions do not support attachments`)
    return
  }
  await validateMessageAttachmentReferences(deps.loopDeps.messageAttachments, p.sessionId, p.content)
  const runtime = deps.agentRuntimes.require(record.agentRuntime)
  const requestedMode = p.mode ?? 'steer'
  const messageModel = effectiveModelForRecord(deps, record)
  const hostQueueIdle = deps.messageQueues.pending(p.sessionId) === 0
  if (
    record.agentRuntime !== 'kernel'
    && requestedMode === 'steer'
    && !shell
    && isRestingStatus(record.state.status)
    && hostQueueIdle
  ) {
    // An idle external runtime can accept the steer immediately. When it is
    // busy, use the durable front queue below: calling send here would start a
    // new runtime generation while the previous generation's tools may still
    // be running.
    await deps.loopDeps.messageAttachments?.commitReferences(p.sessionId, p.content)
    await runtime.send(record, {
      text: p.text,
      ...(p.content ? { content: p.content } : {}),
      ...(p.operationId ? { operationId: p.operationId } : {}),
      ...(messageModel ? { model: messageModel } : {}),
    })
    return
  }
  if (record.agentRuntime === 'kernel' && record.state.status === 'thinking' && !deps.loop.hasActiveLlmCall(p.sessionId)) {
    await deps.loop.recoverInterruptedLlm(p.sessionId)
    record = await loadRecordForDashboard(deps, p.sessionId)
    if (!record) return
  }
  // Queue is a follow-up while another accepted message or turn is active.
  // The durable ACK for the first message can arrive before its background
  // drain changes the kernel status, so status alone has a race: a second
  // queue-mode send could be misclassified as a front-priority steer and move
  // ahead of the item whose commit callback owns the dequeue fence. Include
  // both host-owned queue and Loop activity in the admission state. Only a
  // truly quiescent queue-mode send becomes a hidden immediate steer.
  const messagePipelineIdle = hostQueueIdle && !deps.loop.hasActiveTurn(p.sessionId)
  const mode = requestedMode === 'queue' && isRestingStatus(record.state.status) && messagePipelineIdle
    ? 'steer'
    : requestedMode
  if (deps.queueQuota) {
    if (actor?.kind !== 'ingress' || !record.organizationId) {
      throw new Error('missing organization attribution for queue quota enforcement')
    }
    await deps.queueQuota.assertCanEnqueueMessage({
      organizationId: actor.organizationId,
      principal: actor.principal,
      role: actor.role,
      sessionId: p.sessionId,
      pendingMessages: deps.messageQueues.pending(p.sessionId),
      mode,
    })
  }
  const operationId = p.operationId ?? ulid()
  const queued: QueuedUserMessage = {
    id: operationId,
    operationId,
    text: p.text,
    mode,
    createdAt: new Date().toISOString(),
    ...(p.content ? { content: p.content } : {}),
    ...(messageModel ? { model: messageModel } : {}),
    ...(shell ? { shell } : {}),
  }
  // The Socket.IO ACK means "reliably accepted", not "the Agent turn has
  // completed". Persist every message before acknowledging, then drain in the
  // background. Awaiting loop.dispatch here made an idle direct send hold its
  // ACK for the entire LLM/tool turn; the dashboard timed out and restored a
  // draft that had already been sent.
  // PG/S3 queues the message and protects its objects in one owner-fenced
  // transaction. Other storage continues to protect references before enqueue.
  const atomicAttachments = deps.loopDeps.messageAttachments instanceof S3MessageAttachmentStore
    && p.content?.some((block) => block.type === 'file' && 'source' in block && block.source.kind === 'host_ref')
  if (!atomicAttachments) await deps.loopDeps.messageAttachments?.commitReferences(p.sessionId, p.content)
  await deps.messageQueues.enqueue(p.sessionId, queued, mode === 'steer' ? 'front' : undefined,
    atomicAttachments ? 'atomic-attachments' : undefined)
  if (record.agentRuntime === 'kernel' && mode === 'steer' && !isRestingStatus(record.state.status)) {
    // Do not truncate an in-flight response/tool. Stop at the next safe boundary
    // and let the persisted front-queued steer become the next user turn.
    deps.loop.requestStopAtBoundary(p.sessionId)
  } else if (shell && record.agentRuntime !== 'kernel' && mode === 'steer' && !isRestingStatus(record.state.status)) {
    // Match HTTP admission's external-runtime STEER semantics. The durable
    // shell item remains at the front and executes only after cancellation has
    // brought the Runtime to its safe resting boundary.
    await runtime.cancel(record)
  }
  void deps.messageQueues.drain(p.sessionId)
}

async function loadRecordForDashboard(
  deps: DashboardDeps,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  let record: SessionRecord | undefined = deps.store.get(sessionId)
  if (record?.agentRuntime !== undefined && record.agentRuntime !== 'kernel') {
    const defaultConfig = typeof deps.defaultConfig === 'function'
      ? deps.defaultConfig()
      : deps.defaultConfig
    record = await loadDashboardSession(deps.store, sessionId, defaultConfig)
  }
  if (!record) {
    try {
      const defaultConfig = typeof deps.defaultConfig === 'function'
        ? deps.defaultConfig()
        : deps.defaultConfig
      record = await loadDashboardSession(deps.store, sessionId, defaultConfig)
    } catch {
      record = undefined
    }
  }
  return record
}

export async function loadDashboardSession(
  store: SessionStore,
  sessionId: string,
  runtimeConfig?: AgentConfig,
): Promise<SessionRecord> {
  let record = store.get(sessionId)
  if (!record) {
    record = await store.load(sessionId, {
      recoverDangling: false,
      ...(runtimeConfig ? { runtimeConfig } : {}),
    })
  }
  if (record.agentRuntime !== 'kernel') {
    record = await store.load(sessionId, runtimeConfig
      ? { runtimeConfig: deriveSessionConfig(runtimeConfig, undefined, record.executionMode) }
      : undefined)
  }
  return record
}

export async function loadRecordForCleanup(
  store: SessionStore,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const cached = store.get(sessionId)
  if (cached) return cached
  try {
    return await store.load(sessionId, { recoverDangling: false })
  } catch {
    return undefined
  }
}

async function validateSessionCwd(
  deps: DashboardDeps,
  record: SessionRecord,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const resolved = resolvePath(trimmed)
  const executor = record.workspaceId
    ? deps.executors.snapshot().find((e) => e.workspaceId === record.workspaceId)
    : deps.executors.executorForSession(record.sessionId)
  if (!executor) return { ok: false, reason: record.workspaceId ? 'workspace offline' : 'no executor connected' }
  const roots = executor?.sandboxRoots ?? []
  if (roots.length === 0) return await validateDirectoryExists(deps, executor.workspaceId, resolved)
  for (const root of roots) {
    const r = resolvePath(root)
    if (resolved === r || resolved.startsWith(r + sep)) {
      return await validateDirectoryExists(deps, executor.workspaceId, resolved)
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

export async function validateWorkspaceCwd(
  deps: Pick<DashboardDeps, 'executors'>,
  workspaceId: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const windowsPath = /^[a-z]:[\\/]/iu.test(trimmed)
  const normalizeRemotePath = (value: string): string => windowsPath
    ? value.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase()
    : resolvePath(value)
  const resolved = windowsPath ? trimmed.replaceAll('/', '\\') : resolvePath(trimmed)
  const executor = deps.executors.snapshot().find((e) => e.workspaceId === workspaceId)
  if (!executor) return { ok: false, reason: 'workspace offline' }
  const roots = executor.sandboxRoots ?? []
  if (roots.length === 0) return await validateDirectoryExists(deps, workspaceId, resolved)
  for (const root of roots) {
    const r = windowsPath ? root.replaceAll('/', '\\') : resolvePath(root)
    const candidateKey = normalizeRemotePath(resolved)
    const rootKey = normalizeRemotePath(r)
    const separator = windowsPath ? '\\' : sep
    if (candidateKey === rootKey || candidateKey.startsWith(rootKey.endsWith(separator) ? rootKey : rootKey + separator)) {
      return await validateDirectoryExists(deps, workspaceId, resolved)
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

async function validateDirectoryExists(
  deps: Pick<DashboardDeps, 'executors'>,
  workspaceId: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const listed = await deps.executors.listDirs(workspaceId, cwd, ulid())
  if (listed.error) {
    return { ok: false, reason: `cwd is not a readable directory: ${listed.error}` }
  }
  return { ok: true, cwd: listed.path || cwd }
}

async function broadcastSessionList(deps: DashboardDeps): Promise<void> {
  const sessions = withQueuedCounts(deps, await deps.store.listSummaries())
  deps.dashboardNs.emit('server:sessions', { sessions })
}

/**
 * Annotate each summary with its pending queue depth so the dashboard can tell
 * a real turn end from a transient mid-turn `done` that a queued message will
 * immediately re-drive (see SessionSummary.queuedCount).
 */
function withQueuedCounts(deps: DashboardDeps, sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.map((s) => {
    const queuedCount = deps.messageQueues.pending(s.sessionId)
    return queuedCount > 0 ? { ...s, queuedCount } : s
  })
}

export function collectSessionDescendants(
  sessions: readonly { sessionId: string; parentSessionId?: string }[],
  rootSessionId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const children = childrenByParent.get(session.parentSessionId) ?? []
    children.push(session.sessionId)
    childrenByParent.set(session.parentSessionId, children)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootSessionId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(childrenByParent.get(id) ?? []))
  }
  return out
}

async function readJsonLogArtifact(logPath: string, refPath: string): Promise<unknown> {
  const base = dirname(logPath)
  const resolved = resolvePath(base, refPath)
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error('artifact path escapes session directory')
  }
  return JSON.parse(await readFile(resolved, 'utf8'))
}

export function readyEventFor(
  record: SessionRecord,
  selectedModel?: string,
  reason: SessionReadyEvent['reason'] = 'load',
  contextOverride?: ContextWindowOverride,
  runtimeCompactionPolicy?: RuntimeCompactionPolicy,
  compactStatus?: CompactStatusEvent,
): SessionReadyEvent {
  return {
    sessionId: record.sessionId,
    agentRuntime: record.agentRuntime,
    executionMode: record.executionMode,
    agentRuntimeCapabilities: record.agentRuntime === 'copilot'
      ? COPILOT_AGENT_RUNTIME_CAPABILITIES
      : KERNEL_AGENT_RUNTIME_CAPABILITIES,
    runtimeCompactionPolicy: runtimeCompactionPolicy ?? (record.agentRuntime === 'copilot'
      ? COPILOT_RUNTIME_COMPACTION_POLICY
      : kernelRuntimeCompactionPolicy(record.config.softThreshold, record.config.hardThreshold)),
    ...(compactStatus ? { compactStatus } : {}),
    reason,
    cursor: record.state.cursor,
    state: record.state,
    config: record.config,
    contextSnapshot: record.runtimeContextSnapshot
      ?? contextSnapshot(record, record.state.messages, contextOverride, selectedModel),
    ...(record.turnStartedAt ? { turnStartedAt: record.turnStartedAt } : {}),
    ...(record.parentSessionId
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(record.parentCursor !== undefined
      ? { parentCursor: record.parentCursor }
      : {}),
    ...(record.parentCallId !== undefined
      ? { parentCallId: record.parentCallId }
      : {}),
    ...(record.agentType !== undefined
      ? { agentType: record.agentType }
      : {}),
    ...(record.subAgentStartedAt !== undefined
      ? { subAgentStartedAt: record.subAgentStartedAt }
      : {}),
    ...(record.workspaceId !== undefined
      ? { workspaceId: record.workspaceId }
      : {}),
    ...(record.workspaceName !== undefined
      ? { workspaceName: record.workspaceName }
      : {}),
    ...(selectedModel ? { selectedModel } : {}),
  }

}

function runtimeCompactionPolicyFor(deps: DashboardDeps, record: SessionRecord): RuntimeCompactionPolicy {
  if (record.agentRuntime === 'kernel') {
    return kernelRuntimeCompactionPolicy(record.config.softThreshold, record.config.hardThreshold)
  }

  return deps.agentRuntimes.get(record.agentRuntime)?.descriptor().compactionPolicy
    ?? COPILOT_RUNTIME_COMPACTION_POLICY
}

function runtimeCompactStatusFor(deps: DashboardDeps, record: SessionRecord): CompactStatusEvent | undefined {
  return deps.agentRuntimes.get(record.agentRuntime)?.currentCompactStatus?.(record.sessionId)
}

// Session-not-yet-on-disk fallback. Returns a plausible `session:ready`
// carrying a fresh initial state so the dashboard can render an empty chat
// and let the user compose a message. Nothing is persisted here; the JSONL
// file is written the first time `client:user_message` / `client:fork`
// forces a `store.ensure()` inside the dispatch path.
export function ephemeralReadyEventFor(
  sessionId: string,
  defaultConfig: AgentConfig,
  selectedModel?: string,
  contextOverride?: ContextWindowOverride,
): SessionReadyEvent {
  const state = createInitialState({
    sessionId,
    ...(defaultConfig.systemPrompt
      ? { systemPrompt: defaultConfig.systemPrompt }
      : {}),
  })
  return {
    sessionId,
    agentRuntime: 'kernel',
    executionMode: 'chat',
    agentRuntimeCapabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
    runtimeCompactionPolicy: kernelRuntimeCompactionPolicy(
      defaultConfig.softThreshold,
      defaultConfig.hardThreshold,
    ),
    cursor: state.cursor,
    state,
    config: defaultConfig,
    contextSnapshot: snapshotFromConfig(defaultConfig, state.messages, contextOverride, selectedModel),
    ...(selectedModel ? { selectedModel } : {}),
  }
}

/**
 * Build a lookup from `runtime_metadata` entries so that each historical
 * `messages_replaced (compaction)` event can be re-united with the
 * `compaction_applied` record that carries its token deltas and trigger.
 *
 * Keying uses `replaceRange` because that's the only identifier both sides
 * always agree on: the kernel event carries `replaceRange`, and the
 * compaction extension writes the same `replaceRange` into the metadata
 * payload right after `dispatchOne` returns. `attemptId` isn't on the
 * kernel event, so it can't be the key.
 *
 * When multiple compactions in the same session happen to share an
 * identical `replaceRange` (rare but possible over long sessions), we keep
 * them ordered as a queue and pop the head per consumption — preserving
 * append order so replay matches live.
 *
 * Exported for tests; not intended as a public API.
 */
export function buildCompactionMetadataIndex(
  entries: readonly RuntimeMetadataEntry[],
): Map<string, CompactionMetadata[]> {
  const byRange = new Map<string, CompactionMetadata[]>()
  for (const entry of entries) {
    if (entry.action !== 'compaction_applied') continue
    const meta = extractCompactionMetadata(entry.payload)
    if (!meta) continue
    const key = compactionRangeKey(meta.__rangeStart, meta.__rangeEnd)
    const bucket = byRange.get(key) ?? []
    bucket.push(meta.value)
    byRange.set(key, bucket)
  }
  return byRange
}

export function consumeCompactionMetadata(
  index: Map<string, CompactionMetadata[]>,
  range: { start: number; end: number },
): CompactionMetadata | undefined {
  const key = compactionRangeKey(range.start, range.end)
  const bucket = index.get(key)
  if (!bucket || bucket.length === 0) return undefined
  const [head, ...rest] = bucket
  if (rest.length === 0) index.delete(key)
  else index.set(key, rest)
  return head
}

function compactionRangeKey(start: number, end: number): string {
  return `${start}:${end}`
}

function extractCompactionMetadata(
  payload: Record<string, unknown>,
): { value: CompactionMetadata; __rangeStart: number; __rangeEnd: number } | null {
  const trigger = payload.trigger
  if (trigger !== 'manual' && trigger !== 'auto' && trigger !== 'preflight' && trigger !== 'tool_result') return null
  const range = payload.replaceRange as { start?: unknown; end?: unknown } | undefined
  if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') return null
  const tokensBefore = typeof payload.tokensBefore === 'number' ? payload.tokensBefore : 0
  const tokensAfter = typeof payload.tokensAfter === 'number' ? payload.tokensAfter : 0
  const replacedCount = typeof payload.replacedCount === 'number'
    ? payload.replacedCount
    : Math.max(0, range.end - range.start)
  const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : undefined
  return {
    __rangeStart: range.start,
    __rangeEnd: range.end,
    value: {
      trigger,
      tokensBefore,
      tokensAfter,
      replacedCount,
      ...(attemptId ? { attemptId } : {}),
    },
  }
}
