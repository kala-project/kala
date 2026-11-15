import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AttachedExecutor, DashboardClientToServerEvents, DashboardServerToClientEvents, DeploymentServices, ProductVariant, RuntimeSettingsSection, ServerSettingsPayload, SettingsCapabilities, SettingsSectionValue } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'
import type { AccountOrganization, AccountProfile } from '../../auth-session.js'
import type { DurableSessionViewCache } from '../../durable-session-cache.js'
import { Button } from '../../components/ui/button.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '../../components/ui/alert-dialog.js'
import { AccountCenter } from '../account/AccountCenter.js'
import { SettingsSectionHelpContext } from './controls.js'
import { ConfigurationClient, configurationSnapshot, type ConfigurationKind, type ConfigurationOutcome, type ConfigurationSnapshot } from './configuration-client.js'
import { SettingsRequestContext } from './configuration-request.js'
import { OrganizationTask } from './OrganizationTask.js'
import { PreferencePersistenceNotice } from './PreferencePersistenceNotice.js'
import { SETTINGS_NAVIGATION, capabilityById, routeCapability, mergeSettingsCapabilities } from './navigation.js'
import { openSettings, parseSettingsRoute, returnFromSettings, type SettingsRoute } from './routes.js'
import { resolveSettingsTargetRequest } from './target-request.js'
import { InterfaceSection } from './sections/InterfaceSection.js'
import { NotificationsSection } from './sections/NotificationsSection.js'
import { ConnectionSection } from './sections/ConnectionSection.js'
import { ModelsSection } from './sections/ModelsSection.js'
import { AgentSection } from './sections/AgentSection.js'
import { SecuritySection } from './sections/SecuritySection.js'
import { RuntimeSection } from './sections/RuntimeSection.js'
import { HooksSection } from './sections/HooksSection.js'
import { StorageSection } from './sections/StorageSection.js'
import { ExecutorAccessSection } from './sections/ExecutorAccessSection.js'
import { McpSection } from './sections/McpSection.js'
import { SocketAdminSection } from './sections/SocketAdminSection.js'
import { DeploymentSection, ManagementSection } from './sections/DeploymentSection.js'
import { WebSearchSection } from './sections/WebSearchSection.js'
import { SpeechSection } from './sections/SpeechSection.js'
import { ServiceAccountsSection } from './sections/ServiceAccountsSection.js'
import { SiloSection } from './sections/SiloSection.js'
import { WebhooksSection } from './sections/WebhooksSection.js'
import { IntegrationStatus } from './IntegrationStatus.js'
import { DeploymentConfiguration } from './DeploymentConfiguration.js'
import { WorkspaceOverview } from './WorkspaceOverview.js'
import { ConfigurationApplication } from './ConfigurationApplication.js'
import './settings-page.css'

type Props = {
  cacheNamespace: string
  product: ProductVariant
  organization?: AccountOrganization
  profile?: AccountProfile
  deploymentServices?: DeploymentServices
  executors: readonly AttachedExecutor[]
  sessionCache?: DurableSessionViewCache
  storageSocket?: Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
  host: string
  token?: string
  onModelsChanged?(): void
  connectionPanel?: ReactNode
}

function runtimeSection(path: string): RuntimeSettingsSection | undefined {
  if (path === 'organization/models/providers') return 'models'
  if (path === 'organization/models/prompts') return 'agent'
  if (path === 'organization/models/engines') return 'engines'
  if (path === 'organization/policies/execution') return 'execution'
  if (path === 'organization/integrations/hooks') return 'hooks'
  if (path === 'organization/integrations/skills') return 'skills'
  if (path === 'organization/access/storage') return 'storage'
  if (path === 'organization/diagnostics' || path === 'deployment/consoles') return 'diagnostics'
  if (path === 'deployment/services' || path === 'deployment/configuration') return 'services'
  return undefined
}

const formPayload = (value: SettingsSectionValue): ServerSettingsPayload => ({
  providers: [], hooks: [],
  paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
  mcp: { supported: false, note: '' }, ...value, defaultModel: value.defaultModel ?? '',
})

export function SettingsPage(props: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [route, setRoute] = useState<SettingsRoute>(() => parseSettingsRoute(window.location.hash) ?? { kind: 'not-found', path: '' })
  const [pendingHash, setPendingHash] = useState<string>()
  const [dirty, setDirty] = useState(false)
  const [nativeOperation, setNativeOperation] = useState(false)
  const [configurationOutcome, setConfigurationOutcome] = useState<ConfigurationOutcome>('idle')
  const [reloadConfirmation, setReloadConfirmation] = useState(false)
  const [taskGeneration, setTaskGeneration] = useState(0)
  const dirtyRef = useRef(false), nativeRef = useRef(false)
  dirtyRef.current = dirty
  nativeRef.current = nativeOperation
  const acceptNext = useRef(false)
  const ignoreHelp = useCallback((_value: string | undefined) => {}, [])
  const ownershipTransferred = useCallback(() => {
    dirtyRef.current = false
    nativeRef.current = false
    setDirty(false)
    setNativeOperation(false)
  }, [])
  const hosted = props.product !== 'portable'
  const target = useMemo(() => resolveSettingsTargetRequest({
    product: props.product, host: props.host, browserOrigin: window.location.origin,
    cacheNamespace: props.cacheNamespace, organizationId: props.organization?.id,
    organizationRole: props.organization?.role, token: props.token,
  }), [props.product, props.host, props.cacheNamespace, props.organization?.id, props.organization?.role, props.token])
  const sameTarget = Boolean(target)
  const path = route.path
  const context = target?.cacheKey ?? [props.cacheNamespace, 'invalid-target', props.organization?.id ?? '', props.organization?.role ?? '', props.product]
  const targetIdentity = JSON.stringify(context)
  const activeScope = useRef<{ identity: string }>()
  const identity = JSON.stringify([...context, props.host, path])
  const activeIdentity = useRef(identity)
  activeIdentity.current = identity
  const clearDraft = useCallback(() => {
    if (activeIdentity.current === identity) setDirty(false)
  }, [identity])
  const markDraft = useCallback((value: boolean) => {
    if (activeIdentity.current === identity) setDirty(value)
  }, [identity])
  const headers = !hosted && props.token ? { authorization: `Bearer ${props.token}` } : undefined

  useEffect(() => {
    const scope = { identity: targetIdentity }
    activeScope.current = scope
    activeIdentity.current = identity
    return () => {
      activeIdentity.current = ''
      queueMicrotask(() => {
        // StrictMode immediately reinstates this same mounted scope.
        if (activeScope.current !== scope && activeScope.current?.identity === scope.identity) return
        const predicate = (query: { queryKey: readonly unknown[] }): boolean =>
          ['settings-capabilities', 'settings-section'].includes(String(query.queryKey[0]))
            ? context.every((part, index) => query.queryKey[index + 1] === part)
            : ['settings-view', 'executor-invites', 'dedicated-deployment-status'].includes(String(query.queryKey[0]))
              && query.queryKey[1] === targetIdentity
        void queryClient.cancelQueries({ predicate })
        queryClient.removeQueries({ predicate })
      })
    }
  }, [targetIdentity, queryClient])

  useEffect(() => {
    const guard = (event: Event): void => {
      if (acceptNext.current) { acceptNext.current = false; return }
      const requested = (event as CustomEvent<string>).detail
      if (requested === window.location.hash && requested === `#/settings/${route.path}`) return
      if (!dirtyRef.current && !nativeRef.current) return
      event.preventDefault()
      setPendingHash(requested)
    }
    const changed = (): void => {
      const next = parseSettingsRoute(window.location.hash)
      if (next && next.path !== route.path) { setRoute(next); setDirty(false) }
    }
    const unload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current && !nativeRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('kala:settings-navigation', guard)
    window.addEventListener('hashchange', changed)
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('kala:settings-navigation', guard)
      window.removeEventListener('hashchange', changed)
      window.removeEventListener('beforeunload', unload)
    }
  }, [route.path])
  useEffect(() => {
    if (route.kind !== 'page') return
    const canonical = `#/settings/${route.path}`
    if (window.location.hash === canonical) return
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${canonical}`)
    window.dispatchEvent(new Event('kala:settings-route-accepted'))
  }, [route])

  const gateway = useQuery({
    queryKey: ['settings-capabilities', ...context, 'gateway'],
    queryFn: async ({ signal }): Promise<SettingsCapabilities> => {
      const response = await fetch('/organization/capabilities', { cache: 'no-store', credentials: 'same-origin', signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as SettingsCapabilities
      if (value.product !== props.product || value.organizationId !== props.organization?.id) throw new Error('Settings identity mismatch')
      return value
    },
    enabled: hosted && sameTarget, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: true,
  })
  const runtime = useQuery({
    queryKey: ['settings-capabilities', ...context, 'runtime'],
    queryFn: async ({ signal }): Promise<SettingsCapabilities> => {
      if (!target) throw new Error('settings_target_mismatch')
      const response = await target.request('/settings/capabilities', { signal, headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as SettingsCapabilities
      if (value.product !== props.product || (hosted && value.organizationId !== props.organization?.id)) throw new Error('Settings identity mismatch')
      return value
    },
    enabled: sameTarget, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: true,
  })
  const capabilities = mergeSettingsCapabilities(props.product, runtime.data, gateway.data)
  const action = routeCapability(path)
  const capability = action ? capabilityById(capabilities, action) : undefined
  const forbiddenProduct = (path.startsWith('deployment/') && props.product === 'private-cloud')
    || (path === 'organization/members' && props.product !== 'private-cloud')
  const authorized = !forbiddenProduct && (!action || capability?.supported === true && capability.canRead)
  const section = runtimeSection(path)
  const configurationKind: ConfigurationKind | undefined = section === 'models' ? 'models'
    : section === 'agent' || section === 'execution' ? 'agent'
      : path === 'organization/integrations/search' ? 'search'
        : path === 'organization/integrations/speech' ? 'speech' : undefined
  const configurationClient = useMemo(() => configurationKind ? new ConfigurationClient({
    origin: target?.origin ?? window.location.origin, kind: configurationKind,
    fetch: target?.request,
    readPath: section ? `/settings/sections/${section}` : configurationKind === 'search' ? '/settings/web-search' : '/settings/speech',
    organizationId: hosted ? props.organization?.id : undefined,
    authorization: !hosted && props.token ? `Bearer ${props.token}` : undefined,
    onSnapshot: snapshot => {
      if (activeIdentity.current === identity) queryClient.setQueryData(['settings-section', ...context, section], snapshot)
    },
    onOutcome: outcome => {
      if (activeIdentity.current === identity) setConfigurationOutcome(outcome)
    },
  }) : undefined, [identity, props.token])
  useEffect(() => {
    setDirty(false)
    setNativeOperation(false)
    setConfigurationOutcome('idle')
    setReloadConfirmation(false)
  }, [identity])
  const projected = useQuery({
    queryKey: ['settings-section', ...context, section],
    queryFn: async ({ signal }): Promise<ConfigurationSnapshot> => {
      if (!target) throw new Error('settings_target_mismatch')
      const response = await target.request(`/settings/sections/${section}`, { signal, headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      return configurationKind ? configurationSnapshot(body, response.headers.get('etag'), configurationKind, hosted ? props.organization?.id : undefined)
        : { value: body as SettingsSectionValue }
    },
    enabled: Boolean(sameTarget && section && authorized && route.kind === 'page'), staleTime: 0,
    refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  })
  useLayoutEffect(() => {
    configurationClient?.seed(projected.data?.etag, projected.data?.configuration?.revision)
  }, [configurationClient, projected.data])
  const payload = projected.data ? formPayload(projected.data.value) : undefined
  const applyPayload = (next: ServerSettingsPayload): void => {
    if (activeIdentity.current !== identity) return
    if (!configurationClient || configurationClient.outcome === 'saved-pending') {
      queryClient.setQueryData(['settings-section', ...context, section], { value: next })
    }
    if (section !== 'models' && section !== 'agent') setDirty(false)
  }
  const reloadConfiguration = async (): Promise<void> => {
    if (section) {
      const result = await projected.refetch()
      if (result.isError || activeIdentity.current !== identity) return
    }
    if (activeIdentity.current !== identity) return
    setDirty(false)
    setConfigurationOutcome('idle')
    setTaskGeneration(value => value + 1)
  }
  const navigation = SETTINGS_NAVIGATION.filter(item => (!item.products || item.products.includes(props.product))
    && (!item.capability || !capabilityById(capabilities, item.capability) || capabilityById(capabilities, item.capability)?.canRead))
  const active = SETTINGS_NAVIGATION.filter(item => path === item.path || path.startsWith(item.path.replace(/\/(?:providers|search|execution|usage)$/u, '') + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const organizationTask = (task: Parameters<typeof OrganizationTask>[0]['section'], policyPage?: 'attachments' | 'retention'): ReactNode =>
    props.organization ? <OrganizationTask key={`${task}:${policyPage ?? ''}`} section={task} cacheNamespace={targetIdentity} organizationId={props.organization.id} role={props.organization.role} policyPage={policyPage} executors={props.executors} canConfigurePolicy={capability?.canWrite ?? false} onSaved={clearDraft} onInterruptionChange={setNativeOperation} onOwnershipTransferred={ownershipTransferred} onWorkspace={id => openSettings(`organization/workspaces/${encodeURIComponent(id)}/overview`)} />
      : <p>{t('unifiedSettings.unavailable')}</p>
  const tabs: readonly [string, string][] = path.startsWith('organization/models/') ? [
    ['organization/models/providers', 'providers'], ['organization/models/prompts', 'prompts'], ['organization/models/engines', 'engines'],
  ] : path.startsWith('organization/integrations/') ? [
    ['organization/integrations/search', 'search'], ['organization/integrations/speech', 'speech'], ['organization/integrations/hooks', 'hooks'],
    ['organization/integrations/skills', 'skills'], ['organization/integrations/webhooks', 'webhooks'],
  ] : path.startsWith('organization/policies/') ? [
    ['organization/policies/execution', 'execution'], ['organization/policies/attachments', 'attachments'], ['organization/policies/retention', 'retention'],
  ] : path.startsWith('organization/access/') ? [
    ['organization/access/usage', 'usage'], ['organization/access/storage', 'storage'], ['organization/access/service-accounts', 'serviceAccounts'],
    ['organization/access/sessions', 'sessions'], ['organization/access/audit', 'audit'],
  ] : route.kind === 'page' && route.workspaceId ? [
    [`organization/workspaces/${encodeURIComponent(route.workspaceId)}/overview`, 'overview'],
    [`organization/workspaces/${encodeURIComponent(route.workspaceId)}/access`, 'access'],
    [`organization/workspaces/${encodeURIComponent(route.workspaceId)}/mcp`, 'mcp'],
  ] : []
  let content: ReactNode
  if (route.kind === 'not-found') content = <p role="status">{t('unifiedSettings.notFound')}</p>
  else if (forbiddenProduct || capability && !capability.canRead) content = <p role="alert">{t('unifiedSettings.forbidden')}{capability?.reasonCode ? ` · ${capability.reasonCode}` : ''}</p>
  else if (action && !capability) content = <div role="status"><p>{t('unifiedSettings.unknown')}</p><Button onClick={() => { void runtime.refetch(); if (hosted) void gateway.refetch() }}>{t('common.retry')}</Button></div>
  else if (section && projected.error) content = <div role="alert"><p>{t('settings.loadErrorTitle')}</p><Button onClick={() => void projected.refetch()}>{t('common.retry')}</Button></div>
  else if (section && (!payload || configurationClient && projected.isFetching)) content = <p role="status">{t('common.loading')}</p>
  else if (path === 'personal/interface') content = <InterfaceSection sessionCache={props.sessionCache} autoHideOfflineWorkspacesByDefault={!hosted} />
  else if (path === 'personal/notifications') content = <NotificationsSection />
  else if (path === 'personal/connection') content = <div className="space-y-8"><ConnectionSection hosted={hosted} />{props.connectionPanel}</div>
  else if (path === 'personal/account') content = props.profile ? <AccountCenter embedded profile={props.profile} organization={props.organization} onClose={returnFromSettings} /> : <p>{t('unifiedSettings.localAccount')}</p>
  else if (path === 'organization/members') content = organizationTask('members')
  else if (path === 'organization/models/providers' && payload) content = <ModelsSection payload={payload} onPayloadChange={applyPayload} onModelsChanged={props.onModelsChanged} onDirtyChange={markDraft} mode={capabilityById(capabilities, 'models.configure')?.canWrite ? 'configuration' : 'catalog'} />
  else if (path === 'organization/models/prompts' && payload) content = <AgentSection payload={payload} readOnly={!capabilityById(capabilities, 'agent.configure')?.canWrite} onPayloadChange={applyPayload} onDirtyChange={markDraft} />
  else if (path === 'organization/models/engines' && payload) content = <RuntimeSection payload={payload} onOpenModels={() => openSettings('organization/models/providers')} />
  else if (path === 'organization/workspaces') content = hosted ? organizationTask('workspaces') : <ul>{props.executors.map(executor => <li key={executor.workspaceId}><Button variant="ghost" onClick={() => openSettings(`organization/workspaces/${encodeURIComponent(executor.workspaceId)}/overview`)}>{executor.workspaceName}</Button></li>)}</ul>
  else if (route.kind === 'page' && route.workspaceId) {
    const executor = props.executors.find(item => item.workspaceId === route.workspaceId)
    content = path.endsWith('/access') ? <ExecutorAccessSection executors={executor ? [executor] : []} canManage={capabilityById(capabilities, 'executor-invites.manage')?.canWrite ?? false} cacheNamespace={targetIdentity} />
      : path.endsWith('/mcp') ? <McpSection executors={executor ? [executor] : []} token={props.token} initialWorkspaceId={route.workspaceId} />
        : <WorkspaceOverview workspaceId={route.workspaceId} executor={executor} organizationId={props.organization?.id} cacheNamespace={targetIdentity} />
  }
  else if (path === 'organization/integrations/search') content = <div className="space-y-8"><WebSearchSection readOnly={!capabilityById(capabilities, 'search.configure')?.canWrite} onSaved={clearDraft} /><IntegrationStatus cacheNamespace={targetIdentity} organizationId={props.organization?.id} hosted={hosted} /></div>
  else if (path === 'organization/integrations/speech') content = <SpeechSection readOnly={!capabilityById(capabilities, 'speech.configure')?.canWrite} onSaved={clearDraft} />
  else if (path === 'organization/integrations/hooks' && payload) content = <HooksSection payload={payload} />
  else if (path === 'organization/integrations/skills' && payload) content = <div className="space-y-3"><h2 className="text-lg font-semibold">{t('unifiedSettings.tabs.skills')}</h2><p className="text-sm">{t('unifiedSettings.skillsCount', { count: payload.skills?.count ?? 0 })}</p>{payload.skills?.roots.map(root => <p key={root} className="break-all font-mono text-sm">{root}</p>)}{payload.skills?.diagnostics.map((diagnostic, index) => <p key={index} className="break-words text-sm">{typeof diagnostic === 'string' ? diagnostic : JSON.stringify(diagnostic)}</p>)}</div>
  else if (path === 'organization/integrations/webhooks') content = capability?.supported
    ? <WebhooksSection organizationId={props.organization?.id ?? ''} readOnly={!capability.canWrite} onDirtyChange={markDraft} onInterruptionChange={setNativeOperation} />
    : <p>{capability?.reasonCode ?? t('unifiedSettings.unavailable')}</p>
  else if (path === 'organization/policies/execution' && payload) content = <SecuritySection payload={payload} readOnly={!capabilityById(capabilities, 'execution-policy.configure')?.canWrite} onPayloadChange={applyPayload} />
  else if (path === 'organization/policies/attachments' || path === 'organization/policies/retention') content = organizationTask('policies', path.endsWith('/attachments') ? 'attachments' : 'retention')
  else if (path === 'organization/access/usage') content = organizationTask('usage')
  else if (path === 'organization/access/storage' && payload) content = <StorageSection payload={payload} socket={props.storageSocket} onRefresh={() => void projected.refetch()} refreshing={projected.isFetching} />
  else if (path === 'organization/access/service-accounts') content = <ServiceAccountsSection onInterruptionChange={setNativeOperation} onSaved={clearDraft} />
  else if (path === 'organization/access/sessions') content = organizationTask('sessions')
  else if (path === 'organization/access/audit') content = organizationTask('audit')
  else if (path === 'organization/diagnostics' && payload) content = <SocketAdminSection payload={payload} host={target?.origin} onPayloadChange={applyPayload} socket={props.storageSocket} snapshotPath="/settings/sections/diagnostics" />
  else if (path === 'deployment/storage') content = <SiloSection key={targetIdentity} enabled={props.product === 'dedicated' && props.organization?.role === 'owner' && props.deploymentServices?.siloConsolePath === '/silo/'} credentialsAvailable={props.deploymentServices?.siloCredentialsAvailable} />
  else if (path === 'deployment/services' && payload) content = <div className="space-y-8"><DeploymentSection payload={payload} host={target?.origin ?? ''} cacheNamespace={targetIdentity} token={props.token} /><RuntimeSection payload={payload} /></div>
  else if (path === 'deployment/consoles' && payload) content = <ManagementSection payload={payload} host={target?.origin ?? ''} token={props.token} services={props.deploymentServices ?? { observability: false }} includeSilo={false} />
  else if (path === 'deployment/configuration' && payload) content = <DeploymentConfiguration sources={projected.data?.value.configurationSources} />
  else content = <p className="text-sm">{t('unifiedSettings.unavailable')}</p>

  if (!sameTarget) return <section className="space-y-4 p-6"><h1 className="text-xl font-semibold">{t('settings.title')}</h1><p role="alert">{t('unifiedSettings.targetMismatch')}</p><Button variant="outline" onClick={returnFromSettings}>{t('unifiedSettings.return')}</Button></section>
  return <section className="ak-settings-page h-full min-h-0 min-w-0" data-testid="settings-page">
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
      <div className="min-w-0"><h1 className="text-2xl font-semibold">{t('settings.title')}</h1><p className="break-words text-sm text-muted-foreground">{props.organization?.name ?? new URL(target!.origin).host}</p></div>
      <Button variant="outline" onClick={returnFromSettings}>{t('unifiedSettings.return')}</Button>
    </header>
    <div className="ak-settings-grid">
      <nav className="ak-settings-sidebar" aria-label={t('settings.sectionsLabel')}>{(['personal', 'organization', 'deployment'] as const).map(group => <div key={group} className="space-y-1 px-3 py-4">
        {navigation.some(item => item.group === group) ? <h2 className="px-2 pb-2 text-base font-semibold text-foreground">{t(`unifiedSettings.groups.${group === 'organization' && props.product === 'dedicated' ? 'instance' : group}`)}</h2> : null}
        {navigation.filter(item => item.group === group).map(item => <button key={item.path} type="button" className="ak-settings-nav-row" aria-current={active?.path === item.path ? 'page' : undefined} onClick={() => openSettings(item.path)}>{t(`unifiedSettings.navigation.${item.label}`)}</button>)}
      </div>)}</nav>
      <ScrollArea className="ak-settings-task min-h-0 min-w-0" viewportClassName="h-full" contentClassName={path === 'deployment/storage' ? 'h-full min-w-0' : 'min-w-0'}>
        <label className="ak-settings-picker px-4 pt-4 text-sm"><span>{t('settings.sectionsLabel')}</span><select className="mt-1 min-h-11 w-full rounded border border-border/60 bg-background px-2" value={active?.path ?? ''} onChange={event => openSettings(event.target.value)}><option value="" disabled>{t('settings.sectionsLabel')}</option>{(['personal', 'organization', 'deployment'] as const).map(group => <optgroup key={group} label={t(`unifiedSettings.groups.${group === 'organization' && props.product === 'dedicated' ? 'instance' : group}`)}>{navigation.filter(item => item.group === group).map(item => <option key={item.path} value={item.path}>{t(`unifiedSettings.navigation.${item.label}`)}</option>)}</optgroup>)}</select></label>
        <div className={path === 'deployment/storage' ? 'flex h-full min-h-0 flex-col p-4' : 'mx-auto w-full max-w-4xl p-4 text-sm sm:p-6'} onChangeCapture={() => { if (!path.startsWith('personal/') && section !== 'models' && section !== 'agent') setDirty(true) }}>
          <PreferencePersistenceNotice />
          {configurationClient && !path.startsWith('personal/') && (projected.data?.configuration || configurationOutcome !== 'idle') ? <div className="mb-4 space-y-2 rounded border border-border/60 p-3 text-sm">
            {configurationOutcome !== 'idle' ? <p role={configurationOutcome === 'saving' ? 'status' : 'alert'}>{t(`unifiedSettings.configuration.${configurationOutcome}`)}</p> : null}
            {projected.data?.configuration ? <ConfigurationApplication application={projected.data.configuration.application} /> : null}
            <Button variant="outline" disabled={configurationOutcome === 'saving'} onClick={() => dirty ? setReloadConfirmation(true) : void reloadConfiguration()}>{t('unifiedSettings.configuration.reload')}</Button>
          </div> : null}
          {tabs.length ? <ScrollArea className="mb-6 min-w-0 border-b border-border/60 pb-2"><nav className="flex w-max min-w-full gap-2 pb-2 [&>button]:shrink-0" aria-label={t('unifiedSettings.tabsLabel')}>{tabs.filter(([tab]) => { const id = routeCapability(tab); const cap = id ? capabilityById(capabilities, id) : undefined; return !cap || cap.canRead }).map(([tab, label]) => <Button key={tab} variant={tab === path ? 'outline' : 'ghost'} aria-current={tab === path ? 'page' : undefined} onClick={() => openSettings(tab)}>{t(`unifiedSettings.tabs.${label}`)}</Button>)}</nav></ScrollArea> : null}
          <SettingsSectionHelpContext.Provider value={ignoreHelp}>
            <SettingsRequestContext.Provider value={configurationClient?.request ?? target?.request ?? fetch}>
              <div key={`${identity}:${taskGeneration}`} className={path === 'deployment/storage' ? 'min-h-0 flex-1' : 'min-w-0'}>{content}</div>
            </SettingsRequestContext.Provider>
          </SettingsSectionHelpContext.Provider>
        </div>
      </ScrollArea>
    </div>
    <AlertDialog open={Boolean(pendingHash)} onOpenChange={open => { if (!open) setPendingHash(undefined) }}><AlertDialogContent><AlertDialogTitle>{t('unifiedSettings.leaveTitle')}</AlertDialogTitle><AlertDialogDescription>{t('unifiedSettings.leaveDescription')}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => { if (!pendingHash) return; acceptNext.current = true; setDirty(false); window.location.hash = pendingHash; setPendingHash(undefined) }}>{t('unifiedSettings.leave')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={reloadConfirmation} onOpenChange={setReloadConfirmation}><AlertDialogContent><AlertDialogTitle>{t('unifiedSettings.configuration.reload')}</AlertDialogTitle><AlertDialogDescription>{t('unifiedSettings.leaveDescription')}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => { setReloadConfirmation(false); void reloadConfiguration() }}>{t('unifiedSettings.configuration.reload')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>
}
