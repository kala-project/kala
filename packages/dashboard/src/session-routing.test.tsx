import { createElement } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { createSessionWithAck, runSessionCommand, SessionInspectionContext, useDashboardControlSocket, useSession } from './session.js'
import { useSubAgentSession } from './features/chat/useSubAgentSession.js'
import { workspaceExec } from './lib/workspace-exec.js'

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

describe('target Session commands', () => {
  it('waits for exact target readiness and keeps the ticket socket through the command ACK', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(routeResponse('target-ticket')))
    const control = new FakeSocket()
    let acknowledge!: (value: string) => void
    const ack = new Promise<string>((resolve) => { acknowledge = resolve })
    const command = vi.fn(() => ack)

    const running = runSessionCommand({
      host: window.location.origin,
      sessionId: 'other-session',
      sharedSocket: control as never,
      sessionRouteTickets: true,
    }, command as never)

    await waitFor(() => expect(sockets).toHaveLength(1))
    const target = sockets[0]!
    expect(socketOptions[0]).toMatchObject({
      query: { runtimeRouteTicket: 'target-ticket' },
      auth: { sessionId: 'other-session' },
      forceNew: true,
      autoConnect: false,
      reconnection: false,
    })
    act(() => target.serverEmit('connect'))
    expect(command).not.toHaveBeenCalled()

    act(() => target.serverEmit('session:ready', { sessionId: 'other-session' }))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledWith(target)
    expect(target.closed).toBe(false)
    act(() => target.serverEmit('session:ready', { sessionId: 'other-session' }))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())

    acknowledge('renamed')
    await expect(running).resolves.toBe('renamed')
    expect(target.closed).toBe(true)
    expect(control.emit).not.toHaveBeenCalled()
  })

  it.each([
    ['unavailable', new Response(JSON.stringify({ error: 'route_ticket_unavailable' }), { status: 404 })],
    ['relocating', new Response(JSON.stringify({ error: 'session_relocating' }), { status: 503 })],
  ])('rejects a %s route without falling back to the control socket', async (_kind, response) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
    const control = new FakeSocket()
    const command = vi.fn(async () => undefined)

    await expect(runSessionCommand({
      host: window.location.origin,
      sessionId: 'unroutable',
      sharedSocket: control as never,
      sessionRouteTickets: true,
    }, command as never)).rejects.toThrow()

    expect(sockets).toHaveLength(0)
    expect(command).not.toHaveBeenCalled()
    expect(control.emit).not.toHaveBeenCalled()
  })

  it('opens a direct cookie-authenticated Dedicated Session without requesting a ticket', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const control = new FakeSocket()
    const command = vi.fn(async () => 'deleted')
    const running = runSessionCommand({
      host: window.location.origin,
      sessionId: 'dedicated-target',
      sharedSocket: control as never,
      sessionScoped: true,
    }, command as never)

    expect(sockets).toHaveLength(1)
    expect(socketOptions[0]).toMatchObject({
      auth: { sessionId: 'dedicated-target' },
      forceNew: true,
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      withCredentials: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => sockets[0]!.serverEmit('session:ready', { sessionId: 'dedicated-target' }))
    await expect(running).resolves.toBe('deleted')
    expect(sockets[0]!.closed).toBe(true)
    expect(control.emit).not.toHaveBeenCalled()
  })

  it('closes owned command connections on wrong readiness, synchronous callback failure and disconnect before ACK', async () => {
    const control = new FakeSocket()
    const input = { host: window.location.origin, sessionId: 'target', sharedSocket: control as never, sessionScoped: true }
    const wrongCommand = vi.fn(async () => undefined)
    const wrong = runSessionCommand(input, wrongCommand)
    sockets.at(-1)!.serverEmit('session:ready', { sessionId: 'wrong-target' })
    await expect(wrong).rejects.toThrow('did not match')
    expect(wrongCommand).not.toHaveBeenCalled()
    expect(sockets.at(-1)!.closed).toBe(true)

    const throwing = runSessionCommand(input, () => { throw new Error('fixture callback failure') })
    const failing = sockets.at(-1)!
    failing.serverEmit('session:ready', { sessionId: 'target' })
    await expect(throwing).rejects.toThrow('fixture callback failure')
    expect(failing.closed).toBe(true)
    expect(failing.handlers.get('disconnect')).toHaveLength(0)

    const command = vi.fn(() => new Promise<void>(() => {}))
    const interrupted = runSessionCommand(input, command)
    const interruptedSocket = sockets.at(-1)!
    interruptedSocket.serverEmit('session:ready', { sessionId: 'target' })
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    interruptedSocket.serverEmit('disconnect', 'fixture transport loss')
    await expect(interrupted).rejects.toThrow('fixture transport loss')
    expect(interruptedSocket.closed).toBe(true)
    expect(command).toHaveBeenCalledOnce()
    expect(control.emit).not.toHaveBeenCalled()
  })

  it('uses the shared Portable socket without opening a target transport', async () => {
    const control = new FakeSocket()
    const command = vi.fn(async () => 'updated')

    await expect(runSessionCommand({
      host: window.location.origin,
      sessionId: 'portable-target',
      sharedSocket: control as never,
    }, command as never)).resolves.toBe('updated')

    expect(command).toHaveBeenCalledWith(control)
    expect(sockets).toHaveLength(0)
    expect(control.closed).toBe(false)
  })
})

describe('routed Session hook', () => {
  it.each([
    { auth: { sessionId: 'session-1' }, channel: 'session:session-1' },
    { auth: { clientId: 'dashboard-1' }, channel: 'workspace:workspace-1' },
  ])('binds Workspace RPC readiness to $channel without exceeding socket scope', async ({ auth, channel }) => {
    const socket = new FakeSocket()
    Object.assign(socket, { auth, connected: true })
    socket.emit.mockImplementation((...args: unknown[]) => {
      const [event, payload, ack] = args as [string, { requestId: string; generation: number; channels: string[] }, (result: unknown) => void]
      if (event === 'client:subscribe_channels') ack({ requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} })
      if (event === 'workspace:exec') ack({ requestId: payload.requestId, stdout: 'calculator.cjs', stderr: '', exitCode: 0, durationMs: 1 })
      return socket
    })
    await expect(workspaceExec(socket as never, 'workspace-1', ['ls'])).resolves.toMatchObject({ exitCode: 0, stdout: 'calculator.cjs' })
    expect(socket.emit).toHaveBeenCalledWith('client:subscribe_channels', expect.objectContaining({ channels: [channel] }), expect.any(Function))
  })

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

  it.each(['dedicated', 'private-cloud'])('inspects a %s child on its own lazy owner connection, never the parent capability', async (mode) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(routeResponse('child-ticket'))
    vi.stubGlobal('fetch', fetchMock)
    const control = new FakeSocket()
    const parent = new FakeSocket()
    const transport = { host: window.location.origin, socket: control as never, sessionScoped: mode === 'dedicated', sessionRouteTickets: mode === 'private-cloud' }
    const view = renderHook(({ expanded }) => useSubAgentSession({
      socket: parent as never, parentSessionId: 'parent', parentCallId: 'call', initialChildSessionId: 'child', mirrorMessages: expanded,
    }), { initialProps: { expanded: false }, wrapper: ({ children }) => createElement(SessionInspectionContext.Provider, { value: transport }, children) })
    expect(sockets).toHaveLength(0)
    view.rerender({ expanded: true })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const child = sockets[0]!
    expect(socketOptions[0]).toMatchObject({ forceNew: true, transports: ['websocket'], auth: { sessionId: 'child' } })
    expect(parent.emit.mock.calls.some(([name]) => name === 'client:subscribe_channels')).toBe(false)
    if (mode === 'private-cloud') expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ sessionId: 'child' })
    else expect(fetchMock).not.toHaveBeenCalled()
    act(() => child.serverEmit('session:error', { sessionId: 'child', scope: 'host', message: 'child owner unavailable' }))
    await waitFor(() => expect(view.result.current.transcriptError).toBe('child owner unavailable'))
    view.rerender({ expanded: false })
    expect(child.closed).toBe(true)
    expect(parent.closed).toBe(false)
    expect(control.closed).toBe(false)
    view.unmount()
  })

  it('binds Dedicated Workspace effects to an independent Session without route tickets', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const control = new FakeSocket()
    control.connected = true
    const view = renderHook(({ sessionId }) => useSession({
      host: window.location.origin, sessionId, socket: control as never, sessionScoped: true,
    }), { initialProps: { sessionId: 'dedicated-1' } })
    expect(sockets).toHaveLength(1)
    const bound = sockets[0]!
    const options = socketOptions[0] as { auth: { sessionId: string; clientId?: string } }
    expect(options).toMatchObject({ forceNew: true, withCredentials: true, transports: ['websocket'], auth: { sessionId: 'dedicated-1' } })
    expect(options.auth.clientId).toBeUndefined()
    Object.assign(bound, { auth: options.auth, connected: true })
    bound.emit.mockImplementation((...args: unknown[]) => {
      const [event, payload, ack] = args as [string, { requestId: string; generation: number; channels: string[] }, (result: unknown) => void]
      if (event === 'client:subscribe_channels') ack({ requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} })
      if (event === 'workspace:exec') ack({ requestId: payload.requestId, stdout: 'repository', stderr: '', exitCode: 0, durationMs: 1 })
      return bound
    })
    expect(view.result.current.socket).toBe(bound)
    await expect(workspaceExec(view.result.current.socket!, 'workspace-1', ['git', 'status'])).resolves.toMatchObject({ exitCode: 0 })
    expect(bound.emit).toHaveBeenCalledWith('client:subscribe_channels', expect.objectContaining({ channels: ['session:dedicated-1'] }), expect.any(Function))
    expect(control.emit).not.toHaveBeenCalled()
    view.rerender({ sessionId: 'dedicated-2' })
    expect(bound.closed).toBe(true)
    expect(view.result.current.socket).toBe(sockets[1])
    expect(socketOptions[1]).toMatchObject({ auth: { sessionId: 'dedicated-2' } })
    view.unmount()
    expect(sockets[1]!.closed).toBe(true)
    expect(control.closed).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps visited Dedicated Session transports warm only within the same cache identity', () => {
    const cacheA = { get: () => null, set: () => null } as never
    const cacheB = { get: () => null, set: () => null } as never
    const control = new FakeSocket()
    const options = { host: window.location.origin, socket: control as never, sessionScoped: true }
    const view = renderHook(({ sessionId, cache }) => useSession({ ...options, sessionId, cache }), {
      initialProps: { sessionId: 'session-one', cache: cacheA },
    })
    const first = sockets[0]!
    first.connected = true
    act(() => first.serverEmit('session:ready', {
      sessionId: 'session-one', reason: 'load', agentRuntime: 'copilot', cursor: 0,
      state: createInitialState({ sessionId: 'session-one' }), config: { tools: [] },
    }))
    view.rerender({ sessionId: 'session-two', cache: cacheA })
    expect(first.closed).toBe(false)
    const second = sockets[1]!
    second.connected = true
    view.rerender({ sessionId: 'session-one', cache: cacheA })
    expect(sockets).toHaveLength(2)
    expect(view.result.current.socket).toBe(first)
    expect(first.emit).toHaveBeenCalledWith('client:refresh_channels',
      expect.objectContaining({ channels: ['session:session-one'] }), expect.any(Function))
    expect(view.result.current.status).toBe('connecting')
    const [, refresh, acknowledge] = first.emit.mock.calls.find(([event]) => event === 'client:refresh_channels')!
    act(() => {
      first.serverEmit('session:ready', {
        sessionId: 'session-one', reason: 'load', agentRuntime: 'copilot', cursor: 1,
        state: { ...createInitialState({ sessionId: 'session-one' }), status: 'done' },
        config: { tools: [] },
      })
      acknowledge({ requestId: refresh.requestId, generation: refresh.generation, accepted: refresh.channels, rejected: [], cursors: {} })
    })
    expect(view.result.current.status).toBe('ready')
    expect(view.result.current.state?.status).toBe('done')
    expect(second.closed).toBe(false)
    view.rerender({ sessionId: 'session-one', cache: cacheB })
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(true)
    expect(sockets).toHaveLength(3)
    view.unmount()
    expect(sockets[2]!.closed).toBe(true)
  })

  it('reopens a Session transport when a warm baseline refresh is rejected', () => {
    const cache = { get: () => null, set: () => null } as never
    const view = renderHook(({ sessionId }) => useSession({
      host: window.location.origin, sessionId, cache, sessionScoped: true,
    }), { initialProps: { sessionId: 'session-one' } })
    const first = sockets[0]!
    first.connected = true
    view.rerender({ sessionId: 'session-two' })
    view.rerender({ sessionId: 'session-one' })
    const [, refresh, acknowledge] = first.emit.mock.calls.find(([event]) => event === 'client:refresh_channels')!
    act(() => acknowledge({
      requestId: refresh.requestId, generation: refresh.generation,
      accepted: [], rejected: [{ channel: 'session:session-one', code: 'not_subscribed' }], cursors: {},
    }))
    expect(first.closed).toBe(true)
    expect(sockets).toHaveLength(3)
    expect(view.result.current.socket).toBe(sockets[2])
    view.unmount()
  })

  it('reuses a routed Session ticket transport only while connected', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(routeResponse('ticket-one'))
      .mockResolvedValueOnce(routeResponse('ticket-two'))
      .mockResolvedValueOnce(routeResponse('ticket-one-new'))
    vi.stubGlobal('fetch', fetchMock)
    const cache = { get: () => null, set: () => null } as never
    const view = renderHook(({ sessionId }) => useSession({
      host: window.location.origin, sessionId, cache, sessionRouteTickets: true,
    }), { initialProps: { sessionId: 'session-one' } })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const first = sockets[0]!
    first.connected = true
    view.rerender({ sessionId: 'session-two' })
    await waitFor(() => expect(sockets).toHaveLength(2))
    first.connected = false
    view.rerender({ sessionId: 'session-one' })
    await waitFor(() => expect(sockets).toHaveLength(3))
    expect(first.closed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(socketOptions[2]).toMatchObject({ query: { runtimeRouteTicket: 'ticket-one-new' } })
    view.unmount()
  })

  it('closes a Session transport on switch when warmth is disabled', () => {
    window.localStorage.setItem('ak-session-subscription-warmth-minutes', '0')
    try {
      const cache = { get: () => null, set: () => null } as never
      const view = renderHook(({ sessionId }) => useSession({
        host: window.location.origin, sessionId, cache, sessionScoped: true,
      }), { initialProps: { sessionId: 'session-one' } })
      sockets[0]!.connected = true
      view.rerender({ sessionId: 'session-two' })
      expect(sockets[0]!.closed).toBe(true)
      view.unmount()
    } finally {
      window.localStorage.removeItem('ak-session-subscription-warmth-minutes')
    }
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
