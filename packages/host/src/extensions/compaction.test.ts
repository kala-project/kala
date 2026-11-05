/**
 * Tests for the compaction extension's robustness paths — the ones the
 * doc calls out as must-be-observable-and-bounded: circuit breaker,
 * PTL retry ladder, empty-summary rejection, reducer-rejection detection,
 * tool_result batch back-off, unknown-context fallback, and preflight
 * emergency truncation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig, Message } from '@agent-kernel/kernel'

import { SessionStore } from '../store/session.js'
import { readSessionLog } from '../store/log.js'
import { runHostLoop } from '../loop.js'
import type { LoopBroadcast, ToolDispatcher } from '../loop.js'
import type { LLMAdapter, LLMCallParams } from '../llm/adapter.js'
import { SUMMARY_PREFIX, resetCompactRuntime } from './compaction.js'

function silentBroadcast(): LoopBroadcast {
  return { onEvent() {}, onApprovalRequired() {}, onError() {} }
}

function nullTools(overrides: Partial<ToolDispatcher> = {}): ToolDispatcher {
  return {
    callTool: async () => ({ ok: true, content: 'ok' }),
    cancelPending: () => {},
    ...overrides,
  }
}

const READ = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

type CompactionMetadata = {
  action: string
  payload: Record<string, unknown>
}

async function readSkipEvents(logPath: string): Promise<CompactionMetadata[]> {
  const parsed = await readSessionLog(logPath)
  return parsed.runtimeMetadata.filter((e) => e.action === 'compaction_skipped')
}

async function readReplacedEvents(logPath: string) {
  const parsed = await readSessionLog(logPath)
  return parsed.events
    .filter((e) => e.event.kind === 'messages_replaced' && e.event.reason === 'compaction')
    .map((e) => e.event)
}

async function readRejectedEvents(logPath: string): Promise<CompactionMetadata[]> {
  const parsed = await readSessionLog(logPath)
  return parsed.runtimeMetadata.filter((e) => e.action === 'compaction_rejected')
}

/** A summary that passes validateCompactionSummary and the new quality gates
 * (min length, non-conversational, template-shaped). Length is deliberately
 * padded above MIN_SUMMARY_CHARS so tests exercise the happy path. */
const OK_SUMMARY = `# Compacted Context
## User Intent And Constraints
- User wants the thing done exactly as specified in prior turns.
- No approvals required for read-only tools.

## Repository And Runtime State
- cwd: /workspace/example
- Active files: src/index.ts, src/lib/foo.ts
- Model: claude-opus / provider: anthropic

## Decisions And Rationale
- Chose approach A over B because B breaks the streaming contract.
- Kept existing message shape to avoid a kernel migration.

## Work Completed
- Edited src/index.ts (added feature flag)
- Ran pnpm test -- --run: 42 passed, 0 failed
- Verified behavior end-to-end via scripts/verify.mjs

## Open Work
- 1. Wire the feature flag into the dashboard prefs UI
- 2. Add regression test for the empty-list path
- Blockers: (none)

## Preserved Verbatim
- User: "keep the existing wire protocol untouched"`

function summaryReply(text: string = OK_SUMMARY, extra: Record<string, unknown> = {}) {
  return {
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    usage: { inputTokens: 5, outputTokens: 5 },
    ...extra,
  }
}

function turnReply(text: string = 'ok') {
  return {
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    usage: { inputTokens: 5, outputTokens: 1 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('compaction extension', () => {
  let dir: string
  let store: SessionStore
  let config: AgentConfig
  let sessionId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-compact-'))
    store = new SessionStore(dir)
    config = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const rec = await store.create({ config, sessionId: 'sess-1' })
    sessionId = rec.sessionId
    resetCompactRuntime(sessionId)
  })

  afterEach(() => {
    resetCompactRuntime(sessionId)
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['auto', 'preflight'] as const)('durably prunes stale tool results for %s compaction without invoking a summarizer', async (trigger) => {
    const configWithLimit = createConfig({
      tools: [READ],
      systemPrompt: 'sys',
      contextLimit: 12_000,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    })
    const record = await store.create({ config: configWithLimit, sessionId: 'sess-prune' })
    const turns: Message[] = Array.from({ length: 8 }, (_, index) => {
      const callId = `call-${index}`
      return [
        { role: 'assistant' as const, content: [{ type: 'tool_call' as const, callId, name: 'read', input: { path: 'log' } }] },
        { role: 'tool' as const, content: [{ type: 'tool_result' as const, callId, ok: true, content: index < 2 ? `HEAD${'x'.repeat(18_000)}TAIL` : `recent-${index}` }] },
      ]
    }).flat()
    let summarizerCalls = 0
    const loop = runHostLoop({
      store,
      llm: {
        name: 'prune-mock',
        async call() {
          summarizerCalls++
          throw new Error('summarizer must not run')
        },
      },
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(record.sessionId, {
      kind: 'messages_replaced',
      reason: 'manual_rewrite',
      replaceRange: { start: 0, end: record.state.messages.length },
      replacementMessages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'inspect log' }] }, ...turns],
    })
    expect(await loop.compact(record.sessionId, { trigger, continuation: 'stay_resting' })).toBe(true)
    expect(summarizerCalls).toBe(0)
    const replaced = await readReplacedEvents(record.logPath)
    expect(replaced).toHaveLength(1)
    const persisted = await readSessionLog(record.logPath)
    expect(persisted.runtimeMetadata.some((entry) => entry.action === 'preemptive_pruning_applied')).toBe(true)
    const replay = await new SessionStore(dir).load(record.sessionId)
    const result = replay!.state.messages[3]!.content[0]!
    expect(result.type).toBe('tool_result')
    if (result.type === 'tool_result') expect(result.content).toContain('[pruned tool_result:')
    expect(replay!.state.messages.at(-1)!.content[0]).toEqual(turns.at(-1)!.content[0])
  })

  it('summarizer failures increment the counter; three non-manual failures open the breaker', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'fail-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        throw new Error('summarizer boom')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    // Three failed auto triggers (each is a no-op on error, not a throw).
    for (let i = 0; i < 3; i++) await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })

    // 4th auto trigger must be short-circuited by the breaker.
    await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })

    const rec = store.get(sessionId)!
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.filter((s) => s.payload.reason === 'summarizer_failed').length).toBe(3)
    expect(skips.filter((s) => s.payload.reason === 'circuit_breaker_open').length).toBeGreaterThanOrEqual(1)
  })

  it('allows one automatic half-open probe after the transcript cursor advances', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'half-open-mock',
      async call(params) {
        call += 1
        if (call === 1) return turnReply()
        if (call <= 4) throw new Error('temporary summarizer outage')
        if (params.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) return summaryReply()
        return turnReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    for (let i = 0; i < 3; i++) await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })
    await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })
    const skipsBefore = await readSkipEvents(store.get(sessionId)!.logPath)
    expect(skipsBefore.some((entry) => entry.payload.reason === 'circuit_breaker_open')).toBe(true)

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'new generation' })
    const applied = await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })
    expect(applied).toBe(true)
    expect((await readReplacedEvents(store.get(sessionId)!.logPath).then((events) => events.length))).toBeGreaterThan(0)
  })

  it('manual bypasses the open breaker and success closes it', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'recover-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        // Fail the first three summarizer calls, then succeed on any later call.
        if (call <= 4) throw new Error('boom')
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    // Open the breaker with 3 auto failures.
    for (let i = 0; i < 3; i++) await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })

    // Confirm auto now short-circuits.
    await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })
    let rec = store.get(sessionId)!
    let skips = await readSkipEvents(rec.logPath)
    expect(skips.some((s) => s.payload.reason === 'circuit_breaker_open')).toBe(true)

    // Manual: bypasses the breaker; keep trying manual until one succeeds.
    // (Whether an individual failing manual throws or is skipped is
    // implementation detail; we only need one successful messages_replaced.)
    for (let i = 0; i < 5; i++) {
      try {
        await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })
      } catch {
        // fall through
      }
      const replaced = await readReplacedEvents(store.get(sessionId)!.logPath)
      if (replaced.length > 0) break
    }
    const replaced = await readReplacedEvents(store.get(sessionId)!.logPath)
    expect(replaced.length).toBeGreaterThanOrEqual(1)

    // Auto should no longer short-circuit with circuit_breaker_open.
    rec = store.get(sessionId)!
    const skipsBefore = (await readSkipEvents(rec.logPath)).length
    await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })
    skips = await readSkipEvents(rec.logPath)
    const newSkips = skips.slice(skipsBefore)
    expect(newSkips.every((s) => s.payload.reason !== 'circuit_breaker_open')).toBe(true)
  })

  it('empty summary is rejected: no messages_replaced, empty_summary metadata emitted', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'empty-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: '   \n  ' }] },
          usage: { inputTokens: 5, outputTokens: 0 },
        }
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    const before = store.get(sessionId)!.state.messages.length

    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow(/empty/i)

    const rec = store.get(sessionId)!
    expect(rec.state.messages.length).toBe(before)
    expect(await readReplacedEvents(rec.logPath)).toHaveLength(0)
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.some((s) => s.payload.reason === 'empty_summary')).toBe(true)
  })

  it('rejects a summary if the session advances while the summarizer is in flight', async () => {
    const summary = deferred<ReturnType<typeof summaryReply>>()
    let call = 0
    const llm: LLMAdapter = {
      name: 'stale-summary-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summary.promise
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'first turn' })

    const compacting = loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })
    await Promise.resolve()
    await loop.dispatch(sessionId, { kind: 'approval_mode_changed', mode: 'full' })
    summary.resolve(summaryReply())
    await compacting

    const record = store.get(sessionId)!
    expect(await readReplacedEvents(record.logPath)).toHaveLength(0)
    const rejected = await readRejectedEvents(record.logPath)
    expect(rejected).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ reason: 'session_changed' }),
    }))
    expect(record.state.messages.some((message) =>
      message.content.some((content) => content.type === 'text' && content.text === 'first turn'),
    )).toBe(true)
  })

  it('manual compact on empty session emits nothing_to_compact throw', async () => {
    const llm: LLMAdapter = {
      name: 'unused',
      async call() {
        throw new Error('should not be called')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow(/nothing to compact/i)
  })

  it('manual compact can re-compact a prior compact summary', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'recompact-summary-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        if (call === 2) return summaryReply(`${OK_SUMMARY}\n\nFirst pass.`)
        return summaryReply(`${OK_SUMMARY}\n\nSecond pass.`)
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    // After the first compaction: leading system + anchored summary as a user
    // message + preserved recent user tail ("hi"). Codex-style: summary lands
    // as a user message prefixed with SUMMARY_PREFIX rather than a system
    // message, and raw recent user turns survive verbatim.
    let rec = store.get(sessionId)!
    expect(rec.state.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect((rec.state.messages[1]?.content[0] as { text: string }).text)
      .toContain(`${SUMMARY_PREFIX}\n\n${OK_SUMMARY}\n\nFirst pass.`)
    expect((rec.state.messages[1]?.content[0] as { text: string }).text)
      .toContain(`"sessionId": "${sessionId}"`)
    expect(rec.state.messages[2]?.content).toEqual([{ type: 'text', text: 'hi' }])

    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    // Second compaction updates the anchored summary in place. Shape and tail
    // are unchanged; only the summary body changes.
    rec = store.get(sessionId)!
    expect(rec.state.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect((rec.state.messages[1]?.content[0] as { text: string }).text)
      .toContain(`${SUMMARY_PREFIX}\n\n${OK_SUMMARY}\n\nSecond pass.`)
    expect((rec.state.messages[1]?.content[0] as { text: string }).text)
      .toContain(`"sessionId": "${sessionId}"`)
    expect(rec.state.messages[2]?.content).toEqual([{ type: 'text', text: 'hi' }])
    const replaced = await readReplacedEvents(rec.logPath)
    expect(replaced).toHaveLength(2)
    expect(replaced[1]?.replaceRange).toEqual({ start: 1, end: 2 })
  })

  it('does not treat an anchored summary as the recent-tail pivot when new history is huge', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'summary-plus-huge-tail-mock',
      async call() {
        call += 1
        if (call === 1) return summaryReply(`${OK_SUMMARY}\n\nUpdated huge-tail pass.`)
        return turnReply('ok')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    const rec = store.get(sessionId)!
    const hugeText = '0123456789abcdef'.repeat(2_000)

    rec.state = {
      ...rec.state,
      status: 'done',
      messages: [
        rec.state.messages[0]!,
        { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}\n\n${OK_SUMMARY}\n\nPrevious pass.` }] },
        { role: 'user', content: [{ type: 'text', text: 'old post-summary task' }] },
        { role: 'assistant', content: [{ type: 'text', text: hugeText }] },
        { role: 'user', content: [{ type: 'text', text: 'newest post-summary task' }] },
        { role: 'assistant', content: [{ type: 'text', text: hugeText }] },
      ],
    }

    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const parsed = await readSessionLog(rec.logPath)
    const replaced = parsed.events.find((e) => e.event.kind === 'messages_replaced')?.event
    expect(replaced?.replaceRange).toEqual({ start: 1, end: 4 })
    expect(replaced?.replacementMessages).toHaveLength(2)
    expect(replaced?.resume).toBeUndefined()
    expect(store.get(sessionId)!.state.messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'user', 'assistant'])
    const meta = parsed.runtimeMetadata.find((entry) => entry.action === 'compaction_applied')
    expect(meta?.payload.previousSummaryChars).toBeGreaterThan(0)
    expect(meta?.payload.recentRawUsersCount).toBe(1)
  })

  it('successful compaction writes a cmp_ attemptId in runtime metadata', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'attempt-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const rec = store.get(sessionId)!
    const parsed = await readSessionLog(rec.logPath)
    const meta = parsed.runtimeMetadata.find((entry) => entry.action === 'compaction_applied')
    expect(meta?.payload.attemptId).toMatch(/^cmp_/)
  })

  it('messages_replaced persists the summarizer LLM trace and model', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'trace-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply(OK_SUMMARY, {
          trace: {
            provider: 'openai',
            model: 'gpt-compact-test',
            request: {
              url: 'https://api.openai.com/v1/chat/completions',
              headers: { authorization: 'Bearer test' },
              body: { model: 'gpt-compact-test', messages: [{ role: 'user', content: 'compact' }] },
            },
            response: { status: 200, metrics: { durationMs: 1234, timeToFirstChunkMs: 210 } },
          },
        })
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const compactEntry = parsed.events.find((e) => e.event.kind === 'messages_replaced')
    expect(compactEntry?.llmTraceArtifact?.path).toContain('llm-traces')
    expect(compactEntry?.model).toBe('gpt-compact-test')
  })

  it('summarizer path passes thinkingBudget: 0 to disable extended thinking', async () => {
    let call = 0
    const seen: LLMCallParams[] = []
    const llm: LLMAdapter = {
      name: 'thinking-mock',
      async call(p) {
        call += 1
        seen.push(p)
        if (call === 1) return turnReply()
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    // Second call is the summarizer.
    expect(seen[1]!.thinkingBudget).toBe(0)
  })

  it('PTL retry ladder progresses through rungs and eventually succeeds', async () => {
    // Simulate 2 successive PTL errors, then success. This should exhaust
    // rungs 1 & 2 (progressively tighter tool-result caps) and land on rung 3
    // (head-drop 1). Third summarizer call succeeds.
    let call = 0
    const llm: LLMAdapter = {
      name: 'ptl-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        // Summarizer calls (call 2, 3, ...): first two throw PTL, third OK.
        if (call === 2 || call === 3) throw new Error('prompt is too long for this model')
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' }) // must NOT throw despite 2 PTL failures

    expect(call).toBeGreaterThanOrEqual(4) // 1 turn + at least 3 summarizer attempts
    const rec = store.get(sessionId)!
    const replaced = await readReplacedEvents(rec.logPath)
    expect(replaced).toHaveLength(1)
  })

  it('PTL ladder exhaustion counts as one failure (not one per rung)', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'ptl-exhaust-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        throw new Error('input exceeds model context window')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })

    // One skip event, not one per rung. All ladder attempts are made, but the
    // failure counter gets a single increment.
    const rec = store.get(sessionId)!
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.filter((s) => s.payload.reason === 'summarizer_failed')).toHaveLength(1)
    expect(call).toBeGreaterThan(5)
  })

  it('summarizer prompt preserves language and opaque identifiers while redacting secrets', async () => {
    let call = 0
    const seen: LLMCallParams[] = []
    const llm: LLMAdapter = {
      name: 'prompt-guard-mock',
      async call(p) {
        call += 1
        seen.push(p)
        if (call === 1) return turnReply()
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const prompt = seen[1]!.systemPrompt ?? ''
    expect(prompt).toContain('Preserve opaque identifiers exactly as written')
    expect(prompt).toContain('primary language used by the conversation')
    expect(prompt).toContain('redact the secret value')
  })

  it('budget-plans oversized summarizer input before calling the provider', async () => {
    const seen: LLMCallParams[] = []
    const llm: LLMAdapter = {
      name: 'budget-plan-mock',
      async call(p) {
        seen.push(p)
        return summaryReply()
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: {
        get: () => 'tiny-context-model',
        contextWindow: () => 16_000,
      },
    })
    const rec = store.get(sessionId)!
    rec.config = { ...rec.config, contextLimit: 16_000 }
    rec.state = {
      ...rec.state,
      status: 'done',
      messages: [
        rec.state.messages[0]!,
        { role: 'user', content: [{ type: 'text', text: `old ${'a'.repeat(70_000)}` }] },
        { role: 'assistant', content: [{ type: 'text', text: `old answer ${'b'.repeat(70_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: 'new request' }] },
      ],
    }

    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const summarizerInput = seen[0]!.messages[0]!.content[0]
    expect(summarizerInput.type).toBe('text')
    expect(summarizerInput.text.length).toBeLessThan(80_000)
    expect(summarizerInput.text).toContain('chars omitted from old text before compaction')
    expect(store.get(sessionId)!.state.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
  })

  it('does not preserve a single oversized raw user turn after compaction', async () => {
    const llm: LLMAdapter = {
      name: 'oversized-user-tail-mock',
      async call() {
        return summaryReply()
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: {
        get: () => 'normal-context-model',
        contextWindow: () => 128_000,
      },
    })
    const rec = store.get(sessionId)!
    rec.config = { ...rec.config, contextLimit: 128_000 }
    rec.state = {
      ...rec.state,
      status: 'done',
      messages: [
        rec.state.messages[0]!,
        { role: 'user', content: [{ type: 'text', text: `huge old request ${'a'.repeat(120_000)}` }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'small latest request' }] },
      ],
    }

    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const messages = store.get(sessionId)!.state.messages
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect((messages[1]!.content[0] as { text: string }).text).toContain(SUMMARY_PREFIX)
    expect((messages[2]!.content[0] as { text: string }).text).toBe('small latest request')
    expect(JSON.stringify(messages)).not.toContain('huge old request')
  })

  it('rejects compaction that still leaves the session over the post-compact budget', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'post-budget-mock',
      async call() {
        call += 1
        return summaryReply()
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: {
        get: () => 'tiny-context-model',
        contextWindow: () => 16_000,
      },
    })
    const rec = store.get(sessionId)!
    rec.config = { ...rec.config, contextLimit: 16_000 }
    rec.state = {
      ...rec.state,
      status: 'done',
      messages: [
        rec.state.messages[0]!,
        { role: 'user', content: [{ type: 'text', text: 'old task' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'new request' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(80_000) }] },
      ],
    }

    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow(/post_compaction_still_over_budget/)

    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events.some((e) => e.event.kind === 'messages_replaced')).toBe(false)
    expect(parsed.runtimeMetadata.some((e) => e.action === 'compaction_rejected' && e.payload.reason === 'post_compaction_still_over_budget')).toBe(true)
  })

  it('non-PTL error bubbles out of the ladder without retrying', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'non-ptl-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        throw new Error('rate limit hit')
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    await loop.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })

    // Only one summarizer call was made because the error was non-PTL.
    expect(call).toBe(2)
  })

  it('rejects a conversational reply masquerading as a summary (root cause of the box regression)', async () => {
    // This is exactly the shape observed in box session dcc5879b… seq 1488:
    // the summarizer replied to the user with a question instead of writing
    // a handoff. Before this fix, that reply was accepted and overwrote 300
    // messages with a two-sentence chat turn.
    const badReply = '你上一条只说了 "Please continue"，没指方向。你要哪个？'
    let call = 0
    const llm: LLMAdapter = {
      name: 'conversational-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply(badReply)
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    const before = store.get(sessionId)!.state.messages.length

    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow(/invalid handoff/i)

    const rec = store.get(sessionId)!
    // No messages were replaced.
    expect(rec.state.messages.length).toBe(before)
    expect(await readReplacedEvents(rec.logPath)).toHaveLength(0)
    // The skip metadata carries a specific reason so we can alert on it.
    const skips = await readSkipEvents(rec.logPath)
    const reasons = skips.map((s) => s.payload.reason)
    expect(
      reasons.some(
        (r) =>
          r === 'summary_conversational'
          || r === 'summary_too_short'
          || r === 'summary_schema_invalid',
      ),
    ).toBe(true)
  })

  it('rejects a summary with all required sections missing (schema gate)', async () => {
    const missingSections = 'This is a moderately long reply that has no template headings whatsoever and is definitely not a handoff summary. It just keeps going for a while so the length gate does not catch it first. Padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding.'
    let call = 0
    const llm: LLMAdapter = {
      name: 'schema-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply(missingSections)
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    const before = store.get(sessionId)!.state.messages.length

    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow(/invalid handoff/i)

    const rec = store.get(sessionId)!
    expect(rec.state.messages.length).toBe(before)
    expect(await readReplacedEvents(rec.logPath)).toHaveLength(0)
    const skips = await readSkipEvents(rec.logPath)
    expect(skips.some((s) => s.payload.reason === 'summary_schema_invalid')).toBe(true)
  })

  it('applied metadata records compressionRatio and recentRawUsersCount', async () => {
    let call = 0
    const llm: LLMAdapter = {
      name: 'metadata-mock',
      async call() {
        call += 1
        if (call === 1) return turnReply()
        return summaryReply()
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const rec = store.get(sessionId)!
    const parsed = await readSessionLog(rec.logPath)
    const meta = parsed.runtimeMetadata.find((entry) => entry.action === 'compaction_applied')
    expect(meta?.payload).toMatchObject({
      trigger: 'manual',
      previousSummaryChars: 0,
    })
    expect(typeof meta?.payload.compressionRatio).toBe('number')
    expect(typeof meta?.payload.recentRawUsersCount).toBe('number')
  })
})
