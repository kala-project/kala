import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSessionWithAck, useDashboardControlSocket, useSession } from './session.js'

const sockets: FakeSocket[] = []
const socketOptions: unknown[] = []

vi.mock('socket.io-client', () => ({
  io: vi.fn((_url: string, options: unknown) => {
    socketOptions.push(options)
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }),
}))

class FakeSocket {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  io = { on: vi.fn() }
  connected = false
  closed = false
  connect = vi.fn(() => this)
  close = vi.fn(() => { this.closed = true; this.connected = false })
  disconnect = vi.fn(() => { this.closed = true; this.connected = false })
  emit = vi.fn(() => this)
  timeout = vi.fn(() => ({ emitWithAck: vi.fn(async () => ({ ok: true })) }))
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }
  off(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler))
    return this
  }
  serverEmit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

const routeResponse = (ticket: string): Response => new Response(JSON.stringify({ ticket }), { status: 200 })
const sessionOptions = (sessionId: string, socket: FakeSocket | null = null) => ({
  host: window.location.origin, sessionId, socket: socket as never, sessionRouteTickets: true,
})

afterEach(() => {
  vi.unstubAllGlobals()
  sockets.length = 0
  socketOptions.length = 0
})

describe('routed Session hook', () => {
  it('opens the global control channel without polling so a Unit-routed Gateway can connect', () => {
    const view = renderHook(() => useDashboardControlSocket(window.location.origin))
    expect(sockets).toHaveLength(1)
    expect(socketOptions[0]).toMatchObject({
      transports: ['websocket'],
      auth: { role: 'dashboard', clientId: expect.any(String) },
    })
    view.unmount()
    expect(sockets[0]!.closed).toBe(true)
  })

  it('creates a private-cloud Session on a fresh Gateway-selected control connection', async () => {
    const shared = new FakeSocket()
    const creating = createSessionWithAck(shared as never, { sessionId: 'placed-session' }, 1_000, {
      host: window.location.origin,
    })
    expect(sockets).toHaveLength(1)
    const placement = sockets[0]!
    act(() => { placement.serverEmit('connect') })
    await expect(creating).resolves.toBeUndefined()
    expect(socketOptions[0]).toMatchObject({
      forceNew: true, reconnection: false, transports: ['websocket'], withCredentials: true,
    })
    expect(placement.timeout).toHaveBeenCalledWith(1_000)
    expect(placement.timeout.mock.results[0]!.value.emitWithAck)
      .toHaveBeenCalledWith('client:create_session', expect.objectContaining({ sessionId: 'placed-session' }))
    expect(placement.closed).toBe(true)
    expect(shared.emit).not.toHaveBeenCalled()
  })

  it('waits for its ticket, binds an independent websocket, then refreshes the ticket on disconnect', async () => {
    let deliver!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { deliver = resolve }))
      .mockResolvedValueOnce(routeResponse('ticket-2'))
    vi.stubGlobal('fetch', fetchMock)
    const control = new FakeSocket()
    const view = renderHook(() => useSession(sessionOptions('session-1', control)))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(0)
    await act(async () => { deliver(routeResponse('ticket-1')) })
    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(sockets[0]!.connect).toHaveBeenCalledOnce()
    expect(socketOptions[0]).toMatchObject({
      forceNew: true, reconnection: false, transports: ['websocket'],
      query: { runtimeRouteTicket: 'ticket-1' },
    })
    expect(view.result.current.socket).toBe(sockets[0])
    expect(control.emit).not.toHaveBeenCalled()
    act(() => { sockets[0]!.serverEmit('connect') })
    act(() => { sockets[0]!.serverEmit('disconnect', 'transport close') })
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2_000 })
    expect(sockets[0]!.closed).toBe(true)
    expect(socketOptions[1]).toMatchObject({ query: { runtimeRouteTicket: 'ticket-2' } })
    view.unmount()
  })

  it('prepares an existing Session owner again after its routed Runtime fails', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'session_relocating' }), {
        status: 503, headers: { 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(routeResponse('prepared-ticket'))
      // A rolling-upgrade Gateway still emits the old collapsed response.
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'session_owner_unavailable' }), { status: 404 }))
      .mockResolvedValueOnce(routeResponse('takeover-ticket'))
    vi.stubGlobal('fetch', fetchMock)
    const control = new FakeSocket()
    control.connected = true
    const view = renderHook(() => useSession(sessionOptions('existing-session', control)))
    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(control.timeout).toHaveBeenCalledWith(3_000)
    expect(control.timeout.mock.results[0]!.value.emitWithAck)
      .toHaveBeenCalledWith('client:prepare_session_route', { sessionId: 'existing-session' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(socketOptions[0]).toMatchObject({ query: { runtimeRouteTicket: 'prepared-ticket' } })

    act(() => { sockets[0]!.serverEmit('connect') })
    act(() => { sockets[0]!.serverEmit('disconnect', 'transport close') })
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2_000 })
    expect(control.timeout).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(socketOptions[1]).toMatchObject({ query: { runtimeRouteTicket: 'takeover-ticket' } })
    view.unmount()
  })

  it('uses the shared Unit socket only when the Gateway explicitly disables route tickets', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: 'route_ticket_unavailable' }), { status: 404 },
    )))
    const control = new FakeSocket()
    control.connected = true
    const view = renderHook(() => useSession(sessionOptions('legacy', control)))
    await waitFor(() => expect(view.result.current.socket).toBe(control))
    expect(sockets).toHaveLength(0)
    expect(control.emit).toHaveBeenCalledWith('client:subscribe_channels', expect.anything(), expect.anything())
    view.unmount()
  })

  it('does not open a fallback socket for missing owners and ignores late tickets after selection changes', async () => {
    let deliver!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { deliver = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'session_missing' }), { status: 404 })))
    const control = new FakeSocket()
    const view = renderHook(({ sessionId }) => useSession(sessionOptions(sessionId, control)), {
      initialProps: { sessionId: 'old' },
    })
    view.rerender({ sessionId: 'new' })
    await act(async () => { deliver(routeResponse('stale-ticket')) })
    await waitFor(() => expect(view.result.current.status).toBe('error'))
    expect(sockets).toHaveLength(0)
    expect(control.emit).not.toHaveBeenCalled()
    view.unmount()
  })

  it.each([
    [410, 'session_deleting'],
    [404, 'session_missing'],
  ])('treats terminal route response %s %s as non-retryable', async (status, error) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error }), { status }))
    vi.stubGlobal('fetch', fetchMock)
    const control = new FakeSocket()
    control.connected = true
    const view = renderHook(() => useSession(sessionOptions('terminal-session', control)))

    await waitFor(() => expect(view.result.current.status).toBe('error'))
    act(() => { window.dispatchEvent(new Event('online')) })
    await new Promise((resolve) => window.setTimeout(resolve, 10))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(control.timeout).not.toHaveBeenCalled()
    expect(control.emit).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(0)
    view.unmount()
  })
})
