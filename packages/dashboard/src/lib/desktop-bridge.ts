import { useCallback, useState, useSyncExternalStore } from 'react'
import { isDesktopClient } from './desktop.js'
import type { AppDebugContext, AppDebugFrame, AppDebugReply } from '@agent-kernel/shared'

export type NativeDebugContext = AppDebugContext & { sessionId: string }
export type NativeDebugEvent = {
  generation: number; run: number; id: number
  request: { op: 'start'; ports: number[] } | { op: 'frame'; frame: AppDebugFrame } | { op: 'stop'; grantId?: string }
}
export interface ApplicationDebugBridge {
  version: 1
  begin(listener: (event: NativeDebugEvent) => void): Promise<number>
  setContext(generation: number, context: NativeDebugContext): Promise<void>
  reply(generation: number, id: number, result: AppDebugReply): Promise<void>
  receive(generation: number, frame: AppDebugFrame): Promise<void>
  touch(generation: number, grantId: string): Promise<void>
  abort(generation: number, run: number, error: string): Promise<void>
  detach(generation: number): Promise<void>
  unavailable(generation: number, error: string): Promise<void>
  show(): Promise<void>
}

export type DesktopWindowState = { focused: boolean; visible: boolean }
export type DesktopInfo = DesktopWindowState & { version: string; notificationsAvailable?: boolean; trayAvailable?: boolean }
export type DesktopEvent =
  | ({ type: 'window-state' } & DesktopWindowState)
  | { type: 'open-session'; sessionId: string }
export type DesktopActivity = { status: 'idle' | 'running' | 'attention' | 'completed'; running: number; attention: number; completed: number }
export type DesktopNotification = { id: string; sessionId: string; title: string; body: string; silent: boolean }
export interface DesktopBridge {
  version: 1
  applicationDebugging?: ApplicationDebugBridge
  getInfo(): Promise<DesktopInfo>
  confirmConnection?(): Promise<void>
  setActivity(activity: DesktopActivity): Promise<void>
  notify(notification: DesktopNotification): Promise<void>
  readClipboardImage?(): Promise<string | null>
  subscribe(listener: (event: DesktopEvent) => void): () => void
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
export const validDesktopSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

export function getDesktopBridge(): DesktopBridge | null {
  if (!isDesktopClient()) return null
  const bridge: unknown = (window as Window & { __KALA_DESKTOP_BRIDGE__?: unknown }).__KALA_DESKTOP_BRIDGE__
  if (!record(bridge) || bridge.version !== 1 || !['getInfo', 'setActivity', 'notify', 'subscribe'].every((key) => typeof bridge[key] === 'function')) return null
  return bridge as unknown as DesktopBridge
}

export function validDesktopEvent(value: unknown): value is DesktopEvent {
  return record(value) && ((value.type === 'open-session' && validDesktopSessionId(value.sessionId))
    || (value.type === 'window-state' && typeof value.focused === 'boolean' && typeof value.visible === 'boolean'))
}

export function validDesktopInfo(value: unknown): value is DesktopInfo {
  return record(value) && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 128
    && typeof value.focused === 'boolean' && typeof value.visible === 'boolean'
    && (value.notificationsAvailable === undefined || typeof value.notificationsAvailable === 'boolean')
    && (value.trayAvailable === undefined || typeof value.trayAvailable === 'boolean')
}

type BridgeSnapshot = { bridge: DesktopBridge | null; info: DesktopInfo | null; error: string | null }
const unsupportedSnapshot: BridgeSnapshot = { bridge: null, info: null, error: null }

class BridgeConnection {
  snapshot: BridgeSnapshot
  private listeners = new Set<() => void>()
  private sessionListeners = new Set<(sessionId: string) => void>()
  private pendingSession: string | null = null
  private unsubscribe: (() => void) | undefined
  private generation = 0
  private connected = false

  constructor(private bridge: DesktopBridge) {
    this.snapshot = { bridge, info: null, error: null }
  }

  private publish(patch: Partial<BridgeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private connect(): void {
    if (this.connected) return
    this.connected = true
    const generation = ++this.generation
    let latestWindow: DesktopWindowState | null = null
    this.publish({ info: null, error: null })
    try {
      const unsubscribe = this.bridge.subscribe((event) => {
        if (generation !== this.generation || !validDesktopEvent(event)) return
        if (event.type === 'open-session') {
          if (this.sessionListeners.size) for (const listener of this.sessionListeners) listener(event.sessionId)
          else this.pendingSession = event.sessionId
        } else {
          latestWindow = { focused: event.focused, visible: event.visible }
          if (this.snapshot.info) this.publish({ info: { ...this.snapshot.info, ...latestWindow } })
        }
      })
      if (typeof unsubscribe !== 'function') throw new Error('Invalid native desktop subscription')
      this.unsubscribe = unsubscribe
      void this.bridge.getInfo().then((value: unknown) => {
        if (!validDesktopInfo(value)) throw new Error('Invalid native desktop information')
        if (generation === this.generation) this.publish({ info: { ...value, ...latestWindow } })
      }).catch((reason: unknown) => {
        if (generation === this.generation) this.publish({ error: reason instanceof Error ? reason.message : 'Native desktop bridge unavailable' })
      })
    } catch (reason) {
      this.publish({ error: reason instanceof Error ? reason.message : 'Native desktop bridge unavailable' })
    }
  }

  private disconnectIfUnused(): void {
    if (this.listeners.size || this.sessionListeners.size) return
    ++this.generation
    this.connected = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.connect()
    return () => { this.listeners.delete(listener); this.disconnectIfUnused() }
  }

  subscribeSession(listener: (sessionId: string) => void): () => void {
    this.sessionListeners.add(listener)
    this.connect()
    if (this.pendingSession) {
      const session = this.pendingSession
      this.pendingSession = null
      listener(session)
    }
    return () => { this.sessionListeners.delete(listener); this.disconnectIfUnused() }
  }
}

const connections = new WeakMap<DesktopBridge, BridgeConnection>()
function connectionFor(bridge: DesktopBridge): BridgeConnection {
  let connection = connections.get(bridge)
  if (!connection) { connection = new BridgeConnection(bridge); connections.set(bridge, connection) }
  return connection
}

/** Retains the latest cold-start link even when settings/update widgets subscribe first. */
export function subscribeDesktopSessionOpen(bridge: DesktopBridge, listener: (sessionId: string) => void): () => void {
  return connectionFor(bridge).subscribeSession(listener)
}

export function useDesktopBridge(): BridgeSnapshot {
  const [bridge] = useState(getDesktopBridge)
  const [connection] = useState(() => bridge ? connectionFor(bridge) : null)
  const subscribe = useCallback((listener: () => void) => connection ? connection.subscribe(listener) : () => {}, [connection])
  const snapshot = useCallback(() => connection?.snapshot ?? unsupportedSnapshot, [connection])
  return useSyncExternalStore(subscribe, snapshot, () => unsupportedSnapshot)
}
