import type { CompletedTimingSpan, EventTimingMetadata, TurnTimingSummary } from '@agent-kernel/shared'
import type { OnlineTelemetry, SafeTelemetryAttributes } from '@agent-kernel/shared/node-telemetry'

import type { AgentRuntimeTurnObservation } from './agent-runtime/types.js'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u
const SPAN_KINDS = new Set(['llm', 'tool', 'approval', 'compaction', 'retry', 'recovery'])
const SPAN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const COMPONENTS = new Set(['host', 'executor'])
const PROVIDERS = new Set(['anthropic', 'openai', 'unknown'])

type KnownProvider = 'anthropic' | 'openai' | 'unknown'
type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted'
type SpanStatus = CompletedTimingSpan['status']

/**
 * Stateless bridge from durable Turn timing observations to the bounded OTLP
 * client. It never reads Session content and duplicate observations deliberately
 * produce the same trace/span IDs. Ingest-token rotation changes that namespace.
 */
export class AgentTelemetryBridge {
  constructor(private readonly telemetry: OnlineTelemetry, private readonly unitId = 'local') {}

  observeCopilotTurn(sessionId: string, observation: AgentRuntimeTurnObservation): void {
    if (!validId(this.unitId) || !validId(sessionId) || !validId(observation.turnId)) return
    const startedAtUnixMs = parseTimestamp(observation.startedAt)
    if (startedAtUnixMs === undefined) return
    const traceId = this.telemetry.deriveTraceId('agent.turn.trace', [this.unitId, sessionId, observation.turnId])
    const spanId = this.telemetry.deriveSpanId('agent.turn.root', [this.unitId, sessionId, observation.turnId])
    if (!traceId || !spanId) return
    const attributes: Partial<SafeTelemetryAttributes> = {
      component: 'host', operation: 'turn', provider: 'github_copilot',
      'agent.runtime': 'copilot', 'measurement.source': 'server_observed', outcome: observation.status,
    }
    if (observation.status === 'running') {
      this.telemetry.log('info', 'Agent turn started', attributes, traceId, spanId)
      return
    }
    const completedAtUnixMs = parseTimestamp(observation.completedAt)
    if (completedAtUnixMs === undefined || completedAtUnixMs < startedAtUnixMs) return
    const durationMs = completedAtUnixMs - startedAtUnixMs
    this.telemetry.recordSpan({
      traceId, spanId, name: 'agent.turn', startedAtUnixMs, completedAtUnixMs,
      status: otlpStatus(observation.status), attributes,
    })
    this.telemetry.counter('kala_agent_turns_total', 1, attributes)
    this.telemetry.histogram('kala_agent_turn_duration_ms', durationMs, 'ms', attributes)
    this.telemetry.log(observation.status === 'failed' ? 'error' : 'info',
      observation.status === 'failed' ? 'Agent turn failed'
        : observation.status === 'cancelled' ? 'Agent turn cancelled' : 'Agent turn completed',
      { ...attributes, 'duration.ms': durationMs }, traceId, spanId)
  }

  observe(sessionId: string, metadata: EventTimingMetadata | unknown, provider?: string): void {
    try {
      if (!validId(this.unitId) || !validId(sessionId) || !isRecord(metadata) || !validId(metadata.turnId)) return
      const turnId = metadata.turnId
      const traceId = this.telemetry.deriveTraceId('agent.turn.trace', [this.unitId, sessionId, turnId])
      const rootSpanId = this.telemetry.deriveSpanId('agent.turn.root', [this.unitId, sessionId, turnId])
      if (!traceId || !rootSpanId) return

      if (isCompletedSpan(metadata.span, turnId)) {
        this.exportCompletedSpan(sessionId, turnId, traceId, rootSpanId, metadata.span, safeProvider(provider))
      }
      if (isTerminalSummary(metadata.summary, turnId)) {
        this.exportTurnSummary(traceId, rootSpanId, metadata.summary)
      }
    } catch {
      // Observability must never alter event broadcast or durable receipt paths.
    }
  }

  private exportCompletedSpan(
    sessionId: string,
    turnId: string,
    traceId: string,
    rootSpanId: string,
    span: CompletedTimingSpan,
    provider: KnownProvider,
  ): void {
    const spanId = this.telemetry.deriveSpanId('agent.turn.child', [this.unitId, sessionId, turnId, span.spanId])
    const startedAtUnixMs = parseTimestamp(span.startedAt)
    const completedAtUnixMs = parseTimestamp(span.completedAt)
    if (!spanId || startedAtUnixMs === undefined || completedAtUnixMs === undefined || completedAtUnixMs < startedAtUnixMs) return

    const attributes: Partial<SafeTelemetryAttributes> = {
      component: span.component,
      operation: span.kind,
      outcome: span.status,
      'execution.state': executionState(span.status),
      'measurement.source': 'server_observed',
      ...(span.kind === 'llm' ? { provider } : {}),
    }
    this.telemetry.recordSpan({
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: `agent.${span.kind}`,
      startedAtUnixMs,
      completedAtUnixMs,
      status: otlpStatus(span.status),
      attributes,
    })
    this.telemetry.counter('kala_agent_spans_total', 1, attributes)
    this.telemetry.histogram('kala_agent_span_duration_ms', span.durationMs, 'ms', attributes)
    if (span.kind === 'llm' && span.firstTokenMs !== undefined) {
      this.telemetry.histogram('kala_agent_llm_first_token_ms', span.firstTokenMs, 'ms', { provider, outcome: span.status })
    }
    if (span.kind === 'tool' && span.executorDurationMs !== undefined) {
      this.telemetry.histogram('kala_agent_tool_executor_duration_ms', span.executorDurationMs, 'ms', {
        component: 'executor', outcome: span.status, 'measurement.source': 'executor_reported',
      })
    }
  }

  private exportTurnSummary(traceId: string, rootSpanId: string, summary: TurnTimingSummary & { status: TerminalStatus }): void {
    const startedAtUnixMs = parseTimestamp(summary.startedAt)
    const completedAtUnixMs = parseTimestamp(summary.completedAt)
    if (startedAtUnixMs === undefined || completedAtUnixMs === undefined || completedAtUnixMs < startedAtUnixMs) return
    const attributes: Partial<SafeTelemetryAttributes> = {
      component: 'host',
      operation: 'turn',
      outcome: summary.status,
      'execution.state': executionState(summary.status),
      'measurement.source': 'server_observed',
      'timing.estimated': summary.estimated ? 'true' : 'false',
    }
    this.telemetry.recordSpan({
      traceId,
      spanId: rootSpanId,
      name: 'agent.turn',
      startedAtUnixMs,
      completedAtUnixMs,
      status: otlpStatus(summary.status),
      attributes,
    })
    this.telemetry.counter('kala_agent_turns_total', 1, attributes)
    this.telemetry.histogram('kala_agent_turn_duration_ms', summary.wallDurationMs, 'ms', attributes)
    this.telemetry.log(summary.status === 'failed' ? 'error' : 'info',
      summary.status === 'failed' ? 'Agent turn failed'
        : summary.status === 'cancelled' ? 'Agent turn cancelled'
          : summary.status === 'interrupted' ? 'Agent turn interrupted' : 'Agent turn completed',
      { ...attributes, 'agent.runtime': 'kernel', 'duration.ms': summary.wallDurationMs }, traceId, rootSpanId)

    const phases: ReadonlyArray<readonly [string, number]> = [
      ['queue', summary.queueDurationMs],
      ['active', summary.activeDurationMs],
      ['approval', summary.approvalWaitMs],
      ['llm', summary.llm.wallDurationMs],
      ['tools_wall', summary.tools.wallDurationMs],
      ['tools_aggregate', summary.tools.aggregateDurationMs],
      ['compaction', summary.compactionDurationMs],
      ['retry', summary.retryDurationMs],
      ['recovery', summary.recoveryDurationMs],
    ]
    for (const [operation, duration] of phases) {
      this.telemetry.histogram('kala_agent_turn_phase_duration_ms', duration, 'ms', { operation, outcome: summary.status })
    }
    this.telemetry.histogram('kala_agent_turn_llm_requests', summary.llm.requestCount, '{call}', { outcome: summary.status })
    // Timing completeness is not evidence that external effects are settled.
    this.telemetry.histogram('kala_agent_turn_tool_calls', summary.tools.callCount, '{call}', { outcome: summary.status })
    this.telemetry.histogram('kala_agent_turn_tool_peak_concurrency', summary.tools.peakConcurrency, '{call}', { outcome: summary.status })
    if (summary.llm.firstTokenMs !== undefined) {
      this.telemetry.histogram('kala_agent_turn_llm_first_token_ms', summary.llm.firstTokenMs, 'ms', { outcome: summary.status })
    }
  }
}

function isCompletedSpan(value: unknown, turnId: string): value is CompletedTimingSpan {
  if (!isRecord(value) || value.turnId !== turnId || !validId(value.spanId) || !SPAN_KINDS.has(String(value.kind))) return false
  if (!COMPONENTS.has(String(value.component)) || !SPAN_STATUSES.has(String(value.status))) return false
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.completedAt) || !nonNegative(value.durationMs)) return false
  if (value.callId !== undefined && !validId(value.callId)) return false
  if (value.executorDurationMs !== undefined && !nonNegative(value.executorDurationMs)) return false
  if (value.firstTokenMs !== undefined && !nonNegative(value.firstTokenMs)) return false
  return true
}

function isTerminalSummary(value: unknown, turnId: string): value is TurnTimingSummary & { status: TerminalStatus } {
  if (!isRecord(value) || value.turnId !== turnId || !TERMINAL_STATUSES.has(String(value.status))) return false
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.completedAt) || typeof value.estimated !== 'boolean') return false
  for (const key of ['wallDurationMs', 'queueDurationMs', 'activeDurationMs', 'approvalWaitMs', 'compactionDurationMs', 'retryDurationMs', 'recoveryDurationMs'] as const) {
    if (!nonNegative(value[key])) return false
  }
  if (!isRecord(value.llm) || !nonNegative(value.llm.wallDurationMs) || !nonNegativeInteger(value.llm.requestCount)) return false
  if (value.llm.firstTokenMs !== undefined && !nonNegative(value.llm.firstTokenMs)) return false
  if (!isRecord(value.tools)) return false
  if (!nonNegative(value.tools.wallDurationMs) || !nonNegative(value.tools.aggregateDurationMs)) return false
  if (!nonNegativeInteger(value.tools.callCount) || !nonNegativeInteger(value.tools.peakConcurrency) || typeof value.tools.partial !== 'boolean') return false
  return true
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}
function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function nonNegativeInteger(value: unknown): value is number {
  return nonNegative(value) && Number.isSafeInteger(value)
}
function validTimestamp(value: unknown): value is string {
  return parseTimestamp(value) !== undefined
}
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function safeProvider(value: string | undefined): KnownProvider {
  return value && PROVIDERS.has(value) ? value as KnownProvider : 'unknown'
}
function executionState(status: SpanStatus | TerminalStatus): string {
  return status === 'interrupted' ? 'unknown' : status === 'cancelled' ? 'cancelled' : 'complete'
}
function otlpStatus(status: SpanStatus | TerminalStatus): 'ok' | 'error' | 'unset' {
  return status === 'succeeded' || status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'unset'
}
