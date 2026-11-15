import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { Button } from '../../../components/ui/button.js'
import { useSettingsRequest } from '../configuration-request.js'
import type { ConfigurationOutcome } from '../configuration-client.js'

type Endpoint = {
  organizationId: string; id: string; url: string; topics: string[]; enabled: boolean; revision: string; etag: string;
  secretBindingId: string | null; configurationError: string | null; deliveries?: Record<string, string>;
}
type Page = { organizationId: string; endpoints: Endpoint[]; topics: string[]; enabledCount: string; blocked: boolean; nextCursor?: string }
type Binding = { id: string; label: string; configured: boolean }
type Draft = { url: string; topics: string[]; enabled: boolean; secretBindingId: string }
const empty = (): Draft => ({ url: '', topics: [], enabled: false, secretBindingId: '' })
const fromEndpoint = (endpoint: Endpoint): Draft => ({
  url: endpoint.url, topics: [...endpoint.topics], enabled: endpoint.enabled, secretBindingId: endpoint.secretBindingId ?? '',
})

export function WebhooksSection({ organizationId, readOnly, onDirtyChange, onInterruptionChange }: {
  organizationId: string; readOnly: boolean; onDirtyChange?(dirty: boolean): void; onInterruptionChange?(active: boolean): void
}): JSX.Element {
  const { t } = useTranslation()
  const request = useSettingsRequest()
  const [page, setPage] = useState<Page>()
  const [bindings, setBindings] = useState<Binding[]>([])
  const [bindingCursor, setBindingCursor] = useState<string>()
  const [selected, setSelected] = useState<Endpoint>()
  const [draft, setDraft] = useState<Draft>(empty)
  const [outcome, setOutcome] = useState<ConfigurationOutcome>('idle')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const epoch = useRef(0), busy = useRef(false)
  const reading = useRef(false)
  const lifecycle = useRef<AbortController>()
  const callbacks = useRef({ onDirtyChange, onInterruptionChange })
  callbacks.current = { onDirtyChange, onInterruptionChange }
  const setDraftDirty = (value: boolean) => { setDirty(value); callbacks.current.onDirtyChange?.(value) }
  const current = (generation: number) => epoch.current === generation && !lifecycle.current?.signal.aborted
  const read = async (cursor?: string): Promise<boolean> => {
    if (reading.current) return false
    reading.current = true
    const generation = epoch.current
    setLoading(true)
    try {
      const init = { credentials: 'same-origin' as const, cache: 'no-store' as const, redirect: 'error' as const,
        signal: AbortSignal.any([lifecycle.current!.signal, AbortSignal.timeout(30_000)]) }
      const [endpoints, keys] = await Promise.all([
        request(`/organization/webhooks?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, init),
        request('/organization/webhook-secret-bindings', init),
      ])
      if (!endpoints.ok || !keys.ok) throw new Error(t('unifiedSettings.webhooks.unavailable'))
      const [next, available] = await Promise.all([endpoints.json() as Promise<Page>, keys.json() as Promise<{ organizationId: string; bindings: Binding[]; nextCursor?: string }>])
      if (next.organizationId !== organizationId || available.organizationId !== organizationId
        || !Array.isArray(next.endpoints) || next.endpoints.some(endpoint => endpoint.organizationId !== organizationId)
        || !Array.isArray(next.topics) || !Array.isArray(available.bindings)
        || !/^(?:0|[1-9]\d*)$/u.test(next.enabledCount)) throw new Error('webhook_identity_mismatch')
      if (!current(generation)) return false
      setPage(previous => cursor && previous ? { ...next, endpoints: [...previous.endpoints, ...next.endpoints] } : next)
      if (!cursor) { setBindings(available.bindings); setBindingCursor(available.nextCursor) }
      setError(undefined)
      return true
    } catch { if (current(generation)) setError(t('unifiedSettings.webhooks.unavailable')); return false }
    finally { if (current(generation)) { reading.current = false; setLoading(false) } }
  }
  useEffect(() => {
    ++epoch.current
    lifecycle.current = new AbortController()
    reading.current = false
    void read()
    return () => {
      ++epoch.current
      lifecycle.current?.abort()
      callbacks.current.onInterruptionChange?.(false)
    }
  }, [request, organizationId])
  const moreBindings = async () => {
    if (!bindingCursor || reading.current || busy.current) return
    reading.current = true
    const generation = epoch.current
    setLoading(true)
    try {
      const response = await request(`/organization/webhook-secret-bindings?cursor=${encodeURIComponent(bindingCursor)}`, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([lifecycle.current!.signal, AbortSignal.timeout(30_000)]),
      })
      if (!response.ok) throw new Error()
      const result = await response.json() as { organizationId: string; bindings: Binding[]; nextCursor?: string }
      if (result.organizationId !== organizationId || !Array.isArray(result.bindings)) throw new Error()
      if (current(generation)) { setBindings(previous => [...previous, ...result.bindings]); setBindingCursor(result.nextCursor) }
    } catch { if (current(generation)) setError(t('unifiedSettings.webhooks.unavailable')) }
    finally { if (current(generation)) { reading.current = false; setLoading(false) } }
  }
  const choose = (endpoint?: Endpoint) => {
    if (busy.current || reading.current || outcome !== 'idle' || dirty && !window.confirm(t('unifiedSettings.webhooks.discard'))) return
    setSelected(endpoint); setDraft(endpoint ? fromEndpoint(endpoint) : empty()); setDraftDirty(false); setError(undefined)
  }
  const reload = async () => {
    if (busy.current || reading.current || (dirty || outcome !== 'idle') && !window.confirm(t('unifiedSettings.webhooks.discard'))) return
    if (!await read()) return
    setSelected(undefined); setDraft(empty()); setDraftDirty(false); setOutcome('idle')
  }
  const change = (patch: Partial<Draft>) => { setDraft(value => ({ ...value, ...patch })); setDraftDirty(true) }
  const save = async () => {
    if (readOnly || reading.current || busy.current || outcome !== 'idle') return
    const generation = epoch.current
    busy.current = true
    setOutcome('saving'); setError(undefined); callbacks.current.onInterruptionChange?.(true)
    let response: Response | undefined
    try {
      const patch: Partial<Draft> = selected ? Object.fromEntries(
        Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(fromEndpoint(selected)[key as keyof Draft])),
      ) : draft
      if (!Object.keys(patch).length) { setOutcome('idle'); setDraftDirty(false); return }
      response = await request(selected ? `/organization/webhooks/${encodeURIComponent(selected.id)}` : '/organization/webhooks', {
        method: selected ? 'PATCH' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([lifecycle.current!.signal, AbortSignal.timeout(30_000)]),
        headers: { 'content-type': 'application/json', ...(selected ? { 'if-match': selected.etag } : {}) },
        body: JSON.stringify(patch),
      })
      if (!current(generation)) return
      if (!response.ok) {
        if (response.status === 412) { setOutcome('conflict'); return }
        if (response.status >= 500) { setOutcome('outcome-unknown'); return }
        setOutcome('idle')
        const code = (await response.json() as { error?: string }).error
        setError(t(code === 'webhook_endpoint_limit_exceeded' ? 'unifiedSettings.webhooks.limit'
          : code === 'webhook_destination_rejected' ? 'unifiedSettings.webhooks.destinationRejected' : 'unifiedSettings.webhooks.rejected'))
        return
      }
      const endpoint = await response.json() as Endpoint
      if (!current(generation)) return
      if (endpoint.organizationId !== organizationId || !endpoint.id || !/^[1-9]\d*$/u.test(endpoint.revision) || !/^"[\w-]{43}"$/u.test(endpoint.etag)
        || selected && selected.id !== endpoint.id) throw new Error('invalid_webhook_receipt')
      setSelected(endpoint); setDraft(fromEndpoint(endpoint)); setDraftDirty(false); setOutcome('idle')
      setPage(previous => previous ? {
        ...previous, enabledCount: (BigInt(previous.enabledCount) + (endpoint.enabled ? 1n : 0n) - (selected?.enabled ? 1n : 0n)).toString(),
        blocked: BigInt(previous.enabledCount) + (endpoint.enabled ? 1n : 0n) - (selected?.enabled ? 1n : 0n) > 100n,
        endpoints: selected ? previous.endpoints.map(row => row.id === endpoint.id ? { ...row, ...endpoint } : row) : [endpoint, ...previous.endpoints],
      } : previous)
    } catch {
      if (current(generation)) {
        const rejected = response && response.status < 500 && !response.ok
        setOutcome(rejected ? 'idle' : 'outcome-unknown')
        if (rejected) setError(t('unifiedSettings.webhooks.rejected'))
      }
    } finally {
      busy.current = false
      if (current(generation)) callbacks.current.onInterruptionChange?.(false)
    }
  }
  const topics = [...new Set([...(page?.topics ?? []), ...(selected?.topics ?? [])])]
  return <section className="space-y-5">
    <div className="flex items-center gap-1"><h2 className="text-lg font-semibold">{t('unifiedSettings.tabs.webhooks')}</h2><HelpHint label={t('unifiedSettings.tabs.webhooks')}>{t('unifiedSettings.webhooks.meaning')}</HelpHint></div>
    {outcome !== 'idle' ? <p role={outcome === 'saving' ? 'status' : 'alert'}>{t(`unifiedSettings.configuration.${outcome}`)}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <Button variant="outline" disabled={loading || outcome === 'saving'} onClick={() => void reload()}>{t('unifiedSettings.configuration.reload')}</Button>
    {!page ? loading ? <p role="status">{t('common.loading')}</p> : null : <>
      <p role="status">{t('unifiedSettings.webhooks.count', { count: page.enabledCount })}</p>
      {page.blocked ? <p role="alert">{t('unifiedSettings.webhooks.limit')}</p> : null}
      <Button variant="outline" disabled={readOnly || loading || outcome !== 'idle'} onClick={() => choose()}>{t('unifiedSettings.webhooks.create')}</Button>
      <form noValidate className="space-y-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <h3 className="font-semibold">{t(selected ? 'unifiedSettings.webhooks.edit' : 'unifiedSettings.webhooks.create')}</h3>
        <fieldset disabled={readOnly || loading || outcome === 'saving'} className="grid gap-4">
          <label className="grid gap-1">{t('unifiedSettings.webhooks.url')}<input type="url" required maxLength={4096} value={draft.url} onChange={event => change({ url: event.target.value })} className="min-h-11 w-full rounded border border-border/60 bg-background px-3" /></label>
          <label className="grid gap-1">{t('unifiedSettings.webhooks.binding')}<select value={draft.secretBindingId} required={!selected || draft.enabled} onChange={event => change({ secretBindingId: event.target.value })} className="min-h-11 min-w-0 rounded border border-border/60 bg-background px-3"><option value="">{t('unifiedSettings.webhooks.chooseBinding')}</option>{draft.secretBindingId && !bindings.some(binding => binding.id === draft.secretBindingId) ? <option value={draft.secretBindingId}>{t('unifiedSettings.webhooks.bindingUnknown')}</option> : null}{bindings.map(binding => <option key={binding.id} value={binding.id}>{binding.label}</option>)}</select></label>
          {bindingCursor ? <Button type="button" variant="outline" disabled={loading} onClick={() => void moreBindings()}>{t('unifiedSettings.webhooks.moreBindings')}</Button> : null}
          {!bindings.length ? <p role="status">{t('unifiedSettings.webhooks.noBindings')}</p> : null}
          <fieldset className="grid gap-2"><legend>{t('unifiedSettings.webhooks.topics')}</legend>{topics.map(topic => <label key={topic} className="flex min-h-10 items-center gap-2 break-all"><input type="checkbox" checked={draft.topics.includes(topic)} disabled={!page.topics.includes(topic) && !draft.topics.includes(topic)} onChange={event => change({ topics: event.target.checked ? [...draft.topics, topic] : draft.topics.filter(value => value !== topic) })} />{topic}{!page.topics.includes(topic) ? ` · ${t('unifiedSettings.webhooks.legacyTopic')}` : ''}</label>)}</fieldset>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={page.blocked && !draft.enabled} onChange={event => change({ enabled: event.target.checked })} />{t('unifiedSettings.webhooks.enabled')}</label>
        </fieldset>
        <Button type="submit" disabled={readOnly || loading || outcome !== 'idle' || !dirty || !selected && (!draft.url || !draft.topics.length || !draft.secretBindingId)}>{t('common.save')}</Button>
      </form>
      <ul className="divide-y divide-border">{page.endpoints.map(endpoint => <li key={endpoint.id} className="space-y-2 py-4">
        <h3 className="break-all font-medium">{endpoint.url}</h3>
        <p className="break-words text-sm">{endpoint.topics.join(', ')}</p>
        <p className="text-sm">{t(endpoint.enabled ? 'unifiedSettings.webhooks.enabled' : 'unifiedSettings.webhooks.disabled')} · {t('unifiedSettings.webhooks.revision', { revision: endpoint.revision })}</p>
        {endpoint.configurationError ? <p role="alert">{t('unifiedSettings.webhooks.bindingRepair')}</p> : null}
        <p className="text-xs text-muted-foreground">{Object.entries(endpoint.deliveries ?? {}).map(([state, count]) => `${state}: ${count}`).join(' · ') || t('unifiedSettings.webhooks.noDeliveries')}</p>
        <Button variant="outline" disabled={readOnly || loading || outcome !== 'idle'} onClick={() => choose(endpoint)}>{t('unifiedSettings.webhooks.edit')}</Button>
      </li>)}</ul>
      {page.nextCursor ? <Button variant="outline" disabled={loading || outcome === 'saving'} onClick={() => void read(page.nextCursor)}>{t('unifiedSettings.loadMore')}</Button> : null}
    </>}
  </section>
}
