import type { AttachedExecutor } from '@agent-kernel/shared'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { EmptyRow, SectionHeader } from '../controls.js'

type McpServer = {
  name: string
  command: string
  args: string[]
}

type McpSettings = {
  supported: boolean
  note?: string
  workspaceId: string
  servers: Array<{ name: string }>
}

type ServerDraft = {
  name: string
  command: string
  args: string
}

type RequestIssue = {
  kind: 'authentication' | 'forbidden' | 'unavailable' | 'error'
  detail: string
  localized?: boolean
}

function issueForStatus(status: number, detail: string): RequestIssue {
  if (status === 401) return { kind: 'authentication', detail: 'authentication', localized: true }
  if (status === 403) return { kind: 'forbidden', detail: 'forbidden', localized: true }
  if (status === 409) return { kind: 'unavailable', detail: detail === 'workspace_offline' ? 'offline' : ['unmanaged_workspace', 'unmanaged_executor'].includes(detail) ? 'unmanaged' : 'unavailable', localized: true }
  if (status === 502) return { kind: 'error', detail: 'executorFailure', localized: true }
  return { kind: 'error', detail: 'error', localized: true }
}

async function issueFromResponse(response: Response): Promise<RequestIssue> {
  let detail = ''
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string') detail = body.error
  } catch { /* Do not expose raw service details to the page. */ }
  return issueForStatus(response.status, detail)
}

function draftsFromServers(servers: readonly { name: string }[]): ServerDraft[] {
  // Commands and args can include credentials; the Host deliberately never returns them.
  return servers.map(({ name }) => ({ name, command: '', args: '[]' }))
}

export function McpSection({ executors = [], token }: { executors?: readonly AttachedExecutor[]; token?: string }): JSX.Element {
  const { t } = useTranslation()
  const workspaces = useMemo(() => {
    const unique = new Map<string, string>()
    for (const executor of executors) {
      if (!unique.has(executor.workspaceId)) unique.set(executor.workspaceId, executor.workspaceName || executor.workspaceId)
    }
    return [...unique].map(([id, name]) => ({ id, name }))
  }, [executors])
  const [workspaceId, setWorkspaceId] = useState(() => workspaces[0]?.id ?? '')
  const [settings, setSettings] = useState<McpSettings | null>(null)
  const [drafts, setDrafts] = useState<ServerDraft[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState<RequestIssue | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (workspaces.some((workspace) => workspace.id === workspaceId)) return
    setWorkspaceId(workspaces[0]?.id ?? '')
  }, [workspaces, workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      setSettings(null)
      setDrafts([])
      setIssue(null)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      setSettings(null)
      setDrafts([])
      setIssue(null)
      setSaved(false)
      setConfirmed(false)
      try {
        const response = await fetch(`/settings/mcp?workspaceId=${encodeURIComponent(workspaceId)}`, {
          cache: 'no-store',
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          signal: controller.signal,
        })
        if (!response.ok) {
          const problem = await issueFromResponse(response)
          if (!controller.signal.aborted) setIssue(problem)
          return
        }
        const next = await response.json() as McpSettings
        if (!controller.signal.aborted) {
          setSettings(next)
          setDrafts(draftsFromServers(next.servers))
        }
      } catch {
        if (!controller.signal.aborted) setIssue({ kind: 'error', detail: 'error', localized: true })
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [workspaceId, token])

  const updateDraft = (index: number, field: keyof ServerDraft, value: string): void => {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, [field]: value } : draft))
    setSaved(false)
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!workspaceId || !settings?.supported || !confirmed) return

    const servers: McpServer[] = []
    for (const draft of drafts) {
      if (!draft.name.trim() || !draft.command.trim()) {
        setIssue({ kind: 'error', detail: t('settings.mcp.requiredFields') })
        return
      }
      try {
        const args = JSON.parse(draft.args) as unknown
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error()
        servers.push({ name: draft.name.trim(), command: draft.command.trim(), args })
      } catch {
        setIssue({ kind: 'error', detail: t('settings.mcp.invalidArgs', { name: draft.name.trim() || t('settings.mcp.unnamedServer') }) })
        return
      }
    }

    setSaving(true)
    setIssue(null)
    setSaved(false)
    try {
      const response = await fetch('/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ workspaceId, servers }),
      })
      if (!response.ok) {
        const problem = await issueFromResponse(response)
        setIssue(problem)
        if (problem.kind === 'authentication' || problem.kind === 'forbidden') {
          setSettings(null)
          setDrafts([])
        }
        return
      }
      const next = await response.json() as McpSettings
      setSettings(next)
      setDrafts(draftsFromServers(next.servers))
      setConfirmed(false)
      setSaved(true)
    } catch {
      setIssue({ kind: 'error', detail: 'error', localized: true })
    } finally {
      setSaving(false)
    }
  }

  const issueTitle = issue ? t(`settings.mcp.errors.${issue.kind}`) : ''

  return (
    <div className="min-w-0" data-testid="settings-mcp-section">
      <SectionHeader title={t('settings.sections.mcp.label')} subtitle={t('settings.mcp.subtitle')} />

      {workspaces.length === 0 ? (
        <EmptyRow>{t('settings.mcp.noOnlineWorkspaces')}</EmptyRow>
      ) : (
        <div className="min-w-0 space-y-4">
          <div className="min-w-0 rounded-xl bg-card/65 p-4 ring-1 ring-border/40">
            <label className="block text-sm font-medium" htmlFor="settings-mcp-workspace">{t('settings.mcp.workspace')}</label>
            <select
              id="settings-mcp-workspace"
              className="mt-2 h-9 w-full min-w-0 rounded-md border border-border/50 px-3 text-sm"
              value={workspaceId}
              disabled={loading || saving}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id})</option>)}
            </select>
          </div>

          {loading ? <p className="text-sm text-muted-foreground" role="status">{t('settings.mcp.loading')}</p> : null}

          {!loading && issue && settings === null ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert">
              <div className="font-medium text-destructive">{issueTitle}</div>
              <p className="mt-1 break-words text-sm text-muted-foreground">{issue.localized ? t(`settings.mcp.errorDetails.${issue.detail}`) : issue.detail}</p>
              {issue.kind === 'authentication' ? <p className="mt-2 text-sm text-muted-foreground">{t('settings.mcp.localConfiguration')}</p> : null}
            </div>
          ) : null}

          {!loading && settings && !settings.supported ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" role="status">
              <div className="font-medium">{t('settings.mcp.unsupported')}</div>
              <p className="mt-1 break-words text-sm text-muted-foreground">{settings.note || t('settings.mcp.unsupportedDescription')}</p>
            </div>
          ) : null}

          {!loading && settings?.supported ? (
            <form className="min-w-0 space-y-4" onSubmit={(event) => { void save(event) }}>
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" data-testid="settings-mcp-warning">
                <div className="font-semibold text-foreground">{t('settings.mcp.warningTitle')}</div>
                <p className="mt-1 text-muted-foreground">{t('settings.mcp.warning')}</p>
              </div>

              <p className="text-sm text-muted-foreground">{t('settings.mcp.reenterDetails')}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium">{t('settings.mcp.servers')}</h4>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setDrafts((current) => [...current, { name: '', command: '', args: '[]' }])
                    setSaved(false)
                  }}
                  data-testid="settings-mcp-add-server"
                >
                  <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />{t('settings.mcp.addServer')}
                </Button>
              </div>

              {drafts.length === 0 ? <EmptyRow>{t('settings.mcp.noServers')}</EmptyRow> : null}

              <div className="grid min-w-0 gap-3">
                {drafts.map((draft, index) => (
                  <fieldset key={index} className="min-w-0 space-y-3 rounded-xl bg-card/65 p-4 ring-1 ring-border/40" data-testid="settings-mcp-server">
                    <legend className="sr-only">{t('settings.mcp.serverLegend', { number: index + 1 })}</legend>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <label className="min-w-0 text-sm font-medium">
                        {t('settings.mcp.name')}
                        <input className="mt-1 h-9 w-full min-w-0 rounded-md border border-border/50 px-3 text-sm" value={draft.name} disabled={saving} onChange={(event) => updateDraft(index, 'name', event.target.value)} aria-label={t('settings.mcp.nameNumber', { number: index + 1 })} />
                      </label>
                      <label className="min-w-0 text-sm font-medium">
                        {t('settings.mcp.command')}
                        <input className="mt-1 h-9 w-full min-w-0 rounded-md border border-border/50 px-3 font-mono text-sm" value={draft.command} disabled={saving} onChange={(event) => updateDraft(index, 'command', event.target.value)} aria-label={t('settings.mcp.commandNumber', { number: index + 1 })} />
                      </label>
                    </div>
                    <div className="min-w-0 text-sm font-medium">
                      <div className="flex items-center gap-1"><label htmlFor={`settings-mcp-args-${index}`}>{t('settings.mcp.args')}</label><HelpHint label={t('settings.mcp.args')}>{t('settings.mcp.argsHint')}</HelpHint></div>
                      <textarea id={`settings-mcp-args-${index}`} className="mt-1 min-h-24 w-full min-w-0 resize-y rounded-md border border-border/50 px-3 py-2 font-mono text-sm" value={draft.args} disabled={saving} onChange={(event) => updateDraft(index, 'args', event.target.value)} aria-label={t('settings.mcp.argsNumber', { number: index + 1 })} spellCheck={false} />
                    </div>
                    <Button type="button" variant="outline" disabled={saving} onClick={() => { setDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index)); setSaved(false) }} aria-label={t('settings.mcp.removeServerNumber', { number: index + 1 })}>
                      <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />{t('settings.mcp.removeServer')}
                    </Button>
                  </fieldset>
                ))}
              </div>

              <label className="flex items-start gap-2 rounded-xl bg-muted/25 p-3 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4 flex-none" checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>{t('settings.mcp.confirmExecution')}</span>
              </label>

              {issue ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3" role="alert">
                  <div className="font-medium text-destructive">{issueTitle}</div>
                  <p className="mt-1 break-words text-sm text-muted-foreground">{issue.localized ? t(`settings.mcp.errorDetails.${issue.detail}`) : issue.detail}</p>
                  {issue.kind === 'authentication' ? <p className="mt-2 text-sm text-muted-foreground">{t('settings.mcp.localConfiguration')}</p> : null}
                </div>
              ) : null}
              {saved ? <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">{t('settings.mcp.saved')}</p> : null}

              <Button type="submit" disabled={saving || !confirmed} data-testid="settings-mcp-save">
                {saving ? t('settings.mcp.saving') : t('settings.mcp.save')}
              </Button>
            </form>
          ) : null}
        </div>
      )}
    </div>
  )
}
