import { createHmac, randomBytes } from 'node:crypto'

export type SafeTelemetryAttributes = Readonly<Record<
  'component' | 'deployment.mode' | 'error.type' | 'http.request.method' | 'http.response.status_code' |
  'http.route' | 'operation' | 'outcome' | 'provider' | 'status.class' | 'execution.state' |
  'measurement.source' | 'timing.estimated',
  string | number | undefined
>>

type Signal =
  | { kind: 'span'; value: OtlpSpan }
  | { kind: 'log'; value: OtlpLog }
  | { kind: 'metric'; value: OtlpMetric }

type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  status: { code: number }
}
type OtlpLog = {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: OtlpAttribute[]
  traceId?: string
  spanId?: string
}
type OtlpMetric = {
  name: string
  unit: string
  gauge?: { dataPoints: OtlpDataPoint[] }
  sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: OtlpDataPoint[] }
  histogram?: { aggregationTemporality: number; dataPoints: OtlpHistogramDataPoint[] }
}
type OtlpDataPoint = { timeUnixNano: string; asDouble: number; attributes: OtlpAttribute[] }
type OtlpHistogramDataPoint = Omit<OtlpDataPoint, 'asDouble'> & {
  count: string
  sum: number
  bucketCounts: string[]
  explicitBounds: number[]
  min: number
  max: number
}
type OtlpAttribute = { key: string; value: { stringValue: string } | { intValue: string } }

export type OnlineTelemetryOptions = {
  serviceName: string
  endpoint: string
  authToken: string
  serviceVersion?: string
  queueCapacity?: number
  batchSize?: number
  flushIntervalMs?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

export type HttpSpan = {
  readonly traceparent: string
  readonly correlationId: string
  end(statusCode: number): void
}

export type ExplicitTelemetrySpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: 'agent.turn' | 'agent.llm' | 'agent.tool' | 'agent.approval' | 'agent.compaction' | 'agent.retry' | 'agent.recovery'
  startedAtUnixMs: number
  completedAtUnixMs: number
  status: 'ok' | 'error' | 'unset'
  attributes?: Partial<SafeTelemetryAttributes>
}

const ATTRIBUTE_KEYS = new Set([
  'component', 'deployment.mode', 'error.type', 'http.request.method', 'http.response.status_code',
  'http.route', 'operation', 'outcome', 'provider', 'status.class', 'execution.state',
  'measurement.source', 'timing.estimated',
])
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,127}$/u
const ROUTE = /^[a-z][a-z0-9_.-]{0,63}$/u
const METHOD = /^(DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/u
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u
const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/u
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/u
const DERIVATION_DOMAIN = /^[a-z][a-z0-9_.-]{0,63}$/u
const SERVICE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/u
const EXPLICIT_SPAN_NAMES = new Set(['agent.turn', 'agent.llm', 'agent.tool', 'agent.approval', 'agent.compaction', 'agent.retry', 'agent.recovery'])
const EXPLICIT_SPAN_STATUSES = new Set(['ok', 'error', 'unset'])
const HISTOGRAM_BOUNDS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000]
const HISTOGRAM_BOUNDS_COUNT = [0, 1, 2, 5, 10, 25, 50, 100]

/**
 * A deliberately small, Node-only OTLP/HTTP JSON client for operational signals.
 * It has no ambient context: callers explicitly pass traceparent across each short
 * request boundary, so long-lived Socket.IO/WebSocket contexts cannot leak.
 */
export class OnlineTelemetry {
  private readonly endpoint: string
  private readonly serviceName: string
  private readonly authToken: string
  private readonly serviceVersion?: string
  private readonly queueCapacity: number
  private readonly batchSize: number
  private readonly timeoutMs: number
  private readonly send: typeof fetch
  private readonly queue: Signal[] = []
  private readonly timer: ReturnType<typeof setInterval>
  private flushing = false
  private stopped = false

  constructor(options: OnlineTelemetryOptions) {
    const endpoint = new URL(options.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('telemetry endpoint must be an HTTP(S) origin or path without credentials, query, or fragment')
    }
    if (!options.authToken || options.authToken.length < 32 || options.authToken.length > 1024) {
      throw new Error('telemetry auth token must contain 32 through 1024 characters')
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(options.serviceName)) throw new Error('invalid telemetry service name')
    this.endpoint = endpoint.toString().replace(/\/$/u, '')
    this.serviceName = options.serviceName
    this.authToken = options.authToken
    if (options.serviceVersion !== undefined && !SERVICE_VERSION.test(options.serviceVersion)) throw new Error('invalid telemetry service version')
    this.serviceVersion = options.serviceVersion
    this.queueCapacity = boundedInteger(options.queueCapacity ?? 512, 16, 4096, 'queue capacity')
    this.batchSize = boundedInteger(options.batchSize ?? 64, 1, this.queueCapacity, 'batch size')
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 2_000, 100, 10_000, 'timeout')
    this.send = options.fetch ?? fetch
    const interval = boundedInteger(options.flushIntervalMs ?? 2_000, 100, 60_000, 'flush interval')
    this.timer = setInterval(() => { void this.flush() }, interval)
    this.timer.unref()
  }

  startHttpSpan(method: string | undefined, route: string, incomingTraceparent?: string | string[]): HttpSpan {
    const normalizedMethod = METHOD.test(method ?? '') ? method! : 'OTHER'
    const normalizedRoute = ROUTE.test(route) ? route : 'other'
    const parsed = typeof incomingTraceparent === 'string' ? TRACEPARENT.exec(incomingTraceparent.trim().toLowerCase()) : null
    const incoming = parsed && TRACE_ID.test(parsed[1]!) && SPAN_ID.test(parsed[2]!) ? parsed : null
    const traceId = incoming?.[1] ?? randomHex(16)
    const parentSpanId = incoming?.[2]
    const spanId = randomHex(8)
    const startedAt = nowNano()
    const startedMono = process.hrtime.bigint()
    let ended = false
    return {
      traceparent: `00-${traceId}-${spanId}-01`,
      correlationId: traceId,
      end: (statusCode) => {
        if (ended) return
        ended = true
        const safeStatus = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 500
        const statusClass = `${Math.floor(safeStatus / 100)}xx`
        const attributes = safeAttributes({
          'http.request.method': normalizedMethod,
          'http.route': normalizedRoute,
          'http.response.status_code': safeStatus,
          'status.class': statusClass,
          outcome: safeStatus >= 500 ? 'error' : safeStatus >= 400 ? 'rejected' : 'ok',
        })
        this.enqueue({ kind: 'span', value: {
          traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name: `http ${normalizedRoute}`, kind: 2,
          startTimeUnixNano: startedAt,
          endTimeUnixNano: (BigInt(startedAt) + (process.hrtime.bigint() - startedMono)).toString(),
          attributes,
          status: { code: safeStatus >= 500 ? 2 : 1 },
        } })
        this.counter('kala_http_server_duration_ms_total', Number(process.hrtime.bigint() - startedMono) / 1_000_000, {
          'http.request.method': normalizedMethod, 'http.route': normalizedRoute, 'status.class': statusClass,
        })
        this.counter('kala_http_server_requests_total', 1, {
          'http.request.method': normalizedMethod, 'http.route': normalizedRoute, 'status.class': statusClass,
        })
        if (safeStatus >= 500) this.log('error', 'HTTP request failed', {
          'http.request.method': normalizedMethod, 'http.route': normalizedRoute, 'status.class': statusClass,
        }, traceId, spanId)
      },
    }
  }

  /**
   * Derives anonymous, stable IDs without exporting the source identifiers. The
   * namespace intentionally rotates when the configured ingest token rotates.
   */
  deriveTraceId(domain: string, parts: readonly string[]): string | undefined {
    return this.deriveId(domain, parts, 16)
  }

  deriveSpanId(domain: string, parts: readonly string[]): string | undefined {
    return this.deriveId(domain, parts, 8)
  }

  recordSpan(span: ExplicitTelemetrySpan): void {
    if (!EXPLICIT_SPAN_NAMES.has(span.name) || !EXPLICIT_SPAN_STATUSES.has(span.status)) return
    if (!TRACE_ID.test(span.traceId) || !SPAN_ID.test(span.spanId)) return
    if (span.parentSpanId !== undefined && !SPAN_ID.test(span.parentSpanId)) return
    if (!Number.isFinite(span.startedAtUnixMs) || !Number.isFinite(span.completedAtUnixMs) || span.startedAtUnixMs < 0 || span.completedAtUnixMs < span.startedAtUnixMs) return
    const startTimeUnixNano = unixMsToNano(span.startedAtUnixMs)
    const endTimeUnixNano = unixMsToNano(span.completedAtUnixMs)
    if (!startTimeUnixNano || !endTimeUnixNano) return
    this.enqueue({ kind: 'span', value: {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: 1,
      startTimeUnixNano,
      endTimeUnixNano,
      attributes: safeAttributes(span.attributes ?? {}),
      status: { code: span.status === 'ok' ? 1 : span.status === 'error' ? 2 : 0 },
    } })
  }

  counter(name: string, value = 1, attributes: Partial<SafeTelemetryAttributes> = {}): void {
    if (!METRIC_NAME.test(name) || !Number.isFinite(value) || value < 0) return
    this.enqueue({ kind: 'metric', value: {
      name, unit: '1', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [point(value, attributes)] },
    } })
  }

  gauge(name: string, value: number, attributes: Partial<SafeTelemetryAttributes> = {}): void {
    if (!METRIC_NAME.test(name) || !Number.isFinite(value)) return
    this.enqueue({ kind: 'metric', value: { name, unit: '1', gauge: { dataPoints: [point(value, attributes)] } } })
  }

  histogram(name: string, value: number, unit: 'ms' | '{call}', attributes: Partial<SafeTelemetryAttributes> = {}): void {
    if (!METRIC_NAME.test(name) || !Number.isFinite(value) || value < 0) return
    const bounds = unit === 'ms' ? HISTOGRAM_BOUNDS_MS : HISTOGRAM_BOUNDS_COUNT
    const bucket = bounds.findIndex((bound) => value <= bound)
    const selectedBucket = bucket < 0 ? bounds.length : bucket
    const bucketCounts = Array.from({ length: bounds.length + 1 }, (_, index) => index === selectedBucket ? '1' : '0')
    this.enqueue({ kind: 'metric', value: {
      name,
      unit,
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [{
          timeUnixNano: nowNano(), count: '1', sum: value, min: value, max: value,
          explicitBounds: bounds, bucketCounts, attributes: safeAttributes(attributes),
        }],
      },
    } })
  }

  log(severity: 'info' | 'warn' | 'error', message: 'HTTP request failed' | 'Runtime operation failed', attributes: Partial<SafeTelemetryAttributes> = {}, traceId?: string, spanId?: string): void {
    const levels = { info: 9, warn: 13, error: 17 } as const
    this.enqueue({ kind: 'log', value: {
      timeUnixNano: nowNano(), severityNumber: levels[severity], severityText: severity.toUpperCase(),
      body: { stringValue: message }, attributes: safeAttributes(attributes),
      ...(traceId && /^[0-9a-f]{32}$/u.test(traceId) ? { traceId } : {}),
      ...(spanId && /^[0-9a-f]{16}$/u.test(spanId) ? { spanId } : {}),
    } })
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.splice(0, this.batchSize)
    try {
      for (const kind of ['span', 'log', 'metric'] as const) {
        const values = batch.filter((signal) => signal.kind === kind).map((signal) => signal.value)
        if (values.length === 0) continue
        await this.post(kind, values)
      }
    } finally {
      this.flushing = false
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    await this.flush()
  }

  private enqueue(signal: Signal): void {
    if (this.stopped) return
    if (this.queue.length >= this.queueCapacity) this.queue.shift()
    this.queue.push(signal)
  }

  private deriveId(domain: string, parts: readonly string[], bytes: 8 | 16): string | undefined {
    if (!DERIVATION_DOMAIN.test(domain) || parts.length === 0 || parts.length > 8) return undefined
    const hmac = createHmac('sha256', this.authToken)
    hmac.update(`kala-telemetry:${domain}\0`)
    for (const part of parts) {
      if (typeof part !== 'string' || part.length === 0 || part.length > 256) return undefined
      hmac.update(`${Buffer.byteLength(part, 'utf8')}:`)
      hmac.update(part)
      hmac.update('\0')
    }
    return hmac.digest('hex').slice(0, bytes * 2)
  }

  private async post(kind: 'span' | 'log' | 'metric', values: Array<OtlpSpan | OtlpLog | OtlpMetric>): Promise<void> {
    const resource = { attributes: [
      { key: 'service.name', value: { stringValue: this.serviceName } },
      ...(this.serviceVersion ? [{ key: 'service.version', value: { stringValue: this.serviceVersion } }] : []),
    ] }
    const scope = { name: '@agent-kernel/shared/node-telemetry' }
    const body = kind === 'span'
      ? { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: values }] }] }
      : kind === 'log'
        ? { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: values }] }] }
        : { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: values }] }] }
    const path = kind === 'span' ? 'traces' : kind === 'log' ? 'logs' : 'metrics'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.send(`${this.endpoint}/v1/${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.authToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        })
        await response.body?.cancel()
        if (response.ok || response.status < 500 || attempt === 1) return
      } catch {
        if (attempt === 1) return
      } finally {
        clearTimeout(timeout)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export function createOnlineTelemetryFromEnv(serviceName: string, env: NodeJS.ProcessEnv = process.env): OnlineTelemetry | undefined {
  if (env.KALA_OTEL_ENABLED !== '1') return undefined
  const endpoint = env.KALA_OTEL_EXPORTER_ENDPOINT?.trim()
  const authToken = env.KALA_OTEL_EXPORTER_TOKEN?.trim()
  if (!endpoint || !authToken) throw new Error('online telemetry requires KALA_OTEL_EXPORTER_ENDPOINT and KALA_OTEL_EXPORTER_TOKEN')
  const serviceVersion = env.KALA_OTEL_SERVICE_VERSION?.trim()
  return new OnlineTelemetry({ serviceName, endpoint, authToken, ...(serviceVersion ? { serviceVersion } : {}) })
}

function safeAttributes(attributes: Partial<SafeTelemetryAttributes>): OtlpAttribute[] {
  const out: OtlpAttribute[] = []
  for (const [key, raw] of Object.entries(attributes)) {
    if (!ATTRIBUTE_KEYS.has(key) || raw === undefined) continue
    if (typeof raw === 'number') {
      if (Number.isSafeInteger(raw)) out.push({ key, value: { intValue: String(raw) } })
      continue
    }
    const value = raw.slice(0, 64)
    if (/^[a-zA-Z0-9_.:/ -]{1,64}$/u.test(value)) out.push({ key, value: { stringValue: value } })
  }
  return out
}
function point(value: number, attributes: Partial<SafeTelemetryAttributes>): OtlpDataPoint {
  return { timeUnixNano: nowNano(), asDouble: value, attributes: safeAttributes(attributes) }
}
function randomHex(bytes: number): string { return randomBytes(bytes).toString('hex') }
function nowNano(): string { return (BigInt(Date.now()) * 1_000_000n).toString() }
function unixMsToNano(value: number): string | undefined {
  if (!Number.isSafeInteger(value)) return undefined
  const nano = BigInt(value) * 1_000_000n
  return nano <= 0xffffffffffffffffn ? nano.toString() : undefined
}
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`telemetry ${name} is out of bounds`)
  return value
}
