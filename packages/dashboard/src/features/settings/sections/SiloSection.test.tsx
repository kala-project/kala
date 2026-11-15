import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SiloSection } from './SiloSection.js'
import { i18n } from '../../../i18n/index.js'
import { writeTextToClipboard } from '../../../lib/clipboard.js'
import { SettingsRequestContext } from '../configuration-request.js'
import { resolveSettingsTargetRequest } from '../target-request.js'

vi.mock('../../../lib/clipboard.js', () => ({ writeTextToClipboard: vi.fn(async () => {}) }))
const credentials = { username: 'fictional-storage-user', password: 'fictional-storage-password' }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

it('provides a separate guarded window without embedding or fetching credentials on entry', async () => {
  await i18n.changeLanguage('en')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const view = render(<SiloSection enabled credentialsAvailable />)
  const link = screen.getByRole('link', { name: 'Open console' })
  expect(link.getAttribute('href')).toBe('/auth/silo/open')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toContain('noopener')
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(screen.getByText('Sign in with the storage administrator account, not your Kala login.')).toBeTruthy()
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Password')).toBeNull()
})

it('reveals only on explicit request, copies the exact fields and forgets them when hidden', async () => {
  const fetcher = vi.fn(async () => Response.json(credentials))
  vi.stubGlobal('fetch', fetcher)
  const target = resolveSettingsTargetRequest({ product: 'dedicated', browserOrigin: window.location.origin,
    host: window.location.origin, cacheNamespace: 'fixture', organizationId: 'org_fixture', organizationRole: 'owner', fetch: fetcher })!
  render(<SettingsRequestContext.Provider value={target.request}><SiloSection enabled credentialsAvailable /></SettingsRequestContext.Provider>)
  fireEvent.click(screen.getByRole('button', { name: 'Show login details' }))
  const password = await screen.findByLabelText<HTMLInputElement>('Password')
  expect(password.value).toBe(credentials.password)
  expect(screen.getByLabelText<HTMLInputElement>('Username').value).toBe(credentials.username)
  expect(fetcher).toHaveBeenCalledWith('/auth/silo/credentials', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy storage username' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy storage password' }))
  await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalledWith(credentials.password))
  expect(writeTextToClipboard).toHaveBeenCalledWith(credentials.username)
  fireEvent.click(screen.getByRole('button', { name: 'Hide login details' }))
  expect(screen.queryByLabelText('Password')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show login details' }))
  await screen.findByLabelText('Password')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('conceals credentials on tab hiding and capability revocation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(credentials)))
  const view = render(<SiloSection enabled credentialsAvailable />)
  fireEvent.click(screen.getByRole('button', { name: 'Show login details' }))
  await screen.findByLabelText('Password')
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.queryByLabelText('Password')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show login details' }))
  await screen.findByLabelText('Password')
  view.rerender(<SiloSection enabled credentialsAvailable={false} />)
  expect(screen.queryByLabelText('Password')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show login details' })).toBeNull()
})

it('aborts on unmount and never displays a late credential response', async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<SiloSection enabled credentialsAvailable />)
  fireEvent.click(screen.getByRole('button', { name: 'Show login details' }))
  const signal = fetcher.mock.calls[0]?.[1]?.signal
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { resolve(Response.json(credentials)) })
  expect(screen.queryByLabelText('Password')).toBeNull()
})

it.each([() => new Response('', { status: 403 }), () => Response.json({ username: 'incomplete' }), () => Response.json({ password: 'incomplete' })])('reports rejected or malformed reads without exposing partial values and permits retry', async makeResponse => {
  const fetcher = vi.fn(async () => makeResponse())
  vi.stubGlobal('fetch', fetcher)
  render(<SiloSection enabled credentialsAvailable />)
  fireEvent.click(screen.getByRole('button', { name: 'Show login details' }))
  await screen.findByRole('alert')
  expect(screen.queryByLabelText('Username')).toBeNull()
  expect(screen.queryByLabelText('Password')).toBeNull()
  expect(screen.getByRole('button', { name: 'Show login details' }).hasAttribute('disabled')).toBe(false)
})

it('retains the console link without credential provisioning, and disables both for an unavailable console', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const view = render(<SiloSection enabled />)
  expect(screen.getByRole('link', { name: 'Open console' })).toBeTruthy()
  expect(screen.getByText('Login details have not been shared with this instance. Contact the deployment administrator.')).toBeTruthy()
  view.rerender(<SiloSection enabled={false} credentialsAvailable />)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show login details' })).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})
