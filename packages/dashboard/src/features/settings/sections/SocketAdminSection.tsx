import type { DashboardClientToServerEvents, DashboardServerToClientEvents, ServerSettingsPayload } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { ScrollArea } from '../../../components/ui/scroll-area.js'
import { CopyButton, EmptyRow, SectionHeader } from '../controls.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

export function SocketAdminSection({ payload, onPayloadChange, socket }: { payload: ServerSettingsPayload; onPayloadChange(payload: ServerSettingsPayload): void; socket?: DashboardSocket }): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'development' | 'production'>(payload.socketAdmin?.configuredMode ?? payload.socketAdmin?.runtimeMode ?? 'development')
  const [error, setError] = useState<string | null>(null)
  const admin = payload.socketAdmin
  useEffect(() => {
    setMode(payload.socketAdmin?.configuredMode ?? payload.socketAdmin?.runtimeMode ?? 'development')
  }, [payload.socketAdmin?.configuredMode, payload.socketAdmin?.runtimeMode])
  const init = useMutation({
    mutationFn: async (): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/socket-admin/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, mode }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      setPassword('')
      setError(null)
      onPayloadChange(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const updateMode = useMutation({
    mutationFn: async (nextMode: 'development' | 'production'): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/socket-admin/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: nextMode }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      setError(null)
      onPayloadChange(next)
      setMode(next.socketAdmin?.configuredMode ?? next.socketAdmin?.runtimeMode ?? mode)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  if (payload.deployment?.deployment.architecture === 'platform') {
    return <PlatformSocketDiagnostics payload={payload} onPayloadChange={onPayloadChange} socket={socket} />
  }
  if (!admin) {
    return (
      <div>
        <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t('settings.socketAdmin.subtitle')} />
        <EmptyRow>{t('settings.socketAdmin.unavailable')}</EmptyRow>
      </div>
    )
  }

  function PlatformSocketDiagnostics({ payload, onPayloadChange, socket }: {
    payload: ServerSettingsPayload
    onPayloadChange(payload: ServerSettingsPayload): void
    socket?: DashboardSocket
  }): JSX.Element {
    const { t } = useTranslation()
    const [connected, setConnected] = useState(Boolean(socket?.connected))
    useEffect(() => {
      const refresh = () => setConnected(Boolean(socket?.connected))
      refresh()
      socket?.on('connect', refresh)
      socket?.on('disconnect', refresh)
      return () => {
        socket?.off('connect', refresh)
        socket?.off('disconnect', refresh)
      }
    }, [socket])
    const refresh = useMutation({
      mutationFn: async () => {
        const response = await fetch('/settings', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = await response.json() as ServerSettingsPayload
        if (!next.socketConnections) throw new Error(t('settings.socketAdmin.snapshotUnavailable'))
        return next
      },
      onSuccess: onPayloadChange,
    })
    const ping = useMutation({
      mutationFn: async () => {
        if (!socket?.connected) throw new Error(t('settings.socketAdmin.disconnected'))
        const started = performance.now()
        const serverAt = await socket.timeout(5_000).emitWithAck('client:connection_ping', Date.now())
        if (!Number.isFinite(serverAt)) throw new Error(t('settings.socketAdmin.invalidPing'))
        return Math.round(performance.now() - started)
      },
    })
    const snapshot = payload.socketConnections
    const error = refresh.error ?? ping.error
    return <div data-testid="settings-platform-socket-diagnostics">
      <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t(payload.socketAdmin?.authentication === 'gateway-owner' ? 'settings.socketAdmin.ownerDescription' : 'settings.socketAdmin.scopedDescription')} />
      <div className="space-y-4 rounded-md bg-card/60 p-4 text-sm">
        {payload.socketAdmin?.authentication === 'gateway-owner' && payload.socketAdmin.active ? (
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h4 className="text-sm font-medium text-foreground">{t('settings.socketAdmin.openTitle')}</h4>
              <div className="mt-1 flex min-w-0 items-start gap-2 break-all font-mono text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">{payload.socketAdmin.path}</span>
                <CopyButton value={new URL(payload.socketAdmin.path, window.location.origin).href} />
              </div>
            </div>
            <Button size="sm" className="flex-none" asChild><a href={payload.socketAdmin.path} target="_blank" rel="noreferrer" data-testid="settings-open-socket-admin"><ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />{t('settings.socketAdmin.open')}</a></Button>
          </div>
        ) : null}
        {payload.socketAdmin?.authentication === 'gateway-owner' && !payload.socketAdmin.active ? <p role="alert" className="text-destructive">{payload.socketAdmin.unavailableReason ?? t('settings.socketAdmin.unavailable')}</p> : null}
        {payload.socketAdmin?.authentication === 'gateway-owner' ? <p className="text-sm text-muted-foreground" data-testid="settings-socket-mode">
          {t('settings.socketAdmin.modeSummary', {
            current: t(`settings.socketAdmin.${payload.socketAdmin.runtimeMode === 'development' ? 'modeDevelopment' : 'modeProduction'}`),
            configured: t(`settings.socketAdmin.${payload.socketAdmin.configuredMode === 'development' ? 'modeDevelopment' : 'modeProduction'}`),
          })} <code>KALA_SOCKET_ADMIN_MODE</code>{payload.socketAdmin.restartRequired ? ` · ${t('settings.socketAdmin.modeSummaryRestart')}` : null}
          {payload.socketAdmin.runtimeMode === 'development' ? ` · ${t('settings.socketAdmin.modeSummaryRedacted')}` : null}
        </p> : null}
        <div>{connected ? t('settings.socketAdmin.connected') : t('settings.socketAdmin.disconnected')}</div>
        <div>{t('settings.socketAdmin.transport')}: <code>{socket?.io.engine?.transport.name ?? '—'}</code></div>
        {payload.storage ? <div className="break-all">{t('settings.socketAdmin.scope')}: <code>{payload.storage.organizationId}</code></div> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="settings-socket-refresh">{t('settings.socketAdmin.refresh')}</Button>
          <Button type="button" variant="outline" onClick={() => ping.mutate()} disabled={!connected || ping.isPending} data-testid="settings-socket-ping">{t('settings.socketAdmin.ping')}</Button>
        </div>
        {ping.data !== undefined ? <p role="status" data-testid="settings-socket-ping-result">{t('settings.socketAdmin.pingSuccess', { ms: ping.data })}</p> : null}
        {error ? <p role="alert" className="text-destructive">{error.message}</p> : null}
        {snapshot ? <>
          <p>{t('settings.socketAdmin.total')}: {snapshot.total}</p>
          <p className="text-sm text-muted-foreground">{t('settings.socketAdmin.snapshotUpdated')}: {new Date(snapshot.updatedAt).toLocaleString()}</p>
          <ScrollArea><table className="w-full text-left text-sm" data-testid="settings-socket-namespaces">
            <thead><tr>{['namespace', 'total', 'dashboard', 'executor', 'other'].map(key => <th key={key} className="p-2">{t(`settings.socketAdmin.${key}`)}</th>)}</tr></thead>
            <tbody>{snapshot.namespaces.map(entry => <tr key={entry.namespace}><td className="p-2 font-mono">{entry.namespace}</td><td>{entry.sockets}</td><td>{entry.dashboard}</td><td>{entry.executor}</td><td>{entry.other}</td></tr>)}</tbody>
          </table></ScrollArea>
        </> : <p role="status">{t('settings.socketAdmin.snapshotUnavailable')}</p>}
      </div>
    </div>
  }
  if (!admin.initialized) {
    return (
      <div>
        <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t('settings.socketAdmin.subtitle')} />
        <form
          className="space-y-4 rounded-md bg-muted/30 p-4 ring-1 ring-border/50"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            init.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.6fr)]">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-sm font-medium text-foreground"><label htmlFor="socket-admin-password">{t('settings.socketAdmin.initialPassword')}</label><HelpHint label={t('settings.socketAdmin.initialPassword')}>{t('settings.socketAdmin.initialPasswordDesc')}</HelpHint></div>
              <input
                id="socket-admin-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div className="min-w-0 text-sm font-medium text-foreground">
              <div className="flex items-center gap-1"><label htmlFor="socket-admin-initial-mode">{t('settings.socketAdmin.initialMode')}</label><HelpHint label={t('settings.socketAdmin.initialMode')}>{t('settings.socketAdmin.modeDesc')}</HelpHint></div>
              <select
                id="socket-admin-initial-mode"
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={mode}
                onChange={(event) => setMode(event.currentTarget.value === 'development' ? 'development' : 'production')}
                disabled={init.isPending}
                data-testid="settings-socket-admin-initial-mode-select"
              >
                <option value="production">{t('settings.socketAdmin.modeProduction')}</option>
                <option value="development">{t('settings.socketAdmin.modeDevelopment')}</option>
              </select>
            </div>
          </div>
          {error ? <div className="text-xs text-destructive">{error}</div> : null}
          <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={init.isPending || password.trim().length < 8}>{t('settings.socketAdmin.initialize')}</Button>
        </form>
      </div>
    )
  }
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const href = `${origin}${admin.path}`
  const configuredMode = admin.configuredMode
  return (
    <div>
      <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t('settings.socketAdmin.subtitle')} />
      {admin.restartRequired ? (
        <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300" data-testid="settings-socket-admin-restart-required">
          {t('settings.socketAdmin.modeRestartRequired', { current: admin.runtimeMode, configured: configuredMode })}
        </div>
      ) : null}
      <div className="mb-4 min-w-0 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{t('settings.socketAdmin.openTitle')}</div>
            <div className="mt-1 flex items-start gap-2 break-all font-mono text-xs text-muted-foreground" title={href}>
              <span className="min-w-0 flex-1">{href}</span>
              <CopyButton value={href} />
            </div>
          </div>
          {admin.active ? (
            <Button type="button" size="sm" className="h-8 flex-none" asChild>
              <a href={href} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.socketAdmin.open')}
              </a>
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" className="h-8 flex-none" disabled>
              <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.socketAdmin.open')}
            </Button>
          )}
        </div>
        <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
          <div>
            <div className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t('settings.socketAdmin.username')}</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="text-sm text-foreground">{admin.username}</code>
              <CopyButton value={admin.username} />
            </div>
          </div>
          <div>
            <div className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t('settings.socketAdmin.password')}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.socketAdmin.passwordHidden')}</div>
          </div>
        </div>
      </div>
      <div className="mb-4 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0">
            <label className="text-sm font-medium text-foreground" htmlFor="socket-admin-mode-select">
              {t('settings.socketAdmin.configuredMode')}
            </label>
            <select
              id="socket-admin-mode-select"
              className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value === 'development' ? 'development' : 'production')}
              disabled={updateMode.isPending}
              data-testid="settings-socket-admin-mode-select"
            >
              <option value="production">{t('settings.socketAdmin.modeProduction')}</option>
              <option value="development">{t('settings.socketAdmin.modeDevelopment')}</option>
            </select>
          </div>
          <Button type="button" size="sm" className="h-9 w-full sm:mt-7 sm:w-auto" disabled={updateMode.isPending || mode === configuredMode} onClick={() => updateMode.mutate(mode)} data-testid="settings-socket-admin-save-mode">
            {t('settings.socketAdmin.saveMode')}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('settings.socketAdmin.modeDesc')}</p>
      </div>
      {payload.socketConnections ? <div className="rounded-md bg-muted/30 p-3 text-sm" data-testid="settings-socket-connections">
        <h4 className="font-medium">{t('settings.socketAdmin.connectionAudit')}</h4>
        <p className="mt-2">{t('settings.socketAdmin.connectionAuditDesc', payload.socketConnections)}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{payload.socketConnections.namespaces.map(entry => <code key={entry.namespace} className="rounded border border-border/50 bg-background px-2 py-1">{t('settings.socketAdmin.namespaceConnections', { namespace: entry.namespace, sockets: entry.sockets })}</code>)}</div>
      </div> : null}
    </div>
  )
}
