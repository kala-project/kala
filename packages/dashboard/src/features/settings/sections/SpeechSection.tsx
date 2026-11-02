import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import {
  DEFAULT_AZURE_SPEECH_ENDPOINT,
  DEFAULT_SPEECH_MAX_MINUTES,
  MAX_SPEECH_MAX_MINUTES,
  loadSpeechSettings,
  speechMaxMinutes,
  SPEECH_SETTINGS_CHANGED_EVENT,
  type SpeechTranscriptionMode,
  type SpeechSettings,
} from '../../voice/speech-api.js'
import { SectionHeader, Toggle } from '../controls.js'
import { responseError } from '../section-utils.js'

export function SpeechSection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<SpeechSettings | null>(null)
  const [endpoint, setEndpoint] = useState(DEFAULT_AZURE_SPEECH_ENDPOINT)
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState<SpeechTranscriptionMode>('realtime')
  const [realtimeMaxMinutes, setRealtimeMaxMinutes] = useState(DEFAULT_SPEECH_MAX_MINUTES)
  const [afterRecordingMaxMinutes, setAfterRecordingMaxMinutes] = useState(DEFAULT_SPEECH_MAX_MINUTES)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSpeechSettings().then((next) => {
      if (cancelled) return
      setSettings(next)
      setEndpoint(next.endpoint)
      setEnabled(next.configured ? next.enabled : true)
      setMode(next.mode)
      setRealtimeMaxMinutes(speechMaxMinutes(next.realtimeMaxMinutes))
      setAfterRecordingMaxMinutes(speechMaxMinutes(next.afterRecordingMaxMinutes))
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if ((!settings?.configured && !apiKey.trim()) || !validMaxMinutes(realtimeMaxMinutes) || !validMaxMinutes(afterRecordingMaxMinutes)) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/speech', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: endpoint.trim(),
          enabled,
          mode,
          realtimeMaxMinutes,
          afterRecordingMaxMinutes,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const next = (await response.json()) as SpeechSettings
      setSettings(next)
      setEndpoint(next.endpoint)
      setRealtimeMaxMinutes(speechMaxMinutes(next.realtimeMaxMinutes))
      setAfterRecordingMaxMinutes(speechMaxMinutes(next.afterRecordingMaxMinutes))
      setApiKey('')
      setMessage(t('settings.speech.saved'))
      window.dispatchEvent(new Event(SPEECH_SETTINGS_CHANGED_EVENT))
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
      const response = await fetch('/settings/speech/test', { method: 'POST' })
      if (!response.ok) throw new Error(await responseError(response))
      setMessage(t('settings.speech.testSucceeded'))
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
      const response = await fetch('/settings/speech', { method: 'DELETE' })
      if (!response.ok) throw new Error(await responseError(response))
      const next = (await response.json()) as SpeechSettings
      setSettings(next)
      setEndpoint(next.endpoint)
      setEnabled(true)
      setMode('realtime')
      setRealtimeMaxMinutes(DEFAULT_SPEECH_MAX_MINUTES)
      setAfterRecordingMaxMinutes(DEFAULT_SPEECH_MAX_MINUTES)
      setApiKey('')
      setMessage(t('settings.speech.removed'))
      window.dispatchEvent(new Event(SPEECH_SETTINGS_CHANGED_EVENT))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="settings-speech-section">
      <SectionHeader title={t('settings.sections.speech.label')} subtitle={t('settings.speech.info')} />
      {loading ? (
        <div className="text-sm text-muted-foreground" role="status">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-border/60 bg-card/60 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{t('settings.speech.status')}</div>
                <p className="mt-1 text-xs text-muted-foreground" data-testid="settings-speech-status">
                  {!isSecureVoiceContext()
                    ? t('settings.speech.insecureStatus')
                    : settings?.configured ? t('settings.speech.configured') : t('settings.speech.notConfigured')}
                  {isSecureVoiceContext() && settings?.updatedAt
                    ? ` · ${t('settings.speech.updatedAt', { date: new Date(settings.updatedAt).toLocaleString(i18n.language) })}`
                    : ''}
                </p>
                {!isSecureVoiceContext() ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="settings-speech-https-required">
                    {t('settings.speech.insecureDetail')}
                  </p>
                ) : null}
              </div>
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                ariaLabel={t('settings.speech.enable')}
                testId="settings-speech-enabled"
              />
            </div>
          </div>

          <form className="space-y-4 rounded-xl border border-border/60 bg-card/60 p-4" onSubmit={(event) => { void save(event) }}>
            <label className="block text-sm font-medium" htmlFor="settings-speech-provider">
              {t('settings.speech.provider')}
            </label>
            <select id="settings-speech-provider" className="h-9 w-full rounded-md border border-border/50 px-3 text-sm" value="azure" disabled>
              <option value="azure">Azure Speech</option>
            </select>

            <label className="flex items-center gap-1 text-sm font-medium" htmlFor="settings-speech-mode">
              {t('settings.speech.mode')}
              <HelpHint label={t('settings.speech.mode')}>{t('settings.speech.modeInfo')}</HelpHint>
            </label>
            <select
              id="settings-speech-mode"
              data-testid="settings-speech-mode"
              className="h-9 w-full rounded-md border border-border/50 px-3 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as SpeechTranscriptionMode)}
            >
              <option value="realtime">{t('settings.speech.modeRealtime')}</option>
              <option value="after_recording">{t('settings.speech.modeAfterRecording')}</option>
            </select>

            <div className="grid gap-3 sm:grid-cols-2">
              {([
                ['realtimeMaxMinutes', realtimeMaxMinutes, setRealtimeMaxMinutes],
                ['afterRecordingMaxMinutes', afterRecordingMaxMinutes, setAfterRecordingMaxMinutes],
              ] as const).map(([key, value, setValue]) => (
                <div key={key}>
                  <div className="flex items-center gap-1 text-sm font-medium">
                    <label htmlFor={`settings-speech-${key}`}>{t(`settings.speech.${key}`)}</label>
                    <HelpHint label={t(`settings.speech.${key}`)}>{t('settings.speech.maxMinutesInfo')}</HelpHint>
                  </div>
                  <input id={`settings-speech-${key}`} data-testid={`settings-speech-${key}`} type="number" min="1" max={MAX_SPEECH_MAX_MINUTES} step="1" required
                    className="mt-1 h-9 w-full rounded-md border border-border/50 px-3 text-sm" value={value}
                    onChange={(event) => setValue(event.target.value === '' ? 0 : Number(event.target.value))} />
                </div>
              ))}
            </div>

            <label className="flex items-center gap-1 text-sm font-medium" htmlFor="settings-speech-endpoint">
              {t('settings.speech.endpoint')}
              <HelpHint label={t('settings.speech.endpoint')}>{t('settings.speech.endpointHint')}</HelpHint>
            </label>
            <input
              id="settings-speech-endpoint"
              data-testid="settings-speech-endpoint"
              type="url"
              spellCheck={false}
              className="h-9 w-full rounded-md border border-border/50 px-3 font-mono text-sm"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />

            <label className="flex items-center gap-1 text-sm font-medium" htmlFor="settings-speech-api-key">
              {t('settings.speech.apiKey')}
              <HelpHint label={t('settings.speech.apiKey')}>{t('settings.speech.apiKeyHint')}</HelpHint>
            </label>
            <input
              id="settings-speech-api-key"
              data-testid="settings-speech-api-key"
              type="password"
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-border/50 px-3 text-sm"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={settings?.configured ? t('settings.speech.apiKeyConfiguredPlaceholder') : t('settings.speech.apiKeyPlaceholder')}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !endpoint.trim() || !validMaxMinutes(realtimeMaxMinutes) || !validMaxMinutes(afterRecordingMaxMinutes) || (!settings?.configured && !apiKey.trim())} data-testid="settings-speech-save">
                {t('common.save')}
              </Button>
              <Button type="button" variant="outline" disabled={busy || !settings?.configured} onClick={() => { void testConnection() }} data-testid="settings-speech-test">
                {t('settings.speech.test')}
              </Button>
              {settings?.configured ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => { void remove() }} data-testid="settings-speech-delete">
                  {t('settings.speech.remove')}
                </Button>
              ) : null}
            </div>
          </form>

          {error ? <p className="text-sm text-destructive" role="alert">{t('settings.speech.requestFailed', { error })}</p> : null}
          {message ? <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">{message}</p> : null}
        </div>
      )}
    </div>
  )
}

function validMaxMinutes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SPEECH_MAX_MINUTES
}

function isSecureVoiceContext(): boolean {
  return typeof window === 'undefined' || window.isSecureContext !== false
}
