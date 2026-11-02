import { randomId } from './random-id.js'
import { useEffect } from 'react'
import { isDesktopClient } from './desktop.js'
import type { DashboardSocket } from '../session.js'

const HEARTBEAT_MS = 15_000
const USER_IDLE_MS = 5 * 60_000
const DEVICE_ID_KEY = 'agent-kernel.push-device-id'

export function pushDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const created = randomId()
  localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

/**
 * Reports whether this dashboard is genuinely being used. A connected
 * background tab is not active: it must be visible, focused, and have seen
 * user input within five minutes. Missing heartbeats expire on the host.
 */
export function usePushActivityHeartbeat(enabled = true, socket?: DashboardSocket | null): void {
  useEffect(() => {
    if (!enabled || isDesktopClient()) return
    const id = randomId()
    let lastInteractionAt = Date.now()
    let lastReported: boolean | undefined
    let heartbeatTimer: number | undefined
    let stopped = false

    const isActive = (): boolean => document.visibilityState === 'visible'
      && document.hasFocus()
      && Date.now() - lastInteractionAt <= USER_IDLE_MS

    const scheduleHeartbeat = (): void => {
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
      if (!isActive()) return
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = undefined
        report(true)
      }, HEARTBEAT_MS)
    }

    const report = (force = false): void => {
      const active = isActive()
      if (!force && active === lastReported) return
      lastReported = active
      const payload = { deviceId: id, active }
      const fallback = (): void => {
        if (stopped) return
        void fetch('/push/activity', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      }
      if (socket?.connected) {
        void socket.timeout(3_000).emitWithAck('client:push_activity', payload)
          .then((result) => { if (!result.ok) fallback() }, fallback)
      } else fallback()
      scheduleHeartbeat()
    }
    const reportEvent = (): void => {
      report()
      scheduleHeartbeat()
    }
    const interact = (): void => {
      const wasIdle = Date.now() - lastInteractionAt > USER_IDLE_MS
      lastInteractionAt = Date.now()
      if (wasIdle) report(true)
      else scheduleHeartbeat()
    }
    const leave = (): void => {
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
      heartbeatTimer = undefined
      lastReported = false
      const body = JSON.stringify({ deviceId: id, active: false })
      if (typeof navigator.sendBeacon !== 'function'
        || !navigator.sendBeacon('/push/activity', new Blob([body], { type: 'application/json' }))) {
        void fetch('/push/activity', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {})
      }
    }

    const activityEvents: readonly (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart', 'scroll']
    activityEvents.forEach((event) => window.addEventListener(event, interact, { passive: true }))
    document.addEventListener('visibilitychange', reportEvent)
    window.addEventListener('focus', reportEvent)
    window.addEventListener('blur', reportEvent)
    window.addEventListener('pagehide', leave)
    const transportChanged = (): void => report(true)
    socket?.on('connect', transportChanged)
    socket?.on('disconnect', transportChanged)
    report(true)
    return () => {
      stopped = true
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
      activityEvents.forEach((event) => window.removeEventListener(event, interact))
      document.removeEventListener('visibilitychange', reportEvent)
      window.removeEventListener('focus', reportEvent)
      window.removeEventListener('blur', reportEvent)
      window.removeEventListener('pagehide', leave)
      socket?.off('connect', transportChanged)
      socket?.off('disconnect', transportChanged)
      leave()
    }
  }, [enabled, socket])
}
