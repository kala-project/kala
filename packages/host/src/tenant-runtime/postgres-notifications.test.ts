import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { listenPostgresNotifications } from './postgres-notifications.js'

class Client extends EventEmitter {
  connect = vi.fn().mockResolvedValue(undefined)
  query = vi.fn().mockResolvedValue({})
  end = vi.fn().mockResolvedValue(undefined)
}

afterEach(() => { vi.useRealTimers() })

it('listens outside transactions and ignores unrelated notifications and events after shutdown', async () => {
  const client = new Client()
  const listener = vi.fn()
  const stop = await listenPostgresNotifications(() => client, 'inbox_test', listener)
  expect(client.query).toHaveBeenCalledExactlyOnceWith('LISTEN "inbox_test"')
  expect(listener).toHaveBeenCalledExactlyOnceWith()
  client.emit('notification', { channel: 'another_channel', payload: 'unrelated' })
  expect(listener).toHaveBeenCalledTimes(1)
  client.emit('notification', { channel: 'inbox_test', payload: 'changed' })
  expect(listener).toHaveBeenLastCalledWith('changed')
  await stop()
  client.emit('notification', { channel: 'inbox_test', payload: 'late' })
  expect(listener).toHaveBeenCalledTimes(2)
  expect(client.end).toHaveBeenCalledOnce()
})

it('reconnects after connection loss and invalidates the missed-notification gap', async () => {
  vi.useFakeTimers()
  const clients: Client[] = []
  const listener = vi.fn()
  const stop = await listenPostgresNotifications(() => {
    const client = new Client()
    clients.push(client)
    return client
  }, 'inbox_test', listener)
  clients[0]!.emit('error', new Error('lost'))
  clients[0]!.emit('end')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(clients).toHaveLength(2)
  expect(listener).toHaveBeenCalledTimes(2)
  expect(clients[1]!.query).toHaveBeenCalledExactlyOnceWith('LISTEN "inbox_test"')
  await stop()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(vi.getTimerCount()).toBe(0)
})

it('fails initial setup cleanly instead of silently abandoning notifications', async () => {
  vi.useFakeTimers()
  const client = new Client()
  client.connect.mockRejectedValue(new Error('unavailable'))
  await expect(listenPostgresNotifications(() => client, 'inbox_test', vi.fn())).rejects.toThrow('unavailable')
  expect(vi.getTimerCount()).toBe(0)
  expect(client.end).toHaveBeenCalledOnce()
})
