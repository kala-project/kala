import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AttachedExecutor, OrganizationSettingsSection, OrganizationSettingsValue } from '@agent-kernel/shared'
import { Members, Policies } from '../admin/AdminCenter.js'
import { Button } from '../../components/ui/button.js'
import { HelpHint } from '../../components/ui/help-hint.js'
import { CopyButton, EmptyRow } from './controls.js'
import { ChevronRight, FolderOpen } from 'lucide-react'
import { ConfigurationClient, configurationSnapshot, type ConfigurationOutcome, type ConfigurationSnapshot } from './configuration-client.js'

type RetentionValue = { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }
type PolicyValue = RetentionValue | { maxBytes: number }
function policyProjection(snapshot: ConfigurationSnapshot<PolicyValue>): OrganizationSettingsValue {
  const { value, configuration } = snapshot
  if (!configuration) throw new Error('invalid_policy_configuration')
  if (configuration.resource.kind === 'attachment-policy') {
    if (!('maxBytes' in value) || Object.keys(value).length !== 1 || ![2, 4, 8, 16].some(size => value.maxBytes === size * 1024 * 1024)) throw new Error('invalid_attachment_configuration')
    return { attachmentMaxBytes: value.maxBytes }
  }
  if (!('sessionDays' in value) || Object.keys(value).length !== 4
    || ![value.sessionDays, value.artifactDays, value.auditDays].every(number => Number.isSafeInteger(number) && number >= 1)
    || !Number.isSafeInteger(value.deletedResourceGraceDays) || value.deletedResourceGraceDays < 0) throw new Error('invalid_retention_configuration')
  return { retention: { session_days: value.sessionDays, artifact_days: value.artifactDays, audit_days: value.auditDays,
    deleted_resource_grace_days: value.deletedResourceGraceDays, version: configuration.revision } }
}

export function OrganizationTask({ section, cacheNamespace, organizationId, role, policyPage, canConfigurePolicy, executors = [], onWorkspace, onInterruptionChange, onOwnershipTransferred, onSaved }: {
  section: OrganizationSettingsSection
  cacheNamespace: string
  organizationId: string
  role?: 'owner' | 'admin' | 'member' | 'viewer'
  policyPage?: 'attachments' | 'retention'
  canConfigurePolicy?: boolean
  executors?: readonly AttachedExecutor[]
  onWorkspace(id: string): void
  onInterruptionChange?(active: boolean): void
  onOwnershipTransferred?(): void
  onSaved?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [cursor, setCursor] = useState<string>()
  const [previous, setPrevious] = useState<OrganizationSettingsValue>()
  const [actionError, setActionError] = useState<string>()
  const [outcome, setOutcome] = useState<ConfigurationOutcome>('idle')
  const [application, setApplication] = useState<string>()
  const [dirty, setDirty] = useState(false)
  const [generation, setGeneration] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const queryKey = ['settings-view', cacheNamespace, window.location.origin, organizationId, section, role ?? '', policyPage ?? '', cursor ?? '']
  const policyKind = section === 'policies' ? policyPage === 'retention' ? 'retention' : policyPage === 'attachments' ? 'attachment-policy' : undefined : undefined
  const policyReadPath = policyKind === 'retention' ? '/organization/retention' : '/organization/attachment-policy/configuration'
  const configurationClient = useMemo(() => policyKind ? new ConfigurationClient<PolicyValue>({
    origin: window.location.origin, kind: policyKind, readPath: policyReadPath, organizationId,
    onSnapshot: snapshot => {
      if (!mounted.current) return
      queryClient.setQueryData(queryKey, policyProjection(snapshot))
      setApplication(snapshot.configuration?.application.state)
    },
    onOutcome: value => { if (mounted.current) setOutcome(value) },
  }) : undefined, [policyKind, cacheNamespace, organizationId, role])
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<OrganizationSettingsValue> => {
      if (configurationClient) {
        const response = await configurationClient.request(policyReadPath, { signal })
        return policyProjection(configurationSnapshot<PolicyValue>(await response.json(), response.headers.get('etag'), policyKind!, organizationId))
      }
      const response = await fetch(`/organization/settings-view?section=${section}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store', signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as OrganizationSettingsValue
    },
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: !configurationClient,
  })
  const page = query.data
  const value = page ? { ...page,
    members: [...previous?.members ?? [], ...page.members ?? []], invites: [...previous?.invites ?? [], ...page.invites ?? []],
    workspaces: [...previous?.workspaces ?? [], ...page.workspaces ?? []], sessions: [...previous?.sessions ?? [], ...page.sessions ?? []],
    executorPools: [...previous?.executorPools ?? [], ...page.executorPools ?? []],
    executorRegistrations: [...previous?.executorRegistrations ?? [], ...page.executorRegistrations ?? []],
    audit: [...previous?.audit ?? [], ...page.audit ?? []],
  } : undefined
  const reload = async (): Promise<void> => {
    if (configurationClient) {
      if (configurationClient.outcome === 'conflict' || configurationClient.outcome === 'outcome-unknown') throw new Error('configuration_refresh_required')
      if (mounted.current) { setDirty(false); onSaved?.() }
      return
    }
    setPrevious(undefined)
    setCursor(undefined)
    await queryClient.invalidateQueries({ queryKey: ['settings-view', cacheNamespace, window.location.origin, organizationId, section], refetchType: 'all' })
    if (mounted.current) { setDirty(false); onSaved?.() }
  }
  const reloadConfiguration = async (): Promise<void> => {
    if (dirty && !window.confirm(t('unifiedSettings.leaveDescription'))) return
    const result = await query.refetch()
    if (result.isError || !mounted.current) return
    setGeneration(value => value + 1); setDirty(false); setActionError(undefined); setOutcome('idle'); onSaved?.()
  }
  if (query.error && !value) return <p role="alert" className="text-sm">{String(query.error)} <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button></p>
  if (!value) return <p role="status">{t('common.loading')}</p>
  const manager = role === 'owner' || role === 'admin'
  const workspaces = [
    ...value.workspaces.map(workspace => ({ ...workspace, observed: executors.filter(executor => executor.workspaceId === workspace.id) })),
    ...[...new Set(executors.map(executor => executor.workspaceId))].filter(id => !value.workspaces.some(workspace => workspace.id === id))
      .map(id => ({ id, name: executors.find(executor => executor.workspaceId === id)!.workspaceName,
        status: undefined, observed: executors.filter(executor => executor.workspaceId === id) })),
  ]
  return <div className="space-y-4">
    {query.error ? <p role="alert" className="text-sm">{String(query.error)}</p> : null}
    {actionError ? <p role="alert" className="break-words text-sm text-destructive">{actionError}</p> : null}
    {configurationClient ? <div className="space-y-2 rounded border border-border/60 p-3">
      {outcome !== 'idle' ? <p role={outcome === 'saving' ? 'status' : 'alert'}>{t(`unifiedSettings.configuration.${outcome}`)}</p> : null}
      {application ? <p role="status">{t(`unifiedSettings.configuration.application.${application}`)}</p> : null}
      <Button variant="outline" disabled={outcome === 'saving'} onClick={() => void reloadConfiguration()}>{t('unifiedSettings.configuration.reload')}</Button>
    </div> : null}
    {section === 'members' ? <Members snapshot={{ members: value.members, invites: value.invites, role: role ?? 'viewer' }} canManage={manager} load={reload} setError={setActionError} t={t} onInterruptionChange={onInterruptionChange} onOwnershipTransferred={onOwnershipTransferred} /> : null}
    {section === 'policies' ? <div onChangeCapture={() => setDirty(true)}><Policies key={generation} snapshot={{ organization: { attachment_max_bytes: value.attachmentMaxBytes }, retention: value.retention }} canPolicy={manager && (canConfigurePolicy ?? true)} load={reload} setError={setActionError} t={t} section={policyPage} request={configurationClient?.request} /></div> : null}
    {section === 'workspaces' ? <>
      <div className="flex items-center gap-1"><h2 className="text-lg font-semibold">{t('unifiedSettings.navigation.workspaces')}</h2><HelpHint label={t('unifiedSettings.navigation.workspaces')}>{t('unifiedSettings.registryNotLiveness')}</HelpHint><div className="ml-auto"><CopyButton label={t('unifiedSettings.copyDiagnostics')} value={JSON.stringify(workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, status: workspace.status, executorIds: workspace.observed.map(executor => executor.executorId) })), null, 2)} /></div></div>
      {workspaces.length ? <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card/60" data-testid="settings-workspace-list">
        {workspaces.map(workspace => <li key={workspace.id} className="min-w-0 px-4 py-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-3 whitespace-normal px-0 text-left text-sm font-medium" onClick={() => onWorkspace(workspace.id)}><FolderOpen className="h-4 w-4 flex-none text-muted-foreground" aria-hidden /><span className="min-w-0 flex-1 break-words">{workspace.name}</span><ChevronRight className="h-4 w-4 flex-none text-muted-foreground" aria-hidden /></Button>
            <span className={`rounded-full px-2 py-1 text-xs ${workspace.observed.length ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>{t(`unifiedSettings.workspaceUi.${workspace.observed.length ? 'observed' : 'notObserved'}`)}</span>
          </div>
        </li>)}
      </ul> : <EmptyRow>{t('unifiedSettings.workspaceUi.empty')}</EmptyRow>}
      {manager ? <OrganizationTask section="executors" cacheNamespace={cacheNamespace} organizationId={organizationId} role={role} executors={executors} onWorkspace={onWorkspace} /> : null}
    </> : null}
    {section === 'executors' ? <>
      <section className="space-y-3">
        <div className="flex items-center gap-1"><h2 className="text-lg font-semibold">{t('unifiedSettings.workspaceUi.pools')}</h2><HelpHint label={t('unifiedSettings.workspaceUi.pools')}>{t('unifiedSettings.registryNotLiveness')}</HelpHint><div className="ml-auto"><CopyButton label={t('unifiedSettings.copyDiagnostics')} value={JSON.stringify({ pools: value.executorPools, devices: value.executorRegistrations }, null, 2)} /></div></div>
        {value.executorPools.length ? <ul className="divide-y divide-border/50 rounded-xl border border-border/50 bg-card/60" data-testid="settings-pool-list">{value.executorPools.map(pool => <li key={pool.id} className="min-w-0 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words text-sm font-medium">{pool.name}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">{t(`unifiedSettings.workspaceUi.modes.${pool.mode}`)}</span></div>
          {pool.workspaceId ? <Button variant="link" className="mt-1 h-auto max-w-full whitespace-normal p-0 text-left text-sm" onClick={() => onWorkspace(pool.workspaceId!)}>{executors.find(executor => executor.workspaceId === pool.workspaceId)?.workspaceName ?? value.workspaces.find(workspace => workspace.id === pool.workspaceId)?.name ?? t('unifiedSettings.workspaceUi.workspace')}</Button> : null}
        </li>)}</ul> : <EmptyRow>{t('unifiedSettings.workspaceUi.noPools')}</EmptyRow>}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('unifiedSettings.workspaceUi.devices')}</h2>
        {value.executorRegistrations.length ? <ul className="divide-y divide-border/50 rounded-xl border border-border/50 bg-card/60" data-testid="settings-device-list">{value.executorRegistrations.map(registration => <li key={registration.id} className="min-w-0 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words text-sm font-medium">{registration.name}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs">{t(`unifiedSettings.workspaceUi.${executors.some(executor => executor.executorId === registration.nativeExecutorId && executor.workspaceId === registration.workspaceId) ? 'observed' : 'notObserved'}`)}</span></div>
          {value.executorPools.some(pool => pool.id === registration.poolId) ? <p className="mt-1 text-sm text-muted-foreground">{value.executorPools.find(pool => pool.id === registration.poolId)?.name}</p> : null}
          {registration.workspaceId ? <Button variant="link" className="mt-1 h-auto max-w-full whitespace-normal p-0 text-left text-sm" onClick={() => onWorkspace(registration.workspaceId!)}>{executors.find(executor => executor.workspaceId === registration.workspaceId)?.workspaceName ?? t('unifiedSettings.workspaceUi.workspace')}</Button> : null}
        </li>)}</ul> : <EmptyRow>{t('unifiedSettings.workspaceUi.noDevices')}</EmptyRow>}
      </section>
    </> : null}
    {section === 'usage' ? <div className="space-y-4"><h2 className="text-lg font-semibold">{t('admin.currentMonth')}</h2><dl className="grid gap-3 text-sm sm:grid-cols-2">{Object.entries(value.usage ?? {}).map(([key, data]) => <div key={key} className="min-w-0 rounded-xl border border-border/50 bg-card/60 p-4"><dt className="text-muted-foreground">{t(`admin.labels.${key}`)}</dt><dd className="mt-2 text-xl font-semibold tabular-nums">{data}</dd></div>)}</dl><div className="flex items-center gap-1"><h3 className="text-base font-semibold">{t('admin.contract')}</h3><HelpHint label={t('admin.contract')}>{t('unifiedSettings.reportedOnly')}</HelpHint></div><dl className="divide-y divide-border/50 rounded-xl border border-border/50 px-4 text-sm">{Object.entries(value.entitlement ?? {}).map(([key, data]) => <div key={key} className="flex flex-wrap justify-between gap-3 py-3"><dt className="break-words">{key.replaceAll('_', ' ')}</dt><dd className="break-words font-medium">{data ?? t('admin.unlimited')}</dd></div>)}</dl></div> : null}
    {section === 'sessions' ? <section className="space-y-3"><h2 className="text-lg font-semibold">{t('unifiedSettings.tabs.sessions')}</h2><ul className="divide-y divide-border/50 rounded-xl border border-border/50 bg-card/60">{value.sessions.map(session => <li key={session.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4"><div><time className="block text-sm" dateTime={session.last_seen_at}>{new Date(session.last_seen_at).toLocaleString()}</time><code className="text-xs text-muted-foreground" title={session.id}>{session.id.slice(-8)}</code></div>{session.revoked_at ? <span className="rounded-full bg-muted px-2 py-1 text-xs">{t('admin.revoked')}</span> : null}<CopyButton value={session.id} /></li>)}</ul></section> : null}
    {section === 'audit' ? <section className="space-y-3"><h2 className="text-lg font-semibold">{t('unifiedSettings.tabs.audit')}</h2><ul className="divide-y divide-border/50 rounded-xl border border-border/50 bg-card/60">{value.audit.map(event => <li key={event.id} className="min-w-0 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-words text-sm font-medium">{event.action}</span><span className="rounded-full bg-muted px-2 py-1 text-xs">{event.result}</span></div><time className="mt-2 block text-xs text-muted-foreground" dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString()}</time></li>)}</ul></section> : null}
    {value.nextCursor ? <Button variant="outline" onClick={() => { setPrevious(value); setCursor(value.nextCursor) }}>{t('unifiedSettings.loadMore')}</Button> : null}
  </div>
}
