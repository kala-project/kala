import { describe, expect, it, vi } from 'vitest'

import { createOnlineTelemetryFromEnv, OnlineTelemetry } from './node-telemetry.js'

const TOKEN = 't'.repeat(32)

describe('OnlineTelemetry', () => {
  it('is explicit opt-in and requires endpoint plus a protected token', () => {
    expect(createOnlineTelemetryFromEnv('kala-test', {})).toBeUndefined()
    expect(() => createOnlineTelemetryFromEnv('kala-test', { KALA_OTEL_ENABLED: '1' })).toThrow(/requires/u)
    expect(() => new OnlineTelemetry({ serviceName: 'kala-test', endpoint: 'http://localhost:4318?untrusted=1', authToken: TOKEN })).toThrow(/without credentials/u)
  })

  it('exports correlated traces, safe logs, and low-cardinality metrics only', async () => {
    const requests: Array<{ url: string; init: RequestInit; body: string }> = []
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init!, body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-test', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000,
    })
    const parent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
    const span = telemetry.startHttpSpan('POST', 'runtime.command', parent)
    expect(span.traceparent).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/u)
    span.end(503)
    telemetry.gauge('kala_runtime_queue_depth', 2, { component: 'runtime' })
    await telemetry.flush()
    await telemetry.close()

    expect(requests.map((request) => request.url).sort()).toEqual([
      'http://localhost:4318/v1/logs', 'http://localhost:4318/v1/metrics', 'http://localhost:4318/v1/traces',
    ])
    for (const request of requests) {
      expect(new Headers(request.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(request.body).not.toMatch(/prompt|query|password|cookie|authorization|raw SQL|\/home\//iu)
    }
    const trace = JSON.parse(requests.find((request) => request.url.endsWith('/traces'))!.body)
    const exported = trace.resourceSpans[0].scopeSpans[0].spans[0]
    expect(exported.parentSpanId).toBe('0123456789abcdef')
    expect(exported.attributes).toEqual(expect.arrayContaining([
      { key: 'http.route', value: { stringValue: 'runtime.command' } },
      { key: 'http.response.status_code', value: { intValue: '503' } },
    ]))
  })

  it('exports explicit timestamped spans and typed histograms with anonymous stable IDs', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-test', serviceVersion: '9c04a7ea', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000,
    })
    const traceId = telemetry.deriveTraceId('agent.turn.trace', ['session-sensitive', 'turn-sensitive'])!
    const parentSpanId = telemetry.deriveSpanId('agent.turn.root', ['session-sensitive', 'turn-sensitive'])!
    const spanId = telemetry.deriveSpanId('agent.turn.child', ['session-sensitive', 'turn-sensitive', 'llm-1'])!
    expect(telemetry.deriveTraceId('agent.turn.trace', ['session-sensitive', 'turn-sensitive'])).toBe(traceId)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/u)
    telemetry.recordSpan({
      traceId, spanId, parentSpanId, name: 'agent.llm',
      startedAtUnixMs: 1_767_225_600_000, completedAtUnixMs: 1_767_225_601_250, status: 'ok',
      attributes: { operation: 'llm', outcome: 'succeeded', provider: 'openai' },
    })
    telemetry.histogram('kala_agent_span_duration_ms', 1250, 'ms', { operation: 'llm' })
    await telemetry.flush()
    await telemetry.close()

    const traces = JSON.parse(requests.find((request) => request.url.endsWith('/traces'))!.body)
    const exported = traces.resourceSpans[0].scopeSpans[0].spans[0]
    expect(exported).toMatchObject({ traceId, spanId, parentSpanId, name: 'agent.llm', status: { code: 1 } })
    expect(exported.startTimeUnixNano).toBe('1767225600000000000')
    expect(traces.resourceSpans[0].resource.attributes).toContainEqual({ key: 'service.version', value: { stringValue: '9c04a7ea' } })
    const metrics = JSON.parse(requests.find((request) => request.url.endsWith('/metrics'))!.body)
    const histogram = metrics.resourceMetrics[0].scopeMetrics[0].metrics[0]
    expect(histogram).toMatchObject({ name: 'kala_agent_span_duration_ms', unit: 'ms' })
    expect(histogram.histogram.dataPoints[0]).toMatchObject({ count: '1', sum: 1250, min: 1250, max: 1250 })
    expect(JSON.stringify(requests)).not.toContain('session-sensitive')
    expect(JSON.stringify(requests)).not.toContain('turn-sensitive')
  })

  it('rejects malformed explicit observations without throwing or enqueueing', async () => {
    const send = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-test', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000,
    })
    expect(() => telemetry.recordSpan({
      traceId: 'raw-session-id', spanId: 'bad', name: 'agent.tool',
      startedAtUnixMs: Number.NaN, completedAtUnixMs: -1, status: 'error',
    })).not.toThrow()
    const base = { traceId: '12'.repeat(16), spanId: '34'.repeat(8), name: 'agent.tool' as const, startedAtUnixMs: 1_767_225_600_000, completedAtUnixMs: 1_767_225_601_000, status: 'error' as const }
    for (const invalid of [{ traceId: '0'.repeat(32) }, { spanId: '0'.repeat(16) }, { parentSpanId: '0'.repeat(16) }, { startedAtUnixMs: Number.NaN }, { completedAtUnixMs: Date.parse('9999-01-01T00:00:00Z') }]) {
      expect(() => telemetry.recordSpan({ ...base, ...invalid })).not.toThrow()
    }
    telemetry.histogram('bad metric name', Number.POSITIVE_INFINITY, 'ms')
    await telemetry.flush()
    await telemetry.close()
    expect(send).not.toHaveBeenCalled()
  })

  it('bounds its queue and never throws when observation delivery fails', async () => {
    const send = vi.fn(async () => { throw new Error('secret backend failure') }) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-test', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, queueCapacity: 16, batchSize: 4, flushIntervalMs: 60_000, timeoutMs: 100,
    })
    for (let index = 0; index < 100; index += 1) telemetry.counter('kala_test_total', 1)
    await expect(telemetry.flush()).resolves.toBeUndefined()
    await expect(telemetry.close()).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(4)
  })
})
