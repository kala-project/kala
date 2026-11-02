import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { EmptyRow, SectionHeader } from '../controls.js'

export function ModelsSection({
  payload,
  onPayloadChange,
  onModelsChanged,
  mode = 'configuration',
  onOpenProviders,
}: {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
  onModelsChanged?(): void
  mode?: 'catalog' | 'configuration'
  onOpenProviders?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const [providerId, setProviderId] = useState(payload.providers[0]?.id ?? '')
  const [newProviderId, setNewProviderId] = useState('')
  const [newProviderLabel, setNewProviderLabel] = useState('')
  const [newProviderWire, setNewProviderWire] = useState<'openai' | 'anthropic'>('openai')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('')
  const [newProviderApiKey, setNewProviderApiKey] = useState('')
  const [editingProviderId, setEditingProviderId] = useState<string>()
  const [providerFormOpen, setProviderFormOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<{ providerId: string; id: string }>()
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
        method: editingModel ? 'PATCH' : 'POST',
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
      setEditingModel(undefined)
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const addProvider = useMutation({
    mutationFn: async (input: { id: string; label?: string; wire: 'anthropic' | 'openai'; baseUrl: string; apiKey: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/providers', {
        method: editingProviderId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editingProviderId ? {
          providerId: editingProviderId, label: input.label ?? '', wire: input.wire,
          baseUrl: input.baseUrl, ...(input.apiKey.trim() ? { apiKey: input.apiKey } : {}),
        } : input),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
      setProviderId(newProviderId.trim())
      setNewProviderId('')
      setNewProviderLabel('')
      setNewProviderBaseUrl('')
      setNewProviderApiKey('')
      setEditingProviderId(undefined)
      setProviderFormOpen(false)
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
    if (contextWindow.trim() && (!Number.isSafeInteger(parsedContextWindow) || parsedContextWindow <= 0)) {
      setError(t('settings.models.invalidContextWindow'))
      return
    }
    addModel.mutate({
      providerId,
      id: modelId.trim(),
      ...(trimmedLabel || editingModel ? { label: trimmedLabel } : {}),
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

  const dashboardManaged = payload.modelConfiguration?.management === 'dashboard'
  const externallyManaged = payload.modelConfiguration?.management === 'operator'
    || (!dashboardManaged && payload.deployment?.deployment.architecture === 'platform' && payload.runtimeManagement === 'external')
  if (mode === 'catalog' || externallyManaged) {
    const groups = payload.agentRuntimes?.length
      ? payload.agentRuntimes.map(runtime => ({
          id: runtime.id, label: t(`settings.runtime.engines.${runtime.id}.title`, { defaultValue: runtime.label }),
          models: runtime.models ?? [], reason: runtime.reason,
        }))
      : payload.providers.map(provider => ({ id: provider.id, label: provider.label, models: provider.models, reason: undefined }))
    return <div data-testid="settings-platform-models">
      <SectionHeader title={t(mode === 'catalog' ? 'settings.sections.models.label' : 'settings.sections.modelProviders.label')} subtitle={t(externallyManaged ? 'settings.models.externallyManaged' : 'settings.models.subtitle')} />
      {mode === 'catalog' ? <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/30 p-4 text-sm">
        <span>{t(onOpenProviders ? 'settings.models.configurationLocation' : 'settings.models.contactAdministrator')}</span>
        {onOpenProviders ? <Button variant="outline" onClick={onOpenProviders} data-testid="settings-configure-providers">{t('settings.sections.modelProviders.label')}</Button> : null}
      </div> : <section className="mb-5 space-y-4 rounded-xl bg-card p-4 ring-1 ring-border/40" data-testid="settings-model-configuration">
        <h4 className="flex items-center gap-1 font-medium">{t('settings.models.operatorConfiguration')}<HelpHint label={t('settings.models.operatorConfiguration')}>{t('settings.models.operatorInstructions')}</HelpHint></h4>
        <p className="text-sm">{t('settings.models.operatorAction')}</p>
        <dl className="space-y-2 text-sm"><dt className="font-medium">{t('settings.models.providerCatalog')}</dt><dd className="break-all font-mono">{payload.modelConfiguration?.providerCatalogPath ?? 'KALA_RUNTIME_HOST_LLM_CATALOG_FILE'}</dd></dl>
        {payload.providers.map(provider => <div key={provider.id} className="min-w-0 rounded-lg bg-muted/30 p-3">
          <div className="font-medium">{provider.label}</div>
          <dl className="mt-2 grid min-w-0 gap-2 text-sm"><div><dt className="text-muted-foreground">{t('settings.models.baseUrl')}</dt><dd className="break-all font-mono">{provider.baseUrl ?? t('settings.models.notReported')}</dd></div><div><dt className="text-muted-foreground">{t('settings.models.wire')}</dt><dd>{provider.wire === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible'}</dd></div><div><dt className="text-muted-foreground">{t('settings.sections.models.label')}</dt><dd className="flex flex-wrap gap-2">{provider.models.map(model => <code key={model.ref ?? model.id} className="break-all">{model.id}</code>)}</dd></div></dl>
        </div>)}
      </section>}
      {mode === 'catalog' || externallyManaged ? <div className="space-y-4">
        {groups.map(runtime => <div key={runtime.id} className="rounded-md bg-card/60 p-4">
          <h4 className="font-medium">{runtime.label}</h4>
          {runtime.reason ? <p className="text-sm text-destructive">{runtime.reason}</p> : null}
          {runtime.models?.length ? <ul className="mt-2 space-y-2 text-sm">{runtime.models.map(model => <li key={model.ref ?? model.id} className="flex flex-wrap justify-between gap-2">
            <span>{model.label}</span><code className="break-all text-sm text-muted-foreground">{model.ref ?? model.id}</code>
          </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">{t('settings.models.noRuntimeModels')}</p>}
        </div>)}
      </div> : null}
    </div>
  }

  return (
    <div>
      <SectionHeader
        title={t('settings.sections.models.label')}
        subtitle={t('settings.models.subtitle')}
      />
      <details open={providerFormOpen} onToggle={event => setProviderFormOpen(event.currentTarget.open)} className="group mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/20 ring-1 ring-border/50">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted/40">
          <span>{t(editingProviderId ? 'settings.models.editProvider' : 'settings.models.addProvider')}</span>
          <HelpHint label={t('settings.models.addProvider')}>{t('settings.models.addProviderHint')}</HelpHint>
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
              disabled={busy || Boolean(editingProviderId)}
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
              autoComplete="new-password"
              value={newProviderApiKey}
              onChange={(event) => setNewProviderApiKey(event.target.value)}
              placeholder={editingProviderId ? t('settings.models.keepApiKey') : 'sk-...'}
              disabled={busy}
              data-testid="settings-provider-api-key-input"
            />
          </label>
        </div>
        <div className="mt-3 flex min-w-0 justify-end gap-2">
          {editingProviderId ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditingProviderId(undefined); setNewProviderId(''); setNewProviderLabel(''); setNewProviderBaseUrl(''); setNewProviderApiKey(''); setProviderFormOpen(false) }}>{t('common.cancel')}</Button> : null}
          <Button type="submit" className="h-9 w-full sm:w-auto" disabled={busy || newProviderId.trim().length === 0 || newProviderBaseUrl.trim().length === 0 || (!editingProviderId && newProviderApiKey.trim().length === 0)}>
            {t(editingProviderId ? 'common.save' : 'settings.models.addProvider')}
          </Button>
        </div>
      </form>
      </details>
      <form onSubmit={submit} className="mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="mb-3">
          <div className="flex items-center gap-1 text-sm font-semibold text-foreground">{t(editingModel ? 'settings.models.editModel' : 'settings.models.addModel')}<HelpHint label={t('settings.models.addModel')}>{t('settings.models.addModelHint')}</HelpHint></div>
        </div>
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.provider')}
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              disabled={payload.providers.length === 0 || busy || Boolean(editingModel)}
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
              disabled={payload.providers.length === 0 || busy || Boolean(editingModel)}
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
          <div className="flex min-w-0 justify-end gap-2">
            {editingModel ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditingModel(undefined); setModelId(''); setLabel(''); setContextWindow('') }}>{t('common.cancel')}</Button> : null}
            <Button type="submit" className="h-9 w-full sm:w-auto" disabled={payload.providers.length === 0 || busy || modelId.trim().length === 0} data-testid="settings-model-add-button">
              {t(editingModel ? 'common.save' : 'settings.models.add')}
            </Button>
          </div>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        <div className="mt-2"><HelpHint label={t('settings.models.storageHelp')}>{dashboardManaged ? t('settings.models.organizationStored') : t('settings.models.manualStored', { path: payload.paths.manualModels })}</HelpHint></div>
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
                      setEditingModel(undefined)
                      setModelId('')
                      setLabel('')
                      setContextWindow('')
                      window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid="settings-model-id-input"]')?.focus(), 0)
                    }}
                    className="inline-flex items-center rounded px-1.5 py-1 text-caption font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t('settings.models.addModelTo', { provider: p.label })}
                  >
                    <Plus className="mr-1 h-3 w-3" aria-hidden="true" />{t('settings.models.addModelShort')}
                  </button>
                  {dashboardManaged ? <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t('settings.models.editProviderNamed', { provider: p.label })} onClick={() => {
                    setEditingProviderId(p.id); setNewProviderId(p.id); setNewProviderLabel(p.label); setNewProviderWire(p.wire); setNewProviderBaseUrl(p.baseUrl ?? ''); setNewProviderApiKey(''); setProviderFormOpen(true); setError(null)
                    window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid="settings-provider-base-url-input"]')?.focus(), 0)
                  }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></Button> : null}
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
                      <span className="min-w-0 break-words">{m.label !== m.id ? <span className="block font-medium">{m.label}</span> : null}<code className="break-all" title={m.id}>{m.id}</code></span>
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
                        {dashboardManaged ? <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t('settings.models.editModelNamed', { model: m.id })} onClick={() => {
                          setEditingModel({ providerId: p.id, id: m.id }); setProviderId(p.id); setModelId(m.id); setLabel(m.label); setContextWindow(m.contextWindow?.toString() ?? ''); setError(null)
                          window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid="settings-model-context-window-input"]')?.focus(), 0)
                        }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></Button> : null}
                        {(m.source ?? p.source) === 'manual' ? (
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
