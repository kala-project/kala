export type MetricLabels = Readonly<Record<string, string>>

type Counter = { name: string; help: string; values: Map<string, { labels: MetricLabels; value: number }> }

const ALLOWED_LABELS = new Set(['component', 'operation', 'outcome', 'status_class', 'deployment_mode', 'provider', 'tool', 'error_code'])

export class OperationalMetrics {
  private readonly counters = new Map<string, Counter>()

  constructor(private readonly onIncrement?: (name: string, value: number, labels: MetricLabels) => void) {}

  increment(name: string, help: string, labels: MetricLabels = {}, value = 1): void {
    const safe = normalizeLabels(labels)
    const counter = this.counters.get(name) ?? { name: metricName(name), help, values: new Map() }
    const key = JSON.stringify(safe)
    const current = counter.values.get(key)
    counter.values.set(key, { labels: safe, value: (current?.value ?? 0) + value })
    this.counters.set(name, counter)
    this.onIncrement?.(counter.name, value, safe)
  }

  render(): string {
    const lines: string[] = []
    for (const counter of [...this.counters.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`# HELP ${counter.name} ${counter.help.replace(/[\r\n]+/gu, ' ')}`)
      lines.push(`# TYPE ${counter.name} counter`)
      for (const item of [...counter.values.values()].sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)))) {
        const labels = Object.entries(item.labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')
        lines.push(`${counter.name}${labels ? `{${labels}}` : ''} ${item.value}`)
      }
    }
    return `${lines.join('\n')}\n`
  }
}

export type OperationalError = {
  code: string
  component: string
  operation: string
  outcome: 'error' | 'timeout' | 'recovered'
  retryable: boolean
  correlationId?: string
  safeMessage: string
}

export function operationalError(input: OperationalError): OperationalError {
  return {
    ...input,
    code: bounded(input.code, 64),
    component: bounded(input.component, 32),
    operation: bounded(input.operation, 48),
    safeMessage: bounded(input.safeMessage.replace(/(bearer|token|password|cookie|authorization)\s*[:=]\s*\S+/giu, '$1=[redacted]'), 240),
    ...(input.correlationId ? { correlationId: bounded(input.correlationId, 80) } : {}),
  }
}

function normalizeLabels(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(Object.entries(labels)
    .filter(([key]) => ALLOWED_LABELS.has(key))
    .map(([key, value]) => [metricName(key), bounded(value, 64)]))
}
function metricName(value: string): string { return value.replace(/[^a-zA-Z0-9_:]/gu, '_') }
function escapeLabel(value: string): string { return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n') }
function bounded(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…` }
