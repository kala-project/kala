import { useEffect } from 'react'

export const SESSION_LIST_READY = 'kala:session-list:data-ready'
export const SESSION_LIST_VISIBLE = 'kala:session-list:visible'
export const SESSION_LIST_NAVIGATION = 'kala:navigation-to-session-list'

export function useSessionListPerformance(ready: boolean, visible: boolean, sessionCount: number): void {
  useEffect(() => {
    if (!ready || typeof performance.mark !== 'function') return
    if (performance.getEntriesByName(SESSION_LIST_READY).length === 0) {
      performance.mark(SESSION_LIST_READY, { detail: { sessionCount } })
    }
    if (!visible || performance.getEntriesByName(SESSION_LIST_VISIBLE).length > 0) return
    // Let the committed list paint before recording visibility, not just receipt.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (performance.getEntriesByName(SESSION_LIST_VISIBLE).length > 0) return
        performance.mark(SESSION_LIST_VISIBLE, { detail: { sessionCount } })
        performance.measure(SESSION_LIST_NAVIGATION, { start: 0, end: SESSION_LIST_VISIBLE })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, visible, sessionCount])
}
