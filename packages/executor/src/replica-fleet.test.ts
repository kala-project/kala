import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { discoverExecutorReplicas, startExecutorReplicaFleet } from './replica-fleet.js'

describe('Executor replica discovery', () => {
  it('authenticates with a route hint and returns sorted opaque replica ids', async () => {
    const request = vi.fn(async (_url: URL) => new Response(JSON.stringify({ replicas: ['runtime-y', 'runtime-x'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(discoverExecutorReplicas({
      host: 'https://gateway.example/base',
      routeHint: 'a'.repeat(43),
      fetch: request as typeof fetch,
    })).resolves.toEqual(['runtime-x', 'runtime-y'])
    expect(request).toHaveBeenCalledWith(
      new URL('https://gateway.example/.well-known/kala/executor-replicas'),
      { headers: { 'x-kala-executor-route': 'a'.repeat(43) } },
    )
  })

  it('preserves the exclusive default path when discovery is unavailable', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 404 }))
    await expect(discoverExecutorReplicas({
      host: 'https://gateway.example', invite: 'ak_invite_test', fetch: request as typeof fetch,
    })).resolves.toBeUndefined()
  })

  it('disconnects every stale socket when membership validation fails and reconnects recovered members', async () => {
    vi.useFakeTimers()
    try {
      const sockets: Array<{ connected: boolean; io: EventEmitter; on(event: string, handler: (...args: never[]) => void): void; emit(): boolean; disconnect(): void }> = []
      const ioFactory = vi.fn(() => {
        const events = new EventEmitter()
        const socket = {
          connected: true,
          io: new EventEmitter(),
          on(event: string, handler: (...args: never[]) => void) { events.on(event, handler) },
          emit() { return true },
          disconnect() { socket.connected = false },
        }
        sockets.push(socket)
        return socket
      })
      const refresh = vi.fn()
        .mockRejectedValueOnce(new Error('PostgreSQL unavailable'))
        .mockResolvedValueOnce(['runtime-z'])
      const fleet = startExecutorReplicaFleet({
        host: 'https://gateway.example', token: 'ak_exec_test', routeHint: 'a'.repeat(43),
        replicaIds: ['runtime-x', 'runtime-y'], refreshReplicaIds: refresh, refreshIntervalMs: 100,
        workspaceId: 'workspace', workspaceName: 'workspace', executorId: 'executor', tools: [],
        ioFactory: ioFactory as never, receiptStorePath: false,
      })

      expect(sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets.slice(0, 2).every((socket) => !socket.connected)).toBe(true)
      expect(fleet.replicaIds()).toEqual([])
      await vi.advanceTimersByTimeAsync(100)
      expect(fleet.replicaIds()).toEqual(['runtime-z'])
      expect(sockets).toHaveLength(3)
      await fleet.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('promotes a routed exclusive connection after draining, preserving enrollment and execution receipts without downgrade', async () => {
    vi.useFakeTimers()
    const sockets: ReturnType<typeof makeSocket>[] = []
    function makeSocket() {
      const events = new EventEmitter()
      const socket = {
        connected: true, auth: {} as unknown, io: new EventEmitter(),
        on(event: string, handler: (...args: never[]) => void) { events.on(event, handler) },
        emit() { return true }, disconnect() { socket.connected = false },
        trigger(event: string, ...args: unknown[]) { events.emit(event, ...args) },
      }
      return socket
    }
    const factory = vi.fn(() => { const socket = makeSocket(); sockets.push(socket); return socket })
    let replicas: readonly string[] | undefined
    let finish!: () => void
    const effect = new Promise<void>((resolve) => { finish = resolve })
    const run = vi.fn(async () => { await effect; return 'one effect' })
    const savedToken = vi.fn()
    const fleet = startExecutorReplicaFleet({
      host: 'https://gateway.example', invite: 'ak_invite_test', routeHint: 'a'.repeat(43),
      workspaceId: 'workspace', workspaceName: 'workspace', executorId: 'executor',
      tools: [{ name: 'probe', run }], receiptStorePath: false, ioFactory: factory as never,
      refreshReplicaIds: async () => replicas, refreshIntervalMs: 100, onToken: savedToken,
    })
    try {
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets).toHaveLength(1)
      expect(fleet.connected()).toBe(true)
      replicas = ['runtime-x', 'runtime-y']
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets).toHaveLength(1) // Enrollment must finish before invite fanout.
      sockets[0]!.trigger('executor:welcome', { token: 'ak_exec_enrolled' })
      expect(savedToken).toHaveBeenCalledWith('ak_exec_enrolled')
      const request = { sessionId: 'session', callId: 'once', name: 'probe', input: {} }
      const firstAck = vi.fn()
      sockets[0]!.trigger('tool:call', request, firstAck)
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.connected).toBe(true)
      finish()
      await vi.advanceTimersByTimeAsync(100)
      expect(firstAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true, content: 'one effect' }))
      expect(sockets).toHaveLength(3)
      expect(sockets[0]!.connected).toBe(false)
      expect(fleet.replicaIds()).toEqual(['runtime-x', 'runtime-y'])
      const connection = factory.mock.calls as unknown as Array<[string, { auth: Record<string, unknown>; extraHeaders: Record<string, string> }]>
      expect(connection[1]![1].auth).toMatchObject({ token: 'ak_exec_enrolled' })
      expect(connection[1]![1].auth).not.toHaveProperty('invite')
      const duplicateAck = vi.fn()
      sockets[1]!.trigger('tool:call', request, duplicateAck)
      await vi.advanceTimersByTimeAsync(0)
      expect(duplicateAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true, content: 'one effect' }))
      expect(run).toHaveBeenCalledTimes(1)
      replicas = undefined
      await vi.advanceTimersByTimeAsync(100)
      expect(fleet.connected()).toBe(false)
      expect(sockets).toHaveLength(3)
    } finally {
      finish()
      await fleet.close()
      vi.useRealTimers()
    }
  })

  it('fails closed for malformed or duplicate membership', async () => {
    for (const replicas of [['runtime-x', 'runtime-x'], ['runtime-x', 'bad replica']]) {
      await expect(discoverExecutorReplicas({
        host: 'https://gateway.example',
        routeHint: 'a'.repeat(43),
        fetch: (async () => new Response(JSON.stringify({ replicas }), { status: 200 })) as typeof fetch,
      })).rejects.toThrow('invalid membership')
    }
    await expect(discoverExecutorReplicas({
      host: 'https://gateway.example', routeHint: 'a'.repeat(43),
      fetch: (async () => new Response(JSON.stringify({ replicas: [] }), { status: 200 })) as typeof fetch,
    })).resolves.toEqual([])
  })
})
