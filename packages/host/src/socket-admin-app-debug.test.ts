import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client, type Socket } from 'socket.io-client'
import { instrument } from '@socket.io/admin-ui'
import { expect, it, vi } from 'vitest'
import { redactApplicationDebugAdminEvents } from './socket-admin.js'

it('real Admin UI development capture redacts both debug directions/namespaces without changing transport or ordinary diagnostics', async () => {
  const http = createServer(); const io = new Server(http)
  const dashboard = io.of('/dashboard'); const executor = io.of('/executor')
  const observed: unknown[][] = []; const transported: unknown[] = []; const clients: Socket[] = []
  const secret = 'fixture-application-login-cookie-and-opaque-bytes'
  const frame = { op: 'data', grantId: 'private-grant', streamId: 'private-stream', seq: 0, data: Buffer.from(secret).toString('base64') }
  redactApplicationDebugAdminEvents(io.of('/admin'))
  instrument(io, { auth: false, mode: 'development' })
  dashboard.on('connection', (socket) => {
    socket.on('app_debug:frame', (body) => { transported.push(body); socket.emit('app_debug:frame', body) })
    socket.on('fixture:ordinary', (body) => socket.emit('fixture:ordinary', body))
  })
  executor.on('connection', (socket) => socket.on('executor:app_debug_frame', (body) => { transported.push(body); socket.emit('executor:app_debug_request', body) }))
  try {
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
    const connect = async (namespace: string) => {
      const socket = client(`http://127.0.0.1:${address.port}${namespace}`, { transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false })
      clients.push(socket)
      await new Promise<void>((done, fail) => { socket.once('connect', done); socket.once('connect_error', fail); socket.connect() })
      return socket
    }
    const admin = await connect('/admin')
    admin.on('event_received', (...args) => observed.push(['received', ...args]))
    admin.on('event_sent', (...args) => observed.push(['sent', ...args]))
    const browser = await connect('/dashboard'); const machine = await connect('/executor')
    browser.emit('app_debug:frame', frame); machine.emit('executor:app_debug_frame', frame)
    browser.emit('fixture:ordinary', { visible: 'ordinary diagnostic' })
    await vi.waitFor(() => expect(observed.length).toBeGreaterThanOrEqual(6))
    expect(transported).toEqual([frame, frame])
    const debugEvents = observed.filter((entry) => Array.isArray(entry[3]) && String(entry[3][0]).includes('app_debug'))
    expect(debugEvents).toHaveLength(4)
    for (const event of debugEvents) expect(event[3]).toEqual([expect.any(String), { redacted: true, reason: expect.any(String) }])
    const serialized = JSON.stringify(observed)
    expect(serialized).not.toContain(frame.data)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(frame.grantId)
    expect(serialized).toContain('ordinary diagnostic')
  } finally {
    for (const socket of clients) socket.close()
    await new Promise<void>((done) => io.close(() => done()))
  }
})
