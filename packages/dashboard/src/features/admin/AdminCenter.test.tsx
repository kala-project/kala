import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminCenter } from './AdminCenter.js'
import { i18n } from '../../i18n/index.js'
import { resources } from '../../i18n/resources.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const policySnapshot = {
  organization: { id: 'org_test', name: 'Test organization', status: 'active', runtime_unit_id: 'tenant_test' },
  role: 'owner' as const,
  permissions: ['organization:manage', 'policy:manage'],
  members: [], entitlement: { seat_limit: 20 }, retention: { session_days: 90, artifact_days: 60, audit_days: 365, deleted_resource_grace_days: 30, version: 2 }, usage: {},
  workspaces: [{ id: 'workspace_test', name: 'Test workspace', status: 'active', policy_version: 1 }], executorPools: [{ id: 'pool_test', name: 'Default pool', mode: 'shared' }], executors: [], invites: [], browserSessions: [], serviceAccounts: [], webhooks: [], audit: [], integrations: {},
}

it('keeps admin title help available without hiding access failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
  render(<AdminCenter onClose={() => {}} />)
  expect(await screen.findByText(i18n.t('admin.loadFailed'))).toBeTruthy()
  expect(screen.queryByText(i18n.t('admin.subtitle'))).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.aboutLabel', { label: i18n.t('admin.title') }) }))
  expect(screen.getByRole('tooltip').textContent).toBe(i18n.t('admin.subtitle'))
  expect(screen.getByText(i18n.t('admin.loadFailed'))).toBeTruthy()
})

it('creates a copyable invitation without asking an administrator for OIDC identifiers', async () => {
  const inviteUrl = 'https://kala.example/auth/login?invite=ak_org_invite_secret'
  const snapshot = {
    organization: { id: 'org_test', name: 'Test organization', status: 'active', runtime_unit_id: 'tenant_test' },
    role: 'owner', permissions: ['organization:manage'],
    members: [{ issuer: 'https://id.example', subject: 'owner-sub', displayName: 'Owner', email: 'owner@example.test', role: 'owner', createdAt: '2026-01-01T00:00:00Z' }],
    workspaces: [], executorPools: [], executors: [], invites: [], browserSessions: [], serviceAccounts: [], webhooks: [], audit: [], integrations: {},
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/organization/invites' && init?.method === 'POST') {
      return Response.json({ invite: { id: 'oinv_test' }, inviteUrl }, { status: 201 })
    }
    return Response.json(snapshot)
  })
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  render(<AdminCenter onClose={() => {}} />)

  fireEvent.click(await screen.findByRole('button', { name: i18n.t('admin.tabs.members') }))
  expect(screen.getByText(i18n.t('admin.inviteDeliveryNotice'))).toBeTruthy()
  expect(screen.queryByText('OIDC issuer')).toBeNull()
  fireEvent.change(screen.getByLabelText(i18n.t('admin.inviteEmail')), { target: { value: 'invitee@example.test' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.createInvite') }))

  const link = await screen.findByLabelText(i18n.t('admin.inviteLink'))
  expect((link as HTMLInputElement).value).toBe(inviteUrl)
  const createCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/organization/invites' && init?.method === 'POST')
  expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ email: 'invitee@example.test', role: 'member', expiresInDays: 7 })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.copyLink') }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(inviteUrl))
  expect(screen.getByRole('button', { name: i18n.t('admin.copied') })).toBeTruthy()
})

it('makes the organization scope, role, and first routine tasks explicit', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(policySnapshot)))
  render(<AdminCenter onClose={() => {}} />)

  expect(await screen.findByRole('heading', { name: policySnapshot.organization.name })).toBeTruthy()
  expect(screen.getByText(`${i18n.t('admin.labels.role')}: ${i18n.t('admin.roles.owner')}`)).toBeTruthy()
  expect(screen.getByText(i18n.t('admin.organizationBoundary'))).toBeTruthy()
  expect(screen.getByText(i18n.t('admin.startHereDescription'))).toBeTruthy()
  expect(screen.getByRole('button', { name: i18n.t('admin.tabs.overview') }).getAttribute('aria-current')).toBe('page')

  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.openMembers') }))
  expect(screen.getByRole('button', { name: i18n.t('admin.tabs.members') }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByLabelText(i18n.t('admin.inviteEmail'))).toBeTruthy()
})

it('identifies the deployment operator as responsible for every status-only area', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(policySnapshot)))
  render(<AdminCenter onClose={() => {}} />)

  expect(await screen.findByText(i18n.t('admin.readOnlyOperator'))).toBeTruthy()
  for (const tab of ['workspaces', 'executors', 'usage', 'integrations'] as const) {
    fireEvent.click(screen.getByRole('button', { name: i18n.t(`admin.tabs.${tab}`) }))
    expect(screen.getByText(i18n.t('admin.readOnlyOperator'))).toBeTruthy()
  }
})

it('shows view-only boundaries without exposing organization mutations', async () => {
  const snapshot = {
    ...policySnapshot,
    role: 'viewer' as const,
    permissions: [],
    members: [{ issuer: 'https://id.example', subject: 'member-sub', displayName: 'Member', email: 'member@example.test', role: 'member' }],
  }
  const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot))
  vi.stubGlobal('fetch', fetchMock)
  render(<AdminCenter onClose={() => {}} />)

  await screen.findByRole('heading', { name: snapshot.organization.name })
  expect(screen.getByText(`${i18n.t('admin.labels.role')}: ${i18n.t('admin.roles.viewer')}`)).toBeTruthy()
  expect(screen.getAllByText(i18n.t('admin.viewOnly'))).toHaveLength(2)

  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.tabs.members') }))
  expect(screen.getByText(i18n.t('admin.membersRestricted'))).toBeTruthy()
  expect((screen.getByLabelText(i18n.t('admin.memberRole')) as HTMLSelectElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: i18n.t('admin.createInvite') })).toBeNull()
  expect(screen.queryByRole('button', { name: i18n.t('admin.remove') })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.tabs.policies') }))
  expect(screen.getByText(i18n.t('admin.policyRestricted'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: i18n.t('admin.editSessionRetention') })).toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('lets an organization administrator save a per-file limit for all members', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/organization/attachment-policy' && init?.method === 'PUT') return new Response(null, { status: 204 })
    return Response.json({ ...policySnapshot, organization: { ...policySnapshot.organization, attachment_max_bytes: 2 * 1024 * 1024 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AdminCenter onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('admin.tabs.policies') }))
  fireEvent.change(screen.getByLabelText(i18n.t('attachmentPolicy.label')), { target: { value: String(8 * 1024 * 1024) } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('attachmentPolicy.save') }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/organization/attachment-policy', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ maxBytes: 8 * 1024 * 1024 }),
  })))
})

it('edits only session days and requires confirmation before applying cleanup scope', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/organization/retention' && init?.method === 'PUT') return new Response(null, { status: 204 })
    return Response.json(policySnapshot)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AdminCenter onClose={() => {}} />)

  fireEvent.click(await screen.findByRole('button', { name: i18n.t('admin.tabs.policies') }))
  expect(screen.getByText(i18n.t('admin.retentionCleanupWarning'))).toBeTruthy()
  expect(screen.getByText(i18n.t('admin.unsupportedRetentionFields'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.editSessionRetention') }))

  const input = screen.getByRole('spinbutton', { name: i18n.t('admin.labels.sessionDays') })
  expect(screen.queryByRole('spinbutton', { name: i18n.t('admin.labels.artifactDays') })).toBeNull()
  fireEvent.change(input, { target: { value: '0' } })
  expect(screen.getByRole('alert').textContent).toBe(i18n.t('admin.invalidSessionDays'))
  expect((screen.getByRole('button', { name: i18n.t('admin.reviewRetentionChange') }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.change(input, { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.reviewRetentionChange') }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(screen.getByText(i18n.t('admin.confirmRetentionWarning'))).toBeTruthy()
  expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === '/organization/retention' && init?.method === 'PUT')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.applySessionRetention') }))

  await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === '/organization/retention' && init?.method === 'PUT')).toHaveLength(1))
  const updateCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/organization/retention' && init?.method === 'PUT')
  expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ sessionDays: 7, artifactDays: 60, auditDays: 365, deletedResourceGraceDays: 30 })
})

it('provides equivalent English and Chinese retention safety guidance', () => {
  const english = resources.en.translation.admin
  const chinese = resources.zh.translation.admin
  expect(english.retentionCleanupWarning).toContain('irreversible')
  expect(english.retentionScope).toContain('deployment-wide switch')
  expect(english.unsupportedRetentionFields).toContain('backups')
  expect(chinese.retentionCleanupWarning).toContain('不可逆')
  expect(chinese.retentionScope).toContain('全局开关')
  expect(chinese.unsupportedRetentionFields).toContain('备份')
  expect(english.organizationBoundary).toContain('does not provide cross-organization')
  expect(chinese.organizationBoundary).toContain('不提供跨组织')
  expect(english.membersRestricted).toContain('do not allow')
  expect(chinese.membersRestricted).toContain('不允许')
})
