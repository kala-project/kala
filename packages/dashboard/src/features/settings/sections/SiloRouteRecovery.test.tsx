import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { i18n } from '../../../i18n/index.js'
import { forcePwaRefresh } from '../../../lib/pwa.js'
import { isNativeConsolePath, SiloRouteRecovery } from './SiloRouteRecovery.js'

vi.mock('../../../lib/pwa.js', () => ({ forcePwaRefresh: vi.fn(async () => {}) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); window.history.replaceState({}, '', '/') })

it('guards only native Console routes, including the authenticated entry', () => {
  for (const path of ['/silo', '/silo/', '/silo/login', '/auth/silo/open']) expect(isNativeConsolePath(path)).toBe(true)
  for (const path of ['/', '/silo-other', '/auth/login', '/auth/silo/authorize']) expect(isNativeConsolePath(path)).toBe(false)
})

it('refreshes only after deliberate user action and sends a stale auth-entry shell to the native root', async () => {
  await i18n.changeLanguage('en')
  window.history.replaceState({}, '', '/auth/silo/open')
  vi.stubGlobal('navigator', { serviceWorker: { controller: {} } })
  render(<SiloRouteRecovery standalone />)
  expect(screen.getByRole('heading', { name: 'Object storage' })).toBeTruthy()
  expect(forcePwaRefresh).not.toHaveBeenCalled()
  expect(screen.queryByText(i18n.t('unifiedSettings.silo.recoveryHelp'))).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reload application' }))
  await waitFor(() => expect(forcePwaRefresh).toHaveBeenCalledOnce())
  expect(vi.mocked(forcePwaRefresh).mock.calls[0]?.[0]?.location?.href).toBe(new URL('/silo/', window.location.origin).href)
})

it('surfaces cache recovery failure instead of reporting a successful repair', async () => {
  vi.stubGlobal('navigator', { serviceWorker: { controller: {} } })
  vi.mocked(forcePwaRefresh).mockRejectedValueOnce(new Error('worker activation timed out'))
  render(<SiloRouteRecovery />)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.silo.reloadApplication') }))
  await screen.findByText(i18n.t('unifiedSettings.silo.recoveryFailed'))
  expect(screen.getByRole('button', { name: i18n.t('unifiedSettings.silo.reloadApplication') }).hasAttribute('disabled')).toBe(false)
})
