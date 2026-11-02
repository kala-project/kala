import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import {
  APP_DEBUG_ACK_MS, APP_DEBUG_CHUNK_BYTES, APP_DEBUG_LEASE_MS,
  AppDebugExecutorRequestSchema, AppDebugFrameSchema, AppDebugPortsSchema, appDebugOk, appDebugWait,
  type AppDebugExecutorRequest, type AppDebugFrame, type AppDebugReply,
} from '@agent-kernel/shared'
import { AppDebugRelay, type AppDebugTarget } from './app-debug.js'
import { createAppDebugEndpoint } from '../../../executor/src/app-debug.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers() })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  const request = vi.fn(async (_request: AppDebugExecutorRequest) => appDebugOk)
  let target: AppDebugTarget | undefined = { executorId: 'exec', connectionId: 'connection-1', request }
  const relay = new AppDebugRelay(() => target)
  cleanup.push(() => relay.close())
  const authorize = vi.fn(async (): Promise<string | undefined> => undefined)
  const deliver = vi.fn(async (_frame: AppDebugFrame) => appDebugOk)
  const closed = vi.fn()
  const start = async () => {
    const reply = await relay.start({ owner: 'desktop', workspaceId: 'workspace', executorId: 'exec', ports: [5173, 5000], authorize, deliver, closed })
    expect(reply.ok).toBe(true)
    if (!reply.ok || !reply.grantId) throw new Error('grant missing')
    return reply.grantId
  }
  return { relay, request, authorize, deliver, closed, start, replace: (value: AppDebugTarget | undefined) => { target = value } }
}
async function server(onConnection: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); onConnection(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TCP address missing')
  return { server, port: address.port }
}

describe('app debug v1 boundaries', () => {
  it.each([[], [80], [65536], [5173, 5173], Array.from({ length: 9 }, (_, i) => 5000 + i)])('rejects invalid/manual port group %j', (ports) => {
    expect(AppDebugPortsSchema.safeParse(ports).success).toBe(false)
  })
  it('accepts a maximum frame but rejects oversized, noncanonical and arbitrary-address payloads', () => {
    const frame = { op: 'data', grantId: 'grant', streamId: 'stream', seq: 0, data: Buffer.alloc(APP_DEBUG_CHUNK_BYTES).toString('base64') }
    expect(AppDebugFrameSchema.safeParse(frame).success).toBe(true)
    expect(AppDebugFrameSchema.safeParse({ ...frame, data: Buffer.alloc(APP_DEBUG_CHUNK_BYTES + 1).toString('base64') }).success).toBe(false)
    for (const data of ['YQ', 'YR==', '!!!!', '']) expect(AppDebugFrameSchema.safeParse({ ...frame, data }).success).toBe(false)
    expect(AppDebugExecutorRequestSchema.safeParse({ op: 'open', grantId: 'grant', streamId: 'stream', port: 5173, host: '169.254.169.254' }).success).toBe(false)
  })
  it('never dispatches work cancelled before the queued microtask, and explains uncertainty', async () => {
    const abort = new AbortController(); const operation = vi.fn(async () => appDebugOk)
    const pending = appDebugWait(operation, abort.signal); abort.abort()
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('may already have executed') })
    expect(operation).not.toHaveBeenCalled()
  })
  it('bounds a lost acknowledgement without retry', async () => {
    vi.useFakeTimers()
    const operation = vi.fn(() => new Promise<AppDebugReply>(() => {}))
    const pending = appDebugWait(operation)
    await vi.advanceTimersByTimeAsync(APP_DEBUG_ACK_MS)
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('outcome is unknown') })
    expect(operation).toHaveBeenCalledTimes(1)
  })
})

describe('Host grant fencing and bounded relay', () => {
  it('rejects another Dashboard owner, another Executor and unapproved ports without forwarding', async () => {
    const f = fixture(); const grantId = await f.start(); f.request.mockClear()
    const open = { op: 'open', grantId, streamId: 'one', port: 5173 }
    expect((await f.relay.frame('other', open)).ok).toBe(false)
    expect((await f.relay.executorFrame('other', { op: 'data', grantId, streamId: 'one', seq: 0, data: 'YQ==' })).ok).toBe(false)
    expect((await f.relay.frame('desktop', { ...open, port: 5432 })).ok).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
  })
  it('checks authority on start/open/renew, not every data frame, and rejects duplicate sequence', async () => {
    const f = fixture(); const grantId = await f.start()
    expect((await f.relay.frame('desktop', { op: 'open', grantId, streamId: 'one', port: 5173 })).ok).toBe(true)
    const frame = { op: 'data', grantId, streamId: 'one', seq: 0, data: 'YQ==' }
    expect((await f.relay.frame('desktop', frame)).ok).toBe(true)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect((await f.relay.frame('desktop', frame)).ok).toBe(false)
    expect(f.relay.activeStreams()).toBe(0)
    expect((await f.relay.renew('desktop', grantId)).ok).toBe(true)
    expect(f.authorize).toHaveBeenCalledTimes(3)
  })
  it.each(['start', 'open', 'renew'] as const)('cannot dispatch %s when local authority changes during its awaited check', async (op) => {
    const f = fixture(); let current = true
    f.relay.setAvailability(() => current)
    const grantId = op === 'start' ? undefined : await f.start()
    let release!: () => void
    f.authorize.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    const pending = op === 'start'
      ? f.relay.start({ owner: 'desktop', workspaceId: 'workspace', executorId: 'exec', ports: [5173], authorize: f.authorize, deliver: f.deliver, closed: f.closed })
      : op === 'open' ? f.relay.frame('desktop', { op: 'open', grantId, streamId: 'race', port: 5173 })
        : f.relay.renew('desktop', grantId!)
    await tick(); f.request.mockClear(); current = false; release()
    expect((await pending).ok).toBe(false)
    expect(f.relay.activeGrants()).toBe(0)
    expect(f.request.mock.calls.every(([request]) => request.op === 'stop')).toBe(true)
  })
  it('fences both directions even between data admission and queued dispatch, without async authority', async () => {
    const f = fixture(); let current = true
    f.relay.setAvailability(() => current)
    for (const direction of ['input', 'output'] as const) {
      current = true
      const grantId = await f.start()
      expect((await f.relay.frame('desktop', { op: 'open', grantId, streamId: 'race', port: 5173 })).ok).toBe(true)
      f.request.mockClear(); f.deliver.mockClear(); f.authorize.mockClear()
      const frame = { op: 'data', grantId, streamId: 'race', seq: 0, data: 'YQ==' }
      const pending = direction === 'input' ? f.relay.frame('desktop', frame) : f.relay.executorFrame('connection-1', frame)
      current = false // appDebugWait has not run its queued operation yet.
      expect((await pending).ok).toBe(false)
      expect(f.request.mock.calls.every(([request]) => request.op === 'stop')).toBe(true)
      expect(f.deliver).not.toHaveBeenCalled()
      expect(f.authorize).not.toHaveBeenCalled()
      expect(f.relay.activeGrants()).toBe(0)
    }
    current = true; f.relay.close()
    expect((await f.relay.start({ owner: 'desktop', workspaceId: 'workspace', executorId: 'exec', ports: [5173], authorize: f.authorize, deliver: f.deliver, closed: f.closed })).ok).toBe(false)
  })
  it('closes on superseding connection and never replays to the replacement', async () => {
    const f = fixture(); const grantId = await f.start(); const replacement = vi.fn(async () => appDebugOk)
    f.replace({ executorId: 'exec', connectionId: 'connection-2', request: replacement }); f.relay.targetsChanged()
    expect(f.relay.activeGrants()).toBe(0)
    expect(f.closed).toHaveBeenCalledWith({ grantId, error: expect.stringContaining('replaced') })
    expect((await f.relay.frame('desktop', { op: 'open', grantId, streamId: 'one', port: 5173 })).ok).toBe(false)
    expect(replacement).not.toHaveBeenCalled()
  })
  it('cancels a pending authorization before a late start can create an orphaned grant', async () => {
    const f = fixture(); let authorize!: (error: string | undefined) => void
    f.authorize.mockImplementation(() => new Promise((resolve) => { authorize = resolve }))
    const pending = f.relay.start({ owner: 'desktop', workspaceId: 'workspace', executorId: 'exec', ports: [5173], authorize: f.authorize, deliver: f.deliver, closed: f.closed })
    await tick(); f.relay.closeOwner('desktop'); authorize(undefined)
    expect((await pending).ok).toBe(false)
    expect(f.relay.activeGrants()).toBe(0)
    expect(f.request.mock.calls.every((args) => args[0].op !== 'start')).toBe(true)
  })
  it('expires an unrenewed grant and revokes a denied renewal', async () => {
    vi.useFakeTimers(); const f = fixture(); const grantId = await f.start()
    await vi.advanceTimersByTimeAsync(APP_DEBUG_LEASE_MS)
    expect(f.relay.activeGrants()).toBe(0)
    expect((await f.relay.renew('desktop', grantId)).ok).toBe(false)
    const next = await f.start(); f.authorize.mockResolvedValue('Session owner moved. Reconnect.')
    expect(await f.relay.renew('desktop', next)).toEqual({ ok: false, error: 'Session owner moved. Reconnect.' })
    expect(f.relay.activeGrants()).toBe(0)
  })
  it('limits concurrent streams while open authorization is still pending', async () => {
    const f = fixture(); const grantId = await f.start()
    f.authorize.mockImplementation(() => new Promise(() => {}))
    const pending = Array.from({ length: 32 }, (_, i) => f.relay.frame('desktop', { op: 'open', grantId, streamId: `s${i}`, port: 5173 }))
    expect((await f.relay.frame('desktop', { op: 'open', grantId, streamId: 'excess', port: 5173 })).ok).toBe(false)
    expect(f.relay.activeStreams()).toBe(32)
    f.relay.closeOwner('desktop'); expect((await Promise.all(pending)).every((reply) => !reply.ok)).toBe(true)
    expect(f.relay.activeStreams()).toBe(0)
  })
})

describe('real loopback TCP through Host and Executor relay', () => {
  it('forwards two approved ports, ordered binary chunks and response-after-half-close', async () => {
    const first = await server((socket) => { const chunks: Buffer[] = []; socket.on('data', (data) => chunks.push(data)); socket.on('end', () => socket.end(Buffer.concat([Buffer.from('first:'), ...chunks]))) })
    const second = await server((socket) => { socket.on('data', (data) => socket.write(data)); socket.on('end', () => socket.end()) })
    const received = new Map<string, Buffer[]>(); const eof = new Set<string>()
    let relay!: AppDebugRelay
    const endpoint = createAppDebugEndpoint({ send: (frame) => relay.executorFrame('real-connection', frame) })
    relay = new AppDebugRelay(() => ({ executorId: 'real', connectionId: 'real-connection', request: endpoint.request }))
    cleanup.push(() => { relay.close(); endpoint.close() })
    const reply = await relay.start({ owner: 'desktop', workspaceId: 'ws', executorId: 'real', ports: [first.port, second.port], authorize: async () => undefined, closed: () => {}, deliver: async (frame) => {
      if (frame.op === 'data') received.set(frame.streamId, [...received.get(frame.streamId) ?? [], Buffer.from(frame.data, 'base64')])
      if (frame.op === 'end') eof.add(frame.streamId)
      return appDebugOk
    } })
    if (!reply.ok || !reply.grantId) throw new Error('start failed')
    const grantId = reply.grantId
    const body = Buffer.alloc(40_003); for (let i = 0; i < body.length; i++) body[i] = i % 251
    for (const [streamId, port] of [['first', first.port], ['second', second.port]] as const) {
      expect((await relay.frame('desktop', { op: 'open', grantId, streamId, port })).ok).toBe(true)
      let seq = 0
      for (let offset = 0; offset < body.length; offset += APP_DEBUG_CHUNK_BYTES) expect((await relay.frame('desktop', { op: 'data', grantId, streamId, seq: seq++, data: body.subarray(offset, offset + APP_DEBUG_CHUNK_BYTES).toString('base64') })).ok).toBe(true)
      expect((await relay.frame('desktop', { op: 'end', grantId, streamId, seq })).ok).toBe(true)
    }
    await vi.waitFor(() => expect(eof.size).toBe(2))
    expect(Buffer.concat(received.get('first')!)).toEqual(Buffer.concat([Buffer.from('first:'), body]))
    expect(Buffer.concat(received.get('second')!)).toEqual(body)
    await vi.waitFor(() => { expect(endpoint.activeStreams()).toBe(0); expect(relay.activeStreams()).toBe(0) })
  })
  it('stops reading Executor response while its downstream acknowledgement is held', async () => {
    const service = await server((socket) => socket.write(Buffer.alloc(256 * 1024, 7)))
    const frames: AppDebugFrame[] = []; let release!: (reply: AppDebugReply) => void
    const endpoint = createAppDebugEndpoint({ send: (frame) => {
      frames.push(frame)
      return frame.op === 'data' ? new Promise((resolve) => { release = resolve }) : Promise.resolve(appDebugOk)
    } })
    cleanup.push(() => endpoint.close())
    expect((await endpoint.request({ op: 'start', grantId: 'grant', ports: [service.port] })).ok).toBe(true)
    expect((await endpoint.request({ op: 'open', grantId: 'grant', streamId: 'one', port: service.port })).ok).toBe(true)
    await vi.waitFor(() => expect(frames.filter((frame) => frame.op === 'data')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(frames).toHaveLength(1)
    endpoint.close(); release(appDebugOk); await tick()
    expect(endpoint.activeStreams()).toBe(0)
    expect(frames).toHaveLength(1)
  })
  it('fails closed under HTTP-only restricted policy and rejects arbitrary targets', async () => {
    const endpoint = createAppDebugEndpoint({ send: async () => appDebugOk, networkPolicy: { version: 1, policyId: 'restricted', revision: '1', defaultAction: 'deny', rules: [] } })
    cleanup.push(() => endpoint.close())
    expect(await endpoint.request({ op: 'start', grantId: 'grant', ports: [5173] })).toMatchObject({ ok: false, error: expect.stringContaining('opaque TCP') })
    expect(endpoint.activeGrants()).toBe(0)
    expect((await endpoint.request({ op: 'open', grantId: 'grant', streamId: 's', port: 5173, host: '192.0.2.1' })).ok).toBe(false)
  })
})
