import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@agent-kernel/kernel'
import { OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'
import { AgentTelemetryBridge } from './agent-telemetry.js'
import { TurnTimingTracker } from './turn-timing.js'

const config = { systemPrompt: '', tools: [], maxTurns: 10, approvalMode: 'auto' as const }

describe('TurnTimingTracker', () => {
  it('separates queue wait and emits a durable completion summary', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'))
    const tracker = new TurnTimingTracker()
    const prior = createInitialState({ systemPrompt: config.systemPrompt, approvalMode: config.approvalMode })
    const thinking = { ...prior, cursor: 1, status: 'thinking' as const }
    const started = tracker.observe({ sessionId: 's', event: { kind: 'user_message', operationId: 'turn-1', queuedAt: '2026-01-01T00:00:07.000Z', text: 'go' }, prior, next: thinking, effects: [] })
    expect(started).toMatchObject({ turnId: 'turn-1', turnStartedAt: expect.any(String) })
    const done = { ...thinking, cursor: 2, status: 'done' as const }
    const complete = tracker.observe({ sessionId: 's', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, prior: thinking, next: done, effects: [], span: { spanId: 'llm-1', kind: 'llm', component: 'host', startedAt: '2026-01-01T00:00:10.000Z', completedAt: '2026-01-01T00:00:11.000Z', durationMs: 1000, status: 'succeeded', firstTokenMs: 120 } })
    expect(complete?.summary).toMatchObject({ status: 'completed', queueDurationMs: 3000, llm: { requestCount: 1, firstTokenMs: 120 } })
    vi.useRealTimers()
  })

  it('unions overlapping tools and reports aggregate work plus peak concurrency', () => {
    const tracker = new TurnTimingTracker(); const prior = createInitialState({ systemPrompt: config.systemPrompt, approvalMode: config.approvalMode }); const thinking = { ...prior, cursor: 1, status: 'thinking' as const }
    tracker.observe({ sessionId: 's', event: { kind: 'user_message', operationId: 'turn-2', text: 'go' }, prior, next: thinking, effects: [] })
    let state = thinking
    for (const [index, start, end] of [[1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'], [2, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:03.000Z']] as const) {
      const next = { ...state, cursor: state.cursor + 1 }
      tracker.observe({ sessionId: 's', event: { kind: 'tool_result', callId: `c${index}`, ok: true, content: 'ok' }, prior: state, next, effects: [], span: { spanId: `tool-c${index}`, kind: 'tool', component: 'host', startedAt: start, completedAt: end, durationMs: 2000, executorDurationMs: 1500, callId: `c${index}`, status: 'succeeded' } })
      state = next
    }
    const done = { ...state, cursor: state.cursor + 1, status: 'done' as const }
    const complete = tracker.observe({ sessionId: 's', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, prior: state, next: done, effects: [] })
    expect(complete?.summary?.tools).toMatchObject({ wallDurationMs: 3000, aggregateDurationMs: 3000, callCount: 2, peakConcurrency: 2, partial: false })
  })

  it('preserves an indeterminate receipt as unknown through authoritative timing and OTLP without changing the receipt', async () => {
    const tracker = new TurnTimingTracker()
    const prior = createInitialState({ systemPrompt: '', approvalMode: 'auto' })
    const thinking = { ...prior, status: 'thinking' as const }
    tracker.observe({ sessionId: 's', event: { kind: 'user_message', operationId: 'turn-unknown', text: 'fixture' }, prior, next: thinking, effects: [] })
    const event = Object.freeze({ kind: 'tool_result' as const, callId: 'call-unknown', ok: false, content: 'fixture', failure: Object.freeze({ code: 'executor_disconnected', category: 'infrastructure' as const, outcome: 'indeterminate' as const, retryable: false, responsibility: 'system' as const }) })
    const span = Object.freeze({ spanId: 'tool-unknown', kind: 'tool' as const, component: 'host' as const, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000, status: 'failed' as const })
    const metadata = tracker.observe({ sessionId: 's', event, prior: thinking, next: thinking, effects: [], span })
    expect(metadata?.span?.status).toBe('interrupted')
    expect(event.failure.outcome).toBe('indeterminate')
    expect(span.status).toBe('failed')
    const bodies: string[] = []
    const telemetry = new OnlineTelemetry({ serviceName: 'kala-runtime', endpoint: 'http://localhost:4318', authToken: 'o'.repeat(32), flushIntervalMs: 60000, fetch: vi.fn(async (_url, init) => { bodies.push(String(init?.body)); return new Response('', { status: 200 }) }) as typeof fetch })
    new AgentTelemetryBridge(telemetry, 'unit-fixture').observe('s', metadata)
    await telemetry.close()
    const exported = bodies.map((body) => JSON.parse(body)).find((body) => body.resourceSpans).resourceSpans[0].scopeSpans[0].spans[0]
    expect(exported.status.code).toBe(0)
    expect(exported.attributes).toContainEqual({ key: 'execution.state', value: { stringValue: 'unknown' } })
  })

  it('recovers an open Turn from durable events and marks cross-restart wall time estimated', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    const tracker = new TurnTimingTracker()
    tracker.recover('s', [{ kind: 'event', seq: 1, ts: '2026-01-01T00:00:00Z', event: { kind: 'user_message', operationId: 'turn-r', text: 'go' }, effects: [], timing: { turnId: 'turn-r', turnStartedAt: '2026-01-01T00:00:00Z' } }])
    const prior = { ...createInitialState({ systemPrompt: '', approvalMode: 'auto' }), cursor: 1, status: 'thinking' as const }
    const next = { ...prior, cursor: 2, status: 'done' as const }
    const complete = tracker.observe({ sessionId: 's', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, prior, next, effects: [] })
    expect(complete?.summary).toMatchObject({ turnId: 'turn-r', estimated: true, wallDurationMs: 5000 })
    vi.useRealTimers()
  })
})
