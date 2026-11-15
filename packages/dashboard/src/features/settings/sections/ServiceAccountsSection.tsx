import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button.js'

type Account = { id: string; name: string; scopes: readonly string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null }
type Limits = { scopes: readonly string[]; maxNameLength: number; defaultExpirationMs: number; maxExpirationMs: number }
type AccountPage = { items: Account[]; nextCursor?: string; limits: Limits }

const localDateTime = (time: number): string => {
  const date = new Date(time)
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function ServiceAccountsSection({ onInterruptionChange, onSaved }: { onInterruptionChange?(active: boolean): void; onSaved?(): void }): JSX.Element {
  const { t } = useTranslation()
  const [accounts, setAccounts] = useState<AccountPage>()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<readonly string[]>([])
  const [expiry, setExpiry] = useState('')
  const [issued, setIssued] = useState<(Account & { token: string })>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const load = async (cursor?: string): Promise<void> => {
    try {
      const response = await fetch(`/api/v1/service-accounts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const page = await response.json() as AccountPage
      if (active.current) { setAccounts(previous => cursor && previous ? { ...page, items: [...previous.items, ...page.items] } : page); setError(undefined) }
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false } }, [])
  useEffect(() => {
    onInterruptionChange?.(busy || Boolean(issued))
    return () => onInterruptionChange?.(false)
  }, [busy, issued, onInterruptionChange])
  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    let submitted = false, rejected = false
    try {
      const body = JSON.stringify({ name: name.trim(), scopes, ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}) })
      submitted = true
      const response = await fetch('/api/v1/service-accounts', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body })
      if (!response.ok) { rejected = response.status < 500; throw new Error(`HTTP ${response.status}`) }
      const result = await response.json() as Account & { token: string }
      if (!active.current) return
      setIssued(result); setName(''); setScopes([]); setExpiry('')
      onSaved?.()
      await load()
    } catch (reason) {
      if (active.current) setError(submitted && !rejected ? t('unifiedSettings.accounts.outcomeUnknown') : reason instanceof Error ? reason.message : String(reason))
    } finally { if (active.current) setBusy(false) }
  }
  const revoke = async (account: Account): Promise<void> => {
    if (busy || !window.confirm(t('unifiedSettings.accounts.confirmRevoke', { name: account.name }))) return
    setBusy(true)
    try {
      const response = await fetch(`/api/v1/service-accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!active.current) return
      if (issued?.id === account.id) setIssued(undefined)
      await load()
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (active.current) setBusy(false) }
  }
  return <section className="space-y-5">
    <h2 className="text-lg font-semibold">{t('unifiedSettings.accounts.title')}</h2>
    {error ? <p role="alert" className="break-words text-sm text-destructive">{error} <button type="button" className="underline" onClick={() => void load()}>{t('common.retry')}</button></p> : null}
    {!accounts ? <p role="status">{t('common.loading')}</p> : <>
      {issued ? <div className="space-y-3 rounded-md border border-amber-500 p-4" role="status">
        <p className="text-sm">{t('unifiedSettings.accounts.oneTime')}</p>
        <label className="grid gap-1 text-sm">{t('unifiedSettings.accounts.token')}<textarea readOnly value={issued.token} className="w-full break-all rounded border border-border/60 bg-background p-2 font-mono text-sm" /></label>
        <Button onClick={() => setIssued(undefined)}>{t('unifiedSettings.accounts.dismiss')}</Button>
      </div> : null}
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void create() }}>
        <label className="grid gap-1 text-sm">{t('unifiedSettings.accounts.name')}<input required maxLength={accounts.limits.maxNameLength} value={name} onChange={event => setName(event.target.value)} className="min-h-11 w-full rounded-md border border-border/60 bg-background px-3" /></label>
        <fieldset className="grid gap-2"><legend className="mb-2 text-sm">{t('unifiedSettings.accounts.scopes')}</legend>{accounts.limits.scopes.map(scope => <label key={scope} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(value => value !== scope))} />{scope}</label>)}</fieldset>
        <label className="grid gap-1 text-sm">{t('unifiedSettings.accounts.expiry')}<input type="datetime-local" value={expiry} min={localDateTime(Date.now())} max={localDateTime(Date.now() + accounts.limits.maxExpirationMs)} onChange={event => setExpiry(event.target.value)} className="min-h-11 min-w-0 rounded border border-border/60 bg-background px-3" /><span className="text-xs text-muted-foreground">{t('unifiedSettings.accounts.defaultExpiry', { days: accounts.limits.defaultExpirationMs / 86_400_000 })}</span></label>
        <Button type="submit" className="justify-self-start" disabled={busy || !name.trim() || !scopes.length || Boolean(issued)}>{t('unifiedSettings.accounts.create')}</Button>
      </form>
      <ul className="divide-y divide-border">{accounts.items.map(account => <li key={account.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0"><h3 className="break-words text-base">{account.name}</h3><p className="break-words text-sm text-muted-foreground">{account.scopes.join(', ')}</p><p className="text-xs text-muted-foreground">{account.expiresAt}{account.revokedAt ? ` · ${t('admin.revoked')}` : ''}</p></div><Button variant="destructive" disabled={busy || Boolean(account.revokedAt)} onClick={() => void revoke(account)}>{t('admin.revokeInvite')}</Button></li>)}</ul>
      {accounts.nextCursor ? <Button variant="outline" onClick={() => void load(accounts.nextCursor)}>{t('unifiedSettings.loadMore')}</Button> : null}
    </>}
  </section>
}
