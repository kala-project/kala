import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import { CopyButton, EmptyRow, SectionHeader, SettingsRecord, SettingsRecordField, SettingsRecordList } from '../controls.js'

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
      {!platform ? <details className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-xs">
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
