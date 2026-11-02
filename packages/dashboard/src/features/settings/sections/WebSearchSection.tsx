import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { SectionHeader } from '../controls.js'
import { responseError } from '../section-utils.js'

type WebSearchSettings = {
  configured: boolean
  provider: string
  updatedAt?: string
}

export function WebSearchSection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<WebSearchSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch('/settings/web-search', { cache: 'no-store' })
        if (!response.ok) throw new Error(await responseError(response))
        const next = (await response.json()) as WebSearchSettings
        if (!cancelled) setSettings(next)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!apiKey.trim()) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/web-search', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'serper', apiKey: apiKey.trim() }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      setSettings({ configured: true, provider: 'serper' })
      setApiKey('')
      setMessage(t('settings.webSearch.saved'))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/web-search/test', { method: 'POST' })
      if (!response.ok) throw new Error(await responseError(response))
      setMessage(t('settings.webSearch.testSucceeded'))
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/web-search', { method: 'DELETE' })
      if (!response.ok) throw new Error(await responseError(response))
      setSettings({ configured: false, provider: 'serper' })
      setApiKey('')
      setMessage(t('settings.webSearch.removed'))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="settings-web-search-section">
      <SectionHeader title={t('settings.sections.webSearch.label')} subtitle={t('settings.webSearch.subtitle')} />
      {loading ? (
        <div className="text-sm text-muted-foreground" role="status">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-border/50 bg-card/60 px-4 py-3 text-sm">
            <div className="font-medium">{t('settings.webSearch.status')}</div>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="settings-web-search-status">
              {settings?.configured ? t('settings.webSearch.configured') : t('settings.webSearch.notConfigured')}
              {settings?.updatedAt
                ? ` · ${t('settings.webSearch.updatedAt', { date: new Date(settings.updatedAt).toLocaleString(i18n.language) })}`
                : ''}
            </p>
          </div>

          <form className="space-y-4 rounded-md border border-border/50 bg-card/60 p-4" onSubmit={(event) => { void save(event) }}>
            <label className="block text-sm font-medium" htmlFor="settings-web-search-provider">
              {t('settings.webSearch.provider')}
            </label>
            <select id="settings-web-search-provider" className="h-9 w-full rounded-md border border-border/50 px-3 text-sm" value="serper" disabled>
              <option value="serper">Serper</option>
            </select>

            <div className="flex items-center gap-1 text-sm font-medium">
              <label htmlFor="settings-web-search-api-key">{t('settings.webSearch.apiKey')}</label>
              <HelpHint label={t('settings.webSearch.apiKey')}>{t('settings.webSearch.apiKeyHint')}</HelpHint>
            </div>
            <input
              id="settings-web-search-api-key"
              data-testid="settings-web-search-api-key"
              type="password"
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-border/50 px-3 text-sm"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={settings?.configured ? t('settings.webSearch.apiKeyConfiguredPlaceholder') : t('settings.webSearch.apiKeyPlaceholder')}
            />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !apiKey.trim()} data-testid="settings-web-search-save">
                {t('common.save')}
              </Button>
              <Button type="button" variant="outline" disabled={busy || !settings?.configured} onClick={() => { void testConnection() }} data-testid="settings-web-search-test">
                {t('settings.webSearch.test')}
              </Button>
              {settings?.configured ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => { void remove() }} data-testid="settings-web-search-delete">
                  {t('settings.webSearch.remove')}
                </Button>
              ) : null}
            </div>
          </form>

          {error ? <p className="text-sm text-destructive" role="alert">{t('settings.webSearch.requestFailed', { error })}</p> : null}
          {message ? <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">{message}</p> : null}
        </div>
      )}
    </div>
  )
}
