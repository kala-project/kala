import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { ConfigurationSourceObservation } from '@agent-kernel/shared'
import { HelpHint } from '../../components/ui/help-hint.js'
import { CopyButton, SettingsRecordField } from './controls.js'
import { Button } from '../../components/ui/button.js'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'

export function DeploymentConfiguration({ sources }: { sources?: readonly ConfigurationSourceObservation[] }): JSX.Element {
  const { t } = useTranslation()
  const [maintenance, setMaintenance] = useState<ConfigurationSourceObservation>()
  const command = (maintenance: ConfigurationSourceObservation['maintenance']): string | undefined =>
    maintenance === 'portable-model-import' ? 'kala-settings-file import --resource models --input <protected-file>'
      : maintenance === 'portable-agent-import' ? 'kala-settings-file import --resource agent --input <protected-file>'
        : maintenance === 'runtime-operator' ? "kala-control-plane-settings inspect --profile '<protected-profile>' --organization '<organization-id>' --resource 'model-management/<organization-id>'"
          : undefined
  return <section className="space-y-4">
    <div className="flex items-center gap-1"><h2 className="text-lg font-semibold">{t('unifiedSettings.navigation.configuration')}</h2><HelpHint label={t('unifiedSettings.navigation.configuration')}>{t('unifiedSettings.configurationSources.description')}</HelpHint></div>
    {!sources?.length ? <p role="status">{t('unifiedSettings.configurationSources.unavailable')}</p> : sources.map(source => <article key={source.id} className="space-y-2 rounded border border-border/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t(`unifiedSettings.configurationSources.resources.${source.id}`)}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs">{t(`unifiedSettings.configurationSources.${source.management}`)}</span></div>
      <dl className="grid gap-x-6 gap-y-3 py-3 text-sm sm:grid-cols-2">
        <SettingsRecordField label={t('unifiedSettings.configurationSources.source')} mono>{source.sourceRef}</SettingsRecordField>
        <SettingsRecordField label={t('unifiedSettings.configurationSources.desired')}>{source.revision ?? t('unifiedSettings.configurationSources.unknown')}</SettingsRecordField>
        <SettingsRecordField label={t('unifiedSettings.configurationSources.effective')}>{source.effectiveRevision ?? t('unifiedSettings.configurationSources.unknown')}</SettingsRecordField>
        <SettingsRecordField label={t('unifiedSettings.configurationSources.observed')}><time dateTime={source.observedAt}>{new Date(source.observedAt).toLocaleString()}</time></SettingsRecordField>
      </dl>
      {command(source.maintenance) ? <Button variant="outline" onClick={() => setMaintenance(source)}>{t('unifiedSettings.configurationSources.maintenance')}</Button> : null}
    </article>)}
    <Dialog open={Boolean(maintenance)} onOpenChange={open => { if (!open) setMaintenance(undefined) }}>
      <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{t('unifiedSettings.configurationSources.maintenance')}</DialogTitle><DialogDescription>{t('unifiedSettings.configurationSources.stopped')}</DialogDescription></DialogHeader>
        {maintenance ? <div className="flex min-w-0 items-start gap-2 rounded-lg bg-muted p-4"><code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-sm">{command(maintenance.maintenance)}</code><CopyButton value={command(maintenance.maintenance)!} /></div> : null}
      </DialogContent>
    </Dialog>
  </section>
}
