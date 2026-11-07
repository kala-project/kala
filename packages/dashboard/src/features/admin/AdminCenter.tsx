import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { ProductState } from '../../components/ui/product-state.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js'

type Row = Record<string, any>
type TFunction = ReturnType<typeof useTranslation>['t']
export type OrganizationSnapshot = { organization: Row; role: 'owner' | 'admin' | 'member' | 'viewer'; permissions: string[]; members: Row[]; entitlement?: Row; retention?: Row; usage?: Row; workspaces: Row[]; executorPools: Row[]; executors: Row[]; invites: Row[]; browserSessions: Row[]; serviceAccounts: Row[]; webhooks: Row[]; audit: Row[]; integrations: Row }
const tabs = ['overview', 'members', 'workspaces', 'executors', 'policies', 'usage', 'integrations'] as const
type AdminTab = (typeof tabs)[number]
const navigation: { label: 'manage' | 'review'; items: readonly AdminTab[] }[] = [
  { label: 'manage', items: ['overview', 'members', 'policies'] },
  { label: 'review', items: ['workspaces', 'executors', 'usage', 'integrations'] },
]

async function mutate(path: string, method: string, body?: unknown): Promise<void> {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
}

async function mutateJson<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
  return await response.json() as T
}

export function AdminCenter({ onClose }: { onClose(): void }): JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<OrganizationSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tab, setTab] = useState<AdminTab>('overview')
  const load = async (): Promise<void> => {
    setError(null)
    setActionError(null)
    try {
      const response = await fetch('/organization', { cache: 'no-store' })
      if (!response.ok) throw new Error(t('admin.loadFailed'))
      setSnapshot(await response.json())
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  useEffect(() => { void load() }, [])
  const canManage = snapshot?.permissions.includes('organization:manage') ?? false
  const canPolicy = snapshot?.permissions.includes('policy:manage') ?? false
  return <ScrollArea className="fixed inset-0 z-[71] bg-background" style={{ position: 'fixed' }} data-testid="admin-center" contentClassName="min-h-full">
    <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between border-b border-border/40 bg-background/95 px-4 backdrop-blur sm:px-6"><h1 className="font-semibold">{t('admin.title')}</h1><Button variant="ghost" onClick={onClose} className="min-h-11">{t('common.close')}</Button></header>
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{error ? <ProductState kind="forbidden" title={t('admin.unavailable')} description={error} primary={{ label: t('common.retry'), onClick: () => void load() }} /> : !snapshot ? <ProductState kind="loading" title={t('admin.loading')} description={t('admin.resolving')} /> : <>
      <div className="mb-6 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 pb-5">
        <h2 id="admin-organization-name" className="min-w-0 break-words text-xl font-semibold">{snapshot.organization.name}</h2>
        <Pill label={t('admin.labels.role')} value={t(`admin.roles.${snapshot.role}`)} />
        <Pill label={t('admin.labels.status')} value={snapshot.organization.status} tone={snapshot.organization.status === 'active' ? 'status' : undefined} />
        <HelpHint label={t('admin.organizationScope')}>{t('admin.organizationBoundary')} {t('admin.managementScope')}</HelpHint>
      </div>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
        <ScrollArea aria-label={t('admin.sections')} className="-mx-4 min-w-0 border-b border-border/40 px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:self-start lg:border-0 lg:px-0" contentClassName="flex min-w-max gap-3 pb-3 lg:min-w-0 lg:flex-col lg:gap-5 lg:pb-0" role="navigation">
          {navigation.map((group) => <div key={group.label} role="group" aria-label={t(`adminNavigation.${group.label}`)} className="flex gap-1 lg:flex-col">
            <p className="hidden px-3 text-xs font-medium text-muted-foreground lg:block">{t(`adminNavigation.${group.label}`)}</p>
            {group.items.map((item) => <Button key={item} size="sm" variant="ghost" aria-current={tab === item ? 'page' : undefined} className={`min-h-10 justify-start whitespace-nowrap px-3 lg:w-full ${tab === item ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground'}`} onClick={() => { setTab(item); setActionError(null) }}>{t(`admin.tabs.${item}`)}</Button>)}
          </div>)}
        </ScrollArea>
        <div className="min-w-0 pb-8" data-testid="admin-section-content">
      {actionError ? <p role="alert" className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{actionError}</p> : null}
      {tab === 'overview' ? <Overview snapshot={snapshot} canManage={canManage} canPolicy={canPolicy} openTab={setTab} t={t} /> : null}
      {tab === 'members' ? <Members snapshot={snapshot} canManage={canManage} load={load} setError={setActionError} t={t} /> : null}
      {tab === 'workspaces' ? <Workspaces snapshot={snapshot} t={t} /> : null}
      {tab === 'executors' ? <Executors snapshot={snapshot} t={t} /> : null}
      {tab === 'policies' ? <Policies snapshot={snapshot} canPolicy={canPolicy} load={load} setError={setActionError} t={t} /> : null}
      {tab === 'usage' ? <UsageSecurity snapshot={snapshot} t={t} /> : null}
      {tab === 'integrations' ? <Integrations snapshot={snapshot} t={t} /> : null}
        </div>
      </div>
    </>}</main>
  </ScrollArea>
}

function Overview({ snapshot, canManage, canPolicy, openTab, t }: { snapshot: OrganizationSnapshot; canManage: boolean; canPolicy: boolean; openTab(tab: AdminTab): void; t: TFunction }): JSX.Element {
  const tasks: Array<{ tab: AdminTab; title: string; description: string; label: string }> = [
    { tab: 'members', title: t('admin.peopleTask'), description: t(canManage ? 'admin.peopleTaskManage' : 'admin.peopleTaskView'), label: t('admin.openMembers') },
    { tab: 'policies', title: t('admin.retentionTask'), description: t(canPolicy ? 'admin.retentionTaskManage' : 'admin.retentionTaskView'), label: t('admin.openPolicies') },
    { tab: 'workspaces', title: t('admin.environmentTask'), description: t('admin.environmentTaskDescription'), label: t('admin.reviewStatus') },
  ]
  return <div className="space-y-6">
    <section aria-labelledby="admin-start-here"><h2 id="admin-start-here" className="mb-2 text-base font-semibold">{t('admin.startHere')}</h2><div className="divide-y divide-border/40">{tasks.map((task) => <div key={task.tab} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="flex items-center gap-1.5"><span className="text-sm font-medium">{task.title}</span><HelpHint label={task.title}>{task.description}</HelpHint></div><Button size="sm" variant="outline" onClick={() => openTab(task.tab)}>{task.label}</Button></div>)}</div></section>
    <Grid><Card title={t('admin.organizationActivity')}><KV rows={{ [t('admin.tabs.members')]: snapshot.members.length, [t('admin.pendingInvites')]: snapshot.invites.filter(isPendingInvite).length, [t('admin.tabs.workspaces')]: snapshot.workspaces.length, [t('admin.tabs.executors')]: snapshot.executors.length }} /></Card><Card title={t('admin.yourAccess')}><KV rows={{ [t('admin.memberAdministration')]: t(canManage ? 'admin.allowed' : 'admin.viewOnly'), [t('admin.retentionAdministration')]: t(canPolicy ? 'admin.allowed' : 'admin.viewOnly') }} /><div className="mt-3"><HelpHint label={t('admin.yourAccess')}>{t('admin.accessExplanation')}</HelpHint></div></Card></Grid>
    <details className="border-t border-border/40 pt-4"><summary className="cursor-pointer text-sm font-medium">{t('admin.contract')} · {t('admin.currentMonth')}</summary><Grid><Card title={t('admin.contract')}><KV rows={{ [t('admin.labels.reference')]: snapshot.entitlement?.contract_reference, [t('admin.labels.tier')]: snapshot.entitlement?.support_tier, [t('admin.labels.ends')]: snapshot.entitlement?.ends_at, [t('admin.labels.seats')]: snapshot.entitlement?.seat_limit, [t('admin.labels.concurrentSessions')]: snapshot.entitlement?.concurrent_session_limit, [t('admin.labels.monthlyTokens')]: snapshot.entitlement?.monthly_token_limit ?? t('admin.unlimited'), [t('admin.labels.runtimeUnit')]: snapshot.organization.runtime_unit_id }} /></Card><Card title={t('admin.currentMonth')}><KV rows={{ [t('admin.labels.tokens')]: snapshot.usage?.tokens, [t('admin.labels.sessions')]: snapshot.usage?.sessions, [t('admin.labels.ledger')]: snapshot.usage?.entries }} /></Card></Grid></details>
  </div>
}
function Members({ snapshot, canManage, load, setError, t }: { snapshot: OrganizationSnapshot; canManage: boolean; load(): Promise<void>; setError(value: string): void; t: TFunction }): JSX.Element {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member')
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const createInvite = async (): Promise<void> => {
    try {
      const created = await mutateJson<{ inviteUrl: string }>('/organization/invites', 'POST', { email, role, expiresInDays })
      setInviteUrl(created.inviteUrl); setCopied(false); setEmail(''); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const copyLink = async (): Promise<void> => {
    if (!inviteUrl) return
    try { await navigator.clipboard.writeText(inviteUrl); setCopied(true) } catch { setError(t('admin.copyFailed')) }
  }
  return <div className="grid gap-5">
    <Card title={t('admin.tabs.members')}>{!canManage ? <RestrictedNotice text={t('admin.membersRestricted')} /> : null}{snapshot.members.length ? snapshot.members.map((member) => <Line key={`${member.issuer}:${member.subject}`} title={member.displayName || member.email || member.subject} subtitle={member.displayName && member.email && member.displayName !== member.email ? member.email : undefined} right={<div className="flex flex-wrap justify-end gap-2"><select aria-label={`${t('admin.memberRole')}: ${member.displayName || member.email || member.subject}`} disabled={!canManage || member.role === 'owner'} value={member.role} onChange={(event) => void mutate('/organization/members', 'PATCH', { issuer: member.issuer, subject: member.subject, role: event.target.value }).then(load).catch((reason) => setError(String(reason)))} className="h-9 max-w-full rounded border border-border/50 bg-background px-2 text-sm">{(['admin', 'member', 'viewer', 'owner'] as const).map((role) => <option key={role} value={role}>{t(`admin.roles.${role}`)}</option>)}</select>{canManage && member.role !== 'owner' ? <Button size="sm" variant="destructive" onClick={() => void mutate('/organization/members', 'DELETE', { issuer: member.issuer, subject: member.subject }).then(load).catch((reason) => setError(String(reason)))}>{t('admin.remove')}</Button> : null}</div>} />) : <Empty title={t('admin.emptyMembersTitle')} text={t('admin.emptyMembersDescription')} />}</Card>
    <Card title={t('adminNavigation.invitations')}>{canManage ? <div className="mb-4 grid gap-3 rounded-lg bg-muted/30 p-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
      <label className="grid gap-1 text-sm"><span>{t('admin.inviteEmail')}</span><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="rounded border border-border/50 bg-background px-3 py-2" /></label>
      <label className="grid gap-1 text-sm"><span>{t('admin.inviteRole')}</span><select value={role} onChange={(event) => setRole(event.target.value as typeof role)} className="rounded border border-border/50 bg-background px-3 py-2">{(['admin', 'member', 'viewer'] as const).map((value) => <option key={value} value={value}>{t(`admin.roles.${value}`)}</option>)}</select></label>
      <label className="grid gap-1 text-sm"><span>{t('admin.inviteDays')}</span><input type="number" min={1} max={30} value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} className="w-24 rounded border border-border/50 bg-background px-3 py-2" /></label>
      <Button className="self-end" disabled={!email.trim() || expiresInDays < 1 || expiresInDays > 30} onClick={() => void createInvite()}>{t('admin.createInvite')}</Button>
    </div> : null}
    <p className="mb-3 text-xs leading-5 text-muted-foreground">{t(canManage ? 'admin.inviteDeliveryNotice' : 'admin.invitesRestricted')}</p>
    {inviteUrl ? <div className="mb-4 flex gap-2"><input aria-label={t('admin.inviteLink')} readOnly value={inviteUrl} className="min-w-0 flex-1 rounded border border-border/50 bg-muted px-3 py-2 text-sm" /><Button size="sm" onClick={() => void copyLink()}>{t(copied ? 'admin.copied' : 'admin.copyLink')}</Button></div> : null}
    {snapshot.invites.length ? snapshot.invites.map((invite) => <Line key={invite.id} title={invite.email} subtitle={`${invite.role} · ${inviteStatus(invite, t)} · ${t('admin.expires', { value: invite.expiresAt })}`} right={canManage && isPendingInvite(invite) ? <Button size="sm" variant="destructive" onClick={() => void mutate(`/organization/invites/${invite.id}`, 'DELETE').then(load).catch((reason) => setError(String(reason)))}>{t('admin.revokeInvite')}</Button> : undefined} />) : <Empty title={t('admin.emptyInvitesTitle')} text={t('admin.noInvites')} />}</Card>
  </div>
}
function Workspaces({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <div className="grid gap-3"><ReadOnlyNotice t={t} /><Grid><Card title={t('admin.tabs.workspaces')}>{snapshot.workspaces.length ? snapshot.workspaces.map((workspace) => <Line key={workspace.id} title={workspace.name} subtitle={`${workspace.status} · policy v${workspace.policy_version}`} />) : <Empty title={t('admin.emptyWorkspacesTitle')} text={t('admin.noWorkspaces')} />}</Card><Card title={t('admin.executorPools')}>{snapshot.executorPools.length ? snapshot.executorPools.map((pool) => <Line key={pool.id} title={pool.name} subtitle={`${pool.mode}${pool.workspace_id ? ` · ${pool.workspace_id}` : ''}`} />) : <Empty title={t('admin.emptyPoolsTitle')} text={t('admin.emptyPoolsDescription')} />}</Card></Grid></div> }
function Executors({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <div className="grid gap-3"><ReadOnlyNotice t={t} /><Card title={t('admin.tabs.executors')}>{snapshot.executors.length ? snapshot.executors.map((executor) => <Line key={executor.id} title={executor.name} subtitle={`${executor.status} · ${t('admin.lastSeen', { value: executor.last_seen_at || t('admin.never') })}`} />) : <Empty title={t('admin.emptyExecutorsTitle')} text={t('admin.noExecutors')} />}</Card></div> }
function Policies({ snapshot, canPolicy, load, setError, t }: { snapshot: OrganizationSnapshot; canPolicy: boolean; load(): Promise<void>; setError(value: string): void; t: TFunction }): JSX.Element {
  const [attachmentMaxBytes, setAttachmentMaxBytes] = useState(Number(snapshot.organization.attachment_max_bytes ?? 2 * 1024 * 1024))
  const [savingAttachment, setSavingAttachment] = useState(false)
  const saveAttachment = async (): Promise<void> => {
    setSavingAttachment(true)
    try {
      await mutate('/organization/attachment-policy', 'PUT', { maxBytes: attachmentMaxBytes })
      await load()
      window.dispatchEvent(new Event('kala:attachment-policy-updated'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setSavingAttachment(false) }
  }
  const currentSessionDays = Number(snapshot.retention?.session_days)
  const canEditSessionDays = canPolicy && Number.isSafeInteger(currentSessionDays) && currentSessionDays >= 1
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(Number.isFinite(currentSessionDays) ? currentSessionDays : ''))
  const [pendingSessionDays, setPendingSessionDays] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const parsedDraft = Number(draft)
  const validDraft = Number.isSafeInteger(parsedDraft) && parsedDraft >= 1
  const reviewChange = (): void => {
    if (!validDraft || parsedDraft === currentSessionDays) return
    setPendingSessionDays(parsedDraft)
  }
  const saveRetention = async (): Promise<void> => {
    if (pendingSessionDays === null) return
    setSaving(true)
    try {
      await mutate('/organization/retention', 'PUT', {
        sessionDays: pendingSessionDays,
        artifactDays: snapshot.retention?.artifact_days,
        auditDays: snapshot.retention?.audit_days,
        deletedResourceGraceDays: snapshot.retention?.deleted_resource_grace_days,
      })
      setEditing(false)
      setPendingSessionDays(null)
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setSaving(false) }
  }
  const cancelEdit = (): void => {
    setDraft(String(currentSessionDays))
    setEditing(false)
  }
  return <div className="space-y-4">
    <Card title={t('attachmentPolicy.title')} action={<HelpHint label={t('attachmentPolicy.title')}>{t('attachmentPolicy.scope')}</HelpHint>}>
      {!canPolicy ? <RestrictedNotice text={t('attachmentPolicy.restricted')} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="admin-attachment-limit" className="text-sm">{t('attachmentPolicy.label')}</label>
        <select id="admin-attachment-limit" disabled={!canPolicy || savingAttachment} value={attachmentMaxBytes} onChange={(event) => setAttachmentMaxBytes(Number(event.target.value))} className="h-9 rounded border border-border/50 bg-background px-2 text-sm">
          {[2, 4, 8, 16].map((mib) => <option key={mib} value={mib * 1024 * 1024}>{mib} MiB</option>)}
        </select>
        {canPolicy ? <Button size="sm" disabled={savingAttachment || attachmentMaxBytes === Number(snapshot.organization.attachment_max_bytes ?? 2 * 1024 * 1024)} onClick={() => void saveAttachment()}>{t('attachmentPolicy.save')}</Button> : null}
      </div>
    </Card>
    <Card title={t('admin.retention')} action={<div className="flex items-center gap-2"><HelpHint label={t('admin.retention')}>{t('admin.retentionScope')}</HelpHint>{canEditSessionDays && !editing ? <Button size="sm" onClick={() => setEditing(true)}>{t('admin.editSessionRetention')}</Button> : null}</div>}>
      {!canPolicy ? <RestrictedNotice text={t('admin.policyRestricted')} /> : null}
      <KV rows={{ [t('admin.labels.sessionDays')]: snapshot.retention?.session_days }} />
      {editing ? <div className="mt-4 grid gap-3 rounded-lg bg-muted/30 p-4">
        <label className="grid gap-1 text-sm" htmlFor="admin-session-retention-days"><span>{t('admin.labels.sessionDays')}</span><Input id="admin-session-retention-days" type="number" min={1} step={1} value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby="admin-session-retention-boundary" /></label>
        <p id="admin-session-retention-boundary" className="text-xs text-muted-foreground">{t('admin.sessionDaysBoundary')}</p>
        {!validDraft ? <p role="alert" className="text-xs text-destructive">{t('admin.invalidSessionDays')}</p> : null}
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-foreground">{t('admin.retentionCleanupWarning')}</p>
        <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={cancelEdit}>{t('common.cancel')}</Button><Button size="sm" disabled={!validDraft || parsedDraft === currentSessionDays} onClick={reviewChange}>{t('admin.reviewRetentionChange')}</Button></div>
      </div> : null}
      <details className="mt-4 border-t border-border/40 pt-4"><summary className="cursor-pointer text-sm font-medium">{t('admin.unsupportedRetentionTitle')}</summary><div className="mt-3"><KV rows={{ [t('admin.labels.artifactDays')]: snapshot.retention?.artifact_days, [t('admin.labels.auditDays')]: snapshot.retention?.audit_days, [t('admin.labels.deletedGrace')]: snapshot.retention?.deleted_resource_grace_days, [t('admin.labels.version')]: snapshot.retention?.version }} /><p className="mt-2 text-sm text-muted-foreground">{t('admin.unsupportedRetentionFields')}</p></div></details>
    </Card>
    <AlertDialog open={pendingSessionDays !== null} onOpenChange={(open) => { if (!open && !saving) setPendingSessionDays(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('admin.confirmRetentionTitle')}</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-3"><p>{t('admin.confirmRetentionChange', { current: currentSessionDays, next: pendingSessionDays })}</p><p className="font-medium text-destructive">{t('admin.confirmRetentionWarning')}</p><p>{t('admin.retentionScope')}</p></div></AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={saving}>{t('common.cancel')}</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={() => void saveRetention()}>{t('admin.applySessionRetention')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
function UsageSecurity({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <div className="grid gap-3"><ReadOnlyNotice t={t} /><Grid><Card title={t('admin.browserSessions')}>{snapshot.browserSessions.length ? snapshot.browserSessions.map((session) => <Line key={session.id} title={session.device?.browser || 'Browser'} subtitle={`${t('admin.lastActive', { value: session.last_seen_at })}${session.revoked_at ? ` · ${t('admin.revoked')}` : ''}`} />) : <Empty title={t('admin.emptyActivityTitle')} text={t('admin.emptyBrowserSessions')} />}</Card><Card title={t('admin.serviceAccounts')}>{snapshot.serviceAccounts.length ? snapshot.serviceAccounts.map((account) => <Line key={account.id} title={account.display_name || account.email || account.id} subtitle={(account.scopes || []).join(', ')} />) : <Empty title={t('admin.emptyConfigurationTitle')} text={t('admin.noServiceAccounts')} />}</Card><Card title={t('admin.webhooks')}>{snapshot.webhooks.length ? snapshot.webhooks.map((webhook) => <Line key={webhook.id} title={webhook.url} subtitle={`${t(webhook.enabled ? 'admin.enabled' : 'admin.disabled')} · ${(webhook.topics || []).join(', ')}`} />) : <Empty title={t('admin.emptyConfigurationTitle')} text={t('admin.noWebhooks')} />}</Card><Card title={t('admin.auditLog')}>{snapshot.audit.length ? snapshot.audit.map((event) => <Line key={event.id} title={event.action} subtitle={`${event.result} · ${event.occurred_at}`} />) : <Empty title={t('admin.emptyActivityTitle')} text={t('admin.noAudit')} />}</Card></Grid></div> }
function Integrations({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <Card title={t('admin.adapters')}><ReadOnlyNotice t={t} /><KV rows={{ [t('admin.labels.secrets')]: snapshot.integrations?.secrets, [t('admin.labels.artifacts')]: snapshot.integrations?.artifacts, [t('admin.labels.telemetry')]: t(snapshot.integrations?.telemetry ? 'admin.connected' : 'admin.notConfigured'), [t('admin.labels.errorReporting')]: t(snapshot.integrations?.errorReporting ? 'admin.connected' : 'admin.notConfigured'), [t('admin.labels.ticketing')]: t(snapshot.integrations?.ticketing ? 'admin.connected' : 'admin.notConfigured') }} /><p className="mt-3 text-xs text-muted-foreground">{t('admin.adaptersDescription')}</p></Card> }

function isPendingInvite(invite: Row): boolean { return !invite.acceptedAt && !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now() }
function inviteStatus(invite: Row, t: TFunction): string {
  if (invite.acceptedAt) return t('admin.accepted')
  if (invite.revokedAt) return t('admin.revoked')
  if (Date.parse(invite.expiresAt) <= Date.now()) return t('admin.expired')
  return t('admin.pending')
}
function Grid({ children }: { children: React.ReactNode }): JSX.Element { return <div className="grid gap-4 md:grid-cols-2">{children}</div> }
function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element { return <section className="min-w-0 rounded-xl bg-card/60 p-4 sm:p-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{action}</div>{children}</section> }
function Line({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }): JSX.Element { return <div className="flex flex-col gap-3 border-t border-border/50 py-3 first:border-0 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="break-words text-sm font-medium">{title}</div>{subtitle ? <div className="break-words text-xs text-muted-foreground">{subtitle}</div> : null}</div>{right ? <div className="shrink-0">{right}</div> : null}</div> }
function KV({ rows }: { rows: Record<string, unknown> }): JSX.Element { return <dl className="grid gap-2 text-sm">{Object.entries(rows).map(([key, value]) => <div key={key} className="flex items-start justify-between gap-4"><dt className="min-w-0 text-muted-foreground">{key}</dt><dd className="min-w-0 break-words text-right [overflow-wrap:anywhere]">{String(value ?? '—')}</dd></div>)}</dl> }
function Pill({ label, value, tone }: { label: string; value: unknown; tone?: 'status' }): JSX.Element { return <span className={`rounded-full px-3 py-1 text-xs font-medium ${tone === 'status' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted/60 text-foreground'}`}>{label}: {String(value ?? '—')}</span> }
function Empty({ title, text }: { title: string; text: string }): JSX.Element { return <div className="py-5 text-center"><p className="text-sm font-medium">{title}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">{text}</p></div> }
function RestrictedNotice({ text }: { text: string }): JSX.Element { return <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">{text}</p> }
function ReadOnlyNotice({ t }: { t: TFunction }): JSX.Element { return <p className="mb-3 text-sm text-muted-foreground">{t('admin.readOnlyOperator')}</p> }
