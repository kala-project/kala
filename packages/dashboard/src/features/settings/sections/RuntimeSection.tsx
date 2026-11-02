import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { SectionHeader } from '../controls.js'
import { errorMessageFromBody } from '../section-utils.js'

export function RuntimeSection({
  payload,
  onOpenModels,
}: {
  payload: ServerSettingsPayload
  onOpenModels?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<{ operationId: string; deploymentId?: string; phase: string; blockers?: readonly string[] } | null>(null)
  const platform = payload.deployment?.deployment.architecture === 'platform'
  const restart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch(platform ? '/runtime/deployment/restart' : '/runtime/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(platform ? {} : { mode: 'checkpoint', reason: 'manual' }),
      })
      const body = await res.json() as unknown | { error?: string }
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: (body) => {
      setError(null)
      if (platform) setOperation(body as { operationId: string; deploymentId?: string; phase: string })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const abortRestart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch(platform && operation ? `/runtime/deployment/operations/${encodeURIComponent(operation.operationId)}/abort` : '/runtime/restart/abort', { method: 'POST' })
      const body = await res.json() as unknown
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  useEffect(() => {
    if (!platform || !operation || ['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed', 'rejected'].includes(operation.phase)) return
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/runtime/deployment/operations/${encodeURIComponent(operation.operationId)}`, { cache: 'no-store' })
        const body = await res.json() as { operationId?: string; deploymentId?: string; phase?: string; blockers?: readonly string[]; error?: { message?: string } }
        if (!res.ok || !body.phase) throw new Error(body.error?.message ?? `HTTP ${res.status}`)
        if (!cancelled) {
          setOperation((current) => current?.operationId === operation.operationId ? { ...current, ...body, operationId: operation.operationId, phase: body.phase! } : current)
          if (body.error?.message) setError(body.error.message)
          if (!['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed', 'rejected'].includes(body.phase)) {
            timer = window.setTimeout(() => { void poll() }, 1_000)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          timer = window.setTimeout(() => { void poll() }, 1_000)
        }
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [operation?.operationId, operation?.phase, platform])
  const runtime = payload.runtime
  const externallyManaged = payload.runtimeManagement === 'external'
  const currentAttempt = runtime?.current
  const restartActive = platform ? Boolean(operation && !['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed', 'rejected'].includes(operation.phase)) : Boolean(currentAttempt)
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.runtime.label')}
        subtitle={t('settings.runtime.subtitle')}
      />
      {runtime ? (
        <div className="mb-5 rounded-lg bg-card p-4 ring-1 ring-border/40">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0 space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground">{t('settings.runtime.hostRuntime')}{externallyManaged ? <HelpHint label={t('settings.runtime.hostRuntime')}>{t('settings.runtime.externallyManaged')}</HelpHint> : null}</div>
              <div className="text-sm text-foreground">
                {t('settings.runtime.startedAt')}: <time dateTime={runtime.startedAt}>{new Date(runtime.startedAt).toLocaleString()}</time>
              </div>
              {restartActive ? <div className="text-sm text-foreground" role="status">
                {t('settings.runtime.restartPhase')}: {platform ? operation?.phase ?? t('settings.runtime.restartIdle') : currentAttempt?.phase ?? t('settings.runtime.restartIdle')}
                {!platform && currentAttempt ? ` - ${currentAttempt.sessions.length} ${t('settings.runtime.restartSessions')}` : ''}
              </div> : null}
              {operation?.blockers?.length ? <div className="text-sm text-amber-700 dark:text-amber-300">{t('settings.runtime.restartBlockers')}: {operation.blockers.join(', ')}</div> : null}
              {operation?.operationId ? <div className="break-all font-mono text-caption text-muted-foreground">{operation.operationId}</div> : null}
            </div>
            {!externallyManaged ? <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" size="sm" className="h-9" disabled={restart.isPending || restartActive} onClick={() => restart.mutate()}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.runtime.restartHost')}
              </Button>
              {restartActive ? (
                <Button type="button" variant="outline" size="sm" className="h-9" disabled={abortRestart.isPending} onClick={() => abortRestart.mutate()}>
                  {t('settings.runtime.abortRestart')}
                </Button>
              ) : null}
            </div> : null}
          </div>
          <details className="mt-4 rounded-md bg-muted/40 p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">{t('settings.deployment.technicalDetails')}</summary>
            <div className="mt-3 space-y-2 text-sm leading-6 text-foreground">
              <p>PID {runtime.pid}</p>
              {restartActive ? <p>{t('settings.runtime.restartPhase')}: {platform ? operation?.phase : currentAttempt?.phase}</p> : null}
              {!externallyManaged ? <p>{t('settings.runtime.restartDesc')}</p> : null}
            </div>
          </details>
          {error ? <div className="mt-2 text-sm text-destructive" role="alert">{error}</div> : null}
        </div>
      ) : <p className="text-sm text-muted-foreground">{t('settings.runtime.unavailable')}</p>}
      <h3 className="mb-3 flex items-center gap-1 text-base font-semibold">{t('settings.runtime.agentEngines')}<HelpHint label={t('settings.runtime.agentEngines')}>{t('settings.runtime.engineHelp')}</HelpHint></h3>
      <div className="grid gap-3">
        {payload.agentRuntimes?.map((agentRuntime) => (
          <section key={agentRuntime.id} className="rounded-lg bg-card p-4 ring-1 ring-border/40" data-testid={`agent-runtime-${agentRuntime.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="flex items-center gap-1 text-base font-semibold text-foreground">{t(`settings.runtime.engines.${agentRuntime.id}.title`, { defaultValue: agentRuntime.label })}<HelpHint label={t(`settings.runtime.engines.${agentRuntime.id}.title`, { defaultValue: agentRuntime.label })}>{t(`settings.runtime.engines.${agentRuntime.id}.description`, { defaultValue: agentRuntime.description })}</HelpHint></h4>
              <span className={agentRuntime.status === 'ready' ? 'rounded-full bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-300' : 'rounded-full bg-muted px-3 py-1 text-sm font-medium text-foreground'}>{t(`settings.runtime.status.${agentRuntime.status}`)}</span>
            </div>
            {agentRuntime.models?.length ? <div className="mt-3 text-sm text-foreground">{onOpenModels ? <button type="button" className="underline underline-offset-4" onClick={onOpenModels}>{t('settings.runtime.availableModels', { count: agentRuntime.models.length })}</button> : t('settings.runtime.availableModels', { count: agentRuntime.models.length })}</div> : null}
            {agentRuntime.reason ? <p className="text-sm text-destructive">{agentRuntime.reason}</p> : null}
          </section>
        ))}
      </div>
    </div>
  )
}
