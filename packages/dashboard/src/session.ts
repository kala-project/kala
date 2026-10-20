/**
 * The single hook that owns a Socket.IO connection to the host's `/dashboard`
 * namespace and mirrors the session's state locally.
 *
 * Everything the UI needs (state, event log, pending approvals, usage) is
 * derived from server events. User actions become socket emits — never a
 * local mutation.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import type {
  AgentConfig,
  AgentState,
  MessageContent,
  PendingToolCall,
} from '@agent-kernel/kernel'
import type {
  AskUserChoiceOption,
  AskUserChoiceRequest,
  ApprovalRequiredEvent,
  AttachedExecutor,
  CompactStatusEvent,
  ContextUsageSnapshot,
  ControlUpdate,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  EventAppendedEvent,
  QueuedMessagePreview,
  SessionErrorEvent,
  SessionReadyEvent,
  SessionSummary,
  HostRestartEvent,
  HumanAttentionTimeline,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION, buildHumanAttentionTimeline } from '@agent-kernel/shared'
import { io as socketIo, type Socket } from 'socket.io-client'

import { decideSessionHydration } from './session-hydration-policy.js'
import { scheduleFrameTask } from './lib/scheduler.js'
import { projectStatusFromEntry } from './state-flow.js'
import {
  EMPTY_SESSION_PROJECTION,
  mergeBySeq,
  reduceSessionProjection,
  reduceSessionProjectionBatch,
  timelineEntry,
  type ConnectionStatus,
  type SessionProjectionEvent,
  type TimelineEntry,
} from './session-projection.js'
import type { CachedSessionView, CachedSessionViewInput, SessionViewCache } from './session-view-cache.js'
import { DASHBOARD_PREFERENCES, DEFAULT_SESSION_SUBSCRIPTION_WARMTH_MINUTES, numberPreferenceOptions, PREF_SESSION_SUBSCRIPTION_WARMTH_MINUTES, PREF_SMOOTH_STREAMING_TEXT, readBooleanPref, readNumberPref } from './lib/prefs.js'
import { emitRpc, emitRpcInBackground } from './socket-rpc.js'
import { SessionSummaryStore } from './app-logic/session-summary-store.js'
import { DashboardConnectionManager } from './dashboard-connection-manager.js'
import type { RetainedStreamedDraft, StreamedDraftAnchor } from './transcript.js'

export type { ConnectionStatus, TimelineEntry } from './session-projection.js'

export type DashboardSocket = Socket<
  DashboardServerToClientEvents,
  DashboardClientToServerEvents
>

export type SessionView = {
  status: ConnectionStatus
  agentRuntime: import('@agent-kernel/shared').AgentRuntimeId
  executionMode: import('@agent-kernel/shared').SessionExecutionMode
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  runtimeCompactionPolicy: import('@agent-kernel/shared').RuntimeCompactionPolicy
  /** Host-authoritative start of the current/latest committed user turn. */
  turnStartedAt: string | null
  /**
   * Latest compaction lifecycle event received from the host. Every
   * attached dashboard receives the same broadcast; consumers use it to
   * render "Compacting…" without needing to have originated the request.
   * Null until the first attempt of the session.
   */
  compactStatus: CompactStatusEvent | null
  timeline: readonly TimelineEntry[]
  humanAttention: HumanAttentionTimeline
  streamingText: string
  streamingActive: boolean
  streamingAnchor: StreamedDraftAnchor | null
  retainedDrafts: readonly RetainedStreamedDraft[]
  /**
   * Derived from `state.pendingCalls` (status='awaiting_approval'), NOT from
   * the transient `approval:required` socket emit. That emit fires once per
   * request and disappears after a page reload, but `state.pendingCalls`
   * survives every reconnect. Deriving from state guarantees "banner says
   * awaiting approval" and "some ToolCallCard shows Approve/Reject" never
   * disagree — they read the same source.
   */
  pendingApprovals: readonly ApprovalRequiredEvent[]
  pendingAskUserChoices: readonly AskUserChoiceRequest[]
  queuedMessages: readonly QueuedMessagePreview[]
  lastError: SessionErrorEvent | null
  parentSessionId: string | null
  parentCursor: number | null
  selectedModel: string | null
  toolExecutionStartedAt: number | null
  hydratedSessionId: string | null
  historyLoadedSessionId: string | null
  historyAuthoritativeSessionId?: string | null
  socket: DashboardSocket | null
  reconnect: () => void
}

type BoundDashboardSocket = {
  sessionId: string
  socket: DashboardSocket
}

export type UseSessionOptions = {
  host: string
  sessionId: string | null
  socket?: DashboardSocket | null
  sessionRouteTickets?: boolean
  token?: string
  cache?: SessionViewCache & { hydrate?(sessionId: string): Promise<CachedSessionView | null> }
  onForked?: (payload: SessionReadyEvent) => void
}

const CONTROL_SOCKET_SESSION_ID = '__agent-kernel-control__'
const connectionManagers = new WeakMap<DashboardSocket, DashboardConnectionManager>()
export function dashboardConnectionManager(socket: DashboardSocket): DashboardConnectionManager {
  let manager = connectionManagers.get(socket)
  if (!manager) {
    manager = new DashboardConnectionManager(socket, {
      sessionWarmthMs: () => readNumberPref(
        PREF_SESSION_SUBSCRIPTION_WARMTH_MINUTES,
        DEFAULT_SESSION_SUBSCRIPTION_WARMTH_MINUTES,
        numberPreferenceOptions(DASHBOARD_PREFERENCES.sessionSubscriptionWarmthMinutes),
      ) * 60_000,
    })
    connectionManagers.set(socket, manager)
  }
  return manager
}

/**
 * Text-reveal pacing lives in the text-reveal feature module (presentation
 * concern, see docs/design/smooth-streaming-text.md). The session drain loop
 * consumes the pure rate model to pace how received tokens are revealed.
 */
import { computeReveal } from './features/chat/text-reveal/rate.js'
import { shouldCommitStreamFrame, streamReleaseCount } from './features/chat/text-reveal/scheduler.js'
import { createPrototypeDashboardSocket } from './prototype/mock-dashboard-socket.js'

function openDashboardSocket(url: string, options: Parameters<typeof socketIo>[1]): DashboardSocket {
  if (import.meta.env.VITE_KALA_PROTOTYPE === '1') return createPrototypeDashboardSocket() as DashboardSocket
  return socketIo(url, options) as DashboardSocket
}

export type SessionRouteTicketResult =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'unavailable' }

export async function requestSessionRouteTicket(input: {
  host: string
  sessionId: string
  signal?: AbortSignal
}): Promise<SessionRouteTicketResult> {
  const origin = new URL(input.host || window.location.origin, window.location.origin).origin
  if (origin !== window.location.origin) throw new Error('Session routing requires a same-origin Gateway')
  const response = await fetch(`${origin}/runtime/route-ticket`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: input.sessionId }),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const body = await response.json().catch(() => ({})) as { ticket?: unknown; error?: unknown }
  if (response.status === 404 && body.error === 'route_ticket_unavailable') return { kind: 'unavailable' }
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`
    throw new Error(`Session route ticket request failed: ${code}`)
  }
  if (typeof body.ticket !== 'string' || body.ticket.length === 0) {
    throw new Error('Session route ticket response was invalid')
  }
  return { kind: 'ticket', ticket: body.ticket }
}

export function sessionRouteTicketSocketOptions(input: {
  sessionId: string
  ticket: string
  token?: string
}): NonNullable<Parameters<typeof socketIo>[1]> {
  return {
    auth: {
      sessionId: input.sessionId,
      role: 'dashboard',
      clientVersion: PROTOCOL_VERSION,
      ...(input.token !== undefined ? { token: input.token } : {}),
    },
    query: { runtimeRouteTicket: input.ticket },
    forceNew: true,
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  }
}

export function acceptsSessionTokenDelta(status: AgentState['status']): boolean {
  return status === 'thinking'
}

export function useSession({
  host,
  sessionId,
  socket: sharedSocket,
  sessionRouteTickets = false,
  token,
  cache,
  onForked,
}: UseSessionOptions): SessionView {
  const [projection, dispatchProjection] = useReducer(
    (current: typeof EMPTY_SESSION_PROJECTION, events: readonly SessionProjectionEvent[]) => reduceSessionProjectionBatch(current, events),
    EMPTY_SESSION_PROJECTION,
  )
  const dispatchProjectionEvent = (event: SessionProjectionEvent): void => dispatchProjection([event])
  const [streamingText, setStreamingText] = useState('')
  const [streamingActive, setStreamingActive] = useState(false)
  const [streamingAnchor, setStreamingAnchor] = useState<StreamedDraftAnchor | null>(null)
  const [retainedDrafts, setRetainedDrafts] = useState<readonly RetainedStreamedDraft[]>([])
  const [boundSocket, setBoundSocket] = useState<BoundDashboardSocket | null>(null)
  const [reconnectGeneration, setReconnectGeneration] = useState(0)
  const reconnect = useCallback(() => setReconnectGeneration((generation) => generation + 1), [])
  const socketRef = useRef<DashboardSocket | null>(null)
  const generationRef = useRef(0)
  // Streaming smoother: token_delta events land in `streamBufferRef`, and a
  // requestAnimationFrame loop drains a chunk per frame into React state. This
  // collapses 60-100 setState calls/sec into ~60 frames/sec AND paces bursty
  // deltas into a smoother visual flow. Backlog >~200 chars triggers a catch-up.
  const streamBufferRef = useRef('')
  const streamRafRef = useRef<number | null>(null)
  const onForkedRef = useRef(onForked)
  onForkedRef.current = onForked
  const pendingCacheCheckpointRef = useRef<{ sessionId: string; view: CachedSessionViewInput } | null>(null)

  useEffect(() => {
    if (!cache || !projection.sessionId || projection.hydratedSessionId !== projection.sessionId) return
    const checkpoint = {
      sessionId: projection.sessionId, status: projection.status, executionMode: projection.executionMode, state: projection.state,
      config: projection.config, contextSnapshot: projection.contextSnapshot, runtimeCompactionPolicy: projection.runtimeCompactionPolicy,
      turnStartedAt: projection.turnStartedAt, turnStartedAtCursor: projection.turnStartedAtCursor,
      timeline: projection.timeline,
      queuedMessages: projection.queuedMessages, lastError: projection.lastError,
      parentSessionId: projection.parentSessionId, parentCursor: projection.parentCursor,
      selectedModel: projection.selectedModel, hydratedSessionId: projection.hydratedSessionId, historyLoadedSessionId: projection.historyLoadedSessionId,
    }
    pendingCacheCheckpointRef.current = { sessionId: projection.sessionId, view: checkpoint }
    const timer = window.setTimeout(() => {
      if (pendingCacheCheckpointRef.current?.view !== checkpoint) return
      cache.set(projection.sessionId!, checkpoint)
      pendingCacheCheckpointRef.current = null
    }, 1_000)
    return () => window.clearTimeout(timer)
  }, [cache, projection])

  useEffect(() => () => {
    const pending = pendingCacheCheckpointRef.current
    // A large Session cache estimate walks the full timeline synchronously.
    // Never put that work in a microtask: microtasks run before the browser can
    // paint the newly selected Session and made the click look frozen. Yield one
    // frame, then checkpoint in a task; durable persistence is already scheduled
    // in the cache's background queue.
    if (cache && pending) scheduleFrameTask(() => window.setTimeout(() => cache.set(pending.sessionId, pending.view), 0))
    pendingCacheCheckpointRef.current = null
  }, [cache, sessionId])

  useEffect(() => {
    const generation = ++generationRef.current
    setStreamingActive(false)
    setStreamingAnchor(null)
    setRetainedDrafts([])
    if (sessionId === null) {
      if (!sharedSocket) socketRef.current?.close()
      socketRef.current = null
      setBoundSocket(null)
      dispatchProjectionEvent({ kind: 'select', generation, sessionId: null })
      setStreamingText('')
      return
    }
    let cached = cache?.get(sessionId) ?? null
    dispatchProjectionEvent({ kind: 'select', generation, sessionId, cached })
    setStreamingText('')
    streamBufferRef.current = ''
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current)
      streamRafRef.current = null
    }
    let resetHistoryBaseOnNextReplay = false
    let historyRequestTimer: number | null = null
    let historyRequestAttempts = 0
    let latestHistoryRequest: { sessionId: string; sinceCursor?: number } | null = null

    // Coalesce the two high-frequency projection channels (`event:appended`
    // and `state:changed`) to at most one React commit per animation frame.
    // socket.io delivers each wire message in its own macrotask, so React 18's
    // automatic batching does NOT merge them — during a tool-heavy turn that is
    // dozens of independent re-renders of the whole App per second, which
    // starves the main thread (buttons feel dead, the hover cursor stops
    // updating). We buffer these deltas and flush them in insertion order once
    // per frame, with a bounded timer fallback when WebKit stops painting a
    // hidden native window (even if visibilityState still says visible).
    // Discrete, order-sensitive events (ready/history/queue/error/
    // model) flush the buffer synchronously first so ordering is never broken.
    let projectionQueue: SessionProjectionEvent[] = []
    let cancelProjectionFlush: (() => void) | null = null
    const flushProjectionQueue = (): void => {
      cancelProjectionFlush?.()
      cancelProjectionFlush = null
      if (projectionQueue.length === 0) return
      const batch = projectionQueue
      projectionQueue = []
      dispatchProjection(batch)
    }
    const enqueueProjection = (evt: SessionProjectionEvent): void => {
      projectionQueue.push(evt)
      if (cancelProjectionFlush === null) {
        cancelProjectionFlush = scheduleFrameTask(() => {
          cancelProjectionFlush = null
          flushProjectionQueue()
        })
      }
    }

    // Streaming reveal. token_delta events land in `streamBufferRef`; a rAF
    // loop releases characters into React state (`setStreamingText`). Two modes:
    //
    //  - Smooth (setting on, default): release characters at an EVEN rate
    //    (REVEAL_BASE_CPS), speeding up to REVEAL_MAX_CPS only enough to never
    //    lag the incoming data by more than REVEAL_MAX_LAG_SECONDS. Characters
    //    flow one/few at a time instead of bursting; the tail fade-in
    //    (ChatPanel) makes each character appear softly.
    //  - Batched (setting off): the previous behavior — release ~10% of the
    //    backlog per frame, committing at most once per MIN_COMMIT_MS (~15fps).
    //
    // Either way the completed-block memoization means only the tail re-renders.
    const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const smoothEnabled = readBooleanPref(PREF_SMOOTH_STREAMING_TEXT, true)

    const MIN_COMMIT_MS = 66
    let lastCommitMs = 0
    let pendingCommit = ''
    let pageVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    let carry = 0 // fractional characters owed, carried across frames (smooth mode)
    let lastFrameMs = 0
    const commitPending = (): void => {
      if (pendingCommit.length === 0) return
      const chunk = pendingCommit
      pendingCommit = ''
      lastCommitMs = now()
      setStreamingText((prev) => prev + chunk)
    }

    const drainSmooth = (): void => {
      const buf = streamBufferRef.current
      if (buf.length === 0) {
        if (pageVisible) commitPending()
        streamRafRef.current = null
        lastFrameMs = 0
        return
      }
      const t = now()
      const dt = lastFrameMs === 0 ? 1 / 60 : Math.min(0.1, (t - lastFrameMs) / 1000)
      lastFrameMs = t
      const release = computeReveal(buf.length, dt, carry)
      carry = release.carry
      const count = streamReleaseCount(buf.length, release.count)
      if (count > 0) {
        const chunk = buf.slice(0, count)
        streamBufferRef.current = buf.slice(count)
        pendingCommit += chunk
      }
      if (shouldCommitStreamFrame({
        now: t,
        lastCommitAt: lastCommitMs,
        backlog: streamBufferRef.current.length,
        visible: pageVisible,
      })) commitPending()
      streamRafRef.current = requestAnimationFrame(drainSmooth)
    }

    const drainBatched = (): void => {
      const buf = streamBufferRef.current
      if (buf.length === 0) {
        commitPending()
        streamRafRef.current = null
        return
      }
      const chunkSize = Math.min(buf.length, Math.max(2, Math.ceil(buf.length / 10)))
      const chunk = buf.slice(0, chunkSize)
      streamBufferRef.current = buf.slice(chunkSize)
      pendingCommit += chunk
      if (now() - lastCommitMs >= MIN_COMMIT_MS) commitPending()
      streamRafRef.current = requestAnimationFrame(drainBatched)
    }

    const drainStreamBuffer = (): void => {
      if (smoothEnabled) drainSmooth()
      else drainBatched()
    }

    const pushStreamDelta = (text: string): void => {
      if (!text) return
      if (!draftAnchor) {
        draftAnchor = { afterSeq: streamCursor, messageCount: streamMessageCount }
        setStreamingAnchor(draftAnchor)
      }
      receivedText += text
      setStreamingActive(true)
      streamBufferRef.current += text
      if (streamRafRef.current === null) {
        lastFrameMs = 0
        streamRafRef.current = requestAnimationFrame(drainStreamBuffer)
      }
    }

    const handleVisibilityChange = (): void => {
      pageVisible = document.visibilityState !== 'hidden'
      if (!pageVisible) return
      // Commit the already-released chunk once on resume, then continue pacing
      // any remaining backlog. Hidden tabs never replay every skipped frame.
      commitPending()
      if (streamBufferRef.current.length > 0 && streamRafRef.current === null) {
        lastFrameMs = 0
        streamRafRef.current = requestAnimationFrame(drainStreamBuffer)
      }
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibilityChange)

    const resetStream = (): void => {
      streamBufferRef.current = ''
      pendingCommit = ''
      carry = 0
      lastFrameMs = 0
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      setStreamingText('')
      receivedText = ''
      draftAnchor = null
      setStreamingAnchor(null)
      setStreamingActive(false)
    }

    let receivedText = ''
    let draftAnchor: StreamedDraftAnchor | null = null
    let streamCursor = cached?.timeline.at(-1)?.seq ?? 0
    let streamMessageCount = cached?.state?.messages.length ?? 0
    let streamStatus: AgentState['status'] | undefined
    const finishStream = (): void => {
      // Flush unrevealed tokens too: terminal/tool states can arrive while the
      // smoother still has a backlog, including while this tab is hidden.
      streamBufferRef.current = ''
      pendingCommit = ''
      if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current)
      streamRafRef.current = null
      setStreamingText(receivedText)
      setStreamingActive(false)
    }
    const archiveStream = (): void => {
      if (receivedText && draftAnchor) {
        const draft = { ...draftAnchor, text: receivedText }
        setRetainedDrafts((previous) => [...previous, draft])
      }
      resetStream()
    }
    const updateStreamStatus = (status: AgentState['status']): void => {
      if (status === 'thinking' && streamStatus !== 'thinking') archiveStream()
      if (!acceptsSessionTokenDelta(status)) finishStream()
      streamStatus = status
      acceptStreamDeltas = acceptsSessionTokenDelta(status)
    }
    let disposed = false
    let liveBaselineReceived = false
    let acceptStreamDeltas = false
    let socket: DashboardSocket | null = null
    let reconnectCleanup: (() => void) | null = null
    let socketListenerCleanup: (() => void) | null = null
    let liveConnectionStatus: ConnectionStatus = 'connecting'
    const dispatchStatus = (status: ConnectionStatus): void => {
      liveConnectionStatus = status
      dispatchProjectionEvent({ kind: 'status', generation, sessionId, status })
    }
    // Durable hydration and the live socket race independently. IndexedDB is a
    // paint optimization; it must never delay the authoritative connection.
    if (!cached && cache?.hydrate) {
      void cache.hydrate(sessionId).then((hydrated) => {
        if (disposed || liveBaselineReceived || !hydrated) return
        cached = hydrated
        dispatchProjectionEvent({ kind: 'hydrate', generation, sessionId, cached: hydrated })
      })
    }
    let ticketAbortController: AbortController | null = null
    let routeReconnectTimer: number | null = null
    let routeConnectGeneration = 0
    let routeReconnectAttempts = 0
    let routeTicketFallback = false
    let routeReconnectBlocked = false
    let routePreparationAttempted = false

    const closeOwnedSocket = (): void => {
      socketListenerCleanup?.()
      socketListenerCleanup = null
      if (historyRequestTimer !== null) window.clearTimeout(historyRequestTimer)
      historyRequestTimer = null
      latestHistoryRequest = null
      historyRequestAttempts = 0
      const previous = socket
      socket = null
      if (previous && previous !== sharedSocket) previous.close()
      if (socketRef.current === previous) socketRef.current = null
      setBoundSocket((current) => current?.socket === previous ? null : current)
    }

    const connectSharedSocket = (): void => {
      if (sharedSocket == null) return
      socket = sharedSocket
      socketRef.current = socket
      bindSocket(socket)
      setBoundSocket({ sessionId, socket })
      const cursor = cached?.timeline.at(-1)?.seq
      const releaseChannel = dashboardConnectionManager(socket).acquire(`session:${sessionId}`, cursor, {
        freshBaseline: true,
        onError: (code) => {
          if (disposed) return
          dispatchStatus('error')
          dispatchProjectionEvent({ kind: 'error', generation, sessionId, error: { sessionId, scope: 'host', message: `Unable to subscribe to this Session: ${code}` } })
        },
      })
      const previousCleanup = reconnectCleanup
      reconnectCleanup = () => {
        previousCleanup?.()
        releaseChannel()
      }
    }

    const connectLegacySocket = (): void => {
      socket = openDashboardSocket(`${host}/dashboard`, {
        auth: {
          sessionId,
          role: 'dashboard',
          clientVersion: PROTOCOL_VERSION,
          ...(token !== undefined ? { token } : {}),
        },
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 30_000,
        reconnectionAttempts: Infinity,
        randomizationFactor: 0.5,
        transports: ['websocket', 'polling'],
        tryAllTransports: true,
      })
      socketRef.current = socket
      bindSocket(socket)
      setBoundSocket({ sessionId, socket })
    }

    const connectRoutedSocket = async (): Promise<void> => {
      const connectGeneration = ++routeConnectGeneration
      ticketAbortController?.abort()
      ticketAbortController = new AbortController()
      closeOwnedSocket()
      dispatchStatus('connecting')
      try {
        const result = await requestSessionRouteTicket({
          host,
          sessionId,
          signal: ticketAbortController.signal,
        })
        if (disposed || connectGeneration !== routeConnectGeneration) return
        ticketAbortController = null
        if (result.kind === 'unavailable') {
          routeTicketFallback = true
          connectSharedSocket()
          return
        }
        socket = openDashboardSocket(
          `${host}/dashboard`,
          sessionRouteTicketSocketOptions({ sessionId, ticket: result.ticket, ...(token !== undefined ? { token } : {}) }),
        )
        socketRef.current = socket
        bindSocket(socket)
        setBoundSocket({ sessionId, socket })
        socket.connect()
      } catch (error) {
        if (disposed || connectGeneration !== routeConnectGeneration || (error instanceof DOMException && error.name === 'AbortError')) return
        ticketAbortController = null
        dispatchStatus('error')
        dispatchProjectionEvent({
          kind: 'error',
          generation,
          sessionId,
          error: {
            sessionId,
            scope: 'host',
            message: error instanceof Error ? error.message : 'Session route ticket request failed',
          },
        })
        // A newly created Session may not have a published owner yet; retry
        // transient ownership and transport failures, never auth/permission errors.
        const ownerUnavailable = error instanceof Error && error.message.endsWith(': session_owner_unavailable')
        if (ownerUnavailable && !routePreparationAttempted && sharedSocket?.connected) {
          routePreparationAttempted = true
          try {
            const prepared = await sharedSocket.timeout(3_000).emitWithAck('client:prepare_session_route', { sessionId })
            if (disposed || connectGeneration !== routeConnectGeneration) return
            if (prepared.ok) { void connectRoutedSocket(); return }
          } catch {
            // Rolling upgrades may not support owner preparation yet; never
            // bypass the Gateway ticket on a failed or timed-out RPC.
          }
        }
        if (error instanceof TypeError || ownerUnavailable) scheduleRoutedReconnect()
      }
    }

    const scheduleRoutedReconnect = (): void => {
      if (disposed || routeTicketFallback || routeReconnectBlocked || routeReconnectTimer !== null || routeReconnectAttempts >= 8) return
      const delay = Math.min(500 * 2 ** routeReconnectAttempts, 30_000)
      routeReconnectAttempts += 1
      routeReconnectTimer = window.setTimeout(() => {
        routeReconnectTimer = null
        void connectRoutedSocket()
      }, delay)
    }

    const connect = (): void => {
      if (sessionRouteTickets) {
        void connectRoutedSocket()
        return
      }
      if (sharedSocket !== undefined) connectSharedSocket()
      else connectLegacySocket()
    }

    const reconnectNow = (): void => {
      if (disposed || socket?.connected) return
      if (sessionRouteTickets && !routeTicketFallback) {
        if (routeReconnectTimer !== null) window.clearTimeout(routeReconnectTimer)
        routeReconnectTimer = null
        routeReconnectAttempts = 0
        void connectRoutedSocket()
      } else socket?.connect()
    }
    window.addEventListener('online', reconnectNow)
    document.addEventListener('visibilitychange', reconnectNow)
    reconnectCleanup = () => {
      window.removeEventListener('online', reconnectNow)
      document.removeEventListener('visibilitychange', reconnectNow)
    }

    const requestHistory = (socket: DashboardSocket, payload: { sessionId: string; sinceCursor?: number }): void => {
      latestHistoryRequest = payload
      historyRequestAttempts += 1
      socket.emit('client:load_history', payload)
      if (historyRequestTimer !== null) window.clearTimeout(historyRequestTimer)
      historyRequestTimer = window.setTimeout(() => {
        if (disposed || !latestHistoryRequest) return
        if (historyRequestAttempts < 3) { requestHistory(socket, latestHistoryRequest); return }
        latestHistoryRequest = null
        dispatchProjectionEvent({ kind: 'history', generation, sessionId, entries: [], authoritative: false })
        dispatchProjectionEvent({ kind: 'error', generation, sessionId, error: { sessionId, scope: 'host', message: 'Conversation history request timed out. Reconnect or retry this Session.' } })
      }, 10_000)
    }

    const bindSocket = (socket: DashboardSocket): void => {
      const listenerCleanups: Array<() => void> = []
      const bind = <EventName extends keyof DashboardServerToClientEvents | 'connect' | 'connect_error' | 'disconnect'>(
        event: EventName,
        listener: EventName extends keyof DashboardServerToClientEvents
          ? DashboardServerToClientEvents[EventName]
          : (...args: never[]) => void,
      ): void => {
        socket.on(event as never, listener as never)
        listenerCleanups.push(() => socket.off(event, listener as never))
      }
      socketListenerCleanup = () => {
        for (const cleanup of listenerCleanups) cleanup()
        listenerCleanups.length = 0
      }
      const isCurrentSocket = (): boolean => !disposed && socketRef.current === socket
      let plannedRestartUntil = 0

      const noteHostRestart = (event: HostRestartEvent): void => {
        if (!isCurrentSocket()) return
        if (event.phase === 'restarting') {
          plannedRestartUntil = Date.now() + 120_000
        }
      }

    bind('session:ready', (p) => {
      if (!isCurrentSocket()) return
      if (p.reason === 'forked') {
        onForkedRef.current?.(p)
        return
      }
      if (p.sessionId !== sessionId) return
      liveBaselineReceived = true
      archiveStream()
      streamCursor = p.cursor
      streamMessageCount = p.state.messages.length
      updateStreamStatus(p.state.status)
      if (p.streamingDraft?.text && acceptsSessionTokenDelta(p.state.status)) {
        // Ready is sent after the Host flushes all earlier token batches. The
        // snapshot therefore replaces (rather than appends to) the old tail;
        // later deltas contain only newly generated text.
        receivedText = p.streamingDraft.text
        draftAnchor = { afterSeq: p.streamingDraft.afterSeq, messageCount: p.streamingDraft.messageCount }
        setStreamingAnchor(draftAnchor)
        setStreamingText(receivedText)
        setStreamingActive(true)
      }
      flushProjectionQueue()
      liveConnectionStatus = 'ready'
      dispatchProjectionEvent({ kind: 'ready', generation, sessionId, payload: p })
      if ((p.agentRuntime ?? 'kernel') !== 'kernel') {
        latestHistoryRequest = null
        historyRequestAttempts = 0
        if (historyRequestTimer !== null) {
          window.clearTimeout(historyRequestTimer)
          historyRequestTimer = null
        }
        resetHistoryBaseOnNextReplay = false
        dispatchProjectionEvent({ kind: 'history', generation, sessionId, entries: [], reset: true })
        return
      }
      // Timeline was cleared for a fresh connect; ask the host to replay
      // the log so a page reload doesn't leave the user staring at an
      // empty timeline for a session that already has history. Live
      // event:appended events overlapping the tail of history are
      // deduped by seq below.
      const hydration = decideSessionHydration({ cached, hostCursor: p.cursor })
      if (hydration.kind === 'load_full_history') {
        // Full history is authoritative even when the local timeline is merely
        // empty. Mark the replay as a reset so rows appear and any stale live
        // conflict cannot survive under the same sequence.
        resetHistoryBaseOnNextReplay = true
        if (hydration.resetTimeline) {
          cache?.delete(p.sessionId)
          dispatchProjectionEvent({ kind: 'reset_timeline', generation, sessionId })
        }
        requestHistory(socket, { sessionId: p.sessionId })
        return
      }
      requestHistory(socket, { sessionId: p.sessionId, sinceCursor: hydration.sinceCursor })
    })
    bind('server:history', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      latestHistoryRequest = null
      historyRequestAttempts = 0
      if (historyRequestTimer !== null) { window.clearTimeout(historyRequestTimer); historyRequestTimer = null }
      const reset = resetHistoryBaseOnNextReplay
      resetHistoryBaseOnNextReplay = false
      flushProjectionQueue()
      dispatchProjectionEvent({ kind: 'history', generation, sessionId, entries: p.entries.map(timelineEntry), reset })
    })
    bind('state:changed', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      // Kept as a fallback / correction channel. The primary path is
      // `session:ready` (baseline) + `event:appended` (client-side fold
      // via kernel step()). This handler runs if a wire event lands
      // out-of-order or if the host pushes a mid-stream correction; in
      // both cases the server-computed state wins.
      //
      // Coalesced to one commit per frame (see enqueueProjection): during a
      // tool-heavy turn state:changed fires very frequently and each one used
      // to re-render the whole App synchronously.
      const replacesDraft = Boolean(draftAnchor && p.state.messages.slice(draftAnchor.messageCount)
        .some((message) => message.role === 'assistant' &&
          message.content.some((content) => content.type === 'text' && content.text.length > 0)))
      if (replacesDraft) resetStream()
      updateStreamStatus(p.state.status)
      streamCursor = p.cursor ?? p.state.cursor
      streamMessageCount = p.state.messages.length
      if (replacesDraft) {
        flushProjectionQueue()
        dispatchProjectionEvent({ kind: 'authoritative', generation, sessionId, payload: p })
      } else enqueueProjection({ kind: 'authoritative', generation, sessionId, payload: p })
    })
    const llmResponseHasText = (p: EventAppendedEvent): boolean =>
      p.event.kind === 'llm_response' &&
      p.event.message.role === 'assistant' &&
      p.event.message.content.some((content) => content.type === 'text' && content.text.length > 0)

    bind('event:appended', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      if (p.event.kind === 'clear') {
        resetStream()
        setRetainedDrafts([])
      } else if (p.event.kind === 'user_message') archiveStream()
      const nextStatus = projectStatusFromEntry(streamStatus ?? 'idle', timelineEntry(p))
      updateStreamStatus(nextStatus)
      streamCursor = p.seq
      if (p.event.kind === 'llm_response' || p.event.kind === 'llm_error') {
        // Persisted text and its draft are replaced in the same React commit.
        // A deferred reset can erase the *next* response's tokens.
        finishStream()
        acceptStreamDeltas = false
        flushProjectionQueue()
        dispatchProjectionEvent({ kind: 'appended', generation, sessionId, payload: p })
        if (llmResponseHasText(p)) resetStream()
        return
      }
      // High-frequency mid-turn events (tool_call / tool_result): coalesce to
      // one React commit per animation frame.
      enqueueProjection({ kind: 'appended', generation, sessionId, payload: p })
    })
    bind('approval:required', () => {
      // Best-effort: the reducer's next state:changed already carries the
      // authoritative pendingCalls list, so the derived pendingApprovals
      // updates from that. This handler is left as a hook point for
      // logging/telemetry — it must NOT maintain its own list, or the
      // banner-vs-card mismatch across reloads comes back.
    })
    bind('server:message_queue', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId) {
        // A dequeue snapshot can immediately follow the committed user event.
        // Preserve that wire order before optimistic Queue reconciliation runs.
        flushProjectionQueue()
        const items = p.items ?? []
        dispatchProjectionEvent({ kind: 'queue', generation, sessionId, items })
      }
    })
    bind('session:error', (p) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      if (latestHistoryRequest) {
        latestHistoryRequest = null
        if (historyRequestTimer !== null) { window.clearTimeout(historyRequestTimer); historyRequestTimer = null }
        dispatchProjectionEvent({ kind: 'history', generation, sessionId, entries: [], authoritative: false })
      }
      finishStream()
      acceptStreamDeltas = false
      flushProjectionQueue()
      dispatchProjectionEvent({ kind: 'error', generation, sessionId, error: p })
    })
    bind('session:token_delta', (p) => {
      if (!isCurrentSocket()) return
      if (p.sessionId === sessionId && acceptStreamDeltas) pushStreamDelta(p.text)
    })
    bind('server:control_update', (p: ControlUpdate) => {
      if (p.kind === 'host_restart') noteHostRestart(p)
      if (p.kind === 'session_meta_changed' && p.sessionId === sessionId && p.preferences && 'selectedModel' in p.preferences) {
        const model = p.preferences.selectedModel && p.preferences.selectedModel.length > 0 ? p.preferences.selectedModel : null
        dispatchProjectionEvent({ kind: 'model', generation, sessionId, selectedModel: model })
      }
    })
    bind('connect', () => {
      if (!isCurrentSocket()) return
      routeReconnectAttempts = 0
      // A later owner loss may require the newly selected control Runtime to
      // prepare the same Session again before the Gateway can issue a ticket.
      routePreparationAttempted = false
      dispatchStatus('connecting')
    })
    bind('connect_error', (err: Error) => {
      if (!isCurrentSocket()) return
      // Version / auth failures are handshake-time — no point retrying.
      // Stop the socket.io retry loop and hold in an error state so the
      // user sees an actionable banner instead of a hot-looping toast.
      const msg = (err as Error | undefined)?.message ?? ''
      if (msg === 'version_incompatible' || msg === 'auth_failed') {
        routeReconnectBlocked = true
        socket.disconnect()
        dispatchStatus('error')
        return
      }
      dispatchStatus(liveConnectionStatus === 'ready' || liveConnectionStatus === 'disconnected' ? 'disconnected' : 'connecting')
      if (sessionRouteTickets && !routeTicketFallback) scheduleRoutedReconnect()
    })
    if (socket !== sharedSocket) socket.io.on('reconnect_failed', () => {
      if (!isCurrentSocket()) return
      dispatchStatus('error')
    })
    bind('disconnect', (reason: string) => {
      if (!isCurrentSocket()) return
      finishStream()
      acceptStreamDeltas = false
      if (sessionRouteTickets && !routeTicketFallback) {
        dispatchStatus('disconnected')
        scheduleRoutedReconnect()
        return
      }
      // Server-initiated disconnect (e.g. workspaceId conflict analogue on
      // dashboard side, or host shutdown) is terminal — don't let socket.io
      // keep dialing.
      if (reason === 'io server disconnect') {
        if (Date.now() < plannedRestartUntil) {
          dispatchStatus('disconnected')
          return
        }
        socket.disconnect()
        dispatchStatus('error')
        return
      }
      dispatchStatus('disconnected')
    })
    bind('server:compact_status', (p: CompactStatusEvent) => {
      if (!isCurrentSocket() || p.sessionId !== sessionId) return
      dispatchProjectionEvent({ kind: 'compact', generation, sessionId, compactStatus: p })
    })
    }

    void connect()

    return () => {
      disposed = true
      routeConnectGeneration += 1
      ticketAbortController?.abort()
      ticketAbortController = null
      if (routeReconnectTimer !== null) window.clearTimeout(routeReconnectTimer)
      routeReconnectTimer = null
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      cancelProjectionFlush?.()
      cancelProjectionFlush = null
      if (historyRequestTimer !== null) {
        window.clearTimeout(historyRequestTimer)
        historyRequestTimer = null
      }
      // Drop any buffered projection deltas: this socket/session is being torn
      // down (session switch or reconnect), and the fresh connection replays
      // an authoritative baseline via session:ready + history.
      projectionQueue = []
      streamBufferRef.current = ''
      pendingCommit = ''
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibilityChange)
      reconnectCleanup?.()
      socketListenerCleanup?.()
      socketListenerCleanup = null
      if (socket && socket !== sharedSocket) socket.close()
      if (socketRef.current === socket) socketRef.current = null
      setBoundSocket((current) => current?.socket === socket ? null : current)
    }
  }, [host, sessionId, token, cache, sharedSocket, sessionRouteTickets, reconnectGeneration])

  const selectionCurrent = projection.sessionId === sessionId
  const selectedProjection = selectionCurrent
    ? projection
    : {
        ...EMPTY_SESSION_PROJECTION,
        generation: projection.generation,
        sessionId,
        status: sessionId ? 'connecting' as const : 'idle' as const,
      }

  const {
    status, agentRuntime, executionMode, state, config, contextSnapshot, runtimeCompactionPolicy, compactStatus: remoteCompactStatus, timeline,
    queuedMessages, lastError, parentSessionId, parentCursor, selectedModel, turnStartedAt,
    hydratedSessionId, historyLoadedSessionId, historyAuthoritativeSessionId,
  } = selectedProjection

  const pendingApprovals = useMemo<readonly ApprovalRequiredEvent[]>(() => {
    if (!state || !sessionId) return []
    return state.pendingCalls
      .filter((c) => c.status === 'awaiting_approval')
      .map((c) => ({
        sessionId,
        callId: c.callId,
        name: c.name,
        input: c.input,
      }))
  }, [state, sessionId])

  const pendingAskUserChoices = useMemo<readonly AskUserChoiceRequest[]>(() => {
    if (!state || !sessionId) return []
    return state.pendingCalls
      .filter((c) => c.name === 'ask_user_choice' && (c.status === 'dispatched' || c.status === 'approved'))
      .map((c) => pendingCallToAskUserChoice(sessionId, c))
      .filter((c): c is AskUserChoiceRequest => c !== null)
  }, [state, sessionId])

  const toolExecutionStartedAt = useMemo(
    () => deriveToolExecutionStartedAt(state, timeline),
    [state, timeline],
  )

  // Human-attention scoring walks the whole (growing) timeline prefix and is
  // relatively expensive; recomputing it on every timeline delta froze the main
  // thread during tool-heavy turns (hundreds of ms per recompute). It is not
  // real-time-critical — it only drives the attention indicator — so debounce
  // it: recompute only after the timeline has been quiet for a moment. During
  // an active turn the timeline changes constantly, so this collapses dozens of
  // full recomputes into (at most) one per quiet window.
  const [attentionSnapshot, setAttentionSnapshot] = useState<{
    sessionId: string | null
    timeline: readonly TimelineEntry[]
  }>({ sessionId, timeline })
  useEffect(() => {
    const handle = window.setTimeout(() => setAttentionSnapshot({ sessionId, timeline }), 400)
    return () => window.clearTimeout(handle)
  }, [sessionId, timeline])
  const attentionTimeline = attentionSnapshot.sessionId === sessionId ? attentionSnapshot.timeline : []
  const humanAttention = useMemo(
    () => deriveHumanAttentionTimeline(sessionId, attentionTimeline),
    [sessionId, attentionTimeline],
  )

  return useMemo(
    () => ({
      status,
      agentRuntime,
      executionMode,
      state,
      config,
      contextSnapshot,
      runtimeCompactionPolicy,
      turnStartedAt,
      compactStatus: remoteCompactStatus,
      timeline,
      humanAttention,
      streamingText: selectionCurrent ? streamingText : '',
      streamingActive: selectionCurrent && streamingActive,
      streamingAnchor: selectionCurrent ? streamingAnchor : null,
      retainedDrafts: selectionCurrent ? retainedDrafts : [],
      pendingApprovals,
      pendingAskUserChoices,
      queuedMessages,
      lastError,
      parentSessionId,
      parentCursor,
      selectedModel,
      toolExecutionStartedAt,
      hydratedSessionId,
      historyLoadedSessionId,
      historyAuthoritativeSessionId,
      socket: !sessionRouteTickets && sessionId && sharedSocket ? sharedSocket : boundSocket?.sessionId === sessionId ? boundSocket.socket : null,
      reconnect,
    }),
    [
      status,
      agentRuntime,
      executionMode,
      state,
      config,
      contextSnapshot,
      runtimeCompactionPolicy,
      turnStartedAt,
      remoteCompactStatus,
      timeline,
      humanAttention,
      streamingText,
      streamingActive,
      streamingAnchor,
      retainedDrafts,
      pendingApprovals,
      pendingAskUserChoices,
      queuedMessages,
      lastError,
      parentSessionId,
      parentCursor,
      selectedModel,
      toolExecutionStartedAt,
      hydratedSessionId,
      historyLoadedSessionId,
      historyAuthoritativeSessionId,
      selectionCurrent,
      boundSocket,
      sharedSocket,
      sessionId,
      sessionRouteTickets,
      reconnect,
    ],
  )
}

export function useDashboardControlSocket(host: string, token?: string, enabled = true): DashboardSocket | null {
  const [socket, setSocket] = useState<DashboardSocket | null>(null)

  useEffect(() => {
    if (!enabled) { setSocket(null); return }
    const next = openDashboardSocket(`${host}/dashboard`, {
      auth: {
        clientId: `dashboard-${CONTROL_SOCKET_SESSION_ID}`,
        role: 'dashboard',
        clientVersion: PROTOCOL_VERSION,
        ...(token !== undefined ? { token } : {}),
      },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: 30,
      randomizationFactor: 0.5,
    })
    const manager = dashboardConnectionManager(next)
    manager.acquire('global')
    const onPreferenceChange = (event: Event): void => {
      if ((event as CustomEvent<{ key: string }>).detail?.key === PREF_SESSION_SUBSCRIPTION_WARMTH_MINUTES) manager.updateWarmth()
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === PREF_SESSION_SUBSCRIPTION_WARMTH_MINUTES) manager.updateWarmth()
    }
    window.addEventListener('ak-pref-change', onPreferenceChange)
    window.addEventListener('storage', onStorage)
    setSocket(next)
    return () => {
      window.removeEventListener('ak-pref-change', onPreferenceChange)
      window.removeEventListener('storage', onStorage)
      next.close()
      setSocket((current) => current === next ? null : current)
    }
  }, [host, token, enabled])

  return socket
}

export function deriveHumanAttentionTimeline(
  sessionId: string | null,
  timeline: readonly TimelineEntry[],
): HumanAttentionTimeline {
  return sessionId ? buildHumanAttentionTimeline(sessionId, timeline) : { sessionId: '', points: [], latest: null }
}

export function deriveToolExecutionStartedAt(
  state: AgentState | null,
  timeline: readonly TimelineEntry[],
): number | null {
  if (!state || state.status !== 'executing_tools') return null
  const activeCallIds = new Set(
    state.pendingCalls
      .filter((call) => call.status === 'dispatched' || call.status === 'approved')
      .map((call) => call.callId),
  )
  if (activeCallIds.size === 0) return null
  let startedAt: number | null = null
  for (const entry of timeline) {
    if (!entry.effects.some((effect) => effect.kind === 'call_tool' && activeCallIds.has(effect.callId))) continue
    const parsed = Date.parse(entry.ts)
    if (!Number.isFinite(parsed)) continue
    startedAt = startedAt === null ? parsed : Math.min(startedAt, parsed)
  }
  return startedAt
}

function pendingCallToAskUserChoice(sessionId: string, call: PendingToolCall): AskUserChoiceRequest | null {
  const message = typeof call.input.message === 'string' ? call.input.message.trim() : ''
  const rawChoices = Array.isArray(call.input.choices) ? call.input.choices : []
  if (message.length === 0 || rawChoices.length === 0) return null
  const choices: AskUserChoiceOption[] = []
  const values = new Set<string>()
  for (const raw of rawChoices) {
    const choice = normalizeAskUserChoiceOption(raw)
    if (!choice || values.has(choice.value)) return null
    values.add(choice.value)
    choices.push(choice)
  }
  const defaultValue = typeof call.input.defaultValue === 'string' && values.has(call.input.defaultValue.trim())
    ? call.input.defaultValue.trim()
    : undefined
  const multiple = call.input.multiple === true
  const defaultValues = multiple && Array.isArray(call.input.defaultValues)
    ? [...new Set(call.input.defaultValues
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => values.has(value)))]
    : undefined
  return {
    sessionId,
    callId: call.callId,
    message,
    choices,
    ...(defaultValue ? { defaultValue } : {}),
    ...(defaultValues && defaultValues.length > 0 ? { defaultValues } : {}),
    ...(multiple ? { multiple: true } : {}),
    ...(call.intent ? { intent: call.intent } : {}),
  }
}

function normalizeAskUserChoiceOption(raw: unknown): AskUserChoiceOption | null {
  if (typeof raw === 'string') {
    const value = raw.trim()
    return value.length > 0 && value.length <= 500 ? { value } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const value = typeof record.value === 'string' ? record.value.trim() : ''
  if (value.length === 0 || value.length > 500) return null
  const label = typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : undefined
  const description = typeof record.description === 'string' && record.description.trim().length > 0 ? record.description.trim() : undefined
  return {
    value,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
  }
}

export function respondApproval(
  socket: DashboardSocket,
  sessionId: string,
  callId: string,
  decision: 'approve' | 'reject',
  reason?: string,
): void {
  if (decision === 'approve') {
    socket.emit('client:user_approve', { sessionId, callId })
  } else {
    socket.emit('client:user_reject', {
      sessionId,
      callId,
      ...(reason !== undefined ? { reason } : {}),
    })
  }
}

export function respondAskUserChoice(
  socket: DashboardSocket,
  sessionId: string,
  callId: string,
  response: { value: string } | { values: readonly string[] } | { customText: string },
): Promise<void> {
  return emitRpc(socket, 'client:ask_user_choice', { sessionId, callId, ...response })
}

export function deleteSession(
  socket: DashboardSocket,
  sessionId: string,
): Promise<void> {
  return emitRpc(socket, 'client:delete_session', { sessionId })
}

/**
 * Interrupt the current turn: dispatches a `cancel` event through the FSM so
 * pendingCalls are cleared and the executor is told to stop. This is stronger
 * than `client:cancel_stream`, which only aborts the in-flight HTTP call and
 * lets whatever was streamed become the final assistant message. Use this
 * when the user actually wants to stop the agent, not just cut the stream.
 */
export function cancelSession(
  socket: DashboardSocket,
  sessionId: string,
): Promise<void> {
  return emitRpc(socket, 'client:cancel', { sessionId })
}

export function clearSession(
  socket: DashboardSocket,
  sessionId: string,
): void {
  socket.emit('client:clear', { sessionId })
}

/**
 * Ask the host to materialise a session on disk bound to `workspaceId`.
 * Emitted when the user clicks "New" so the session shows up in the
 * Explorer immediately and is grouped under the right workspace, instead
 * of appearing in Unassigned after the first message triggers lazy-create.
 */
export function createSession(
  socket: DashboardSocket,
  input: {
    sessionId: string
    agentRuntime?: import('@agent-kernel/shared').AgentRuntimeId
    executionMode?: import('@agent-kernel/shared').SessionExecutionMode
    workspaceId?: string
    workspaceName?: string
    cwd?: string
    tools?: readonly string[]
    selectedModel?: string
  },
): void {
  socket.emit('client:create_session', {
    sessionId: input.sessionId,
    ...(input.agentRuntime ? { agentRuntime: input.agentRuntime } : {}),
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
    ...(input.cwd !== undefined && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.selectedModel !== undefined && input.selectedModel.length > 0 ? { selectedModel: input.selectedModel } : {}),
  })
}

export async function createSessionWithAck(
  socket: DashboardSocket,
  input: {
    sessionId: string
    agentRuntime?: import('@agent-kernel/shared').AgentRuntimeId
    executionMode?: import('@agent-kernel/shared').SessionExecutionMode
    workspaceId?: string
    workspaceName?: string
    cwd?: string
    tools?: readonly string[]
    selectedModel?: string
  },
  timeoutMs = 10_000,
  placement?: { host: string; token?: string },
): Promise<void> {
  let target = socket
  if (placement) {
    target = openDashboardSocket(`${placement.host}/dashboard`, {
      auth: {
        clientId: `dashboard-session-placement-${input.sessionId}`,
        role: 'dashboard',
        clientVersion: PROTOCOL_VERSION,
        ...(placement.token !== undefined ? { token: placement.token } : {}),
      },
      forceNew: true,
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      withCredentials: true,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Session placement connection timed out')), timeoutMs)
        const finish = (operation: () => void) => {
          window.clearTimeout(timer)
          target.off('connect', connected)
          target.off('connect_error', failed)
          operation()
        }
        const connected = () => finish(resolve)
        const failed = (error: Error) => finish(() => reject(error))
        target.on('connect', connected)
        target.on('connect_error', failed)
        target.connect()
      })
      await emitRpc(target, 'client:create_session', {
        sessionId: input.sessionId,
        ...(input.agentRuntime ? { agentRuntime: input.agentRuntime } : {}),
        ...(input.executionMode ? { executionMode: input.executionMode } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
        ...(input.cwd !== undefined && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.selectedModel !== undefined && input.selectedModel.length > 0 ? { selectedModel: input.selectedModel } : {}),
      }, { timeoutMs })
      return
    } finally {
      target.close()
    }
  }
  await emitRpc(target, 'client:create_session', {
    sessionId: input.sessionId,
    ...(input.agentRuntime ? { agentRuntime: input.agentRuntime } : {}),
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
    ...(input.cwd !== undefined && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.selectedModel !== undefined && input.selectedModel.length > 0 ? { selectedModel: input.selectedModel } : {}),
  }, { timeoutMs })
}

export function updateSessionPreferences(
  socket: DashboardSocket,
  sessionId: string,
  preferences: import('@agent-kernel/shared').SessionPreferencesPatch,
): Promise<void> {
  return emitRpc(socket, 'client:update_preferences', { sessionId, preferences })
}

export function setSessionApprovalMode(
  socket: DashboardSocket,
  sessionId: string,
  mode: import('@agent-kernel/kernel').ApprovalMode,
): Promise<void> {
  return emitRpc(socket, 'client:set_approval_mode', { sessionId, mode })
}

export function reorderQueuedMessage(
  socket: DashboardSocket,
  sessionId: string,
  id: string,
  beforeId?: string | null,
): Promise<void> {
  return emitRpc(socket, 'client:reorder_queued_message', {
    sessionId,
    id,
    ...(beforeId !== undefined ? { beforeId } : {}),
  })
}

export function updateQueuedMessage(
  socket: DashboardSocket,
  sessionId: string,
  id: string,
  text: string,
  content?: readonly MessageContent[],
): Promise<void> {
  return emitRpc(socket, 'client:update_queued_message', { sessionId, id, text, ...(content ? { content } : {}) })
}

export function deleteQueuedMessage(
  socket: DashboardSocket,
  sessionId: string,
  id: string,
): Promise<void> {
  return emitRpc(socket, 'client:delete_queued_message', { sessionId, id })
}

export function renameSession(
  socket: DashboardSocket,
  sessionId: string,
  label: string,
): void {
  socket.emit('client:rename_session', { sessionId, label })
}

export function renameWorkspace(
  socket: DashboardSocket,
  workspaceId: string,
  workspaceName: string,
): void {
  socket.emit('client:rename_workspace', { workspaceId, workspaceName })
}

export type ControlPlaneView = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  agentRuntimes: readonly import('@agent-kernel/shared').AgentRuntimeDescriptor[]
  executorsLoaded: boolean
  sessionsLoaded: boolean
  refreshSessions(): void
}

/**
 * Subscribes to the host's control-plane events (executors / sessions) using
 * an already-open dashboard socket. Fetches an initial snapshot on socket
 * change and keeps the daemon list live via `server:control_update`.
 *
 * Sessions are fetched on connect and on `refreshSessions()`, and then kept
 * coherent by host pushes such as `server:sessions` and
 * `server:session_deleted`. The App still treats the snapshot as advisory and
 * validates navigation targets before switching sessions, because fork/delete
 * races can leave stale parent links in old summaries.
 */
export function useControlPlane(
  socket: DashboardSocket | null,
): ControlPlaneView {
  const [executors, setExecutors] = useState<readonly AttachedExecutor[]>([])
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [agentRuntimes, setAgentRuntimes] = useState<readonly import('@agent-kernel/shared').AgentRuntimeDescriptor[]>([])
  const [executorsLoaded, setExecutorsLoaded] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const summaryStoreRef = useRef<SessionSummaryStore | null>(null)
  if (summaryStoreRef.current === null) summaryStoreRef.current = new SessionSummaryStore()

  useEffect(() => {
    const summaryStore = summaryStoreRef.current!
    if (!socket) {
      summaryStore.clear()
      setExecutors([])
      setSessions([])
      setAgentRuntimes([])
      setExecutorsLoaded(false)
      setSessionsLoaded(false)
      return
    }
    let active = true
    let cancelSummaryFlush: (() => void) | null = null
    let summaryUpdates: Array<(sessions: readonly SessionSummary[]) => readonly SessionSummary[]> = []
    const isActive = (): boolean => active
    const flushSummaryUpdates = (): void => {
      cancelSummaryFlush?.()
      cancelSummaryFlush = null
      if (summaryUpdates.length === 0) return
      const updates = summaryUpdates
      summaryUpdates = []
      setSessions((current) => summaryStore.replace(updates.reduce((next, update) => update(next), current)))
    }
    const enqueueSummaryUpdate = (update: (sessions: readonly SessionSummary[]) => readonly SessionSummary[]): void => {
      summaryUpdates.push(update)
      if (cancelSummaryFlush !== null) return
      cancelSummaryFlush = scheduleFrameTask(() => {
        cancelSummaryFlush = null
        flushSummaryUpdates()
      })
    }
    const onExecutors = (p: { executors: readonly AttachedExecutor[] }): void => {
      if (!isActive()) return
      setExecutors(p.executors)
      setExecutorsLoaded(true)
    }
    const onSessions = (p: { sessions: readonly SessionSummary[] }): void => {
      if (!isActive()) return
      flushSummaryUpdates()
      setSessions(summaryStore.replace(p.sessions))
      setSessionsLoaded(true)
    }
    const onAgentRuntimes: DashboardServerToClientEvents['server:agent_runtimes'] = (p) => {
      if (isActive()) setAgentRuntimes(p.runtimes)
    }
    const onExecutorChanged = (change: Extract<ControlUpdate, { kind: 'executor_changed' }>): void => {
      if (!isActive()) return
      setExecutorsLoaded(true)
      setExecutors((prev) => {
        if (change.change === 'detached') {
          // Host now debounces detach with a grace window, so by the time
          // this event lands the workspace is really gone. Drop by both
          // executorId AND workspaceId — a restarted process reattaches
          // with a fresh executorId but same workspaceId, and we don't
          // want a lingering stale row.
          return prev.filter((e) => e.executorId !== change.executorId)
        }
        // attached/updated: dedupe by workspaceId so an executor process
        // restart (fresh executorId, same workspaceId) replaces the old
        // row in place instead of showing two entries for one machine.
        const next = prev.filter(
          (e) =>
            e.executorId !== change.executorId &&
            e.workspaceId !== change.executor.workspaceId,
        )
        next.push(change.executor)
        return next
      })
    }
    const onControlUpdate = (payload: ControlUpdate): void => {
      if (!isActive()) return
      if (payload.kind === 'session_summary_changed') {
        enqueueSummaryUpdate(() => summaryStore.update(
          payload.session.sessionId,
          () => payload.session,
        ))
      }
      if (payload.kind === 'session_meta_changed') {
        setSessions((current) => summaryStore.replace(current.map((summary) =>
          summary.sessionId === payload.sessionId
            ? {
                ...summary,
                ...(payload.label !== undefined && payload.label.trim().length > 0
                  ? { label: payload.label }
                  : payload.label !== undefined
                    ? { label: undefined }
                    : {}),
                ...(payload.preferences !== undefined ? { preferences: payload.preferences } : {}),
              }
            : summary,
        )))
      }
      if (payload.kind === 'executor_changed') {
        onExecutorChanged(payload)
      }
    }
    const onEventAppended: DashboardServerToClientEvents['event:appended'] = (p) => {
      if (!isActive()) return
      enqueueSummaryUpdate((prev) => updateSessionSummaryFromEvent(prev, p))
    }
    const onStateChanged: DashboardServerToClientEvents['state:changed'] = (p) => {
      if (!isActive()) return
      enqueueSummaryUpdate((prev) => updateSessionSummary(prev, p.sessionId, (s) => ({
        ...s,
        status: p.state.status,
        ...(p.state.cwd ? { currentCwd: p.state.cwd } : { currentCwd: undefined }),
      })))
    }
    const onMessageQueue: DashboardServerToClientEvents['server:message_queue'] = (p) => {
      if (!isActive()) return
      enqueueSummaryUpdate((prev) => updateSessionSummary(prev, p.sessionId, (s) => ({
        ...s,
        queuedCount: p.pending,
        status: p.pending > 0 && isRestingSessionStatus(s.status) ? 'idle' : s.status,
      })))
    }
    socket.on('server:executors', onExecutors)
    socket.on('server:sessions', onSessions)
    socket.on('server:agent_runtimes', onAgentRuntimes)
    socket.on('server:control_update', onControlUpdate)
    socket.on('event:appended', onEventAppended)
    socket.on('state:changed', onStateChanged)
    socket.on('server:message_queue', onMessageQueue)
    const onSessionDeleted: DashboardServerToClientEvents['server:session_deleted'] = (
      payload,
    ) => {
      if (!isActive()) return
      setSessions((current) => summaryStore.replace(current.filter((summary) => summary.sessionId !== payload.sessionId)))
    }
    socket.on('server:session_deleted', onSessionDeleted)

    const requestBoth = (): void => {
      if (!isActive()) return
      socket.emit('client:list_executors', {})
      socket.emit('client:list_sessions', {})
    }
    if (socket.connected) requestBoth()
    socket.on('connect', requestBoth)

    return () => {
      active = false
      cancelSummaryFlush?.()
      cancelSummaryFlush = null
      summaryUpdates = []
      socket.off('server:executors', onExecutors)
      socket.off('server:sessions', onSessions)
      socket.off('server:agent_runtimes', onAgentRuntimes)
      socket.off('server:control_update', onControlUpdate)
      socket.off('event:appended', onEventAppended)
      socket.off('state:changed', onStateChanged)
      socket.off('server:message_queue', onMessageQueue)
      socket.off('server:session_deleted', onSessionDeleted)
      socket.off('connect', requestBoth)
    }
  }, [socket])

  const refreshSessions = useMemo(
    () => () => {
      if (socket && socket.connected) socket.emit('client:list_sessions', {})
    },
    [socket],
  )

  return { executors, sessions, agentRuntimes, executorsLoaded, sessionsLoaded, refreshSessions }
}

export function mergeSessionSummaries(
  prev: readonly SessionSummary[],
  incoming: readonly SessionSummary[],
): readonly SessionSummary[] {
  if (prev.length === 0) return incoming
  const incomingById = new Map(incoming.map((s) => [s.sessionId, s]))
  const prevById = new Map(prev.map((s) => [s.sessionId, s]))
  const next: SessionSummary[] = []
  for (const old of prev) {
    const fresh = incomingById.get(old.sessionId)
    if (!fresh) continue
    next.push(fresh)
  }
  for (const fresh of incoming) {
    if (!prevById.has(fresh.sessionId)) next.push(fresh)
  }
  return next
}

function updateSessionSummary(
  sessions: readonly SessionSummary[],
  sessionId: string,
  update: (summary: SessionSummary) => SessionSummary,
): readonly SessionSummary[] {
  let changed = false
  const next = sessions.map((summary) => {
    if (summary.sessionId !== sessionId) return summary
    changed = true
    return update(summary)
  })
  return changed ? next : sessions
}

function updateSessionSummaryFromEvent(
  sessions: readonly SessionSummary[],
  entry: EventAppendedEvent,
): readonly SessionSummary[] {
  return updateSessionSummary(sessions, entry.sessionId, (summary) => {
    const nextStatus = projectStatusFromEntry(summary.status ?? 'idle', timelineEntry(entry))
    const nextCwd = entry.event.kind === 'cwd_changed' ? entry.event.cwd : summary.currentCwd
    return {
      ...summary,
      status: nextStatus,
      lastEventAt: entry.ts,
      eventCount: Math.max(summary.eventCount, entry.seq),
      ...(nextCwd ? { currentCwd: nextCwd } : { currentCwd: undefined }),
      ...(summary.firstUserMessage || entry.event.kind !== 'user_message' || !entry.event.text
        ? {}
        : { firstUserMessage: entry.event.text.slice(0, 120) }),
    }
  })
}

function isRestingSessionStatus(status: SessionSummary['status'] | undefined): boolean {
  return status === undefined || status === 'idle' || status === 'done' || status === 'error'
}

export { mergeBySeq } from './session-projection.js'
