import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer, type Socket as TcpSocket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { startHostServer, type HostServer } from '@agent-kernel/host'
import { PROTOCOL_VERSION, type AppDebugControl, type AppDebugReply, type DashboardClientToServerEvents, type DashboardServerToClientEvents } from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'
import { startExecutor } from './client.js'
import { ulid } from 'ulid'

type Dashboard = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
it('forwards two real ports over token-authenticated events, fences owners/sessions and never changes the conversation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kala-debug-wire-'))
  const config = createConfig({ tools: [], systemPrompt: 'fixture' })
  const token = 'fixture-token'
  const workspaceId = ulid()
  const dashboards: Dashboard[] = []
  const sockets = new Set<TcpSocket>()
  const services = [0, 1].map((index) => tcpServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    const received: Buffer[] = []
    socket.on('data', (data) => received.push(data))
    socket.on('end', () => socket.end(Buffer.concat([Buffer.from(`service-${index}:`), ...received])))
  }))
  let phase = 'host setup'
  const diagnostic = setTimeout(() => console.error('app-debug fixture stalled in:', phase), 5000)
  let host: HostServer | undefined
  let executor: ReturnType<typeof startExecutor> | undefined
  const dashboard = async (url: string, sessionId: string): Promise<Dashboard> => {
    const socket: Dashboard = io(`${url}/dashboard`, { transports: ['websocket'], auth: { role: 'dashboard', clientVersion: PROTOCOL_VERSION, sessionId, token }, reconnection: false, retries: 0, autoConnect: false, forceNew: true })
    dashboards.push(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture dashboard did not become ready')), 3000)
      socket.once('session:ready', () => { clearTimeout(timer); resolve() })
      socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
      socket.connect()
    })
    return socket
  }
  try {
    for (const service of services) await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    const ports = services.map((service) => { const address = service.address(); if (!address || typeof address === 'string') throw new Error('fixture port missing'); return address.port })
    const http = httpServer(); await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Host fixture port missing')
    host = await startHostServer({ port: address.port, httpServer: http, sessionsDir: join(root, 'sessions'), authToken: token, defaultConfig: config, llm: { name: 'unused', async call() { throw new Error('Debugging must not call a model') } } })
    const url = `http://127.0.0.1:${host.port}`
    await host.store.ensure({ sessionId: 'debug-session', workspaceId, workspaceName: 'fixture', defaultConfig: config })
    await host.store.ensure({ sessionId: 'unsubscribed-session', workspaceId, workspaceName: 'fixture', defaultConfig: config })
    phase = 'Dashboard handshake'
    const owner = await dashboard(url, 'debug-session')
    const other = await dashboard(url, 'debug-session')
    executor = startExecutor({ host: url, token, workspaceId, workspaceName: 'fixture', sandboxRoots: [root] })
    phase = 'Executor handshake'
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Executor fixture handshake did not finish in 3 seconds')), 3000)
      executor!.ready.then(() => { clearTimeout(timer); resolve() })
      executor!.permanentError.then((error) => { clearTimeout(timer); reject(new Error(`Executor fixture rejected: ${error.code}: ${error.message}`)) })
      executor!.socket.once('connect_error', (error) => { clearTimeout(timer); reject(new Error(`Executor fixture handshake failed: ${error.message}`)) })
    })
    await vi.waitFor(() => expect(host!.executorsSnapshot().some((entry) => entry.workspaceId === workspaceId)).toBe(true))
    const control = (socket: Dashboard, request: AppDebugControl): Promise<AppDebugReply> => socket.timeout(3000).emitWithAck('app_debug:control', request)
    phase = 'authorized context'
    const context = await control(owner, { op: 'context', sessionId: 'debug-session' })
    expect(context.ok).toBe(true)
    if (!context.ok || !context.context) throw new Error('No authorized context')
    expect(context.context.executorId).toBe(executor.executorId)
    expect(context.context.principalKey).toMatch(/^[a-f0-9]{64}$/u)
    expect(await control(owner, { op: 'context', sessionId: 'unsubscribed-session' })).toMatchObject({ ok: false, error: expect.stringContaining('unsubscribed') })
    const before = structuredClone(host.store.get('debug-session')!.state)
    phase = 'grant start'
    const started = await control(owner, { op: 'start', sessionId: 'debug-session', executorId: context.context.executorId, ports })
    if (!started.ok || !started.grantId) throw new Error(`Start failed: ${JSON.stringify(started)}`)
    const grantId = started.grantId
    expect((await other.timeout(3000).emitWithAck('app_debug:frame', { op: 'open', grantId, streamId: 'stolen', port: ports[0]! })).ok).toBe(false)
    const received = new Map<string, Buffer[]>(); const eof = new Set<string>()
    owner.on('app_debug:frame', (frame, ack) => {
      if (frame.op === 'data') received.set(frame.streamId, [...received.get(frame.streamId) ?? [], Buffer.from(frame.data, 'base64')])
      if (frame.op === 'end') eof.add(frame.streamId)
      ack({ ok: true })
    })
    phase = 'TCP frames'
    const body = Buffer.from('not-a-conversation-message\0binary\xff', 'latin1')
    for (let index = 0; index < ports.length; index++) {
      const streamId = `stream-${index}`
      expect((await owner.timeout(3000).emitWithAck('app_debug:frame', { op: 'open', grantId, streamId, port: ports[index]! })).ok).toBe(true)
      expect((await owner.timeout(3000).emitWithAck('app_debug:frame', { op: 'data', grantId, streamId, seq: 0, data: body.toString('base64') })).ok).toBe(true)
      expect((await owner.timeout(3000).emitWithAck('app_debug:frame', { op: 'end', grantId, streamId, seq: 1 })).ok).toBe(true)
    }
    phase = 'duplex EOF'
    await vi.waitFor(() => expect(eof.size).toBe(2))
    for (let index = 0; index < ports.length; index++) expect(Buffer.concat(received.get(`stream-${index}`)!)).toEqual(Buffer.concat([Buffer.from(`service-${index}:`), body]))
    expect(host.store.get('debug-session')!.state).toEqual(before)
    const serverSocket = host.io.of('/dashboard').sockets.get(other.id!)!
    serverSocket.data.readOnly = true
    expect(await control(other, { op: 'context', sessionId: 'debug-session' })).toMatchObject({ ok: false, error: expect.stringContaining('runtime:write') })
    expect(await control(owner, { op: 'stop', grantId })).toEqual({ ok: true })
    expect((await owner.timeout(3000).emitWithAck('app_debug:frame', { op: 'open', grantId, streamId: 'after-stop', port: ports[0]! })).ok).toBe(false)
  } finally {
    for (const socket of dashboards) socket.close()
    phase = 'Executor shutdown'
    await executor?.close()
    phase = 'Host shutdown'
    await host?.close()
    for (const socket of sockets) socket.destroy()
    phase = 'TCP service shutdown'
    for (const service of services) await new Promise<void>((resolve) => service.close(() => resolve()))
    clearTimeout(diagnostic)
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
