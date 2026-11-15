import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ServiceAccountsSection } from './ServiceAccountsSection.js'
import { i18n } from '../../../i18n/index.js'

const page = { items: [], limits: { scopes: ['organization:read'], maxNameLength: 200, defaultExpirationMs: 90 * 86_400_000, maxExpirationMs: 365 * 86_400_000 } }
beforeEach(async () => { await i18n.changeLanguage('en') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function submit(): Promise<void> {
  await screen.findByRole('button', { name: 'Create service account' })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Automation' } })
  fireEvent.click(screen.getByLabelText('organization:read'))
  fireEvent.click(screen.getByRole('button', { name: 'Create service account' }))
}

it('treats a lost successful create body as unknown, keeps its draft and never automatically repeats the mutation', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Response('', { status: 201 }) : Response.json(page))
  vi.stubGlobal('fetch', fetcher)
  render(<ServiceAccountsSection />)
  await submit()
  await screen.findByText(i18n.t('unifiedSettings.accounts.outcomeUnknown'))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Automation')
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2))
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('holds the one-time Token and interruption guard until explicit dismissal', async () => {
  const interruption = vi.fn(), saved = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { id: 'principal-fixture', name: 'Automation', scopes: ['organization:read'], token: 'fictional-test-token', createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null } : page)))
  render(<ServiceAccountsSection onInterruptionChange={interruption} onSaved={saved} />)
  await submit()
  expect(await screen.findByDisplayValue('fictional-test-token')).toHaveProperty('readOnly', true)
  await waitFor(() => expect(interruption).toHaveBeenLastCalledWith(true))
  expect(saved).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Create service account' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'I have stored the Token' }))
  expect(screen.queryByDisplayValue('fictional-test-token')).toBeNull()
  await waitFor(() => expect(interruption).toHaveBeenLastCalledWith(false))
})
