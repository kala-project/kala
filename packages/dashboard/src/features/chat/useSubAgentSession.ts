/**
 * Live view of a single sub-agent child session.
 *
 * The dashboard listens for `server:control_update` on the parent's room to
 * discover children spawned by the current turn; when one arrives with a
 * matching `parentCallId` we subscribe to the child's `session:<id>` room and
 * mirror `state.messages` via `session:ready` + `state:changed` so the nested
 * read-only ChatPanel can render the child transcript in real time.
 *
 * The initial "lifecycle" is optional: when a session is being replayed from
 * disk we already know the child from the `<sub_agent>` envelope, so callers
 * pass `initialChildSessionId` to short-circuit subscription and skip the
 * wait for a `_started` push that will never arrive. Live and replayed
 * children share the same reducer once subscribed.
 *
 * See docs/host/sub-agent-design.md §5 and [[sub-agent-envelope]] for the
 * envelope parser that seeds `initialChildSessionId`.
 */

import { useContext, useEffect, useRef, useState } from 'react'

import type { Message } from '@agent-kernel/kernel'
import type {
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  ControlUpdate,
  SessionReadyEvent,
  StateChangedEvent,
  SubAgentListResult,
} from '@agent-kernel/shared'

import { dashboardConnectionManager, SessionInspectionContext, useSession, type DashboardSocket } from '../../session.js'

export type SubAgentLifecycle =
  | { status: 'idle' }
  | { status: 'running'; childSessionId: string; startedAt: string }
  | {
      status: 'completed'
      childSessionId: string
      turns: number
      durationMs: number
      finishedAt: string
      startedAt?: string
    }
  | {
      status: 'failed'
      childSessionId: string
      error: string
      turns: number
      durationMs: number
      finishedAt: string
      startedAt?: string
    }
  | {
      status: 'cancelled'
      childSessionId: string
      error: string
      turns: number
      durationMs: number
      finishedAt: string
      startedAt?: string
    }

export type SubAgentView = {
  lifecycle: SubAgentLifecycle
  messages: readonly Message[]
  transcriptError?: string
  agentType?: string
  intention?: string
  prompt?: string
  model?: string
}

type Params = {
  socket: DashboardSocket | null
  parentSessionId: string
  parentCallId: string
  /**
   * Child transcripts are expensive full-state projections. Keep lifecycle
   * discovery on the parent room, but only join the child room while its
   * transcript is visible.
   */
  mirrorMessages?: boolean
  /**
   * Present when the row is being replayed from a pre-existing envelope; the
   * hook skips waiting for a `_started` push and subscribes immediately.
   */
  initialChildSessionId?: string
  /**
   * When replaying, callers may already know the terminal status from the
   * envelope. Provided so the row can render the "completed"/"failed" state
   * before subscribe finishes and without waiting for a `_finished` push
   * that will never arrive.
   */
  initialLifecycle?: SubAgentLifecycle
  initialAgentType?: string
  initialIntention?: string
}

export function useSubAgentSession({
  socket,
  parentSessionId,
  parentCallId,
  initialChildSessionId,
  initialLifecycle,
  initialAgentType,
  initialIntention,
  mirrorMessages = true,
}: Params): SubAgentView {
  const [lifecycle, setLifecycle] = useState<SubAgentLifecycle>(
    initialLifecycle ??
      (initialChildSessionId
        ? { status: 'running', childSessionId: initialChildSessionId, startedAt: '' }
        : { status: 'idle' }),
  )
  const [messages, setMessages] = useState<readonly Message[]>([])
  const [agentType, setAgentType] = useState<string | undefined>(initialAgentType)
  const [intention, setIntention] = useState<string | undefined>(initialIntention)
  const [prompt, setPrompt] = useState<string | undefined>(undefined)
  const [model, setModel] = useState<string | undefined>(undefined)

  const childIdRef = useRef<string | null>(initialChildSessionId ?? null)

  // Recover lifecycle after a dashboard refresh. Live start/finish pushes are
  // ephemeral; the durable relation is the child session header returned by
  // `sub_agent:list`.
  useEffect(() => {
    if (!socket || childIdRef.current) return
    let cancelled = false
    socket.emit(
      'sub_agent:list',
      { requestId: `sub-agent-${parentSessionId}-${parentCallId}`, parentSessionId },
      (result: SubAgentListResult) => {
        if (cancelled || result.error) return
        const child = result.children.find((entry) => entry.parentCallId === parentCallId)
        if (!child) return
        childIdRef.current = child.childSessionId
        if (child.agentType) setAgentType(child.agentType)
        setLifecycle(() => {
          if (child.status === 'failed' || child.status === 'cancelled') {
            return {
              status: child.status,
              childSessionId: child.childSessionId,
              error: child.error ?? 'sub-agent ended before this dashboard connected',
              turns: child.turns ?? 0,
              durationMs: child.durationMs ?? 0,
              finishedAt: child.finishedAt ?? '',
              ...(child.startedAt ? { startedAt: child.startedAt } : {}),
            }
          }
          if (child.status === 'completed') {
            return {
              status: 'completed',
              childSessionId: child.childSessionId,
              turns: child.turns ?? 0,
              durationMs: child.durationMs ?? 0,
              finishedAt: child.finishedAt ?? '',
              ...(child.startedAt ? { startedAt: child.startedAt } : {}),
            }
          }
          return {
            status: 'running',
            childSessionId: child.childSessionId,
            startedAt: child.startedAt ?? '',
          }
        })
      },
    )
    return () => {
      cancelled = true
    }
  }, [socket, parentSessionId, parentCallId])

  // Watch the parent's room for our specific tool call to fire.
  useEffect(() => {
    if (!socket) return
    const onStarted = (payload: ServerSubAgentStartedEvent): void => {
      if (payload.parentSessionId !== parentSessionId) return
      if (payload.parentCallId !== parentCallId) return
      childIdRef.current = payload.childSessionId
      setLifecycle({
        status: 'running',
        childSessionId: payload.childSessionId,
        startedAt: payload.startedAt,
      })
      if (payload.agentType) setAgentType(payload.agentType)
      if (payload.intention) setIntention(payload.intention)
      setPrompt(payload.prompt)
      setModel(payload.model)
    }
    const onFinished = (payload: ServerSubAgentFinishedEvent): void => {
      if (payload.parentSessionId !== parentSessionId) return
      if (payload.parentCallId !== parentCallId) return
      setLifecycle((prev) => {
        const startedAt = prev.status === 'running' ? prev.startedAt : undefined
        if (
          payload.status === 'failed'
          || payload.status === 'cancelled'
          || payload.status === 'timed_out_with_partial_result'
        ) {
          return {
            status: payload.status === 'timed_out_with_partial_result' ? 'failed' : payload.status,
            childSessionId: payload.childSessionId,
            error: payload.error ??
              (payload.status === 'timed_out_with_partial_result'
                ? 'sub-agent timed out with a partial result'
                : 'unknown error'),
            turns: payload.turns,
            durationMs: payload.durationMs,
            finishedAt: payload.finishedAt,
            ...(startedAt ? { startedAt } : {}),
          }
        }
        return {
          status: 'completed',
          childSessionId: payload.childSessionId,
          turns: payload.turns,
          durationMs: payload.durationMs,
          finishedAt: payload.finishedAt,
          ...(startedAt ? { startedAt } : {}),
        }
      })
    }
    const onControlUpdate = (payload: ControlUpdate): void => {
      if (payload.kind === 'sub_agent_started') onStarted(payload)
      if (payload.kind === 'sub_agent_finished') onFinished(payload)
    }

    socket.on('server:control_update', onControlUpdate)
    return () => {
      socket.off('server:control_update', onControlUpdate)
    }
  }, [socket, parentSessionId, parentCallId])

  // Once we know the child session id (either from a start event or from
  // replay), subscribe to its room and mirror its state.
  const childSessionId =
    lifecycle.status !== 'idle' ? lifecycle.childSessionId : initialChildSessionId

  const transport = useContext(SessionInspectionContext)
  const independentlyRouted = Boolean(transport?.sessionScoped || transport?.sessionRouteTickets)
  // Reuse the same owner/ticket/reconnect lifecycle as the main Session. Only
  // expanded scoped views connect; no cache or model action is attached here.
  const child = useSession({
    host: transport?.host ?? '',
    socket: transport?.socket,
    sessionScoped: transport?.sessionScoped,
    sessionRouteTickets: transport?.sessionRouteTickets,
    token: transport?.token,
    sessionId: independentlyRouted && mirrorMessages ? childSessionId ?? null : null,
  })

  useEffect(() => {
    if (!socket || !childSessionId || !mirrorMessages || independentlyRouted) return
    let cancelled = false

    const onReady = (payload: SessionReadyEvent): void => {
      if (cancelled || payload.sessionId !== childSessionId) return
      setMessages(payload.state.messages)
    }
    const onStateChanged = (payload: StateChangedEvent): void => {
      if (cancelled || payload.sessionId !== childSessionId) return
      setMessages(payload.state.messages)
    }

    socket.on('session:ready', onReady)
    socket.on('state:changed', onStateChanged)
    const releaseChannel = dashboardConnectionManager(socket).acquire(
      `session:${childSessionId}`,
      undefined,
      { retainWarm: false },
    )

    return () => {
      cancelled = true
      socket.off('session:ready', onReady)
      socket.off('state:changed', onStateChanged)
      releaseChannel()
    }
  }, [socket, childSessionId, mirrorMessages, independentlyRouted])

  return {
    lifecycle,
    messages: independentlyRouted ? child.state?.messages ?? [] : messages,
    ...(independentlyRouted && child.lastError ? { transcriptError: child.lastError.message } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(intention !== undefined ? { intention } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(model !== undefined ? { model } : {}),
  }
}
