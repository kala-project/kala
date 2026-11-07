import type { BuildMetadata, DedicatedDeploymentStatus, DeploymentServices, ExternalDeploymentHealth, ServerSettingsPayload } from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronRight, CircleAlert, CloudCog, MonitorUp, Server } from 'lucide-react'

import { CopyButton, SectionHeader, SettingsRecord, SettingsRecordField, SettingsRecordList } from '../controls.js'
import packageJson from '../../../../package.json'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { Button } from '../../../components/ui/button.js'
import { forcePwaRefresh } from '../../../lib/pwa.js'

const DASHBOARD_VERSION = packageJson.version

export function DeploymentSection({ payload, host, token, services }: { payload: ServerSettingsPayload; host: string; token?: string; services?: DeploymentServices }): JSX.Element {
  const { t } = useTranslation()
  const aspireUrl = services?.observabilityUrl
  const statusQuery = useQuery({
    queryKey: ['dedicated-deployment-status', host],
    queryFn: async (): Promise<DedicatedDeploymentStatus | ExternalDeploymentHealth | null> => {
      const response = await fetch(`${host.replace(/\/$/u, '')}/runtime/deployment/status`, { cache: 'no-store', credentials: 'include', signal: AbortSignal.timeout(10_000), headers: token ? { authorization: `Bearer ${token}` } : undefined })
      if (response.status === 404) {
        if (payload.runtimeManagement !== 'external') return null
        const health = await fetch(`${host.replace(/\/$/u, '')}/runtime/deployment/health`, { cache: 'no-store', credentials: 'include', signal: AbortSignal.timeout(10_000), headers: token ? { authorization: `Bearer ${token}` } : undefined })
        if (health.status === 404) return null
        if (!health.ok) throw new Error(`HTTP ${health.status}`)
        return await health.json() as ExternalDeploymentHealth
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as DedicatedDeploymentStatus
    },
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const current = query.state.data
      return current && 'route' in current && current.deployment && !['completed', 'failed', 'aborted'].includes(current.deployment.phase) ? 2_000 : false
    },
  })
  const externalHealth = statusQuery.data && 'kind' in statusQuery.data ? statusQuery.data : undefined
  const status = statusQuery.data && 'route' in statusQuery.data ? statusQuery.data : undefined
  const build = payload.versions?.build
  const deploymentHealthy = !status?.deployment || status.deployment.phase === 'completed' && !status.deployment.error && !(status.deployment.blockers?.length)
  const dashboardCompatible = !status?.dashboard || protocolCompatible(PROTOCOL_VERSION, status.dashboard.protocol)
  const verified = Boolean(status || externalHealth)
  const overallHealthy = !statusQuery.isError && (externalHealth?.ok ?? deploymentHealthy) && dashboardCompatible
  return (
    <div>
      <SectionHeader title={t('settings.sections.deployment.label')} subtitle={t('settings.deployment.subtitle')} />
      {services ? <section className="mb-5 space-y-3 rounded-lg border border-border/50 bg-card/60 p-4" data-testid="settings-management-tools">
        <h4 className="font-semibold">{t('settings.deployment.managementTools')}</h4>
        <div className="flex flex-wrap gap-2">
          {services.identityConsoleUrl ? <Button asChild variant="outline"><a href={services.identityConsoleUrl} target="_blank" rel="noreferrer">{t('deploymentCenter.openIdentity')}</a></Button> : null}
          {payload.socketAdmin?.active && payload.socketAdmin.path ? <Button asChild variant="outline"><a href={payload.socketAdmin.path} target="_blank" rel="noreferrer">Socket.IO Admin</a></Button> : null}
          {services.siloConsolePath ? <Button asChild variant="outline"><a href={services.siloConsolePath} target="_blank" rel="noreferrer" data-testid="settings-open-silo">SILO Console</a></Button> : null}
        </div>
        {services.siloConsolePath ? <p className="text-sm text-muted-foreground" data-testid="settings-silo-explanation">{t('settings.deployment.siloAccessHelp')}</p> : null}
        {payload.socketAdmin?.authentication === 'gateway-owner' ? <p className="text-sm text-muted-foreground" data-testid="settings-socket-mode">
          {t('settings.deployment.socketMode', {
            current: t(`settings.socketAdmin.${payload.socketAdmin.runtimeMode === 'development' ? 'modeDevelopment' : 'modeProduction'}`),
            configured: t(`settings.socketAdmin.${payload.socketAdmin.configuredMode === 'development' ? 'modeDevelopment' : 'modeProduction'}`),
          })} <code>KALA_SOCKET_ADMIN_MODE</code>{payload.socketAdmin.restartRequired ? ` · ${t('settings.deployment.socketModeRestart')}` : null}
          {payload.socketAdmin.runtimeMode === 'development' ? ` · ${t('settings.deployment.socketModeRedacted')}` : null}
        </p> : null}
        {aspireUrl ? <div data-testid="settings-native-aspire">
          <div className="flex items-center gap-1 text-sm font-medium">Aspire<HelpHint label="Aspire">{t('settings.deployment.aspireAccessHelp')}</HelpHint></div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all text-sm">{aspireUrl}</code><CopyButton value={aspireUrl} /><Button asChild><a href={aspireUrl} target="_blank" rel="noreferrer">{t('settings.socketAdmin.open')}</a></Button></div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['structuredlogs', 'traces', 'metrics'] as const).map((page) =>
              <Button key={page} asChild variant="outline" size="sm"><a href={`${aspireUrl.replace(/\/$/u, '')}/${page}`} target="_blank" rel="noreferrer">{t(`deploymentCenter.${page === 'structuredlogs' ? 'logs' : page}`)}</a></Button>,
            )}
          </div>
          {services.observabilityTokenAvailable ? <AspireLoginToken host={host} token={token} /> : null}
        </div> : null}
      </section> : null}
      <div className="mb-4 flex justify-end"><Button variant="outline" disabled={statusQuery.isFetching} onClick={() => { void statusQuery.refetch() }}>{t('settings.socketAdmin.refresh')}</Button></div>
      <div className="grid gap-2 sm:grid-cols-2" data-testid="settings-deployment-overview">
        <OverviewCard icon={verified && overallHealthy ? CheckCircle2 : CircleAlert} label={t('settings.deployment.overallStatus')} value={!verified && !statusQuery.isError ? t('settings.deployment.externalStatus') : overallHealthy ? t('settings.deployment.healthy') : t('settings.deployment.needsAttention')} tone={verified && overallHealthy ? 'good' : 'warn'} />
        <OverviewCard icon={MonitorUp} label={t('settings.deployment.dashboardRelease')} value={status?.dashboard?.version ?? build?.releaseTag ?? DASHBOARD_VERSION} detail={status?.dashboard ? t('settings.deployment.generationValue', { generation: status.dashboard.generation }) : dashboardDeliveryLabel(build)} />
        <OverviewCard icon={Server} label={t('settings.deployment.runtimeRelease')} value={status?.route.activeReleaseId ?? build?.releaseTag ?? payload.versions?.host ?? '—'} detail={status ? t('settings.deployment.activeSlotValue', { slot: status.route.activeSlot }) : hostDeliveryLabel(build)} />
      </div>
      {status ? <CurrentDeployment status={status} compatible={dashboardCompatible} /> : statusQuery.isError ? <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">{t('settings.deployment.statusUnavailable')}</div> : null}
      {externalHealth && !statusQuery.isError ? <section className="mt-5 rounded-lg bg-card p-4 ring-1 ring-border/40" data-testid="settings-external-deployment">
        <h4 className="flex items-center gap-1 text-base font-semibold text-foreground">{t('settings.deployment.externalChecks')}<HelpHint label={t('settings.deployment.externalChecks')}>{t('settings.deployment.externalChecksScope')}</HelpHint></h4>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">{externalHealth.checks.map(check => <div key={check.component}><dt className="text-sm text-muted-foreground">{t(`settings.deployment.checkComponents.${check.component}`)}</dt><dd className={check.ready ? 'mt-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300' : 'mt-1 text-sm font-semibold text-amber-700 dark:text-amber-300'}>{t(check.ready ? 'settings.deployment.ready' : 'settings.deployment.needsAttention')}</dd></div>)}</dl>
        <p className="mt-4 text-sm text-muted-foreground">{t('settings.deployment.checkedAt')}: <time dateTime={externalHealth.checkedAt}>{new Date(externalHealth.checkedAt).toLocaleString()}</time></p>
      </section> : null}
      <details className="mt-5 rounded-lg border border-border/50 bg-card/40" data-testid="settings-deployment-diagnostics">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden"><ChevronRight className="h-4 w-4" /><CloudCog className="h-4 w-4 text-muted-foreground" />{t('settings.deployment.versionDiagnostics')}</summary>
        <div className="border-t border-border/50 px-4 py-4">
          <SettingsRecordList testId="settings-component-inventory">
            <SettingsRecord title={t('settings.deployment.hostRuntime')} detail={hostDeliveryLabel(build)}><SettingsRecordField label={t('settings.deployment.version')} mono>{build?.releaseTag ?? payload.versions?.host ?? '—'}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.commit')} mono>{build?.gitCommit ?? '—'}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.buildTime')} mono>{build?.builtAt ?? '—'}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.instance')} mono>{typeof window === 'undefined' ? t('settings.deployment.sameOriginHost') : window.location.host}</SettingsRecordField></SettingsRecord>
            <SettingsRecord title={t('settings.deployment.dashboardComponent')} detail={status?.dashboard ? t('settings.deployment.independentStaticRelease') : dashboardDeliveryLabel(build)}><SettingsRecordField label={t('settings.deployment.version')} mono>{status?.dashboard?.version ?? DASHBOARD_VERSION}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.releaseDigest')} mono>{shortDigest(status?.dashboard?.releaseDigest)}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.assetDigest')} mono>{shortDigest(status?.dashboard?.assetDigest)}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.protocolRange')} mono>{status?.dashboard ? `${status.dashboard.protocol.min} – ${status.dashboard.protocol.max}` : PROTOCOL_VERSION}</SettingsRecordField></SettingsRecord>
            <SettingsRecord title={t('settings.deployment.protocolComponent')} detail={t('settings.deployment.wireContract')}><SettingsRecordField label={t('settings.deployment.version')} mono>{payload.versions?.protocol ?? PROTOCOL_VERSION}</SettingsRecordField><SettingsRecordField label={t('settings.deployment.health')}>{dashboardCompatible ? t('settings.deployment.compatible') : t('settings.deployment.incompatible')}</SettingsRecordField></SettingsRecord>
          </SettingsRecordList>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/70 p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t('settings.deployment.forceDashboardRefresh')}</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.deployment.forceDashboardRefreshDetail')}</div>
            </div>
            <button
              type="button"
              onClick={() => { void forcePwaRefresh() }}
              className="flex-none rounded-md border border-border/50 bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-accent"
              data-testid="settings-force-dashboard-refresh"
            >
              {t('pwa.forceRefresh')}
            </button>
          </div>
          {payload.socketConnections ? <DiagnosticBlock title={t('settings.deployment.socketConnections')} testId="settings-socket-connections"><p>{t('settings.deployment.socketConnectionsDesc', payload.socketConnections)}</p><div className="mt-2 flex flex-wrap gap-1.5">{payload.socketConnections.namespaces.map((entry) => <code key={entry.namespace} className="rounded border border-border/50 bg-background px-2 py-1">{t('settings.deployment.namespaceConnections', { namespace: entry.namespace, sockets: entry.sockets })}</code>)}</div></DiagnosticBlock> : null}
          {payload.agentModule ? <DiagnosticBlock title={t('settings.deployment.agentModule')}><p className="font-mono">{payload.agentModule.label} · {payload.agentModule.id}@{payload.agentModule.version}</p><p className="mt-1 font-mono">prompt {payload.agentModule.systemPromptHash.slice(0, 12)} · tools {payload.agentModule.toolRegistryHash.slice(0, 12)}</p></DiagnosticBlock> : null}
        </div>
      </details>
    </div>
  )
}

function AspireLoginToken({ host, token }: { host: string; token?: string }): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const pending = useRef<AbortController>()
  useEffect(() => {
    setValue(undefined)
    setLoading(false)
    setError(false)
    return () => { pending.current?.abort() }
  }, [host, token])
  async function show(): Promise<void> {
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError(false)
    try {
      const response = await fetch(`${host.replace(/\/$/u, '')}/auth/aspire/login-token`, {
        method: 'POST', cache: 'no-store', credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      })
      if (!response.ok) throw new Error('Aspire token unavailable')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string' || !result.token) throw new Error('invalid Aspire token')
      if (!controller.signal.aborted) setValue(result.token)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  return <div className="mt-3 space-y-2" data-testid="settings-aspire-token">
    <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{t('settings.deployment.aspireToken')}</span>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => { if (value) setValue(undefined); else void show() }}>{t(value ? 'settings.deployment.aspireHideToken' : 'settings.deployment.aspireShowToken')}</Button>
    </div>
    {value ? <div className="flex min-w-0 items-center gap-2"><code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-sm" data-testid="settings-aspire-token-value">{value}</code><CopyButton value={value} /></div> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{t('settings.deployment.aspireTokenUnavailable')}</p> : null}
  </div>
}

function OverviewCard({ icon: Icon, label, value, detail, tone }: { icon: typeof Server; label: string; value: string; detail?: string; tone?: 'good' | 'warn' }): JSX.Element { return <div className="rounded-lg border border-border/50 bg-card/60 p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className={tone === 'good' ? 'h-4 w-4 text-emerald-500' : tone === 'warn' ? 'h-4 w-4 text-amber-500' : 'h-4 w-4'} />{label}</div><div className="mt-2 truncate text-sm font-semibold text-foreground" title={value}>{value}</div>{detail ? <div className="mt-1 truncate text-xs text-muted-foreground" title={detail}>{detail}</div> : null}</div> }
function CurrentDeployment({ status, compatible }: { status: DedicatedDeploymentStatus; compatible: boolean }): JSX.Element {
  const { t } = useTranslation(); const deployment = status.deployment; const admission = status.admission.pending + status.admission.leased; const continuation = deployment?.continuation; const healthy = (!deployment || deployment.phase === 'completed') && !deployment?.error && !(deployment?.blockers?.length) && admission === 0 && compatible
  return <section className="mt-5 rounded-lg border border-border/50 bg-card/40 p-4" data-testid="settings-dedicated-deployment"><div className="flex items-start justify-between gap-3"><h4 className="flex items-center gap-1 text-sm font-semibold text-foreground">{t('settings.deployment.currentDeployment')}<HelpHint label={t('settings.deployment.currentDeployment')}>{t('settings.deployment.currentDeploymentDesc')}</HelpHint></h4><span className={healthy ? 'rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300' : 'rounded-full bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300'}>{healthy ? t('settings.deployment.ready') : t('settings.deployment.needsAttention')}</span></div><div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4"><StatusFact label={t('settings.deployment.activeRuntime')} value={`${status.route.activeSlot} · ${status.route.activeReleaseId}`} /><StatusFact label={t('settings.deployment.deploymentPhase')} value={deployment?.phase ?? t('settings.deployment.idle')} /><StatusFact label={t('settings.deployment.sessionContinuation')} value={continuation ? `${continuation.completed}/${continuation.participants}` : '—'} /><StatusFact label={t('settings.deployment.admissionQueue')} value={admission === 0 ? t('settings.deployment.empty') : String(admission)} /></div>{!compatible ? <Notice>{t('settings.deployment.protocolIncompatible')}</Notice> : null}{deployment?.blockers?.length ? <Notice>{t('settings.deployment.blockersValue', { blockers: deployment.blockers.join(', ') })}</Notice> : null}{deployment?.error ? <Notice>{deployment.error.code}: {deployment.error.message}</Notice> : null}<details className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">{t('settings.deployment.technicalDetails')}</summary><div className="mt-3 grid gap-2 sm:grid-cols-2"><StatusFact label={t('settings.deployment.routeGeneration')} value={String(status.route.generation)} mono /><StatusFact label={t('settings.deployment.runtimePid')} value={String(status.slots[status.route.activeSlot].pid || '—')} mono /><StatusFact label={t('settings.deployment.writeLeasePid')} value={String(status.writeLeaseOwnerPid || '—')} mono /><StatusFact label={t('settings.deployment.supervisorPid')} value={String(status.services?.supervisor.pid || '—')} mono /><StatusFact label={t('settings.deployment.runtimeDigest')} value={shortDigest(status.slots[status.route.activeSlot].releaseDigest)} mono /><StatusFact label={t('settings.deployment.deploymentId')} value={deployment?.deploymentId ?? '—'} mono /></div></details></section>
}
function StatusFact({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element { return <div className="min-w-0"><div className="text-muted-foreground">{label}</div><div className={`mt-0.5 break-words text-foreground ${mono ? 'font-mono' : ''}`} title={value}>{value}</div></div> }
function Notice({ children }: { children: React.ReactNode }): JSX.Element { return <div className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{children}</div> }
function DiagnosticBlock({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }): JSX.Element { return <div className="mt-4 rounded-md bg-muted/30 p-3 text-xs text-muted-foreground" data-testid={testId}><div className="mb-2 font-medium text-foreground">{title}</div>{children}</div> }
function shortDigest(value: string | undefined): string { return value ? value.slice(0, 12) : '—' }
function dashboardDeliveryLabel(build: BuildMetadata | undefined): string { if (!build) return 'unknown'; if (build.dashboardMode === 'embedded') return 'embedded'; if (build.dashboardMode === 'static') return 'static'; return build.dashboardMode ?? 'none' }
function hostDeliveryLabel(build: BuildMetadata | undefined): string { if (!build) return 'local source'; if (build.artifactKind === 'native') return 'native'; return build.dashboardMode === 'embedded' ? 'portable bundle' : 'runtime-only bundle' }
function protocolCompatible(current: string, range: { min: string; max: string }): boolean { return compareVersion(current, range.min) >= 0 && compareVersion(current, range.max) <= 0 }
function compareVersion(left: string, right: string): number { const a = left.split('.').map(Number), b = right.split('.').map(Number); for (let i = 0; i < 3; i++) { const delta = (a[i] ?? 0) - (b[i] ?? 0); if (delta) return delta } return 0 }
