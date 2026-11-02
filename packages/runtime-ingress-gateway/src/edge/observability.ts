import type { OperatorObservabilitySnapshot } from '@agent-kernel/shared'

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_observability_response')
  return value as JsonObject
}
function rows(value: unknown): JsonObject[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('invalid_observability_response')
  return value.map(object)
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
const visibleAttributes = new Set(['http.route', 'http.request.method', 'http.response.status_code', 'provider', 'agent.runtime', 'outcome', 'duration.ms'])
function attributes(value: unknown, filtered = true): Record<string, string> {
  return Object.fromEntries(rows(value).flatMap(entry => {
    const key = text(entry.key)
    if (filtered && !visibleAttributes.has(key)) return []
    const values = object(entry.value)
    const content = values.stringValue ?? values.intValue ?? values.doubleValue ?? values.boolValue
    return typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean'
      ? [[key, String(content).slice(0, 512)]] : []
  }))
}
function timestamp(value: unknown): string | undefined {
  const nanos = text(value)
  if (!/^\d{1,20}$/u.test(nanos)) return undefined
  const milliseconds = Number(nanos) / 1_000_000
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : undefined
}
function durationMs(span: JsonObject): number {
  const start = text(span.startTimeUnixNano), end = text(span.endTimeUnixNano)
  if (!/^\d{1,20}$/u.test(start) || !/^\d{1,20}$/u.test(end)) throw new Error('invalid_observability_response')
  return Number(BigInt(end) - BigInt(start)) / 1_000_000
}

export async function loadOperatorObservability(get: (path: string) => Promise<unknown>): Promise<OperatorObservabilitySnapshot> {
  const [resourcesValue, logsValue, spansValue] = await Promise.all([
    get('resources'), get('logs?limit=100'), get('spans?limit=500'),
  ])
  const resources = rows(resourcesValue).map(row => ({
    name: text(row.displayName ?? row.name), hasLogs: row.hasLogs === true,
    hasTraces: row.hasTraces === true, hasMetrics: row.hasMetrics === true,
  }))
  const logsDocument = object(logsValue), spansDocument = object(spansValue)
  const logs = rows(object(logsDocument.data).resourceLogs).flatMap(resource =>
    rows(resource.scopeLogs).flatMap(scope => rows(scope.logRecords).map(log => ({
      service: attributes(object(resource.resource).attributes, false)['service.name'] ?? '',
      message: text(object(log.body).stringValue).slice(0, 512),
      timestamp: timestamp(log.timeUnixNano), traceId: text(log.traceId) || undefined,
      attributes: attributes(log.attributes),
    }))))
  const spans = rows(object(spansDocument.data).resourceSpans).flatMap(resource =>
    rows(resource.scopeSpans).flatMap(scope => rows(scope.spans).map(span => ({
      service: attributes(object(resource.resource).attributes, false)['service.name'] ?? '',
      name: text(span.name), traceId: text(span.traceId) || undefined,
      timestamp: timestamp(span.startTimeUnixNano),
      durationMs: durationMs(span),
      attributes: attributes(span.attributes),
    }))))
  if (typeof logsDocument.totalCount !== 'number' || typeof spansDocument.totalCount !== 'number'
      || spans.some(span => !Number.isFinite(span.durationMs) || span.durationMs < 0)) throw new Error('invalid_observability_response')
  return {
    checkedAt: new Date().toISOString(), retainedLogs: logsDocument.totalCount,
    retainedSpans: spansDocument.totalCount, resources,
    logs: logs.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')),
    spans: spans.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')),
  }
}
