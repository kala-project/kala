import { useTranslation } from 'react-i18next'
import type { ConfigurationRead, SettingsSectionValue } from '@agent-kernel/shared'
import { HelpHint } from '../../components/ui/help-hint.js'
import { CopyButton } from './controls.js'

export function ConfigurationApplication({ application }: {
  application: ConfigurationRead<SettingsSectionValue>['application'];
}): JSX.Element {
  const { t } = useTranslation()
  return <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
    <span role="status" className={`rounded-full px-2.5 py-1 text-xs font-medium ${application.state === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground'}`}>{t(`unifiedSettings.configuration.application.${application.state}`)}</span>
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <div className="flex gap-2"><dt className="text-muted-foreground">{t('unifiedSettings.configurationSources.desired')}</dt><dd className="font-mono">{application.desiredRevision}</dd></div>
      <div className="flex gap-2"><dt className="text-muted-foreground">{t('unifiedSettings.configurationSources.effective')}</dt><dd className="font-mono">{application.effectiveRevision ?? '—'}</dd></div>
    </dl>
    <div className="ml-auto flex items-center">
      <HelpHint label={t('unifiedSettings.configuration.applicationDetails')}>{t('unifiedSettings.configuration.servingScope')} {t('unifiedSettings.configuration.loadedSessionScope')}</HelpHint>
      <CopyButton value={JSON.stringify(application, null, 2)} label={t('unifiedSettings.copyDiagnostics')} />
    </div>
  </div>
}
