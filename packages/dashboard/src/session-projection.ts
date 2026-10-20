import type { AgentConfig, AgentEvent, AgentState, Effect, Message } from '@agent-kernel/kernel'
import { step } from '@agent-kernel/kernel'
import type {
  AgentRuntimeId,
  CompactStatusEvent, CompactionMetadata, ContextUsageSnapshot, EventAppendedEvent,
  LLMTrace, QueuedMessagePreview, RuntimeCompactionPolicy, SessionErrorEvent, SessionReadyEvent, StateChangedEvent,
} from '@agent-kernel/shared'
import type { SessionExecutionMode } from '@agent-kernel/shared'
import {
  COPILOT_RUNTIME_COMPACTION_POLICY,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  kernelRuntimeCompactionPolicy,
} from '@agent-kernel/shared'

import type { CachedSessionView } from './session-view-cache.js'

export type TimelineEntry = {
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly Effect[]
  hasEffectsArtifact?: boolean
  hasLlmTraceArtifact?: boolean
  llmTrace?: LLMTrace
  model?: string
  timing?: import('@agent-kernel/shared').EventTimingMetadata
  compactionMetadata?: CompactionMetadata
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'disconnected'

export type SessionProjection = {
  generation: number
  sessionId: string | null
  agentRuntime: AgentRuntimeId
  executionMode: SessionExecutionMode
  status: ConnectionStatus
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  runtimeCompactionPolicy: RuntimeCompactionPolicy
  turnStartedAt: string | null
  /** Cursor of the authoritative payload that supplied turnStartedAt. */
  turnStartedAtCursor: number | null
  compactStatus: CompactStatusEvent | null
  timeline: readonly TimelineEntry[]
  queuedMessages: readonly QueuedMessagePreview[]
  lastError: SessionErrorEvent | null
  parentSessionId: string | null
  parentCursor: number | null
  selectedModel: string | null
  hydratedSessionId: string | null
  historyLoadedSessionId: string | null
  /** Only set by a Host history response, never by a cached transcript. */
  historyAuthoritativeSessionId: string | null
}

type Scoped = { generation: number; sessionId: string }
export type SessionProjectionEvent =
  | { kind: 'select'; generation: number; sessionId: string | null; cached?: CachedSessionView | null }
  | ({ kind: 'hydrate'; cached: CachedSessionView } & Scoped)
  | ({ kind: 'ready'; payload: SessionReadyEvent } & Scoped)
  | ({ kind: 'history'; entries: readonly TimelineEntry[]; reset?: boolean; authoritative?: boolean } & Scoped)
  | ({ kind: 'authoritative'; payload: StateChangedEvent } & Scoped)
  | ({ kind: 'appended'; payload: EventAppendedEvent } & Scoped)
  | ({ kind: 'queue'; items: readonly QueuedMessagePreview[] } & Scoped)
  | ({ kind: 'error'; error: SessionErrorEvent } & Scoped)
  | ({ kind: 'status'; status: ConnectionStatus } & Scoped)
  | ({ kind: 'compact'; compactStatus: CompactStatusEvent } & Scoped)
  | ({ kind: 'model'; selectedModel: string | null } & Scoped)
  | ({ kind: 'reset_timeline' } & Scoped)

export const EMPTY_SESSION_PROJECTION: SessionProjection = {
  generation: 0, sessionId: null, agentRuntime: 'kernel', executionMode: 'chat', status: 'idle', state: null, config: null,
  contextSnapshot: null, runtimeCompactionPolicy: kernelRuntimeCompactionPolicy(), turnStartedAt: null, turnStartedAtCursor: null,
  compactStatus: null, timeline: [], queuedMessages: [],
  lastError: null, parentSessionId: null, parentCursor: null, selectedModel: null,
  hydratedSessionId: null, historyLoadedSessionId: null, historyAuthoritativeSessionId: null,
}

export function reduceSessionProjectionBatch(
  current: SessionProjection,
  events: readonly SessionProjectionEvent[],
): SessionProjection {
  let next = current
  for (const event of events) next = reduceSessionProjection(next, event)
  return next
}

export function reduceSessionProjection(
  current: SessionProjection,
  event: SessionProjectionEvent,
): SessionProjection {
  if (event.kind === 'select') {
    if (event.sessionId === null) return { ...EMPTY_SESSION_PROJECTION, generation: event.generation }
    const cached = event.cached
    return {
      ...EMPTY_SESSION_PROJECTION, generation: event.generation, sessionId: event.sessionId, status: 'connecting',
      ...(cached ? projectionFromCache(cached) : {}),
    }
  }
  if (event.generation !== current.generation || event.sessionId !== current.sessionId) return current

  switch (event.kind) {
    case 'hydrate':
      return { ...current, ...projectionFromCache(event.cached), status: 'connecting' }
    case 'ready': {
      const p = event.payload
      return {
        ...current, status: 'ready', agentRuntime: p.agentRuntime ?? 'kernel', executionMode: p.executionMode ?? 'chat', state: p.state, config: p.config,
        contextSnapshot: p.contextSnapshot ?? null,
        runtimeCompactionPolicy: p.runtimeCompactionPolicy
          ?? (p.agentRuntime === 'copilot'
            ? COPILOT_RUNTIME_COMPACTION_POLICY
            : kernelRuntimeCompactionPolicy(p.config.softThreshold, p.config.hardThreshold)),
        compactStatus: p.compactStatus?.scope?.kind === 'subagent' ? null : (p.compactStatus ?? null),
        // Ready is the authoritative baseline and may deliberately clear a stale cached value.
        turnStartedAt: p.turnStartedAt ?? null, turnStartedAtCursor: p.turnStartedAt ? p.cursor : null,
        parentSessionId: p.parentSessionId ?? null,
        parentCursor: p.parentCursor ?? null, selectedModel: p.selectedModel ?? null,
        hydratedSessionId: p.sessionId, historyAuthoritativeSessionId: null, lastError: null,
      }
    }
    case 'history':
      return {
        ...current,
        // A reset response is an authoritative server replay, not another live
        // delta. It must replace conflicting cached/live entries at the same seq.
        timeline: event.reset
          ? authoritativeTimeline(event.entries)
          : mergeBySeq(current.timeline, event.entries),
        historyLoadedSessionId: event.sessionId,
        historyAuthoritativeSessionId: event.authoritative === false ? current.historyAuthoritativeSessionId : event.sessionId,
      }
    case 'authoritative': {
      const p = event.payload
      // State, context, and turn timing form one Host projection. A delayed
      // correction must not regress only part of that projection.
      if (current.state && p.cursor < current.state.cursor) return current
      const acceptsTurnStart = p.turnStartedAt !== undefined
        && (current.turnStartedAtCursor === null || p.cursor >= current.turnStartedAtCursor)
      return {
        ...current, state: p.state, contextSnapshot: p.contextSnapshot ?? null,
        // Missing legacy/same-turn corrections preserve a known start. A newer
        // explicit value may begin the next turn; ready can authoritatively clear.
        ...(acceptsTurnStart ? { turnStartedAt: p.turnStartedAt!, turnStartedAtCursor: p.cursor } : {}),
      }
    }
    case 'appended': {
      const entry = timelineEntry(event.payload)
      let state = current.state
      let contextSnapshot = current.contextSnapshot
      if (current.agentRuntime === 'kernel' && state && current.config && event.payload.seq === state.cursor + 1) {
        state = step(state, event.payload.event, current.config).next
        contextSnapshot = reprojectContextSnapshotAfterStateChange(current.config, state.messages, contextSnapshot)
      }
      return {
        ...current, state, contextSnapshot, lastError: null,
        timeline: mergeBySeq(current.timeline, [entry]),
      }
    }
    case 'queue': return { ...current, queuedMessages: event.items }
    case 'error': return { ...current, lastError: event.error }
    case 'status': return { ...current, status: event.status }
    case 'compact':
      if (event.compactStatus.scope?.kind === 'subagent') return current
      return { ...current, compactStatus: event.compactStatus }
    case 'model': return { ...current, selectedModel: event.selectedModel }
    case 'reset_timeline': return { ...current, timeline: [], historyLoadedSessionId: null, historyAuthoritativeSessionId: null }
  }
}

function projectionFromCache(cached: CachedSessionView): Partial<SessionProjection> {
  return {
    agentRuntime: cached.agentRuntime ?? 'kernel',
    executionMode: cached.executionMode ?? 'chat',
    state: cached.state, config: cached.config, contextSnapshot: cached.contextSnapshot,
    runtimeCompactionPolicy: cached.runtimeCompactionPolicy ?? kernelRuntimeCompactionPolicy(
      cached.config?.softThreshold,
      cached.config?.hardThreshold,
    ),
    turnStartedAt: cached.turnStartedAt ?? null, turnStartedAtCursor: cached.turnStartedAtCursor ?? null,
    timeline: cached.timeline, queuedMessages: cached.queuedMessages, lastError: cached.lastError,
    parentSessionId: cached.parentSessionId, parentCursor: cached.parentCursor,
    // Cached content is paint-ready, but it is not an authoritative live
    // baseline. Only session:ready may mark the current selection hydrated;
    // otherwise a stale cached running state can override a terminal Host
    // summary while switching Sessions and make a completed row flash running.
    selectedModel: cached.selectedModel, hydratedSessionId: null, historyLoadedSessionId: cached.sessionId,
  }
}

export function timelineEntry(p: EventAppendedEvent): TimelineEntry {
  return {
    seq: p.seq, ts: p.ts, event: p.event, effects: p.effects,
    ...(p.hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
    ...(p.hasLlmTraceArtifact ? { hasLlmTraceArtifact: true } : {}),
    ...(p.llmTrace ? { llmTrace: p.llmTrace } : {}), ...(p.model ? { model: p.model } : {}),
    ...(p.timing ? { timing: p.timing } : {}),
    ...(p.compactionMetadata ? { compactionMetadata: p.compactionMetadata } : {}),
  }
}

function authoritativeTimeline(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  const bySeq = new Map<number, TimelineEntry>()
  // The Host reader already applies first-durable-entry-wins to legacy duplicate
  // logs. Preserve that deterministic policy if a malformed history payload is
  // encountered at the client boundary.
  for (const entry of entries) if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function mergeBySeq(prev: readonly TimelineEntry[], add: readonly TimelineEntry[]): readonly TimelineEntry[] {
  if (add.length === 0) return prev
  // The live event stream and ordinary history tail are strictly increasing.
  // Preserve those entry identities and append in O(add.length); replay overlap,
  // metadata enrichment, gaps inserted before the tail, and malformed ordering
  // deliberately fall through to the authoritative merge below.
  const previousLastSeq = prev.at(-1)?.seq ?? Number.NEGATIVE_INFINITY
  if (isStrictlyIncreasingAfter(add, previousLastSeq)) return [...prev, ...add]
  const map = new Map<number, TimelineEntry>()
  for (const entry of prev) map.set(entry.seq, entry)
  for (const entry of add) {
    const existing = map.get(entry.seq)
    if (!existing || sameTimelineEvent(existing, entry)) map.set(entry.seq, existing ? { ...existing, ...entry } : entry)
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq)
}

function isStrictlyIncreasingAfter(entries: readonly TimelineEntry[], previousSeq: number): boolean {
  let lastSeq = previousSeq
  for (const entry of entries) {
    if (entry.seq <= lastSeq) return false
    lastSeq = entry.seq
  }
  return true
}

function sameTimelineEvent(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.event.kind !== b.event.kind) return false
  if ('callId' in a.event || 'callId' in b.event) {
    return 'callId' in a.event && 'callId' in b.event && a.event.callId === b.event.callId
  }
  return true
}

function reprojectContextSnapshotAfterStateChange(
  config: AgentConfig, messages: readonly Message[], prior: ContextUsageSnapshot | null,
): ContextUsageSnapshot {
  let transcriptTokens = 0
  let userMessageTokens = 0
  let assistantMessageTokens = 0
  let toolResultTokens = 0
  for (const message of messages) {
    const tokens = estimateMessageTokens([message])
    transcriptTokens += tokens
    if (message.role === 'user') userMessageTokens += tokens
    else if (message.role === 'assistant') assistantMessageTokens += tokens
    else if (message.role === 'tool') toolResultTokens += tokens
  }
  const toolTokens = estimateToolSchemaTokens(config.tools)
  const system = reserveForContext(prior?.contextWindow.tokens ?? config.contextLimit)
  const inputTokens = transcriptTokens + toolTokens + system
  return {
    model: prior?.model ?? { ref: 'unknown' },
    contextWindow: prior?.contextWindow ?? { tokens: null, source: 'unknown' },
    usage: { inputTokens, totalTokens: inputTokens },
    breakdown: {
      system,
      transcript: transcriptTokens,
      tools: toolTokens,
      memory: prior?.breakdown.memory ?? 0,
      attachments: prior?.breakdown.attachments ?? 0,
      pendingUserInput: 0,
      transcriptBreakdown: {
        userMessages: userMessageTokens,
        assistantMessages: assistantMessageTokens,
        toolResults: toolResultTokens,
      },
    },
    estimator: prior?.estimator ?? { total: { kind: 'heuristic', confidence: 'rough' },
      breakdown: { kind: 'heuristic', confidence: 'rough' }, version: 'heuristic-v1' },
    updatedAt: Date.now(),
  }
}

function reserveForContext(limit: number | null | undefined): number {
  const positive = positiveInt(limit)
  if (!positive) return 16_384
  return Math.min(16_384, Math.floor(positive * 0.1))
}

function positiveInt(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const int = Math.floor(value)
  return int > 0 ? int : undefined
}
