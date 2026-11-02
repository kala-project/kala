import type { DeploymentServices, OperatorObservabilitySnapshot } from '@agent-kernel/shared'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { resolvePublicHttpUrl } from '../../runtime-capabilities.js'

export function DeploymentCenter({ services, onClose }: { services: DeploymentServices; onClose(): void }): JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<OperatorObservabilitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!services.observability) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/organization/observability', { cache: 'no-store', signal })
      if (!response.ok) throw new Error(t('deploymentCenter.loadFailed', { status: response.status }))
      const next = await response.json() as OperatorObservabilitySnapshot
      if (!signal?.aborted) setSnapshot(next)
    } catch (reason) {
      if (!signal?.aborted) {
        setSnapshot(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [services.observability, t])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  const identityUrl = resolvePublicHttpUrl(services.identityConsoleUrl)
  const gatewayRequests = snapshot?.spans.filter(span => span.name.startsWith('http gateway.')) ?? []
  const groups = new Map<string, { count: number; durationMs: number }>()
  for (const span of gatewayRequests) {
    const route = span.attributes['http.route'] ?? span.name
    const label = t(`deploymentCenter.routes.${route.replace('gateway.', '')}`, { defaultValue: route })
    const key = `${span.attributes['http.request.method'] ?? ''} ${label} · ${span.attributes['http.response.status_code'] ?? ''}`
    const previous = groups.get(key) ?? { count: 0, durationMs: 0 }
    groups.set(key, { count: previous.count + 1, durationMs: previous.durationMs + span.durationMs })
  }
  return <section className="fixed inset-0 z-[71] flex flex-col bg-background" data-testid="deployment-center">
    <header className="flex min-h-14 flex-none items-center justify-between gap-3 bg-muted/25 px-4">
      <h1 className="font-semibold">{t('deploymentCenter.title')}</h1>
      <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
    </header>
    <ScrollArea className="min-h-0 flex-1"><main className="mx-auto grid max-w-6xl gap-5 p-4 md:p-6">
      <p className="text-sm leading-6 text-muted-foreground">{t('deploymentCenter.scope')}</p>
      {identityUrl ? <article className="rounded-xl bg-card p-5 ring-1 ring-border/35">
        <h2 className="text-base font-semibold">{t('deploymentCenter.identity')}</h2>
        <p className="my-3 text-sm text-muted-foreground">{t('deploymentCenter.identityHelp')}</p>
        <Button asChild variant="outline"><a href={identityUrl} target="_blank" rel="noreferrer" data-testid="deployment-identity-console">{t('deploymentCenter.openIdentity')}</a></Button>
      </article> : null}
      <article className="rounded-xl bg-card p-5 ring-1 ring-border/35">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('deploymentCenter.observability')}</h2>
          {services.observability ? <Button variant="outline" disabled={loading} onClick={() => void load()}>{t('deploymentCenter.refresh')}</Button> : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('deploymentCenter.observabilityHelp')}</p>
        {!services.observability ? <p className="mt-3 text-sm">{t('deploymentCenter.notConfigured')}</p> : null}
        {loading ? <p role="status" className="mt-3 text-sm">{t('deploymentCenter.loading')}</p> : null}
        {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
        {snapshot ? <>
          <p className="mt-4 text-sm">{t('deploymentCenter.updated', { time: new Date(snapshot.checkedAt).toLocaleString() })}</p>
          <div className="mt-4 flex flex-wrap gap-3">{snapshot.resources.map(resource => <div key={resource.name} className="rounded-lg bg-muted/35 px-4 py-3">
            <h3 className="text-sm font-semibold">{resource.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{[
              resource.hasLogs && t('deploymentCenter.logs'), resource.hasTraces && t('deploymentCenter.traces'), resource.hasMetrics && t('deploymentCenter.metrics'),
            ].filter(Boolean).join(' · ')}</p>
          </div>)}</div>
        </> : null}
      </article>
      {snapshot ? <>
        <article className="rounded-xl bg-card p-5 ring-1 ring-border/35">
          <h2 className="text-base font-semibold">{t('deploymentCenter.logs')}</h2>
          <p className="my-3 text-sm text-muted-foreground">{t('deploymentCenter.logHelp', { count: snapshot.retainedLogs })}</p>
          {snapshot.logs.length ? <div className="divide-y">{snapshot.logs.map((log, index) => <div key={index} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{log.message}</strong><span className="text-muted-foreground">{log.service}{log.timestamp ? ` · ${new Date(log.timestamp).toLocaleTimeString()}` : ''}</span></div>
            <p className="mt-1 text-sm text-muted-foreground">{[log.attributes['agent.runtime'], log.attributes.outcome, log.attributes['duration.ms'] ? `${log.attributes['duration.ms']} ms` : undefined].filter(Boolean).join(' · ')}</p>
            {log.traceId ? <details className="mt-2 text-sm"><summary className="cursor-pointer">{t('deploymentCenter.correlation')}</summary><code className="mt-1 block break-all">{log.traceId}</code></details> : null}
          </div>)}</div> : <p className="text-sm">{t('deploymentCenter.empty')}</p>}
        </article>
        <article className="rounded-xl bg-card p-5 ring-1 ring-border/35">
          <h2 className="text-base font-semibold">{t('deploymentCenter.requests')}</h2>
          <p className="my-3 text-sm leading-6 text-muted-foreground">{t('deploymentCenter.sampleHelp')}</p>
          <div className="divide-y">{[...groups].sort((a, b) => b[1].count - a[1].count).map(([route, data]) => <div key={route} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
            <span className="break-all font-medium">{route}</span><span>{t('deploymentCenter.requestSummary', { count: data.count, duration: (data.durationMs / data.count).toFixed(1) })}</span>
          </div>)}</div>
        </article>
        <article className="rounded-xl bg-card p-5 ring-1 ring-border/35">
          <h2 className="text-base font-semibold">{t('deploymentCenter.turns')}</h2>
          <p className="my-3 text-sm text-muted-foreground">{t('deploymentCenter.turnHelp')}</p>
          {snapshot.spans.filter(span => span.name === 'agent.turn').map((span, index) => <div key={span.traceId ?? index} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
            <span>{span.attributes['agent.runtime']} · {span.attributes.outcome}</span><span>{span.durationMs.toFixed(1)} ms</span>
          </div>)}
          {!snapshot.spans.some(span => span.name === 'agent.turn') ? <p className="text-sm text-muted-foreground">{t('deploymentCenter.noRecentTurns')}</p> : null}
        </article>
      </> : null}
    </main></ScrollArea>
  </section>
}
