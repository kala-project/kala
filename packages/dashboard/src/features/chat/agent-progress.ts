import type { AgentState } from '@agent-kernel/kernel'
import type { AgentRuntimeId } from '@agent-kernel/shared'

import type { TimelineEntry } from '../../session.js'

export type AgentProgress = {
  phase: 'idle' | 'thinking' | 'tools' | 'approval' | 'done' | 'error'
  label: string
  intention?: string
  callId?: string
  outcome?: 'running' | 'succeeded' | 'failed' | 'approval'
  startedAt?: number
  durationMs?: number
}

type PersistedToolCall = { callId: string; intention: string }

export function deriveAgentProgress(
  state: AgentState | null,
  timeline: readonly TimelineEntry[],
  turnStartedAt?: string | null,
  agentRuntime: AgentRuntimeId = 'kernel',
): AgentProgress {
  const status = state?.status
  const calls = persistedToolIntentions(timeline)

  if (status === 'executing_tools') {
    const current = latestPendingIntention(state!, calls, timeline, 'dispatched')
    return current
      ? { phase: 'tools', label: current.intention, intention: current.intention, callId: current.callId, outcome: 'running', ...(current.startedAt !== undefined ? { startedAt: current.startedAt } : {}) }
      : { phase: 'tools', label: 'Working' }
  }

  if (status === 'awaiting_approval') {
    const current = latestPendingIntention(state!, calls, timeline, 'awaiting_approval')
    return current
      ? { phase: 'approval', label: current.intention, intention: current.intention, callId: current.callId, outcome: 'approval' }
      : { phase: 'approval', label: 'Working' }
  }

  if (status === 'thinking') {
    const previous = latestSettledToolIntention(timeline, calls)
    if (previous) {
      return {
        phase: 'thinking',
        label: previous.intention,
        intention: previous.intention,
        callId: previous.callId,
        outcome: previous.ok ? 'succeeded' : 'failed',
        ...(previous.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
      }
    }
    const startedAt = agentRuntime === 'kernel'
      ? currentThinkingStartedAt(timeline, turnStartedAt)
      : parsedTimestamp(turnStartedAt)
    return {
      phase: 'thinking',
      label: agentRuntime === 'kernel' ? 'Thinking' : 'Working',
      ...(startedAt !== undefined ? { startedAt } : {}),
    }
  }

  if (status === 'error') return { phase: 'error', label: 'Message failed. Check the error before retrying.' }
  if (status === 'done') return { phase: 'done', label: 'Turn complete' }
  return { phase: 'idle', label: 'Ready' }
}

function persistedToolIntentions(timeline: readonly TimelineEntry[]): Map<string, PersistedToolCall> {
  const calls = new Map<string, PersistedToolCall>()
  for (const entry of timeline) {
    if (entry.event.kind !== 'llm_response') continue
    for (const content of entry.event.message.content) {
      if (content.type !== 'tool_call') continue
      const intention = content.intent?.trim()
      if (intention) calls.set(content.callId, { callId: content.callId, intention })
    }
  }
  return calls
}

function latestPendingIntention(
  state: AgentState,
  calls: ReadonlyMap<string, PersistedToolCall>,
  timeline: readonly TimelineEntry[],
  pendingStatus: 'dispatched' | 'awaiting_approval',
): (PersistedToolCall & { startedAt?: number }) | undefined {
  for (let index = state.pendingCalls.length - 1; index >= 0; index -= 1) {
    const pending = state.pendingCalls[index]
    if (pending?.status !== pendingStatus) continue
    const call = calls.get(pending.callId)
    if (call) {
      const startedAt = pendingStatus === 'dispatched' ? toolStartedAt(timeline, call.callId) : undefined
      return { ...call, ...(startedAt !== undefined ? { startedAt } : {}) }
    }
  }
  return undefined
}

function latestSettledToolIntention(
  timeline: readonly TimelineEntry[],
  calls: ReadonlyMap<string, PersistedToolCall>,
): (PersistedToolCall & { ok: boolean; durationMs?: number }) | undefined {
  // A previous-step bridge is turn-local. Once a newer user_message starts a
  // turn, an older result must not reappear while the Agent plans its first step.
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index]
    const event = entry?.event
    if (!event) continue
    if (event.kind === 'user_message') return undefined
    if (event.kind !== 'tool_result') continue
    const call = calls.get(event.callId)
    if (call) {
      const durationMs = entry.timing?.span?.callId === event.callId
        ? entry.timing.span.durationMs
        : durationBetween(toolStartedAt(timeline, event.callId), Date.parse(entry.ts))
      return { ...call, ok: event.ok, ...(durationMs !== undefined ? { durationMs } : {}) }
    }
  }
  return undefined
}

function toolStartedAt(timeline: readonly TimelineEntry[], callId: string): number | undefined {
  let startedAt: number | undefined
  for (const entry of timeline) {
    if (!entry.effects.some((effect) => effect.kind === 'call_tool' && effect.callId === callId)) continue
    const parsed = Date.parse(entry.ts)
    if (!Number.isFinite(parsed)) continue
    startedAt = startedAt === undefined ? parsed : Math.min(startedAt, parsed)
  }
  return startedAt
}

function parsedTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function currentTurnStartedAt(timeline: readonly TimelineEntry[]): number | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index]
    if (entry?.event.kind !== 'user_message') continue
    const parsed = Date.parse(entry.ts)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function currentThinkingStartedAt(
  timeline: readonly TimelineEntry[],
  turnStartedAt?: string | null,
): number | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index]
    if (entry?.event.kind === 'user_message') break
    if (entry?.event.kind !== 'tool_result') continue
    const parsed = Date.parse(entry.ts)
    if (Number.isFinite(parsed)) return parsed
  }
  return parsedTimestamp(turnStartedAt) ?? currentTurnStartedAt(timeline)
}

function durationBetween(startedAt: number | undefined, completedAt: number): number | undefined {
  if (startedAt === undefined || !Number.isFinite(completedAt) || completedAt < startedAt) return undefined
  return completedAt - startedAt
}
