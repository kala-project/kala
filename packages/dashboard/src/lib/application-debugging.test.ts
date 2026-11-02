import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_DEBUG_LEASE_MS, appDebugOk, type AppDebugReply } from '@agent-kernel/shared'
import type { DashboardSocket } from '../session.js'
import type { ApplicationDebugBridge, NativeDebugEvent } from './desktop-bridge.js'
import { connectApplicationDebugging } from './application-debugging.js'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0)) close(); vi.useRealTimers() })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function harness() {
  const events = new EventEmitter()
  const native: Array<(event: NativeDebugEvent) => void> = []
  const context = { principalKey: 'f'.repeat(64), workspaceId: 'ws', executorId: 'exec' }
  const send = vi.fn(async (_event: string, request: { op: string }): Promise<AppDebugReply> => {
    if (request.op === 'context') return { ok: true, context }
    if (request.op === 'start') return { ok: true, grantId: 'grant-1' }
    return appDebugOk
  })
  const source = { connected: true, on: events.on.bind(events), off: events.off.bind(events), timeout: () => source, emitWithAck: send }
  const bridge = {
    version: 1 as const,
    begin: vi.fn(async (listener: (event: NativeDebugEvent) => void) => { native.push(listener); return native.length }),
    setContext: vi.fn(async () => {}), reply: vi.fn(async () => {}), receive: vi.fn(async () => {}),
    touch: vi.fn(async () => {}), abort: vi.fn(async () => {}), detach: vi.fn(async () => {}),
    unavailable: vi.fn(async () => {}), show: vi.fn(async () => {}),
  } satisfies ApplicationDebugBridge
  const close = connectApplicationDebugging(bridge, source as unknown as DashboardSocket, 'session')
  dispose.push(close)
  const start = () => native.at(-1)!({ generation: native.length, run: 1, id: 1, request: { op: 'start', ports: [5173, 5000] } })
  return { bridge, context, events, native, send, source, start, close }
}

describe('desktop application debugging relay lifecycle', () => {
  it('only binds context, never auto-starts or renews/polls while inactive', async () => {
    vi.useFakeTimers(); const h = harness(); await flush()
    expect(h.bridge.setContext).toHaveBeenCalledWith(1, { ...h.context, sessionId: 'session' })
    await vi.advanceTimersByTimeAsync(APP_DEBUG_LEASE_MS * 2)
    expect(h.send.mock.calls.map((call) => call[1].op)).toEqual(['context'])
    expect(h.bridge.reply).not.toHaveBeenCalled()
  })
  it('starts only on native approval and renews only the active group', async () => {
    vi.useFakeTimers(); const h = harness(); await flush(); h.start(); await flush()
    expect(h.send).toHaveBeenCalledWith('app_debug:control', { op: 'start', sessionId: 'session', executorId: 'exec', ports: [5173, 5000] })
    expect(h.bridge.reply).toHaveBeenCalledWith(1, 1, { ok: true, grantId: 'grant-1' })
    await vi.advanceTimersByTimeAsync(APP_DEBUG_LEASE_MS / 2)
    expect(h.bridge.touch).toHaveBeenCalledWith(1, 'grant-1')
    h.native[0]!({ generation: 1, run: 1, id: 0, request: { op: 'stop', grantId: 'grant-1' } }); await flush()
    const count = h.send.mock.calls.length
    await vi.advanceTimersByTimeAsync(APP_DEBUG_LEASE_MS)
    expect(h.send.mock.calls).toHaveLength(count)
  })
  it('acknowledges Host data only after native TCP write and rejects wrong grant', async () => {
    const h = harness(); await flush(); h.start(); await flush()
    let release!: () => void
    h.bridge.receive.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const ack = vi.fn(); const frame = { op: 'data', grantId: 'grant-1', streamId: 'stream', seq: 0, data: 'YQ==' }
    h.events.emit('app_debug:frame', frame, ack); await flush()
    expect(h.bridge.receive).toHaveBeenCalledWith(1, frame)
    expect(ack).not.toHaveBeenCalled(); release(); await flush(); expect(ack).toHaveBeenCalledWith({ ok: true })
    const denied = vi.fn(); h.events.emit('app_debug:frame', { ...frame, grantId: 'another' }, denied)
    expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(h.bridge.receive).toHaveBeenCalledTimes(1)
  })
  it('stops a late successful start after cancellation instead of reviving it', async () => {
    const h = harness(); await flush()
    let complete!: (reply: AppDebugReply) => void
    h.send.mockImplementation(async (_event, request) => request.op === 'start' ? new Promise((resolve) => { complete = resolve }) : appDebugOk)
    h.start(); await flush()
    h.native[0]!({ generation: 1, run: 1, id: 0, request: { op: 'stop' } }); await flush()
    complete({ ok: true, grantId: 'late-grant' }); await flush()
    expect(h.bridge.reply).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('app_debug:control', { op: 'stop', grantId: 'late-grant' })
    h.native[0]!({ generation: 1, run: 1, id: 2, request: { op: 'start', ports: [5173] } }); await flush()
    expect(h.bridge.reply).toHaveBeenCalledWith(1, 2, expect.objectContaining({ ok: false }))
  })
  it('disconnects without buffering commands, ignores old native callbacks, and reconnects context only', async () => {
    const h = harness(); await flush(); h.start(); await flush(); const old = h.native[0]!
    h.source.connected = false; const count = h.send.mock.calls.length; h.events.emit('disconnect'); await flush()
    expect(h.bridge.detach).toHaveBeenCalledWith(1)
    old({ generation: 1, run: 1, id: 2, request: { op: 'frame', frame: { op: 'data', grantId: 'grant-1', streamId: 'stream', seq: 0, data: 'YQ==' } } }); await flush()
    expect(h.send.mock.calls).toHaveLength(count)
    h.source.connected = true; h.events.emit('connect'); await flush()
    expect(h.bridge.setContext).toHaveBeenLastCalledWith(2, { ...h.context, sessionId: 'session' })
    expect(h.send.mock.calls.filter((call) => call[1].op === 'start')).toHaveLength(1)
    h.close(); expect(h.events.listenerCount('app_debug:frame')).toBe(0)
  })
  it('reports an incompatible or unauthorized Host without starting a group', async () => {
    const h = harness()
    h.send.mockResolvedValue({ ok: false, error: 'Session is not subscribed. Select an authorized Session.' })
    await flush()
    expect(h.bridge.unavailable).toHaveBeenCalledWith(1, expect.stringContaining('not subscribed'))
    expect(h.bridge.setContext).not.toHaveBeenCalled()
    expect(h.bridge.reply).not.toHaveBeenCalled()
  })
})
