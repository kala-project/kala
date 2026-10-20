import { createConfig, createInitialState } from '@agent-kernel/kernel'
import { COPILOT_RUNTIME_COMPACTION_POLICY, KERNEL_AGENT_RUNTIME_CAPABILITIES, kernelRuntimeCompactionPolicy, type ContextUsageSnapshot, type EventAppendedEvent, type SessionReadyEvent } from '@agent-kernel/shared'
import { describe, expect, it, vi } from 'vitest'

import { EMPTY_SESSION_PROJECTION, reduceSessionProjection, reduceSessionProjectionBatch } from './session-projection.js'

const config = createConfig({ systemPrompt: 'system', tools: [] })
const contextSnapshot: ContextUsageSnapshot = {
  model: { ref: 'provider/model' },
  contextWindow: { tokens: 200_000, source: 'model_registry' },
  usage: { inputTokens: 10, totalTokens: 10 },
  breakdown: { system: 1, transcript: 9, tools: 0, memory: 0, attachments: 0, pendingUserInput: 0 },
  estimator: { total: { kind: 'heuristic', confidence: 'rough' }, breakdown: { kind: 'heuristic', confidence: 'rough' }, version: 'test' },
  updatedAt: 1,
}

function ready(sessionId: string): SessionReadyEvent {
  const state = createInitialState({ sessionId, systemPrompt: 'system' })
  return {
    sessionId,
    agentRuntime: 'kernel',
    executionMode: 'chat',
    agentRuntimeCapabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
    runtimeCompactionPolicy: kernelRuntimeCompactionPolicy(),
    cursor: state.cursor,
    state,
    config,
    contextSnapshot,
  }
}

function appended(sessionId: string, seq: number, text: string): EventAppendedEvent {
  return {
    sessionId, seq, ts: `2026-07-24T00:00:0${seq}.000Z`,
    event: { kind: 'user_message', text }, effects: [],
  }
}

function selected(sessionId: string, generation = 1) {
  const selected = reduceSessionProjection(EMPTY_SESSION_PROJECTION, { kind: 'select', generation, sessionId })
  return reduceSessionProjection(selected, { kind: 'ready', generation, sessionId, payload: ready(sessionId) })
}

describe('session projection reducer', () => {
  it('marks only a real Host history response as authoritative for /clear recovery', () => {
    const sessionId = 'session-clear-reset'
    const current = selected(sessionId)
    const failedReplay = reduceSessionProjection(current, {
      kind: 'history', generation: 1, sessionId, entries: [], authoritative: false,
    })
    expect(failedReplay.historyLoadedSessionId).toBe(sessionId)
    expect(failedReplay.historyAuthoritativeSessionId).toBeNull()
    const replayed = reduceSessionProjection(failedReplay, {
      kind: 'history', generation: 1, sessionId, entries: [], reset: true,
    })
    expect(replayed.historyAuthoritativeSessionId).toBe(sessionId)
    expect(reduceSessionProjection(replayed, { kind: 'ready', generation: 1, sessionId, payload: ready(sessionId) })
      .historyAuthoritativeSessionId).toBeNull()
    expect(reduceSessionProjection(replayed, { kind: 'reset_timeline', generation: 1, sessionId })
      .historyAuthoritativeSessionId).toBeNull()
  })

  it('derives a compatible compaction policy when an older Host omits it', () => {
    const payload = ready('legacy-ready')
    delete payload.runtimeCompactionPolicy
    payload.agentRuntime = 'copilot'
    const selected = reduceSessionProjection(EMPTY_SESSION_PROJECTION, {
      kind: 'select',
      generation: 1,
      sessionId: payload.sessionId,
    })

    const hydrated = reduceSessionProjection(selected, {
      kind: 'ready',
      generation: 1,
      sessionId: payload.sessionId,
      payload,
    })

    expect(hydrated.runtimeCompactionPolicy).toEqual(COPILOT_RUNTIME_COMPACTION_POLICY)
  })

  it('hydrates an active root compaction from the authoritative ready baseline', () => {
    const sessionId = 'session-active-compact'
    const current = reduceSessionProjection(EMPTY_SESSION_PROJECTION, {
      kind: 'select',
      generation: 1,
      sessionId,
    })
    const hydrated = reduceSessionProjection(current, {
      kind: 'ready',
      generation: 1,
      sessionId,
      payload: {
        ...ready(sessionId),
        compactStatus: {
          sessionId,
          kind: 'running',
          trigger: 'auto',
          tokensBefore: 800,
          attemptId: 'active-root',
          startedAt: '2026-07-24T00:00:00.000Z',
          scope: { kind: 'root' },
        },
      },
    })

    expect(hydrated.compactStatus?.attemptId).toBe('active-root')
  })

  it('does not replace root compaction state with a subagent lifecycle event', () => {
    const current = selected('session-a')
    const root = reduceSessionProjection(current, {
      kind: 'compact',
      generation: 1,
      sessionId: 'session-a',
      compactStatus: {
        sessionId: 'session-a',
        kind: 'running',
        trigger: 'auto',
        tokensBefore: 800,
        attemptId: 'root',
        startedAt: '2026-07-24T00:00:00.000Z',
        scope: { kind: 'root' },
      },
    })
    const afterSubagent = reduceSessionProjection(root, {
      kind: 'compact',
      generation: 1,
      sessionId: 'session-a',
      compactStatus: {
        sessionId: 'session-a',
        kind: 'running',
        trigger: 'auto',
        tokensBefore: 900,
        attemptId: 'child',
        startedAt: '2026-07-24T00:00:01.000Z',
        scope: { kind: 'subagent', agentId: 'child-a' },
      },
    })

    expect(afterSubagent.compactStatus?.attemptId).toBe('root')
  })

  it('reduces a queued frame in exactly the same order as individual events', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:10.000Z'))
    try {
      const current = selected('session-a')
      const events = [
        { kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'first') } as const,
        { kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 2, 'second') } as const,
        { kind: 'status', generation: 1, sessionId: 'session-a', status: 'ready' } as const,
      ]
      const individual = events.reduce(reduceSessionProjection, current)

      expect(reduceSessionProjectionBatch(current, events)).toEqual(individual)
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds state and appends timeline in one transition', () => {
    const current = selected('session-a')
    const next = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'hello'),
    })

    expect(next.state?.cursor).toBe(1)
    expect(next.state?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(next.timeline.map((entry) => entry.seq)).toEqual([1])
    expect(next.lastError).toBeNull()
  })

  it('reprojects context usage in the same transition as a sent message', () => {
    const current = selected('session-a')
    const next = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'hello context'),
    })

    expect(next.contextSnapshot?.usage.inputTokens).toBeGreaterThan(current.contextSnapshot!.usage.inputTokens)
    expect(next.contextSnapshot?.breakdown.transcript).toBeGreaterThan(current.contextSnapshot!.breakdown.transcript)
    expect(next.contextSnapshot?.breakdown.pendingUserInput).toBe(0)
  })

  it('does not visibly correct context usage again when authoritative state follows an appended event', () => {
    const current = selected('session-a')
    const appendedNext = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'hello context'),
    })
    const authoritativeNext = reduceSessionProjection(appendedNext, {
      kind: 'authoritative', generation: 1, sessionId: 'session-a',
      payload: {
        sessionId: 'session-a',
        cursor: appendedNext.state!.cursor,
        state: appendedNext.state!,
        contextSnapshot: {
          ...appendedNext.contextSnapshot!,
          updatedAt: appendedNext.contextSnapshot!.updatedAt + 1,
        },
      },
    })

    expect(authoritativeNext.contextSnapshot?.usage).toEqual(appendedNext.contextSnapshot?.usage)
    expect(authoritativeNext.contextSnapshot?.breakdown).toEqual(appendedNext.contextSnapshot?.breakdown)
  })

  it('merges duplicate and out-of-order events without folding state twice or across a gap', () => {
    const current = selected('session-a')
    const once = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'first'),
    })
    const duplicate = reduceSessionProjection(once, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'first'),
    })
    const gap = reduceSessionProjection(duplicate, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 3, 'third'),
    })

    expect(duplicate.state).toBe(once.state)
    expect(duplicate.timeline).toHaveLength(1)
    expect(gap.state?.cursor).toBe(1)
    expect(gap.timeline.map((entry) => entry.seq)).toEqual([1, 3])
  })

  it('keeps cached running state non-authoritative until session:ready', () => {
    const cachedState = { ...createInitialState({ sessionId: 'session-done' }), status: 'executing_tools' as const }
    const cached = {
      sessionId: 'session-done', status: 'ready' as const, state: cachedState, config,
      contextSnapshot, timeline: [], queuedMessages: [], lastError: null,
      parentSessionId: null, parentCursor: null, selectedModel: null, hydratedSessionId: 'session-done',
    }
    const selectedFromCache = reduceSessionProjection(EMPTY_SESSION_PROJECTION, {
      kind: 'select', generation: 1, sessionId: 'session-done', cached,
    })

    expect(selectedFromCache.state?.status).toBe('executing_tools')
    expect(selectedFromCache.hydratedSessionId).toBeNull()

    const authoritativeDone = { ...ready('session-done'), state: { ...ready('session-done').state, status: 'done' as const } }
    const hydrated = reduceSessionProjection(selectedFromCache, {
      kind: 'ready', generation: 1, sessionId: 'session-done', payload: authoritativeDone,
    })
    expect(hydrated.hydratedSessionId).toBe('session-done')
    expect(hydrated.state?.status).toBe('done')
  })

  it('accepts authoritative state and context as one correction', () => {
    const current = selected('session-a')
    const authoritativeState = {
      ...current.state!, cursor: 7, status: 'done' as const,
    }
    const authoritativeContext = { ...contextSnapshot, usage: { inputTokens: 700, totalTokens: 700 }, updatedAt: 7 }
    const next = reduceSessionProjection(current, {
      kind: 'authoritative', generation: 1, sessionId: 'session-a',
      payload: { sessionId: 'session-a', cursor: 7, state: authoritativeState, contextSnapshot: authoritativeContext },
    })

    expect(next.state).toBe(authoritativeState)
    expect(next.contextSnapshot).toBe(authoritativeContext)
  })

  it('preserves a known turn start across missing and older state corrections, while ready stays authoritative', () => {
    const firstStart = '2026-09-25T12:00:00.000Z'
    const nextStart = '2026-09-25T12:01:00.000Z'
    let current = reduceSessionProjection(
      reduceSessionProjection(EMPTY_SESSION_PROJECTION, { kind: 'select', generation: 1, sessionId: 'session-a' }),
      { kind: 'ready', generation: 1, sessionId: 'session-a', payload: { ...ready('session-a'), cursor: 4, turnStartedAt: firstStart } },
    )
    current = reduceSessionProjection(current, {
      kind: 'authoritative', generation: 1, sessionId: 'session-a',
      payload: { sessionId: 'session-a', cursor: 5, state: { ...current.state!, cursor: 5 }, contextSnapshot },
    })
    expect(current.turnStartedAt).toBe(firstStart)

    current = reduceSessionProjection(current, {
      kind: 'authoritative', generation: 1, sessionId: 'session-a',
      payload: { sessionId: 'session-a', cursor: 3, state: { ...current.state!, cursor: 3 }, contextSnapshot, turnStartedAt: '2026-09-25T11:59:00.000Z' },
    })
    expect(current.turnStartedAt).toBe(firstStart)
    expect(current.state?.cursor).toBe(5)

    current = reduceSessionProjection(current, {
      kind: 'authoritative', generation: 1, sessionId: 'session-a',
      payload: { sessionId: 'session-a', cursor: 6, state: { ...current.state!, cursor: 6 }, contextSnapshot, turnStartedAt: nextStart },
    })
    expect(current.turnStartedAt).toBe(nextStart)
    expect(current.turnStartedAtCursor).toBe(6)

    const legacyReady = reduceSessionProjection(current, {
      kind: 'ready', generation: 1, sessionId: 'session-a', payload: { ...ready('session-a'), cursor: 7 },
    })
    expect(legacyReady.turnStartedAt).toBeNull()
    expect(legacyReady.turnStartedAtCursor).toBeNull()
  })

  it('ignores events from obsolete session generations', () => {
    const old = selected('session-a', 1)
    const current = reduceSessionProjection(old, { kind: 'select', generation: 2, sessionId: 'session-b' })
    const stale = reduceSessionProjection(current, {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'stale'),
    })

    expect(stale).toBe(current)
    expect(stale.sessionId).toBe('session-b')
    expect(stale.state).toBeNull()
    expect(stale.timeline).toEqual([])
  })

  it('merges history by sequence while preserving conflicting live entries', () => {
    const current = reduceSessionProjection(selected('session-a'), {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'live'),
    })
    const conflict = { ...appended('session-a', 1, 'different'), event: { kind: 'llm_error' as const, error: 'different kind' } }
    const next = reduceSessionProjection(current, {
      kind: 'history', generation: 1, sessionId: 'session-a',
      entries: [
        { seq: conflict.seq, ts: conflict.ts, event: conflict.event, effects: [] },
        { ...appended('session-a', 2, 'history'), effects: [] },
      ],
    })

    expect(next.timeline.map((entry) => entry.event.kind)).toEqual(['user_message', 'user_message'])
    expect(next.timeline.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it('authoritative history reset replaces conflicting cached/live entries', () => {
    const current = reduceSessionProjection(selected('session-a'), {
      kind: 'appended', generation: 1, sessionId: 'session-a', payload: appended('session-a', 1, 'stale live'),
    })
    const authoritative = { ...appended('session-a', 1, 'server'), event: { kind: 'llm_error' as const, error: 'server truth' } }
    const next = reduceSessionProjection(current, {
      kind: 'history', generation: 1, sessionId: 'session-a', reset: true,
      entries: [
        { seq: authoritative.seq, ts: authoritative.ts, event: authoritative.event, effects: [] },
        { seq: authoritative.seq, ts: authoritative.ts, event: { kind: 'cancel' }, effects: [] },
      ],
    })
    expect(next.timeline).toHaveLength(1)
    expect(next.timeline[0]?.event).toEqual({ kind: 'llm_error', error: 'server truth' })
  })
})
