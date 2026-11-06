import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createBuiltinTools } from '../builtin-tools.js'
import { runHostLoop } from '../loop.js'
import type { HostLoopDeps } from '../loop-types.js'
import { SessionStore } from '../store/session.js'
import { SqliteSessionAuthority } from '../store/sqlite-session-authority.js'
import { clearAgentBoardForRoot, inspectAgentBoard, runAgentBoardTool } from './agent-board.js'
import { runAgentTool, runReadAgentTool, runWriteAgentTool } from './agent-tool.js'

describe('multi-agent message board & live subagent steering', () => {
  let dir: string

  beforeEach(() => {
    mkdirSync('.tmp', { recursive: true })
    dir = mkdtempSync(join('.tmp', 'kala-multi-agent-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('shares the agent_board across parent and sibling sub-agents and enforces advisory file claims', async () => {
    const store = new SessionStore(dir)
    const tools = createBuiltinTools()
    const parent = await store.create({
      sessionId: 'root-parent',
      config: { tools },
    })
    const childA = await store.create({
      sessionId: 'child-a',
      parentSessionId: parent.sessionId,
      agentType: 'research',
      config: { tools },
    })
    const childB = await store.create({
      sessionId: 'child-b',
      parentSessionId: parent.sessionId,
      agentType: 'implementation',
      config: { tools },
    })

    const deps = { store } as unknown as HostLoopDeps

    // Child A posts a root cause finding
    const postRes = await runAgentBoardTool({
      deps,
      sessionId: childA.sessionId,
      aborts: new Map(),
      plannedContinuation: false,
      effect: {
        kind: 'call_tool',
        callId: 'b-1',
        name: 'agent_board',
        input: {
          operation: 'post',
          topic: 'auth-token-bug',
          content: 'Token expiry check in src/auth.ts uses seconds instead of milliseconds.',
          tags: ['bug', 'auth'],
        },
      },
    })
    expect(postRes.ok).toBe(true)

    // Child B reads the board and sees Child A's finding under the shared rootSessionId
    const readRes = await runAgentBoardTool({
      deps,
      sessionId: childB.sessionId,
      aborts: new Map(),
      plannedContinuation: false,
      effect: {
        kind: 'call_tool',
        callId: 'b-2',
        name: 'agent_board',
        input: {
          operation: 'read',
          topic: 'auth-token-bug',
        },
      },
    })
    expect(readRes.ok).toBe(true)
    const readPayload = JSON.parse(readRes.content)
    expect(readPayload.rootSessionId).toBe('root-parent')
    expect(readPayload.entry.authorSessionId).toBe('child-a')
    expect(readPayload.entry.authorRole).toBe('research')
    expect(readPayload.entry.content).toContain('seconds instead of milliseconds')

    // Child B claims src/auth.ts
    const claimRes = await runAgentBoardTool({
      deps,
      sessionId: childB.sessionId,
      aborts: new Map(),
      plannedContinuation: false,
      effect: {
        kind: 'call_tool',
        callId: 'b-3',
        name: 'agent_board',
        input: {
          operation: 'claim_file',
          path: 'src/auth.ts',
          note: 'Applying ms multiplier fix',
        },
      },
    })
    expect(claimRes.ok).toBe(true)

    // Child A tries to claim src/auth.ts -> rejected with conflict
    const conflictRes = await runAgentBoardTool({
      deps,
      sessionId: childA.sessionId,
      aborts: new Map(),
      plannedContinuation: false,
      effect: {
        kind: 'call_tool',
        callId: 'b-4',
        name: 'agent_board',
        input: {
          operation: 'claim_file',
          path: 'src/auth.ts',
        },
      },
    })
    expect(conflictRes.ok).toBe(false)
    expect(conflictRes.content).toContain('already claimed by session child-b')

    const childClear = await runAgentBoardTool({
      deps, sessionId: childA.sessionId, aborts: new Map(), plannedContinuation: false,
      effect: { kind: 'call_tool', callId: 'b-clear-child', name: 'agent_board', input: { operation: 'clear' } },
    })
    expect(childClear.ok).toBe(false)
    expect(inspectAgentBoard('root-parent').entries).toHaveLength(1)
    expect(inspectAgentBoard('root-parent').fileClaims).toHaveLength(1)

    // Child B releases src/auth.ts
    const releaseRes = await runAgentBoardTool({
      deps,
      sessionId: childB.sessionId,
      aborts: new Map(),
      plannedContinuation: false,
      effect: {
        kind: 'call_tool',
        callId: 'b-5',
        name: 'agent_board',
        input: {
          operation: 'release_file',
          path: 'src/auth.ts',
        },
      },
    })
    expect(releaseRes.ok).toBe(true)
    expect(inspectAgentBoard('root-parent').fileClaims).toHaveLength(0)

    clearAgentBoardForRoot('root-parent')
  })

  it('bounds file claims and lets only the root clear the board', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'claim-root', config: { tools: [] } })
    const deps = { store } as unknown as HostLoopDeps
    const call = (operation: string, path?: string) => runAgentBoardTool({
      deps, sessionId: parent.sessionId, aborts: new Map(), plannedContinuation: false,
      effect: { kind: 'call_tool' as const, callId: 'claim', name: 'agent_board', input: { operation, path } },
    })

    for (let i = 0; i < 200; i++) expect((await call('claim_file', `src/${i}.ts`)).ok).toBe(true)
    expect((await call('claim_file', 'src/overflow.ts')).ok).toBe(false)
    expect((await call('claim_file', 'a'.repeat(1025))).ok).toBe(false)
    expect((await call('claim_file', 'src/0.ts')).ok).toBe(true)
    expect((await call('clear')).ok).toBe(true)
    expect(inspectAgentBoard(parent.sessionId).fileClaims).toHaveLength(0)
    clearAgentBoardForRoot(parent.sessionId)
  })

  it('persists atomic claims and topic revisions between independent SQLite stores and after restart', async () => {
    const databasePath = join(dir, 'sessions.sqlite')
    const authorities = [new SqliteSessionAuthority(databasePath), new SqliteSessionAuthority(databasePath)]
    const stores = authorities.map((authority, i) => new SessionStore(join(dir, `replica-${i}`), { authority }))
    try {
      await Promise.all(stores.map(store => store.initialize()))
      const root = await stores[0]!.create({ sessionId: 'board-root', config: { tools: [] } })
      await stores[0]!.create({ sessionId: 'board-a', parentSessionId: root.sessionId, config: { tools: [] } })
      await stores[0]!.create({ sessionId: 'board-b', parentSessionId: root.sessionId, config: { tools: [] } })
      await stores[1]!.load('board-b')
      const call = (store: SessionStore, sessionId: string, operation: string, extra: Record<string, unknown> = {}) =>
        runAgentBoardTool({
          deps: { store } as HostLoopDeps, sessionId, aborts: new Map(), plannedContinuation: false,
          effect: { kind: 'call_tool', callId: `board-${operation}`, name: 'agent_board',
            input: { operation, ...extra } },
        })
      const [first, second] = await Promise.all([
        call(stores[0]!, 'board-a', 'claim_file', { path: 'src/owned.ts' }),
        call(stores[1]!, 'board-b', 'claim_file', { path: 'src/owned.ts' }),
      ])
      expect([first.ok, second.ok].sort()).toEqual([false, true])
      expect([first, second].find(result => !result.ok)?.content).toContain('already claimed')
      const [postA, postB] = await Promise.all([
        call(stores[0]!, 'board-a', 'post', { topic: 'contract', content: 'first', expected_revision: 0 }),
        call(stores[1]!, 'board-b', 'post', { topic: 'contract', content: 'second', expected_revision: 0 }),
      ])
      expect([postA.ok, postB.ok].sort()).toEqual([false, true])
      expect([postA, postB].find(result => !result.ok)?.content).toContain('revision mismatch')
      await authorities[0]!.close()
      const restarted = new SqliteSessionAuthority(databasePath)
      try {
        const fresh = new SessionStore(join(dir, 'restarted'), { authority: restarted })
        await fresh.initialize()
        await fresh.load('board-root')
        const board = await call(fresh, 'board-root', 'read')
        expect(board.ok).toBe(true)
        const data = JSON.parse(board.content)
        expect(data.entries).toHaveLength(1)
        expect(data.fileClaims).toHaveLength(1)
        expect(data.entries[0].revision).toBe(1)
      } finally {
        await restarted.close()
      }
    } finally {
      await authorities[1]!.close()
    }
  })

  it('retains the JSONL Portable board across store restarts and removes it when the root is deleted', async () => {
    const first = new SessionStore(dir)
    await first.create({ sessionId: 'jsonl-root', config: { tools: [] } })
    await first.create({ sessionId: 'jsonl-child', parentSessionId: 'jsonl-root', config: { tools: [] } })
    const call = (store: SessionStore, sessionId: string, operation: string, extra: Record<string, unknown> = {}) =>
      runAgentBoardTool({
        deps: { store } as HostLoopDeps, sessionId, aborts: new Map(), plannedContinuation: false,
        effect: { kind: 'call_tool', callId: `jsonl-${operation}`, name: 'agent_board',
          input: { operation, ...extra } },
      })
    expect((await call(first, 'jsonl-child', 'post', { topic: 'topic', content: 'persisted' })).ok).toBe(true)
    const restarted = new SessionStore(dir)
    await restarted.load('jsonl-root')
    await restarted.load('jsonl-child')
    const board = await call(restarted, 'jsonl-root', 'read')
    expect(JSON.parse(board.content).entries[0].content).toBe('persisted')
    await restarted.delete('jsonl-root')
    await restarted.create({ sessionId: 'jsonl-root', config: { tools: [] } })
    const cleared = await call(restarted, 'jsonl-root', 'read')
    expect(JSON.parse(cleared.content).entries).toEqual([])
  })

  it('allows durable board coordination under owner fencing while child routing remains fenced', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'owner-root', config: { tools: createBuiltinTools() } })
    const child = await store.create({
      sessionId: 'owner-child', parentSessionId: parent.sessionId, config: { tools: createBuiltinTools() },
    })
    const deps = {
      store,
      assertSessionEffectOwner: async () => {},
    } as unknown as HostLoopDeps
    const board = await runAgentBoardTool({
      deps, sessionId: child.sessionId, aborts: new Map(), plannedContinuation: false,
      effect: { kind: 'call_tool', callId: 'fenced-board', name: 'agent_board',
        input: { operation: 'post', topic: 'secret', content: 'must not be split across replicas' } },
    })
    expect(board.ok).toBe(true)
    expect(inspectAgentBoard(parent.sessionId).entries).toHaveLength(1)
    const launched = await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'fenced-agent', name: 'agent',
      input: { prompt: 'background', mode: 'background' },
    }, new Map())
    expect(launched.ok).toBe(false)
    expect(await store.listChildren(parent.sessionId)).toHaveLength(1)
    const read = await runReadAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'fenced-read', name: 'read_agent', input: { agent_id: child.sessionId },
    })
    const write = await runWriteAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'fenced-write', name: 'write_agent',
      input: { agent_id: child.sessionId, message: 'follow up' },
    }, new Map())
    expect(read.content).toContain('durable child inbox')
    expect(write.content).toContain('durable child inbox')
    expect(write.ok).toBe(false)

    delete deps.assertSessionEffectOwner
    store.usesSharedSessionAuthority = () => true
    expect((await runAgentBoardTool({
      deps, sessionId: parent.sessionId, aborts: new Map(), plannedContinuation: false,
      effect: { kind: 'call_tool', callId: 'pg-board', name: 'agent_board',
        input: { operation: 'claim_file', path: 'src/unsafe.ts' } },
    })).ok).toBe(true)
    expect((await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'pg-background', name: 'agent',
      input: { prompt: 'background', mode: 'background' },
    }, new Map())).ok).toBe(false)
    expect((await runReadAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'pg-read', name: 'read_agent', input: { agent_id: child.sessionId },
    })).ok).toBe(false)
    expect((await runWriteAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'pg-write', name: 'write_agent',
      input: { agent_id: child.sessionId, message: 'follow up' },
    }, new Map())).ok).toBe(false)
  })

  it('accepts shared-owner follow-ups into the durable inbox and reports an unresolved head without claiming success', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'owner-parent', config: { tools: createBuiltinTools() } })
    const child = await store.create({ sessionId: 'owner-child-followup', parentSessionId: parent.sessionId,
      config: { tools: createBuiltinTools() } })
    const commands: Array<import('../store/child-command-state.js').ChildCommand> = []
    Object.defineProperty(store, 'childCommandInbox', { value: {
      enqueueChildCommand: async (parentSessionId: string, childSessionId: string, commandId: string,
        kind: 'message', message: string) => {
        const command = { parentSessionId, childSessionId, commandId, kind, message, status: 'pending' as const }
        commands.push(command)
        return command
      },
      readChildCommands: async () => commands,
    } })
    const deps = { store, assertSessionEffectOwner: async () => ({ ownerGeneration: '2' }) } as unknown as HostLoopDeps
    const queued = await runWriteAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'stable-command', name: 'write_agent',
      input: { agent_id: child.sessionId, message: 'follow up', mode: 'background' },
    }, new Map())
    expect(queued.ok).toBe(true)
    expect(commands).toMatchObject([{ commandId: 'stable-command', message: 'follow up', status: 'pending' }])
    const status = await runReadAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'status', name: 'read_agent', input: { agent_id: child.sessionId },
    })
    expect(status.content).toContain('stable-command')
    expect(status.content).toContain('queued')
  })

  it('creates a shared child with an initial durable command and queues steering behind its running head', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'shared-create-parent', agentRuntime: 'copilot', organizationId: 'tenant-a',
      principal: 'operator-a', organizationRole: 'member', config: { tools: createBuiltinTools(), maxAgentFanOut: 2 } })
    const commands: Array<import('../store/child-command-state.js').ChildCommand> = []
    const placements: string[] = []
    store.countCompletedChildModelTurns = async (_sessionId, commandId) =>
      commands.find((command) => command.commandId === commandId)?.status === 'completed' ? 1 : 0
    store.usesSharedSessionAuthority = () => true
    store.createChildWithCommand = async (params, commandId, message) => {
      placements.push(params.preferredChildReplicaId ?? '')
      const child = await store.create(params)
      commands.push({ parentSessionId: parent.sessionId, childSessionId: child.sessionId,
        commandId, kind: 'message', message, status: 'pending' })
      return child
    }
    Object.defineProperty(store, 'childCommandInbox', { value: {
      readChildCommands: async () => commands,
      enqueueChildCommand: async (parentSessionId: string, childSessionId: string, commandId: string,
        kind: 'message', message: string) => {
        const command = { parentSessionId, childSessionId, commandId, kind, message, status: 'pending' as const }
        commands.push(command)
        return command
      },
    } })
    const handoffs: string[] = []
    const deps = {
      store, assertSessionEffectOwner: async () => ({ ownerGeneration: '1' }),
      chooseChildReplicaId: async () => 'replica-b',
      handoffChildOwner: async (id: string, replica: string) => { handoffs.push(`${id}:${replica}`) },
      broadcast: { onSubAgentStarted() {} },
    } as unknown as HostLoopDeps
    const launched = await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'initial-command', name: 'agent',
      input: { prompt: 'initial prompt', mode: 'background' },
    }, new Map())
    expect(launched.content).toContain('status="running"')
    const childId = launched.content.match(/session_id="([^"]+)"/)![1]!
    expect(placements).toEqual(['replica-b'])
    expect(handoffs).toEqual([`${childId}:replica-b`])
    expect(commands).toMatchObject([{ childSessionId: childId, commandId: 'initial-command', message: 'initial prompt' }])
    commands[0]!.status = 'claimed'
    commands[0]!.dispatchedAt = new Date().toISOString()
    const child = store.get(childId)!
    expect(child).toMatchObject({ organizationId: 'tenant-a', principal: 'operator-a', organizationRole: 'member' })
    child.state.status = 'thinking'
    const steering = await runWriteAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'steering-command', name: 'write_agent',
      input: { agent_id: childId, message: 'steer next', mode: 'background' },
    }, new Map())
    expect(steering.ok).toBe(true)
    expect(commands.map((command) => command.commandId)).toEqual(['initial-command', 'steering-command'])
    expect(await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'initial-command', name: 'agent',
      input: { prompt: 'initial prompt', mode: 'background' },
    }, new Map())).toMatchObject({ ok: true, content: expect.stringContaining(childId) })
    expect(commands).toHaveLength(2)
    const finish = setTimeout(() => {
      child.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'durable child answer' }],
        metadata: { kind: 'temporal', messageId: 'child-answer', turnId: 'initial-command',
          createdAt: new Date().toISOString(), turnStartedAt: new Date().toISOString() } })
      child.state.status = 'done'
      commands[0]!.status = 'completed'
      commands[0]!.outcome = { ok: true, content: 'terminal turn persisted' }
    }, 20)
    try {
      const completed = await runAgentTool(deps, parent.sessionId, {
        kind: 'call_tool', callId: 'initial-command', name: 'agent',
        input: { prompt: 'initial prompt', mode: 'sync' },
      }, new Map())
      expect(completed.content).toContain('status="completed"')
      expect(completed.content).toContain('durable child answer')
      expect(completed.content).toContain('turns="1"')
    } finally { clearTimeout(finish) }
    child.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'later steering answer' }],
      metadata: { kind: 'temporal', messageId: 'steering-answer', turnId: 'steering-command',
        createdAt: new Date().toISOString(), turnStartedAt: new Date().toISOString() } })
    commands[1]!.status = 'completed'
    commands[1]!.outcome = { ok: true, content: 'later terminal turn persisted' }
    const retried = await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'initial-command', name: 'agent',
      input: { prompt: 'initial prompt', mode: 'background' },
    }, new Map())
    expect(retried.content).toContain('durable child answer')
    expect(retried.content).not.toContain('later steering answer')
    expect(retried.content).toContain('turns="1"')
  })

  it('authorizes and persists a canonical shared child model instead of accepting an unchecked override', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'model-parent', organizationId: 'tenant-a',
      principal: 'operator-a', config: { tools: createBuiltinTools() } })
    store.usesSharedSessionAuthority = () => true
    const commands: Array<import('../store/child-command-state.js').ChildCommand> = []
    store.createChildWithCommand = async (params, commandId, message) => {
      const child = await store.create(params)
      commands.push({ parentSessionId: parent.sessionId, childSessionId: child.sessionId,
        commandId, kind: 'message', message, status: 'pending' })
      return child
    }
    Object.defineProperty(store, 'childCommandInbox', { value: { readChildCommands: async () => commands } })
    const approvals: Array<{ organizationId: string; sessionId: string; model: string; principal?: string }> = []
    const deps = { store, normalizeAgentModel: (model: string) => model === 'friendly' ? 'provider/model-v1' : undefined,
      modelPolicy: { assertCanUseModel: async (request: typeof approvals[number]) => { approvals.push(request) } },
      assertSessionEffectOwner: async () => ({ ownerGeneration: '1' }),
      broadcast: { onSubAgentStarted() {} } } as unknown as HostLoopDeps
    const input = (callId: string, model: string) => ({
      kind: 'call_tool' as const, callId, name: 'agent', input: { prompt: 'work', model, mode: 'background' },
    })
    expect((await runAgentTool(deps, parent.sessionId, input('unknown', 'not-advertised'), new Map())).ok).toBe(false)
    expect(await store.listChildren(parent.sessionId)).toHaveLength(0)
    const launched = await runAgentTool(deps, parent.sessionId, input('allowed', 'friendly'), new Map())
    expect(launched.ok).toBe(true)
    const childId = launched.content.match(/session_id="([^"]+)"/)![1]!
    expect(store.get(childId)?.preferences.selectedModel).toBe('provider/model-v1')
    expect(approvals).toEqual([{ organizationId: 'tenant-a', sessionId: childId,
      model: 'provider/model-v1', principal: 'operator-a' }])
    expect((await runAgentTool(deps, parent.sessionId, input('allowed', 'not-advertised'), new Map())).ok).toBe(false)
  })

  it('spawns a sub-agent in background mode, queues live steering via write_agent, awaits via read_agent, and resumes warm context in-place', async () => {
    const store = new SessionStore(dir)
    const tools = createBuiltinTools()
    const parent = await store.create({
      sessionId: 'parent-bg-1',
      config: { tools },
    })

    let llmCallNumber = 0
    const deps: HostLoopDeps = {
      store,
      llm: {
        name: 'mock-llm',
        async call({ messages }) {
          llmCallNumber += 1
          await new Promise((r) => setTimeout(r, 35))
          const userTexts = messages
            .filter((m) => m.role === 'user')
            .flatMap((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text))
          return {
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: `Reply #${llmCallNumber}; seen_user_turns=${userTexts.length}; latest="${userTexts.at(-1)}"`,
              }],
            },
            finishReason: 'stop',
          }
        },
      },
      tools: {
        async callTool() {
          return { ok: true, content: 'ok' }
        },
      },
      broadcast: {
        onStateChanged() {},
        onApprovalRequired() {},
        onError() {},
      },
    }

    const loop = runHostLoop(deps)
    const aborts = new Map<string, AbortController>()

    // 1. Launch sub-agent in background mode
    const bgStart = await runAgentTool(
      deps,
      parent.sessionId,
      {
        kind: 'call_tool',
        callId: 'call-bg-1',
        name: 'agent',
        input: {
          prompt: 'Initial research task',
          mode: 'background',
          role: 'research',
          intention: 'Investigate initial auth module structure',
        },
      },
      aborts,
      loop,
    )

    expect(bgStart.ok).toBe(true)
    expect(bgStart.content).toContain('status="running"')
    const match = bgStart.content.match(/session_id="([^"]+)"/)
    expect(match).toBeTruthy()
    const childId = match![1]!

    // 2. While running in background, send a live steering message via write_agent (background queue)
    const steerQueueRes = await runWriteAgentTool(
      deps,
      parent.sessionId,
      {
        kind: 'call_tool',
        callId: 'call-steer-1',
        name: 'write_agent',
        input: {
          agent_id: childId,
          message: 'Steering update: also check token refresh logic',
          mode: 'background',
        },
      },
      aborts,
      loop,
    )
    expect(steerQueueRes.ok).toBe(true)
    expect(steerQueueRes.content).toContain('Queued live steering message')

    // 3. Await full completion (initial turn + steered turn) via read_agent { wait: true }
    const waitedRes = await runReadAgentTool(
      deps,
      parent.sessionId,
      {
        kind: 'call_tool',
        callId: 'call-read-1',
        name: 'read_agent',
        input: {
          agent_id: childId,
          wait: true,
          timeout_ms: 5_000,
        },
      },
    )
    expect(waitedRes.ok).toBe(true)
    expect(waitedRes.content).toContain('status="completed"')
    expect(waitedRes.content).toContain('turns="2"')
    expect(waitedRes.content).toContain('seen_user_turns=2')
    expect(waitedRes.content).toContain('Steering update: also check token refresh logic')

    // 4. Now that the child sub-agent is resting ('done'), resume it in-place with write_agent (warm context reuse)
    const warmResumeRes = await runWriteAgentTool(
      deps,
      parent.sessionId,
      {
        kind: 'call_tool',
        callId: 'call-resume-1',
        name: 'write_agent',
        input: {
          agent_id: childId,
          message: 'Follow-up on warm session: summarize in one line',
          mode: 'sync',
        },
      },
      aborts,
      loop,
    )
    expect(warmResumeRes.ok).toBe(true)
    expect(warmResumeRes.content).toContain('status="completed"')
    expect(warmResumeRes.content).toContain('turns="3"')
    expect(warmResumeRes.content).toContain('seen_user_turns=3')
    expect(warmResumeRes.content).toContain('Follow-up on warm session: summarize in one line')
  })

  it('stops a background child after its parent has returned to rest', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'resting-parent', config: { tools: createBuiltinTools() } })
    let childStarted!: () => void
    const started = new Promise<void>((resolve) => { childStarted = resolve })
    const deps: HostLoopDeps = {
      store,
      llm: {
        name: 'blocked-child',
        async call({ signal }) {
          childStarted()
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
          throw new Error('unreachable')
        },
      },
      tools: { async callTool() { return { ok: true, content: 'ok' } }, cancelPending() {} },
      broadcast: { onStateChanged() {}, onApprovalRequired() {}, onError() {} },
    }
    const loop = runHostLoop(deps)
    const launched = await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'background-stop', name: 'agent',
      input: { prompt: 'keep working', mode: 'background' },
    }, new Map(), loop)
    const childId = launched.content.match(/session_id="([^"]+)"/)![1]!
    await started
    expect(store.get(parent.sessionId)?.state.status).toBe('idle')
    await loop.dispatch(parent.sessionId, { kind: 'cancel' })
    const outcome = await runReadAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'read-stopped', name: 'read_agent',
      input: { agent_id: childId, wait: true, timeout_ms: 5_000 },
    })
    expect(outcome.content).toContain('status="cancelled"')
  })

  it('does not interrupt children of another parent or another store with the same parent ID', async () => {
    const firstStore = new SessionStore(join(dir, 'first'))
    const secondStore = new SessionStore(join(dir, 'second'))
    const createBlocked = async (store: SessionStore, parentId: string, callId: string) => {
      const parent = await store.create({ sessionId: parentId, config: { tools: createBuiltinTools() } })
      let notifyStarted!: () => void
      const started = new Promise<void>((resolve) => { notifyStarted = resolve })
      const deps: HostLoopDeps = {
        store,
        llm: {
          name: 'blocked',
          async call({ signal }) {
            notifyStarted()
            await new Promise<void>((_, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
            throw new Error('unreachable')
          },
        },
        tools: { async callTool() { return { ok: true, content: 'ok' } }, cancelPending() {} },
        broadcast: { onStateChanged() {}, onApprovalRequired() {}, onError() {} },
      }
      const loop = runHostLoop(deps)
      const launched = await runAgentTool(deps, parent.sessionId, {
        kind: 'call_tool', callId, name: 'agent', input: { prompt: 'wait', mode: 'background' },
      }, new Map(), loop)
      await started
      return { deps, loop, parentId, childId: launched.content.match(/session_id="([^"]+)"/)![1]! }
    }
    const first = await createBlocked(firstStore, 'shared-id', 'first-call')
    const otherParent = await createBlocked(firstStore, 'other-parent', 'other-call')
    const otherStore = await createBlocked(secondStore, 'shared-id', 'second-call')
    await first.loop.dispatch(first.parentId, { kind: 'cancel' })
    for (const unaffected of [otherParent, otherStore]) {
      const status = await runReadAgentTool(unaffected.deps, unaffected.parentId, {
        kind: 'call_tool', callId: 'check', name: 'read_agent', input: { agent_id: unaffected.childId },
      })
      expect(status.content).toContain('status="running"')
      await unaffected.loop.dispatch(unaffected.parentId, { kind: 'cancel' })
    }
  })

  it('refuses Stop when the child owner has moved instead of cancelling an unfenced child', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'owner-moved-parent', config: { tools: createBuiltinTools() } })
    let started!: () => void
    const waiting = new Promise<void>((resolve) => { started = resolve })
    const deps: HostLoopDeps = {
      store,
      llm: {
        name: 'child-owner-change',
        async call({ signal }) {
          started()
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
          throw new Error('unreachable')
        },
      },
      tools: { async callTool() { return { ok: true, content: 'ok' } }, cancelPending() {} },
      broadcast: { onStateChanged() {}, onApprovalRequired() {}, onError() {} },
    }
    const loop = runHostLoop(deps)
    const startedChild = await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'moved-child', name: 'agent', input: { prompt: 'wait', mode: 'background' },
    }, new Map(), loop)
    const childId = startedChild.content.match(/session_id="([^"]+)"/)![1]!
    await waiting
    deps.assertSessionEffectOwner = async (id) => {
      if (id === childId) throw new Error('owner moved')
    }
    await expect(loop.dispatch(parent.sessionId, { kind: 'cancel' })).rejects.toThrow('owner moved')
    expect(store.get(childId)?.state.status).not.toBe('idle')
    delete deps.assertSessionEffectOwner
    await loop.dispatch(parent.sessionId, { kind: 'cancel' })
    expect((await runReadAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'moved-read', name: 'read_agent',
      input: { agent_id: childId, wait: true },
    })).content).toContain('status="cancelled"')
  })

  it('enforces a fresh timeout on a resumed child without counting its prior turns', async () => {
    const store = new SessionStore(dir)
    const parent = await store.create({ sessionId: 'resume-budget-parent', config: { tools: createBuiltinTools() } })
    let calls = 0
    const deps: HostLoopDeps = {
      store,
      llm: {
        name: 'resumed-block',
        async call({ signal }) {
          calls++
          if (calls === 1) return {
            message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'first answer' }] },
            finishReason: 'stop' as const,
          }
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
          throw new Error('unreachable')
        },
      },
      tools: { async callTool() { return { ok: true, content: 'ok' } }, cancelPending() {} },
      broadcast: { onStateChanged() {}, onApprovalRequired() {}, onError() {} },
    }
    const loop = runHostLoop(deps)
    const initial = await runAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'initial-budget', name: 'agent', input: { prompt: 'first' },
    }, new Map(), loop)
    const childId = initial.content.match(/session_id="([^"]+)"/)![1]!
    const resumed = await runWriteAgentTool(deps, parent.sessionId, {
      kind: 'call_tool', callId: 'followup-budget', name: 'write_agent',
      input: { agent_id: childId, message: 'second', max_turns: 1, timeout_ms: 10 },
    }, new Map(), loop)
    expect(resumed.content).toContain('absolute-deadline')
    expect(resumed.content).not.toContain('status="completed"')
  })
})
