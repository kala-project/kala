import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useState, type FormEvent } from 'react'
import { CalendarClock, Pencil, ShieldCheck, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { AttachedExecutor, ExecutorIdentitySummary, ServerExecutorIdentitiesPayload, ServerSettingsPayload, SessionSummary } from '@agent-kernel/shared'

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
} from '../../components/ui/dialog.js'
import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  workspaceId: string
  workspaceName?: string
  executor?: AttachedExecutor
  sessions: readonly SessionSummary[]
  onRename?(workspaceName: string): void
  onOpenSession?(sessionId: string): void
  onManageScheduledTasks?(): void
}

export function WorkspaceMetadataDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  executor,
  sessions,
  onRename,
  onOpenSession,
  onManageScheduledTasks,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const displayName = workspaceName ?? executor?.workspaceName ?? ''
  const [draft, setDraft] = useState(displayName)
  const [activeTab, setActiveTab] = useState<'overview' | 'sessions' | 'runtime'>('overview')
  useEffect(() => {
    if (open) {
      setDraft(displayName)
      setActiveTab('overview')
    }
  }, [displayName, open])

  const identitiesQuery = useQuery({
    queryKey: ['executor-identities'],
    queryFn: async (): Promise<ServerExecutorIdentitiesPayload> => {
      const res = await fetch('/auth/executor-identities', { cache: 'no-store' })
      if (!res.ok) throw new Error(await res.text())
      return (await res.json()) as ServerExecutorIdentitiesPayload
    },
    enabled: open && workspaceId.length > 0,
    staleTime: 15_000,
  })
  const identity: ExecutorIdentitySummary | null =
    identitiesQuery.data?.identities.find((entry) => entry.workspaceId === workspaceId) ?? null
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async (): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings', { cache: 'no-store' })
      if (!res.ok) throw new Error(await res.text())
      return (await res.json()) as ServerSettingsPayload
    },
    enabled: open,
    staleTime: 30_000,
  })

  const revokeMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const params = new URLSearchParams({ workspaceId })
      const res = await fetch(`/auth/executor-identities?${params.toString()}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
    },
    onSuccess: () => {
      queryClient.setQueryData<ServerExecutorIdentitiesPayload>(['executor-identities'], (prev) => {
        if (!prev) return prev
        return { ...prev, identities: prev.identities.filter((entry) => entry.workspaceId !== workspaceId) }
      })
    },
  })
  const revoking = revokeMutation.isPending
  const recentSessions = [...sessions]
    .sort((a, b) => Date.parse(b.lastEventAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.createdAt))
    .slice(0, 4)
  const identityError =
    (revokeMutation.error as Error | undefined)?.message ??
    (identitiesQuery.error as Error | undefined)?.message ??
    null

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0 || trimmed === displayName) return
    onRename?.(trimmed)
  }
  const revokeIdentity = (): void => {
    if (workspaceId.length === 0) return
    revokeMutation.mutate()
  }
  const rows: Array<[string, string]> = [
    [t('workspaceMetadata.hostVersion'), settingsQuery.data?.versions?.host ?? '—'],
    [t('workspaceMetadata.executorVersion'), executor?.executorVersion ?? '—'],
    [t('workspaceMetadata.protocolVersion'), executor?.clientVersion ?? settingsQuery.data?.versions?.protocol ?? '—'],
    [t('workspaceMetadata.runtime'), executor ? `${executor.runtime} ${executor.runtimeVersion}` : '—'],
    [
      t('workspaceMetadata.sandboxRoots'),
      executor?.sandboxRoots && executor.sandboxRoots.length > 0
        ? executor.sandboxRoots.join(', ')
        : t('workspaceMetadata.trustsWholeMachine'),
    ],
    [t('workspaceMetadata.executorId'), executor?.executorId ?? t('workspaceMetadata.notAttached')],
    [
      t('workspaceMetadata.startedAt'),
      executor?.startedAt ? new Date(executor.startedAt).toLocaleString() : '—',
    ],
    [t('workspaceMetadata.pid'), executor?.pid ? String(executor.pid) : '—'],
  ]
  const activeSessions = sessions.filter((session) => session.status === 'thinking' || session.status === 'executing_tools').length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          dialogMobileSheetClassName,
          'h-[min(calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1rem),48rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 gap-0',
        )}
        data-testid="workspace-metadata-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle className="flex items-center gap-1">{displayName || t('workspaceMetadata.workspace')}<HelpHint label={t('workspaceMetadata.workspace')}>{t('workspaceMetadata.description')}</HelpHint></DialogTitle>
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <ScrollArea className="mt-3 max-w-full" role="tablist" aria-label={t('workspaceMetadata.tabs.label')} data-testid="workspace-metadata-tabs" contentClassName="flex gap-1 min-w-full w-max">
            {(['overview', 'sessions', 'runtime'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={cn('min-h-9 flex-none rounded-md px-3 text-sm font-medium transition-colors', activeTab === tab ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
                data-testid={`workspace-metadata-${tab}-tab`}
                onClick={() => setActiveTab(tab)}
              >
                {t(`workspaceMetadata.tabs.${tab}`)}
              </button>
            ))}
          </ScrollArea>
        </DialogHeader>
        <DialogBody className="min-w-0" contentClassName="space-y-4 px-3 py-3 sm:px-5 sm:py-4" data-testid="workspace-metadata-body">
          {activeTab === 'overview' ? (
          <>
          <section className="grid gap-3 sm:grid-cols-3" data-testid="workspace-home-summary">
            <WorkspaceHomeMetric label={t('workspaceMetadata.home.status')} value={executor ? t('workspaceMetadata.home.online') : t('workspaceMetadata.home.offline')} tone={executor ? 'good' : 'neutral'} />
            <WorkspaceHomeMetric label={t('workspaceMetadata.home.sessions')} value={String(sessions.length)} tone={sessions.length ? 'info' : 'neutral'} />
            <WorkspaceHomeMetric label={t('workspaceMetadata.home.sandboxRoots')} value={String(executor?.sandboxRoots?.length ?? 0)} tone={executor?.sandboxRoots?.length ? 'good' : 'neutral'} />
          </section>
          {onManageScheduledTasks ? (
            <section className="flex flex-col gap-3 rounded-md border border-border/50 bg-card p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="workspace-scheduled-tasks-card">
              <div>
                <p className="text-sm font-medium">Scheduled tasks</p>
                <p className="mt-1 text-xs text-muted-foreground">Run a prompt on a schedule in a fresh Session for this workspace.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onManageScheduledTasks}>
                <CalendarClock className="mr-1.5 h-4 w-4" aria-hidden />
                Manage tasks
              </Button>
            </section>
          ) : null}
          <form onSubmit={submit} className="rounded-md border border-border/50 bg-card p-3" data-testid="workspace-metadata-rename-form">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="workspace-display-name">
              {t('workspaceMetadata.displayName')}
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="workspace-display-name"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border/50 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                data-testid="workspace-metadata-name-input"
              />
              <Button type="submit" size="sm" className="sm:flex-none" disabled={draft.trim().length === 0 || draft.trim() === displayName} data-testid="workspace-metadata-rename-button">
                <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('workspaceMetadata.rename')}
              </Button>
            </div>
          </form>
          <section className="rounded-md border border-border/50 bg-card p-3" data-testid="workspace-identity-card">
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {identity ? <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />}
                  {t('workspaceMetadata.executorIdentity')}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {identity
                    ? t('workspaceMetadata.identityBound', { lastSeen: identity.lastSeenAt ? new Date(identity.lastSeenAt).toLocaleString() : t('workspaceMetadata.neverSeen') })
                    : t('workspaceMetadata.identityNotBound')}
                </p>
                {identityError ? <p className="mt-2 text-xs text-destructive">{identityError}</p> : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!identity || revoking}
                onClick={() => revokeIdentity()}
                data-testid="workspace-revoke-identity-button"
              >
                <ShieldOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {revoking ? t('workspaceMetadata.revokingIdentity') : t('workspaceMetadata.revokeIdentity')}
              </Button>
            </div>
          </section>
          <section className="overflow-hidden rounded-md border border-border/50 bg-card" data-testid="workspace-overview-details">
            <dl className="divide-y divide-border/50">
              <WorkspaceOverviewRow label={t('workspaceMetadata.overview.identity')} value={workspaceId} mono />
              <WorkspaceOverviewRow label={t('workspaceMetadata.overview.location')} value={executor?.defaultCwd ?? executor?.sandboxRoots?.[0] ?? '—'} mono />
              <WorkspaceOverviewRow label={t('workspaceMetadata.overview.connection')} value={executor ? t('workspaceMetadata.home.online') : t('workspaceMetadata.home.offline')} />
              <WorkspaceOverviewRow label={t('workspaceMetadata.os')} value={executor?.os ?? '—'} />
              <WorkspaceOverviewRow label={t('workspaceMetadata.hostname')} value={executor?.hostname ?? '—'} mono />
            </dl>
          </section>
          </>
          ) : activeTab === 'sessions' ? (
          <section className="grid gap-3" data-testid="workspace-session-list">
            <div className="flex items-end justify-between gap-3">
              <div><h3 className="font-medium">{t('workspaceMetadata.sessionList')}</h3><p className="text-xs text-muted-foreground">{t('workspaceMetadata.sessionListDescription')}</p></div>
              <span className="text-xs text-muted-foreground">{t('workspaceMetadata.activeSessions', { count: activeSessions })}</span>
            </div>
            {recentSessions.length ? (
              <div className="grid gap-2">
                {recentSessions.map((session) => {
                  const content = (
                    <>
                      <span className="block truncate text-sm font-medium">{session.label ?? session.firstUserMessage ?? session.sessionId}</span>
                      <span className="mt-1 block truncate text-caption text-muted-foreground">{session.status ?? 'idle'} · {session.eventCount} events · {new Date(session.lastEventAt ?? session.createdAt).toLocaleString()}</span>
                    </>
                  )
                  return onOpenSession ? (
                    <button key={session.sessionId} type="button" onClick={() => { onOpenChange(false); onOpenSession(session.sessionId) }} className="min-w-0 rounded-lg border border-border/45 bg-card px-3 py-2 text-left hover:bg-muted/30" data-testid="workspace-session-item">{content}</button>
                  ) : (
                    <div key={session.sessionId} className="min-w-0 rounded-lg border border-border/45 bg-card px-3 py-2" data-testid="workspace-session-item">{content}</div>
                  )
                })}
              </div>
            ) : <div className="rounded-md border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">{t('workspaceMetadata.noSessions')}</div>}
            {!onOpenSession ? <p className="text-caption text-muted-foreground">{t('workspaceMetadata.readOnlySessions')}</p> : null}
          </section>
          ) : (
          <section className="overflow-hidden rounded-md border border-border/50 bg-card" data-testid="workspace-technical-details">
            <div className="bg-muted/10">
              <dl className="divide-y divide-border/50 sm:hidden" data-testid="workspace-metadata-mobile-values">
                {rows.map(([label, value]) => (
                  <div key={label} className="min-w-0 px-3 py-2">
                    <dt className="text-caption font-medium text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
              <table className="hidden w-full text-sm sm:table">
                <tbody>
                  {rows.map(([label, value], i) => (
                    <tr key={label} className={i !== rows.length - 1 ? 'border-b border-border/50' : ''}>
                      <th className="w-44 border-r border-border/50 bg-muted/50 px-3 py-2 text-left font-medium">{label}</th>
                      <td className="break-all px-3 py-2 font-mono text-xs">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceOverviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return <div className="grid gap-1 px-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-baseline"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className={cn('min-w-0 break-all text-sm', mono && 'font-mono text-xs')}>{value}</dd></div>
}

function WorkspaceHomeMetric({ label, value, tone }: { label: string; value: string; tone: 'neutral' | 'good' | 'info' }): JSX.Element {
  return (
    <div className="rounded-2xl border border-border/45 bg-card/80 p-3">
      <div className="text-caption font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={tone === 'good' ? 'mt-2 truncate text-lg font-semibold text-emerald-600 dark:text-emerald-400' : tone === 'info' ? 'mt-2 truncate text-lg font-semibold text-sky-600 dark:text-sky-400' : 'mt-2 truncate text-lg font-semibold text-foreground'}>{value}</div>
    </div>
  )
}
