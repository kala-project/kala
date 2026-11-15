import { useState } from 'react'
import { WorkspaceMcpPatchSchema, type McpPatchOperation } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button.js'
import { useSettingsRequest } from '../configuration-request.js'

export type McpPatchSettings = {
  supported: boolean; workspaceId: string; servers: { name: string }[]
  revision: string; editProtocol: 'patch-v1'; requestId: string; editToken: string
}
type Draft = { name: string; action: 'keep' | 'replace' | 'delete'; command: string; args: string; existing: boolean }

export function McpPatchEditor({ settings, token, onSaved }: { settings: McpPatchSettings; token?: string; onSaved(): void }): JSX.Element {
  const { t } = useTranslation()
  const request = useSettingsRequest()
  const [drafts, setDrafts] = useState<Draft[]>(() => settings.servers.map(server => ({ ...server, existing: true, action: 'keep', command: '', args: '[]' })))
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [unknown, setUnknown] = useState(false)
  const change = (index: number, patch: Partial<Draft>): void => setDrafts(current => current.map((draft, item) => item === index ? { ...draft, ...patch } : draft))
  const save = async (): Promise<void> => {
    if (busy || !confirmed || unknown) return
    let operations: McpPatchOperation[]
    try {
      operations = drafts.filter(draft => draft.action !== 'keep').map(draft => draft.action === 'delete'
        ? { op: 'delete', name: draft.name }
        : { op: 'replace', name: draft.name, command: draft.command, args: JSON.parse(draft.args) as string[] })
      const request = WorkspaceMcpPatchSchema.parse({ workspaceId: settings.workspaceId,
        requestId: settings.requestId, editToken: settings.editToken, expectedRevision: settings.revision, operations })
      // Strict parsing is shared with the Host and Executor; only declared fields are sent.
      operations = request.operations
    } catch { setError(t('unifiedSettings.mcp.invalid')); return }
    setBusy(true); setError(undefined)
    try {
      const response = await request('/settings/mcp', { method: 'PATCH', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ workspaceId: settings.workspaceId, requestId: settings.requestId, editToken: settings.editToken, expectedRevision: settings.revision, operations }) })
      if (!response.ok) {
        if (response.status === 504) { setUnknown(true); setError(t('unifiedSettings.mcp.unknown')); return }
        const result = await response.json() as { error?: string }
        setError(response.status === 412 ? t('unifiedSettings.mcp.conflict') : result.error ?? `HTTP ${response.status}`)
        return
      }
      onSaved()
    } catch { setUnknown(true); setError(t('unifiedSettings.mcp.unknown')) }
    finally { setBusy(false) }
  }
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save() }} data-testid="settings-mcp-patch">
    <p className="text-sm text-muted-foreground">{t('unifiedSettings.mcp.preserve')}</p>
    <p className="text-xs text-muted-foreground">{t('unifiedSettings.mcp.revision', { revision: settings.revision })}</p>
    {drafts.map((draft, index) => <fieldset key={`${index}:${draft.existing}`} disabled={busy || unknown} className="grid gap-3 rounded-lg border border-border/60 p-4">
      <legend className="break-all text-sm font-medium">{draft.existing ? draft.name : t('settings.mcp.addServer')}</legend>
      <label className="grid gap-1 text-sm">{t('settings.mcp.name')}<input readOnly={draft.existing} value={draft.name} onChange={event => change(index, { name: event.target.value })} className="min-h-11 w-full rounded border border-border/60 bg-background px-3" /></label>
      <label className="grid gap-1 text-sm">{t('unifiedSettings.mcp.action')}<select value={draft.action} onChange={event => change(index, { action: event.target.value as Draft['action'] })} className="min-h-11 w-full rounded border border-border/60 bg-background px-3">{(draft.existing ? ['keep', 'replace', 'delete'] as const : ['replace'] as const).map(action => <option key={action} value={action}>{t(`unifiedSettings.mcp.${action}`)}</option>)}</select></label>
      {draft.action === 'replace' ? <>
        <label className="grid gap-1 text-sm">{t('settings.mcp.command')}<input autoComplete="off" value={draft.command} onChange={event => change(index, { command: event.target.value })} className="min-h-11 w-full rounded border border-border/60 bg-background px-3 font-mono" /></label>
        <label className="grid gap-1 text-sm">{t('settings.mcp.args')}<textarea autoComplete="off" value={draft.args} onChange={event => change(index, { args: event.target.value })} className="min-h-24 w-full rounded border border-border/60 bg-background p-3 font-mono" /></label>
      </> : null}
      {!draft.existing ? <Button variant="outline" type="button" onClick={() => setDrafts(current => current.filter((_, item) => item !== index))}>{t('settings.mcp.removeServer')}</Button> : null}
    </fieldset>)}
    <Button type="button" variant="outline" disabled={busy || unknown} onClick={() => setDrafts(current => [...current, { name: '', command: '', args: '[]', action: 'replace', existing: false }])}>{t('settings.mcp.addServer')}</Button>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || unknown} onChange={event => setConfirmed(event.target.checked)} /><span>{t('settings.mcp.confirmExecution')} {t('unifiedSettings.mcp.rename')}</span></label>
    {error ? <div role="alert" className="space-y-2 break-words text-sm text-destructive"><p>{error}</p><Button variant="outline" type="button" onClick={() => { if (window.confirm(t('unifiedSettings.mcp.reloadWarning'))) onSaved() }}>{t('unifiedSettings.mcp.reload')}</Button></div> : null}
    <Button type="submit" disabled={busy || unknown || !confirmed || !drafts.some(draft => draft.action !== 'keep')}>{t('settings.mcp.save')}</Button>
  </form>
}
