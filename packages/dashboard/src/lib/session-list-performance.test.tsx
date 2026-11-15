import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_LIST_NAVIGATION, SESSION_LIST_READY, SESSION_LIST_VISIBLE, useSessionListPerformance } from './session-list-performance.js'

describe('initial Session list performance', () => {
  const entries = new Set<string>()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const mark = vi.fn((name: string) => { entries.add(name) })
  const measure = vi.fn()

  beforeEach(() => {
    entries.clear()
    frames.clear()
    mark.mockClear()
    measure.mockClear()
    vi.stubGlobal('performance', { mark, measure, getEntriesByName: (name: string) => entries.has(name) ? [{}] : [] })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  })

  afterEach(() => { vi.unstubAllGlobals() })

  function paint(): void {
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })
  }

  it('includes navigation and list rendering instead of stopping when data arrives', () => {
    const { rerender } = renderHook(({ ready }) => useSessionListPerformance(ready, true, 71), { initialProps: { ready: false } })
    expect(mark).not.toHaveBeenCalled()
    rerender({ ready: true })
    expect(mark).toHaveBeenCalledWith(SESSION_LIST_READY, { detail: { sessionCount: 71 } })
    expect(measure).not.toHaveBeenCalled()
    paint()
    expect(measure).not.toHaveBeenCalled()
    paint()
    expect(mark).toHaveBeenCalledWith(SESSION_LIST_VISIBLE, { detail: { sessionCount: 71 } })
    expect(measure).toHaveBeenCalledWith(SESSION_LIST_NAVIGATION, { start: 0, end: SESSION_LIST_VISIBLE })
    rerender({ ready: true })
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('does not count a hidden list as visible and cancels an abandoned render', () => {
    const { rerender, unmount } = renderHook(({ visible }) => useSessionListPerformance(true, visible, 0), { initialProps: { visible: false } })
    paint()
    paint()
    expect(entries.has(SESSION_LIST_READY)).toBe(true)
    expect(measure).not.toHaveBeenCalled()
    rerender({ visible: true })
    paint()
    unmount()
    paint()
    expect(measure).not.toHaveBeenCalled()
  })

  it('records an authoritative empty list once, including across component remounts', () => {
    const first = renderHook(() => useSessionListPerformance(true, true, 0))
    paint()
    paint()
    expect(mark).toHaveBeenCalledWith(SESSION_LIST_VISIBLE, { detail: { sessionCount: 0 } })
    expect(measure).toHaveBeenCalledTimes(1)
    first.unmount()
    renderHook(() => useSessionListPerformance(true, true, 0))
    paint()
    paint()
    expect(measure).toHaveBeenCalledTimes(1)
  })
})
