import type { ChannelSubscriptionResult, DashboardChannel, DashboardClientToServerEvents, DashboardServerToClientEvents } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'

export type ManagedDashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
export type ChannelWireState = 'desired' | 'subscribing' | 'active' | 'rejected'
type ChannelRecord = { refs: number; generation: number; baselineGeneration?: number; cursor?: number; state: ChannelWireState; error?: string; errorListeners: Set<(code: string) => void>; warmUntil?: number; warmTimer?: number; lastUsed: number }
type AcquireOptions = { freshBaseline?: boolean; retainWarm?: boolean; onError?(code: string): void }
type DashboardConnectionManagerOptions = { sessionWarmthMs?: () => number; maxWarmSessions?: number }

const DEFAULT_SESSION_WARMTH_MS = 60 * 60_000
const DEFAULT_MAX_WARM_SESSIONS = 16
function warmable(channel: DashboardChannel): boolean {
  return channel.startsWith('session:') || channel.startsWith('workspace:')
}

export class DashboardConnectionManager {
  private readonly channels = new Map<DashboardChannel, ChannelRecord>()
  private request = 0
  private readonly sessionWarmthMs: () => number
  private readonly maxWarmSessions: number
  constructor(readonly socket: ManagedDashboardSocket, options: DashboardConnectionManagerOptions = {}) {
    this.sessionWarmthMs = options.sessionWarmthMs ?? (() => DEFAULT_SESSION_WARMTH_MS)
    this.maxWarmSessions = options.maxWarmSessions ?? DEFAULT_MAX_WARM_SESSIONS
    socket.on('connect', () => { void this.restore() })
    socket.on('disconnect', () => {
      for (const record of this.channels.values()) {
        record.state = 'desired'
        delete record.baselineGeneration
      }
    })
  }

  acquire(channel: DashboardChannel, cursor?: number, options: AcquireOptions = {}): () => void {
    let current = this.channels.get(channel)
    if (current?.refs === 0 && current.warmUntil !== undefined
      && (current.warmUntil <= Date.now() || this.sessionWarmthMs() <= 0)) {
      this.remove(channel, current)
      current = undefined
    }
    if (current) {
      if (current.warmTimer !== undefined) window.clearTimeout(current.warmTimer)
      delete current.warmTimer
      delete current.warmUntil
      current.refs += 1
      current.lastUsed = Date.now()
      if (cursor !== undefined) current.cursor = Math.max(current.cursor ?? 0, cursor)
      if (options.onError) current.errorListeners.add(options.onError)
      // A room can outlive its UI consumer (hover preview, child card). Refresh
      // its authoritative baseline after new listeners bind without touching
      // room membership or the shared reference count.
      if (this.socket.connected && (current.state === 'desired' || current.state === 'rejected')) void this.subscribe([channel], false)
      else if (this.socket.connected && options.freshBaseline) void this.refreshBaselines([channel])
    } else {
      this.channels.set(channel, { refs: 1, generation: 0, ...(cursor !== undefined ? { cursor } : {}), state: 'desired', errorListeners: new Set(options.onError ? [options.onError] : []), lastUsed: Date.now() })
      if (this.socket.connected) void this.subscribe([channel], false)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const record = this.channels.get(channel)
      if (options.onError) record?.errorListeners.delete(options.onError)
      if (!record || --record.refs > 0) return
      if (options.retainWarm !== false
        && warmable(channel)
        && record.state !== 'rejected'
        && this.retainWarm(channel, record)) return
      this.remove(channel, record)
    }
  }

  async waitUntilActive(channel: DashboardChannel, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = this.channels.get(channel)?.state
      if (state === 'active') return true
      if (state === 'rejected' || state === undefined) return false
      await new Promise((resolve) => window.setTimeout(resolve, 10))
    }
    return this.channels.get(channel)?.state === 'active'
  }

  setCursor(channel: DashboardChannel, cursor: number): void {
    const record = this.channels.get(channel)
    if (record) record.cursor = Math.max(record.cursor ?? 0, cursor)
  }

  snapshot(): ReadonlyMap<DashboardChannel, Readonly<ChannelRecord>> { return new Map(this.channels) }

  refresh(channel: DashboardChannel): void {
    const record = this.channels.get(channel)
    if (!record) return
    if (this.socket.connected && (record.state === 'active' || record.state === 'subscribing')) void this.refreshBaselines([channel])
    else if (this.socket.connected) void this.subscribe([channel], false)
    else this.socket.connect()
  }

  async restore(): Promise<void> {
    for (const [channel, record] of this.channels) {
      if (record.refs === 0 && record.warmUntil !== undefined
        && (record.warmUntil <= Date.now() || this.sessionWarmthMs() <= 0)) this.remove(channel, record)
    }
    const desired = [...this.channels.entries()].filter(([, record]) => record.refs > 0 || record.warmUntil !== undefined).map(([channel]) => channel)
    if (desired.length) await this.subscribe(desired, true)
  }

  /** Recalculate existing warm leases when the user changes the setting. */
  updateWarmth(): void {
    const duration = Math.max(0, this.sessionWarmthMs())
    for (const [channel, record] of this.channels) {
      if (record.refs !== 0 || record.warmUntil === undefined) continue
      if (record.warmTimer !== undefined) window.clearTimeout(record.warmTimer)
      const remaining = record.lastUsed + duration - Date.now()
      if (remaining <= 0 || this.maxWarmSessions <= 0) {
        this.remove(channel, record)
      } else {
        record.warmUntil = record.lastUsed + duration
        record.warmTimer = window.setTimeout(() => {
          if (this.channels.get(channel) !== record || record.refs !== 0) return
          // Browser background throttling can fire late or early.
          this.updateWarmth()
        }, remaining)
      }
    }
  }

  private retainWarm(channel: DashboardChannel, record: ChannelRecord): boolean {
    const duration = Math.max(0, this.sessionWarmthMs())
    if (duration === 0 || this.maxWarmSessions <= 0) return false
    record.lastUsed = Date.now()
    record.warmUntil = record.lastUsed + duration
    const expire = (): void => {
      const current = this.channels.get(channel)
      if (current !== record || current.refs > 0 || current.warmUntil === undefined) return
      const remaining = current.warmUntil - Date.now()
      if (remaining > 0 && this.sessionWarmthMs() > 0) {
        current.warmTimer = window.setTimeout(expire, remaining)
        return
      }
      this.remove(channel, current)
    }
    record.warmTimer = window.setTimeout(expire, duration)
    const warm = [...this.channels.entries()]
      .filter(([candidate, candidateRecord]) => warmable(candidate) && candidateRecord.refs === 0 && candidateRecord.warmUntil !== undefined)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
    for (const [candidate, candidateRecord] of warm.slice(0, Math.max(0, warm.length - this.maxWarmSessions))) this.remove(candidate, candidateRecord)
    return this.channels.get(channel) === record
  }

  private remove(channel: DashboardChannel, record: ChannelRecord): void {
    if (record.warmTimer !== undefined) window.clearTimeout(record.warmTimer)
    this.channels.delete(channel)
    if (this.socket.connected) this.unsubscribe([channel])
  }

  private async subscribe(channels: DashboardChannel[], restore: boolean): Promise<void> {
    const generation = ++this.request
    for (const channel of channels) {
      const record = this.channels.get(channel)
      if (record) { record.generation = generation; record.state = 'subscribing'; delete record.baselineGeneration; delete record.error }
    }
    const cursors = Object.fromEntries(channels.flatMap((channel) => { const cursor = this.channels.get(channel)?.cursor; return cursor === undefined ? [] : [[channel, cursor]] }))
    const event = restore ? 'client:restore_subscriptions' : 'client:subscribe_channels'
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        for (const channel of channels) {
          const record = this.channels.get(channel)
          if (record?.generation !== generation) continue
          record.state = 'desired'
          record.error = 'subscription_timeout'
          for (const listener of record.errorListeners) listener(record.error)
        }
        resolve()
      }, 5_000)
      this.socket.emit(event, { requestId: `channels-${generation}`, generation, channels, ...(Object.keys(cursors).length ? { cursors } : {}) }, (result: ChannelSubscriptionResult) => {
        window.clearTimeout(timer)
        this.applyAck(result)
        resolve()
      })
    })
  }

  private async refreshBaselines(channels: DashboardChannel[]): Promise<void> {
    const generation = ++this.request
    for (const channel of channels) {
      const record = this.channels.get(channel)
      if (record) { record.baselineGeneration = generation; delete record.error }
    }
    const cursors = Object.fromEntries(channels.flatMap((channel) => { const cursor = this.channels.get(channel)?.cursor; return cursor === undefined ? [] : [[channel, cursor]] }))
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        for (const channel of channels) {
          const record = this.channels.get(channel)
          if (record?.baselineGeneration !== generation) continue
          record.error = 'baseline_timeout'
          for (const listener of record.errorListeners) listener(record.error)
        }
        resolve()
      }, 5_000)
      this.socket.emit('client:refresh_channels', { requestId: `baseline-${generation}`, generation, channels, ...(Object.keys(cursors).length ? { cursors } : {}) }, (result: ChannelSubscriptionResult) => {
        window.clearTimeout(timer)
        for (const channel of result.accepted) {
          const record = this.channels.get(channel)
          if (!record || record.baselineGeneration !== result.generation) continue
          const cursor = result.cursors[channel]
          if (cursor !== undefined) record.cursor = Math.max(record.cursor ?? 0, cursor)
        }
        for (const rejection of result.rejected) {
          const record = this.channels.get(rejection.channel)
          if (!record || record.baselineGeneration !== result.generation) continue
          record.error = rejection.code
          for (const listener of record.errorListeners) listener(rejection.code)
        }
        resolve()
      })
    })
  }

  private applyAck(result: ChannelSubscriptionResult): void {
    for (const channel of result.accepted) {
      const record = this.channels.get(channel)
      if (!record || record.generation !== result.generation) continue
      record.state = 'active'
      const cursor = result.cursors[channel]
      if (cursor !== undefined) record.cursor = Math.max(record.cursor ?? 0, cursor)
    }
    for (const rejection of result.rejected) {
      const record = this.channels.get(rejection.channel)
      if (!record || record.generation !== result.generation) continue
      record.state = 'rejected'; record.error = rejection.code
      for (const listener of record.errorListeners) listener(rejection.code)
    }
  }

  private unsubscribe(channels: DashboardChannel[]): void {
    const generation = ++this.request
    this.socket.emit('client:unsubscribe_channels', { requestId: `unsubscribe-${generation}`, generation, channels }, () => {})
  }
}
