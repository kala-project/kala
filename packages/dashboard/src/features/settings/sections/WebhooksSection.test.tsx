import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '../../../i18n/index.js'
import { WebhooksSection } from './WebhooksSection.js'

const etag = `"${'a'.repeat(43)}"`
const endpoint = { organizationId: 'org_fixture', id: 'webhook_fixture', url: 'https://receiver.test/events',
  topics: ['organization.provisioned'], enabled: true, revision: '1', etag,
  secretBindingId: 'binding_fixture', configurationError: null }
const keyPage = { organizationId: 'org_fixture', bindings: [{ id: 'binding_fixture', label: 'Reviewed binding', configured: true }] }
const projection = (rows = [endpoint]) => ({ organizationId: 'org_fixture', endpoints: rows, topics: ['organization.provisioned'],
  enabledCount: String(rows.filter(row => row.enabled).length), blocked: false })
const label = (key: string) => i18n.t(`unifiedSettings.webhooks.${key}`)
const mutations = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => init?.method)
beforeEach(async () => { await i18n.changeLanguage('en') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function edit(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: label('edit') }))
}

it('sends only changed fields with the selected endpoint ETag, and never reconstructs its secret reference', async () => {
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => init?.method
    ? Response.json({ ...endpoint, enabled: false, revision: '2', etag: `"${'b'.repeat(43)}"` })
    : Response.json(path.includes('secret-bindings') ? keyPage : projection()))
  vi.stubGlobal('fetch', fetcher)
  render(<WebhooksSection organizationId="org_fixture" readOnly={false} />)
  await edit()
  fireEvent.click(screen.getByLabelText(label('enabled')))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await waitFor(() => expect(mutations(fetcher)).toHaveLength(1))
  const [path, init] = mutations(fetcher)[0]!
  expect(path).toBe('/organization/webhooks/webhook_fixture')
  expect(init).toMatchObject({ method: 'PATCH', headers: { 'if-match': etag } })
  expect(JSON.parse(init.body)).toEqual({ enabled: false })
  await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('common.save') })).toHaveProperty('disabled', true))
})

it('keeps a conflicted draft until a confirmed successful read and refuses duplicate saves', async () => {
  let release!: (response: Response) => void
  let failedRead = false
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => init?.method
    ? new Promise<Response>(resolve => { release = resolve })
    : Response.json(path.includes('secret-bindings') ? keyPage : projection(), { status: failedRead ? 503 : 200 }))
  vi.stubGlobal('fetch', fetcher)
  render(<WebhooksSection organizationId="org_fixture" readOnly={false} />)
  await edit()
  const input = screen.getByLabelText(label('url'))
  fireEvent.change(input, { target: { value: 'https://receiver.test/retained' } })
  const form = input.closest('form')!
  fireEvent.submit(form); fireEvent.submit(form)
  await waitFor(() => expect(mutations(fetcher)).toHaveLength(1))
  release(Response.json({ error: 'configuration_conflict' }, { status: 412 }))
  await screen.findByText(i18n.t('unifiedSettings.configuration.conflict'))
  expect(input).toHaveProperty('value', 'https://receiver.test/retained')
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const reload = screen.getByRole('button', { name: i18n.t('unifiedSettings.configuration.reload') })
  const requests = fetcher.mock.calls.length
  fireEvent.click(reload)
  expect(fetcher).toHaveBeenCalledTimes(requests)
  confirm.mockReturnValue(true); failedRead = true
  fireEvent.click(reload)
  await screen.findByText(label('unavailable'))
  expect(input).toHaveProperty('value', 'https://receiver.test/retained')
  expect(screen.getByRole('button', { name: i18n.t('common.save') })).toHaveProperty('disabled', true)
  failedRead = false
  fireEvent.click(reload)
  await waitFor(() => expect(input).toHaveProperty('value', ''))
  expect(mutations(fetcher)).toHaveLength(1)
})

it('creates with a binding ID and registered topics, retaining a response-lost draft without automatic replay', async () => {
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => init?.method
    ? new Response('', { status: 201 })
    : Response.json(path.includes('secret-bindings') ? keyPage : projection([])))
  vi.stubGlobal('fetch', fetcher)
  render(<WebhooksSection organizationId="org_fixture" readOnly={false} />)
  await screen.findByRole('button', { name: label('create') })
  fireEvent.change(screen.getByLabelText(label('url')), { target: { value: endpoint.url } })
  fireEvent.change(screen.getByLabelText(label('binding')), { target: { value: 'binding_fixture' } })
  fireEvent.click(screen.getByLabelText('organization.provisioned'))
  fireEvent.click(screen.getByLabelText(label('enabled')))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await screen.findByText(i18n.t('unifiedSettings.configuration.outcome-unknown'))
  expect(screen.getByLabelText(label('url'))).toHaveProperty('value', endpoint.url)
  expect(mutations(fetcher)).toHaveLength(1)
  expect(mutations(fetcher)[0]).toMatchObject(['/organization/webhooks', { method: 'POST' }])
  expect(JSON.parse(mutations(fetcher)[0]![1].body)).toEqual({
    url: endpoint.url, secretBindingId: 'binding_fixture', topics: ['organization.provisioned'], enabled: true,
  })
})

it('allows legacy-topic disable without replacing topics and visibly rejects an unreadable 4xx body', async () => {
  const legacy = { ...endpoint, topics: ['legacy.unregistered'] }
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => init?.method
    ? new Response('', { status: 400 })
    : Response.json(path.includes('secret-bindings') ? keyPage : projection([legacy])))
  vi.stubGlobal('fetch', fetcher)
  render(<WebhooksSection organizationId="org_fixture" readOnly={false} />)
  await edit()
  fireEvent.click(screen.getByLabelText(label('enabled')))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await screen.findByText(label('rejected'))
  expect(JSON.parse(mutations(fetcher)[0]![1].body)).toEqual({ enabled: false })
  expect(screen.getByLabelText(label('enabled'))).toHaveProperty('checked', false)
})

it('does not expose foreign organization readback', async () => {
  const fetcher = vi.fn(async (path: string) => Response.json(path.includes('secret-bindings')
    ? { ...keyPage, organizationId: 'org_foreign' } : projection()))
  vi.stubGlobal('fetch', fetcher)
  render(<WebhooksSection organizationId="org_fixture" readOnly={false} />)
  await screen.findByText(label('unavailable'))
  expect(screen.queryByRole('button', { name: label('edit') })).toBeNull()
  expect(mutations(fetcher)).toHaveLength(0)
})

it('rejects a foreign successful receipt as unknown without replacing the local draft', async () => {
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => Response.json(init?.method
    ? { ...endpoint, organizationId: 'org_foreign', enabled: false }
    : path.includes('secret-bindings') ? keyPage : projection()))
  vi.stubGlobal('fetch', fetcher)
  render(<WebhooksSection organizationId="org_fixture" readOnly={false} />)
  await edit()
  fireEvent.click(screen.getByLabelText(label('enabled')))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }))
  await screen.findByText(i18n.t('unifiedSettings.configuration.outcome-unknown'))
  expect(screen.getByLabelText(label('enabled'))).toHaveProperty('checked', false)
  expect(mutations(fetcher)).toHaveLength(1)
})
