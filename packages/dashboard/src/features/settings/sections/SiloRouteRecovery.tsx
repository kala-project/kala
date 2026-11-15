import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { forcePwaRefresh } from '../../../lib/pwa.js'

export function isNativeConsolePath(pathname: string): boolean {
  return /^\/silo(?:\/|$)/u.test(pathname) || pathname === '/auth/silo/open'
}

export function SiloRouteRecovery({ standalone = false }: { standalone?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const reload = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      if (navigator.serviceWorker?.controller) {
        const href = isNativeConsolePath(window.location.pathname)
          ? new URL('/silo/', window.location.origin).href : window.location.href
        await forcePwaRefresh({ location: { href, replace: url => window.location.replace(url) } })
      } else {
        window.location.reload()
      }
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }
  const content = <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
    {standalone ? <h1 className="text-xl font-semibold">{t('unifiedSettings.silo.title')}</h1> : null}
    <div className="flex items-center gap-1"><p role="alert" className="text-sm">{t('unifiedSettings.silo.routeRecovery')}</p><HelpHint label={t('unifiedSettings.silo.title')}>{t('unifiedSettings.silo.recoveryHelp')}</HelpHint></div>
    <Button className="min-h-11" disabled={busy} onClick={() => { void reload() }}>{t('unifiedSettings.silo.reloadApplication')}</Button>
    {failed ? <p role="alert" className="text-sm text-destructive">{t('unifiedSettings.silo.recoveryFailed')}</p> : null}
  </div>
  return standalone ? <main className="mx-auto w-full max-w-xl p-4 pt-12">{content}</main> : content
}
