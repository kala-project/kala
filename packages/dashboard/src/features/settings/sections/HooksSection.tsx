import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import { CopyButton, EmptyRow, SectionHeader, SettingsKeyValueList, SettingsRecord, SettingsRecordField, SettingsRecordList } from '../controls.js'
import { HelpHint } from '../../../components/ui/help-hint.js'

export function HooksSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const { t } = useTranslation()
  const platform = payload.deployment?.deployment.architecture === 'platform'
  return (
    <div>
      <SectionHeader
        descriptionKind="notice"
        title={t('settings.sections.hooks.label')}
        subtitle={t(platform ? 'settings.hooks.externallyManaged' : 'settings.hooks.subtitle')}
      />
      {payload.hooksSummary ? <div className="space-y-3 text-sm">
        <div className="flex items-center gap-1"><span className="rounded-full bg-muted px-2 py-1 text-xs">{payload.hooksSummary.loadState}</span><HelpHint label={t('settings.sections.hooks.label')}>{t('unifiedSettings.hooksManaged')}</HelpHint></div>
        <ul className="flex flex-wrap gap-2">{payload.hooksSummary.events.map((event, index) => <li key={`${event}:${index}`} className="rounded-lg border border-border/50 bg-card/60 px-3 py-2 font-mono text-xs">{event}</li>)}</ul>
        <SettingsKeyValueList rows={[
          { label: t('unifiedSettings.configurationSources.source'), value: <code className="break-all">{payload.hooksSummary.sourceRef}</code> },
          { label: t('unifiedSettings.workspaceUi.revision'), value: payload.hooksSummary.version ?? t('unifiedSettings.hooksUnversioned') },
          { label: t('unifiedSettings.configurationSources.observed'), value: payload.hooksSummary.loadedAt ? new Date(payload.hooksSummary.loadedAt).toLocaleString() : '—' },
        ]} />
      </div> : null}
      {!payload.hooksSummary ? <>
      {payload.hooks.length === 0 ? (
        <EmptyRow>
          {t(platform ? 'settings.hooks.noneManaged' : 'settings.hooks.none', { path: payload.paths.hooksConfig })}
        </EmptyRow>
      ) : (
        <SettingsRecordList testId="settings-hooks-list">
          {payload.hooks.map((hook, index) => (
            <SettingsRecord key={`${hook.event}-${index}`} title={hook.event}>
              <SettingsRecordField label={t('settings.hooks.match')} mono>{hook.match ?? '*'}</SettingsRecordField>
              <SettingsRecordField label={t('settings.hooks.command')}>
                <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
                  <span className="min-w-0 flex-1 break-all" title={hook.command}>{hook.command}</span>
                  <CopyButton value={hook.command} />
                </div>
              </SettingsRecordField>
            </SettingsRecord>
          ))}
        </SettingsRecordList>
      )}
      </> : null}
      {!platform ? <details className="mt-4 rounded-md border border-border/50 bg-muted/30 p-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t('settings.hooks.example')}</summary>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-caption text-foreground">
{`[[hooks]]
event = "pre_tool_use"
match = "bash"
command = "/usr/local/bin/lint-shell.sh"`}
        </pre>
      </details> : null}
    </div>
  )
}
