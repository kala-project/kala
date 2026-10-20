import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionSummary } from '@agent-kernel/shared'
import type { TimelineEntry } from './session.js'
import { acceptsSessionTokenDelta, createSessionWithAck, deleteSession, deriveHumanAttentionTimeline, deriveToolExecutionStartedAt, mergeBySeq, mergeSessionSummaries, requestSessionRouteTicket, sessionRouteTicketSocketOptions } from './session.js'

afterEach(() => { vi.unstubAllGlobals() })

function entry(seq: number, kind: TimelineEntry['event']['kind']): TimelineEntry {
  if (kind === 'llm_response') {
    return {
      seq,
      ts: `t-${seq}`,
      event: {
        kind,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
      effects: [{ kind: 'finish' }],
    }
  }
  return {
    seq,
    ts: `t-${seq}`,
    event: { kind: 'user_message', text: `m-${seq}` },
    effects: [{ kind: 'call_llm', messages: [], tools: [] }],
  }
}

describe('Session route tickets', () => {
  it('requests a same-origin cookie ticket without putting it in auth storage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ticket: 'ticket-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestSessionRouteTicket({ host: window.location.origin, sessionId: 'session-1' }))
      .resolves.toEqual({ kind: 'ticket', ticket: 'ticket-1' })
    expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}/runtime/route-ticket`, expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    }))
  })

  it('rejects a cross-origin routing endpoint without sending cookies or contacting it', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestSessionRouteTicket({ host: 'https://other.example/', sessionId: 'session-1' }))
      .rejects.toThrow('same-origin Gateway')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows legacy fallback only for the exact unavailable response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'route_ticket_unavailable' }), { status: 404 }),
    ))
    await expect(requestSessionRouteTicket({ host: '', sessionId: 'session-1' }))
      .resolves.toEqual({ kind: 'unavailable' })
  })

  it('fails closed when the Session owner is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'session_owner_unavailable' }), { status: 404 }),
    ))
    await expect(requestSessionRouteTicket({ host: '', sessionId: 'session-1' }))
      .rejects.toThrow('session_owner_unavailable')
  })

  it('creates a fresh websocket-only Manager with the ticket only in Engine.IO query', () => {
    const options = sessionRouteTicketSocketOptions({ sessionId: 'session-1', ticket: 'ticket-1', token: 'bootstrap' })

    expect(options).toMatchObject({
      forceNew: true,
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      query: { runtimeRouteTicket: 'ticket-1' },
      auth: { sessionId: 'session-1', role: 'dashboard', token: 'bootstrap' },
    })
    expect(options.auth).not.toHaveProperty('runtimeRouteTicket')
  })
})

describe('acceptsSessionTokenDelta', () => {
  it('rejects deltas after the authoritative turn leaves thinking state', () => {
    expect(acceptsSessionTokenDelta('thinking')).toBe(true)
    expect(acceptsSessionTokenDelta('awaiting_approval')).toBe(false)
    expect(acceptsSessionTokenDelta('executing_tools')).toBe(false)
    expect(acceptsSessionTokenDelta('done')).toBe(false)
    expect(acceptsSessionTokenDelta('error')).toBe(false)
  })
})


describe('createSessionWithAck', () => {
  it('completes from the idempotent RPC ack without waiting for session broadcasts', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true })
    const socket = { connected: true, active: true, timeout: vi.fn(() => ({ emitWithAck })), connect: vi.fn() }
    await expect(createSessionWithAck(socket as never, { sessionId: 'chat-1', tools: ['websearch'] })).resolves.toBeUndefined()
    expect(emitWithAck).toHaveBeenCalledWith('client:create_session', expect.objectContaining({ sessionId: 'chat-1', operationId: expect.any(String), tools: ['websearch'] }))
  })
})

describe('deleteSession', () => {
  it('uses an acknowledged idempotent RPC payload', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true })
    const socket = {
      connected: true,
      active: true,
      timeout: vi.fn(() => ({ emitWithAck })),
      connect: vi.fn(),
    }

    await deleteSession(socket as never, 'session-1')

    expect(emitWithAck).toHaveBeenCalledWith('client:delete_session', expect.objectContaining({
      operationId: expect.any(String),
      sessionId: 'session-1',
    }))
  })

  it('rejects when the Host refuses deletion', async () => {
    const socket = {
      connected: true,
      active: true,
      timeout: () => ({ emitWithAck: vi.fn().mockResolvedValue({ ok: false, error: 'delete denied' }) }),
      connect: vi.fn(),
    }

    await expect(deleteSession(socket as never, 'session-1')).rejects.toThrow('delete denied')
  })
})

describe('mergeBySeq', () => {
  it('appends a strictly increasing live tail while preserving entry identities', () => {
    const first = entry(1, 'user_message')
    const second = entry(2, 'llm_response')
    const third = entry(3, 'user_message')

    const merged = mergeBySeq([first], [second, third])

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(merged[0]).toBe(first)
    expect(merged[1]).toBe(second)
    expect(merged[2]).toBe(third)
  })

  it('falls back to authoritative merging when the added tail is not increasing', () => {
    expect(mergeBySeq([entry(1, 'user_message')], [entry(3, 'user_message'), entry(2, 'llm_response')]).map((item) => item.seq)).toEqual([1, 2, 3])
  })

  it('sorts and fills missing history entries', () => {
    expect(mergeBySeq([entry(3, 'user_message')], [entry(1, 'user_message')]).map((e) => e.seq)).toEqual([1, 3])
  })

  it('does not let conflicting replay data overwrite an existing live event', () => {
    const live = entry(2, 'llm_response')
    const history = entry(2, 'user_message')

    expect(mergeBySeq([live], [history])[0]).toBe(live)
  })

  it('merges llmTrace and model metadata for the same replayed LLM event', () => {
    const live = entry(2, 'llm_response')
    const history: TimelineEntry = {
      ...entry(2, 'llm_response'),
      llmTrace: {
        provider: 'openai',
        model: 'gpt-5.5',
        request: {
          url: 'https://api.example.test/v1/chat/completions',
          headers: { authorization: 'Bearer test-redacted-api-key' },
          body: { model: 'gpt-5.5', messages: [] },
        },
        response: { status: 200, body: { choices: [] } },
      },
      model: 'gpt-5.5',
    }

    const merged = mergeBySeq([live], [history])[0]

    expect(merged?.llmTrace?.model).toBe('gpt-5.5')
    expect(merged?.model).toBe('gpt-5.5')
  })
})

describe('mergeSessionSummaries', () => {
  it('does not keep an old running status after a fresh resting summary arrives', () => {
    const base: SessionSummary = {
      sessionId: 's1',
      createdAt: '2026-07-15T00:00:00.000Z',
      lastEventAt: '2026-07-15T00:00:01.000Z',
      eventCount: 1,
      status: 'thinking',
    }

    const merged = mergeSessionSummaries([base], [{ ...base, eventCount: 2, status: 'done' }])

    expect(merged[0]?.status).toBe('done')
  })
})

describe('deriveHumanAttentionTimeline', () => {
  it('builds session-scoped points on message cursors', () => {
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: 't-1', event: { kind: 'user_message', text: '先审计，不要部署，给证据。' }, effects: [] },
      { seq: 2, ts: 't-2', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'rg', input: {} }] } }, effects: [{ kind: 'call_tool', callId: 'c1', name: 'rg', input: {} }] },
      { seq: 3, ts: 't-3', event: { kind: 'tool_result', callId: 'c1', ok: true, content: 'read' }, effects: [] },
    ]

    const attention = deriveHumanAttentionTimeline('s1', timeline)

    expect(attention.sessionId).toBe('s1')
    expect(attention.points.map((point) => point.messageCursor)).toEqual([1, 2, 3])
    expect(attention.latest?.score).toBeGreaterThan(0)
  })
})

describe('deriveToolExecutionStartedAt', () => {
  it('recovers the running tool elapsed start from replayed call_tool effects', () => {
    const state = {
      sessionId: 's1',
      messages: [],
      pendingCalls: [
        { callId: 'c1', name: 'bash', input: {}, status: 'dispatched' as const },
        { callId: 'c2', name: 'read', input: {}, status: 'approved' as const },
      ],
      status: 'executing_tools' as const,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      cursor: 2,
      approvalMode: 'auto' as const,
    }
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-20T12:00:05.000Z',
        event: { kind: 'user_approve', callId: 'c2' },
        effects: [{ kind: 'call_tool', callId: 'c2', name: 'read', input: {} }],
      },
      {
        seq: 2,
        ts: '2026-07-20T12:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
        effects: [{ kind: 'call_tool', callId: 'c1', name: 'bash', input: {} }],
      },
    ]

    expect(deriveToolExecutionStartedAt(state, timeline)).toBe(Date.parse('2026-07-20T12:00:01.000Z'))
  })

  it('returns null when the session is not currently executing tools', () => {
    const state = {
      sessionId: 's1',
      messages: [],
      pendingCalls: [{ callId: 'c1', name: 'bash', input: {}, status: 'dispatched' as const }],
      status: 'thinking' as const,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      cursor: 1,
      approvalMode: 'auto' as const,
    }

    expect(deriveToolExecutionStartedAt(state, [])).toBeNull()
  })
})
