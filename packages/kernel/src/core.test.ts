import { describe, expect, it } from 'vitest'
import {
  createConfig,
  createInitialState,
  fold,
  foldWithTrace,
  fork,
  legalTransitions,
  stateInvariantViolation,
  step,
} from './index.js'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Message,
  ToolSchema,
} from './types.js'

// ============================================================================
// Fixtures
// ============================================================================

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file',
  inputSchema: { type: 'object' },
  requiresApproval: false,
}
const WRITE: ToolSchema = {
  name: 'write',
  description: 'Write a file',
  inputSchema: { type: 'object' },
  requiresApproval: true,
}
const TOOLS = [READ, WRITE]

const CONFIG: AgentConfig = createConfig({
  tools: TOOLS,
  systemPrompt: 'you are a coding agent',
})

function initial(): AgentState {
  return createInitialState({
    sessionId: 's1',
    systemPrompt: 'you are a coding agent',
  })
}

function asst(...content: Message['content']): Message {
  return { role: 'assistant', content }
}

// ============================================================================
// Basic state transitions
// ============================================================================

describe('step: user_message', () => {
  it('appends user message and emits call_llm', () => {
    const s0 = initial()
    const { next, effects } = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(next.status).toBe('thinking')
    expect(next.messages).toHaveLength(2) // system + user
    expect(next.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(effects).toHaveLength(1)
    expect(effects[0]?.kind).toBe('call_llm')
  })

  it('is no-op when not idle', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(next.cursor).toBe(s0.cursor + 1) // cursor still advances
    expect(next.messages).toEqual(s0.messages) // but no message added
    expect(effects).toEqual([])
  })

  it('recovers from error with a fresh user message', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'error',
      error: 'provider failed',
      pendingCalls: [
        { callId: 'stale', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(s0, { kind: 'user_message', text: 'try again' }, CONFIG)
    expect(next.status).toBe('thinking')
    expect(next.error).toBeUndefined()
    expect(next.pendingCalls).toEqual([])
    expect(next.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'try again' }],
    })
    expect(effects).toEqual([{ kind: 'call_llm', messages: next.messages, tools: CONFIG.tools }])
  })

  it('repairs orphaned tool calls before a fresh user message', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'error',
      error: 'previous turn failed after cancel',
      messages: [
        ...initial().messages,
        asst({ type: 'tool_call', callId: 'c-orphan', name: 'bash', input: { command: 'sleep 90' } }),
      ],
      pendingCalls: [],
    }

    const { next, effects } = step(s0, { kind: 'user_message', text: 'continue now' }, CONFIG)

    expect(next.status).toBe('thinking')
    expect(next.messages.at(-2)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', callId: 'c-orphan', ok: false, content: 'cancelled by user' }],
    })
    expect(next.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'continue now' }],
    })
    expect(effects[0]).toMatchObject({ kind: 'call_llm' })
  })

  it('repairs only the current turn without rescanning completed historical turns', () => {
    const completed = Array.from({ length: 2_000 }, (_, index): Message[] => [
      { role: 'user', content: [{ type: 'text', text: `turn ${index}` }] },
      asst({ type: 'tool_call', callId: `done-${index}`, name: 'read_file', input: { path: `${index}.ts` } }),
      { role: 'tool', content: [{ type: 'tool_result', callId: `done-${index}`, ok: true, content: 'ok' }] },
    ]).flat()
    const s0: AgentState = {
      ...initial(),
      status: 'error',
      messages: [
        ...initial().messages,
        ...completed,
        { role: 'user', content: [{ type: 'text', text: 'current turn' }] },
        asst({ type: 'tool_call', callId: 'current-orphan', name: 'bash', input: { command: 'sleep 90' } }),
      ],
      pendingCalls: [],
    }

    const started = performance.now()
    const { next } = step(s0, { kind: 'user_message', text: 'continue' }, CONFIG)
    const duration = performance.now() - started
    const cancelled = next.messages.flatMap((message) => message.content).filter((content) => content.type === 'tool_result' && content.content === 'cancelled by user')

    expect(cancelled).toEqual([{ type: 'tool_result', callId: 'current-orphan', ok: false, content: 'cancelled by user' }])
    expect(duration).toBeLessThan(20)
  })

  it('cursor advances by exactly 1', () => {
    const s0 = initial()
    const { next } = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(next.cursor).toBe(s0.cursor + 1)
  })

  it('accepts structured image content unchanged', () => {
    const s0 = initial()
    const content: Message['content'] = [
      { type: 'text', text: 'describe this' },
      {
        type: 'image',
        source: {
          kind: 'base64',
          mediaType: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
    ]
    const { next, effects } = step(
      s0,
      { kind: 'user_message', content },
      CONFIG,
    )
    expect(next.status).toBe('thinking')
    expect(next.messages[1]).toEqual({ role: 'user', content })
    expect(effects[0]).toMatchObject({
      kind: 'call_llm',
      messages: next.messages,
    })
  })
})

describe('step: clear', () => {
  it('clears the current session while preserving session context', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system' }] },
        { role: 'user', content: [{ type: 'text', text: 'old prompt' }] },
      ],
      pendingCalls: [{ callId: 'c1', name: 'bash', input: {}, status: 'dispatched' }],
      usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 4, cacheReadTokens: 8 },
      memory: [{ key: 'old', content: 'value', updatedAt: '2026-07-07T00:00:00.000Z' }],
      cwd: '/tmp/project',
      approvalMode: 'ask',
    }

    const { next, effects } = step(s0, { kind: 'clear' }, CONFIG)

    expect(next.sessionId).toBe(s0.sessionId)
    expect(next.cwd).toBe('/tmp/project')
    expect(next.approvalMode).toBe('ask')
    expect(next.status).toBe('idle')
    expect(next.messages).toEqual([])
    expect(next.pendingCalls).toEqual([])
    expect(next.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
    expect(effects).toEqual([])
  })
})

describe('step: llm_response (plain answer)', () => {
  it('marks turn done and emits finish', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hello!' }),
      },
      CONFIG,
    )
    expect(next.status).toBe('done')
    expect(next.messages).toHaveLength(2) // system + assistant
    expect(next.messages.at(-1)?.role).toBe('assistant')
    expect(effects).toEqual([{ kind: 'finish' }])
  })

  it('is no-op if not thinking', () => {
    const s0 = initial()
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hi' }),
      },
      CONFIG,
    )
    expect(next.status).toBe('idle')
    expect(effects).toEqual([])
  })

  it('accumulates usage when provided', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hi' }),
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      CONFIG,
    )
    expect(next.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('adds usage on top of prior total across turns', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'thinking',
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    }
    const { next } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hi' }),
        usage: { inputTokens: 30, outputTokens: 5 },
      },
      CONFIG,
    )
    expect(next.usage).toEqual({
      inputTokens: 80,
      outputTokens: 15,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })
  })
})

describe('step: llm_response with tool calls', () => {
  it('keeps missing legacy intent absent instead of synthesizing misleading UI copy', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(s0, { kind: 'llm_response', message: asst({ type: 'tool_call', callId: 'intent-fallback', name: 'read_file', input: { path: '/tmp/config.ts' } }) }, CONFIG)
    expect(next.messages.at(-1)?.content[0]).toEqual({ type: 'tool_call', callId: 'intent-fallback', name: 'read_file', input: { path: '/tmp/config.ts' } })
    expect(effects[0]).not.toHaveProperty('intent')
  })

  it('extracts intent metadata and removes it from execution input', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(s0, { kind: 'llm_response', message: asst({ type: 'tool_call', callId: 'intent-1', name: 'read', input: { path: '/tmp/x', _intent: 'Inspect the configuration.' } }) }, CONFIG)
    expect(next.messages.at(-1)?.content[0]).toMatchObject({ type: 'tool_call', intent: 'Inspect the configuration.', input: { path: '/tmp/x' } })
    expect(effects[0]).toMatchObject({ kind: 'call_tool', intent: 'Inspect the configuration.', input: { path: '/tmp/x' } })
  })

  it('dispatches non-approval tool directly', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'read',
          input: { path: '/tmp/x' },
        }),
      },
      CONFIG,
    )
    expect(next.status).toBe('executing_tools')
    expect(next.pendingCalls).toEqual([
      {
        callId: 'c1',
        name: 'read',
        input: { path: '/tmp/x' },
        status: 'dispatched',
      },
    ])
    expect(effects).toEqual([
      {
        kind: 'call_tool',
        callId: 'c1',
        name: 'read',
        input: { path: '/tmp/x' },
      },
    ])
  })

  it('parks approval-required tool in awaiting_approval', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'write',
          input: { path: '/tmp/x', content: 'y' },
        }),
      },
      CONFIG,
    )
    expect(next.status).toBe('awaiting_approval')
    expect(next.pendingCalls[0]?.status).toBe('awaiting_approval')
    expect(effects).toEqual([
      {
        kind: 'request_approval',
        callId: 'c1',
        name: 'write',
        input: { path: '/tmp/x', content: 'y' },
      },
    ])
  })

  it('approves Session attachment reads but requires write approval for save', () => {
    const config = createConfig({
      tools: [...TOOLS, { name: 'session_attachment', description: 'Manage attached files', inputSchema: { type: 'object' }, requiresApproval: false }],
    })
    const s0 = { ...initial(), status: 'thinking' as const }
    const read = step(s0, { kind: 'llm_response', message: asst({
      type: 'tool_call', callId: 'read-attachment', name: 'session_attachment', input: { action: 'read_text' },
    }) }, config)
    expect(read.effects[0]?.kind).toBe('call_tool')
    const save = step(s0, { kind: 'llm_response', message: asst({
      type: 'tool_call', callId: 'save-attachment', name: 'session_attachment', input: { action: 'save', path: '/workspace/snapshot.json' },
    }) }, config)
    expect(save.effects[0]?.kind).toBe('request_approval')
    const denied = step({ ...s0, approvalMode: 'deny' }, { kind: 'llm_response', message: asst({
      type: 'tool_call', callId: 'denied-save', name: 'session_attachment', input: { action: 'save' },
    }) }, config)
    expect(denied.effects).not.toContainEqual(expect.objectContaining({ kind: 'call_tool' }))
  })

  it('handles mixed approval/auto in one response', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst(
          { type: 'tool_call', callId: 'c1', name: 'read', input: {} },
          { type: 'tool_call', callId: 'c2', name: 'write', input: {} },
        ),
      },
      CONFIG,
    )
    // Read auto-dispatched; write awaiting approval.
    expect(next.status).toBe('awaiting_approval')
    const read = next.pendingCalls.find((c) => c.callId === 'c1')
    const write = next.pendingCalls.find((c) => c.callId === 'c2')
    expect(read?.status).toBe('dispatched')
    expect(write?.status).toBe('awaiting_approval')
    expect(effects).toHaveLength(2)
  })
})

describe('transition diagnostics', () => {
  it('reports applied transitions with their source and destination', () => {
    const result = step(initial(), { kind: 'user_message', text: 'hello' }, CONFIG)
    expect(result.transition).toEqual({
      outcome: 'applied',
      from: 'idle',
      to: 'thinking',
      event: 'user_message',
    })
  })

  it('reports illegal state/event pairs while preserving cursor semantics', () => {
    const state = initial()
    const result = step(state, { kind: 'tool_result', callId: 'missing', ok: true, content: '' }, CONFIG)
    expect(result.transition).toEqual({
      outcome: 'ignored',
      from: 'idle',
      to: 'idle',
      event: 'tool_result',
      reason: 'event_not_legal_in_state',
    })
    expect(result.next).toEqual({ ...state, cursor: state.cursor + 1 })
    expect(result.effects).toEqual([])
  })

  it('reports malformed payloads for otherwise legal transitions', () => {
    const state = { ...initial(), status: 'thinking' as const }
    const result = step(state, {
      kind: 'messages_replaced',
      reason: 'compaction',
      replaceRange: { start: -1, end: 1 },
      replacementMessages: [],
    }, CONFIG)
    expect(result.transition).toMatchObject({
      outcome: 'rejected',
      from: 'thinking',
      to: 'thinking',
      event: 'messages_replaced',
      reason: 'invalid_event_payload',
    })
  })

  it('rejects reused Tool call identities without dispatching another side effect', () => {
    const state: AgentState = {
      ...initial(),
      status: 'thinking',
      messages: [
        ...initial().messages,
        asst({ type: 'tool_call', callId: 'already-used', name: 'read', input: { path: '/tmp/a' } }),
        { role: 'tool', content: [{ type: 'tool_result', callId: 'already-used', ok: true, content: 'done' }] },
      ],
    }
    const result = step(state, {
      kind: 'llm_response',
      message: asst({ type: 'tool_call', callId: 'already-used', name: 'read', input: { path: '/tmp/b' } }),
    }, CONFIG)
    expect(result.transition).toMatchObject({ outcome: 'rejected', reason: 'invalid_event_payload' })
    expect(result.next).toEqual({ ...state, cursor: state.cursor + 1 })
    expect(result.effects).toEqual([])
  })

  it('describes every status and reports every absent transition cell as ignored', () => {
    const states: Record<AgentState['status'], AgentState> = {
      idle: initial(),
      thinking: { ...initial(), status: 'thinking' },
      awaiting_approval: {
        ...initial(),
        status: 'awaiting_approval',
        pendingCalls: [{ callId: 'awaiting', name: 'write', input: {}, status: 'awaiting_approval' }],
      },
      executing_tools: {
        ...initial(),
        status: 'executing_tools',
        pendingCalls: [{ callId: 'running', name: 'read', input: {}, status: 'dispatched' }],
      },
      done: { ...initial(), status: 'done' },
      error: { ...initial(), status: 'error', error: 'failed' },
    }
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'hello' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'done' }) },
      { kind: 'llm_error', error: 'failed' },
      { kind: 'user_approve', callId: 'awaiting' },
      { kind: 'user_reject', callId: 'awaiting' },
      { kind: 'tool_result', callId: 'running', ok: true, content: 'ok' },
      { kind: 'cancel' },
      { kind: 'clear' },
      { kind: 'messages_replaced', reason: 'recovery', replaceRange: { start: 0, end: 0 }, replacementMessages: [] },
      { kind: 'approval_mode_changed', mode: 'ask' },
      { kind: 'cwd_changed', cwd: '/workspace' },
    ]

    expect(Object.keys(legalTransitions).sort()).toEqual(Object.keys(states).sort())
    for (const [status, state] of Object.entries(states) as Array<[AgentState['status'], AgentState]>) {
      const legal = new Set(legalTransitions[status])
      for (const event of events) {
        const result = step(state, event, CONFIG)
        if (!legal.has(event.kind)) {
          expect(result.transition, `${status} + ${event.kind}`).toMatchObject({
            outcome: 'ignored',
            from: status,
            event: event.kind,
            reason: 'event_not_legal_in_state',
          })
          expect(result.next.cursor).toBe(state.cursor + 1)
          expect(result.effects).toEqual([])
        }
      }
    }
  })

  it('detects contradictory status payloads', () => {
    expect(stateInvariantViolation({
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [],
    })).toMatch(/requires dispatched calls/)
    expect(stateInvariantViolation({
      ...initial(),
      status: 'done',
      error: 'stale',
    })).toMatch(/cannot retain an error/)
    expect(stateInvariantViolation({
      ...initial(),
      status: 'error',
      error: 'failed',
    })).toBeUndefined()
  })
})

describe('step: approval / rejection', () => {
  it('approve → dispatched, emits call_tool', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'awaiting_approval',
      pendingCalls: [
        { callId: 'c1', name: 'write', input: { x: 1 }, status: 'awaiting_approval' },
      ],
    }
    const { next, effects } = step(s0, { kind: 'user_approve', callId: 'c1' }, CONFIG)
    expect(next.status).toBe('executing_tools')
    expect(next.pendingCalls[0]?.status).toBe('dispatched')
    expect(effects[0]).toEqual({
      kind: 'call_tool',
      callId: 'c1',
      name: 'write',
      input: { x: 1 },
    })
  })

  it('reject → removes pending, appends tool_result, calls LLM again', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'awaiting_approval',
      pendingCalls: [
        { callId: 'c1', name: 'write', input: {}, status: 'awaiting_approval' },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'user_reject',
        callId: 'c1',
        reason: 'nope',
      },
      CONFIG,
    )
    expect(next.pendingCalls).toEqual([])
    expect(next.status).toBe('thinking')
    expect(next.messages.at(-1)?.role).toBe('tool')
    expect(effects[0]?.kind).toBe('call_llm')
  })

  it('duplicate approval is an idempotent no-op after dispatch', () => {
    const s0: AgentState = {
      ...initial(), status: 'awaiting_approval',
      pendingCalls: [{ callId: 'c1', name: 'write', input: {}, status: 'awaiting_approval' }],
    }
    const approved = step(s0, { kind: 'user_approve', callId: 'c1' }, CONFIG)
    const duplicate = step(approved.next, { kind: 'user_approve', callId: 'c1' }, CONFIG)
    expect(duplicate.next.pendingCalls).toEqual(approved.next.pendingCalls)
    expect(duplicate.next.messages).toEqual(approved.next.messages)
    expect(duplicate.effects).toEqual([])
  })

  it('partial rejection preserves sibling approvals and waits for settlement', () => {
    const s0: AgentState = {
      ...initial(), status: 'awaiting_approval',
      pendingCalls: [
        { callId: 'c1', name: 'write', input: {}, status: 'awaiting_approval' },
        { callId: 'c2', name: 'write', input: {}, status: 'awaiting_approval' },
      ],
    }
    const rejected = step(s0, { kind: 'user_reject', callId: 'c1', reason: 'no' }, CONFIG)
    expect(rejected.next.status).toBe('awaiting_approval')
    expect(rejected.next.pendingCalls).toEqual([
      { callId: 'c2', name: 'write', input: {}, status: 'awaiting_approval' },
    ])
    expect(rejected.effects).toEqual([])
    expect(rejected.next.messages.at(-1)?.content[0]).toMatchObject({ type: 'tool_result', callId: 'c1', ok: false })
  })
})

describe('step: tool_result', () => {
  it('single tool: appends result, thinks again', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'tool_result',
        callId: 'c1',
        ok: true,
        content: 'file contents',
      },
      CONFIG,
    )
    expect(next.pendingCalls).toEqual([])
    expect(next.status).toBe('thinking')
    expect(next.messages.at(-1)?.content[0]).toEqual({
      type: 'tool_result',
      callId: 'c1',
      ok: true,
      content: 'file contents',
    })
    expect(effects[0]?.kind).toBe('call_llm')
  })

  it('parallel tools: waits until all complete before calling LLM', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
        { callId: 'c2', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const r1 = step(
      s0,
      { kind: 'tool_result', callId: 'c1', ok: true, content: 'a' },
      CONFIG,
    )
    expect(r1.next.status).toBe('executing_tools')
    expect(r1.effects).toEqual([])
    expect(r1.next.pendingCalls).toHaveLength(1)

    const r2 = step(
      r1.next,
      {
        kind: 'tool_result',
        callId: 'c2',
        ok: true,
        content: 'b',
      },
      CONFIG,
    )
    expect(r2.next.status).toBe('thinking')
    expect(r2.effects[0]?.kind).toBe('call_llm')
  })

  it('is no-op for unknown callId', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'tool_result',
        callId: 'wrong',
        ok: true,
        content: 'x',
      },
      CONFIG,
    )
    expect(next.pendingCalls).toEqual(s0.pendingCalls)
    expect(effects).toEqual([])
  })
})

describe('step: tool_result — legacy todowrite history compatibility', () => {
  it('replays a historical todowrite result without promoting input into kernel state', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        {
          callId: 'c1',
          name: 'todowrite',
          input: {
            todos: [
              { content: 'ship v1', status: 'in_progress', priority: 'high' },
              { content: 'write tests', status: 'pending' },
            ],
          },
          status: 'dispatched',
        },
      ],
    }
    const { next } = step(
      s0,
      { kind: 'tool_result', callId: 'c1', ok: true, content: 'ok' },
      CONFIG,
    )
    expect(next.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'ok' }],
    })
    expect(next.pendingCalls).toEqual([])
  })
})

describe('step: cancel + errors', () => {
  it('cancel terminates the turn', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      messages: [
        ...initial().messages,
        asst({ type: 'tool_call', callId: 'c1', name: 'read', input: {} }),
      ],
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(s0, { kind: 'cancel' }, CONFIG)
    expect(next.status).toBe('done')
    expect(next.pendingCalls).toEqual([])
    expect(next.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', callId: 'c1', ok: false, content: 'cancelled by user' }],
    })
    expect(effects).toEqual([{ kind: 'finish' }])
  })

  it('cancel records every pending tool call as cancelled so the transcript is provider-valid', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'awaiting_approval',
      messages: [
        ...initial().messages,
        asst(
          { type: 'tool_call', callId: 'c1', name: 'read', input: {} },
          { type: 'tool_call', callId: 'c2', name: 'write', input: {} },
        ),
      ],
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
        { callId: 'c2', name: 'write', input: {}, status: 'awaiting_approval' },
      ],
    }

    const { next } = step(s0, { kind: 'cancel' }, CONFIG)

    const toolResults = next.messages
      .flatMap((message) => message.content)
      .filter((content): content is Extract<Message['content'][number], { type: 'tool_result' }> => content.type === 'tool_result')
    expect(toolResults.map((result) => result.callId)).toEqual(['c1', 'c2'])
    expect(toolResults.every((result) => result.ok === false && result.content === 'cancelled by user')).toBe(true)
  })

  it('llm_error moves to error status', () => {
    const s0: AgentState = { ...initial(), status: 'thinking' }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_error',
        error: 'rate limited',
      },
      CONFIG,
    )
    expect(next.status).toBe('error')
    expect(next.error).toBe('rate limited')
    expect(effects).toEqual([{ kind: 'emit_error', error: 'rate limited' }])
  })

  it('llm_error clears any staged pendingCalls (invariant I5)', () => {
    // Scenario: an LLM 5xx interrupts a turn where the previous LLM response
    // had already staged tool calls. The kernel must drop them — leaving them
    // pending would leave the dashboard rendering a "waiting to dispatch"
    // tool with no path forward, and would violate SPEC §5 invariant I5.
    const s0: AgentState = {
      ...initial(),
      status: 'thinking',
      pendingCalls: [
        { callId: 'stale', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next } = step(s0, { kind: 'llm_error', error: 'boom' }, CONFIG)
    expect(next.status).toBe('error')
    expect(next.pendingCalls).toEqual([])
  })
})

describe('regression: state hygiene on re-entry', () => {
  it('user_message from done wipes residual pendingCalls (defense in depth)', () => {
    // If an earlier bug (or unexpected sequence) left the state with a stale
    // pending call while status='done', a fresh user_message must reset the
    // pending slate before entering 'thinking' — otherwise the next LLM sees
    // ghost tools that were never in its transcript.
    const s0: AgentState = {
      ...initial(),
      status: 'done',
      pendingCalls: [
        { callId: 'ghost', name: 'read', input: {}, status: 'dispatched' },
      ],
      error: 'lingering from earlier turn',
    }
    const { next } = step(s0, { kind: 'user_message', text: 'again' }, CONFIG)
    expect(next.status).toBe('thinking')
    expect(next.pendingCalls).toEqual([])
    expect(next.error).toBeUndefined()
  })
})

// ============================================================================
// Message replacement
// ============================================================================

describe('step: messages_replaced', () => {
  const c: AgentConfig = createConfig({
    tools: TOOLS,
    systemPrompt: 'x',
    contextLimit: 100,
  })

  it('replaces an explicit message range deterministically', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'done',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'you are' }] },
        { role: 'user', content: [{ type: 'text', text: 'old request' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'recent request' }] },
      ],
    }
    const replacement = [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'old context summary' }] }]
    const { next } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 3 },
        replacementMessages: replacement,
      },
      c,
    )

    expect(next.messages).toEqual([
      s0.messages[0],
      replacement[0],
      s0.messages[3],
    ])
    expect(next.usage).toEqual(s0.usage)
  })

  it('resumes the autonomous turn when a manual compaction requests continuation', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'done',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'you are' }] },
        { role: 'user', content: [{ type: 'text', text: 'finish the task autonomously' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'partial work before compaction' }] },
      ],
    }
    const replacement = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'compacted handoff' }] }]
    const { next, effects } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 3 },
        replacementMessages: replacement,
        resume: true,
      },
      c,
    )

    expect(next.status).toBe('thinking')
    expect(next.messages).toEqual([s0.messages[0], replacement[0]])
    expect(effects).toEqual([{ kind: 'call_llm', messages: next.messages, tools: c.tools }])
  })

  it('does not start a second LLM call when a busy compaction carries resume', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'thinking',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'you are' }] },
        { role: 'user', content: [{ type: 'text', text: 'current task' }] },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 2 },
        replacementMessages: [{ role: 'user', content: [{ type: 'text', text: 'compacted handoff' }] }],
        resume: true,
      },
      c,
    )

    expect(next.status).toBe('thinking')
    expect(effects).toEqual([])
  })

  it('ignores invalid ranges', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'done',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    }
    const { next } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 2, end: 1 },
        replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'summary' }] }],
      },
      c,
    )
    expect(next.messages).toEqual(s0.messages)
  })

  it('is a no-op while awaiting_approval', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'awaiting_approval',
      pendingCalls: [
        { callId: 'c1', name: 'write', input: {}, status: 'awaiting_approval' },
      ],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'x' }] },
        { role: 'user', content: [{ type: 'text', text: 'big prompt' }] },
      ],
    }
    const { next } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 2 },
        replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'ignored' }] }],
      },
      c,
    )
    expect(next.messages).toEqual(s0.messages)
    expect(next.pendingCalls).toEqual(s0.pendingCalls)
  })

  it('allows executing_tools replacement when the pending tool-call group is preserved', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c2', name: 'read', input: {}, status: 'dispatched' },
      ],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'x' }] },
        { role: 'user', content: [{ type: 'text', text: 'old task' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'current task' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'c1', name: 'read', input: {} },
            { type: 'tool_call', callId: 'c2', name: 'read', input: {} },
          ],
        },
        { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'done' }] },
      ],
    }
    const { next } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 3 },
        replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'old context summary' }] }],
      },
      c,
    )

    expect(next.status).toBe('executing_tools')
    expect(next.pendingCalls).toEqual(s0.pendingCalls)
    expect(next.messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'tool'])
    expect(next.messages[3]).toEqual(s0.messages[4])
  })

  it('rejects executing_tools replacement that would orphan a pending tool result', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c2', name: 'read', input: {}, status: 'dispatched' },
      ],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'x' }] },
        { role: 'user', content: [{ type: 'text', text: 'current task' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'c1', name: 'read', input: {} },
            { type: 'tool_call', callId: 'c2', name: 'read', input: {} },
          ],
        },
      ],
    }
    const { next } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 3 },
        replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'unsafe summary' }] }],
      },
      c,
    )

    expect(next.messages).toEqual(s0.messages)
    expect(next.pendingCalls).toEqual(s0.pendingCalls)
  })

  it('is legal from error state', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'error',
      error: 'boom',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    }
    const { next } = step(
      s0,
      {
        kind: 'messages_replaced',
        reason: 'recovery',
        replaceRange: { start: 0, end: 1 },
        replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'recovered' }] }],
      },
      c,
    )
    expect(next.messages).toEqual([{ role: 'system', content: [{ type: 'text', text: 'recovered' }] }])
  })
})

// ============================================================================
// Purity + immutability
// ============================================================================

describe('purity', () => {
  it('input state is never mutated', () => {
    const s0 = initial()
    const snapshot = JSON.parse(JSON.stringify(s0))
    step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(s0).toEqual(snapshot)
  })

  it('same input yields same output (idempotent step)', () => {
    const s0 = initial()
    const r1 = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    const r2 = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(r1.next).toEqual(r2.next)
    expect(r1.effects).toEqual(r2.effects)
  })
})

// ============================================================================
// Replay + fork
// ============================================================================

describe('fold', () => {
  it('replays system prompt changes and keeps the override through message compaction', () => {
    const final = fold(initial(), [
      { kind: 'system_prompt_changed', prompt: 'new system', version: 7 },
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 0, end: 1 },
        replacementMessages: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
      },
    ], CONFIG)

    expect(final.systemPromptOverride).toEqual({ prompt: 'new system', version: 7 })
    expect(final.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'new system' }],
    })
    expect(final.messages.filter((message) => message.role === 'system')).toHaveLength(1)
  })

  it('applies system prompt changes while busy without scheduling another model call', () => {
    const thinking = step(initial(), { kind: 'user_message', text: 'work' }, CONFIG).next
    const result = step(thinking, { kind: 'system_prompt_changed', prompt: 'busy update' }, CONFIG)

    expect(result.transition.outcome).toBe('applied')
    expect(result.next.status).toBe('thinking')
    expect(result.next.messages[0]?.content).toEqual([{ type: 'text', text: 'busy update' }])
    expect(result.effects).toEqual([])
  })

  it('replays a full session deterministically', () => {
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'read /tmp/x' },
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'read',
          input: { path: '/tmp/x' },
        }),
      },
      { kind: 'tool_result', callId: 'c1', ok: true, content: 'hello' },
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'the file says hello' }),
      },
    ]
    const final = fold(initial(), events, CONFIG)
    expect(final.status).toBe('done')
    expect(final.cursor).toBe(4)
    expect(final.messages.at(-1)?.role).toBe('assistant')
  })

  it('trace preserves every step', () => {
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'hi' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'yo' }) },
    ]
    const { trace, final } = foldWithTrace(initial(), events, CONFIG)
    expect(trace).toHaveLength(2)
    expect(trace[0]?.cursor).toBe(1)
    expect(trace[1]?.cursor).toBe(2)
    expect(final).toBe(trace[1]?.state)
  })
})

describe('fork', () => {
  it('takes a different path from a chosen cursor', () => {
    const original: AgentEvent[] = [
      { kind: 'user_message', text: 'hi' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'original' }) },
    ]
    const alt: AgentEvent[] = [
      { kind: 'user_message', text: 'hi again' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'alternate' }) },
    ]
    // Fork at cursor 0 (before any event) — replace with alt.
    const forked = fork(initial(), original, 0, alt, CONFIG)
    expect(forked.messages.at(-1)?.content[0]).toMatchObject({
      text: 'alternate',
    })
  })

  it('keeps prefix and appends new suffix', () => {
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'first' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'a1' }) },
      { kind: 'user_message', text: 'second' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'a2' }) },
    ]
    // Fork after the first user message but before the LLM answered.
    const forked = fork(
      initial(),
      events,
      1,
      [{ kind: 'llm_response', message: asst({ type: 'text', text: 'different' }) }],
      CONFIG,
    )
    // Kept: system + user "first". Then the alt assistant reply.
    const texts = forked.messages
      .flatMap((m) => m.content)
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
    expect(texts).toContain('first')
    expect(texts).toContain('different')
    expect(texts).not.toContain('a1')
  })
})

describe('step: approval mode', () => {
  const assistantWith = (name: string): Message =>
    asst({
      type: 'tool_call',
      callId: 'c1',
      name,
      input: {},
    })

  it('defaults to "auto" — READ (requiresApproval:false) dispatches, WRITE asks', () => {
    // Sanity baseline. Rest of the tests build on this by mutating mode.
    const s0 = initial()
    expect(s0.approvalMode).toBe('auto')
    const r1 = step(
      { ...s0, status: 'thinking' },
      { kind: 'llm_response', message: assistantWith('write') },
      CONFIG,
    )
    expect(r1.next.status).toBe('awaiting_approval')
    expect(r1.effects[0]?.kind).toBe('request_approval')
  })

  it('"ask" mode forces approval even for safe tools', () => {
    const s0: AgentState = { ...initial(), approvalMode: 'ask' }
    const r = step(
      { ...s0, status: 'thinking' },
      { kind: 'llm_response', message: assistantWith('read') },
      CONFIG,
    )
    expect(r.next.status).toBe('awaiting_approval')
    expect(r.effects.map((e) => e.kind)).toEqual(['request_approval'])
  })

  it('"allow_all" mode dispatches WRITE without asking', () => {
    const s0: AgentState = { ...initial(), approvalMode: 'allow_all' }
    const r = step(
      { ...s0, status: 'thinking' },
      { kind: 'llm_response', message: assistantWith('write') },
      CONFIG,
    )
    expect(r.next.status).toBe('executing_tools')
    expect(r.effects.map((e) => e.kind)).toEqual(['call_tool'])
  })

  it('"deny" mode short-circuits WRITE into a synthetic tool_result and re-asks the LLM', () => {
    const s0: AgentState = { ...initial(), approvalMode: 'deny' }
    const r = step(
      { ...s0, status: 'thinking' },
      { kind: 'llm_response', message: assistantWith('write') },
      CONFIG,
    )
    // No tool ever dispatches. Instead the reducer injects a tool_result
    // message and immediately schedules another LLM turn so the assistant
    // can react to the refusal.
    expect(r.next.pendingCalls).toEqual([])
    expect(r.next.status).toBe('thinking')
    expect(r.effects.map((e) => e.kind)).toEqual(['call_llm'])
    const lastMsg = r.next.messages[r.next.messages.length - 1]!
    expect(lastMsg.role).toBe('tool')
    expect(lastMsg.content[0]).toMatchObject({
      type: 'tool_result',
      ok: false,
    })
  })

  it('"deny" still dispatches safe tools (requiresApproval:false)', () => {
    const s0: AgentState = { ...initial(), approvalMode: 'deny' }
    const r = step(
      { ...s0, status: 'thinking' },
      { kind: 'llm_response', message: assistantWith('read') },
      CONFIG,
    )
    expect(r.next.status).toBe('executing_tools')
    expect(r.effects.map((e) => e.kind)).toEqual(['call_tool'])
  })

  it('approval_mode_changed updates state.approvalMode in every status', () => {
    const s0 = initial()
    for (const status of [
      'idle',
      'thinking',
      'awaiting_approval',
      'executing_tools',
      'done',
      'error',
    ] as const) {
      const r = step(
        { ...s0, status },
        { kind: 'approval_mode_changed', mode: 'ask' },
        CONFIG,
      )
      expect(r.next.approvalMode).toBe('ask')
      // Status is unchanged by the mode event itself.
      expect(r.next.status).toBe(status)
    }
  })
})

describe('step: cwd', () => {
  it('updates cwd only while idle or done', () => {
    const s0 = initial()
    const idle = step(s0, { kind: 'cwd_changed', cwd: '/work/app' }, CONFIG)
    expect(idle.next.cwd).toBe('/work/app')

    const thinking = step(
      { ...idle.next, status: 'thinking' },
      { kind: 'cwd_changed', cwd: '/work/other' },
      CONFIG,
    )
    expect(thinking.next.cwd).toBe('/work/app')

    const done = step(
      { ...idle.next, status: 'done' },
      { kind: 'cwd_changed', cwd: '/work/other' },
      CONFIG,
    )
    expect(done.next.cwd).toBe('/work/other')
  })

  it('routes subsequent tool calls with the current cwd', () => {
    const config = createConfig({
      tools: [
        {
          name: 'bash',
          description: 'run shell',
          inputSchema: { type: 'object' },
          requiresApproval: false,
        },
      ],
      systemPrompt: 'sys',
    })
    const s0 = step(initial(), { kind: 'cwd_changed', cwd: '/work/app' }, config).next
    const r = step(
      { ...s0, status: 'thinking' },
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'bash',
          input: { command: 'pwd' },
        }),
      },
      config,
    )
    expect(r.effects[0]).toMatchObject({
      kind: 'call_tool',
      callId: 'c1',
      cwd: '/work/app',
    })
  })
})

// ============================================================================
// Session-scoped memory (memory with operation=write/delete and scope=session)
// ============================================================================
