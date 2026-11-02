import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { EmptyRow, SectionHeader } from '../controls.js'

export function ModelsSection({
  payload,
  onPayloadChange,
  onModelsChanged,
}: {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
  onModelsChanged?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const [providerId, setProviderId] = useState(payload.providers[0]?.id ?? '')
  const [newProviderId, setNewProviderId] = useState('')
  const [newProviderLabel, setNewProviderLabel] = useState('')
  const [newProviderWire, setNewProviderWire] = useState<'openai' | 'anthropic'>('openai')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('')
  const [newProviderApiKey, setNewProviderApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!payload.providers.some((p) => p.id === providerId)) {
      setProviderId(payload.providers[0]?.id ?? '')
    }
  }, [payload.providers, providerId])

  const addModel = useMutation({
    mutationFn: async (input: { providerId: string; id: string; label?: string; contextWindow?: number }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
      setModelId('')
      setLabel('')
      setContextWindow('')
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const addProvider = useMutation({
    mutationFn: async (input: { id: string; label?: string; wire: 'anthropic' | 'openai'; baseUrl: string; apiKey: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      setProviderId(newProviderId.trim())
      setNewProviderId('')
      setNewProviderLabel('')
      setNewProviderBaseUrl('')
      setNewProviderApiKey('')
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deleteProvider = useMutation({
    mutationFn: async (input: { providerId: string }): Promise<ServerSettingsPayload> => {
      const params = new URLSearchParams({ providerId: input.providerId })
      const res = await fetch(`/settings/providers?${params.toString()}`, { method: 'DELETE' })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deleteModel = useMutation({
    mutationFn: async (input: { providerId: string; id: string }): Promise<ServerSettingsPayload> => {
      const params = new URLSearchParams({ providerId: input.providerId, id: input.id })
      const res = await fetch(`/settings/models?${params.toString()}`, { method: 'DELETE' })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const setDefaultModel = useMutation({
    mutationFn: async (input: { model: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/default-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const busy = addModel.isPending || deleteModel.isPending || addProvider.isPending || deleteProvider.isPending || setDefaultModel.isPending

  const submitProvider = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    const trimmedLabel = newProviderLabel.trim()
    addProvider.mutate({
      id: newProviderId.trim(),
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
      wire: newProviderWire,
      baseUrl: newProviderBaseUrl.trim(),
      apiKey: newProviderApiKey,
    })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    const trimmedLabel = label.trim()
    const parsedContextWindow = Number(contextWindow.trim())
    addModel.mutate({
      providerId,
      id: modelId.trim(),
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
      ...(Number.isSafeInteger(parsedContextWindow) && parsedContextWindow > 0 ? { contextWindow: parsedContextWindow } : {}),
    })
  }

  const deleteManual = (deleteProviderId: string, id: string): void => {
    setError(null)
    deleteModel.mutate({ providerId: deleteProviderId, id })
  }

  const deleteManualProvider = (deleteProviderId: string): void => {
    setError(null)
    deleteProvider.mutate({ providerId: deleteProviderId })
  }

  if (payload.deployment?.deployment.architecture === 'platform' && payload.runtimeManagement === 'external') {
    return <div data-testid="settings-platform-models">
      <SectionHeader title={t('settings.sections.models.label')} subtitle={t('settings.models.externallyManaged')} descriptionKind="notice" />
      <div className="space-y-4">
        {payload.agentRuntimes?.map(runtime => <div key={runtime.id} className="rounded-md bg-card/60 p-4">
          <h4 className="font-medium">{runtime.label}</h4>
          {runtime.reason ? <p className="text-sm text-destructive">{runtime.reason}</p> : null}
          {runtime.models?.length ? <ul className="mt-2 space-y-2 text-sm">{runtime.models.map(model => <li key={model.ref} className="flex flex-wrap justify-between gap-2">
            <span>{model.label}</span><code className="break-all text-xs text-muted-foreground">{model.ref}</code>
          </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">{t('settings.models.noRuntimeModels')}</p>}
        </div>)}
      </div>
    </div>
  }

  return (
    <div>
      <SectionHeader
        title={t('settings.sections.models.label')}
        subtitle={t('settings.models.subtitle')}
      />
      <details className="group mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/20 ring-1 ring-border/50">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted/40">
          <span>{t('settings.models.addProvider')}</span>
          <span className="text-xs font-normal text-muted-foreground">{t('settings.models.addProviderHint')}</span>
        </summary>
      <form onSubmit={submitProvider} className="border-t border-border/50 p-3">
        <div className="grid min-w-0 gap-3 lg:grid-cols-3">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.providerId')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={newProviderId}
              onChange={(event) => setNewProviderId(event.target.value)}
              placeholder="openai-local"
              disabled={busy}
              data-testid="settings-provider-id-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={newProviderLabel}
              onChange={(event) => setNewProviderLabel(event.target.value)}
              placeholder={t('settings.models.optional')}
              disabled={busy}
              data-testid="settings-provider-label-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.wire')}
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={newProviderWire}
              onChange={(event) => setNewProviderWire(event.target.value as 'openai' | 'anthropic')}
              disabled={busy}
              data-testid="settings-provider-wire-select"
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic-compatible</option>
            </select>
          </label>
        </div>
        <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.baseUrl')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={newProviderBaseUrl}
              onChange={(event) => setNewProviderBaseUrl(event.target.value)}
              placeholder="http://localhost:8000/v1"
              disabled={busy}
              data-testid="settings-provider-base-url-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.apiKey')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              type="password"
              value={newProviderApiKey}
              onChange={(event) => setNewProviderApiKey(event.target.value)}
              placeholder="sk-..."
              disabled={busy}
              data-testid="settings-provider-api-key-input"
            />
          </label>
        </div>
        <div className="mt-3 flex min-w-0 justify-end">
          <Button type="submit" className="h-9 w-full sm:w-auto" disabled={busy || newProviderId.trim().length === 0 || newProviderBaseUrl.trim().length === 0 || newProviderApiKey.length === 0}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.models.addProvider')}
          </Button>
        </div>
      </form>
      </details>
      <form onSubmit={submit} className="mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="mb-3">
          <div className="text-sm font-semibold text-foreground">{t('settings.models.addModel')}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.models.addModelHint')}</div>
        </div>
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.provider')}
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              disabled={payload.providers.length === 0 || busy}
              data-testid="settings-model-provider-select"
            >
              {payload.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.modelId')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="gpt-5.5-mini"
              disabled={payload.providers.length === 0 || busy}
              data-testid="settings-model-id-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.contextWindow')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              placeholder="1000000"
              disabled={payload.providers.length === 0 || busy}
              inputMode="numeric"
              data-testid="settings-model-context-window-input"
            />
          </label>
        </div>
        <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('settings.models.optional')}
              disabled={payload.providers.length === 0 || busy}
            />
          </label>
          <div className="flex min-w-0 justify-end">
            <Button type="submit" className="h-9 w-full sm:w-auto" disabled={payload.providers.length === 0 || busy || modelId.trim().length === 0} data-testid="settings-model-add-button">
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.models.add')}
            </Button>
          </div>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        <div className="mt-2 break-words text-xs text-muted-foreground">
          <Trans i18nKey="settings.models.manualStored" values={{ path: payload.paths.manualModels }} components={{ code: <code className="font-mono" /> }} />
        </div>
      </form>
      {payload.providers.length === 0 ? (
        <EmptyRow>
          {t('settings.models.noProvider', { claudePath: payload.paths.claudeSettings, codexPath: payload.paths.codexConfig })}
        </EmptyRow>
      ) : (
        <div className="space-y-4">
          {payload.providers.map((p) => (
            <div
              key={p.id}
              className="max-w-full min-w-0 overflow-hidden rounded-md bg-card/60 p-3 ring-1 ring-border/50 sm:p-4"
              data-testid={`settings-provider-${p.id}`}
            >
              <div className="mb-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div className="min-w-0 overflow-hidden">
                  <div className="truncate font-medium" title={p.label}>{p.label}</div>
                  <div className="min-w-0 break-words text-xs text-muted-foreground">
                    <span className="font-mono">{p.wire}</span>
                    {' · '}
                    <SourceBadge source={p.source ?? 'unknown'} />
                    {p.baseUrl ? (
                      <>
                        {' · '}
                        <span className="break-all font-mono">{p.baseUrl}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setProviderId(p.id)
                      window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid="settings-model-id-input"]')?.focus(), 0)
                    }}
                    className="inline-flex items-center rounded px-1.5 py-1 text-caption font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t('settings.models.addModelTo', { provider: p.label })}
                  >
                    <Plus className="mr-1 h-3 w-3" aria-hidden="true" />{t('settings.models.addModelShort')}
                  </button>
                  {p.models.some((m) => modelKey(m) === payload.defaultModel || m.id === payload.defaultModel) ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-caption font-medium uppercase tracking-wide text-foreground ring-1 ring-primary/40">
                      {t('settings.models.defaultProvider')}
                    </span>
                  ) : null}
                  {p.source === 'manual' ? (
                    <button
                      type="button"
                      onClick={() => { deleteManualProvider(p.id) }}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t('settings.models.deleteProvider', { provider: p.id })}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
              {p.models.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  {t('settings.models.noModelAttached')}
                </div>
              ) : (
                <ul className="space-y-1">
                  {p.models.map((m) => (
                    <li
                      key={m.id}
                      className="grid min-w-0 gap-2 rounded bg-muted/40 px-2.5 py-1.5 text-xs ring-1 ring-border/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <span className="min-w-0 break-all font-mono" title={m.id}>{m.id}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                        <SourceBadge source={m.source ?? p.source ?? 'unknown'} />
                        {m.contextWindow ? (
                          <span className="font-mono text-caption text-muted-foreground">{m.contextWindow.toLocaleString()}</span>
                        ) : null}
                        {modelKey(m) === payload.defaultModel || m.id === payload.defaultModel ? (
                          <span className="text-caption font-medium uppercase tracking-wide text-primary">
                            {t('settings.models.default')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setError(null)
                              setDefaultModel.mutate({ model: modelKey(m) })
                            }}
                            className="rounded px-1.5 py-0.5 text-caption font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={t('settings.models.setDefaultModel', { model: modelKey(m) })}
                            disabled={busy}
                          >
                            {t('settings.models.setDefault')}
                          </button>
                        )}
                        {m.source === 'manual' ? (
                          <button
                            type="button"
                            onClick={() => { deleteManual(p.id, m.id) }}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('settings.models.deleteModel', { model: m.id })}
                            disabled={busy}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function modelKey(model: { ref?: string; id: string }): string {
  return model.ref ?? model.id
}

function SourceBadge({ source }: { source: string }): JSX.Element {
  const label = source === 'claude-settings'
    ? 'Claude Code'
    : source === 'codex-config'
      ? 'Codex'
      : source === 'env'
        ? 'Env'
        : source === 'manual'
          ? 'Manual'
          : 'Unknown'
  return (
    <span className="rounded bg-background/80 px-1.5 py-0.5 text-caption font-medium uppercase tracking-wide text-muted-foreground ring-1 ring-border/50">
      {label}
    </span>
  )
}
