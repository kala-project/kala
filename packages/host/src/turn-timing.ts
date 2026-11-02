import { performance } from 'node:perf_hooks'

import type { AgentEvent, AgentState, Effect } from '@agent-kernel/kernel'
import type { CompletedTimingSpan, EventEntry, EventTimingMetadata, TurnTimingStatus, TurnTimingSummary } from '@agent-kernel/shared'
import { nonNegativeDuration } from '@agent-kernel/shared'

export type SpanObservation = Omit<CompletedTimingSpan, 'turnId'>

type ActiveTurn = {
  turnId: string
  startedAt: string
  startedMono: number
  spans: CompletedTimingSpan[]
  queueDurationMs: number
  estimated: boolean
  approval?: { startedAt: string; startedMono: number; callId: string }
}

export class TurnTimingTracker {
  readonly #active = new Map<string, ActiveTurn>()

  has(sessionId: string): boolean { return this.#active.has(sessionId) }
  currentTurnId(sessionId: string): string | undefined { return this.#active.get(sessionId)?.turnId }

  recover(sessionId: string, entries: readonly EventEntry[]): void {
    if (this.#active.has(sessionId)) return
    let terminalIndex = -1
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.timing?.summary !== undefined) { terminalIndex = index; break }
    }
    const tail = entries.slice(terminalIndex + 1)
    const start = tail.find((entry) => entry.event.kind === 'user_message' && entry.timing?.turnStartedAt)
    if (!start?.timing?.turnStartedAt) return
    const spans = tail.flatMap((entry) => entry.timing?.span ? [entry.timing.span] : [])
    this.#active.set(sessionId, {
      turnId: start.timing.turnId, startedAt: start.timing.turnStartedAt, startedMono: performance.now(), spans,
      queueDurationMs: start.event.kind === 'user_message' && start.event.queuedAt ? nonNegativeDuration(Date.parse(start.timing.turnStartedAt) - Date.parse(start.event.queuedAt)) : 0,
      estimated: true,
    })
  }

  observe(input: {
    sessionId: string
    event: AgentEvent
    prior: AgentState
    next: AgentState
    effects: readonly Effect[]
    span?: SpanObservation
  }): EventTimingMetadata | undefined {
    let turn = this.#active.get(input.sessionId)
    if (input.event.kind === 'user_message' && !turn) {
      turn = {
        turnId: input.event.operationId ?? `turn-${input.sessionId}-${input.next.cursor}`,
        startedAt: new Date().toISOString(),
        startedMono: performance.now(),
        spans: [],
        queueDurationMs: input.event.queuedAt ? nonNegativeDuration(Date.now() - Date.parse(input.event.queuedAt)) : 0,
        estimated: false,
      }
      this.#active.set(input.sessionId, turn)
    }
    if (!turn) return undefined

    let span = input.span ? { ...input.span, turnId: turn.turnId } : undefined
    // A structured unknown receipt is not a confirmed tool failure. Keep the
    // business event untouched and preserve uncertainty in its timing projection.
    if (span?.kind === 'tool' && input.event.kind === 'tool_result' && input.event.failure?.outcome === 'indeterminate') {
      span = { ...span, status: 'interrupted' }
    }
    if (span) turn.spans.push(span)
    const approval = input.effects.find((effect) => effect.kind === 'request_approval')
    if (approval && !turn.approval) turn.approval = { startedAt: new Date().toISOString(), startedMono: performance.now(), callId: approval.callId }
    if ((input.event.kind === 'user_approve' || input.event.kind === 'user_reject') && turn.approval?.callId === input.event.callId) {
      const completedAt = new Date().toISOString()
      span = { spanId: `approval-${input.event.callId}`, turnId: turn.turnId, kind: 'approval', component: 'host', startedAt: turn.approval.startedAt, completedAt, durationMs: nonNegativeDuration(performance.now() - turn.approval.startedMono), status: input.event.kind === 'user_approve' ? 'succeeded' : 'cancelled', callId: input.event.callId }
      turn.spans.push(span)
      turn.approval = undefined
    }

    const terminal = terminalStatus(input.event, input.next)
    const metadata: EventTimingMetadata = {
      turnId: turn.turnId,
      ...(input.event.kind === 'user_message' ? { turnStartedAt: turn.startedAt } : {}),
      ...(span ? { span } : {}),
    }
    if (terminal) {
      if (turn.approval) {
        const completedAt = new Date().toISOString()
        turn.spans.push({ spanId: `approval-${turn.approval.callId}`, turnId: turn.turnId, kind: 'approval', component: 'host', startedAt: turn.approval.startedAt, completedAt, durationMs: nonNegativeDuration(performance.now() - turn.approval.startedMono), status: 'interrupted', callId: turn.approval.callId })
      }
      metadata.summary = summarizeTurn(turn, terminal)
      this.#active.delete(input.sessionId)
    }
    return metadata
  }
}

export function timedSpan(kind: CompletedTimingSpan['kind'], spanId: string, startedAt: string, startedMono: number, status: CompletedTimingSpan['status'], details: Partial<Pick<CompletedTimingSpan, 'callId' | 'executorDurationMs' | 'firstTokenMs'>> = {}): SpanObservation {
  return { spanId, kind, component: 'host', startedAt, completedAt: new Date().toISOString(), durationMs: nonNegativeDuration(performance.now() - startedMono), status, ...details }
}

function terminalStatus(event: AgentEvent, next: AgentState): TurnTimingStatus | undefined {
  if (event.kind === 'cancel') return 'cancelled'
  if (event.kind === 'llm_error' || next.status === 'error') return 'failed'
  if (event.kind === 'llm_response' && next.status === 'done') {
    const text = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    return /\[(?:interrupted|cancelled)\]/iu.test(text) ? 'interrupted' : 'completed'
  }
  return undefined
}

function summarizeTurn(turn: ActiveTurn, status: TurnTimingStatus): TurnTimingSummary {
  const completedAt = new Date().toISOString()
  const llm = turn.spans.filter((span) => span.kind === 'llm')
  const tools = turn.spans.filter((span) => span.kind === 'tool')
  const approval = turn.spans.filter((span) => span.kind === 'approval')
  const active = turn.spans.filter((span) => span.kind !== 'approval')
  return {
    turnId: turn.turnId, status, startedAt: turn.startedAt, completedAt,
    wallDurationMs: turn.estimated ? nonNegativeDuration(Date.parse(completedAt) - Date.parse(turn.startedAt)) : nonNegativeDuration(performance.now() - turn.startedMono), estimated: turn.estimated,
    queueDurationMs: turn.queueDurationMs, activeDurationMs: intervalUnion(active), approvalWaitMs: intervalUnion(approval),
    llm: { wallDurationMs: intervalUnion(llm), requestCount: llm.length, ...(llm.map((span) => span.firstTokenMs).filter((value): value is number => value !== undefined).at(0) !== undefined ? { firstTokenMs: llm.map((span) => span.firstTokenMs).find((value): value is number => value !== undefined) } : {}) },
    tools: { wallDurationMs: intervalUnion(tools), aggregateDurationMs: tools.reduce((sum, span) => sum + (span.executorDurationMs ?? span.durationMs), 0), callCount: tools.length, peakConcurrency: peakConcurrency(tools), partial: tools.some((span) => span.executorDurationMs === undefined) },
    compactionDurationMs: sumKind(turn.spans, 'compaction'), retryDurationMs: sumKind(turn.spans, 'retry'), recoveryDurationMs: sumKind(turn.spans, 'recovery'),
  }
}

function intervalUnion(spans: readonly CompletedTimingSpan[]): number {
  const intervals = spans.map((span) => [Date.parse(span.startedAt), Date.parse(span.completedAt)] as const).filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start).sort((a, b) => a[0] - b[0])
  let total = 0, start = -1, end = -1
  for (const [nextStart, nextEnd] of intervals) {
    if (nextStart > end) { if (end >= start) total += end - start; start = nextStart; end = nextEnd } else end = Math.max(end, nextEnd)
  }
  return nonNegativeDuration(total + (end >= start ? end - start : 0))
}
function peakConcurrency(spans: readonly CompletedTimingSpan[]): number {
  const points = spans.flatMap((span) => [[Date.parse(span.startedAt), 1] as const, [Date.parse(span.completedAt), -1] as const]).filter(([time]) => Number.isFinite(time)).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let current = 0, peak = 0
  for (const [, delta] of points) { current += delta; peak = Math.max(peak, current) }
  return peak
}
function sumKind(spans: readonly CompletedTimingSpan[], kind: CompletedTimingSpan['kind']): number { return spans.filter((span) => span.kind === kind).reduce((sum, span) => sum + span.durationMs, 0) }
