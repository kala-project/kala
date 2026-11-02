import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAuthenticatedPwaState, useAuthSession } from './auth-session.js'

describe('clearAuthenticatedPwaState', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('clears badge, tells the worker to close notifications, and removes app caches', async () => {
    const postMessage = vi.fn(), clearAppBadge = vi.fn().mockResolvedValue(undefined), deleteCache = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', { clearAppBadge, serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ active: { postMessage } }) } })
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['ak-icons-v1', 'workbox-precache']), delete: deleteCache })
    await clearAuthenticatedPwaState()
    expect(clearAppBadge).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenCalledWith({ type: 'AUTH_LOGOUT' })
    expect(deleteCache).toHaveBeenCalledWith('ak-icons-v1')
    expect(deleteCache).not.toHaveBeenCalledWith('workbox-precache')
  })
})

describe('useAuthSession', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rechecks after a genuine return to the page, not repeated visible events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) })
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    renderHook(() => useAuthSession(true))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledOnce()

    await act(async () => {
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(15_000)
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
      }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    await act(async () => {
      vi.advanceTimersByTime(15_000)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('allows explicit refresh immediately even after a recent visible check', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAuthSession(true))
    await act(async () => {})
    await act(async () => { await result.current.refresh() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
