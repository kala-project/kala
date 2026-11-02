import type { AttachedExecutor, ExecutorInviteSummary, ServerExecutorInvitePayload, ServerExecutorInvitesPayload } from '@agent-kernel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { cn } from '../../../lib/utils.js'
import { CopyButton, EmptyRow, SectionHeader } from '../controls.js'
import { executorSetupCommand, formatDate, meaningfulInviteLabel, responseError } from '../section-utils.js'

export function ExecutorAccessSection({ executors = [], canManage = true, cacheNamespace = 'default' }: { executors?: readonly AttachedExecutor[]; canManage?: boolean; cacheNamespace?: string }): JSX.Element {
  const { t } = useTranslation()
  return <div>
    <SectionHeader title={t('settings.sections.executorAccess.label')} subtitle={t('settings.executorAccess.subtitle')} />
    <section className="mb-5" aria-labelledby="connected-workspaces-heading">
      <h4 id="connected-workspaces-heading" className="flex items-center gap-1 text-sm font-semibold text-foreground">{t('settings.executorAccess.connectedTitle')}<HelpHint label={t('settings.executorAccess.connectedTitle')}>{t('settings.executorAccess.connectedDesc')}</HelpHint></h4>
      {executors.length === 0 ? <EmptyRow>{t('settings.executorAccess.noConnected')}</EmptyRow> : <div className="mt-3 space-y-2" data-testid="settings-connected-executors">{executors.map(executor => <ConnectedWorkspace key={executor.executorId} executor={executor} />)}</div>}
    </section>
    {canManage ? <ExecutorInviteManagement key={cacheNamespace} executors={executors} cacheNamespace={cacheNamespace} /> : null}
  </div>
}

function ExecutorInviteManagement({ executors, cacheNamespace }: { executors: readonly AttachedExecutor[]; cacheNamespace: string }): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [plainInvite, setPlainInvite] = useState<ServerExecutorInvitePayload | null>(null)
  const [copyMode, setCopyMode] = useState<'command' | 'token'>('command')
  const [error, setError] = useState<string | null>(null)

  const invitesQuery = useQuery({
    queryKey: ['executor-invites', cacheNamespace],
    queryFn: async (): Promise<ServerExecutorInvitesPayload> => {
      const res = await fetch('/auth/executor-invites', { cache: 'no-store' })
      const body = await res.json() as ServerExecutorInvitesPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerExecutorInvitesPayload
    },
  })

  const createInvite = useMutation({
    mutationFn: async (): Promise<ServerExecutorInvitePayload> => {
      const input = { ...(label.trim() ? { label: label.trim() } : {}), ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}) }
      const res = await fetch('/auth/executor-invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json() as ServerExecutorInvitePayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerExecutorInvitePayload
    },
    onSuccess: (invite) => {
      setPlainInvite(invite)
      setLabel('')
      setWorkspaceId('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const patchInvite = useMutation({
    mutationFn: async (input: { id: string; label: string }): Promise<void> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: input.label }),
      })
      if (!res.ok) throw new Error(await responseError(res))
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const revokeInvite = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
      if (!res.ok) throw new Error(await responseError(res))
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deleteInvite = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await responseError(res))
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const regenerateInvite = useMutation({
    mutationFn: async (id: string): Promise<ServerExecutorInvitePayload> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(id)}/regenerate`, { method: 'POST' })
      const body = await res.json() as ServerExecutorInvitePayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerExecutorInvitePayload
    },
    onSuccess: (invite) => {
      setPlainInvite(invite)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const busy = createInvite.isPending || patchInvite.isPending || revokeInvite.isPending || deleteInvite.isPending || regenerateInvite.isPending
  const invites = invitesQuery.data?.invites ?? []
  const inviteCopyValue = plainInvite
    ? copyMode === 'command'
      ? executorSetupCommand(plainInvite.inviteToken)
      : plainInvite.inviteToken
    : ''

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    createInvite.mutate()
  }

  const saveLabel = (invite: ExecutorInviteSummary): void => {
    if (!Object.prototype.hasOwnProperty.call(editing, invite.id)) return
    const next = editing[invite.id] ?? ''
    setError(null)
    patchInvite.mutate({ id: invite.id, label: next })
  }

  return (
    <div>
      <h4 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">{t('settings.executorAccess.invitesTitle')}<HelpHint label={t('settings.executorAccess.invitesTitle')}>{t('settings.executorAccess.plaintextNotice')}</HelpHint></h4>
      <form onSubmit={submit} className="mb-4 max-w-full min-w-0 rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="grid min-w-0 gap-3 xl:grid-cols-2">
          <label className="min-w-0 text-sm font-medium text-foreground">
            {t('settings.executorAccess.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('settings.executorAccess.labelPlaceholder')}
              disabled={busy}
            />
          </label>
          <label className="min-w-0 text-sm font-medium text-foreground">
            {t('settings.executorAccess.workspaceId')}
            <select className="mt-1 h-9 w-full min-w-0 max-w-full rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={busy}>
              <option value="">{t('settings.executorAccess.workspacePlaceholder')}</option>
              {[...new Map(executors.map((executor) => [executor.workspaceId, executor])).values()].map((executor) => <option key={executor.workspaceId} value={executor.workspaceId}>{executor.workspaceName}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-3 flex min-w-0 justify-end">
          <Button type="submit" className="h-9 w-full sm:w-auto" disabled={busy}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.executorAccess.create')}
          </Button>
        </div>
        {error ? <div className="mt-2 text-sm text-destructive" role="alert">{error}</div> : null}
      </form>
      {plainInvite ? (
        <div className="mb-4 min-w-0 rounded-md bg-primary/5 px-3 py-2 ring-1 ring-primary/30">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">{t('settings.executorAccess.plaintextTitle')}</div>
            <select
              value={copyMode}
              onChange={(event) => setCopyMode(event.target.value === 'token' ? 'token' : 'command')}
              className="h-9 rounded-md bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50"
              aria-label={t('settings.executorAccess.copyMode')}
            >
              <option value="command">{t('settings.executorAccess.copyCommand')}</option>
              <option value="token">{t('settings.executorAccess.copyToken')}</option>
            </select>
          </div>
          <div className="mt-1 flex items-start gap-2 rounded bg-background px-2 py-1.5 font-mono text-sm ring-1 ring-border/50">
            <span className="min-w-0 flex-1 break-all" title={inviteCopyValue}>{inviteCopyValue}</span>
            <CopyButton value={inviteCopyValue} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{t('settings.executorAccess.plaintextNotice')}</p>
        </div>
      ) : null}
      {invitesQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : invites.length === 0 ? (
        <EmptyRow>{t('settings.executorAccess.empty')}</EmptyRow>
      ) : (
        <div className="space-y-2" data-testid="executor-invite-list">
          {invites.map((invite) => {
            const labelValue = meaningfulInviteLabel(invite.label) ?? ''
            const workspace = executors.find(executor => executor.workspaceId === invite.workspaceId)
            const title = workspace?.workspaceName ?? (labelValue || t(invite.workspaceId ? 'settings.executorAccess.boundInvite' : 'settings.executorAccess.unboundInvite'))
            const expired = Date.parse(invite.expiresAt) <= Date.now()
            const canDelete = !invite.workspaceId || invite.revoked || expired
            const subtitle = invite.workspaceId
              ? invite.workspaceId
              : t('settings.executorAccess.waitingForFirstUse')
            return (
              <article key={invite.id} className="min-w-0 max-w-full rounded-xl bg-card/65 p-4 ring-1 ring-border/40" data-testid="executor-invite-row">
                <div className="grid min-w-0 gap-4">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="min-w-0 break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]" title={title}>
                          {title}
                        </div>
                        <div className="mt-0.5 min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]" title={subtitle}>
                          {subtitle}
                        </div>
                      </div>
                      <span className={cn('rounded px-1.5 py-0.5 text-xs ring-1', invite.revoked || expired ? 'bg-destructive/10 text-destructive ring-destructive/40' : 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300')}>
                        {invite.revoked ? t('settings.executorAccess.revoked') : expired ? t('settings.executorAccess.expired') : t('settings.executorAccess.inviteActive')}
                      </span>
                    </div>
                    <label className="block max-w-md text-sm font-medium text-muted-foreground">
                      {t('settings.executorAccess.label')}
                      <input
                        className="mt-1 h-8 w-full rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50 disabled:opacity-70"
                        value={editing[invite.id] ?? labelValue}
                        onChange={(event) => setEditing((prev) => ({ ...prev, [invite.id]: event.target.value }))}
                        onBlur={() => saveLabel(invite)}
                        placeholder={t('settings.executorAccess.optionalLabelPlaceholder')}
                        aria-label={t('settings.executorAccess.label')}
                        disabled={busy || invite.revoked}
                      />
                    </label>
                    <div className="grid min-w-0 gap-3 text-sm text-muted-foreground sm:grid-cols-2">
                      <InviteMeta label={t('settings.executorAccess.inviteId')} value={invite.id.slice(0, 12)} mono />
                      <InviteMeta label={t('settings.executorAccess.created')} value={formatDate(invite.createdAt)} />
                      <InviteMeta label={t('settings.executorAccess.expires')} value={formatDate(invite.expiresAt)} />
                      <InviteMeta label={t('settings.executorAccess.lastUsed')} value={invite.lastUsedAt ? formatDate(invite.lastUsedAt) : t('settings.executorAccess.never')} />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap justify-end gap-2 border-t border-border/40 pt-3">
                    <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => regenerateInvite.mutate(invite.id)} disabled={busy} aria-label={t('settings.executorAccess.regenerate')}>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t('settings.executorAccess.regenerate')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-destructive" onClick={() => canDelete ? deleteInvite.mutate(invite.id) : revokeInvite.mutate(invite.id)} disabled={busy} aria-label={canDelete ? t('settings.executorAccess.delete') : t('settings.executorAccess.revoke')}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {canDelete ? t('settings.executorAccess.delete') : t('settings.executorAccess.revoke')}
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConnectedWorkspace({ executor }: { executor: AttachedExecutor }): JSX.Element {
  const { t } = useTranslation()
  const runtime = executor.runtime === 'node' ? 'Node.js' : executor.runtime === 'browser-webcontainer' ? 'Browser WebContainer' : executor.runtime
  const instance = [executor.hostname, `${runtime} ${executor.runtimeVersion}`, executor.os].filter(Boolean).join(' · ')
  return (
    <details className="rounded-lg border border-border/50 bg-card/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="truncate text-sm font-medium text-foreground">{executor.workspaceName}</span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{instance}</div>
        </div>
        <div className="flex flex-none items-center gap-2 text-xs text-muted-foreground">
          <span>{executor.executorVersion ?? t('settings.deployment.notReported')}</span>
          <ChevronRight className="h-4 w-4" />
        </div>
      </summary>
      <div className="grid gap-2 border-t border-border/50 px-4 py-3 text-xs sm:grid-cols-2">
        <InviteMeta label={t('settings.deployment.workspace')} value={executor.workspaceId} mono />
        <InviteMeta label={t('settings.deployment.executor')} value={executor.executorId} mono />
        <InviteMeta label={t('settings.deployment.executorProtocol')} value={executor.clientVersion ?? '—'} mono />
        <InviteMeta label={t('settings.deployment.attachedAt')} value={formatDate(executor.attachedAt)} />
      </div>
    </details>
  )
}

function InviteMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-caption uppercase tracking-wide text-muted-foreground/80">{label}</div>
      <div className={cn('mt-0.5 break-words text-foreground [overflow-wrap:anywhere]', mono && 'break-all font-mono')} title={value}>{value}</div>
    </div>
  )
}
