/**
 * Regression net for memory consolidation.
 *
 * Two surfaces:
 *  - `parseConsolidatorOutput` — pure. Fences, malformed JSON, empty, wrong
 *    shape, and the happy path.
 *  - `consolidateMemory` — the orchestration. Driven with a minimal mock
 *    `HostLoopDeps` (fake store + scripted llm + spy tools.callTool) so we
 *    assert the full read-session → call-LLM → write-memory pipeline plus the
 *    guard rails (disabled, unknown session, running session, too short,
 *    validation rejects, per-entry write failures).
 */

import { describe, expect, it, vi } from 'vitest'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import type { AgentState, Message } from '@agent-kernel/kernel'

import {
  DEFAULT_CONSOLIDATION_CONFIG,
  consolidateMemory,
  parseConsolidatorOutput,
} from './memory-consolidation.js'
import type { ConsolidationConfig } from './memory-consolidation.js'
import type { HostLoopDeps } from '../loop.js'
import type { LLMResponse } from '../llm/adapter.js'
import type { SessionRecord } from '../store/session.js'

// ---------------------------------------------------------------------------
// parseConsolidatorOutput — pure function, exhaustive branches
// ---------------------------------------------------------------------------

describe('parseConsolidatorOutput', () => {
  it('parses a bare JSON object with a memories array', () => {
    const res = parseConsolidatorOutput('{"memories": [{"name": "x"}]}')
    expect(res).toEqual({ ok: true, memories: [{ name: 'x' }] })
  })

  it('strips a ```json fence before parsing', () => {
    const res = parseConsolidatorOutput('```json\n{"memories": []}\n```')
    expect(res).toEqual({ ok: true, memories: [] })
  })

  it('strips a bare ``` fence before parsing', () => {
    const res = parseConsolidatorOutput('```\n{"memories": [1, 2]}\n```')
    expect(res).toEqual({ ok: true, memories: [1, 2] })
  })

  it('rejects empty output', () => {
    const res = parseConsolidatorOutput('   ')
    expect(res).toEqual({ ok: false, reason: 'consolidator returned empty output' })
  })

  it('rejects invalid JSON', () => {
    const res = parseConsolidatorOutput('not json at all')
    expect(res).toEqual({ ok: false, reason: 'consolidator returned invalid JSON' })
  })

  it('rejects a non-object top-level value', () => {
    const res = parseConsolidatorOutput('42')
    expect(res).toEqual({ ok: false, reason: 'consolidator output was not an object' })
  })

  it('rejects null (typeof null === "object" but falsy)', () => {
    const res = parseConsolidatorOutput('null')
    expect(res).toEqual({ ok: false, reason: 'consolidator output was not an object' })
  })

  it('rejects an object missing the "memories" array', () => {
    const res = parseConsolidatorOutput('{"other": 1}')
    expect(res).toEqual({ ok: false, reason: 'consolidator output missing "memories" array' })
  })

  it('rejects when "memories" is present but not an array', () => {
    const res = parseConsolidatorOutput('{"memories": "nope"}')
    expect(res).toEqual({ ok: false, reason: 'consolidator output missing "memories" array' })
  })
})

// ---------------------------------------------------------------------------
// consolidateMemory — mock HostLoopDeps
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/** A conversation long enough to clear the `minMessages` gate (default 8). */
function longTranscript(): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 5; i++) {
    out.push(userMsg(`question ${i}`))
    out.push(assistantMsg(`answer ${i}`))
  }
  return out
}

type DepsOverrides = {
  record?: SessionRecord | null
  llmText?: string
  llmThrows?: Error
  callTool?: HostLoopDeps['tools']['callTool']
}

/**
 * Build a minimal `HostLoopDeps` sufficient for `consolidateMemory`. It only
 * touches `store.get`, `models.get`, `llm.call`, and `tools.callTool` — the
 * rest of the surface is stubbed to shut up the type checker.
 */
function makeState(messages: Message[]): AgentState {
  return { ...createInitialState({ sessionId: 's1' }), status: 'idle', messages }
}

function makeRecord(messages: Message[]): SessionRecord {
  return {
    sessionId: 's1',
    logPath: '/tmp/s1.jsonl',
    config: createConfig({ tools: [] }),
    state: makeState(messages),
  }
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: HostLoopDeps
  callTool: ReturnType<typeof vi.fn>
  llmCall: ReturnType<typeof vi.fn>
} {
  const defaultRecord = makeRecord(longTranscript())
  const record =
    overrides.record === undefined ? defaultRecord : overrides.record

  const callTool =
    overrides.callTool !== undefined
      ? vi.fn(overrides.callTool)
      : vi.fn(async () => ({ ok: true, content: 'written' }))

  const llmCall = vi.fn(async (): Promise<LLMResponse> => {
    if (overrides.llmThrows) throw overrides.llmThrows
    const text = overrides.llmText ?? '{"memories": []}'
    return { message: { role: 'assistant', content: [{ type: 'text', text }] } }
  })

  const deps = {
    store: { get: (id: string) => (id === 's1' ? record ?? undefined : undefined) },
    llm: { name: 'mock', call: llmCall },
    tools: { callTool, cancelPending: () => {} },
    models: { get: () => undefined },
    broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
  } as unknown as HostLoopDeps

  return { deps, callTool, llmCall }
}

const goodEntry = {
  name: 'user-prefers-concise',
  type: 'user',
  description: 'User prefers concise responses',
  content: 'Keep answers short.',
  confidence: 0.9,
}

describe('consolidateMemory', () => {
  it('returns disabled reason when config.enabled is false', async () => {
    const { deps, callTool, llmCall } = makeDeps()
    const config: ConsolidationConfig = { ...DEFAULT_CONSOLIDATION_CONFIG, enabled: false }
    const out = await consolidateMemory(deps, 's1', config)
    expect(out).toEqual({ saved: [], skipped: 0, reason: 'consolidation disabled in config' })
    expect(llmCall).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('errors on an unknown session', async () => {
    const { deps } = makeDeps()
    const out = await consolidateMemory(deps, 'does-not-exist')
    expect(out).toEqual({ saved: [], skipped: 0, error: 'unknown session: does-not-exist' })
  })

  it('refuses to consolidate a running session', async () => {
    const { deps } = makeDeps()
    // Flip the record's status to a running state.
    const rec = deps.store.get('s1')!
    rec.state = { ...rec.state, status: 'calling_llm' }
    const out = await consolidateMemory(deps, 's1')
    expect(out.error).toBe('session is running; wait for it to finish')
  })

  it('skips a session with fewer than minMessages messages', async () => {
    const { deps, llmCall } = makeDeps({
      record: makeRecord([userMsg('hi'), assistantMsg('hello')]),
    })
    const out = await consolidateMemory(deps, 's1')
    expect(out.saved).toEqual([])
    expect(out.reason).toContain('session too short')
    expect(llmCall).not.toHaveBeenCalled()
  })

  it('happy path: reads session, calls LLM, writes each valid memory via the tool', async () => {
    const { deps, callTool, llmCall } = makeDeps({
      llmText: JSON.stringify({ memories: [goodEntry] }),
    })
    const out = await consolidateMemory(deps, 's1')

    expect(llmCall).toHaveBeenCalledTimes(1)
    // the LLM saw the transcript as a user message, no tools offered
    const llmArgs = llmCall.mock.calls[0]![0] as {
      tools: unknown[]
      messages: Message[]
      systemPrompt: string
    }
    expect(llmArgs.tools).toEqual([])
    expect(llmArgs.systemPrompt).toContain('memory consolidation')

    // one write per valid entry, through the memory tool
    expect(callTool).toHaveBeenCalledTimes(1)
    const [, effect] = callTool.mock.calls[0]! as [string, { name: string; input: Record<string, unknown> }]
    expect(effect.name).toBe('memory')
    expect(effect.input).toMatchObject({
      operation: 'write',
      scope: 'workspace',
      key: 'user-prefers-concise',
    })
    expect(String(effect.input.content)).toContain('Keep answers short.')

    expect(out).toEqual({ saved: ['user-prefers-concise'], skipped: 0 })
  })

  it('propagates an LLM error as an outcome error', async () => {
    const { deps, callTool } = makeDeps({ llmThrows: new Error('llm exploded') })
    const out = await consolidateMemory(deps, 's1')
    expect(out).toEqual({ saved: [], skipped: 0, error: 'llm exploded' })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('reports a parse failure from malformed LLM output', async () => {
    const { deps, callTool } = makeDeps({ llmText: 'this is not json' })
    const out = await consolidateMemory(deps, 's1')
    expect(out.saved).toEqual([])
    expect(out.error).toBe('consolidator returned invalid JSON')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rejects invalid candidates on validation and saves none', async () => {
    const bad = { name: 'BAD NAME!!', type: 'nonsense', description: '', content: '' }
    const { deps, callTool } = makeDeps({ llmText: JSON.stringify({ memories: [bad] }) })
    const out = await consolidateMemory(deps, 's1')
    expect(out.saved).toEqual([])
    expect(out.skipped).toBe(1)
    expect(out.reason).toBe('all candidates rejected on validation')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('counts a per-entry write failure as skipped, not saved', async () => {
    const { deps } = makeDeps({
      llmText: JSON.stringify({ memories: [goodEntry] }),
      callTool: async () => ({ ok: false, content: 'disk full' }),
    })
    const out = await consolidateMemory(deps, 's1')
    expect(out.saved).toEqual([])
    expect(out.skipped).toBe(1)
  })

  it('stops on an indeterminate Executor write instead of dispatching later candidates', async () => {
    const { deps, callTool } = makeDeps({
      llmText: JSON.stringify({ memories: [goodEntry, { ...goodEntry, name: 'another-memory' }] }),
      callTool: async () => ({ ok: false, content: 'ack timed out; outcome unknown',
        failure: { code: 'tool_ack_timeout', category: 'infrastructure', outcome: 'indeterminate' } }),
    })
    const out = await consolidateMemory(deps, 's1')
    expect(out).toMatchObject({ saved: [], skipped: 0,
      error: expect.stringContaining('memory write outcome unknown') })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('stops after a rejected ownership-fenced memory dispatch instead of attempting more writes', async () => {
    const { deps, callTool } = makeDeps({
      llmText: JSON.stringify({ memories: [goodEntry, { ...goodEntry, name: 'another-memory' }] }),
      callTool: async () => { throw new Error('owner generation fenced') },
    })
    const out = await consolidateMemory(deps, 's1')
    expect(out).toMatchObject({ saved: [], skipped: 0, error: 'owner generation fenced' })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('does not even extract candidates on owner-fenced Runtimes without final-effect fencing', async () => {
    const { deps, callTool, llmCall } = makeDeps({
      llmText: JSON.stringify({ memories: [goodEntry] }),
    })
    deps.assertSessionEffectOwner = async () => ({ ownerGeneration: 'generation-1' })
    const out = await consolidateMemory(deps, 's1')
    expect(out).toMatchObject({
      saved: [],
      error: expect.stringContaining('final-effect fencing'),
    })
    expect(llmCall).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('consolidates on a bound shared-owner Executor only with the durable generic memory barrier', async () => {
      const { deps, callTool, llmCall } = makeDeps({
        llmText: JSON.stringify({ memories: [goodEntry] }),
      })
      const record = deps.store.get('s1')!
      Object.assign(record, { workspaceId: 'owner-workspace' })
      record.state = { ...record.state, cwd: '/remote/workspace' }
      deps.assertSessionEffectOwner = async () => ({ ownerGeneration: '9' })
      deps.requireMemoryEffectBarrier = true
      const outcome = await consolidateMemory(deps, 's1')
      expect(outcome).toEqual({ saved: ['user-prefers-concise'], skipped: 0 })
      expect(llmCall).toHaveBeenCalledOnce()
      expect(callTool).toHaveBeenCalledWith('s1', expect.objectContaining({
        name: 'memory', cwd: '/remote/workspace',
        input: expect.objectContaining({ scope: 'workspace', operation: 'write' }),
      }))
  })

  it('consolidates into the bound Executor workspace when no shared-owner fence is required', async () => {
    const { deps, callTool, llmCall } = makeDeps({
      llmText: JSON.stringify({ memories: [goodEntry] }),
    })
    const record = deps.store.get('s1')!
    Object.assign(record, { workspaceId: 'executor-workspace' })
    record.state = { ...record.state, cwd: '/remote/workspace' }
    const out = await consolidateMemory(deps, 's1')
    expect(out.saved).toEqual(['user-prefers-concise'])
    expect(llmCall).toHaveBeenCalledOnce()
    expect(callTool).toHaveBeenCalledWith('s1', expect.objectContaining({
      name: 'memory', cwd: '/remote/workspace',
      input: expect.objectContaining({ scope: 'workspace', operation: 'write' }),
    }))
  })

  it('rejects Executor-bound consolidation with no session cwd before calling the model', async () => {
    const { deps, callTool, llmCall } = makeDeps()
    Object.assign(deps.store.get('s1')!, { workspaceId: 'executor-workspace' })
    expect((await consolidateMemory(deps, 's1')).error).toContain('requires a session cwd')
    expect(llmCall).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('does not write candidates after ownership changes during the LLM call', async () => {
    const { deps, callTool } = makeDeps({ llmText: JSON.stringify({ memories: [goodEntry] }) })
    let active = true
    deps.captureSessionEffectOwner = () => () => active
    const originalCall = deps.llm.call
    deps.llm.call = async (...args) => {
      const response = await originalCall(...args)
      active = false
      return response
    }
    const out = await consolidateMemory(deps, 's1')
    expect(out.error).toContain('ownership changed')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('honors maxPerRun by writing at most N memories', async () => {
    const entries = [
      { ...goodEntry, name: 'one' },
      { ...goodEntry, name: 'two' },
      { ...goodEntry, name: 'three' },
      { ...goodEntry, name: 'four' },
    ]
    const { deps, callTool } = makeDeps({ llmText: JSON.stringify({ memories: entries }) })
    const config: ConsolidationConfig = { ...DEFAULT_CONSOLIDATION_CONFIG, maxPerRun: 2 }
    const out = await consolidateMemory(deps, 's1', config)
    expect(out.saved).toHaveLength(2)
    expect(callTool).toHaveBeenCalledTimes(2)
  })
})
