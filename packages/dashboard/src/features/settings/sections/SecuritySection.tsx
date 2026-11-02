import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import { SectionHeader, SettingsKeyValueList } from '../controls.js'

export function SecuritySection({ payload }: { payload: ServerSettingsPayload }): JSX.Element {
  const { t } = useTranslation()
  const auth = payload.auth
  const platform = payload.deployment?.deployment.architecture === 'platform'
  const inviteCount = auth?.executorIdentity.inviteCount ?? 0
  const providerRows: Array<[string, string]> = platform
    ? [[t('settings.security.gatewayAuth'), t('settings.security.gatewayIdentity')]]
    : auth ? [
      [t('settings.security.githubOAuth'), auth.githubOAuth.required ? (auth.githubOAuth.configured ? t('settings.security.requiredConfigured') : t('settings.security.requiredIncomplete')) : t('settings.security.disabled')],
      [t('settings.security.githubWhitelist'), auth.githubOAuth.usernameWhitelistEnabled ? auth.githubOAuth.usernameWhitelist.join(', ') : t('settings.security.disabled')],
    ] : []
  const rows: Array<[string, string]> = auth
    ? [
        [t('settings.security.dashboardAuth'), auth.dashboardAuthRequired ? t('settings.security.required') : t('settings.security.notRequired')],
        ...providerRows,
        [t('settings.security.executorIdentity'), auth.executorIdentity.tokenScoped ? t('settings.security.tokenScoped', { count: auth.executorIdentity.tokenCount }) : auth.executorIdentity.tokenCount > 0 ? t('settings.security.tokenProtected', { count: auth.executorIdentity.tokenCount }) : t('settings.security.inviteReady')],
        [t('settings.security.executorInvites'), t('settings.security.inviteCount', { count: inviteCount })],
      ]
    : [
        [t('settings.security.dashboardAuth'), t(platform ? 'settings.security.required' : 'settings.security.notRequired')],
        [t(platform ? 'settings.security.gatewayAuth' : 'settings.security.githubOAuth'), t(platform ? 'settings.security.gatewayIdentity' : 'settings.security.disabled')],
        [t('settings.security.executorIdentity'), t('settings.security.inviteReady')],
      ]
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.security.label')}
        subtitle={t('settings.security.subtitle')}
      />
      <SettingsKeyValueList rows={rows.map(([label, value]) => ({
        label,
        value: <span className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{value}</span>,
      }))} />
    </div>
  )
}
