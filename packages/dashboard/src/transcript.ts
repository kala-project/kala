import type { AgentStatus, Message, MessageContent } from '@agent-kernel/kernel'
import type { AgentRuntimeId, QueuedMessagePreview, TurnTimingSummary } from '@agent-kernel/shared'

import type { TimelineEntry } from './session.js'

export type CompactBoundary = {
  kind: 'compact_boundary'
  seq?: number
  attemptId?: string
  trigger: 'manual' | 'auto' | 'preflight' | 'tool_result' | 'unknown'
  replacedCount: number
  /**
   * Tokens before/after the compaction. `null` means the metadata was not
   * available to us (e.g. sessions logged before compaction metadata was
   * plumbed onto the wire, or a runtime that dropped the record). The UI
   * must not fall back to `0` in that case — display "—" instead so we
   * don't imply a nonsense "0 → 0 tokens" result.
   */
  tokensBefore: number | null
  tokensAfter: number | null
  summary: string
}

export type CompactProgress = {
  kind: 'compact_progress'
  attemptId: string
  phase: 'running' | 'error'
  trigger: 'manual' | 'auto' | 'preflight' | 'tool_result'
  tokensBefore: number
  startedAt: string
  error?: string
}

export type TranscriptItem =
  | { kind: 'message'; message: Message; seq?: number; ts?: string; operationId?: string; streaming?: boolean; turnTiming?: import('@agent-kernel/shared').TurnTimingSummary }
  | { kind: 'model_changed'; from?: string; to: string }
  | {
      kind: 'pending_user_message'
      id: string
      text: string
      mode: 'steer' | 'queue'
      status: 'sending' | 'queued'
      content?: readonly MessageContent[]
      shell?: QueuedMessagePreview['shell']
      createdAt: string
    }
  | CompactProgress
  | CompactBoundary

export function transcriptViewStartForItems(start: number, itemCount: number, historyAuthoritative: boolean): number {
  if (!Number.isSafeInteger(start) || start <= 0 || itemCount <= 0) return 0
  // /clear stores an array index. If a later history reset makes the transcript
  // shorter, clamping to the last item would hide every new message until the
  // transcript grows past the old index. Wait for Host history before repairing.
  if (historyAuthoritative && start >= itemCount) return 0
  return Math.min(start, itemCount - 1)
}

export function lastUserTranscriptIndex(items: readonly TranscriptItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === 'pending_user_message' || (item?.kind === 'message' && item.message.role === 'user')) return index
  }
  return 0
}

export type PendingUserTranscriptMessage = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  content?: readonly MessageContent[]
  createdAt: string
  afterSeq?: number
}

const EMPTY_TIMELINE: readonly TimelineEntry[] = []

export type StreamedDraftAnchor = { afterSeq: number; messageCount: number }
export type RetainedStreamedDraft = StreamedDraftAnchor & { text: string }
export type TranscriptStreamOptions = {
  streamingActive?: boolean
  streamingAnchor?: StreamedDraftAnchor | null
  retainedDrafts?: readonly RetainedStreamedDraft[]
}

export function transcriptTimelineForRuntime(
  agentRuntime: AgentRuntimeId,
  timeline: readonly TimelineEntry[],
): readonly TimelineEntry[] {
  return agentRuntime === 'kernel' ? timeline : EMPTY_TIMELINE
}

export function reconcilePendingUserMessages(
  pendingUserMessages: readonly PendingUserTranscriptMessage[],
  timeline: readonly TimelineEntry[],
  queuedMessages: readonly QueuedMessagePreview[],
  status: AgentStatus | undefined,
  streamingText: string,
  authoritativeMessages: readonly Message[] = [],
): readonly PendingUserTranscriptMessage[] {
  if (pendingUserMessages.length === 0) return pendingUserMessages
  const acked = new Map<string, number>()
  for (const entry of timeline) {
    if (entry.event.kind !== 'user_message') continue
    incrementPendingAck(acked, pendingMessageKey(entry.event.text ?? '', 'steer'))
  }
  for (const queued of queuedMessages) {
    incrementPendingAck(acked, pendingMessageKey(queued.text, queued.mode))
  }
  for (const message of authoritativeMessages) {
    if (message.role !== 'user') continue
    const text = message.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
      .join('')
    incrementPendingAck(acked, pendingMessageKey(text, 'steer'))
  }

  const canDropCompleted = isRestingStatus(status) && streamingText.length === 0
  let changed = false
  const next = pendingUserMessages.filter((pending) => {
    const key = pendingMessageKey(pending.text, pending.mode)
    const count = acked.get(key) ?? 0
    if (count > 0) {
      acked.set(key, count - 1)
      changed = true
      return false
    }
    if (canDropCompleted && pending.mode === 'steer' && hasCompletedTurnAfterPending(timeline, pending)) {
      changed = true
      return false
    }
    return true
  })
  return changed ? next : pendingUserMessages
}

function incrementPendingAck(acked: Map<string, number>, key: string): void {
  acked.set(key, (acked.get(key) ?? 0) + 1)
}

function pendingMessageKey(text: string, mode: 'steer' | 'queue'): string {
  return `${mode}\u0000${text}`
}

function isRestingStatus(status: AgentStatus | undefined): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

function hasCompletedTurnAfterPending(timeline: readonly TimelineEntry[], pending: PendingUserTranscriptMessage): boolean {
  const afterSeq = pending.afterSeq
  if (afterSeq !== undefined) {
    return timeline.some((entry) => entry.seq > afterSeq && isTurnCompletionEvent(entry))
  }
  const createdAtMs = Date.parse(pending.createdAt)
  if (!Number.isFinite(createdAtMs)) return false
  return timeline.some((entry) => {
    if (!isTurnCompletionEvent(entry)) return false
    const entryMs = Date.parse(entry.ts)
    return Number.isFinite(entryMs) && entryMs >= createdAtMs
  })
}

function isTurnCompletionEvent(entry: TimelineEntry): boolean {
  return entry.event.kind === 'llm_response' || entry.event.kind === 'llm_error'
}

export function visibleTranscript(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  pendingUserMessages: readonly PendingUserTranscriptMessage[] = [],
  queuedMessages: readonly QueuedMessagePreview[] = [],
  options: { includeStatePrefix?: boolean } & TranscriptStreamOptions = {},
): readonly TranscriptItem[] {
  const base = transcriptBaseItems(stateMessages, timeline, options)
  return appendLiveTranscriptItems(base, stateMessages, timeline, streamingText, pendingUserMessages, queuedMessages, options)
}

/**
 * The stable, timeline-derived portion of the transcript — everything that
 * does *not* change while the agent is streaming a response or while the user
 * has optimistic pending/queued messages in flight. Splitting this out lets
 * callers memoize the expensive full-timeline iteration on stable inputs and
 * only re-run the cheap live-tail append (streaming text, pending) on every
 * ~15fps streaming commit. Rebuilding the whole array each frame was a primary
 * cause of main-thread jank on long sessions (dropped clicks / stuck cursor
 * while the agent runs).
 */
export function transcriptBaseItems(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  options: { includeStatePrefix?: boolean } = {},
): readonly TranscriptItem[] {
  if (timeline.length === 0) return stateTranscriptItems(stateMessages)
  const out: TranscriptItem[] = options.includeStatePrefix
    ? inheritedStatePrefix(stateMessages, timeline).map((message) => ({ kind: 'message' as const, message }))
    : []

  for (const entry of timeline) {
    const event = entry.event
    if (event.kind === 'user_message') {
      out.push({
        kind: 'message',
        seq: entry.seq,
        ts: entry.ts,
        ...(event.operationId ? { operationId: event.operationId } : {}),
        message: {
          role: 'user',
          content: event.content
            ? [...event.content]
            : [{ type: 'text', text: event.text ?? '' }],
        },
      })
    } else if (event.kind === 'llm_response') {
      out.push({ kind: 'message', seq: entry.seq, ts: entry.ts, message: event.message, ...(entry.timing?.summary ? { turnTiming: entry.timing.summary } : {}) })
    } else if (event.kind === 'tool_result') {
      out.push({
        kind: 'message',
        seq: entry.seq,
        ts: entry.ts,
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: event.callId,
              ok: event.ok,
              content: event.content,
            },
          ],
        },
      })
    } else if (event.kind === 'messages_replaced' && event.reason === 'compaction') {
      const meta = entry.compactionMetadata
      const marker = event.replacementMessages.find((message) => message.metadata?.kind === 'context_compaction')
      const markerSummary = marker?.metadata?.kind === 'context_compaction'
        ? marker.metadata.summary
        : undefined
      out.push({
        kind: 'compact_boundary',
        seq: entry.seq,
        ...(meta?.attemptId ? { attemptId: meta.attemptId } : {}),
        trigger: meta?.trigger ?? 'unknown',
        replacedCount: meta?.replacedCount ?? Math.max(0, event.replaceRange.end - event.replaceRange.start),
        tokensBefore: meta?.tokensBefore ?? null,
        tokensAfter: meta?.tokensAfter ?? null,
        summary: markerSummary
          ?? event.replacementMessages.map((message) => message.content.map((content) => content.type === 'text' ? content.text : '').join('')).join('\n'),
      })
    }
  }
  const knownAttempts = new Set(out.flatMap((item) =>
    item.kind === 'compact_boundary' && item.attemptId ? [item.attemptId] : []
  ))
  const durableBoundaries = stateTranscriptItems(stateMessages).filter((item): item is CompactBoundary =>
    item.kind === 'compact_boundary'
      && item.attemptId !== undefined
      && !knownAttempts.has(item.attemptId)
  )
  return durableBoundaries.length > 0 ? [...durableBoundaries, ...out] : out
}

/** Append-only fast path. Returns null when history was replaced or reordered. */
export function appendTranscriptBaseItems(
  previousItems: readonly TranscriptItem[],
  previousTimeline: readonly TimelineEntry[],
  timeline: readonly TimelineEntry[],
): readonly TranscriptItem[] | null {
  if (previousTimeline.length === 0 && previousItems.length > 0 && timeline.length > 0) return null
  if (timeline.length < previousTimeline.length) return null
  for (let index = 0; index < previousTimeline.length; index++) {
    const previous = previousTimeline[index]
    const current = timeline[index]
    if (!previous || !current || previous.seq !== current.seq || previous.event !== current.event) return null
  }
  if (timeline.length === previousTimeline.length) return previousItems
  const tail = transcriptBaseItems([], timeline.slice(previousTimeline.length))
  return tail.length === 0 ? previousItems : [...previousItems, ...tail]
}

/**
 * Append the cheap "live tail" (streaming assistant text + optimistic pending
 * user messages) to a memoized {@link transcriptBaseItems} result. Preserves
 * the historical ordering (streaming before pending) and the empty-timeline
 * fallback to raw state messages.
 */
export function appendLiveTranscriptItems(
  base: readonly TranscriptItem[],
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  pendingUserMessages: readonly PendingUserTranscriptMessage[] = [],
  queuedMessages: readonly QueuedMessagePreview[] = [],
  options: TranscriptStreamOptions = {},
): readonly TranscriptItem[] {
  // Runtime-backed sessions use state messages, not a kernel event timeline.
  // Their authoritative transcript must remain visible even with a live tail.
  const source = timeline.length === 0 && base.length === 0 ? stateTranscriptItems(stateMessages) : base
  const hasLiveTail = streamingText.length > 0 || pendingUserMessages.length > 0 || queuedMessages.length > 0 || (options.retainedDrafts?.length ?? 0) > 0
  const out: TranscriptItem[] = hasLiveTail ? [...source] : (source as TranscriptItem[])

  const appendDraft = (draft: RetainedStreamedDraft, streaming: boolean): void => {
    const following = timeline.length > 0
      ? source.filter((item) => item.kind === 'message' && item.seq !== undefined && item.seq > draft.afterSeq)
      : stateMessages.slice(draft.messageCount).map((message) => ({ kind: 'message' as const, message }))
    // Only the first response at this anchor can replace this draft. A later
    // tool iteration or user turn must not swallow earlier unpersisted prose.
    const response = following.find((item) => item.kind === 'message' && (item.message.role === 'assistant' || item.message.role === 'user'))
    if (response?.kind === 'message' && response.message.role === 'assistant' &&
      response.message.content.some((content) => content.type === 'text' && content.text.length > 0)) return
    const followingMessages = timeline.length === 0 ? new Set(stateMessages.slice(draft.messageCount)) : null
    const next = timeline.length > 0
      ? out.findIndex((item) => item.kind === 'message' && item.seq !== undefined && item.seq > draft.afterSeq)
      : out.findIndex((item) => item.kind === 'message' && followingMessages!.has(item.message))
    out.splice(next < 0 ? out.length : next, 0, {
      kind: 'message', streaming, message: { role: 'assistant', content: [{ type: 'text', text: draft.text }] },
    })
  }
  for (const draft of options.retainedDrafts ?? []) appendDraft(draft, false)
  const baseTail = source.at(-1)
  const authoritativeAssistantAtTail = baseTail?.kind === 'message' && baseTail.message.role === 'assistant'
  const authoritativeAssistantTextAtTail =
    authoritativeAssistantAtTail &&
    baseTail.message.content.some((content) => content.type === 'text' && content.text.length > 0)
  if (streamingText.length > 0 && options.streamingAnchor) {
    appendDraft({ ...options.streamingAnchor, text: streamingText }, options.streamingActive ?? true)
  } else if (streamingText.length > 0 && !authoritativeAssistantTextAtTail) {
    out.push({
      kind: 'message',
      streaming: options.streamingActive ?? true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: streamingText }],
      },
    })
  }

  for (const pending of pendingUserMessages) {
    out.push({
      kind: 'pending_user_message',
      id: pending.id,
      text: pending.text,
      mode: pending.mode,
      status: 'sending',
      ...(pending.content ? { content: pending.content } : {}),
      createdAt: pending.createdAt,
    })
  }

  const showDurableQueuedRows =
    base.length === 0 &&
    timeline.length === 0 &&
    streamingText.length === 0 &&
    pendingUserMessages.length === 0
  queuedMessages.filter((message) => isOptimisticQueuedMessage(message) || showDurableQueuedRows).forEach((queued, index) => {
    out.push({
      kind: 'pending_user_message',
      id: queued.id ?? `queued-${index}`,
      text: queued.text,
      mode: queued.mode,
      status: 'queued',
      ...(queued.content ? { content: queued.content } : {}),
      ...(queued.shell ? { shell: queued.shell } : {}),
      createdAt: queued.createdAt,
    })
  })

  return out
}

function stateTranscriptItems(stateMessages: readonly Message[]): TranscriptItem[] {
  return stateMessages.flatMap((message): TranscriptItem[] => {
    if (message.metadata?.kind === 'model_changed') {
      return [{ kind: 'model_changed', ...(message.metadata.from ? { from: message.metadata.from } : {}), to: message.metadata.to }]
    }
    if (message.metadata?.kind === 'context_compaction') {
      if (message.metadata.phase === 'done') {
        return [{
          kind: 'compact_boundary',
          attemptId: message.metadata.attemptId,
          trigger: message.metadata.trigger,
          replacedCount: message.metadata.replacedCount ?? 0,
          tokensBefore: message.metadata.tokensBefore,
          tokensAfter: message.metadata.tokensAfter ?? null,
          summary: message.metadata.summary ?? '',
        }]
      }
      return [{
        kind: 'compact_progress',
        attemptId: message.metadata.attemptId,
        phase: message.metadata.phase,
        trigger: message.metadata.trigger,
        tokensBefore: message.metadata.tokensBefore,
        startedAt: message.metadata.startedAt,
        ...(message.metadata.error ? { error: message.metadata.error } : {}),
      }]
    }
    if (message.role === 'system') return []
    const temporal = message.metadata?.kind === 'temporal' ? message.metadata : undefined
    return [{
      kind: 'message',
      message,
      ...(temporal ? { ts: temporal.createdAt } : {}),
      ...(temporal?.turnDurationMs !== undefined && temporal.turnStatus
        ? { turnTiming: basicTurnTiming(temporal) }
        : {}),
    }]
  })
}

function basicTurnTiming(
  temporal: Extract<NonNullable<Message['metadata']>, { kind: 'temporal' }>,
): TurnTimingSummary {
  return {
    turnId: temporal.turnId,
    status: temporal.turnStatus ?? 'completed',
    startedAt: temporal.turnStartedAt,
    ...(temporal.turnCompletedAt ? { completedAt: temporal.turnCompletedAt } : {}),
    wallDurationMs: temporal.turnDurationMs ?? 0,
    estimated: true,
    queueDurationMs: 0,
    activeDurationMs: 0,
    approvalWaitMs: 0,
    llm: { wallDurationMs: 0, requestCount: 0 },
    tools: { wallDurationMs: 0, aggregateDurationMs: 0, callCount: 0, peakConcurrency: 0, partial: true },
    compactionDurationMs: 0,
    retryDurationMs: 0,
    recoveryDurationMs: 0,
  }
}

function isOptimisticQueuedMessage(message: QueuedMessagePreview): boolean {
  return message.id.startsWith('optimistic-')
}

export function visibleMessages(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  options: { includeStatePrefix?: boolean } = {},
): readonly Message[] {
  return visibleTranscript(stateMessages, timeline, streamingText, [], [], options)
    .filter((item): item is { kind: 'message'; message: Message } => item.kind === 'message')
    .map((item) => item.message)
}

function inheritedStatePrefix(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
): readonly Message[] {
  const stateVisible = stateMessages.filter((m) => m.role !== 'system')
  if (stateVisible.length === 0 || timeline.length === 0) return stateVisible
  const timelineMessages = timeline.flatMap((entry) => timelineEntryMessages(entry))
  if (timelineMessages.length === 0) return stateVisible
  let stateIndex = stateVisible.length - 1
  let timelineIndex = timelineMessages.length - 1
  while (stateIndex >= 0 && timelineIndex >= 0 && sameMessage(stateVisible[stateIndex]!, timelineMessages[timelineIndex]!)) {
    stateIndex -= 1
    timelineIndex -= 1
  }
  if (timelineIndex >= 0) return []
  return stateVisible.slice(0, stateIndex + 1)
}

function timelineEntryMessages(entry: TimelineEntry): readonly Message[] {
  const event = entry.event
  if (event.kind === 'user_message') {
    return [{
      role: 'user',
      content: event.content
        ? [...event.content]
        : [{ type: 'text', text: event.text ?? '' }],
    }]
  }
  if (event.kind === 'llm_response') return [event.message]
  if (event.kind === 'tool_result') {
    return [{
      role: 'tool',
      content: [{
        type: 'tool_result',
        callId: event.callId,
        ok: event.ok,
        content: event.content,
      }],
    }]
  }
  return []
}

function sameMessage(a: Message, b: Message): boolean {
  return a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content)
}
