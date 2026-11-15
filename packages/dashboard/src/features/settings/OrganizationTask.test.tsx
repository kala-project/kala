import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { OrganizationTask } from './OrganizationTask.js'
import { i18n } from '../../i18n/index.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const tag = (revision: number) => `"${String(revision).repeat(43)}"`
const read = (revision: number, days: number) => Response.json({
  resource: { kind: 'retention', id: 'org-a', organizationId: 'org-a' }, revision: String(revision), capabilities: [],
  value: { sessionDays: days, artifactDays: 90, auditDays: 365, deletedResourceGraceDays: 30 },
  application: { state: 'unknown', desiredRevision: String(revision), effectiveRevision: null, applyMode: 'immediate', scope: 'organization' },
}, { headers: { etag: tag(revision) } })
function mount(policyPage: 'attachments' | 'retention' = 'retention', canConfigurePolicy = true): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<StrictMode><QueryClientProvider client={client}><OrganizationTask section="policies" policyPage={policyPage} canConfigurePolicy={canConfigurePolicy}
    cacheNamespace="authority-a" organizationId="org-a" role="owner" onWorkspace={() => {}} /></QueryClientProvider></StrictMode>)
  return client
}
async function draft(days: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('admin.editSessionRetention') }))
  fireEvent.change(screen.getByLabelText(i18n.t('admin.labels.sessionDays')), { target: { value: days } })
}
function save(): void {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('admin.reviewRetentionChange') }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: i18n.t('admin.applySessionRetention') }))
}

it('retains the shown retention draft and precondition after conflict until a confirmed explicit reload', async () => {
  let revision = 1
  const request = vi.fn(async (_path: string, init?: RequestInit) => init?.method === 'PUT'
    ? new Response('{}', { status: 412 }) : read(revision, revision === 1 ? 30 : 60))
  vi.stubGlobal('fetch', request)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  mount()
  await draft('45')
  revision = 2
  save()
  await screen.findByText(i18n.t('unifiedSettings.configuration.conflict'))
  expect(new Headers(request.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]?.headers).get('if-match')).toBe(tag(1))
  expect((screen.getByLabelText(i18n.t('admin.labels.sessionDays')) as HTMLInputElement).value).toBe('45')
  const reload = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.configuration.reload') }))
  const before = request.mock.calls.length
  reload()
  expect(request).toHaveBeenCalledTimes(before)
  confirm.mockReturnValue(true)
  reload()
  await screen.findByRole('button', { name: i18n.t('admin.editSessionRetention') })
  await draft('75')
  request.mockImplementation(async (_path, init) => init?.method === 'PUT' ? new Response('{}', { status: 412 }) : read(2, 60))
  save()
  await waitFor(() => expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2))
  expect(new Headers(request.mock.calls.filter(([, init]) => init?.method === 'PUT')[1]?.[1]?.headers).get('if-match')).toBe(tag(2))
})

it('does not silently rebase a retained policy draft when another writer wins the post-commit readback', async () => {
  let committed = false
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { committed = true; return new Response(null, { status: 204 }) }
    return committed ? read(3, 60) : read(1, 30)
  })
  vi.stubGlobal('fetch', request)
  mount()
  await draft('45')
  save()
  await screen.findByText(i18n.t('unifiedSettings.configuration.conflict'))
  expect((screen.getByLabelText(i18n.t('admin.labels.sessionDays')) as HTMLInputElement).value).toBe('45')
  save()
  await screen.findByText('configuration_refresh_required')
  expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
})

it('fences lost policy responses without replay and preserves the draft when explicit reconstruction also fails', async () => {
  let unavailable = false
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { unavailable = true; throw new Error('fixture response loss') }
    if (unavailable) throw new Error('fixture reconstruction unavailable')
    return read(1, 30)
  })
  vi.stubGlobal('fetch', request)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  mount()
  await draft('45')
  save()
  await screen.findByText(i18n.t('unifiedSettings.configuration.outcome-unknown'))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.configuration.reload') }))
  await screen.findByText('Error: fixture reconstruction unavailable')
  expect((screen.getByLabelText(i18n.t('admin.labels.sessionDays')) as HTMLInputElement).value).toBe('45')
  expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
})

it('does not turn a readable policy into an editable one merely because the role is Owner', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => read(1, 30)))
  mount('retention', false)
  await screen.findByText(i18n.t('admin.policyRestricted'))
  expect(screen.queryByRole('button', { name: i18n.t('admin.editSessionRetention') })).toBeNull()
})

it('pairs attachment drafts with their displayed authoritative ETag and requires explicit conflict reconstruction', async () => {
  let revision = 1, maxBytes = 2 * 1024 * 1024
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (new Headers(init.headers).get('if-match') !== tag(revision)) return new Response('{}', { status: 412 })
      maxBytes = JSON.parse(String(init.body)).maxBytes; revision++
      return new Response(null, { status: 204 })
    }
    return Response.json({ resource: { kind: 'attachment-policy', id: 'org-a', organizationId: 'org-a' },
      revision: String(revision), capabilities: [], value: { maxBytes },
      application: { state: 'unknown', desiredRevision: String(revision), effectiveRevision: null, applyMode: 'immediate', scope: 'organization' } },
    { headers: { etag: tag(revision) } })
  })
  vi.stubGlobal('fetch', request)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  mount('attachments')
  const select = await screen.findByLabelText(i18n.t('attachmentPolicy.label'))
  fireEvent.change(select, { target: { value: String(8 * 1024 * 1024) } })
  revision = 2; maxBytes = 4 * 1024 * 1024
  fireEvent.click(screen.getByRole('button', { name: i18n.t('attachmentPolicy.save') }))
  await screen.findByText(i18n.t('unifiedSettings.configuration.conflict'))
  expect((select as HTMLSelectElement).value).toBe(String(8 * 1024 * 1024))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.configuration.reload') }))
  await waitFor(() => expect((screen.getByLabelText(i18n.t('attachmentPolicy.label')) as HTMLSelectElement).value).toBe(String(4 * 1024 * 1024)))
  fireEvent.change(screen.getByLabelText(i18n.t('attachmentPolicy.label')), { target: { value: String(16 * 1024 * 1024) } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('attachmentPolicy.save') }))
  await waitFor(() => expect((screen.getByRole('button', { name: i18n.t('attachmentPolicy.save') }) as HTMLButtonElement).disabled).toBe(true))
  expect(maxBytes).toBe(16 * 1024 * 1024)
  expect(revision).toBe(3)
  expect(request.mock.calls.every(([path]) => ['/organization/attachment-policy/configuration', '/organization/attachment-policy'].includes(path))).toBe(true)
})
