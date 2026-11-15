import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { getStoredHostEndpoint, resolveHostEndpoint, setStoredHostEndpoint } from '../../../host-endpoint.js'
import { SectionHeader } from '../controls.js'
import { isDesktopClient } from '../../../lib/desktop.js'
import { DesktopUpdateSettings } from '../../../app-shell/DesktopUpdate.js'
import { useSettingsRequest } from '../configuration-request.js'

export function ConnectionSection({ hosted = false }: { hosted?: boolean } = {}): JSX.Element {
  const { t } = useTranslation()
  const request = useSettingsRequest()
  const [current, setCurrent] = useState(() => resolveHostEndpoint())
  const [draft, setDraft] = useState<string>(() => getStoredHostEndpoint() ?? '')
  const [testState, setTestState] = useState<{ kind: 'idle' | 'testing' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' })

  useEffect(() => {
    const refresh = () => setCurrent(resolveHostEndpoint())
    window.addEventListener('agent-kernel:host-endpoint-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('agent-kernel:host-endpoint-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const sourceLabel: Record<typeof current.source, string> = {
    query: t('settings.connection.sources.query'),
    settings: t('settings.connection.sources.settings'),
    build: t('settings.connection.sources.build'),
    default: t('settings.connection.sources.default'),
  }
  const crossOrigin = [current.url, draft.trim()].some((value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && url.origin !== window.location.origin
    } catch (error) {
      if (error instanceof TypeError) return false
      throw error
    }
  })
  const crossOriginHelp = <>{t('settings.connection.crossOriginPrefix')}{' '}<code className="rounded bg-muted px-1">KALA_PUBLIC_URLS</code>.</>

  const save = () => {
    if (hosted && draft.trim()) {
      try {
        const target = new URL(draft.trim())
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid target Origin')
        if (target.origin !== window.location.origin) {
          window.location.assign(`${target.origin}/#/settings/personal/connection`)
          return
        }
      } catch {
        setTestState({ kind: 'error', msg: t('unifiedSettings.connection.invalidOrigin') })
        return
      }
    }
    setTestState(setStoredHostEndpoint(draft.trim() === '' ? null : draft.trim()) ? { kind: 'idle' } : { kind: 'error', msg: t('unifiedSettings.preferences.writeFailed') })
  }
  const reset = () => {
    if (setStoredHostEndpoint(null)) {
      setDraft('')
      setTestState({ kind: 'idle' })
    } else setTestState({ kind: 'error', msg: t('unifiedSettings.preferences.writeFailed') })
  }
  const test = async () => {
    const target = hosted ? window.location.origin : (draft.trim() || current.url).replace(/\/+$/, '')
    setTestState({ kind: 'testing' })
    try {
      const probe = hosted || target === current.url ? request : fetch
      const res = await probe(`${target}/models`, { method: 'GET', credentials: hosted ? 'same-origin' : 'omit', cache: 'no-store' })
      if (!res.ok) {
        setTestState({ kind: 'error', msg: `HTTP ${res.status}` })
        return
      }
      setTestState({ kind: 'ok', msg: t('settings.connection.reachable') })
    } catch (err) {
      setTestState({ kind: 'error', msg: err instanceof Error ? err.message : t('settings.connection.unreachable') })
    }
  }

  if (isDesktopClient()) {
    return (
      <div className="space-y-4">
        <SectionHeader title={t('settings.connection.title')} subtitle={`${t('settings.connection.subtitle')} ${t('common.desktopConnectionHelp')}`} />
        <p className="break-all font-mono text-sm">{current.url}</p>
        <DesktopUpdateSettings />
      </div>
    )
  }

  return (
    <div className="space-y-5 md:space-y-6">
      <SectionHeader title={t('settings.connection.title')} subtitle={`${t('settings.connection.subtitle')} ${t('settings.connection.priority')}${hosted ? ` ${t('unifiedSettings.connection.hosted')}` : ''}`} />

      <div className="space-y-2.5 rounded-xl bg-card/60 p-4 text-sm ring-1 ring-border/50 md:space-y-3 md:rounded-md">
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="uppercase tracking-wider">{t('settings.connection.current')}</span><span>{t('settings.connection.source', { source: sourceLabel[current.source] })}</span></div>
          <div className="mt-1 break-all font-mono">{current.url || t('settings.connection.none')}</div>
        </div>
      </div>

      <div className="space-y-3 rounded-xl bg-card/30 p-4 ring-1 ring-border/40 md:rounded-none md:bg-transparent md:p-0 md:ring-0">
        <div className="flex items-center gap-1 text-sm font-medium"><label htmlFor="settings-connection-endpoint">{t('settings.connection.override')}</label><HelpHint label={t('settings.connection.override')}>{crossOriginHelp}</HelpHint></div>
        <input
          id="settings-connection-endpoint"
          type="url"
          data-testid="settings-connection-endpoint"
          className="h-11 w-full rounded-lg border border-input bg-background px-3 font-mono text-base outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring md:h-auto md:rounded-md md:py-2 md:text-sm"
          placeholder={window.location.origin}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {crossOrigin ? <div className="text-xs text-muted-foreground" data-description-kind="notice">{crossOriginHelp}</div> : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button data-testid="settings-connection-save" className="h-10 rounded-lg px-5 md:h-7 md:rounded md:px-2" onClick={save}>{t('common.save')}</Button>
          <Button data-testid="settings-connection-test" variant="outline" className="h-10 rounded-lg px-4 md:h-7 md:rounded md:px-2" onClick={() => void test()} disabled={testState.kind === 'testing'}>
            {testState.kind === 'testing' ? t('settings.connection.testing') : t('settings.connection.test')}
          </Button>
          <Button data-testid="settings-connection-reset" variant="ghost" className="h-10 rounded-lg px-3 text-muted-foreground md:h-7 md:rounded md:px-2" onClick={reset}>{t('settings.connection.reset')}</Button>
        </div>
        {testState.kind === 'ok' && (
          <div className="text-xs text-emerald-500" data-testid="settings-connection-result">✓ {testState.msg}</div>
        )}
        {testState.kind === 'error' && (
          <div className="text-xs text-red-500" data-testid="settings-connection-result" role="alert">✗ {testState.msg}</div>
        )}
      </div>
    </div>
  )
}
