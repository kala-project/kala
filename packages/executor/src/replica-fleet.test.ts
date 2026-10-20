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
