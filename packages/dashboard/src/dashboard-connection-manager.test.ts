import { describe, expect, it, vi } from 'vitest'
import { DashboardConnectionManager } from './dashboard-connection-manager.js'

class SocketMock {
  connected = true
  handlers = new Map<string, Array<(...args: any[]) => void>>()
  emits: Array<{ event: string; payload: any }> = []
  on(event: string, handler: (...args: any[]) => void): this { this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]); return this }
  emit(event: string, payload: any, ack?: (value: any) => void): this {
    this.emits.push({ event, payload })
    if (event.includes('subscribe') || event === 'client:refresh_channels') queueMicrotask(() => ack?.({ requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} }))
    return this
  }
  fire(event: string): void { for (const handler of this.handlers.get(event) ?? []) handler() }
}

describe('DashboardConnectionManager', () => {
  it.each(['active', 'subscribing'] as const)('requests a fresh selection baseline on a %s preview channel without dropping its room', async (state) => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never)
    const releasePreview = manager.acquire('session:s1')
    if (state === 'active') await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))
    const releaseSelection = manager.acquire('session:s1', 4, { freshBaseline: true })
    expect(socket.emits.filter(entry => entry.event === 'client:subscribe_channels')).toHaveLength(1)
    expect(socket.emits.filter(entry => entry.event === 'client:refresh_channels')).toHaveLength(1)
    expect(manager.snapshot().get('session:s1')?.refs).toBe(2)
    releasePreview()
    expect(socket.emits.filter(entry => entry.event === 'client:unsubscribe_channels')).toHaveLength(0)
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))
    releaseSelection()
    expect(socket.emits.filter(entry => entry.event === 'client:unsubscribe_channels')).toHaveLength(0)
  })

  it('reports a rejected subscription to its active consumer, not a released one', () => {
    const socket = new SocketMock()
    let ack: ((value: any) => void) | undefined
    let payload: any
    socket.emit = function (event, value, callback) { if (event === 'client:subscribe_channels') { payload = value; ack = callback }; return this }
    const manager = new DashboardConnectionManager(socket as never)
    const releasedError = vi.fn(), activeError = vi.fn()
    const release = manager.acquire('session:s1', undefined, { onError: releasedError })
    manager.acquire('session:s1', undefined, { onError: activeError })
    release()
    ack?.({ requestId: payload.requestId, generation: payload.generation, accepted: [], rejected: [{ channel: 'session:s1', code: 'tenant_forbidden' }], cursors: {} })
    expect(releasedError).not.toHaveBeenCalled()
    expect(activeError).toHaveBeenCalledWith('tenant_forbidden')
  })

  it('reports a subscription timeout once without starting a polling or retry loop', async () => {
    vi.useFakeTimers()
    try {
      const socket = new SocketMock()
      socket.emit = function (event, payload) { this.emits.push({ event, payload }); return this }
      const onError = vi.fn()
      const manager = new DashboardConnectionManager(socket as never)
      const release = manager.acquire('session:s1', undefined, { onError })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith('subscription_timeout')
      expect(socket.emits).toHaveLength(1)
      release()
    } finally { vi.useRealTimers() }
  })

  it('refreshes a baseline without changing channel ownership, or reconnects the shared transport', async () => {
    const socket = new SocketMock()
    const connect = vi.fn()
    Object.assign(socket, { connect })
    const manager = new DashboardConnectionManager(socket as never)
    const release = manager.acquire('session:s1')
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))
    manager.refresh('session:s1')
    expect(socket.emits.filter(entry => entry.event === 'client:subscribe_channels')).toHaveLength(1)
    expect(socket.emits.filter(entry => entry.event === 'client:refresh_channels')).toHaveLength(1)
    expect(manager.snapshot().get('session:s1')?.refs).toBe(1)
    socket.connected = false
    manager.refresh('session:s1')
    expect(connect).toHaveBeenCalledTimes(1)
    release()
  })

  it('reference-counts channels and restores them in one batch', async () => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never)
    const release1 = manager.acquire('session:s1')
    const release2 = manager.acquire('session:s1')
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))
    expect(socket.emits.filter((entry) => entry.event === 'client:subscribe_channels')).toHaveLength(1)
    release1()
    expect(socket.emits.filter((entry) => entry.event === 'client:unsubscribe_channels')).toHaveLength(0)
    socket.connected = false; socket.fire('disconnect')
    manager.acquire('workspace:w1')
    socket.connected = true; socket.fire('connect')
    await vi.waitFor(() => expect(socket.emits.some((entry) => entry.event === 'client:restore_subscriptions' && entry.payload.channels.length === 2)).toBe(true))
    release2()
  })

  it('switches Sessions on the same physical socket and restores active and warm channels', async () => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never)
    const releaseWorkspace = manager.acquire('workspace:w1')
    const releaseFirst = manager.acquire('session:s1', 4)
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))

    const releaseSecond = manager.acquire('session:s2', 8)
    releaseFirst()
    await vi.waitFor(() => expect(manager.snapshot().get('session:s2')?.state).toBe('active'))
    expect(manager.socket).toBe(socket)
    expect(socket.emits.filter((entry) => entry.event === 'client:unsubscribe_channels')).toHaveLength(0)

    socket.connected = false; socket.fire('disconnect')
    socket.connected = true; socket.fire('connect')
    await vi.waitFor(() => expect(socket.emits.some((entry) => entry.event === 'client:restore_subscriptions'
      && entry.payload.channels.includes('workspace:w1')
      && entry.payload.channels.includes('session:s2')
      && entry.payload.channels.includes('session:s1')
      && entry.payload.cursors['session:s2'] === 8)).toBe(true))
    releaseSecond(); releaseWorkspace()
  })

  it('ignores stale acknowledgements after a channel is released', async () => {
    const socket = new SocketMock()
    let captured: ((value: any) => void) | undefined
    socket.emit = function (event: string, payload: any, ack?: (value: any) => void) { this.emits.push({ event, payload }); captured = ack; return this }
    const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => 0 })
    const release = manager.acquire('session:s1')
    release()
    captured?.({ requestId: 'old', generation: 1, accepted: ['session:s1'], rejected: [], cursors: {} })
    expect(manager.snapshot().has('session:s1')).toBe(false)
  })

  it('keeps A to B to A rooms warm while independently refreshing the reentered baseline', async () => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => 60_000 })
    const releaseA = manager.acquire('session:a', undefined, { freshBaseline: true })
    releaseA()
    const releaseB = manager.acquire('session:b', undefined, { freshBaseline: true })
    releaseB()
    const releaseAAgain = manager.acquire('session:a', undefined, { freshBaseline: true })

    expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(0)
    expect(socket.emits.filter(({ event, payload }) => event === 'client:subscribe_channels' && payload.channels.includes('session:a'))).toHaveLength(1)
    expect(socket.emits.filter(({ event, payload }) => event === 'client:refresh_channels' && payload.channels.includes('session:a'))).toHaveLength(1)
    expect(manager.snapshot().get('session:a')?.refs).toBe(1)
    expect(manager.snapshot().get('session:b')?.refs).toBe(0)
    releaseAAgain()
  })

  it('keeps visited Workspace rooms warm when changing Sessions and evicts them within the shared cap', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    try {
      const socket = new SocketMock()
      const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => 60_000, maxWarmSessions: 2 })
      manager.acquire('workspace:w1')()
      await vi.waitFor(() => expect(manager.snapshot().get('workspace:w1')?.state).toBe('active'))
      manager.acquire('workspace:w2')()
      expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(0)
      manager.acquire('workspace:w1')()
      expect(socket.emits.filter(({ event, payload }) => event === 'client:subscribe_channels' && payload.channels.includes('workspace:w1'))).toHaveLength(1)
      manager.acquire('workspace:w3')()
      expect(manager.snapshot().has('workspace:w2')).toBe(false)
      expect(manager.snapshot().has('workspace:w1')).toBe(true)
      expect(manager.snapshot().has('workspace:w3')).toBe(true)
    } finally { clock.mockRestore() }
  })

  it('refreshes a warm session expiry when it is reentered', async () => {
    vi.useFakeTimers()
    try {
      const socket = new SocketMock()
      const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => 1_000 })
      const release = manager.acquire('session:s1')
      release()
      await vi.advanceTimersByTimeAsync(500)
      const releaseAgain = manager.acquire('session:s1')
      releaseAgain()
      await vi.advanceTimersByTimeAsync(999)
      expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(1)
      expect(manager.snapshot().has('session:s1')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('immediately removes idle rooms when the warmth setting is disabled', () => {
    const socket = new SocketMock()
    let duration = 60_000
    const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => duration })
    manager.acquire('session:s1')()
    expect(manager.snapshot().has('session:s1')).toBe(true)
    duration = 0
    manager.updateWarmth()
    expect(manager.snapshot().has('session:s1')).toBe(false)
    expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(1)
  })

  it('evicts the least recently used warm session above the cap', () => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => 60_000, maxWarmSessions: 2 })
    for (const id of ['s1', 's2', 's3']) manager.acquire(`session:${id}`)()

    expect(manager.snapshot().has('session:s1')).toBe(false)
    expect(manager.snapshot().has('session:s2')).toBe(true)
    expect(manager.snapshot().has('session:s3')).toBe(true)
    expect(socket.emits.filter(({ event, payload }) => event === 'client:unsubscribe_channels' && payload.channels.includes('session:s1'))).toHaveLength(1)
  })

  it('reports a rejected baseline refresh without dropping the active room', async () => {
    const socket = new SocketMock()
    const onError = vi.fn()
    socket.emit = function (event, payload, ack) {
      this.emits.push({ event, payload })
      queueMicrotask(() => ack?.(event === 'client:refresh_channels'
        ? { requestId: payload.requestId, generation: payload.generation, accepted: [], rejected: [{ channel: 'session:s1', code: 'tenant_forbidden' }], cursors: {} }
        : { requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} }))
      return this
    }
    const manager = new DashboardConnectionManager(socket as never)
    const releasePreview = manager.acquire('session:s1')
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))
    const releaseSelection = manager.acquire('session:s1', undefined, { freshBaseline: true, onError })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('tenant_forbidden'))
    expect(manager.snapshot().get('session:s1')?.state).toBe('active')
    expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(0)
    releaseSelection(); releasePreview()
  })

  it('evicts a throttled expired warm room before reentry and subscribes anew', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      const socket = new SocketMock()
      const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => 1_000 })
      manager.acquire('session:s1')()
      await vi.runAllTicks()
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))

      const release = manager.acquire('session:s1')

      expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(1)
      expect(socket.emits.filter(({ event }) => event === 'client:subscribe_channels')).toHaveLength(2)
      release()
    } finally { vi.useRealTimers() }
  })

  it('drops warm rooms promptly on restore when warmth is changed to zero', async () => {
    const socket = new SocketMock()
    let warmth = 1_000
    const manager = new DashboardConnectionManager(socket as never, { sessionWarmthMs: () => warmth })
    manager.acquire('session:s1')()
    warmth = 0

    await manager.restore()

    expect(manager.snapshot().has('session:s1')).toBe(false)
    expect(socket.emits.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(1)
    expect(socket.emits.filter(({ event }) => event === 'client:restore_subscriptions')).toHaveLength(0)
  })

  it('waits until a channel subscription is active', async () => {
    const socket = new SocketMock()
    let acknowledge: (() => void) | undefined
    socket.emit = function (event: string, payload: any, ack?: (value: any) => void) {
      this.emits.push({ event, payload })
      if (event === 'client:subscribe_channels') {
        acknowledge = () => ack?.({
          requestId: payload.requestId,
          generation: payload.generation,
          accepted: payload.channels,
          rejected: [],
          cursors: {},
        })
      }
      return this
    }
    const manager = new DashboardConnectionManager(socket as never)
    const release = manager.acquire('session:s1')
    const ready = manager.waitUntilActive('session:s1')

    expect(manager.snapshot().get('session:s1')?.state).toBe('subscribing')
    acknowledge?.()
    await expect(ready).resolves.toBe(true)
    release()
  })
})
