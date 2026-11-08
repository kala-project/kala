import type { AgentState } from '@agent-kernel/kernel'
import type { CompactStatusEvent, RuntimeCompactionPolicy } from '@agent-kernel/shared'
import type { CompactStatus } from '../features/chat/InlineStatusRow.js'
import type { TranscriptItem } from '../transcript.js'

/**
 * Pure helpers for reasoning about context compaction events/state. Extracted
 * from app.tsx so they can be unit-tested independently of the App component.
 */

/** Whether the session has any non-system message that could be compacted. */
export function hasCompactableContent(state: AgentState | null): boolean {
  return state?.messages.some((m, index) => !(index === 0 && m.role === 'system')) ?? false
}

/** Copilot's persisted marker replaces the transient row only for the same attempt. */
export function compactFeedbackStatus(
  status: CompactStatus,
  runtime: string,
  remote: CompactStatusEvent | null,
  items: readonly TranscriptItem[],
): CompactStatus {
  if (runtime !== 'copilot' || !remote || (status.kind !== 'running' && status.kind !== 'error')) return status
  const phase = status.kind === 'running' ? 'running' : 'error'
  return items.some((item) => item.kind === 'compact_progress'
    && item.attemptId === remote.attemptId && item.phase === phase)
    ? { kind: 'idle' }
    : status
}

export function shouldShowQueuedAutoCompact(
  policy: RuntimeCompactionPolicy,
  shouldCompact: boolean,
  resting: boolean,
): boolean {
  return policy.automatic.enabled
    && policy.automatic.mode === 'safe_boundary'
    && shouldCompact
    && resting
}

/** A projection event kind that terminates a compaction attempt. */
export function isCompactTerminalEvent(kind: string): boolean {
  return kind === 'messages_replaced'
}

/** Whether a terminal event represents a successful compaction. */
export function isCompactionSuccess(event: { kind: string; reason?: string }): boolean {
  return event.kind === 'messages_replaced' && event.reason === 'compaction'
}

/** A user-facing message for a failed compaction event. */
export function compactFailureMessage(event: { kind: string; reason?: string }): string {
  if (event.reason) return compactReasonMessage(event.reason)
  return 'Compaction failed.'
}

/** A user-facing explanation for a compaction failure reason code. */
export function compactReasonMessage(reason: string): string {
  switch (reason) {
    case 'summary_schema_invalid':
      return 'Compaction summary was missing required sections.'
    case 'summary_too_short':
      return 'Compaction summary was too short to be useful.'
    case 'summary_conversational':
      return 'Compaction summary looked conversational instead of structured.'
    case 'post_compaction_still_over_budget':
      return 'Compaction did not reduce context enough.'
    case 'circuit_breaker_open':
      return 'Auto compaction is paused after repeated failures.'
    case 'session_busy':
      return 'Compaction skipped while the session is busy.'
    case 'empty':
      return 'Nothing to compact yet.'
    default:
      return reason.replace(/_/g, ' ')
  }
}
