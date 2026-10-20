import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import type { AgentConfig, AgentState } from '@agent-kernel/kernel'

import { SessionStore } from './store/session.js'
import { readSessionLog } from './store/log.js'
import { runHostLoop, withCurrentToolIntentionInstruction } from './loop.js'
import type {
  LoopBroadcast,
  SubAgentFinishedPayload,
  SubAgentStartedPayload,
  ToolDispatcher,
} from './loop.js'
import type { LLMAdapter, LLMResponse } from './llm/adapter.js'
import { createSkillManager, discoverSkills } from './extensions/skills.js'
import { createBuiltinExtensionRegistry } from './extensions/builtin-registry.js'
import { contextSnapshot } from './context/manager.js'
import { shouldCompactContext } from '@agent-kernel/shared/context-policy'
import { estimateStringTokens } from '@agent-kernel/shared/token-estimation'
import { SUMMARY_PREFIX } from './extensions/compaction.js'

/**
 * Well-formed summary body that clears validateCompactionSummary + the quality
 * gates (schema, min length, non-conversational). Kept in one place so
 * loop.test.ts summarizer mocks don't diverge from real prompt shape.
 */
describe('current Tool Intention instruction assembly', () => {
  it('injects the current instruction into legacy Session messages without rewriting history', () => {
    const legacy = [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'legacy prompt' }] }]
    const assembled = withCurrentToolIntentionInstruction(legacy)
    expect(assembled).toHaveLength(1)
    expect(assembled[0]?.role).toBe('system')
    expect(assembled[0]?.content[0]).toEqual({ type: 'text', text: 'legacy prompt' })
    expect(assembled[0]?.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('include the required _intent argument') })
  })

  it('is idempotent for current Session prompts', () => {
    const legacy = [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'legacy prompt' }] }]
    const once = withCurrentToolIntentionInstruction(legacy)
    expect(withCurrentToolIntentionInstruction(once)).toBe(once)
  })
})

const OK_SUMMARY_BODY = `# Compacted Context
## User Intent And Constraints
- User wants the requested change made without touching unrelated modules.

## Repository And Runtime State
- cwd: /workspace/test
- Files of interest: src/index.ts, packages/host/src/loop.ts
- Model + provider recorded in prior turns still apply.

## Decisions And Rationale
- Preserved the existing wire protocol; considered v2 shape and rejected it
  because callers depend on the current field names.

## Work Completed
- Edited target files as agreed.
- Ran pnpm test -- --run in the affected package: passing.

## Open Work
- 1. Wire the change into the dashboard when the user asks for it.
- 2. Backfill migration notes.
- Blockers: (none)

## Preserved Verbatim
- User: "keep the existing wire protocol untouched"`


function silentBroadcast(): LoopBroadcast {
  return {
    onEvent() {},
    onApprovalRequired() {},
    onError() {},
  }
}

function nullTools(overrides: Partial<ToolDispatcher> = {}): ToolDispatcher {
  return {
    callTool: async () => ({ ok: true, content: 'ok' }),
    cancelPending: () => {},
    ...overrides,
  }
}

function scriptedLlm(responses: LLMResponse[]): LLMAdapter {
  let i = 0
  return {
    name: 'scripted',
    async call() {
      const r = responses[i++]
      if (!r) throw new Error('scriptedLlm exhausted')
      return r
    },
  }
}

describe('Kernel Loop runtime ownership', () => {
  it('fails closed without appending events to a Copilot Session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-loop-ownership-'))
    try {
      const store = new SessionStore(dir)
      const record = await store.create({
        sessionId: 'copilot-owned-session',
        agentRuntime: 'copilot',
        config: createConfig({ tools: [] }),
      })
      const loop = runHostLoop({
        store,
        llm: scriptedLlm([]),
        tools: nullTools(),
        broadcast: silentBroadcast(),
      })

      await expect(loop.dispatch(record.sessionId, {
        kind: 'user_message',
        text: 'must not enter Kernel',
      })).rejects.toThrow('Kernel Loop cannot mutate copilot session')
      expect((await readSessionLog(record.logPath, { allowExternalRuntime: true })).events).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const READ = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

const READ_FILE = {
  ...READ,
  name: 'read_file',
} as const

const AGENT = {
  name: 'agent',
  description: 'spawn agent',
  inputSchema: { type: 'object' },
  requiresApproval: false,
  executionKind: 'host',
  executionHandler: 'agent',
} as const

const SKILL = {
  name: 'skill',
  description: 'skill loader',
  inputSchema: { type: 'object' },
  requiresApproval: false,
  executionKind: 'host',
  executionHandler: 'skill',
} as const

const MEMORY = {
  name: 'memory',
  description: 'memory',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

describe('host loop', () => {
  let dir: string
  let store: SessionStore
  let config: AgentConfig
  let sessionId: string
  let state: AgentState

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kala-host-'))
    store = new SessionStore(dir)
    config = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const record = await store.create({ config, sessionId: 'sess-1' })
    sessionId = record.sessionId
    state = record.state
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not call the model if the Session owner gate rejects before a turn effect', async () => {
    const call = vi.fn(async () => ({ message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'unsafe' }] } }))
    const gate = vi.fn(async () => { throw new Error('Session owner lost') })
    const loop = runHostLoop({ store, llm: { name: 'owner-gate', call }, tools: nullTools(),
      assertSessionEffectOwner: gate, broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'start' })
    expect(gate).toHaveBeenCalledWith(sessionId)
    expect(call).not.toHaveBeenCalled()
  })

  it('does not dispatch a Tool or a second model call after losing the Session owner', async () => {
    const call = vi.fn(async () => ({ message: {
      role: 'assistant' as const,
      content: [{ type: 'tool_call' as const, callId: 'c1', name: 'read', input: { path: '/tmp/x' } }],
    } }))
    const callTool = vi.fn(async () => ({ ok: true, content: 'unsafe' }))
    let checks = 0
    const gate = vi.fn(async () => { if (++checks > 2) throw new Error('Session owner lost') })
    const loop = runHostLoop({ store, llm: { name: 'owner-gate', call }, tools: nullTools({ callTool }),
      assertSessionEffectOwner: gate, broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'use tool' })
    expect(call).toHaveBeenCalledTimes(1)
    expect(callTool).not.toHaveBeenCalled()
    expect(gate).toHaveBeenCalledTimes(4)
  })

  it('preserves core state timing around extension lifecycle callbacks', async () => {
    const calls: string[] = []
    const extensions = createBuiltinExtensionRegistry([{
      id: 'test.lifecycle-order',
      version: '1',
      lifecycle: {
        beforeTurn({ event }) {
          calls.push(`before-turn:${event.kind}:${store.get(sessionId)?.state.status}`)
        },
        beforeStateTransition({ event, record }) {
          calls.push(`before-transition:${event.kind}:${record.state.status}`)
        },
        beforeModelCall() {
          calls.push(`before-model:${store.get(sessionId)?.state.status}`)
        },
        afterModelCall() {
          calls.push(`after-model:${store.get(sessionId)?.state.status}`)
        },
        afterTurn({ event }) {
          calls.push(`after-turn:${event.kind}:${store.get(sessionId)?.state.status}`)
        },
      },
    }])
    const loop = runHostLoop({
      store,
      extensions,
      llm: {
        name: 'lifecycle-order',
        async call() {
          calls.push(`model-call:${store.get(sessionId)?.state.status}`)
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
            finishReason: 'stop',
          }
        },
      },
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'run lifecycle' })

    expect(calls).toEqual([
      'before-turn:user_message:idle',
      'before-transition:user_message:idle',
      'before-model:thinking',
      'model-call:thinking',
      'after-model:thinking',
      'before-transition:llm_response:thinking',
      'after-turn:user_message:done',
    ])
  })

  it('resumes once when an LLM stops while durable todo_graph work remains', async () => {
    const graph = JSON.stringify({
      version: 1, revision: 1,
      nodes: [{ id: 'work', content: 'finish work', status: 'in_progress', priority: 'high' }],
      edges: [],
      summary: { total: 1, completed: 0, active: 1, ready: 0, blocked: 0, cancelled: 0 },
      ready: [], blocked: [], changed: ['work'],
    })
    let calls = 0
    const llm: LLMAdapter = {
      name: 'graph-resume',
      async call() {
        calls += 1
        if (calls === 1) return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'graph-1', name: 'todo_graph', input: { operations: [] } }] }, finishReason: 'tool_calls' }
        return { message: { role: 'assistant', content: [{ type: 'text', text: calls === 2 ? 'premature stop' : 'recovered once' }] }, finishReason: 'stop' }
      },
    }
    const graphConfig = createConfig({ tools: [{ name: 'todo_graph', description: 'graph', inputSchema: { type: 'object' }, requiresApproval: false }], systemPrompt: 'sys' })
    store.get(sessionId)!.config = graphConfig
    const loop = runHostLoop({
      store, llm,
      tools: nullTools({ callTool: async (_sid, effect) => effect.name === 'todo_graph' ? { ok: true, content: graph } : { ok: true, content: 'ok' } }),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'continue until graph is done' })
    expect(calls).toBe(3)
    expect(store.get(sessionId)!.state.status).toBe('done')
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toHaveLength(1)

    // A fresh Host may compact a resting Session, but unfinished durable graph
    // data alone is not permission to create a new Agent turn.
    let postCompactCalls = 0
    const afterRestart = runHostLoop({
      store,
      llm: {
        name: 'auto-compact-resume',
        async call(params) {
          postCompactCalls += 1
          if (params.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
            return { message: { role: 'assistant', content: [{ type: 'text', text: OK_SUMMARY_BODY }] }, usage: { inputTokens: 10, outputTokens: 10 } }
          }
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'continued after auto compact' }] }, finishReason: 'stop' }
        },
      },
      tools: nullTools(), broadcast: silentBroadcast(),
    })
    await expect(afterRestart.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })).resolves.toBe(true)
    expect(postCompactCalls).toBe(1)
    const afterCompact = await readSessionLog(store.get(sessionId)!.logPath)
    expect(afterCompact.events.at(-1)?.event).toMatchObject({ kind: 'messages_replaced', reason: 'compaction' })
    expect(afterCompact.events.filter((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toHaveLength(1)
    expect(store.get(sessionId)!.state.status).toBe('done')
  })

  it('explicit Stop suppresses durable todo graph auto-continuation until a new user message', async () => {
    const graph = JSON.stringify({
      version: 1, revision: 1,
      nodes: [{ id: 'work', content: 'finish work', status: 'in_progress', priority: 'high' }],
      edges: [], summary: { total: 1, completed: 0, active: 1, ready: 0, blocked: 0, cancelled: 0 }, ready: [], blocked: [], changed: ['work'],
    })
    let calls = 0
    let secondStarted!: () => void
    const secondCall = new Promise<void>((resolve) => { secondStarted = resolve })
    const llm: LLMAdapter = {
      name: 'stop-graph-continuation',
      async call(params) {
        calls += 1
        if (calls === 1) return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'graph-stop-1', name: 'todo_graph', input: { operations: [] } }] } }
        if (calls === 2) {
          secondStarted()
          await new Promise<void>((_resolve, reject) => params.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'new explicit turn' }] } }
      },
    }
    const graphConfig = createConfig({ tools: [{ name: 'todo_graph', description: 'graph', inputSchema: { type: 'object' }, requiresApproval: false }], systemPrompt: 'sys' })
    store.get(sessionId)!.config = graphConfig
    const loop = runHostLoop({ store, llm, tools: nullTools({ callTool: async () => ({ ok: true, content: graph }) }), broadcast: silentBroadcast() })
    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'work until stopped' })
    await secondCall
    await loop.dispatch(sessionId, { kind: 'cancel' })
    await turn
    expect(calls).toBe(2)
    expect(store.get(sessionId)!.state.status).toBe('done')
    const afterStop = await readSessionLog(store.get(sessionId)!.logPath)
    expect(afterStop.events.filter((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toHaveLength(0)

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'start again explicitly' })
    expect(calls).toBe(4)
  })

  it('does not dispatch a Tool from a provider response that arrives after Stop', async () => {
    let releaseLlm!: () => void
    let started!: () => void
    const llmStarted = new Promise<void>((resolve) => { started = resolve })
    const toolsCalled: string[] = []
    const llm: LLMAdapter = {
      name: 'late-tool-after-stop',
      async call() {
        started()
        await new Promise<void>((resolve) => { releaseLlm = resolve })
        return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'late-call', name: 'read', input: { path: '/tmp/x' } }] } }
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools({ callTool: async (_sid, effect) => { toolsCalled.push(effect.callId); return { ok: true, content: 'late' } } }), broadcast: silentBroadcast() })
    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'start' })
    await llmStarted
    await loop.dispatch(sessionId, { kind: 'cancel' })
    releaseLlm()
    await turn
    expect(toolsCalled).toEqual([])
    expect(store.get(sessionId)!.state.status).toBe('done')
  })

  it('discloses websearch on the first LLM call for explicit network research', async () => {
    const seenTools: string[][] = []
    const websearch = { name: 'websearch', description: 'Search the web', inputSchema: { type: 'object' }, requiresApproval: false, executionKind: 'host' as const, executionHandler: 'websearch' }
    const progressive = createConfig({ tools: [websearch], systemPrompt: 'sys', toolDisclosureMode: 'progressive' })
    store.get(sessionId)!.config = progressive
    const loop = runHostLoop({
      store,
      llm: { name: 'network-disclosure', async call(params) { seenTools.push(params.tools.map((tool) => tool.name)); return { message: { role: 'assistant', content: [{ type: 'text', text: 'ready to search' }] } } } },
      tools: nullTools(), broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: '请联网检索最新资料并给出可点击来源链接' })
    expect(seenTools).toEqual([['websearch']])
  })

  it('does not resume terminal replies without durable graph work', async () => {
    const llm = scriptedLlm([{ message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, finishReason: 'stop' }])
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'one answer' })
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toHaveLength(0)
  })

  it('runs a plain-answer turn to done and writes the log', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }],
        },
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    expect(rec.state.cursor).toBe(2)
    expect(rec.state.usage.inputTokens).toBe(5)

    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.header.sessionId).toBe(sessionId)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.events[0]?.event.kind).toBe('user_message')
    expect(parsed.events[1]?.event.kind).toBe('llm_response')
    void state
  })

  it('persists locally published assistant images as durable artifact URIs', async () => {
    const llm = scriptedLlm([{ message: { role: 'assistant', content: [{ type: 'text', text: 'Design:\n![preview](/tmp/design.png)' }] } }])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      publishLocalImages: async (_sessionId, _record, message) => ({
        ...message,
        content: message.content.map((part) => part.type === 'text' ? { ...part, text: part.text.replace('/tmp/design.png', 'artifact://published-image') } : part),
      }),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'show design' })
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const response = parsed.events.find((entry) => entry.event.kind === 'llm_response')
    expect(response?.event.kind).toBe('llm_response')
    if (response?.event.kind === 'llm_response') {
      expect(response.event.message.content).toContainEqual({ type: 'text', text: 'Design:\n![preview](artifact://published-image)' })
      expect(response.event.message.content.some((part) => part.type === 'text' && part.text.includes('/tmp/'))).toBe(false)
    }
    expect(store.get(sessionId)!.state.messages.at(-1)?.content).toEqual(response?.event.kind === 'llm_response' ? response.event.message.content : [])
  })

  it('records an empty assistant response without hidden retry messages', async () => {
    const calls: number[] = []
    const llm: LLMAdapter = {
      name: 'empty-once',
      async call(params) {
        calls.push(params.messages.length)
        return { message: { role: 'assistant', content: [] } }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'continue' })

    expect(calls).toEqual([2])
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    const last = rec.state.messages.at(-1)
    expect(last).toEqual({ role: 'assistant', content: [] })
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events.map((entry) => entry.event.kind)).toEqual(['user_message', 'llm_response'])
  })

  it('writes message assembly artifacts outside the replay log when configured', async () => {
    const artifactRootDir = join(dir, 'artifacts')
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'artifact captured' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      artifactRootDir,
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const artifact = JSON.parse(await readFile(
      join(artifactRootDir, 'message-assembly', sessionId, '1.json'),
      'utf8',
    ))
    const routerDecision = JSON.parse(await readFile(
      join(artifactRootDir, 'router-decisions', sessionId, '1.json'),
      'utf8',
    ))
    const toolCatalog = JSON.parse(await readFile(
      join(artifactRootDir, 'tool-catalog', sessionId, '1.json'),
      'utf8',
    ))
    expect(artifact.sessionId).toBe(sessionId)
    expect(artifact.messageCount).toBeGreaterThan(0)
    expect(artifact.toolCount).toBe(1)
    expect(artifact.parts.map((part: { name: string }) => part.name)).toContain('tools')
    expect(artifact.stages.map((stage: { name: string }) => stage.name)).toEqual([
      'kernel.messages',
      'tool.registry',
      'memory.contribution',
      'host.preflight',
      'provider.adapter',
    ])
    expect(artifact.stages.find((stage: { name: string }) => stage.name === 'tool.registry').estimatedTokens).toBeGreaterThan(0)
    expect(artifact.stages.find((stage: { name: string }) => stage.name === 'provider.adapter').reasonCodes[0]).toContain('adapter:')
    expect(routerDecision.reasonCodes).toContain('adapter_default_model')
    expect(routerDecision.reasonCodes).toContain('tool_calling_enabled')
    expect(routerDecision.toolPolicy).toMatchObject({ toolCount: 1, requiresApprovalCount: 0 })
    expect(toolCatalog.tools[0]).toMatchObject({ name: 'read', kind: 'executor', skillBacked: false })
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    expect(parsed.events).toHaveLength(2)
  })

  it('marks memory tool contribution in message assembly artifacts', async () => {
    const artifactRootDir = join(dir, 'artifacts')
    const memoryConfig = createConfig({ tools: [MEMORY], systemPrompt: 'sys' })
    const memoryRecord = await store.create({ config: memoryConfig, sessionId: 'sess-memory' })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', callId: 'mem-1', name: 'memory', input: { operation: 'read', scope: 'workspace', key: 'style' } }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'used memory' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({ callTool: async () => ({ ok: true, content: 'prefer compact answers' }) }),
      broadcast: silentBroadcast(),
      artifactRootDir,
    })

    await loop.dispatch(memoryRecord.sessionId, { kind: 'user_message', text: 'remember my style' })

    const artifact = JSON.parse(await readFile(
      join(artifactRootDir, 'message-assembly', memoryRecord.sessionId, '3.json'),
      'utf8',
    ))
    expect(artifact.parts.map((part: { name: string }) => part.name)).toContain('memory')
    const memoryPart = artifact.parts.find((part: { name: string }) => part.name === 'memory')
    expect(memoryPart.estimatedTokens).toBeGreaterThan(0)
    const memoryStage = artifact.stages.find((stage: { name: string }) => stage.name === 'memory.contribution')
    expect(memoryStage.reasonCodes).toContain('memory_tool_context_present')
    expect(memoryStage.estimatedTokens).toBeGreaterThan(0)
  })

  it('rejects workspace/global memory tool calls when memoryPolicy.mode is disabled', async () => {
    const memoryConfig = createConfig({ tools: [MEMORY], systemPrompt: 'sys' })
    const memoryRecord = await store.create({
      config: memoryConfig,
      sessionId: 'sess-memory-blocked',
      memoryPolicy: {
        mode: 'disabled',
        includeGlobal: false,
        reasonCodes: ['memory_mode:disabled', 'cross_task_isolation', 'memory_disabled'],
      },
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', callId: 'mem-block', name: 'memory', input: { operation: 'read', scope: 'workspace', key: 'style' } }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'acknowledged' }],
        },
      },
    ])
    let executorSaw = false
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          executorSaw = true
          return { ok: true, content: 'should not reach executor' }
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(memoryRecord.sessionId, { kind: 'user_message', text: 'read style memory' })

    expect(executorSaw).toBe(false)
    const parsed = await readSessionLog(memoryRecord.logPath)
    const result = parsed.events.find(
      (entry) => entry.event.kind === 'tool_result' && entry.event.callId === 'mem-block',
    )
    expect(result).toBeDefined()
    if (result?.event.kind !== 'tool_result') throw new Error('unreachable')
    expect(result.event.ok).toBe(false)
    expect(result.event.content).toContain('EMEMDISABLED')
    expect(result.event.content).toContain('scope=workspace')
  })

  it('allows session-scope memory when memoryPolicy.mode is disabled', async () => {
    const memoryConfig = createConfig({ tools: [MEMORY], systemPrompt: 'sys' })
    const memoryRecord = await store.create({
      config: memoryConfig,
      sessionId: 'sess-memory-session-ok',
      memoryPolicy: {
        mode: 'disabled',
        includeGlobal: false,
        reasonCodes: ['memory_mode:disabled', 'cross_task_isolation', 'memory_disabled'],
      },
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', callId: 'mem-session', name: 'memory', input: { operation: 'read', scope: 'session', key: 'plan' } }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'read complete' }],
        },
      },
    ])
    let executorSaw = false
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          executorSaw = true
          return { ok: true, content: 'session memory reply' }
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(memoryRecord.sessionId, { kind: 'user_message', text: 'read session plan' })

    expect(executorSaw).toBe(true)
  })

  it('records the active model on LLM response entries and broadcasts', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'model captured' }],
        },
        usage: { inputTokens: 7, outputTokens: 4 },
      },
    ])
    const seenEvents: Array<{ event: string; model?: string }> = []
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onEvent(_sessionId, _seq, event, _effects, _state, _llmTrace, model) {
          seenEvents.push({ event: event.kind, model })
        },
      },
      models: { get: () => 'claude-sonnet-4-6' },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const response = parsed.events.find((entry) => entry.event.kind === 'llm_response')
    expect(response?.model).toBe('claude-sonnet-4-6')
    expect(seenEvents).toContainEqual({ event: 'llm_response', model: 'claude-sonnet-4-6' })
  })

  it('uses dispatch model override for the whole turn instead of the live resolver value', async () => {
    const calls: Array<string | undefined> = []
    const llm: LLMAdapter = {
      name: 'capturing',
      async call(params) {
        calls.push(params.model)
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'override captured' }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: { get: () => 'live-model' },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' }, { model: 'snapshot-model' })

    expect(calls).toEqual(['snapshot-model'])
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    expect(parsed.events.find((entry) => entry.event.kind === 'llm_response')?.model).toBe('snapshot-model')
  })

  it('records and broadcasts LLM provider trace from the adapter', async () => {
    const trace = {
      provider: 'openai' as const,
      model: 'gpt-5.5',
      request: {
        url: 'https://api.example.test/v1/chat/completions?api_key=query-secret',
        headers: { authorization: 'Bearer test-redacted-api-key', 'x-api-key': 'header-secret' },
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
      },
      response: { status: 200, body: { choices: [], url: 'https://api.example.test/v1/chat/completions' } },
    }
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'trace captured' }],
        },
        usage: { inputTokens: 7, outputTokens: 4 },
        finishReason: 'stop',
        trace,
      },
    ])
    const seen: Array<{ llmTrace?: typeof trace; model?: string }> = []
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onEvent(_sessionId, _seq, event, _effects, _state, llmTrace, model) {
          if (event.kind === 'llm_response') seen.push({ ...(llmTrace ? { llmTrace: llmTrace as typeof trace } : {}), model })
        },
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const response = parsed.events.find((entry) => entry.event.kind === 'llm_response')
    expect(response?.llmTrace?.request.url).toBe('https://<redacted>/v1/chat/completions')
    expect(response?.llmTrace?.request.body).toBeUndefined()
    expect(response?.llmTraceArtifact?.path).toContain('llm-traces')
    expect(response?.model).toBe('gpt-5.5')
    expect(response?.event.kind).toBe('llm_response')
    if (response?.event.kind === 'llm_response') {
      expect(response.event.finishReason).toBe('stop')
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.llmTrace?.request.url).toBe('https://<redacted>/v1/chat/completions')
    expect(seen[0]?.llmTrace?.request.headers.authorization).toBe('[redacted]')
    expect(JSON.stringify(seen[0]?.llmTrace)).not.toContain('api.example.test')
    expect(JSON.stringify(seen[0]?.llmTrace)).not.toContain('header-secret')
    expect(seen[0]?.model).toBe('gpt-5.5')
  })

  it('drives a tool call round-trip', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'file contents seen' }],
        },
      },
    ])
    let seen: string | undefined
    const tools = nullTools({
      callTool: async (_sid, eff) => {
        seen = eff.name
        return { ok: true, content: 'hello file' }
      },
    })
    const loop = runHostLoop({ store, llm, tools, broadcast: silentBroadcast() })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(seen).toBe('read')
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    // user + llm(tool) + tool_result + llm(text)
    expect(rec.state.cursor).toBe(4)
  })

  it('handles the skill builtin in host without dispatching to executor', async () => {
    const skillsRoot = join(dir, '.agent', 'skills')
    const skillDir = join(skillsRoot, 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: demo-skill',
        'description: Use for testing host-side skill loading.',
        '---',
        '',
        'DEMO SKILL BODY',
      ].join('\n'),
      'utf8',
    )
    const skills = await discoverSkills([skillsRoot])
    const skillConfig = createConfig({
      tools: [
        READ,
        SKILL,
      ],
      systemPrompt: 'sys',
    })
    const skillRecord = await store.create({ config: skillConfig, sessionId: 'sess-skill' })
    let executorCalls = 0
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'skill-1',
              name: 'skill',
              input: { name: 'demo-skill' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'skill loaded' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          executorCalls++
          return { ok: false, content: 'should not dispatch' }
        },
      }),
      broadcast: silentBroadcast(),
      skills,
    })

    await loop.dispatch(skillRecord.sessionId, { kind: 'user_message', text: 'load skill' })

    expect(executorCalls).toBe(0)
    const toolMessage = store
      .get(skillRecord.sessionId)!
      .state.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content[0]).toMatchObject({
      type: 'tool_result',
      callId: 'skill-1',
      ok: true,
    })
    expect(
      toolMessage?.content[0]?.type === 'tool_result'
        ? toolMessage.content[0].content
        : '',
    ).toContain('DEMO SKILL BODY')
  })

  it('keeps the skill Tool schema stable while listing a newly authored Skill', async () => {
    const workspace = join(dir, 'workspace')
    const skillDir = join(workspace, '.agent', 'skills', 'fresh-skill')
    const skillPath = join(skillDir, 'SKILL.md')
    mkdirSync(workspace, { recursive: true })
    const skillConfig = createConfig({
      tools: [
        { ...SKILL, description: '<available_skills />' },
        {
          name: 'write',
          description: 'write',
          inputSchema: { type: 'object' },
          requiresApproval: false,
        },
      ],
      systemPrompt: 'sys',
    })
    const record = await store.create({
      sessionId: 'sess-refresh-skill',
      config: skillConfig,
      initialCwd: workspace,
    })
    const skillSchemas: string[] = []
    const llm: LLMAdapter = {
      name: 'capture-tools',
      async call(params) {
        skillSchemas.push(JSON.stringify(params.tools.find((tool) => tool.name === 'skill')))
        if (skillSchemas.length === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'write-skill',
                  name: 'write',
                  input: {
                    path: skillPath,
                    content: [
                      '---',
                      'name: fresh-skill',
                      'description: Use for same-session refresh testing.',
                      '---',
                      '',
                      'Fresh instructions.',
                    ].join('\n'),
                  },
                },
              ],
            },
          }
        }
        if (skillSchemas.length === 2) {
          return {
            message: {
              role: 'assistant',
              content: [{
                type: 'tool_call',
                callId: 'list-skills',
                name: 'skill',
                input: { action: 'list' },
              }],
            },
          }
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async (_sessionId, effect) => {
          const path = effect.input.path
          const content = effect.input.content
          if (typeof path === 'string' && typeof content === 'string') {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, content, 'utf8')
          }
          return { ok: true, content: 'written' }
        },
      }),
      broadcast: silentBroadcast(),
      skills: createSkillManager(store, skillConfig),
    })

    await loop.dispatch(record.sessionId, { kind: 'user_message', text: 'create a skill' })

    expect(skillSchemas).toHaveLength(3)
    expect(new Set(skillSchemas).size).toBe(1)
    expect(skillSchemas[0]).not.toContain('fresh-skill')
    const skillResult = store
      .get(record.sessionId)!
      .state.messages.find((message) =>
        message.content.some((item) => item.type === 'tool_result' && item.callId === 'list-skills'))
    expect(skillResult?.content[0]).toMatchObject({
      type: 'tool_result',
      callId: 'list-skills',
      ok: true,
      content: expect.stringContaining('<name>fresh-skill</name>'),
    })
    const parsed = await readSessionLog(record.logPath)
    const llmEntries = parsed.events.filter((entry) => entry.effects.some((effect) => effect.kind === 'call_llm'))
    const firstEffects = JSON.parse(await readFile(join(dir, llmEntries[0]!.effectsArtifact!.path), 'utf8'))
    const thirdEffects = JSON.parse(await readFile(join(dir, llmEntries[2]!.effectsArtifact!.path), 'utf8'))
    const firstSkill = firstEffects.find((effect: { kind: string }) => effect.kind === 'call_llm')
      .tools.find((tool: { name: string }) => tool.name === 'skill')
    const thirdSkill = thirdEffects.find((effect: { kind: string }) => effect.kind === 'call_llm')
      .tools.find((tool: { name: string }) => tool.name === 'skill')
    expect(thirdSkill).toEqual(firstSkill)
  })

  it('translates LLM throw into llm_error event', async () => {
    const llm: LLMAdapter = {
      name: 'boom',
      async call() {
        throw new Error('rate limited')
      },
    }
    let sawError: string | undefined
    const broadcast: LoopBroadcast = {
      ...silentBroadcast(),
      onError(_sid, msg) {
        sawError = msg
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast,
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('error')
    expect(rec.state.error).toBe('rate limited')
    expect(sawError).toBe('rate limited')
  })

  it('persistent log round-trips through load', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const fresh = new SessionStore(dir)
    const reloaded = await fresh.load(sessionId)
    expect(reloaded.state.status).toBe('done')
    expect(reloaded.state.cursor).toBe(2)
  })

  it('serializes concurrent dispatches for one session', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await Promise.all([
      loop.dispatch(sessionId, { kind: 'user_message', text: 'one' }),
      loop.dispatch(sessionId, { kind: 'user_message', text: 'two' }),
    ])

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    expect(rec.state.cursor).toBe(4)
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(parsed.events.map((e) => e.event.kind)).toEqual([
      'user_message',
      'llm_response',
      'user_message',
      'llm_response',
    ])
  })

  it('does not let broadcast failures break persisted loop progress', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'still persisted' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onEvent() {
          throw new Error('socket layer failed')
        },
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events).toHaveLength(2)
  })

  it('propagates cancel to the executor via cancelPending (SPEC §Non-goals: Host cancels IO)', async () => {
    // Scenario: LLM asked for a tool call, executor is chewing on it, user
    // hits cancel. Before this fix the kernel drops pendingCalls but the
    // executor kept running because `cancelPending` was never invoked —
    // wire-protocol §5.2 was silently ignored. Now dispatch must call
    // cancelPending exactly once with the session id.
    let toolPromiseResolve: ((r: { ok: boolean; content: string }) => void) | undefined
    let toolCalled: (() => void) | undefined
    const toolCallSeen = new Promise<void>((r) => {
      toolCalled = r
    })
    const cancels: string[] = []
    const tools: ToolDispatcher = {
      callTool: (_sid, _eff) =>
        new Promise((r) => {
          toolPromiseResolve = r
          // Signal that the loop actually reached callTool. Awaiting this
          // in the test avoids brittle setImmediate/setTimeout guesses
          // about how many microtasks the loop needs to reach the
          // pending-tool point.
          toolCalled?.()
        }),
      cancelPending: (sid) => {
        cancels.push(sid)
        // Simulate the executor honouring cancel by acking with a synthetic
        // failure. The registry would normally do this after the executor
        // replies; we short-circuit here so the loop's outstanding
        // dispatchOne (for tool_result) can resolve.
        toolPromiseResolve?.({ ok: false, content: 'cancelled' })
      },
    }
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c-cancel',
              name: 'read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools,
      broadcast: silentBroadcast(),
    })

    // Kick off the tool-call turn. Don't await — the executor is
    // "processing" indefinitely until cancel arrives.
    const dispatchP = loop.dispatch(sessionId, {
      kind: 'user_message',
      text: 'read x',
    })
    // Wait until the loop is definitely blocked inside callTool.
    await toolCallSeen

    // Now the user cancels. Loop must call cancelPending on the executor.
    await loop.dispatch(sessionId, { kind: 'cancel' })
    await dispatchP

    expect(cancels).toEqual([sessionId])
    // Kernel is done, not executing_tools any more.
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
    expect(rec.state.pendingCalls).toEqual([])
  })

  it('coalesces concurrent cancel requests into one persisted transition', async () => {
    let releaseTool: ((result: { ok: boolean; content: string }) => void) | undefined
    let signalTool: (() => void) | undefined
    const toolStarted = new Promise<void>((resolve) => { signalTool = resolve })
    const cancels: string[] = []
    const loop = runHostLoop({
      store,
      llm: scriptedLlm([{
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', callId: 'c-concurrent-cancel', name: 'read', input: { path: '/tmp/x' } }],
        },
      }]),
      tools: {
        callTool: () => new Promise((resolve) => {
          releaseTool = resolve
          signalTool?.()
        }),
        cancelPending: (sid) => {
          cancels.push(sid)
          releaseTool?.({ ok: false, content: 'cancelled' })
        },
      },
      broadcast: silentBroadcast(),
    })

    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })
    await toolStarted
    await Promise.all(Array.from({ length: 12 }, () => loop.dispatch(sessionId, { kind: 'cancel' })))
    await turn

    expect(cancels).toEqual([sessionId])
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'cancel')).toHaveLength(1)
    expect(new Set(parsed.events.map((entry) => entry.seq)).size).toBe(parsed.events.length)
  })

  it('cancel with no pending tool is still safe (no-op cancelPending)', async () => {
    // Cancel from idle (no tool call ever dispatched): kernel is a noop,
    // executor has nothing to interrupt, but cancelPending is still
    // invoked — the spec's contract is "cancel means stop everything
    // now" and we want it to be idempotent-shaped. The important
    // guarantee is that the loop doesn't crash when there's nothing
    // in flight.
    const cancels: string[] = []
    const tools: ToolDispatcher = {
      callTool: async () => ({ ok: true, content: 'unused' }),
      cancelPending: (sid) => {
        cancels.push(sid)
      },
    }
    const loop = runHostLoop({
      store,
      llm: scriptedLlm([]),
      tools,
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'cancel' })
    expect(cancels).toEqual([sessionId])
    const rec = store.get(sessionId)!
    // A stale/repeated cancel at rest still reaches the executor cancellation
    // hook, but must not append a duplicate no-op event or advance the cursor.
    expect(rec.state.status).toBe('idle')
    expect(rec.state.cursor).toBe(0)
  })

  it('manual compact() summarizes and replaces messages', async () => {
    // Pre-seed a session that has already run one turn so state.messages is
    // non-trivial. Then a manual `/compact` should send those messages to
    // the LLM with the summarizer system prompt, receive a well-formed
    // handoff, and emit a messages_replaced event that shrinks the list.
    const llmCalls: Array<{
      sys?: string
      msgs: number
      model?: string
      messages: import('@agent-kernel/kernel').Message[]
    }> = []
    const llm: LLMAdapter = {
      name: 'compact-mock',
      async call(p) {
        llmCalls.push({ sys: p.systemPrompt, msgs: p.messages.length, model: p.model, messages: [...p.messages] })
        // First call = turn's user_message → assistant text reply.
        // Second call = summarizer → summary text.
        if (llmCalls.length === 1) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          }
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: OK_SUMMARY_BODY }],
          },
          usage: { inputTokens: 8, outputTokens: 3 },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: { get: () => 'compact-model' },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    const beforeCount = store.get(sessionId)!.state.messages.length
    expect(beforeCount).toBeGreaterThan(1)

    await loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })

    const rec = store.get(sessionId)!
    // Codex-style replacement: leading system prompt + anchored summary as a
    // user message + preserved raw user tail ('hi').
    expect(rec.state.messages).toHaveLength(3)
    expect(rec.state.messages[0]!.role).toBe('system')
    const anchored = rec.state.messages[1]!
    expect(anchored.role).toBe('user')
    expect(anchored.content[0]).toMatchObject({ type: 'text' })
    const anchoredText = (anchored.content[0] as { type: 'text'; text: string }).text
    expect(anchoredText).toContain(`${SUMMARY_PREFIX}\n\n${OK_SUMMARY_BODY}`)
    expect(anchoredText).toContain('<runtime-checkpoint>')
    expect(anchoredText).toContain(`"sessionId": "${sessionId}"`)
    expect(anchoredText).toContain('"status": "done"')
    expect(anchored.metadata).toMatchObject({
      kind: 'context_compaction',
      phase: 'done',
      trigger: 'manual',
      summary: OK_SUMMARY_BODY,
    })
    expect(rec.state.messages[2]!.content[0]).toEqual({ type: 'text', text: 'hi' })
    // Summarizer call carried the new compaction prompt.
    expect(llmCalls[1]!.sys).toMatch(/CONTEXT CHECKPOINT COMPACTION/)
    expect(llmCalls[1]!.model).toBe('compact-model')
    // Summarizer sees the transcript as ONE user message wrapping <transcript>.
    expect(llmCalls[1]!.messages).toHaveLength(1)
    expect(llmCalls[1]!.messages[0]!.role).toBe('user')
    const summarizerInput = (llmCalls[1]!.messages[0]!.content[0] as { text: string }).text
    expect(summarizerInput).toContain('<transcript>')
    expect(summarizerInput).toContain('<runtime-checkpoint>')
    expect(summarizerInput).toContain(`"sessionId": "${sessionId}"`)
    // Cumulative usage is preserved; current-window context is compacted.
    expect(rec.state.usage.inputTokens).toBe(10)
    expect(rec.state.status).toBe('done')
    const parsed = await readSessionLog(rec.logPath)
    const compact = parsed.events.find((e) => e.event.kind === 'messages_replaced')?.event
    expect(compact).toMatchObject({ kind: 'messages_replaced', reason: 'compaction' })
    const metadata = parsed.runtimeMetadata.find((e) => e.action === 'compaction_applied')
    expect(metadata?.payload.trigger).toBe('manual')
    expect(metadata?.payload.responseUsage).toEqual({ inputTokens: 8, outputTokens: 3 })
    expect(parsed.events.some((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toBe(false)
    const reloaded = await new SessionStore(dir).load(sessionId)
    expect(reloaded.state.messages[1]?.metadata).toMatchObject({
      kind: 'context_compaction',
      phase: 'done',
      attemptId: expect.stringMatching(/^cmp_/),
    })
    expect(llmCalls).toHaveLength(2)
  })

  it('manual compact() trims old oversized tool results before summarizing', async () => {
    const toolConfig = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const rec = await store.create({ config: toolConfig, sessionId: 'sess-compact-tool-trim' })
    const sid = rec.sessionId
    const largeToolOutput = `${'A'.repeat(9_000)}${'Z'.repeat(7_000)}TAIL-ERROR-${'Z'.repeat(1_000)}`
    const compactInputs: import('@agent-kernel/kernel').Message[][] = []
    let normalCalls = 0
    const llm: LLMAdapter = {
      name: 'compact-trim-mock',
      async call(p) {
        if (p.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
          compactInputs.push([...p.messages])
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: OK_SUMMARY_BODY }],
            },
          }
        }
        normalCalls += 1
        if (normalCalls > 1) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done with log' }],
            },
          }
        }
        return {
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'read-big',
                name: 'read',
                input: { path: '/tmp/big.log' },
              },
            ],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({ callTool: async () => ({ ok: true, content: largeToolOutput }) }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'read big log' })
    await loop.compact(sid, { trigger: 'manual', continuation: 'stay_resting' })

    // Codex-style summarizer receives one user message containing a serialised
    // transcript. The tool result is embedded as "[Tool result read-big]: <content>"
    // and must be truncated by prepareCompactionInputWithLimit before rendering.
    expect(compactInputs[0]).toHaveLength(1)
    const transcript = (compactInputs[0]![0]!.content[0] as { text: string }).text
    const toolLineMatch = transcript.match(/\[Tool result read-big\]:([\s\S]*?)(?:\n\n\[|$)/)
    expect(toolLineMatch, 'transcript must contain the tool result line').not.toBeNull()
    const toolBody = toolLineMatch![1]!
    expect(toolBody.length).toBeLessThan(9_000)
    expect(toolBody).toContain('chars omitted from old tool result before compaction')
    expect(toolBody).toContain('TAIL-ERROR')
  })

  it('manual compact() rejects empty sessions before calling the summarizer', async () => {
    let llmCalls = 0
    const llm: LLMAdapter = {
      name: 'compact-counter',
      async call() {
        llmCalls += 1
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'unused' }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow('nothing to compact yet')
    expect(llmCalls).toBe(0)
  })

  it('manual compact() rejects busy sessions before calling the summarizer', async () => {
    let release: (() => void) | undefined
    const llm: LLMAdapter = {
      name: 'blocked-turn',
      async call() {
        return await new Promise<LLMResponse>((resolve) => {
          release = () =>
            resolve({
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
              },
            })
        })
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (store.get(sessionId)?.state.status === 'thinking') return resolve()
        if (Date.now() - start > 1000) return reject(new Error('never thinking'))
        setTimeout(tick, 10)
      }
      tick()
    })

    await expect(loop.compact(sessionId, { trigger: 'manual', continuation: 'stay_resting' })).rejects.toThrow(
      'cannot compact while the session is busy',
    )
    release?.()
    await turn
  })

  it('auto-fires compact when context pressure hits hard tier', async () => {
    // Build a session whose contextLimit is tiny so a single assistant reply
    // pushes inputTokens/contextLimit past the hard threshold. The loop's
    // post-dispatch hook must observe the hard pressure and self-fire compact.
    const tightConfig = createConfig({
      tools: [],
      systemPrompt: 'sys',
      contextLimit: 100,
      softThreshold: 0.5,
      hardThreshold: 0.9,
    })
    const rec = await store.create({ config: tightConfig, sessionId: 'sess-hp' })
    const sid = rec.sessionId

    const llmCalls: Array<{ sys?: string }> = []
    const llm: LLMAdapter = {
      name: 'pressure-mock',
      async call(p) {
        llmCalls.push({ sys: p.systemPrompt })
        if (llmCalls.length === 1) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done '.repeat(100) }],
            },
            usage: { inputTokens: 5, outputTokens: 5 },
          }
        }
        // Turn 2 = the auto-compact's summarizer call.
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: OK_SUMMARY_BODY }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'x'.repeat(120) })

    // Two LLM calls: the turn itself, then the auto-compact summarizer.
    expect(llmCalls).toHaveLength(2)
    expect(llmCalls[1]!.sys).toMatch(/CONTEXT CHECKPOINT COMPACTION/)
    const after = store.get(sid)!
    // After compact: system prompt + anchored user-summary + preserved raw user tail.
    expect(after.state.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect((after.state.messages[1]!.content[0] as { text: string }).text).toContain(SUMMARY_PREFIX)
    expect((after.state.messages[1]!.content[0] as { text: string }).text).toContain(OK_SUMMARY_BODY)
    // A well-formed anchored summary is bigger than the original tiny transcript
    // in this test, so `shouldCompact` may still return true — that's fine,
    // the guarantee we care about is that compaction actually fired above.
  })

  it('auto-compact summarizes the old prefix and preserves the latest user turn', async () => {
    const tightConfig = createConfig({
      tools: [],
      systemPrompt: 'sys',
      contextLimit: 100,
      softThreshold: 0.5,
      hardThreshold: 0.9,
    })
    const rec = await store.create({ config: tightConfig, sessionId: 'sess-compact-tail' })
    const sid = rec.sessionId

    const compactInputs: import('@agent-kernel/kernel').Message[][] = []
    let callCount = 0
    let normalCallCount = 0
    const llm: LLMAdapter = {
      name: 'compact-tail-mock',
      async call(p) {
        callCount += 1
        if (p.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
          compactInputs.push([...p.messages])
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: OK_SUMMARY_BODY }],
            },
          }
        }
        normalCallCount += 1
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: normalCallCount === 2 ? `answer ${callCount} ${'x'.repeat(400)}` : `answer ${callCount}` }],
          },
          usage: normalCallCount === 2
            ? { inputTokens: 5, outputTokens: 5 }
            : { inputTokens: 20, outputTokens: 5 },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'old task' })
    await loop.dispatch(sid, { kind: 'user_message', text: 'latest task' })

    expect(compactInputs).toHaveLength(1)
    // Summarizer now receives ONE user message wrapping the transcript.
    expect(compactInputs[0]!).toHaveLength(1)
    expect(compactInputs[0]![0]!.role).toBe('user')
    const transcript = (compactInputs[0]![0]!.content[0] as { text: string }).text
    expect(transcript).toContain('<transcript>')
    expect(transcript).toContain('[User]: old task')
    const after = store.get(sid)!
    // Codex-style replacement: leading system + anchored user-summary +
    // preserved raw user turns from the compacted region ('old task') +
    // the ongoing tail (user 'latest task' + its assistant reply).
    expect(after.state.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'user',
      'user',
      'assistant',
    ])
    expect((after.state.messages[1]!.content[0] as { text: string }).text).toContain(SUMMARY_PREFIX)
    expect((after.state.messages[1]!.content[0] as { text: string }).text).toContain(OK_SUMMARY_BODY)
    expect(after.state.messages[2]!.content[0]).toEqual({ type: 'text', text: 'old task' })
    expect(after.state.messages[3]!.content[0]).toEqual({ type: 'text', text: 'latest task' })
    expect(after.state.messages[4]!.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(after.state.messages[4]!.content[0])).toContain('answer 2')
  })

  it('preflight compacts before an oversized follow-up LLM request', async () => {
    const tightConfig = createConfig({
      tools: [READ],
      systemPrompt: 'sys',
      contextLimit: 1_000,
      softThreshold: 0.8,
      hardThreshold: 0.99,
    })
    const rec = await store.create({ config: tightConfig, sessionId: 'sess-preflight-compact' })
    const sid = rec.sessionId
    const calls: Array<{ kind: 'compact' | 'normal'; messages: import('@agent-kernel/kernel').Message[] }> = []
    let normalCalls = 0
    const llm: LLMAdapter = {
      name: 'preflight-mock',
      async call(p) {
        if (p.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
          calls.push({ kind: 'compact', messages: [...p.messages] })
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: OK_SUMMARY_BODY }] },
            usage: { inputTokens: 50, outputTokens: 10 },
          }
        }
        normalCalls += 1
        calls.push({ kind: 'normal', messages: [...p.messages] })
        if (normalCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', callId: 'big-read', name: 'read', input: { path: '/big' } }],
            },
            usage: { inputTokens: 100, outputTokens: 10 },
          }
        }
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'finished after compact' }] },
          usage: { inputTokens: 120, outputTokens: 20 },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({ callTool: async () => ({ ok: true, content: 'x'.repeat(4_000) }) }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'read big output' })

    expect(calls.map((c) => c.kind)).toEqual(['normal', 'compact', 'normal'])
    // Anchored summary now lives as a user message prefixed with SUMMARY_PREFIX.
    expect(
      calls[2]!.messages.some(
        (m) => m.role === 'user' && JSON.stringify(m).includes(SUMMARY_PREFIX),
      ),
    ).toBe(true)
    const parsed = await readSessionLog(store.get(sid)!.logPath)
    const compact = parsed.events.find((e) => e.event.kind === 'messages_replaced')?.event
    expect(compact).toMatchObject({ kind: 'messages_replaced', reason: 'compaction' })
    expect(parsed.runtimeMetadata.some((e) => e.action === 'compaction_applied' && e.payload.trigger === 'preflight')).toBe(true)
  })

  it('recovers a provider context overflow by compacting and continuing the same turn once', async () => {
    const rec = await store.create({ config: createConfig({ systemPrompt: 'sys', tools: [], contextLimit: 100_000 }), sessionId: 'sess-provider-overflow' })
    let normalCalls = 0
    const calls: string[] = []
    const llm: LLMAdapter = {
      name: 'overflow-recovery-mock',
      async call(params) {
        if (params.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
          calls.push('compact')
          return { message: { role: 'assistant', content: [{ type: 'text', text: OK_SUMMARY_BODY }] } }
        }
        normalCalls += 1
        calls.push(`normal-${normalCalls}`)
        if (normalCalls === 1) throw Object.assign(new Error('maximum context length exceeded'), { input: { status: 400, bodyText: 'too many tokens' } })
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'continued after forced recovery' }] } }
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(rec.sessionId, { kind: 'user_message', text: 'perform this once' })
    expect(calls).toEqual(['normal-1', 'compact', 'normal-2'])
    const state = store.get(rec.sessionId)!.state
    expect(state.status).toBe('done')
    expect(state.messages.filter((message) => message.role === 'user' && JSON.stringify(message).includes('perform this once'))).toHaveLength(1)
    expect(JSON.stringify(state.messages)).toContain('continued after forced recovery')
  })

  it('hard-truncates one irreducibly huge message when compaction fails', async () => {
    const rec = await store.create({ config: createConfig({ systemPrompt: 'sys', tools: [], contextLimit: 20_000 }), sessionId: 'sess-single-huge-message' })
    const normalInputs: import('@agent-kernel/kernel').Message[][] = []
    const llm: LLMAdapter = {
      name: 'single-huge-recovery-mock',
      async call(params) {
        if (params.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) throw new Error('summarizer unavailable')
        normalInputs.push([...params.messages])
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'completed despite huge input' }] } }
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    await loop.dispatch(rec.sessionId, { kind: 'user_message', text: `head-${'x'.repeat(120_000)}-tail` })
    expect(normalInputs).toHaveLength(1)
    expect(estimateStringTokens(JSON.stringify(normalInputs[0]))).toBeLessThan(20_000)
    expect(JSON.stringify(normalInputs[0])).toContain('omitted by emergency context recovery')
    expect(store.get(rec.sessionId)!.state.status).toBe('done')
  })

  it('compacts after sibling tool results settle and before the continuation LLM call', async () => {
    const tightConfig = createConfig({
      tools: [READ],
      systemPrompt: 'sys',
      contextLimit: 30_000,
      softThreshold: 0.8,
      hardThreshold: 0.99,
    })
    const rec = await store.create({ config: tightConfig, sessionId: 'sess-mid-tool-compact' })
    const sid = rec.sessionId
    const calls: Array<{ kind: 'normal' | 'compact'; messages: import('@agent-kernel/kernel').Message[] }> = []
    let normalCalls = 0
    const llm: LLMAdapter = {
      name: 'mid-tool-compact-mock',
      async call(p) {
        if (p.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
          calls.push({ kind: 'compact', messages: [...p.messages] })
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: OK_SUMMARY_BODY }] },
            usage: { inputTokens: 4_000, outputTokens: 100 },
          }
        }
        normalCalls += 1
        calls.push({ kind: 'normal', messages: [...p.messages] })
        if (normalCalls === 1) {
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: 'old answer retained until compaction' }] },
            usage: { inputTokens: 10_000, outputTokens: 50 },
          }
        }
        if (normalCalls === 2) {
          return {
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_call', callId: 'c1', name: 'read', input: { path: '/tmp/huge.log' } },
                { type: 'tool_call', callId: 'c2', name: 'read', input: { path: '/tmp/small.log' } },
              ],
            },
            usage: { inputTokens: 10_000, outputTokens: 50 },
          }
        }
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'finished after tools' }] },
          usage: { inputTokens: 6_000, outputTokens: 50 },
        }
      },
    }
    const toolOutputs: Record<string, string> = {
      c1: `${'A'.repeat(60_000)}TAIL-OF-HUGE-RESULT`,
      c2: 'small result',
    }
    let releaseSecondTool: (() => void) | undefined
    const secondToolGate = new Promise<void>((resolve) => {
      releaseSecondTool = resolve
    })
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async (_sessionId, eff) => {
          if (eff.callId === 'c2') await secondToolGate
          return { ok: true, content: toolOutputs[eff.callId] ?? 'missing' }
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'old context '.repeat(7_000) })
    calls.length = 0

    const dispatch = loop.dispatch(sid, { kind: 'user_message', text: 'read both files' })
    await vi.waitFor(() => {
      const state = store.get(sid)!.state
      const settledResults = state.messages
        .flatMap((message) => message.content)
        .filter((content) => content.type === 'tool_result')
      expect(settledResults).toHaveLength(1)
      expect(state.pendingCalls.map((call) => call.callId)).toEqual(['c2'])
    })
    expect(calls.some((call) => call.kind === 'compact')).toBe(false)
    releaseSecondTool?.()
    await dispatch

    expect(calls[0]?.kind).toBe('normal')
    expect(calls.some((call) => call.kind === 'compact')).toBe(true)
    expect(calls.at(-1)?.kind).toBe('normal')
    const compactCall = calls.find((call) => call.kind === 'compact')
    expect(compactCall?.messages.some((m) => m.content.some((c) => c.type === 'tool_call'))).toBe(false)
    const finalNormal = calls.at(-1)!
    // Anchored summary now lives as a user message prefixed with SUMMARY_PREFIX.
    expect(
      finalNormal.messages.some(
        (m) => m.role === 'user' && JSON.stringify(m).includes(SUMMARY_PREFIX),
      ),
    ).toBe(true)
    const activeAssistant = finalNormal.messages.find((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'tool_call'))
    expect(activeAssistant).toBeDefined()
    const toolResults = finalNormal.messages.flatMap((m) => m.content).filter((c) => c.type === 'tool_result')
    expect(toolResults).toHaveLength(2)
    expect(JSON.stringify(toolResults[0])).toContain('omitted from tool result before entering LLM context')
    expect(JSON.stringify(toolResults[0])).toContain('TAIL-OF-HUGE-RESULT')

    const parsed = await readSessionLog(store.get(sid)!.logPath)
    expect(parsed.runtimeMetadata.some((e) => e.action === 'compaction_applied' && e.payload.trigger === 'preflight')).toBe(true)
    expect(store.get(sid)!.state.status).toBe('done')
  })

  it('blocks a third identical tool call immediately after compaction', async () => {
    const toolConfig = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const rec = await store.create({ config: toolConfig, sessionId: 'sess-loop-guard' })
    const sid = rec.sessionId
    let normalCalls = 0
    let executorCalls = 0
    const llm: LLMAdapter = {
      name: 'loop-guard-mock',
      async call(p) {
        if (p.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
          return { message: { role: 'assistant', content: [{ type: 'text', text: OK_SUMMARY_BODY }] } }
        }
        normalCalls += 1
        if (normalCalls === 1) {
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } }
        }
        if (normalCalls <= 4) {
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', callId: `repeat-${normalCalls}`, name: 'read', input: { path: '/same' } }],
            },
          }
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          executorCalls += 1
          return { ok: true, content: 'same' }
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sid, { kind: 'user_message', text: 'start' })
    await loop.compact(sid, { trigger: 'manual', continuation: 'stay_resting' })
    await loop.dispatch(sid, { kind: 'user_message', text: 'continue' })

    expect(executorCalls).toBe(2)
    const toolResults = store
      .get(sid)!
      .state.messages.flatMap((m) => m.content)
      .filter((c): c is { type: 'tool_result'; callId: string; ok: boolean; content: string } => c.type === 'tool_result')
    expect(toolResults.some((r) => !r.ok && r.content.includes('repeated identical tool call after context compaction'))).toBe(true)
  })

  it('pipes streaming text deltas through the broadcast', async () => {
    // Adapter fake that yields three text chunks synchronously, then returns
    // the assembled assistant message. Mirrors what the real anthropic /
    // openai adapters do when `onTextDelta` is present.
    const chunks = ['hel', 'lo ', 'world']
    const llm: LLMAdapter = {
      name: 'streaming-fake',
      async call({ onTextDelta }) {
        if (onTextDelta) for (const c of chunks) onTextDelta(c)
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: chunks.join('') }],
          },
          usage: { inputTokens: 1, outputTokens: 3 },
        }
      },
    }
    const deltas: string[] = []
    const appendedKinds: string[] = []
    const broadcast: LoopBroadcast = {
      onEvent: (_sid, _seq, event) => {
        appendedKinds.push(event.kind)
      },
      onApprovalRequired: () => {},
      onError: () => {},
      onTokenDelta: (_sid, t) => {
        deltas.push(t)
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })

    expect(deltas).toEqual(chunks)
    // Exactly one llm_response landed in the log — deltas are UI-only.
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const llmResponses = parsed.events.filter(
      (e) => e.event.kind === 'llm_response',
    )
    expect(llmResponses).toHaveLength(1)
    if (llmResponses[0]!.event.kind === 'llm_response') {
      expect(llmResponses[0]!.event.message.content[0]).toEqual({
        type: 'text',
        text: 'hello world',
      })
    }
    // Sanity: an event:appended fires for the user + the final response, but
    // NOT one per delta.
    expect(appendedKinds).toEqual(['user_message', 'llm_response'])
    // ...state should have used deltas without extra usage records:
    void state
  })

  it('recovers one short max_tokens text-only response by compacting and retrying', async () => {
    let calls = 0
    const llm: LLMAdapter = {
      name: 'scripted',
      async call() {
        calls += 1
        if (calls === 1) {
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: '好，写成文件。' }] },
            usage: { inputTokens: 230_000, outputTokens: 10 },
            finishReason: 'max_tokens',
          }
        }
        if (calls === 2) {
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: OK_SUMMARY_BODY }] },
            usage: { inputTokens: 10_000, outputTokens: 200 },
            finishReason: 'end_turn',
          }
        }
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'done after retry' }] },
          usage: { inputTokens: 12_000, outputTokens: 20 },
          finishReason: 'end_turn',
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
      models: { get: () => 'm', contextWindow: () => 1_000_000 },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: '写成文件' })

    expect(calls).toBe(3)
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const llmResponses = parsed.events.filter((entry) => entry.event.kind === 'llm_response')
    expect(llmResponses).toHaveLength(1)
    const final = llmResponses.at(-1)!
    expect(final.event.kind).toBe('llm_response')
    if (final.event.kind === 'llm_response') {
      expect(final.event.finishReason).toBe('end_turn')
      expect(final.event.message.content).toContainEqual({ type: 'text', text: 'done after retry' })
    }
    expect(JSON.stringify(parsed.events)).not.toContain('好，写成文件。')
    expect(parsed.runtimeMetadata.some((entry) => entry.action === 'compaction_applied')).toBe(true)
    expect(parsed.runtimeMetadata.some((entry) => entry.action === 'token_usage_observed' && entry.payload.trigger === 'max_tokens_retry')).toBe(true)
  })

  it('uses CJK-aware token estimates instead of chars divided by four', () => {
    const text = '港股数据字段含义说明缺失'.repeat(100)
    expect(estimateStringTokens(text)).toBeGreaterThan(Math.ceil(text.length / 2))
  })

  it('cancelStream aborts an in-flight streaming LLM call', async () => {
    // The adapter observes the AbortSignal and rejects with an AbortError,
    // matching how fetch(signal) rejects. The loop must convert that into a
    // finalised `llm_response` with a `[cancelled]` suffix so the FSM
    // doesn't hang in `thinking`.
    let seenSignal: AbortSignal | undefined
    let listenerReady: (() => void) | undefined
    const listenerReadyPromise = new Promise<void>((r) => {
      listenerReady = r
    })
    const llm: LLMAdapter = {
      name: 'abortable',
      async call({ onTextDelta, signal }) {
        seenSignal = signal
        onTextDelta?.('partial ')
        return await new Promise<LLMResponse>((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }
          listenerReady!()
        })
      },
    }
    const broadcast: LoopBroadcast = {
      onEvent: () => {},
      onApprovalRequired: () => {},
      onError: () => {},
      onTokenDelta: () => {},
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast })
    const done = loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await listenerReadyPromise
    loop.cancelStream(sessionId)
    await done

    expect(seenSignal).toBeDefined()
    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const last = parsed.events[parsed.events.length - 1]!
    expect(last.event.kind).toBe('llm_response')
    if (last.event.kind === 'llm_response') {
      const text = last.event.message.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { type: 'text'; text: string }).text)
        .join('')
      expect(text).toMatch(/\[cancelled\]$/)
      expect(text).toMatch(/^partial /)
    }
  })

  it('immediately aborts the in-flight model and rejects new effects when its Runtime closes', async () => {
    let started!: () => void
    const active = new Promise<void>((resolve) => { started = resolve })
    const llm: LLMAdapter = {
      name: 'shutdown-abort',
      async call({ signal }) {
        return await new Promise<LLMResponse>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
          started()
        })
      },
    }
    const loop = runHostLoop({ store, llm, tools: nullTools(), broadcast: silentBroadcast() })
    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'start model' })
    await active
    loop.abortActiveEffects()
    await turn
    await expect(loop.dispatch(sessionId, { kind: 'user_message', text: 'stale effect' }))
      .rejects.toThrow('effects are stopped')
  })

  it('cancels in-flight executor work immediately when its Runtime closes', async () => {
    let started!: () => void
    const active = new Promise<void>((resolve) => { started = resolve })
    let resolveTool!: (value: { ok: boolean; content: string }) => void
    const callTool = vi.fn(async () => await new Promise<{ ok: boolean; content: string }>((resolve) => {
      resolveTool = resolve
      started()
    }))
    const cancelPending = vi.fn(() => resolveTool({ ok: false, content: 'cancelled' }))
    let calls = 0
    const llm: LLMAdapter = { name: 'shutdown-tool', async call() {
      calls += 1
      return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'shutdown-c1', name: 'read', input: { path: '/tmp/test' } }] } }
    } }
    const loop = runHostLoop({ store, llm, tools: nullTools({ callTool, cancelPending }), broadcast: silentBroadcast() })
    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'start tool' })
    await active
    loop.abortActiveEffects()
    await turn
    expect(cancelPending).toHaveBeenCalledWith(sessionId)
    expect(callTool).toHaveBeenCalledOnce()
    expect(calls).toBe(1)
  })

  it('handles agent tool calls inside the host and records a child session', async () => {
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-parent',
      workspaceId: 'ws-agent',
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-1',
              name: 'agent',
              input: { prompt: 'answer the question' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '42' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parent done' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          throw new Error('agent should not dispatch to executor')
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const parentLog = await readSessionLog(parent.logPath)
    const toolResult = parentLog.events.find(
      (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-1',
    )
    expect(toolResult?.event.kind).toBe('tool_result')
    if (toolResult?.event.kind !== 'tool_result') throw new Error('unreachable')
    expect(toolResult.event.ok).toBe(true)
    // The child's final text ("42") is wrapped in the `<sub_agent>` envelope
    // so the dashboard can render a SubAgentCard without heuristics.
    expect(toolResult.event.content).toMatch(/^<sub_agent\b/)
    expect(toolResult.event.content).toContain('status="completed"')
    expect(toolResult.event.content).toContain('<result>\n42\n</result>')
    expect(toolResult.event.content).toContain('</sub_agent>')

    const children = store
      .list()
      .filter((r) => r.parentSessionId === parent.sessionId)
    expect(children).toHaveLength(1)
    expect(children[0]!.workspaceId).toBe('ws-agent')
    const childLog = await readSessionLog(children[0]!.logPath)
    expect(childLog.header.parentSessionId).toBe(parent.sessionId)
    expect(childLog.header.parentCallId).toBe('agent-1')
    expect(childLog.header.subAgentStartedAt).toMatch(/T/)
    expect(children[0]!.state.status).toBe('done')
  })

  it('releases an idle restart checkpoint after a running child Agent and its parent finish', async () => {
    const parent = await store.create({
      config: createConfig({ tools: [AGENT], systemPrompt: 'sys' }),
      sessionId: 'sess-agent-idle-drain-parent',
    })
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
    let markChildStarted!: () => void
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve })
    let calls = 0
    const loop = runHostLoop({
      store,
      llm: {
        name: 'agent-idle-drain',
        async call() {
          calls += 1
          if (calls === 1) {
            return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'agent-idle-1', name: 'agent', input: { prompt: 'finish child' } }] } }
          }
          if (calls === 2) {
            markChildStarted()
            await childGate
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'child done' }] } }
          }
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'parent done' }] } }
        },
      },
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    const run = loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })
    await childStarted
    const child = store.list().find((record) => record.parentSessionId === parent.sessionId)!
    loop.beginDrain('idle')
    let parentReached = false
    let childReached = false
    const parentCheckpoint = loop.waitForCheckpoint(parent.sessionId).then(() => { parentReached = true })
    const childCheckpoint = loop.waitForCheckpoint(child.sessionId).then(() => { childReached = true })
    await Promise.resolve()
    expect(parentReached).toBe(false)
    expect(childReached).toBe(false)

    releaseChild()
    await Promise.all([run, parentCheckpoint, childCheckpoint])
    expect(store.get(child.sessionId)?.state.status).toBe('done')
    expect(store.get(parent.sessionId)?.state.status).toBe('done')
    expect(parentReached).toBe(true)
    expect(childReached).toBe(true)
  })

  it('starts sibling sub-agent tool calls concurrently', async () => {
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-parallel-parent',
      workspaceId: 'ws-agent-parallel',
    })
    const childWaiters: Array<() => void> = []
    let llmCalls = 0
    const llm: LLMAdapter = {
      name: 'parallel-scripted',
      async call() {
        llmCalls += 1
        if (llmCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_call', callId: 'agent-a', name: 'agent', input: { prompt: 'A' } },
                { type: 'tool_call', callId: 'agent-b', name: 'agent', input: { prompt: 'B' } },
              ],
            },
          }
        }
        if (llmCalls === 2 || llmCalls === 3) {
          await new Promise<void>((resolve) => childWaiters.push(resolve))
          return { message: { role: 'assistant', content: [{ type: 'text', text: `child ${llmCalls}` }] } }
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'parent done' }] } }
      },
    }
    const started: SubAgentStartedPayload[] = []
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onSubAgentStarted(p) {
          started.push(p)
        },
      },
    })

    const run = loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })
    while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started.map((p) => p.parentCallId).sort()).toEqual(['agent-a', 'agent-b'])
    while (childWaiters.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(childWaiters).toHaveLength(2)
    childWaiters.forEach((resolve) => resolve())
    await run

    const parentLog = await readSessionLog(parent.logPath)
    const results = parentLog.events.filter((e) => e.event.kind === 'tool_result')
    expect(results.map((e) => e.event.kind === 'tool_result' ? e.event.callId : '').sort()).toEqual(['agent-a', 'agent-b'])
  })

  it('persists a resolved sub-agent policy artifact when a role is requested', async () => {
    const parentConfig = createConfig({ tools: [AGENT, READ_FILE], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-policy-parent',
      workspaceId: 'ws-agent-policy',
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-policy-1',
              name: 'agent',
              input: {
                prompt: 'find things',
                role: 'research',
                objective: 'summarize repo layout',
              },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child done' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parent done' }],
        },
      },
    ])
    const artifactRootDir = join(dir, 'agent-policy-artifacts')
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          throw new Error('agent should not dispatch to executor')
        },
      }),
      broadcast: silentBroadcast(),
      artifactRootDir,
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const artifactPath = join(artifactRootDir, 'subagent-policies', parent.sessionId, 'agent-policy-1.json')
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.parentSessionId).toBe(parent.sessionId)
    expect(artifact.parentCallId).toBe('agent-policy-1')
    expect(artifact.policy.role).toBe('research')
    expect(artifact.policy.objective).toBe('summarize repo layout')
    expect(artifact.policy.intention).toBe('summarize repo layout')
    expect(artifact.policy.reasons).toContain('role_template_applied')
    expect(artifact.policy.allowedTools).toContain('read_file')
    expect(artifact.policy.maxTurns).toBe(180)
    expect(artifact.policy.idleTimeoutMs).toBe(45 * 60_000)
    expect(artifact.policy.toolIdleTimeoutMs).toBe(120 * 60_000)
    expect(artifact.policy.timeoutMs).toBe(4 * 60 * 60_000)
    expect(artifact.policy.gracePeriodMs).toBe(5 * 60_000)
    expect(artifact.policy.expectedOutput).toMatch(/summary/i)
  })

  it('maps implementation agent_type to the controlled write policy when role is omitted', async () => {
    const write = { name: 'write_file', description: 'write', inputSchema: { type: 'object' }, requiresApproval: true, executionKind: 'executor' as const }
    const parent = await store.create({
      config: createConfig({ tools: [AGENT, READ_FILE, write], systemPrompt: 'sys' }),
      sessionId: 'sess-agent-implementation-type-parent',
      workspaceId: 'ws-agent-implementation-type',
    })
    const llm = scriptedLlm([
      { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'agent-implementation-type', name: 'agent', input: { prompt: 'make a bounded edit', agent_type: 'implementation' } }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'child done' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'parent done' }] } },
    ])
    const artifactRootDir = join(dir, 'agent-implementation-type-artifacts')
    const started: SubAgentStartedPayload[] = []
    const loop = runHostLoop({ store, llm, tools: nullTools(), artifactRootDir, broadcast: { ...silentBroadcast(), onSubAgentStarted(payload) { started.push(payload) } } })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const artifact = JSON.parse(await readFile(join(artifactRootDir, 'subagent-policies', parent.sessionId, 'agent-implementation-type.json'), 'utf8'))
    expect(artifact.policy.role).toBe('implementation')
    expect(artifact.policy.allowedTools).toContain('write_file')
    expect(started[0]?.agentType).toBe('implementation')
  })

  it('emits sub_agent_started + sub_agent_finished around the child run', async () => {
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-events-parent',
      workspaceId: 'ws-agent-events',
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-events-1',
              name: 'agent',
              input: {
                prompt: 'do the thing',
                intention: 'Investigate the delegated runtime behavior.',
                agent_type: 'Explore',
                model: 'claude-sonnet-4-6',
              },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child text' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parent done' }],
        },
      },
    ])
    const started: SubAgentStartedPayload[] = []
    const finished: SubAgentFinishedPayload[] = []
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools({
        callTool: async () => {
          throw new Error('agent should not dispatch to executor')
        },
      }),
      broadcast: {
        ...silentBroadcast(),
        onSubAgentStarted(p) {
          started.push(p)
        },
        onSubAgentFinished(p) {
          finished.push(p)
        },
      },
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    expect(started).toHaveLength(1)
    expect(finished).toHaveLength(1)
    const s = started[0]!
    expect(s.parentSessionId).toBe(parent.sessionId)
    expect(s.parentCallId).toBe('agent-events-1')
    expect(s.agentType).toBe('Explore')
    expect(s.model).toBe('claude-sonnet-4-6')
    expect(s.prompt).toBe('do the thing')
    expect(s.intention).toBe('Investigate the delegated runtime behavior.')
    expect(s.childSessionId).toMatch(/./)
    const persistedResult = store.get(parent.sessionId)!.state.messages
      .flatMap((message) => message.content)
      .find((content) => content.type === 'tool_result' && content.callId === 'agent-events-1')
    expect(persistedResult?.type === 'tool_result' ? persistedResult.content : '').toContain(
      'intention="Investigate the delegated runtime behavior."',
    )
    const f = finished[0]!
    expect(f.childSessionId).toBe(s.childSessionId)
    expect(f.status).toBe('completed')
    expect(f.turns).toBeGreaterThan(0)
    expect(f.error).toBeUndefined()
  })

  it('cancels a running sub-agent when the parent session is cancelled', async () => {
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-cancel-parent',
      workspaceId: 'ws-agent-cancel',
    })
    const started: SubAgentStartedPayload[] = []
    const finished: SubAgentFinishedPayload[] = []
    let call = 0
    let childAbort: (() => void) | null = null
    const llm: LLMAdapter = {
      name: 'cancel-aware',
      async call(params) {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-cancel-1',
                  name: 'agent',
                  input: { prompt: 'long child work' },
                },
              ],
            },
          }
        }
        if (call === 2) {
          await new Promise<void>((_resolve, reject) => {
            childAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            params.signal?.addEventListener('abort', () => childAbort?.(), { once: true })
          })
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'parent done' }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onSubAgentStarted(p) {
          started.push(p)
        },
        onSubAgentFinished(p) {
          finished.push(p)
        },
      },
    })

    const run = loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })
    while (started.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))

    await loop.dispatch(parent.sessionId, { kind: 'cancel' })
    await run

    expect(finished).toHaveLength(1)
    expect(finished[0]!.status).toBe('cancelled')
    expect(finished[0]!.error).toContain('parent session cancelled')

    const parentLog = await readSessionLog(parent.logPath)
    const toolResult = parentLog.events.find(
      (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-cancel-1',
    )
    if (toolResult?.event.kind !== 'tool_result') throw new Error('unreachable')
    expect(toolResult.event.ok).toBe(false)
    expect(toolResult.event.content).toContain('status="cancelled"')
    expect(toolResult.event.content).toContain('parent session cancelled')
  })

  it('failed sub-agent runs still emit start + finish (status=failed) and a failure envelope', async () => {
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-agent-fail-parent',
      workspaceId: 'ws-agent-fail',
    })
    // Child LLM immediately throws → child ends in `error` status →
    // runAgentTool wraps the failure in a `<sub_agent status="failed">…<error>…`.
    let call = 0
    const llm: LLMAdapter = {
      name: 'flaky',
      async call() {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-fail-1',
                  name: 'agent',
                  input: { prompt: 'crash please' },
                },
              ],
            },
          }
        }
        if (call === 2) throw new Error('child llm exploded')
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'parent done' }],
          },
        }
      },
    }
    const started: SubAgentStartedPayload[] = []
    const finished: SubAgentFinishedPayload[] = []
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: {
        ...silentBroadcast(),
        onSubAgentStarted(p) {
          started.push(p)
        },
        onSubAgentFinished(p) {
          finished.push(p)
        },
      },
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    expect(started).toHaveLength(1)
    expect(finished).toHaveLength(1)
    expect(finished[0]!.status).toBe('failed')
    expect(finished[0]!.error).toMatch(/./)

    const parentLog = await readSessionLog(parent.logPath)
    const toolResult = parentLog.events.find(
      (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-fail-1',
    )
    if (toolResult?.event.kind !== 'tool_result') throw new Error('unreachable')
    expect(toolResult.event.ok).toBe(false)
    expect(toolResult.event.content).toContain('status="failed"')
    expect(toolResult.event.content).toContain('<error>')
  })

  it('refuses to spawn a sub-agent once the recursive depth cap is reached', async () => {
    // Default policy allows a root session to create one child, but the child
    // cannot create another sub-agent.
    const parentConfig = createConfig({
      tools: [AGENT],
      systemPrompt: 'sys',
    })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-depth-parent',
      workspaceId: 'ws-depth',
    })
    let call = 0
    const llm: LLMAdapter = {
      name: 'nested',
      async call() {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-parent',
                  name: 'agent',
                  input: { prompt: 'delegate one level' },
                },
              ],
            },
          }
        }
        if (call === 2) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-child',
                  name: 'agent',
                  input: { prompt: 'delegate one more level' },
                },
              ],
            },
          }
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const descendants = store.list().filter((r) => r.parentSessionId === parent.sessionId)
    // Exactly one child (depth 1). No grand-child was created.
    expect(descendants).toHaveLength(1)
    const grandChildren = store.list().filter((r) => r.parentSessionId === descendants[0]!.sessionId)
    expect(grandChildren).toHaveLength(0)
    expect(descendants[0]!.config.tools.some((tool) => tool.name === 'agent')).toBe(false)
  })

  it('hard-caps recursive sub-agents even if an old child config still exposes agent', async () => {
    const parent = await store.create({
      config: createConfig({ tools: [AGENT], systemPrompt: 'sys' }),
      sessionId: 'sess-depth-hardcap-parent',
      workspaceId: 'ws-depth-hardcap',
    })
    const child = await store.create({
      config: createConfig({ tools: [AGENT], systemPrompt: 'sys', maxAgentDepth: 6 }),
      sessionId: 'sess-depth-hardcap-child',
      parentSessionId: parent.sessionId,
      parentCursor: 0,
      workspaceId: 'ws-depth-hardcap',
    })
    const llm = scriptedLlm([
      { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'agent-child-hardcap', name: 'agent', input: { prompt: 'try nested delegate' } }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(child.sessionId, { kind: 'user_message', text: 'go' })

    const grandChildren = store.list().filter((r) => r.parentSessionId === child.sessionId)
    expect(grandChildren).toHaveLength(0)
    const childLog = await readSessionLog(child.logPath)
    const refused = childLog.events.find(
      (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-child-hardcap',
    )
    if (refused?.event.kind !== 'tool_result') throw new Error('unreachable')
    expect(refused.event.ok).toBe(false)
    expect(refused.event.content).toContain('agent depth exceeded')
  })

  it('refuses to spawn a sub-agent when the fan-out cap is already reached', async () => {
    // Fan-out cap = 0 means *no* sibling sub-agents are allowed. The parent's
    // very first delegate call must be refused with `fan-out exceeded`.
    const parentConfig = createConfig({
      tools: [AGENT],
      systemPrompt: 'sys',
      maxAgentFanOut: 0,
    })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-fanout-parent',
      workspaceId: 'ws-fanout',
    })
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-first',
              name: 'agent',
              input: { prompt: 'try to delegate' },
            },
          ],
        },
      },
      {
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    // No child was created because fan-out is 0.
    const children = store.list().filter((r) => r.parentSessionId === parent.sessionId)
    expect(children).toHaveLength(0)

    const parentLog = await readSessionLog(parent.logPath)
    const refused = parentLog.events.find(
      (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-first',
    )
    if (refused?.event.kind !== 'tool_result') throw new Error('unreachable')
    expect(refused.event.ok).toBe(false)
    expect(refused.event.content).toContain('fan-out exceeded')
  })

  it('atomically enforces the fan-out cap for sibling calls from one response', async () => {
    const parent = await store.create({
      config: createConfig({
        tools: [AGENT],
        systemPrompt: 'sys',
        maxAgentFanOut: 1,
      }),
      sessionId: 'sess-fanout-race-parent',
      workspaceId: 'ws-fanout-race',
    })
    const llm: LLMAdapter = {
      name: 'parallel-fanout',
      async call(params) {
        const userText = params.messages
          .filter((message) => message.role === 'user')
          .flatMap((message) => message.content)
          .map((content) => content.type === 'text' ? content.text : '')
          .join('\n')
        const hasToolResult = params.messages.some(
          (message) => message.content.some((content) => content.type === 'tool_result'),
        )
        if (userText.includes('child task')) {
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'child done' }] } }
        }
        if (!hasToolResult) {
          return {
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_call', callId: 'agent-race-a', name: 'agent', input: { prompt: 'child task A' } },
                { type: 'tool_call', callId: 'agent-race-b', name: 'agent', input: { prompt: 'child task B' } },
              ],
            },
          }
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'parent done' }] } }
      },
    }
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const children = store.list().filter((record) => record.parentSessionId === parent.sessionId)
    expect(children).toHaveLength(1)
    const toolResults = store.get(parent.sessionId)!.state.messages
      .flatMap((message) => message.content)
      .filter((content) => content.type === 'tool_result')
    expect(toolResults).toHaveLength(2)
    expect(toolResults.some((result) => result.type === 'tool_result' && result.content.includes('fan-out exceeded'))).toBe(true)
  })

  it('spawned sub-agents run with allow_all regardless of parent approval mode (ADR 0014)', async () => {
    // Regression: parents in `auto`/`ask` used to hand their mode down to the
    // child. But sub-agents are headless — no dashboard is subscribed to the
    // child session, so a RequestApprovalEffect would deadlock forever and
    // the parent would see `tool_result: ok=false, "agent ended with status
    // awaiting_approval"`. See docs/meta/adr/0014-subagent-approval-mode.md.
    const parentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    const parent = await store.create({
      config: parentConfig,
      sessionId: 'sess-approval-parent',
      workspaceId: 'ws-approval',
      initialApprovalMode: 'auto',
    })
    expect(parent.state.approvalMode).toBe('auto')

    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'agent-approval',
              name: 'agent',
              input: { prompt: 'do a thing' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child done' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parent done' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(parent.sessionId, { kind: 'user_message', text: 'go' })

    const children = store
      .list()
      .filter((r) => r.parentSessionId === parent.sessionId)
    expect(children).toHaveLength(1)
    expect(children[0]!.state.approvalMode).toBe('allow_all')
    // Parent's own mode is untouched.
    expect(store.get(parent.sessionId)!.state.approvalMode).toBe('auto')
  })

  it('pre_tool_use hook blocks the tool call when it fails', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ])
    let executorCalled = false
    const tools = nullTools({
      callTool: async () => {
        executorCalled = true
        return { ok: true, content: 'nope' }
      },
    })
    const loop = runHostLoop({
      store,
      llm,
      tools,
      broadcast: silentBroadcast(),
      hooks: [{ event: 'pre_tool_use', command: '_ignored' }],
      hookRunner: {
        run: async () => ({
          ok: false,
          exitCode: 3,
          stdout: 'denied by policy',
          stderr: '',
        }),
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(executorCalled).toBe(false)
    const rec = store.get(sessionId)!
    const parsed = await readSessionLog(rec.logPath)
    const toolResult = parsed.events.find((e) => e.event.kind === 'tool_result')
    expect(toolResult?.event).toMatchObject({
      kind: 'tool_result',
      ok: false,
    })
    const content =
      toolResult?.event.kind === 'tool_result' ? toolResult.event.content : ''
    expect(content).toContain('blocked by pre_tool_use hook')
    expect(content).toContain('denied by policy')
  })

  it('post_tool_use hook fires after a successful tool call', async () => {
    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ])
    const tools = nullTools({
      callTool: async () => ({ ok: true, content: 'hello file' }),
    })
    let postSeen = false
    const loop = runHostLoop({
      store,
      llm,
      tools,
      broadcast: silentBroadcast(),
      hooks: [{ event: 'post_tool_use', command: '_ignored' }],
      hookRunner: {
        run: async (_hook, payload) => {
          if (payload.event === 'post_tool_use') {
            postSeen = true
            expect(payload.toolResult).toEqual({ ok: true, content: 'hello file' })
          }
          return { ok: true, exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(postSeen).toBe(true)
    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('done')
  })

  it('checkpoint drain pauses after llm_response before dispatching tools', async () => {
    let toolCalls = 0
    let releaseLlm!: (response: LLMResponse) => void
    let markLlmStarted!: () => void
    const llmStarted = new Promise<void>((resolve) => {
      markLlmStarted = resolve
    })
    const llmResponse = new Promise<LLMResponse>((resolve) => {
      releaseLlm = resolve
    })
    const loop = runHostLoop({
      store,
      llm: {
        name: 'deferred',
        async call() {
          markLlmStarted()
          return await llmResponse
        },
      },
      tools: nullTools({
        callTool: async () => {
          toolCalls += 1
          return { ok: true, content: 'ok' }
        },
      }),
      broadcast: silentBroadcast(),
    })

    const turn = loop.dispatch(sessionId, { kind: 'user_message', text: 'hi' })
    await llmStarted
    loop.beginDrain('checkpoint')
    releaseLlm({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', callId: 'c1', name: 'read', input: {} }],
      },
    })
    await turn

    const rec = store.get(sessionId)!
    expect(rec.state.status).toBe('executing_tools')
    expect(rec.state.pendingCalls[0]?.callId).toBe('c1')
    expect(toolCalls).toBe(0)
    expect(loop.drainSnapshot(sessionId).safe).toBe(true)
  })

  it('checkpoint drain pauses after a durable tool result before the next LLM', async () => {
    let llmCalls = 0
    const loop = runHostLoop({
      store,
      llm: {
        name: 'checkpoint-tool-boundary',
        async call() {
          llmCalls += 1
          if (llmCalls === 1) return { message: { role: 'assistant', content: [{ type: 'tool_call' as const, callId: 'c-tool-boundary', name: 'read', input: {} }] } }
          return { message: { role: 'assistant', content: [{ type: 'text' as const, text: 'continued' }] } }
        },
      },
      tools: nullTools({
        callTool: async () => {
          loop.beginDrain('checkpoint')
          return { ok: true, content: 'tool finished' }
        },
      }),
      broadcast: silentBroadcast(),
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: 'read x' })

    expect(llmCalls).toBe(1)
    expect(store.get(sessionId)?.state.status).toBe('thinking')
    expect(loop.drainSnapshot(sessionId)).toMatchObject({ safe: true, checkpointKind: 'before_llm' })
  })

  it('distributed owner takeover never automatically replays an uncertain model request', async () => {
    let llmCalls = 0
    const loop = runHostLoop({
      store,
      llm: { name: 'uncertain-model', async call() {
        llmCalls += 1
        return { message: { role: 'assistant', content: [{ type: 'tool_call' as const, callId: 'c-uncertain', name: 'read', input: {} }] } }
      } },
      tools: nullTools({ callTool: async () => {
        loop.beginDrain('checkpoint')
        return { ok: true, content: 'safe checkpoint' }
      } }),
      assertSessionEffectOwner: async () => {},
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'work' })
    expect(store.get(sessionId)?.state.status).toBe('thinking')
    loop.endDrain()
    expect(await loop.resumeSession(sessionId)).toBe(true)
    expect(llmCalls).toBe(1)
    const events = (await readSessionLog(store.get(sessionId)!.logPath)).events
    expect(events.some(({ event }) => event.kind === 'llm_response'
      && event.message.content.some((part) => part.type === 'text' && part.text === '[interrupted]'))).toBe(true)
  })

  it('distributed owner takeover does not replay a tool with an unknown external outcome', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'unsafe duplicate' }))
    const loop = runHostLoop({
      store,
      llm: { name: 'uncertain-tool', async call() {
        loop.beginDrain('checkpoint')
        return { message: { role: 'assistant', content: [{ type: 'tool_call' as const, callId: 'c-uncertain-tool', name: 'read', input: {} }] } }
      } },
      tools: nullTools({ callTool }),
      assertSessionEffectOwner: async () => {},
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'work' })
    expect(store.get(sessionId)?.state.status).toBe('executing_tools')
    loop.endDrain()
    expect(await loop.resumeSession(sessionId)).toBe(false)
    expect(callTool).not.toHaveBeenCalled()
    expect(store.get(sessionId)?.state.pendingCalls.length).toBeGreaterThan(0)
  })

  it('planned resume continues a checkpointed LLM turn without an interrupted marker', async () => {
    let llmCalls = 0
    const loop = runHostLoop({
      store,
      llm: {
        name: 'planned-resume',
        async call() {
          llmCalls += 1
          if (llmCalls === 1) return { message: { role: 'assistant', content: [{ type: 'tool_call' as const, callId: 'c-resume', name: 'read', input: {} }] } }
          return { message: { role: 'assistant', content: [{ type: 'text' as const, text: 'resumed normally' }] } }
        },
      },
      tools: nullTools({
        callTool: async () => {
          loop.beginDrain('checkpoint')
          return { ok: true, content: 'checkpoint me' }
        },
      }),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(sessionId, { kind: 'user_message', text: 'continue me' })
    expect(store.get(sessionId)?.state.status).toBe('thinking')
    loop.endDrain()

    await expect(loop.resumeSession(sessionId)).resolves.toBe(true)

    const parsed = await readSessionLog(store.get(sessionId)!.logPath)
    const assistantText = parsed.events
      .flatMap((entry) => entry.event.kind === 'llm_response' ? entry.event.message.content : [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
    expect(assistantText).toContain('resumed normally')
    expect(assistantText).not.toContain('[interrupted]')
  })
})

describe('SessionStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a new session with header on disk', async () => {
    const store = new SessionStore(dir)
    const cfg = createConfig({ tools: [] })
    const rec = await store.create({ config: cfg, sessionId: 'abc' })
    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.header.sessionId).toBe('abc')
    expect(parsed.header.formatVersion).toBe(2)
    expect(parsed.events).toHaveLength(0)
  })

  it('fold matches live loop after replay', async () => {
    const store = new SessionStore(dir)
    const cfg = createConfig({ tools: [READ] })
    const rec = await store.create({ config: cfg, sessionId: 'zzz' })
    void createInitialState

    const llm = scriptedLlm([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'yep' }],
        },
      },
    ])
    const loop = runHostLoop({
      store,
      llm,
      tools: nullTools(),
      broadcast: silentBroadcast(),
    })
    await loop.dispatch(rec.sessionId, { kind: 'user_message', text: 'x' })

    const other = new SessionStore(dir)
    const loaded = await other.load('zzz')
    expect(loaded.state).toEqual(store.get('zzz')?.state)
  })
})
