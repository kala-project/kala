import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useState } from 'react'
import type { AccountOrganization, AccountProfile } from '../../auth-session.js'
import { Button } from '../../components/ui/button.js'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'

export type PublicBrowserSession = {
  id: string
  current: boolean
  device: { label: string }
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export function AccountCenter({ profile, organization, onClose }: { profile: AccountProfile; organization?: AccountOrganization; onClose(): void }): JSX.Element {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<PublicBrowserSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = async (): Promise<void> => {
    setLoading(true); setError(null)
    try {
      const response = await fetch('/auth/sessions', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(response.status === 401 ? t('account.expired') : t('account.loadFailed'))
      setSessions(((await response.json()) as { sessions: PublicBrowserSession[] }).sessions)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const revoke = async (session: PublicBrowserSession): Promise<void> => {
    const response = await fetch(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
    if (!response.ok) { setError(t('account.revokeFailed', { status: response.status })); return }
    if (session.current) { location.assign('/auth/login?prompt=login'); return }
    await load()
  }
  return (
    <ScrollArea className="fixed inset-0 z-[70] bg-background" data-testid="account-center" contentClassName="min-h-full">
      <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between bg-card/95 px-4 backdrop-blur">
        <div><h1 className="flex items-center gap-1 text-base font-semibold">{t('account.title')}<HelpHint label={t('account.title')}>{t('account.subtitle')}</HelpHint></h1></div>
        <Button type="button" variant="ghost" onClick={onClose} className="h-11" data-testid="account-center-close">{t('common.close')}</Button>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 px-4 py-6">
        <section className="rounded-lg bg-card/70 p-4 shadow-sm"><h2 className="font-semibold">{t('account.profile')}</h2><div className="mt-3 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-primary/15 font-semibold text-primary">{profile.initials}</span><div><div className="font-medium">{profile.displayName}</div>{profile.email ? <div className="text-sm text-muted-foreground">{profile.email}</div> : null}{organization ? <div className="mt-1 text-xs text-muted-foreground">{organization.name} · {organization.role}</div> : null}</div></div><p className="mt-3 text-xs text-muted-foreground">{t('account.identityManaged')}</p></section>
        <section className="rounded-lg border border-border/50 p-4"><h2 className="font-semibold">{t('account.devices')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('account.devicesDescription')}</p>{loading ? <div className="mt-4 text-sm text-muted-foreground" role="status">{t('account.loading')}</div> : error ? <div className="mt-4 text-sm text-destructive" role="alert">{error} <button type="button" onClick={() => void load()} className="underline">{t('account.retry')}</button></div> : <div className="mt-4 grid gap-2" data-testid="account-session-list">{sessions.map((session) => <div key={session.id} className="flex items-start justify-between gap-3 rounded-md bg-muted/30 p-3" data-testid={`account-session-${session.id}`}><div><div className="text-sm font-medium">{session.device.label}{session.current ? ` · ${t('account.currentDevice')}` : ''}</div><div className="mt-1 text-xs text-muted-foreground">{t('account.activity', { last: new Date(session.lastSeenAt).toLocaleString(), expires: new Date(session.expiresAt).toLocaleString() })}</div></div><button type="button" onClick={() => void revoke(session)} className="min-h-10 rounded border border-border/50 px-3 text-xs text-destructive hover:bg-destructive/10">{t('account.signOut')}</button></div>)}</div>}</section>
        <section className="rounded-lg border border-border/50 p-4"><h2 className="font-semibold">{t('account.productLegal')}</h2><div className="mt-3 flex flex-wrap gap-3 text-sm"><a href="#/docs" className="text-primary underline">{t('account.help')}</a><a href="/privacy" className="text-primary underline">{t('account.privacy')}</a><a href="/terms" className="text-primary underline">{t('account.terms')}</a></div></section>
        <section className="rounded-lg border border-destructive/40 p-4"><h2 className="font-semibold">{t('account.signOutEverywhere')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('account.signOutEverywhereDescription')}</p><form method="post" action="/auth/logout-all" onSubmit={() => { setTimeout(() => location.replace('/signed-out'), 0) }} className="mt-3"><button type="submit" className="min-h-11 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground">{t('account.signOutAll')}</button></form></section>
      </main>
    </ScrollArea>
  )
}
