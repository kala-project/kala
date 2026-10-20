import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'
import { appendLiveTranscriptItems, appendTranscriptBaseItems, lastUserTranscriptIndex, reconcilePendingUserMessages, transcriptBaseItems, transcriptTimelineForRuntime, transcriptViewStartForItems, visibleMessages, visibleTranscript } from './transcript.js'

const system: Message = {
  role: 'system',
  content: [{ type: 'text', text: 'sys' }],
}

describe('transcriptViewStartForItems', () => {
  it('preserves a valid /clear boundary on the latest user turn', () => {
    expect(transcriptViewStartForItems(2, 4, true)).toBe(2)
  })

  it('restores the entire authoritative transcript when a reset invalidates the old index', () => {
    expect(transcriptViewStartForItems(120, 1, true)).toBe(0)
    expect(transcriptViewStartForItems(120, 3, true)).toBe(0)
    expect(transcriptViewStartForItems(120, 121, true)).toBe(120)
  })

  it('does not repair a partial cached transcript before the Host confirms its history', () => {
    expect(transcriptViewStartForItems(120, 1, false)).toBe(0)
    expect(transcriptViewStartForItems(-1, 2, true)).toBe(0)
  })
})

describe('transcriptTimelineForRuntime', () => {
  it('keeps external Runtime state authoritative over Kernel event timelines', () => {
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-08-27T00:00:00Z', event: { kind: 'user_message', text: 'request' }, effects: [] },
    ]

    expect(transcriptTimelineForRuntime('kernel', timeline)).toBe(timeline)
    expect(transcriptTimelineForRuntime('copilot', timeline)).toEqual([])
  })

  describe('lastUserTranscriptIndex', () => {
    it('keeps the latest user turn and everything after it', () => {
      const items = [
        { kind: 'message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'old' }] } },
        { kind: 'message' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'old answer' }] } },
        { kind: 'message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'latest' }] } },
        { kind: 'message' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'latest answer' }] } },
      ]

      expect(lastUserTranscriptIndex(items)).toBe(2)
      expect(lastUserTranscriptIndex(items.slice(1, 2))).toBe(0)
    })

    it('treats an optimistic pending message as the latest user turn', () => {
      expect(lastUserTranscriptIndex([
        { kind: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } },
        { kind: 'pending_user_message', id: 'pending-1', text: 'go', mode: 'steer', status: 'sending', createdAt: '2026-01-01T00:00:00Z' },
      ])).toBe(1)
    })
  })

  it('retains operationId provenance on historical user messages', () => {
    const timeline: TimelineEntry[] = [{
      seq: 7,
      ts: '2026-10-01T09:00:00.000Z',
      event: { kind: 'user_message', operationId: 'schedule-op-1', text: 'historical scheduled prompt' },
      effects: [],
    }]

    expect(transcriptBaseItems([], timeline)).toEqual([{
      kind: 'message',
      seq: 7,
      ts: '2026-10-01T09:00:00.000Z',
      operationId: 'schedule-op-1',
      message: { role: 'user', content: [{ type: 'text', text: 'historical scheduled prompt' }] },
    }])
  })

  it('renders persisted external Runtime model changes without exposing system prompts', () => {
    const messages: Message[] = [
      system,
      {
        role: 'system',
        content: [{ type: 'text', text: 'Model changed: old → new' }],
        metadata: { kind: 'model_changed', from: 'old', to: 'new' },
      },
    ]

    expect(visibleTranscript(messages, [], '')).toEqual([
      { kind: 'model_changed', from: 'old', to: 'new' },
    ])
  })

  it('keeps a persisted Copilot compaction boundary before output produced after its cutoff', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Start the task.' }] },
      {
        role: 'system',
        content: [],
        metadata: {
          kind: 'context_compaction',
          attemptId: 'compact-1',
          phase: 'done',
          trigger: 'auto',
          tokensBefore: 104_000,
          tokensAfter: 32_000,
          replacedCount: 30,
          summary: 'Context before the live tail.',
          startedAt: '2026-08-30T00:00:01.000Z',
          endedAt: '2026-08-30T00:00:02.000Z',
        },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Final output after the compact cutoff.' }] },
    ]

    expect(visibleTranscript(messages, [], '')).toEqual([
      { kind: 'message', message: messages[0] },
      {
        kind: 'compact_boundary',
        attemptId: 'compact-1',
        trigger: 'auto',
        replacedCount: 30,
        tokensBefore: 104_000,
        tokensAfter: 32_000,
        summary: 'Context before the live tail.',
      },
      { kind: 'message', message: messages[2] },
    ])
  })

  it('restores a durable Kernel compaction boundary when paged history no longer contains its event', () => {
    const marker: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'durable handoff' }],
      metadata: {
        kind: 'context_compaction',
        attemptId: 'compact-kernel-1',
        phase: 'done',
        trigger: 'preflight',
        tokensBefore: 220_200,
        tokensAfter: 58_000,
        replacedCount: 42,
        summary: 'Persist the active implementation.',
        startedAt: '2026-09-30T06:00:00.000Z',
        endedAt: '2026-09-30T06:00:02.000Z',
      },
    }
    const timeline: TimelineEntry[] = [{
      seq: 101,
      ts: '2026-09-30T06:00:03.000Z',
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Output after compaction.' }] } },
      effects: [],
    }]

    const items = transcriptBaseItems([marker], timeline)
    expect(items[0]).toMatchObject({ kind: 'compact_boundary', attemptId: 'compact-kernel-1' })
    expect(items[1]).toMatchObject({ kind: 'message', seq: 101 })
  })

  it('deduplicates the same durable compaction boundary from state and history', () => {
    const marker: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'durable handoff' }],
      metadata: {
        kind: 'context_compaction',
        attemptId: 'compact-kernel-2',
        phase: 'done',
        trigger: 'manual',
        tokensBefore: 12_000,
        tokensAfter: 4_000,
        replacedCount: 8,
        summary: 'Keep the result.',
        startedAt: '2026-09-30T06:00:00.000Z',
        endedAt: '2026-09-30T06:00:01.000Z',
      },
    }
    const timeline: TimelineEntry[] = [{
      seq: 8,
      ts: '2026-09-30T06:00:01.000Z',
      event: {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 9 },
        replacementMessages: [marker],
      },
      effects: [],
      compactionMetadata: {
        attemptId: 'compact-kernel-2',
        trigger: 'manual',
        tokensBefore: 12_000,
        tokensAfter: 4_000,
        replacedCount: 8,
      },
    }]

    const boundaries = transcriptBaseItems([marker], timeline).filter((item) => item.kind === 'compact_boundary')
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ attemptId: 'compact-kernel-2', summary: 'Keep the result.' })
  })
})

describe('Turn timing transcript projection', () => {
  it('attaches a durable Turn summary only to its terminal assistant message', () => {
    const summary = { turnId: 'turn-1', status: 'completed' as const, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', wallDurationMs: 1000, estimated: false, queueDurationMs: 0, activeDurationMs: 1000, approvalWaitMs: 0, llm: { wallDurationMs: 1000, requestCount: 1 }, tools: { wallDurationMs: 0, aggregateDurationMs: 0, callCount: 0, peakConcurrency: 0, partial: false }, compactionDurationMs: 0, retryDurationMs: 0, recoveryDurationMs: 0 }
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-01-01T00:00:00Z', event: { kind: 'user_message', text: 'go' }, effects: [] },
      { seq: 2, ts: '2026-01-01T00:00:01Z', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, effects: [], timing: { turnId: 'turn-1', summary } },
    ]
    const items = visibleTranscript([], timeline, '')
    expect(items[0]).not.toHaveProperty('turnTiming')
    expect(items[1]).toMatchObject({ kind: 'message', turnTiming: summary })
  })
})

describe('appendTranscriptBaseItems', () => {
  it('replaces the state fallback instead of appending duplicated history on hydration', () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Existing request' }] }]
    const timeline: TimelineEntry[] = [{ seq: 1, ts: 't1', event: { kind: 'user_message', text: 'Existing request' }, effects: [] }]
    expect(appendTranscriptBaseItems(transcriptBaseItems(messages, []), [], timeline)).toBeNull()
  })
  it('keeps retained tool prose at its original response boundary instead of merging later turns', () => {
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: 't1', event: { kind: 'user_message', text: 'First request' }, effects: [] },
      { seq: 2, ts: 't2', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'probe', input: {} }] } }, effects: [] },
      { seq: 3, ts: 't3', event: { kind: 'tool_result', callId: 'c1', ok: true, content: 'ok' }, effects: [] },
      { seq: 4, ts: 't4', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] } }, effects: [] },
      { seq: 5, ts: 't5', event: { kind: 'user_message', text: 'Second request' }, effects: [] },
    ]
    const items = visibleTranscript([], timeline, 'New response', [], [], {
      retainedDrafts: [{ afterSeq: 1, messageCount: 1, text: 'Tool preamble' }],
      streamingAnchor: { afterSeq: 5, messageCount: 5 }, streamingActive: true,
    })
    expect(items[1]).toMatchObject({ streaming: false, message: { content: [{ text: 'Tool preamble' }] } })
    expect(items[2]).toMatchObject({ seq: 2 })
    expect(items.at(-1)).toMatchObject({ streaming: true, message: { content: [{ text: 'New response' }] } })
    expect(items.filter((item) => item.kind === 'message' && item.streaming)).toHaveLength(1)
  })

  it('reconciles retained reconnect drafts only against their own authoritative response', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Request' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Persisted answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Next request' }] },
    ]
    const items = visibleTranscript(messages, [], 'Next draft', [], [], {
      retainedDrafts: [{ afterSeq: 1, messageCount: 1, text: 'Old draft' }],
      streamingAnchor: { afterSeq: 3, messageCount: 3 }, streamingActive: false,
    })
    expect(items).toHaveLength(4)
    expect(items[1]).toMatchObject({ message: { content: [{ text: 'Persisted answer' }] } })
    expect(items.at(-1)).toMatchObject({ streaming: false, message: { content: [{ text: 'Next draft' }] } })
  })

  it('preserves historical item identity when timeline only appends', () => {
    const first: TimelineEntry = { seq: 1, ts: '2026-01-01T00:00:00Z', event: { kind: 'user_message', text: 'one' }, effects: [] }
    const second: TimelineEntry = { seq: 2, ts: '2026-01-01T00:00:01Z', event: { kind: 'user_message', text: 'two' }, effects: [] }
    const base = transcriptBaseItems([], [first])
    const next = appendTranscriptBaseItems(base, [first], [first, second])
    expect(next).not.toBeNull()
    expect(next![0]).toBe(base[0])
    expect(next).toHaveLength(2)
  })

  it('falls back when existing history identity changes', () => {
    const first: TimelineEntry = { seq: 1, ts: '2026-01-01T00:00:00Z', event: { kind: 'user_message', text: 'one' }, effects: [] }
    const replacement: TimelineEntry = { ...first, event: { kind: 'user_message', text: 'changed' } }
    expect(appendTranscriptBaseItems(transcriptBaseItems([], [first]), [first], [replacement])).toBeNull()
  })
})

describe('optimistic to durable message handoff', () => {
  it('reconciles an external Runtime pending message from authoritative state', () => {
    const pending = [{
      id: 'pending-copilot',
      text: 'run the tool',
      mode: 'steer' as const,
      createdAt: '2026-08-27T00:00:00Z',
    }]
    const authoritative: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'run the tool' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]

    expect(reconcilePendingUserMessages(pending, [], [], 'done', '', authoritative)).toEqual([])
  })

  it('never renders the same accepted user message in both durable and optimistic rows', () => {
    const timeline: TimelineEntry[] = [{ seq: 1, ts: '2026-01-01T00:00:00Z', event: { kind: 'user_message', text: 'send once' }, effects: [] }]
    const pending = [{ id: 'pending-1', text: 'send once', mode: 'steer' as const, createdAt: '2026-01-01T00:00:00Z' }]
    const visiblePending = reconcilePendingUserMessages(pending, timeline, [], 'thinking', '')
    const rendered = appendLiveTranscriptItems(transcriptBaseItems([], timeline), [], timeline, '', visiblePending, [])
    expect(rendered.filter((item) => item.kind === 'message' || item.kind === 'pending_user_message')).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ kind: 'message', message: { role: 'user' } })
  })

  it('renders queued messages as live transcript rows for otherwise empty sessions', () => {
    const rendered = appendLiveTranscriptItems([], [], [], '', [], [{
      id: 'server-queued-1',
      text: 'run this next',
      mode: 'queue',
      createdAt: '2026-01-01T00:00:00.000Z',
    }])

    expect(rendered).toEqual([{
      kind: 'pending_user_message',
      id: 'server-queued-1',
      text: 'run this next',
      mode: 'queue',
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
    }])
  })
})

describe('visibleMessages', () => {
  it('keeps event-log transcript visible after compacted state messages shrink', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-05T00:00:00.000Z',
        event: { kind: 'user_message', text: 'hello' },
        effects: [],
      },
      {
        seq: 2,
        ts: '2026-07-05T00:00:01.000Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
        effects: [],
      },
      {
        seq: 3,
        ts: '2026-07-05T00:00:02.000Z',
        event: {
          kind: 'messages_replaced',
          reason: 'compaction',
          replaceRange: { start: 1, end: 3 },
          replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'hello -> hi' }] }],
        },
        effects: [],
      },
    ]

    const visible = visibleMessages(
      [system, { role: 'system', content: [{ type: 'text', text: 'hello -> hi' }] }],
      timeline,
      '',
    )

    expect(visible.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(visible[0]?.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(visible[1]?.content[0]).toEqual({ type: 'text', text: 'hi' })
    const transcript = visibleTranscript(
      [system, { role: 'system', content: [{ type: 'text', text: 'hello -> hi' }] }],
      timeline,
      '',
    )
    expect(transcript[2]).toMatchObject({
      kind: 'compact_boundary',
      seq: 3,
      trigger: 'unknown',
      tokensBefore: null,
      tokensAfter: null,
    })
  })

  it('honours compactionMetadata attached to the timeline entry (live path)', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-05T00:00:00.000Z',
        event: { kind: 'user_message', text: 'hello' },
        effects: [],
      },
      {
        seq: 2,
        ts: '2026-07-05T00:00:02.000Z',
        event: {
          kind: 'messages_replaced',
          reason: 'compaction',
          replaceRange: { start: 1, end: 5 },
          replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'summary' }] }],
        },
        effects: [],
        compactionMetadata: {
          trigger: 'auto',
          tokensBefore: 12400,
          tokensAfter: 3800,
          replacedCount: 4,
          attemptId: 'cmp_01',
        },
      },
    ]
    const transcript = visibleTranscript(
      [system, { role: 'system', content: [{ type: 'text', text: 'summary' }] }],
      timeline,
      '',
    )
    const boundary = transcript.find((item) => item.kind === 'compact_boundary')
    expect(boundary).toMatchObject({
      trigger: 'auto',
      tokensBefore: 12400,
      tokensAfter: 3800,
      replacedCount: 4,
    })
  })

  it('appends an assistant draft while token deltas are streaming', () => {
    const visible = visibleMessages(
      [system],
      [
        {
          seq: 1,
          ts: '2026-07-05T00:00:00.000Z',
          event: { kind: 'user_message', text: 'stream' },
          effects: [],
        },
      ],
      'partial answer',
    )

    expect(visible.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(visible[1]?.content[0]).toEqual({ type: 'text', text: 'partial answer' })

    const transcript = visibleTranscript([system], [], 'partial answer')
    expect(transcript[0]).toMatchObject({
      kind: 'message',
      streaming: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
    })
  })

  it('keeps streamed text visible when a tool-only assistant response becomes the tail', () => {
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-07-05T00:00:00.000Z', event: { kind: 'user_message', text: 'stream then tool' }, effects: [] },
      {
        seq: 2,
        ts: '2026-07-05T00:00:01.000Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'call-1', name: 'bash', input: { command: 'true' } }],
          },
        },
        effects: [],
      },
    ]

    const transcript = visibleTranscript([system], timeline, 'I will inspect that first.')

    expect(transcript).toContainEqual(expect.objectContaining({
      kind: 'message',
      streaming: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect that first.' }] },
    }))
  })

  it('does not duplicate the latest assistant message while Stop hands streaming text to the authoritative response', () => {
    const response: Message = { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] }
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-07-05T00:00:00.000Z', event: { kind: 'user_message', text: 'stop now' }, effects: [] },
      { seq: 2, ts: '2026-07-05T00:00:01.000Z', event: { kind: 'llm_response', message: response }, effects: [] },
    ]
    const visible = visibleTranscript([system, response], timeline, 'partial answer')
    expect(visible.filter((item) => item.kind === 'message' && item.message.role === 'assistant')).toHaveLength(1)
    expect(visible.some((item) => item.kind === 'message' && item.streaming === true)).toBe(false)
  })

  it('uses timeline messages even before the first assistant response lands', () => {
    const visible = visibleMessages(
      [system],
      [
        {
          seq: 1,
          ts: '2026-07-05T00:00:00.000Z',
          event: { kind: 'user_message', text: 'first turn' },
          effects: [],
        },
      ],
      '',
    )

    expect(visible.map((m) => m.role)).toEqual(['user'])
    expect(visible[0]?.content[0]).toEqual({ type: 'text', text: 'first turn' })
  })

  it('keeps fork baseline messages before child timeline events', () => {
    const stateMessages: Message[] = [
      system,
      { role: 'user', content: [{ type: 'text', text: 'first parent turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first parent answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'edited child prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] },
    ]
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-07-06T00:00:00.000Z', event: { kind: 'user_message', text: 'edited child prompt' }, effects: [] },
      {
        seq: 2,
        ts: '2026-07-06T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] } },
        effects: [],
      },
    ]

    const visible = visibleMessages(stateMessages, timeline, '', { includeStatePrefix: true })

    expect(visible.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'first parent turn' },
      { type: 'text', text: 'first parent answer' },
      { type: 'text', text: 'edited child prompt' },
      { type: 'text', text: 'child answer' },
    ])
  })

  it('emits nothing when the only state message is the system prompt (no timeline, no stream)', () => {
    const visible = visibleMessages([system], [], '')
    expect(visible).toEqual([])
    const transcript = visibleTranscript([system], [], '')
    expect(transcript).toEqual([])
  })

  it('appends local sending messages but leaves server queued messages in the composer dock once the transcript has live content', () => {
    const transcript = visibleTranscript(
      [system],
      [],
      '',
      [
        {
          id: 'local-1',
          text: 'sent but not acked',
          mode: 'steer',
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'queue-1',
          text: 'run next',
          mode: 'queue',
          createdAt: '2026-07-06T00:00:01.000Z',
        },
      ],
    )

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: 'pending_user_message',
        id: 'local-1',
        status: 'sending',
        text: 'sent but not acked',
      }),
    ])
  })

  it('drops system messages from the tail-fallback dump', () => {
    const user: Message = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    const visible = visibleMessages([system, user], [], '')
    expect(visible.map((m) => m.role)).toEqual(['user'])
  })

  it('reconciles local pending messages with timeline and queue acknowledgements', () => {
    const pending = [
      { id: 'local-1', text: 'sent', mode: 'steer' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 0 },
      { id: 'local-2', text: 'queued', mode: 'queue' as const, createdAt: '2026-07-06T00:00:01.000Z', afterSeq: 0 },
    ]
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-07-06T00:00:02.000Z', event: { kind: 'user_message', text: 'sent' }, effects: [] },
    ]

    const next = reconcilePendingUserMessages(
      pending,
      timeline,
      [{ id: 'queue-1', text: 'queued', mode: 'queue', createdAt: '2026-07-06T00:00:03.000Z' }],
      'thinking',
      '',
    )

    expect(next).toEqual([])
  })

  it('drops stale steer pending messages after the later LLM turn has completed', () => {
    const pending = [
      { id: 'local-1', text: 'Schema-first or types-first', mode: 'steer' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 10 },
      { id: 'queue-1', text: 'keep queued local preview', mode: 'queue' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 10 },
    ]
    const timeline: TimelineEntry[] = [
      {
        seq: 11,
        ts: '2026-07-06T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        effects: [],
      },
    ]

    const next = reconcilePendingUserMessages(pending, timeline, [], 'done', '')

    expect(next).toEqual([pending[1]])
  })

  it('keeps local pending messages while the turn is still active or streaming', () => {
    const pending = [{ id: 'local-1', text: 'still sending', mode: 'steer' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 10 }]
    const timeline: TimelineEntry[] = [
      {
        seq: 11,
        ts: '2026-07-06T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        effects: [],
      },
    ]

    expect(reconcilePendingUserMessages(pending, timeline, [], 'thinking', '')).toEqual(pending)
    expect(reconcilePendingUserMessages(pending, timeline, [], 'done', 'partial')).toEqual(pending)
  })
})
