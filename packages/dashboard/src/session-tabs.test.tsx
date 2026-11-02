import { act, renderHook } from '@testing-library/react'
import type { SessionSummary } from '@agent-kernel/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionTabs } from './session-tabs.js'

const session: SessionSummary = {
  sessionId: 'session-a', agentRuntime: 'kernel', executionMode: 'chat',
  createdAt: '2026-01-01T00:00:00Z', eventCount: 0,
}

describe('useSessionTabs', () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit): Promise<Response> =>
    init?.method === 'PUT' ? Promise.resolve(new Response('{}')) : new Promise(() => {}))

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    localStorage.clear()
    localStorage.setItem('ak-session-tabs-v1', JSON.stringify({ open: [session.sessionId] }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not re-save unchanged tabs on session updates, but persists pinning and pruning', () => {
    const { result, rerender } = renderHook(({ sessions }) => useSessionTabs(sessions, null, vi.fn()), {
      initialProps: { sessions: [session] },
    })
    const writes = (): number => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').length
    act(() => { vi.advanceTimersByTime(700) })
    const initialWrites = writes()
    for (let index = 0; index < 5; index += 1) {
      rerender({ sessions: [{ ...session, eventCount: index + 1 }] })
      act(() => { vi.advanceTimersByTime(700) })
    }
    expect(writes()).toBe(initialWrites)

    act(() => { result.current.pin(session.sessionId) })
    act(() => { vi.advanceTimersByTime(700) })
    expect(writes()).toBe(initialWrites + 1)

    rerender({ sessions: [] })
    act(() => { vi.advanceTimersByTime(700) })
    expect(writes()).toBe(initialWrites + 2)
  })
})
