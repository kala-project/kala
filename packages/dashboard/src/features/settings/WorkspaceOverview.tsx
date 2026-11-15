import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AttachedExecutor, OrganizationSettingsValue } from '@agent-kernel/shared'
import { Button } from '../../components/ui/button.js'
import { HelpHint } from '../../components/ui/help-hint.js'
import { CopyButton, SettingsKeyValueList } from './controls.js'

export function WorkspaceOverview({ workspaceId, executor, organizationId, cacheNamespace }: {
  workspaceId: string; executor?: AttachedExecutor; organizationId?: string; cacheNamespace: string;
}): JSX.Element {
  const { t } = useTranslation()
  const currentExecutor = executor?.workspaceId === workspaceId ? executor : undefined
  const registryId = /^ws_[A-Za-z0-9_-]{1,197}$/u.test(workspaceId)
  const query = useQuery({ queryKey: ['settings-view', cacheNamespace, window.location.origin, organizationId, 'workspace', workspaceId],
    enabled: Boolean(organizationId && registryId), staleTime: Infinity, refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<OrganizationSettingsValue> => {
      const response = await fetch(`/organization/settings-view?section=workspaces&workspaceId=${encodeURIComponent(workspaceId)}`, { cache: 'no-store', signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as OrganizationSettingsValue
      if (value.workspaces?.some(workspace => workspace.id !== workspaceId)) throw new Error('workspace_scope_mismatch')
      return value
    } })
  const workspace = query.data?.workspaces?.find(workspace => workspace.id === workspaceId)
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="break-words text-lg font-semibold">{workspace?.name ?? currentExecutor?.workspaceName ?? t('unifiedSettings.navigation.workspaces')}</h2><span className="rounded-full bg-muted px-2 py-1 text-xs">{t(currentExecutor ? 'unifiedSettings.workspaceUi.observed' : 'unifiedSettings.workspaceUi.notObserved')}</span><HelpHint label={t('unifiedSettings.navigation.workspaces')}>{t('unifiedSettings.registryNotLiveness')}</HelpHint></div>
    {query.error ? <p role="alert">{t('unifiedSettings.unknown')} <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button></p> : null}
    {query.isLoading ? <p role="status">{t('common.loading')}</p> : null}
    <SettingsKeyValueList rows={[
      { label: t('unifiedSettings.workspaceUi.workspaceId'), value: <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-sm">{workspaceId}</code><CopyButton value={workspaceId} /></div> },
      ...(workspace?.status ? [{ label: t('unifiedSettings.workspaceUi.status'), value: workspace.status }] : []),
      ...(currentExecutor ? [{ label: t('unifiedSettings.workspaceUi.executorId'), value: <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-sm">{currentExecutor.executorId}</code><CopyButton value={currentExecutor.executorId} /></div> }] : []),
    ]} />
  </div>
}
