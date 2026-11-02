import { describe, expect, it, vi } from 'vitest'
import type { CompletedTimingSpan, EventTimingMetadata, TurnTimingSummary } from '@agent-kernel/shared'
import { OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'

import { AgentTelemetryBridge } from './agent-telemetry.js'

const TOKEN = 'o'.repeat(32)
const SESSION_ID = 'session-01'
const TURN_ID = 'turn-01'

function summary(status: TurnTimingSummary['status'] = 'cancelled'): TurnTimingSummary {
  return {
    turnId: TURN_ID,
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:10.000Z',
    wallDurationMs: 10_000,
    estimated: false,
    queueDurationMs: 500,
    activeDurationMs: 9_500,
    approvalWaitMs: 1_000,
    llm: { wallDurationMs: 3_000, requestCount: 1, firstTokenMs: 120 },
    tools: { wallDurationMs: 3_000, aggregateDurationMs: 4_000, callCount: 2, peakConcurrency: 2, partial: true },
    compactionDurationMs: 600,
    retryDurationMs: 200,
    recoveryDurationMs: 300,
  }
}

function completedSpan(kind: CompletedTimingSpan['kind'], overrides: Partial<CompletedTimingSpan> = {}): CompletedTimingSpan {
  return {
    spanId: `${kind}-01`,
    turnId: TURN_ID,
    kind,
    component: kind === 'tool' ? 'executor' : 'host',
    startedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 1_000,
    status: 'succeeded',
    ...overrides,
  }
}

function attributes(span: { attributes: Array<{ key: string; value: { stringValue?: string } }> }): Record<string, string | undefined> {
  return Object.fromEntries(span.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))
}

describe('AgentTelemetryBridge', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)('exports actual Copilot turn time and correlated safe logs for %s turns without inventing internal phases', async (status) => {
    const requests: Array<{ url: string; body: string }> = []
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-runtime', endpoint: 'http://localhost:4318', authToken: TOKEN, flushIntervalMs: 60_000,
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) })
        return new Response('', { status: 200 })
      },
    })
    const bridge = new AgentTelemetryBridge(telemetry, 'private-unit')
    const startedAt = '2026-01-01T00:00:00.000Z'
    bridge.observeCopilotTurn(SESSION_ID, { turnId: TURN_ID, startedAt, status: 'running' })
    bridge.observeCopilotTurn(SESSION_ID, { turnId: TURN_ID, startedAt, completedAt: '2026-01-01T00:00:02.500Z', status })
    await telemetry.close()
    const spans = JSON.parse(requests.find(request => request.url.endsWith('/traces'))!.body).resourceSpans[0].scopeSpans[0].spans
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      name: `Assistant turn - ${status}`,
      startTimeUnixNano: '1767225600000000000', endTimeUnixNano: '1767225602500000000',
      status: { code: status === 'failed' ? 2 : status === 'cancelled' ? 0 : 1 },
    })
    expect(attributes(spans[0])).toMatchObject({ 'agent.runtime': 'copilot', provider: 'github_copilot', outcome: status })
    expect(spans[0].attributes).toContainEqual({ key: 'duration.ms', value: { intValue: '2500' } })
    const logs = JSON.parse(requests.find(request => request.url.endsWith('/logs'))!.body).resourceLogs[0].scopeLogs[0].logRecords
    expect(logs).toHaveLength(2)
    expect(logs.every((log: { traceId: string; spanId: string }) => log.traceId === spans[0].traceId && log.spanId === spans[0].spanId)).toBe(true)
    expect(logs[1].attributes).toContainEqual({ key: 'duration.ms', value: { intValue: '2500' } })
    expect(logs[1].body.stringValue).toBe(`Agent turn ${status} · 2.5 s`)
    const metrics = JSON.parse(requests.find(request => request.url.endsWith('/metrics'))!.body).resourceMetrics[0].scopeMetrics[0].metrics
    expect(metrics.map((metric: { name: string }) => metric.name)).toEqual(['kala_agent_turns_total', 'kala_agent_turn_duration_ms'])
    expect(JSON.stringify(requests)).not.toMatch(/private-unit|session-01|turn-01|agent\.llm|agent\.tool/u)
  })

  it('exports one anonymous turn trace with real child timings, metrics, and stable IDs across duplicate/out-of-order observations', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-runtime', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000,
    })
    const bridge = new AgentTelemetryBridge(telemetry)

    // The terminal root can be observed before children without mutable correlation state.
    bridge.observe(SESSION_ID, { turnId: TURN_ID, summary: summary() })
    const llm = completedSpan('llm', { firstTokenMs: 120 })
    bridge.observe(SESSION_ID, { turnId: TURN_ID, span: llm, prompt: 'sensitive prompt' } as EventTimingMetadata, 'openai')
    bridge.observe(SESSION_ID, { turnId: TURN_ID, span: llm }, 'openai')
    bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan('tool', {
      spanId: 'tool-01', callId: 'call-01', executorDurationMs: 800,
      startedAt: '2026-01-01T00:00:03.000Z', completedAt: '2026-01-01T00:00:05.000Z', durationMs: 2_000,
    }) })
    bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan('tool', {
      spanId: 'tool-02', callId: 'call-02', executorDurationMs: 700, status: 'interrupted',
      startedAt: '2026-01-01T00:00:04.000Z', completedAt: '2026-01-01T00:00:06.000Z', durationMs: 2_000,
    }) })
    bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan('approval') })
    for (const kind of ['compaction', 'retry', 'recovery'] as const) {
      bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan(kind) })
    }
    await telemetry.flush()
    await telemetry.close()

    const traceRequest = requests.find((request) => request.url.endsWith('/traces'))!
    const payload = JSON.parse(traceRequest.body)
    const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{
      traceId: string; spanId: string; parentSpanId?: string; name: string; status: { code: number }
      startTimeUnixNano: string; endTimeUnixNano: string
      attributes: Array<{ key: string; value: { stringValue?: string } }>
    }>
    const root = spans.find((span) => span.name.startsWith('Assistant turn'))!
    const children = spans.filter((span) => !span.name.startsWith('Assistant turn'))
    expect(spans.every((span) => /^[\x20-\x7e]+$/u.test(span.name))).toBe(true)
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([root.traceId]))
    expect(children.every((span) => span.parentSpanId === root.spanId)).toBe(true)
    expect(new Set(children.map((span) => span.name))).toEqual(new Set([
      'Model request - completed',
      'Tool execution - completed',
      'Tool execution - interrupted',
      'Waiting for approval - completed',
      'Context compaction - completed',
      'Retry - completed',
      'Recovery - completed',
    ]))
    const duplicatedLlm = children.filter((span) => span.name.startsWith('Model request'))
    expect(duplicatedLlm).toHaveLength(2)
    expect(duplicatedLlm[0]!.spanId).toBe(duplicatedLlm[1]!.spanId)
    expect(duplicatedLlm[0]).toMatchObject({
      startTimeUnixNano: '1767225601000000000', endTimeUnixNano: '1767225602000000000', status: { code: 1 },
    })
    const interruptedTool = children.find((span) => span.name.startsWith('Tool execution') && attributes(span).outcome === 'interrupted')!
    expect(interruptedTool.status.code).toBe(0)
    expect(attributes(interruptedTool)).toMatchObject({ outcome: 'interrupted', 'execution.state': 'unknown', 'measurement.source': 'server_observed' })
    expect(root.status.code).toBe(0)
    expect(attributes(root)).toMatchObject({ outcome: 'cancelled', 'execution.state': 'cancelled' })
    expect(root.attributes).toContainEqual({ key: 'duration.ms', value: { intValue: '10000' } })

    const metricRequest = requests.find((request) => request.url.endsWith('/metrics'))!
    const metrics = JSON.parse(metricRequest.body).resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string; unit: string }>
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'kala_agent_llm_first_token_ms', unit: 'ms' }),
      expect.objectContaining({ name: 'kala_agent_turn_phase_duration_ms', unit: 'ms' }),
      expect.objectContaining({ name: 'kala_agent_turn_tool_peak_concurrency', unit: '{call}' }),
      expect.objectContaining({ name: 'kala_agent_tool_executor_duration_ms', unit: 'ms' }),
    ]))
    const exported = JSON.stringify(requests)
    expect(exported).not.toMatch(/session-01|turn-01|call-01|sensitive prompt|\/home\/|custom-model/iu)
  })

  it('does not merge identical Session and turn IDs across authoritative Units', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const telemetry = new OnlineTelemetry({ serviceName: 'kala-runtime', endpoint: 'http://localhost:4318', authToken: TOKEN, fetch: send, flushIntervalMs: 60_000 })
    for (const unitId of ['unit-alpha', 'unit-beta']) {
      const bridge = new AgentTelemetryBridge(telemetry, unitId)
      bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan('llm') })
      bridge.observe(SESSION_ID, { turnId: TURN_ID, summary: summary() })
    }
    await telemetry.close()
    const spans = JSON.parse(requests.find((request) => request.url.endsWith('/traces'))!.body).resourceSpans[0].scopeSpans[0].spans as Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string }>
    const roots = spans.filter((span) => span.name.startsWith('Assistant turn'))
    expect(new Set(roots.map((root) => root.traceId)).size).toBe(2)
    expect(new Set(roots.map((root) => root.spanId)).size).toBe(2)
    for (const root of roots) {
      expect(spans.filter((span) => span.parentSpanId === root.spanId)).toHaveLength(1)
      expect(spans.find((span) => span.parentSpanId === root.spanId)!.traceId).toBe(root.traceId)
    }
    expect(JSON.stringify(requests)).not.toContain('unit-alpha')
    expect(JSON.stringify(requests)).not.toContain('unit-beta')
  })

  it('silently rejects malformed and sensitive metadata without enqueueing', async () => {
    const send = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-runtime', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000,
    })
    const bridge = new AgentTelemetryBridge(telemetry)
    expect(() => bridge.observe('../raw/session', {
      turnId: 'turn bad',
      span: { ...completedSpan('tool'), durationMs: Number.NaN, callId: '/tmp/kala-telemetry-fixture/invalid-call' },
    })).not.toThrow()
    for (const invalid of [{ durationMs: Number.NaN }, { callId: '/tmp/kala-telemetry-fixture/invalid-call' }, { startedAt: 'invalid' }, { firstTokenMs: Number.POSITIVE_INFINITY }]) {
      expect(() => bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan('tool', invalid) })).not.toThrow()
    }
    const hostile = Object.defineProperty({}, 'turnId', { get() { throw new Error('malformed getter') } })
    expect(() => bridge.observe(SESSION_ID, hostile)).not.toThrow()
    await telemetry.flush()
    await telemetry.close()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps valid observations best-effort when the collector is offline', async () => {
    const send = vi.fn(async () => { throw new Error('collector offline') }) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-runtime', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000, timeoutMs: 100,
    })
    const bridge = new AgentTelemetryBridge(telemetry)
    expect(() => bridge.observe(SESSION_ID, { turnId: TURN_ID, span: completedSpan('recovery') })).not.toThrow()
    await expect(telemetry.flush()).resolves.toBeUndefined()
    await expect(telemetry.close()).resolves.toBeUndefined()
  })
})
