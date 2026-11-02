import { describe, expect, it, vi } from 'vitest'
import { COPILOT_AGENT_RUNTIME_CAPABILITIES, KERNEL_AGENT_RUNTIME_CAPABILITIES, type ClientUserMessage, type RuntimeMetadataEntry } from '@agent-kernel/shared'
import { createConfig, createInitialState } from '@agent-kernel/kernel'

import { buildCompactionMetadataIndex, consumeCompactionMetadata, deriveSessionConfig, handleUserMessage, loadDashboardSession, loadRecordForCleanup, recoverSubAgentOutcome, sessionTreeTokenUsage, type DashboardDeps } from './dashboard-ns.js'
import { terminalOwnerSessionId, terminalSessionRoom } from './rooms.js'
import type { SessionStore } from '../store/session.js'
import type { SessionRecord } from '../store/session.js'

describe('session tree token usage', () => {
  const record = (
    sessionId: string,
    contextTokens: number,
    inputTokens: number,
    outputTokens: number,
  ): SessionRecord => ({
    sessionId,
    config: createConfig({ tools: [] }),
    preferences: {},
    state: {
      ...createInitialState({ sessionId }),
      usage: { inputTokens, outputTokens, cacheCreationTokens: 3, cacheReadTokens: 4 },
    },
    runtimeContextSnapshot: {
      model: { ref: 'test:model' },
      contextWindow: { tokens: 100_000, source: 'api_reported' },
      usage: { inputTokens: contextTokens, totalTokens: contextTokens },
      breakdown: { system: 0, transcript: contextTokens, tools: 0, memory: 0, attachments: 0, pendingUserInput: 0 },
      estimator: {
        total: { kind: 'provider_reported', confidence: 'exact' },
        breakdown: { kind: 'heuristic', confidence: 'rough' },
        version: 'test',
      },
      updatedAt: 1,
    },
  } as unknown as SessionRecord)

  it('separates current context occupancy from cumulative API usage across all descendants', () => {
    const usage = sessionTreeTokenUsage(
      record('root', 100, 1_000, 100),
      [record('child', 40, 400, 40), record('grandchild', 20, 200, 20)],
    )
    expect(usage.direct).toMatchObject({
      currentContextTokens: 100,
      cumulativeInputTokens: 1_000,
      cumulativeOutputTokens: 100,
      sessionCount: 1,
    })
    expect(usage.tree).toEqual({
      currentContextTokens: 160,
      cumulativeInputTokens: 1_600,
      cumulativeOutputTokens: 160,
      cacheCreationTokens: 9,
      cacheReadTokens: 12,
      sessionCount: 3,
    })
  })
})

describe('DAG parent runtime configuration', () => {
  it('exposes planner authority only, plus Host-local clarification', () => {
    const tool = (name: string, executionHandler?: string) => ({
      name,
      description: name,
      inputSchema: { type: 'object' as const },
      requiresApproval: false,
      ...(executionHandler ? { executionKind: 'host' as const, executionHandler } : {}),
    })
    const config = deriveSessionConfig(createConfig({
      tools: [
        tool('read_file'),
        tool('bash'),
        tool('websearch', 'websearch'),
        tool('agent', 'agent'),
        tool('ask_user_choice', 'ask_user_choice'),
      ],
    }), undefined, 'dag')
    expect(config.tools.map((candidate) => candidate.name)).toEqual(['ask_user_choice', 'dag_plan'])
    expect(config.systemPrompt).toContain('planner/controller only')
  })
})

function makeMeta(
  action: string,
  payload: Record<string, unknown>,
  ts = '2026-08-01T00:00:00.000Z',
): RuntimeMetadataEntry {
  return {
    kind: 'runtime_metadata',
    ts,
    sessionId: 's1',
    action,
    payload,
  }
}

describe('dashboard user message routing', () => {
  function messageHarness(
    status: 'idle' | 'thinking',
    agentRuntime: 'kernel' | 'copilot' = 'copilot',
    pending = 0,
  ) {
    const order: string[] = []
    const send = vi.fn(async () => { order.push('send') })
    const cancel = vi.fn(async () => { order.push('cancel') })
    const enqueue = vi.fn(async () => { order.push('enqueue') })
    const drain = vi.fn(async () => { order.push('drain') })
    const commitReferences = vi.fn(async () => { order.push('commit') })
    const requestStopAtBoundary = vi.fn()
    const record = {
      sessionId: 'copilot-session',
      agentRuntime,
      preferences: { selectedModel: 'copilot:gpt-5' },
      state: { status },
    }
    const deps = {
      store: { get: vi.fn(() => record) },
      agentRuntimes: {
        require: vi.fn(() => ({
          descriptor: () => ({
            label: agentRuntime === 'copilot' ? 'Copilot' : 'Kernel',
            capabilities: agentRuntime === 'copilot' ? COPILOT_AGENT_RUNTIME_CAPABILITIES : KERNEL_AGENT_RUNTIME_CAPABILITIES,
          }),
          send,
          cancel,
        })),
      },
      loop: {
        hasActiveTurn: vi.fn(() => status === 'thinking'),
        hasActiveLlmCall: vi.fn(() => status === 'thinking'),
        recoverInterruptedLlm: vi.fn(),
        requestStopAtBoundary,
      },
      loopDeps: { messageAttachments: { commitReferences } },
      messageQueues: {
        pending: vi.fn(() => pending),
        enqueue,
        drain,
      },
      broadcastError: vi.fn(),
    } as unknown as DashboardDeps
    return { deps, order, send, cancel, enqueue, drain, commitReferences, requestStopAtBoundary }
  }

  it.each(['kernel', 'copilot'] as const)('durably queues a %s queue-mode message with committed references while another turn is active', async (agentRuntime) => {
    const { deps, order, send, enqueue, drain, commitReferences } = messageHarness('thinking', agentRuntime)
    const content = [{ type: 'text' as const, text: 'details' }]
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-follow-up',
      text: 'follow up',
      content,
      mode: 'queue',
    }

    await handleUserMessage(deps, message)

    expect(send).not.toHaveBeenCalled()
    expect(commitReferences).toHaveBeenCalledWith(message.sessionId, content)
    expect(enqueue).toHaveBeenCalledWith(message.sessionId, expect.objectContaining({
      operationId: message.operationId,
      text: message.text,
      content,
      model: 'copilot:gpt-5',
      mode: 'queue',
    }), undefined, undefined)
    expect(drain).toHaveBeenCalledWith(message.sessionId)
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('enqueue'))
  })

  it('keeps an idle Copilot steer immediate but commits references before sending', async () => {
    const { deps, order, send, enqueue } = messageHarness('idle')
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-steer',
      text: 'redirect',
      mode: 'steer',
    }

    await handleUserMessage(deps, message)

    expect(enqueue).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      text: message.text,
      operationId: message.operationId,
      model: 'copilot:gpt-5',
    }))
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('send'))
  })

  it('defers a busy Copilot steer without cancelling or starting an overlapping generation', async () => {
    const { deps, order, send, cancel, enqueue, drain, requestStopAtBoundary } = messageHarness('thinking')
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-busy-steer',
      text: 'redirect after the child finishes',
      mode: 'steer',
    }

    await handleUserMessage(deps, message)

    expect(send).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(message.sessionId, expect.objectContaining({
      operationId: message.operationId,
      text: message.text,
      model: 'copilot:gpt-5',
      mode: 'steer',
    }), 'front', undefined)
    expect(drain).toHaveBeenCalledWith(message.sessionId)
    expect(requestStopAtBoundary).not.toHaveBeenCalled()
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('enqueue'))
  })

  it('does not bypass an existing Copilot queue with an otherwise resting steer', async () => {
    const { deps, send, enqueue } = messageHarness('idle', 'copilot', 1)
    const message: ClientUserMessage = {
      sessionId: 'copilot-session',
      operationId: 'copilot-steer-behind-claim',
      text: 'redirect safely',
      mode: 'steer',
    }

    await handleUserMessage(deps, message)

    expect(send).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(message.sessionId, expect.objectContaining({
      text: message.text,
      operationId: message.operationId,
      model: 'copilot:gpt-5',
      mode: 'steer',
    }), 'front', undefined)
  })
})

describe('temporary workspace terminal identity', () => {
  it('maps an isolated PTY id to its authorized owner session and rejects malformed ids', () => {
    expect(terminalOwnerSessionId('session-1')).toBe('session-1')
    expect(terminalOwnerSessionId('workspace-terminal:session-1:request-1')).toBe('session-1')
    expect(terminalSessionRoom('workspace-terminal:session-1:request-1')).toBe('session:session-1')
    expect(terminalOwnerSessionId('workspace-terminal:')).toBeUndefined()
    expect(terminalOwnerSessionId('workspace-terminal::request-1')).toBeUndefined()
  })

  describe('sub-agent lifecycle recovery', () => {
    it('recovers cancellation details from the durable parent tool result', () => {
      const state = {
        ...createInitialState({ sessionId: 'parent' }),
        messages: [{
          role: 'tool' as const,
          content: [{
            type: 'tool_result' as const,
            callId: 'agent-call',
            ok: false,
            content: [
              '<sub_agent session_id="child" status="cancelled" turns="3" duration_ms="4200">',
              '<error>stopped &amp; reported</error>',
              '</sub_agent>',
            ].join('\n'),
          }],
        }],
      }

      expect(recoverSubAgentOutcome(state, 'agent-call')).toEqual({
        status: 'cancelled',
        turns: 3,
        durationMs: 4200,
        error: 'stopped & reported',
      })
    })

    it('recovers a partial timeout as a failed lifecycle', () => {
      const state = {
        ...createInitialState({ sessionId: 'parent' }),
        messages: [{
          role: 'tool' as const,
          content: [{
            type: 'tool_result' as const,
            callId: 'agent-timeout',
            ok: true,
            content: [
              '<sub_agent session_id="child" status="timed_out_with_partial_result" turns="2" duration_ms="5000">',
              '<warning>Sub-agent reached ordinary-idle; returning verified partial work.</warning>',
              '<result>partial</result>',
              '</sub_agent>',
            ].join('\n'),
          }],
        }],
      }

      expect(recoverSubAgentOutcome(state, 'agent-timeout')).toEqual({
        status: 'failed',
        turns: 2,
        durationMs: 5000,
        error: 'Sub-agent reached ordinary-idle; returning verified partial work.',
      })
    })
  })
})

describe('history compaction-metadata correlator', () => {
  it('rebuilds trigger/token metadata by replaceRange, preserving order for duplicates', () => {
    const entries: RuntimeMetadataEntry[] = [
      makeMeta('compaction_applied', {
        trigger: 'auto',
        attemptId: 'cmp_1',
        replaceRange: { start: 1, end: 3 },
        replacedCount: 2,
        tokensBefore: 12000,
        tokensAfter: 4000,
      }),
      makeMeta('compaction_applied', {
        trigger: 'preflight',
        attemptId: 'cmp_2',
        replaceRange: { start: 1, end: 5 },
        replacedCount: 4,
        tokensBefore: 18000,
        tokensAfter: 6000,
      }),
      // Second compaction that happens to share replaceRange with cmp_1 —
      // must not clobber the first; we pop them in append order.
      makeMeta('compaction_applied', {
        trigger: 'manual',
        attemptId: 'cmp_3',
        replaceRange: { start: 1, end: 3 },
        replacedCount: 2,
        tokensBefore: 30000,
        tokensAfter: 5000,
      }),
      // Unrelated action — must be ignored.
      makeMeta('compaction_skipped', { trigger: 'auto', reason: 'circuit_breaker_open' }),
    ]

    const index = buildCompactionMetadataIndex(entries)

    const first = consumeCompactionMetadata(index, { start: 1, end: 3 })
    expect(first).toEqual({
      trigger: 'auto',
      attemptId: 'cmp_1',
      tokensBefore: 12000,
      tokensAfter: 4000,
      replacedCount: 2,
    })

    const second = consumeCompactionMetadata(index, { start: 1, end: 5 })
    expect(second?.trigger).toBe('preflight')
    expect(second?.tokensBefore).toBe(18000)

    // Same key again should now return the second cmp_3 entry, not cmp_1.
    const third = consumeCompactionMetadata(index, { start: 1, end: 3 })
    expect(third?.attemptId).toBe('cmp_3')
    expect(third?.trigger).toBe('manual')

    // Exhausted.
    expect(consumeCompactionMetadata(index, { start: 1, end: 3 })).toBeUndefined()
    expect(consumeCompactionMetadata(index, { start: 1, end: 5 })).toBeUndefined()
  })

  it('tolerates missing / malformed fields by dropping the entry (no crash)', () => {
    const entries: RuntimeMetadataEntry[] = [
      // trigger missing → drop.
      makeMeta('compaction_applied', {
        replaceRange: { start: 1, end: 2 },
        tokensBefore: 100,
        tokensAfter: 20,
        replacedCount: 1,
      }),
      // replaceRange missing → drop.
      makeMeta('compaction_applied', {
        trigger: 'auto',
        tokensBefore: 100,
        tokensAfter: 20,
        replacedCount: 1,
      }),
      // token counts missing → default to 0 (honest under-count is preferable
      // to dropping the whole record).
      makeMeta('compaction_applied', {
        trigger: 'tool_result',
        replaceRange: { start: 2, end: 5 },
      }),
    ]

    const index = buildCompactionMetadataIndex(entries)
    const only = consumeCompactionMetadata(index, { start: 2, end: 5 })
    expect(only).toEqual({
      trigger: 'tool_result',
      tokensBefore: 0,
      tokensAfter: 0,
      replacedCount: 3,
    })
  })

  describe('Dashboard Session hydration', () => {
    it('runs external Runtime recovery even when an unrecovered record is cached', async () => {
      const cached = { sessionId: 'copilot-session', agentRuntime: 'copilot' as const, executionMode: 'chat' as const, state: { status: 'idle' as const, cursor: 0 } }
      const recovered = { ...cached, state: { status: 'error' as const, cursor: 2 } }
      const store = {
        get: vi.fn(() => cached),
        load: vi.fn(async () => recovered),
      } as unknown as SessionStore

      await expect(loadDashboardSession(store, cached.sessionId)).resolves.toBe(recovered)
      expect(store.load).toHaveBeenCalledWith(cached.sessionId, undefined)
    })

    it('restores DAG runtime instructions when hydrating an external Runtime Session', async () => {
      const cached = {
        sessionId: 'copilot-dag',
        agentRuntime: 'copilot' as const,
        executionMode: 'dag' as const,
        state: { status: 'idle' as const, cursor: 0 },
      }
      const store = {
        get: vi.fn(() => cached),
        load: vi.fn(async () => cached),
      } as unknown as SessionStore
      const runtimeConfig = createConfig({ systemPrompt: 'current', tools: [] })

      await loadDashboardSession(store, cached.sessionId, runtimeConfig)

      expect(store.load).toHaveBeenCalledWith(cached.sessionId, {
        runtimeConfig: expect.objectContaining({
          systemPrompt: expect.stringContaining('DAG-First Kala Session'),
          tools: expect.arrayContaining([expect.objectContaining({ name: 'dag_plan' })]),
        }),
      })
    })

    it('does not eagerly recover a cached Kernel Session during hydration', async () => {
      const cached = { sessionId: 'kernel-session', agentRuntime: 'kernel' as const, state: { status: 'thinking' as const, cursor: 4 } }
      const store = {
        get: vi.fn(() => cached),
        load: vi.fn(),
      } as unknown as SessionStore

      await expect(loadDashboardSession(store, cached.sessionId)).resolves.toBe(cached)
      expect(store.load).not.toHaveBeenCalled()
    })

    it('loads cleanup records without recovering interrupted external Runtime state', async () => {
      const interrupted = {
        sessionId: 'copilot-cleanup',
        agentRuntime: 'copilot' as const,
        state: { status: 'thinking' as const, cursor: 4 },
      }
      const store = {
        get: vi.fn(() => undefined),
        load: vi.fn(async () => interrupted),
      } as unknown as SessionStore

      await expect(loadRecordForCleanup(store, interrupted.sessionId)).resolves.toBe(interrupted)
      expect(store.load).toHaveBeenCalledWith(interrupted.sessionId, { recoverDangling: false })
    })
  })
})
