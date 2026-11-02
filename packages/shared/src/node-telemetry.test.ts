import { describe, expect, it, vi } from 'vitest'

import { createOnlineTelemetryFromEnv, OnlineTelemetry, tracePostgresQuery } from './node-telemetry.js'

const TOKEN = 't'.repeat(32)

describe('OnlineTelemetry', () => {
  it('is explicit opt-in and requires endpoint plus a protected token', () => {
    expect(createOnlineTelemetryFromEnv('kala-test', {})).toBeUndefined()
    const original = Promise.resolve({ rows: [] })
    expect(tracePostgresQuery(undefined, () => original)).toBe(original)
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

  it('records real client calls with success, error, parent isolation, and no sensitive fields', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-test', endpoint: 'http://localhost:4318', authToken: TOKEN,
      fetch: send, flushIntervalMs: 60_000,
    })
    const request = telemetry.startHttpSpan('POST', 'runtime.command')
    request.activate()
    const queryResult = { rows: [{ ok: true }] }
    await expect(telemetry.traceClientCall({ provider: 'postgresql', operation: 'query' }, async () => {
      // These values represent data used by the real client call, not telemetry attributes.
      void 'SELECT secret FROM private_table WHERE password=$1'
      void 'postgres://user:credential@db.example.invalid/private'
      return queryResult
    })).resolves.toBe(queryResult)
    const clientError = new Error('raw S3 failure for bucket-sensitive/key-sensitive')
    await expect(telemetry.traceClientCall({ provider: 's3', operation: 'put' }, async () => {
      throw clientError
    })).rejects.toBe(clientError)
    request.end(200)
    await telemetry.flush()
    await telemetry.close()

    const body = requests.find((entry) => entry.url.endsWith('/traces'))!.body
    const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans
    const pg = spans.find((span: { name: string }) => span.name === 'postgresql.query')
    const s3 = spans.find((span: { name: string }) => span.name === 's3.put')
    const requestSpan = spans.find((span: { name: string }) => span.name === 'http runtime.command')
    expect(pg).toMatchObject({ traceId: requestSpan.traceId, parentSpanId: requestSpan.spanId, kind: 3, status: { code: 1 } })
    expect(s3).toMatchObject({ kind: 3, status: { code: 2 } })
    expect(s3.parentSpanId).toBe(requestSpan.spanId)
    expect(s3.traceId).toBe(requestSpan.traceId)
    expect(s3.attributes).toEqual(expect.arrayContaining([
      { key: 'provider', value: { stringValue: 's3' } },
      { key: 'operation', value: { stringValue: 'put' } },
      { key: 'error.type', value: { stringValue: 'client_error' } },
    ]))
    expect(body).not.toMatch(/SELECT secret|private_table|password|credential|db\.internal|bucket-sensitive|key-sensitive|raw S3 failure/u)
  })

  it('aggregates idle calls and failures without creating root traces or per-call metric signals', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const telemetry = new OnlineTelemetry({ serviceName: 'kala-test', endpoint: 'http://localhost:4318',
      authToken: TOKEN, fetch: send, flushIntervalMs: 60_000, queueCapacity: 16, batchSize: 16 })
    const ended = telemetry.startHttpSpan('GET', 'ended.request')
    ended.activate()
    ended.end(200)
    await telemetry.flush()
    requests.length = 0
    vi.mocked(send).mockClear()
    for (let i = 0; i < 2_000; i += 1) await tracePostgresQuery(telemetry, async () => i)
    const failure = new Error('private SQL and credentials must not escape')
    await expect(tracePostgresQuery(telemetry, async () => { throw failure })).rejects.toBe(failure)
    await telemetry.flush(false)
    expect(send).not.toHaveBeenCalled()
    await telemetry.close()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toMatch(/\/metrics$/u)
    const metrics = JSON.parse(requests[0]!.body).resourceMetrics[0].scopeMetrics[0].metrics
    expect(metrics).toHaveLength(2)
    const counts = metrics.find((m: { name: string }) => m.name === 'kala_client_calls_total').sum.dataPoints
    expect(counts.map((p: { asDouble: number }) => p.asDouble).sort((a: number, b: number) => a - b)).toEqual([1, 2000])
    expect(JSON.stringify(metrics)).toContain('background')
    expect(JSON.stringify(metrics)).toContain('error')
    expect(requests[0]!.body).not.toContain(failure.message)
    expect(metrics[1].histogram.dataPoints.reduce((n: number, p: { count: string }) => n + Number(p.count), 0)).toBe(2001)
  })

  it('keeps readiness health metrics and failures without adding business traces', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const telemetry = new OnlineTelemetry({ serviceName: 'kala-test', endpoint: 'http://localhost:4318',
      authToken: TOKEN, flushIntervalMs: 60_000, fetch: (async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) })
        return new Response('', { status: 200 })
      }) as typeof fetch })
    for (const [route, status] of [['gateway.health', 200], ['runtime.health', 503]] as const) {
      const health = telemetry.startHttpSpan('GET', route)
      health.activate()
      await tracePostgresQuery(telemetry, async () => undefined)
      health.end(status)
    }
    await telemetry.close()
    expect(requests.some((r) => r.url.endsWith('/traces'))).toBe(false)
    const metrics = requests.find((r) => r.url.endsWith('/metrics'))!.body
    expect(metrics).toContain('gateway.health')
    expect(metrics).toContain('runtime.health')
    expect(metrics).toContain('5xx')
    const logs = JSON.parse(requests.find((r) => r.url.endsWith('/logs'))!.body)
    const failure = logs.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(failure.severityText).toBe('ERROR')
    expect(failure).not.toHaveProperty('traceId')
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
