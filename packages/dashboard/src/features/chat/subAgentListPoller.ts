import type { SubAgentListResult } from '@agent-kernel/shared'
import type { DashboardSocket } from '../../session.js'

type Listener = (result: SubAgentListResult) => void
type Poller = {
  listeners: Set<Listener>
  latest?: SubAgentListResult
  timer: number
  refresh(): void
}

const pollers = new WeakMap<DashboardSocket, Map<string, Poller>>()

export function subscribeSubAgentList(
  socket: DashboardSocket,
  parentSessionId: string,
  listener: Listener,
): () => void {
  let byParent = pollers.get(socket)
  if (!byParent) {
    byParent = new Map()
    pollers.set(socket, byParent)
  }
  let poller = byParent.get(parentSessionId)
  const first = !poller
  if (!poller) {
    const listeners = new Set<Listener>()
    let pending = false
    let requestedAt = 0
    let requestNumber = 0
    const current: Poller = {
      listeners,
      timer: 0,
      refresh() {
        if (pending && Date.now() - requestedAt < 5_000) return
        if (pending) {
          current.latest = undefined
          for (const subscriber of current.listeners) subscriber({
            requestId: `sub-agent-list-${parentSessionId}-${requestNumber}`,
            parentSessionId, children: [], error: 'Sub-agent status query timed out',
          })
        }
        pending = true
        requestedAt = Date.now()
        const request = ++requestNumber
        socket.emit('sub_agent:list',
          { requestId: `sub-agent-list-${parentSessionId}-${request}`, parentSessionId },
          (result: SubAgentListResult) => {
            if (request !== requestNumber || byParent?.get(parentSessionId) !== current) return
            pending = false
            if (result.error) {
              current.latest = undefined
              for (const subscriber of current.listeners) subscriber(result)
              return
            }
            current.latest = result
            for (const subscriber of current.listeners) subscriber(result)
          })
      },
    }
    current.timer = window.setInterval(() => current.refresh(), 2_000)
    poller = current
    byParent.set(parentSessionId, current)
  }
  poller.listeners.add(listener)
  if (poller.latest) listener(poller.latest)
  if (first) poller.refresh()
  return () => {
    poller.listeners.delete(listener)
    if (poller.listeners.size !== 0) return
    window.clearInterval(poller.timer)
    byParent.delete(parentSessionId)
    if (!byParent.size) pollers.delete(socket)
  }
}
