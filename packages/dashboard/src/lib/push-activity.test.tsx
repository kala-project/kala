import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { io } from 'socket.io-client'

import { usePushActivityHeartbeat } from './push-activity.js'
import type { DashboardSocket } from '../session.js'

describe('usePushActivityHeartbeat', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports a focused visible page active and refreshes every 15 seconds', () => {
    renderHook(() => usePushActivityHeartbeat())
    expect(lastPayload()).toMatchObject({ active: true })

    act(() => { vi.advanceTimersByTime(15_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastPayload()).toMatchObject({ active: true })
  })

  it('reports inactive immediately when the window loses focus', () => {
    renderHook(() => usePushActivityHeartbeat())
    vi.mocked(document.hasFocus).mockReturnValue(false)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(lastPayload()).toMatchObject({ active: false })
  })

  it('reports inactive after five minutes without user interaction', () => {
    renderHook(() => usePushActivityHeartbeat())
    act(() => { vi.advanceTimersByTime(5 * 60_000 + 15_000) })
    expect(lastPayload()).toMatchObject({ active: false })
  })

  it('sends active presence over a connected socket, not periodic HTTP requests', async () => {
    const socket: DashboardSocket = io('http://localhost:3000/dashboard', { autoConnect: false })
    Object.defineProperty(socket, 'connected', { configurable: true, value: true })
    vi.spyOn(socket, 'emitWithAck').mockResolvedValue({ ok: true })
    renderHook(() => usePushActivityHeartbeat(true, socket))
    await act(async () => { vi.advanceTimersByTime(45_000) })
    expect(socket.emitWithAck).toHaveBeenCalledTimes(4)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to HTTP if the socket cannot acknowledge presence', async () => {
    const socket: DashboardSocket = io('http://localhost:3000/dashboard', { autoConnect: false })
    Object.defineProperty(socket, 'connected', { configurable: true, value: true })
    vi.spyOn(socket, 'emitWithAck').mockRejectedValue(new Error('timeout'))
    renderHook(() => usePushActivityHeartbeat(true, socket))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(lastPayload()).toMatchObject({ active: true })
  })

  it('keeps presence independent between browser tabs on the same device', () => {
    renderHook(() => usePushActivityHeartbeat())
    const first = lastPayload().deviceId
    renderHook(() => usePushActivityHeartbeat())
    expect(lastPayload().deviceId).not.toBe(first)
  })

  it('uses keepalive HTTP when the browser cannot queue a pagehide beacon', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) })
    renderHook(() => usePushActivityHeartbeat())
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(lastPayload()).toMatchObject({ active: false })
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ keepalive: true })
  })

  function lastPayload(): { deviceId: string; active: boolean } {
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    return JSON.parse(String(init.body)) as { deviceId: string; active: boolean }
  }
})
