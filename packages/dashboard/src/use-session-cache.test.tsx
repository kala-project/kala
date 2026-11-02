import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

import { dashboardConnectionManager, useControlPlane, useDashboardControlSocket, useSession, type TimelineEntry } from './session.js'
import { createSessionViewCache } from './session-view-cache.js'
import { visibleTranscript } from './transcript.js'
import { ChatPanel } from './features/chat/ChatPanel.js'
import { InlineStatusRow } from './features/chat/InlineStatusRow.js'

type Handler = (payload: any) => void

const sockets: MockSocket[] = []

vi.mock('socket.io-client', () => ({
  io: vi.fn((_url: string, _options: unknown) => {
    const socket = new MockSocket()
    sockets.push(socket)
    return socket
  }),
}))

class MockSocket {
  handlers = new Map<string, Handler[]>()
  emitted: Array<{ event: string; payload: unknown; ack?: (value: any) => void }> = []
  io = { on: vi.fn() }
  connected = true

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  off(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? []
    this.handlers.set(event, list.filter((candidate) => candidate !== handler))
    return this
  }

  emit(event: string, payload: unknown, ack?: (value: any) => void): this {
    this.emitted.push({ event, payload, ...(ack ? { ack } : {}) })
    return this
  }

  close(): void {
    this.connected = false
  }

  disconnect(): void {
    this.connected = false
  }

  serverEmit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

function timelineEntry(seq: number): TimelineEntry {
  return {
    seq,
    ts: `2026-07-21T00:00:0${seq}.000Z`,
    event: { kind: 'user_message', text: `message ${seq}` },
    effects: [],
  }
}

function cachedView(sessionId: string, timeline: readonly TimelineEntry[], turnStartedAt?: string) {
  return {
    sessionId,
    status: 'ready' as const,
    state: createInitialState({ sessionId }),
    config: { systemPrompt: 'cached', tools: [] },
    contextSnapshot: null,
    ...(turnStartedAt ? { turnStartedAt, turnStartedAtCursor: timeline.at(-1)?.seq ?? 0 } : {}),
    timeline,
    queuedMessages: [],
    lastError: null,
    parentSessionId: null,
    parentCursor: null,
    selectedModel: null,
    hydratedSessionId: sessionId,
    cachedAt: Date.now(),
    estimatedBytes: 1,
    estimateParts: { staticBytes: 1, stateBytes: 1, timelineBytes: 1 },
  }
}

afterEach(() => {
  sockets.length = 0
})

describe('useSession session view cache', () => {
  it('receives historical and live scheduled attribution without HTTP or idle polling', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const socket = new MockSocket()
    const view = renderHook(({ id }) => useSession({ host: 'http://host', sessionId: id, socket: socket as never }), { initialProps: { id: 'a' } })
    const ready = (sessionId: string) => ({
      sessionId, agentRuntime: 'kernel', cursor: 0, state: createInitialState({ sessionId }),
      config: { systemPrompt: 'test', tools: [] }, scheduledMessageTasks: { historical: 'historical-task' },
    })
    act(() => socket.serverEmit('session:ready', ready('a')))
    expect(view.result.current.scheduledMessageTasks).toEqual({ historical: 'historical-task' })
    act(() => socket.serverEmit('event:appended', {
      sessionId: 'a', ...timelineEntry(1), event: { kind: 'user_message', text: 'Scheduled', operationId: 'new-scheduled' }, scheduledTaskId: 'new-task',
    }))
    await waitFor(() => expect(view.result.current.scheduledMessageTasks?.['new-scheduled']).toBe('new-task'))
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(5 * 60_000) })
    expect(fetcher).not.toHaveBeenCalled()
    view.rerender({ id: 'b' })
    expect(view.result.current.scheduledMessageTasks).toEqual({})
    act(() => socket.serverEmit('session:ready', ready('a')))
    expect(view.result.current.scheduledMessageTasks).toEqual({})
    view.unmount()
    hidden.mockRestore()
    fetcher.mockRestore()
    vi.useRealTimers()
  })

  it('preserves turn timing across rapid A to B to A cache selection and authoritative ready hydration', () => {
    const socket = new MockSocket()
    const cache = createSessionViewCache({ maxBytes: 10 * 1024 * 1024 })
    const aStart = '2026-09-25T12:00:00.000Z'
    const bStart = '2026-09-25T12:01:00.000Z'
    cache.set('a', cachedView('a', [timelineEntry(1)], aStart))
    cache.set('b', cachedView('b', [timelineEntry(1)], bStart))

    const view = renderHook(
      ({ id }) => useSession({ host: 'http://host', sessionId: id, socket: socket as never, cache }),
      { initialProps: { id: 'a' } },
    )
    expect(view.result.current.turnStartedAt).toBe(aStart)
    view.rerender({ id: 'b' })
    expect(view.result.current.turnStartedAt).toBe(bStart)
    view.rerender({ id: 'a' })
    expect(view.result.current.turnStartedAt).toBe(aStart)

    act(() => socket.serverEmit('session:ready', {
      sessionId: 'a', agentRuntime: 'kernel', reason: 'load', cursor: 1,
      state: createInitialState({ sessionId: 'a' }), config: { tools: [] }, contextSnapshot: null,
      turnStartedAt: aStart,
    }))
    expect(view.result.current.hydratedSessionId).toBe('a')
    expect(view.result.current.turnStartedAt).toBe(aStart)
    view.unmount()
  })

  it('applies a committed queued message before the following empty queue snapshot', () => {
    const socket = new MockSocket()
    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 'queued', socket: socket as never }))
    act(() => socket.serverEmit('session:ready', {
      sessionId: 'queued', agentRuntime: 'kernel', reason: 'load', cursor: 0,
      state: createInitialState({ sessionId: 'queued' }), config: { tools: [] }, contextSnapshot: null,
    }))
    act(() => socket.serverEmit('server:message_queue', {
      sessionId: 'queued', pending: 1,
      items: [{ id: 'operation-queued', text: 'follow up', mode: 'queue', createdAt: '2026-09-25T12:00:00.000Z' }],
    }))
    expect(view.result.current.queuedMessages).toHaveLength(1)

    act(() => {
      socket.serverEmit('event:appended', {
        sessionId: 'queued', seq: 1, ts: '2026-09-25T12:00:01.000Z',
        event: { kind: 'user_message', operationId: 'operation-queued', text: 'follow up' }, effects: [],
      })
      socket.serverEmit('server:message_queue', { sessionId: 'queued', pending: 0, items: [] })
    })

    expect(view.result.current.timeline.at(-1)?.event).toMatchObject({ kind: 'user_message', operationId: 'operation-queued' })
    expect(view.result.current.queuedMessages).toEqual([])
    view.unmount()
  })

  it('restores all already-streamed text on a mid-turn session switch and appends only new deltas', () => {
    const socket = new MockSocket()
    const ready = (id: string, text?: string) => ({
      sessionId: id, agentRuntime: 'kernel', reason: 'load', cursor: 1,
      state: { ...createInitialState({ sessionId: id }), status: 'thinking' },
      config: { tools: [] }, contextSnapshot: null,
      ...(text ? { streamingDraft: { text, afterSeq: 1, messageCount: 0 } } : {}),
    })
    const view = renderHook(({ id }) => useSession({ host: 'http://host', sessionId: id, socket: socket as never }), { initialProps: { id: 'first' } })
    act(() => socket.serverEmit('session:ready', ready('first')))
    act(() => socket.serverEmit('session:token_delta', { sessionId: 'first', text: 'old prefix' }))
    view.rerender({ id: 'second' })
    act(() => socket.serverEmit('session:ready', ready('second')))
    view.rerender({ id: 'first' })
    act(() => socket.serverEmit('session:ready', ready('first', 'old prefix while away')))
    expect(view.result.current.streamingText).toBe('old prefix while away')
    act(() => socket.serverEmit('session:token_delta', { sessionId: 'first', text: ' and new suffix' }))
    act(() => socket.serverEmit('state:changed', {
      sessionId: 'first', cursor: 1,
      state: { ...createInitialState({ sessionId: 'first' }), status: 'done' },
      contextSnapshot: null,
    }))
    expect(view.result.current.streamingText).toBe('old prefix while away and new suffix')
    view.unmount()
  })

  it.each(['kernel', 'copilot'] as const)('hydrates a selected %s session even when preview consumed the first ready event', async (agentRuntime) => {
    const socket = new MockSocket()
    const manager = dashboardConnectionManager(socket as never)
    const releasePreview = manager.acquire('session:s1')
    const ready = { sessionId: 's1', agentRuntime, reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }), config: { tools: [] }, contextSnapshot: null }
    socket.serverEmit('session:ready', ready)
    const first = socket.emitted[0]!
    const request = first.payload as { requestId: string; generation: number }
    first.ack?.({ ...request, accepted: ['session:s1'], rejected: [], cursors: {} })
    expect(manager.snapshot().get('session:s1')?.state).toBe('active')

    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 's1', socket: socket as never }))
    expect(socket.emitted.filter(entry => entry.event === 'client:subscribe_channels')).toHaveLength(1)
    expect(socket.emitted.filter(entry => entry.event === 'client:refresh_channels')).toHaveLength(1)
    expect(view.result.current.status).toBe('connecting')
    act(() => socket.serverEmit('session:ready', ready))
    expect(view.result.current.status).toBe('ready')
    expect(view.result.current.hydratedSessionId).toBe('s1')
    releasePreview()
    expect(socket.emitted.some(entry => entry.event === 'client:unsubscribe_channels')).toBe(false)
    view.unmount()
    expect(socket.emitted.filter(entry => entry.event === 'client:unsubscribe_channels')).toHaveLength(0)
    expect(manager.snapshot().get('session:s1')?.refs).toBe(0)
  })

  it('reflects shared control socket failures and waits for a fresh baseline after reconnect', () => {
    const socket = new MockSocket()
    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 's1', socket: socket as never }))
    const ready = { sessionId: 's1', agentRuntime: 'copilot', reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }), config: { tools: [] } }
    act(() => socket.serverEmit('session:ready', ready))
    expect(view.result.current.status).toBe('ready')
    act(() => socket.serverEmit('disconnect', 'transport close'))
    expect(view.result.current.status).toBe('disconnected')
    act(() => socket.serverEmit('connect_error', new Error('network unavailable')))
    expect(view.result.current.status).toBe('disconnected')
    act(() => socket.serverEmit('connect', undefined))
    expect(view.result.current.status).toBe('connecting')
    act(() => socket.serverEmit('session:ready', ready))
    expect(view.result.current.status).toBe('ready')
  })

  it('keeps transient initial shared socket errors in the connecting state', () => {
    const socket = new MockSocket()
    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 's1', socket: socket as never }))
    expect(view.result.current.status).toBe('connecting')
    act(() => socket.serverEmit('connect_error', new Error('websocket error')))
    expect(view.result.current.status).toBe('connecting')
  })

  it('keeps transient reconnect errors disconnected after a ready session drops', () => {
    const socket = new MockSocket()
    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 's1', socket: socket as never }))
    const ready = { sessionId: 's1', agentRuntime: 'copilot', reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }), config: { tools: [] } }
    act(() => socket.serverEmit('session:ready', ready))
    expect(view.result.current.status).toBe('ready')
    act(() => socket.serverEmit('disconnect', 'transport close'))
    expect(view.result.current.status).toBe('disconnected')
    act(() => socket.serverEmit('connect_error', new Error('websocket error')))
    expect(view.result.current.status).toBe('disconnected')
  })

  it('still surfaces permanent shared socket auth failures as errors', () => {
    const socket = new MockSocket()
    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 's1', socket: socket as never }))
    act(() => socket.serverEmit('connect_error', new Error('auth_failed')))
    expect(view.result.current.status).toBe('error')
    expect(socket.connected).toBe(false)
  })

  it('does not leave a rejected shared subscription Connecting forever', () => {
    const socket = new MockSocket()
    const view = renderHook(() => useSession({ host: 'http://host', sessionId: 's1', socket: socket as never }))
    const request = socket.emitted.find(entry => entry.event === 'client:subscribe_channels')!
    act(() => request.ack?.({ ...(request.payload as object), accepted: [], rejected: [{ channel: 'session:s1', code: 'tenant_forbidden' }], cursors: {} }))
    expect(view.result.current.status).toBe('error')
    expect(view.result.current.lastError?.message).toContain('tenant_forbidden')
  })

  it('reuses one physical control socket while switching selected sessions', async () => {
    sockets.length = 0
    const wrapper = ({ sessionId }: { sessionId: string }) => {
      const socket = useDashboardControlSocket('http://host', undefined, true)
      useSession({ host: 'http://host', sessionId, socket })
      return null
    }
    const view = render(React.createElement(wrapper, { sessionId: 's1' }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    view.rerender(React.createElement(wrapper, { sessionId: 's2' }))
    await waitFor(() => expect(sockets[0]?.emitted.some((entry) => entry.event === 'client:subscribe_channels' && (entry.payload as { channels?: string[] }).channels?.includes('session:s2'))).toBe(true))
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.connected).toBe(true)
  })
  it('keeps rapid A to B to A switching on one socket and completes loading only from current history', async () => {
    const wrapper = ({ sessionId }: { sessionId: string }) => {
      const socket = useDashboardControlSocket('http://host', undefined, true)
      return useSession({ host: 'http://host', sessionId, socket })
    }
    const view = renderHook(({ sessionId }) => wrapper({ sessionId }), { initialProps: { sessionId: 'a' } })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    view.rerender({ sessionId: 'b' })
    view.rerender({ sessionId: 'a' })
    await waitFor(() => expect(socket.handlers.get('session:ready')).toHaveLength(1))
    expect(socket.emitted.filter(({ event }) => event === 'client:unsubscribe_channels')).toHaveLength(0)
    expect(socket.emitted.filter(({ event, payload }) => event === 'client:subscribe_channels' && (payload as { channels?: string[] }).channels?.includes('session:a'))).toHaveLength(1)
    expect(socket.emitted.filter(({ event, payload }) => event === 'client:refresh_channels' && (payload as { channels?: string[] }).channels?.includes('session:a'))).toHaveLength(1)

    act(() => socket.serverEmit('session:ready', { sessionId: 'b', reason: 'load', cursor: 1, state: createInitialState({ sessionId: 'b' }), config: { tools: [] }, contextSnapshot: null }))
    expect(view.result.current.hydratedSessionId).not.toBe('b')
    act(() => socket.serverEmit('session:ready', { sessionId: 'a', reason: 'load', cursor: 1, state: createInitialState({ sessionId: 'a' }), config: { tools: [] }, contextSnapshot: null }))
    expect(view.result.current.hydratedSessionId).toBe('a')
    expect(view.result.current.historyLoadedSessionId).toBeNull()

    act(() => socket.serverEmit('server:history', { sessionId: 'b', entries: [timelineEntry(1)] }))
    expect(view.result.current.historyLoadedSessionId).toBeNull()
    act(() => socket.serverEmit('server:history', { sessionId: 'a', entries: [timelineEntry(1)] }))
    expect(view.result.current.historyLoadedSessionId).toBe('a')
    expect(view.result.current.timeline.map((entry) => entry.seq)).toEqual([1])
    expect(sockets).toHaveLength(1)
    expect(socket.connected).toBe(true)
  })

  it('never exposes the previous projection under a newly selected session', async () => {
    const socket = new MockSocket()
    const observations: Array<{
      requested: string
      stateSessionId: string | null
      timelineText: string
      approvalSessionId: string | null
    }> = []
    const Probe = ({ sessionId }: { sessionId: string }) => {
      const current = useSession({ host: 'http://host', sessionId, socket: socket as never })
      observations.push({
        requested: sessionId,
        stateSessionId: current.state?.sessionId ?? null,
        timelineText: current.timeline.map((entry) => entry.event.kind === 'user_message' ? entry.event.text : '').join(''),
        approvalSessionId: current.pendingApprovals[0]?.sessionId ?? null,
      })
      return null
    }
    const view = render(<Probe sessionId="a" />)
    act(() => socket.serverEmit('session:ready', {
      sessionId: 'a',
      agentRuntime: 'kernel',
      reason: 'load',
      cursor: 41,
      state: {
        ...createInitialState({ sessionId: 'a' }),
        status: 'awaiting_approval',
        pendingCalls: [{
          callId: 'approval-a',
          name: 'shell',
          input: { command: 'private-a' },
          status: 'awaiting_approval',
        }],
      },
      config: { tools: [] },
      contextSnapshot: null,
    }))
    act(() => socket.serverEmit('server:history', {
      sessionId: 'a',
      entries: [{ ...timelineEntry(41), event: { kind: 'user_message', text: 'message-only-from-a' } }],
    }))
    await waitFor(() => expect(observations.at(-1)?.stateSessionId).toBe('a'))

    observations.length = 0
    view.rerender(<Probe sessionId="b" />)

    expect(observations.filter((entry) => entry.requested === 'b')).not.toEqual([])
    for (const observation of observations.filter((entry) => entry.requested === 'b')) {
      expect(observation.stateSessionId).not.toBe('a')
      expect(observation.timelineText).not.toContain('message-only-from-a')
      expect(observation.approvalSessionId).not.toBe('b')
    }
  })

  it('removes session listeners when a shared socket is rebound', async () => {
    sockets.length = 0
    const wrapper = ({ sessionId }: { sessionId: string }) => {
      const socket = useDashboardControlSocket('http://host', undefined, true)
      return useSession({ host: 'http://host', sessionId, socket }).streamingText
    }
    const view = renderHook(({ sessionId }) => wrapper({ sessionId }), {
      initialProps: { sessionId: 's1' },
    })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    expect(socket.handlers.get('session:token_delta')).toHaveLength(1)

    view.rerender({ sessionId: 's2' })
    await waitFor(() => expect(socket.handlers.get('session:token_delta')).toHaveLength(1))
    view.rerender({ sessionId: 's1' })
    await waitFor(() => expect(socket.handlers.get('session:token_delta')).toHaveLength(1))

    // Every delta must have exactly one consumer after repeated workspace/session
    // switches; leaked handlers append the same streamed text multiple times.
    expect(socket.handlers.get('event:appended')).toHaveLength(1)
    expect(socket.handlers.get('state:changed')).toHaveLength(1)
  })

  it('keeps streamed text visible while the turn transitions into tool execution', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const flushFrames = async (count = 20): Promise<void> => {
      for (let index = 0; index < count && frames.length > 0; index += 1) {
        const callback = frames.shift()!
        await act(async () => callback(performance.now()))
      }
    }
    try {
      window.localStorage.setItem('ak-smooth-streaming-text', 'false')
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
      await waitFor(() => expect(sockets).toHaveLength(1))
      const socket = sockets[0]!
      const thinking = { ...createInitialState({ sessionId: 's1' }), status: 'thinking' as const }
      act(() => socket.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 1, state: thinking, config: { tools: [] }, contextSnapshot: null,
      }))
      act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'visible draft before tool' }))
      await flushFrames()
      await waitFor(() => expect(result.current.streamingText).toBe('visible draft before tool'))

      act(() => socket.serverEmit('state:changed', {
        sessionId: 's1',
        state: {
          ...thinking,
          status: 'executing_tools',
          pendingCalls: [{ callId: 'call-1', name: 'bash', input: { command: 'true' }, status: 'dispatched' }],
        },
        contextSnapshot: null,
      }))
      await flushFrames()

      expect(result.current.state?.status).toBe('executing_tools')
      expect(result.current.streamingText).toBe('visible draft before tool')
      expect(result.current.streamingActive).toBe(false)

      act(() => socket.serverEmit('event:appended', {
        sessionId: 's1',
        seq: 2,
        ts: 't2',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'call-1', name: 'bash', input: { command: 'true' } }],
          },
        },
        effects: [{ kind: 'call_tool', callId: 'call-1', name: 'bash', input: { command: 'true' } }],
      }))
      await flushFrames()

      expect(result.current.timeline.at(-1)?.event.kind).toBe('llm_response')
      expect(result.current.streamingText).toBe('visible draft before tool')
      expect(result.current.streamingActive).toBe(false)
    } finally {
      raf.mockRestore()
      caf.mockRestore()
      window.localStorage.removeItem('ak-smooth-streaming-text')
    }
  })

  it.each(['done', 'idle', 'error', 'executing_tools', 'awaiting_approval'] as const)(
    'finishes the rendered draft on %s without losing unrevealed tokens or joining the next turn',
    async (status) => {
      const initial = { ...createInitialState({ sessionId: 's1' }), status: 'thinking' as const }
      let current: ReturnType<typeof useSession>
      function Conversation() {
        current = useSession({ host: 'http://host.test', sessionId: 's1' })
        return <ChatPanel messages={[]} items={visibleTranscript(
          current.state?.messages ?? [], current.timeline, current.streamingText, [], [], current,
        )} footerSlot={<InlineStatusRow state={current.state} streamingActive={current.streamingActive} />} />
      }
      render(<Conversation />)
      await waitFor(() => expect(sockets).toHaveLength(1))
      const socket = sockets[0]!
      act(() => socket.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', agentRuntime: 'copilot', cursor: 0, state: initial, config: { tools: [] },
      }))
      act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'Retain this complete draft.' }))
      await waitFor(() => expect(screen.queryByTestId('streaming-cursor')).not.toBeNull())
      act(() => socket.serverEmit('state:changed', { sessionId: 's1', state: { ...initial, status }, cursor: 0 }))
      await waitFor(() => expect(current!.state?.status).toBe(status))
      expect(screen.queryByTestId('streaming-cursor')).toBeNull()
      expect(screen.getByText('Retain this complete draft.')).toBeTruthy()
      expect(current!.streamingActive).toBe(false)
      act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'LATE_DELTA' }))
      expect(current!.streamingText).toBe('Retain this complete draft.')
      act(() => socket.serverEmit('state:changed', { sessionId: 's1', state: initial, cursor: 0 }))
      await waitFor(() => expect(current!.state?.status).toBe('thinking'))
      expect(screen.getByText('Retain this complete draft.')).toBeTruthy()
      expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
      act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'Separate next answer.' }))
      await waitFor(() => expect(current!.streamingText).toBe('Separate next answer.'))
      expect(screen.getAllByTestId('streaming-cursor')).toHaveLength(1)
      expect(screen.getByText('Retain this complete draft.')).toBeTruthy()
      expect(current!.retainedDrafts).toHaveLength(1)
    },
  )

  it('reconciles a state-only runtime completion and renders its authoritative history during the next stream', async () => {
    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    const initial = { ...createInitialState({ sessionId: 's1' }), status: 'thinking' as const }
    act(() => socket.serverEmit('session:ready', { sessionId: 's1', reason: 'load', agentRuntime: 'copilot', cursor: 0, state: initial, config: { tools: [] } }))
    act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'draft' }))
    const completed = { ...initial, status: 'done', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Current turn request.' }] },
      { role: 'assistant', content: [{ type: 'tool_call', callId: 'call-1', name: 'bash', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Authoritative answer.' }] },
    ] }
    act(() => socket.serverEmit('state:changed', { sessionId: 's1', state: completed, cursor: 1 }))
    await waitFor(() => expect(result.current.state?.status).toBe('done'))
    expect(result.current.streamingText).toBe('')
    expect(result.current.streamingActive).toBe(false)
    act(() => socket.serverEmit('state:changed', { sessionId: 's1', state: { ...completed, status: 'thinking' }, cursor: 1 }))
    act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'Next stream.' }))
    await waitFor(() => expect(result.current.streamingText).toBe('Next stream.'))
    const items = visibleTranscript(result.current.state!.messages, [], result.current.streamingText, [], [], result.current)
    expect(items).toHaveLength(4)
    expect(items[2]).toMatchObject({ message: { content: [{ text: 'Authoritative answer.' }] } })
    expect(items[3]).toMatchObject({ streaming: true, message: { content: [{ text: 'Next stream.' }] } })
    act(() => socket.serverEmit('disconnect', 'transport close'))
    expect(result.current.streamingActive).toBe(false)
    act(() => socket.serverEmit('session:ready', { sessionId: 's1', reason: 'load', agentRuntime: 'copilot', cursor: 1, state: { ...completed, status: 'thinking' }, config: { tools: [] } }))
    expect(result.current.streamingActive).toBe(false)
    expect(result.current.retainedDrafts).toHaveLength(1)
  })

  it.each(['cancel', 'llm_error'] as const)('stops a draft from the %s event even without a state correction', async (kind) => {
    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    act(() => socket.serverEmit('session:ready', { sessionId: 's1', cursor: 0, state: { ...createInitialState({ sessionId: 's1' }), status: 'thinking' }, config: { tools: [] } }))
    act(() => socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'Partial answer.' }))
    act(() => socket.serverEmit('event:appended', { sessionId: 's1', seq: 1, ts: 't1', event: kind === 'cancel' ? { kind } : { kind, error: 'failed' }, effects: [] }))
    expect(result.current.streamingActive).toBe(false)
    expect(result.current.streamingText).toBe('Partial answer.')
  })

  it('does not let completion erase the next response when events arrive within one animation frame', async () => {
    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    const thinking = { ...createInitialState({ sessionId: 's1' }), status: 'thinking' as const }
    act(() => {
      socket.serverEmit('session:ready', { sessionId: 's1', cursor: 0, state: thinking, config: { tools: [] } })
      socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'first' })
      socket.serverEmit('event:appended', { sessionId: 's1', seq: 1, ts: 't1', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }, effects: [{ kind: 'finish' }] })
      socket.serverEmit('state:changed', { sessionId: 's1', state: thinking })
      socket.serverEmit('session:token_delta', { sessionId: 's1', text: 'second' })
    })
    await waitFor(() => expect(result.current.streamingText).toBe('second'))
    expect(result.current.streamingActive).toBe(true)
  })

  it('keeps a dashboard control socket independent from the selected session hook', async () => {
    const { rerender, unmount } = renderHook(
      ({ sessionId }) => ({
        control: useDashboardControlSocket('http://host.test'),
        session: useSession({ host: 'http://host.test', sessionId }),
      }),
      { initialProps: { sessionId: 's1' as string | null } },
    )

    await waitFor(() => expect(sockets).toHaveLength(2))
    const controlSocket = sockets[0]!
    const sessionSocket = sockets[1]!
    expect(controlSocket.emitted.some((entry) => entry.event === 'client:subscribe_channels' && (entry.payload as { channels?: string[] }).channels?.includes('global'))).toBe(true)
    expect(sessionSocket.connected).toBe(true)

    rerender({ sessionId: null })

    expect(sessionSocket.connected).toBe(false)
    expect(controlSocket.connected).toBe(true)

    unmount()
    expect(controlSocket.connected).toBe(false)
  })

  it('keeps control-plane data loaded when the selected session is cleared', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => {
        const controlSocket = useDashboardControlSocket('http://host.test')
        return {
          control: useControlPlane(controlSocket),
          session: useSession({ host: 'http://host.test', sessionId }),
        }
      },
      { initialProps: { sessionId: 's1' as string | null } },
    )

    await waitFor(() => expect(sockets).toHaveLength(2))
    const controlSocket = sockets[0]!
    const sessionSocket = sockets[1]!

    act(() => {
      controlSocket.serverEmit('server:executors', { executors: [] })
      controlSocket.serverEmit('server:sessions', {
        sessions: [{ sessionId: 's1', createdAt: 't0', eventCount: 0 }],
      })
    })

    await waitFor(() => {
      expect(result.current.control.executorsLoaded).toBe(true)
      expect(result.current.control.sessionsLoaded).toBe(true)
      expect(result.current.control.sessions).toHaveLength(1)
    })

    rerender({ sessionId: null })

    expect(sessionSocket.connected).toBe(false)
    expect(controlSocket.connected).toBe(true)
    expect(result.current.control.executorsLoaded).toBe(true)
    expect(result.current.control.sessionsLoaded).toBe(true)
    expect(result.current.control.sessions.map((session) => session.sessionId)).toEqual(['s1'])
  })

  it('batches high-frequency control summary events into one animation frame', async () => {
    const { result } = renderHook(() => {
      const controlSocket = useDashboardControlSocket('http://host.test')
      return useControlPlane(controlSocket)
    })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const controlSocket = sockets[0]!
    act(() => controlSocket.serverEmit('server:sessions', {
      sessions: [{ sessionId: 's1', createdAt: 't0', eventCount: 0, status: 'idle' }],
    }))
    act(() => {
      controlSocket.serverEmit('event:appended', {
        sessionId: 's1', seq: 1, ts: 't1', event: { kind: 'user_message', text: 'one' }, effects: [],
      })
      controlSocket.serverEmit('state:changed', {
        sessionId: 's1', state: { ...createInitialState({ sessionId: 's1' }), status: 'thinking' }, contextSnapshot: null,
      })
    })
    expect(result.current.sessions[0]?.eventCount).toBe(0)
    await waitFor(() => expect(result.current.sessions[0]?.eventCount).toBe(1))
    expect(result.current.sessions[0]?.status).toBe('thinking')
  })

  it('merges one incremental Session summary without replacing the full list', async () => {
    const { result } = renderHook(() => {
      const controlSocket = useDashboardControlSocket('http://host.test')
      return useControlPlane(controlSocket)
    })
    await waitFor(() => expect(sockets).toHaveLength(1))
    const controlSocket = sockets[0]!
    act(() => controlSocket.serverEmit('server:sessions', {
      sessions: [
        { sessionId: 's1', createdAt: 't0', eventCount: 0, status: 'idle' },
        { sessionId: 's2', createdAt: 't0', eventCount: 3, status: 'done' },
      ],
    }))
    act(() => controlSocket.serverEmit('server:control_update', {
      kind: 'session_summary_changed',
      session: { sessionId: 's1', createdAt: 't0', eventCount: 4, status: 'thinking' },
    }))

    await waitFor(() => expect(result.current.sessions[0]?.eventCount).toBe(4))
    expect(result.current.sessions.map((session) => session.sessionId)).toEqual(['s1', 's2'])
    expect(result.current.sessions[0]?.status).toBe('thinking')
    expect(result.current.sessions[1]?.eventCount).toBe(3)
  })

  it('checkpoints cache updates instead of writing on every projection commit', async () => {
    vi.useFakeTimers()
    try {
      const memory = createSessionViewCache({ maxBytes: 1024 * 1024 })
      const set = vi.fn(memory.set)
      const cache = { ...memory, set }
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', cache }))
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }),
        config: { systemPrompt: 'live', tools: [] }, contextSnapshot: null,
      }))
      act(() => sockets[0]!.serverEmit('event:appended', {
        sessionId: 's1', seq: 1, ts: 't1', event: { kind: 'user_message', text: 'one' }, effects: [],
      }))
      act(() => sockets[0]!.serverEmit('event:appended', {
        sessionId: 's1', seq: 2, ts: 't2', event: { kind: 'user_message', text: 'two' }, effects: [],
      }))
      expect(set).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTime(1_000))
      expect(set).toHaveBeenCalledTimes(1)
      expect(result.current.timeline.map((item) => item.seq)).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('paints the selected Session before checkpointing the previous large cache', async () => {
    vi.useFakeTimers()
    let frame: FrameRequestCallback | null = null
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frame = callback; return 1 })
    try {
      const memory = createSessionViewCache({ maxBytes: 1024 * 1024 })
      const set = vi.fn(memory.set)
      const cache = { ...memory, set }
      const { rerender } = renderHook(({ sessionId }) => useSession({ host: 'http://host.test', sessionId, cache }), {
        initialProps: { sessionId: 's1' as string | null },
      })
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 0, state: createInitialState({ sessionId: 's1' }),
        config: { systemPrompt: 'live', tools: [] }, contextSnapshot: null,
      }))
      expect(set).not.toHaveBeenCalled()
      rerender({ sessionId: 's2' })
      expect(set).not.toHaveBeenCalled()
      await act(async () => { await Promise.resolve() })
      expect(set).not.toHaveBeenCalled()
      expect(frame).not.toBeNull()
      await act(async () => { frame?.(performance.now()) })
      expect(set).not.toHaveBeenCalled()
      await act(async () => vi.runOnlyPendingTimers())
      expect(set).toHaveBeenCalledTimes(1)
      expect(set.mock.calls[0]?.[0]).toBe('s1')
    } finally {
      raf.mockRestore()
      vi.useRealTimers()
    }
  })

  it('opens the live socket without waiting for durable hydration', async () => {
    let resolveHydrate: ((view: null) => void) | null = null
    const hydrate = vi.fn(() => new Promise<null>((resolve) => { resolveHydrate = resolve }))
    const cache = { ...createSessionViewCache({ maxBytes: 1024 * 1024 }), hydrate }
    renderHook(() => useSession({
      host: 'http://host.test',
      sessionId: 's1',
      cache,
    }))

    await waitFor(() => expect(sockets).toHaveLength(1))
    expect(hydrate).toHaveBeenCalledWith('s1')
    act(() => resolveHydrate?.(null))
  })

  it('ignores durable hydration that arrives after the live baseline', async () => {
    let resolveHydrate: ((view: ReturnType<typeof cachedView>) => void) | null = null
    const hydrate = vi.fn(() => new Promise<ReturnType<typeof cachedView>>((resolve) => { resolveHydrate = resolve }))
    const cache = { ...createSessionViewCache({ maxBytes: 1024 * 1024 }), hydrate }
    const { result } = renderHook(() => useSession({
      host: 'http://host.test',
      sessionId: 's1',
      cache,
    }))
    await waitFor(() => expect(sockets).toHaveLength(1))
    const liveState = createInitialState({ sessionId: 's1' })
    act(() => sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1', reason: 'load', cursor: 0, state: liveState,
      config: { systemPrompt: 'live', tools: [] }, contextSnapshot: null,
    }))
    act(() => resolveHydrate?.(cachedView('s1', [timelineEntry(4)])))
    await Promise.resolve()

    expect(result.current.config?.systemPrompt).toBe('live')
    expect(result.current.timeline).toEqual([])
  })

  it('bounds a lost history response with retries and an actionable terminal error', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1', reason: 'load', cursor: 2, state: createInitialState({ sessionId: 's1' }), config: { tools: [] }, contextSnapshot: null,
      }))
      expect(result.current.historyLoadedSessionId).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(sockets[0]!.emitted.filter((entry) => entry.event === 'client:load_history')).toHaveLength(3)
      expect(result.current.historyLoadedSessionId).toBe('s1')
      expect(result.current.lastError?.message).toContain('Conversation history request timed out')
    } finally { vi.useRealTimers() }
  })

  it('uses the authoritative external Runtime baseline without requesting Kernel history', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1' }))
      await act(async () => {})
      act(() => sockets[0]!.serverEmit('session:ready', {
        sessionId: 's1',
        reason: 'load',
        agentRuntime: 'copilot',
        cursor: 2,
        state: createInitialState({ sessionId: 's1' }),
        config: { tools: [] },
        contextSnapshot: null,
      }))

      expect(result.current.historyLoadedSessionId).toBe('s1')
      expect(sockets[0]!.emitted.filter((entry) => entry.event === 'client:load_history')).toHaveLength(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.lastError).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('restores cached timeline immediately and refreshes history from the cached cursor', async () => {
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const state = createInitialState({ sessionId: 's1' })
    cache.set('s1', {
      sessionId: 's1',
      status: 'ready',
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
      timeline: [timelineEntry(1), timelineEntry(3)],
      queuedMessages: [],
      lastError: null,
      parentSessionId: null,
      parentCursor: null,
      selectedModel: null,
      hydratedSessionId: 's1',
    })

    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', cache }))

    await waitFor(() => expect(result.current.timeline.map((entry) => entry.seq)).toEqual([1, 3]))
    expect(result.current.hydratedSessionId).toBeNull()

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 5,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })

    await waitFor(() => expect(result.current.hydratedSessionId).toBe('s1'))
    expect(sockets[0]!.emitted).toContainEqual({
      event: 'client:load_history',
      payload: { sessionId: 's1', sinceCursor: 3 },
    })
  })

  it('does a full history refresh when cached cursor is ahead of host cursor', async () => {
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const state = createInitialState({ sessionId: 's1' })
    cache.set('s1', {
      sessionId: 's1',
      status: 'ready',
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
      timeline: [timelineEntry(4)],
      queuedMessages: [],
      lastError: null,
      parentSessionId: null,
      parentCursor: null,
      selectedModel: null,
      hydratedSessionId: 's1',
    })

    renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', token: PROTOCOL_VERSION, cache }))

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 2,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })

    expect(cache.get('s1')).toBeNull()
    expect(sockets[0]!.emitted).toContainEqual({
      event: 'client:load_history',
      payload: { sessionId: 's1' },
    })
  })

  it('replaces stale cached timeline after host cursor rollback', async () => {
    const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
    const state = createInitialState({ sessionId: 's1' })
    cache.set('s1', {
      sessionId: 's1',
      status: 'ready',
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
      timeline: [timelineEntry(4)],
      queuedMessages: [],
      lastError: null,
      parentSessionId: null,
      parentCursor: null,
      selectedModel: null,
      hydratedSessionId: 's1',
    })

    const { result } = renderHook(() => useSession({ host: 'http://host.test', sessionId: 's1', cache }))

    sockets[0]!.serverEmit('session:ready', {
      sessionId: 's1',
      reason: 'load',
      cursor: 2,
      state,
      config: { systemPrompt: 'test', tools: [] },
      contextSnapshot: null,
    })
    sockets[0]!.serverEmit('server:history', {
      sessionId: 's1',
      entries: [timelineEntry(1), timelineEntry(2)],
    })

    await waitFor(() => expect(result.current.timeline.map((entry) => entry.seq)).toEqual([1, 2]))
    await waitFor(() => expect(cache.get('s1')?.timeline.map((entry) => entry.seq)).toEqual([1, 2]), { timeout: 2_000 })
  })
})
