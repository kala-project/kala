import { useEffect } from 'react'
import type { DashboardSocket } from '../session.js'
import { useDesktopBridge } from './desktop-bridge.js'
import { connectApplicationDebugging } from './application-debugging.js'

export function useApplicationDebugging(input: { socket: DashboardSocket | null; sessionId: string | null; ready: boolean }): void {
  const { bridge } = useDesktopBridge()
  const debug = bridge?.applicationDebugging
  useEffect(() => {
    if (!debug || debug.version !== 1 || !input.socket || !input.sessionId || !input.ready) return
    return connectApplicationDebugging(debug, input.socket, input.sessionId)
  }, [debug, input.socket, input.sessionId, input.ready])
}
