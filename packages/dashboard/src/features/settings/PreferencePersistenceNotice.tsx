import { useTranslation } from 'react-i18next'
import { usePreferencePersistenceFailure } from '../../lib/prefs.js'

export function PreferencePersistenceNotice(): JSX.Element | null {
  const { t } = useTranslation()
  return usePreferencePersistenceFailure()
    ? <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive" data-testid="settings-preference-error">{t('unifiedSettings.preferences.writeFailed')}</p>
    : null
}
