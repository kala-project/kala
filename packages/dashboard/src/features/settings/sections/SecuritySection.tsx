import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { InterfaceToggle, SectionHeader, SettingsKeyValueList } from '../controls.js'

export function SecuritySection({ payload, onPayloadChange }: {
  payload: ServerSettingsPayload
  onPayloadChange?(payload: ServerSettingsPayload): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const scope = payload.agentPrompt?.configPath ?? 'unavailable'
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [feedback, setFeedback] = useState<{ scope: string; message: string; pending: boolean } | null>(null)
  const updateDesktopAccess = useMutation({
    mutationFn: async (input: { scope: string; manualAuthorizationRequired: boolean; computerUseEnabled?: boolean; desktopPreviewEnabled?: boolean }) => {
      const response = await fetch('/settings/desktop-access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manualAuthorizationRequired: input.manualAuthorizationRequired,
          ...(input.computerUseEnabled !== undefined ? { computerUseEnabled: input.computerUseEnabled } : {}),
          ...(input.desktopPreviewEnabled !== undefined ? { desktopPreviewEnabled: input.desktopPreviewEnabled } : {}) }),
      })
      const body = await response.json() as ServerSettingsPayload | { error?: string; settingsSaved?: boolean }
      if (!response.ok) {
        const error = new Error('error' in body && body.error ? body.error : `HTTP ${response.status}`)
        if (response.status === 503 && 'settingsSaved' in body && body.settingsSaved === true) {
          throw Object.assign(error, { settingsSaved: true })
        }
        throw error
      }
      return body as ServerSettingsPayload
    },
    onSuccess: (next, input) => {
      if (scopeRef.current !== input.scope || next.agentPrompt?.configPath !== input.scope) return
      setFeedback(null)
      onPayloadChange?.(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (error, input) => {
      if (scopeRef.current !== input.scope) return
      const pending = 'settingsSaved' in error && error.settingsSaved === true
      setFeedback({
        scope: input.scope, pending,
        message: pending ? t('settings.security.desktopSavedPending') : t('settings.security.desktopSaveFailed', { error: error.message }),
      })
      if (pending) void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })
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
      {payload.desktopAccess ? (
        <ul className="mt-6 space-y-3">
          {payload.desktopAccess.computerUseEnabled !== undefined ? <>
            <InterfaceToggle
              label={t('settings.security.computerUse')}
              description={t('settings.security.computerUseHint')}
              checked={payload.desktopAccess.computerUseEnabled}
              disabled={!onPayloadChange || updateDesktopAccess.isPending}
              testId="settings-computer-use"
              onChange={(computerUseEnabled) => updateDesktopAccess.mutate({ scope, manualAuthorizationRequired: payload.desktopAccess!.manualAuthorizationRequired, computerUseEnabled })}
            />
            <InterfaceToggle
              label={t('settings.security.desktopPreview')}
              description={t('settings.security.desktopPreviewHint')}
              checked={payload.desktopAccess.desktopPreviewEnabled ?? false}
              disabled={!payload.desktopAccess.computerUseEnabled || !onPayloadChange || updateDesktopAccess.isPending}
              testId="settings-desktop-preview"
              onChange={(desktopPreviewEnabled) => updateDesktopAccess.mutate({ scope, manualAuthorizationRequired: payload.desktopAccess!.manualAuthorizationRequired, desktopPreviewEnabled })}
            />
          </> : null}
          <InterfaceToggle
            label={t('settings.security.desktopManualAuthorization')}
            description={t('settings.security.desktopManualAuthorizationHint')}
            checked={payload.desktopAccess.manualAuthorizationRequired}
            disabled={payload.desktopAccess.computerUseEnabled === false || !onPayloadChange || updateDesktopAccess.isPending}
            testId="settings-desktop-manual-authorization"
            onChange={(manualAuthorizationRequired) => updateDesktopAccess.mutate({ scope, manualAuthorizationRequired })}
          />
        </ul>
      ) : null}
      {feedback?.scope === scope ? (
        <p role={feedback.pending ? 'status' : 'alert'} className={`mt-3 text-sm ${feedback.pending ? 'text-muted-foreground' : 'text-destructive'}`}>{feedback.message}</p>
      ) : null}
    </div>
  )
}
