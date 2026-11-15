import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button.js'
import { Input } from '../../../components/ui/input.js'
import { CopyButton, SectionHeader } from '../controls.js'
import { useSettingsRequest } from '../configuration-request.js'

type Credentials = { username: string; password: string }

export function SiloSection({ enabled, credentialsAvailable = false }: {
  enabled: boolean
  credentialsAvailable?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const request = useSettingsRequest()
  const [credentials, setCredentials] = useState<Credentials>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const pending = useRef<AbortController>()
  const allowed = enabled && credentialsAvailable

  function hide(): void {
    pending.current?.abort()
    setCredentials(undefined)
    setLoading(false)
    setError(false)
  }
  useEffect(() => {
    hide()
    const conceal = (): void => { if (document.visibilityState === 'hidden') hide() }
    document.addEventListener('visibilitychange', conceal)
    return () => {
      pending.current?.abort()
      document.removeEventListener('visibilitychange', conceal)
    }
  }, [enabled, credentialsAvailable])

  async function show(): Promise<void> {
    if (!allowed || loading) return
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError(false)
    try {
      const response = await request('/auth/silo/credentials', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error('Storage credentials unavailable')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('username' in result) || !('password' in result) ||
          typeof result.username !== 'string' || !result.username || typeof result.password !== 'string' || !result.password) {
        throw new Error('Invalid storage credentials')
      }
      if (!controller.signal.aborted) setCredentials({ username: result.username, password: result.password })
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  return <section className="min-w-0" data-testid="settings-silo">
    <SectionHeader title={t('unifiedSettings.silo.title')} subtitle={t('unifiedSettings.silo.scope')} />
    {enabled ? <div className="grid min-w-0 gap-5 rounded-xl bg-card/65 p-4 ring-1 ring-border/40 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('unifiedSettings.silo.loginHelp')}</p>
        <Button asChild className="min-h-11"><a href="/auth/silo/open" target="_blank" rel="noopener noreferrer" data-testid="settings-open-silo">
          {t('unifiedSettings.silo.open')}<ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
        </a></Button>
      </div>
      <div className="grid min-w-0 gap-3 border-t border-border/50 pt-4" data-testid="settings-storage-login">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">{t('unifiedSettings.silo.credentials')}</h3>
          {allowed ? <Button type="button" variant="outline" className="min-h-11" disabled={loading} onClick={() => { if (credentials) hide(); else void show() }}>
            {t(loading ? 'common.loading' : credentials ? 'unifiedSettings.silo.hideCredentials' : 'unifiedSettings.silo.showCredentials')}
          </Button> : null}
        </div>
        <p className="text-sm text-muted-foreground">{t(allowed ? 'unifiedSettings.silo.credentialWarning' : 'unifiedSettings.silo.credentialsNotConfigured')}</p>
        {error ? <p role="alert" className="text-sm text-destructive">{t('unifiedSettings.silo.credentialsFailed')}</p> : null}
        {allowed && credentials ? <div className="grid min-w-0 gap-3">
          {(['username', 'password'] as const).map(field => <div key={field} className="grid min-w-0 gap-1.5">
            <label htmlFor={`storage-login-${field}`} className="text-sm font-medium">{t(`unifiedSettings.silo.${field}`)}</label>
            <div className="flex min-w-0 items-center gap-2">
              <Input id={`storage-login-${field}`} className="min-w-0 flex-1 font-mono" readOnly autoComplete="off" spellCheck={false} value={credentials[field]} />
              <CopyButton value={credentials[field]} label={t(`unifiedSettings.silo.copy${field === 'username' ? 'Username' : 'Password'}`)} />
            </div>
          </div>)}
        </div> : null}
      </div>
    </div> : <p role="status" className="text-sm text-muted-foreground">{t('unifiedSettings.silo.source')}</p>}
  </section>
}
