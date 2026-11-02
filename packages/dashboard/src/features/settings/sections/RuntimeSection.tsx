import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { SectionHeader } from '../controls.js'
import { errorMessageFromBody } from '../section-utils.js'

export function RuntimeSection({
  payload,
}: {
  payload: ServerSettingsPayload
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
        <div className="mb-4 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0 space-y-1 text-sm">
              <div className="font-medium text-foreground">{t('settings.runtime.hostRuntime')}</div>
              <div className="text-xs text-muted-foreground">PID {runtime.pid} - {t('settings.runtime.startedAt')}: {runtime.startedAt}</div>
              <div className="text-xs text-muted-foreground">
                {t('settings.runtime.restartPhase')}: {platform ? operation?.phase ?? t('settings.runtime.restartIdle') : currentAttempt?.phase ?? t('settings.runtime.restartIdle')}
                {!platform && currentAttempt ? ` - ${currentAttempt.sessions.length} ${t('settings.runtime.restartSessions')}` : ''}
              </div>
              {operation?.blockers?.length ? <div className="text-xs text-amber-600">{t('settings.runtime.restartBlockers')}: {operation.blockers.join(', ')}</div> : null}
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
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{t(externallyManaged ? 'settings.runtime.externallyManaged' : 'settings.runtime.restartDesc')}</p>
          {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        </div>
      ) : <p className="text-sm text-muted-foreground">{t('settings.runtime.unavailable')}</p>}
      {payload.agentRuntimes?.map((agentRuntime) => (
        <div key={agentRuntime.id} className="mb-3 rounded-md bg-muted/40 p-4 text-sm" data-testid={`agent-runtime-${agentRuntime.id}`}>
          <div className="font-medium">{agentRuntime.label}</div>
          <div>{t(`settings.runtime.status.${agentRuntime.status}`)}</div>
          {agentRuntime.reason ? <p className="text-destructive">{agentRuntime.reason}</p> : null}
          {agentRuntime.models?.length ? <p className="text-muted-foreground">{t('settings.runtime.availableModels', { count: agentRuntime.models.length })}</p> : null}
        </div>
      ))}
    </div>
  )
}
