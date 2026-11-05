import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig, step } from '@agent-kernel/kernel'
import { PROTOCOL_VERSION, type ClientGoalControl, type RpcAck, type SessionGoal } from '@agent-kernel/shared'

import { SessionStore } from './store/session.js'
import { SqliteSessionAuthority } from './store/sqlite-session-authority.js'
import { runHostLoop } from './loop.js'
import type { HostLoopDeps } from './loop.js'
import type { LLMCallParams } from './llm/adapter.js'
import { configureDashboardNamespace, type DashboardDeps, type DashboardNs } from './connection/dashboard-ns.js'

const root = join(process.cwd(), `.goal-test-data-${process.pid}`)
const config = createConfig({ tools: [], systemPrompt: 'Goal test' })
const goal = (maxTurns = 2): SessionGoal => ({
  objective: 'Write a concise answer',
  successCriteria: 'Answer is complete',
  maxTurns,
  turns: 0,
  status: 'active',
  lastTerminalCursor: 0,
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('durable Session Goal', () => {
  async function goalControl(
    store: SessionStore,
    broadcasts: Array<{ room: string; event: string; payload: unknown }>,
    route?: { sessionId: string; assertOwner: (sessionId: string) => Promise<void>; role?: 'member' | 'viewer' },
  ): Promise<(payload: ClientGoalControl) => Promise<RpcAck>> {
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const connectionErrors: string[] = []
    let connect: ((socket: unknown) => void) | undefined
    let authorize: ((socket: unknown, next: (error?: Error) => void) => void) | undefined
    const socketMiddlewares: Array<(args: [string, ClientGoalControl, (result: RpcAck) => void], next: (error?: Error) => void) => void> = []
    const namespace = {
      use(handler: (socket: unknown, next: (error?: Error) => void) => void) { authorize = handler; return this },
      on(event: string, handler: (...args: never[]) => unknown) {
        if (event === 'connection') connect = handler as (socket: unknown) => void
        return this
      },
    } as unknown as DashboardNs
    configureDashboardNamespace(namespace, {
      store,
      loopDeps: { store, ...(route ? { assertSessionEffectOwner: route.assertOwner } : {}) },
      loop: { isDraining: () => false, hasActiveTurn: () => false },
      agentRuntimes: { catalog: () => [], get: () => undefined },
      defaultConfig: config,
      executors: {},
      ...(route ? { auth: { requireIngressIdentity: true } } : {}),
      dashboardNs: {
        to(room: string) {
          return {
            emit(event: string, payload: unknown) {
              broadcasts.push({ room, event, payload })
            },
          }
        },
      },
      messageQueues: { pending: () => 0, hydrate: async () => {}, snapshot: () => ({}), drain: async () => {} },
      audit: { log(entry: { error?: string }) { if (entry.error) connectionErrors.push(entry.error) } },
    } as unknown as DashboardDeps)
    const socket = {
      id: 'goal-control-test',
      connected: true,
      handshake: {
        auth: route
          ? { sessionId: route.sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }
          : { clientId: 'goal-tests', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
        headers: route ? { 'x-agent-runlab-route-session-id': route.sessionId } : {},
      },
      request: { headers: route ? {
        'x-agent-runlab-principal': 'member-test',
        'x-agent-runlab-organization-id': 'org-a',
        'x-agent-runlab-organization-role': route.role ?? 'member',
      } : {} },
      data: route ? {} : { dashboardActor: { kind: 'token' } },
      emit() {},
      use(handler: (args: [string, ClientGoalControl, (result: RpcAck) => void], next: (error?: Error) => void) => void) {
        socketMiddlewares.push(handler)
      },
      join: async () => {},
      disconnect() { connectionErrors.push('disconnected') },
      on(event: string, handler: (...args: never[]) => unknown) { handlers.set(event, handler) },
    }
    if (route) {
      if (!authorize) throw new Error('Dashboard route authentication middleware was not registered')
      let authError: Error | undefined
      authorize(socket, (error) => { authError = error })
      if (authError) throw authError
    }
    connect?.(socket)
    await vi.waitFor(() => {
      if (connectionErrors.length) throw new Error(connectionErrors.join(', '))
      expect(handlers.has('client:goal_control')).toBe(true)
    })
    const handler = handlers.get('client:goal_control') as
      | ((payload: ClientGoalControl, ack: (result: RpcAck) => void) => void)
      | undefined
    if (!handler) throw new Error('Goal control handler was not registered')
    return (payload) => new Promise<RpcAck>((resolve) => {
      let index = 0
      const next = (error?: Error): void => {
        if (error) { resolve({ ok: false, error: error.message }); return }
        const middleware = socketMiddlewares[index++]
        if (middleware) middleware(['client:goal_control', payload, resolve], next)
        else handler(payload, resolve)
      }
      next()
    })
  }

  it('durably records user acceptance of model completion and rejects unrelated terminal controls', async () => {
    for (const storage of ['jsonl', 'sqlite'] as const) {
      mkdirSync(root, { recursive: true })
      const authority = storage === 'sqlite' ? new SqliteSessionAuthority(join(root, 'goal.sqlite')) : undefined
      try {
        const options = authority ? { authority } : {}
        const store = new SessionStore(join(root, 'sessions'), options)
        const record = await store.create({ sessionId: storage, config, goal: goal() })
        await store.updateGoal(record.sessionId, (current) => ({
          ...current, status: 'completed', completionSource: 'model', turns: 1,
        }))
        const broadcasts: Array<{ room: string; event: string; payload: unknown }> = []
        const send = await goalControl(store, broadcasts)
        expect(await send({ sessionId: storage, operationId: 'cannot-cancel-model-completion', action: 'cancel' }))
          .toMatchObject({ ok: false })
        const acceptance = { sessionId: storage, operationId: 'accept-model-goal', action: 'complete' as const }
        expect(await send(acceptance)).toEqual({ ok: true })
        expect(record.goal).toMatchObject({
          status: 'completed', completionSource: 'user', turns: 1,
          lastControl: { operationId: acceptance.operationId, action: 'complete' },
        })

        expect(record.state.cursor).toBe(0)
        expect(broadcasts).toContainEqual({
          room: `session:${storage}`,
          event: 'server:control_update',
          payload: { kind: 'session_summary_changed', session: expect.objectContaining({
            goal: expect.objectContaining({ status: 'completed', completionSource: 'user' }),
          }) },
        })
        expect(await send(acceptance)).toEqual({ ok: true })
        expect(await send({ ...acceptance, action: 'cancel' })).toMatchObject({ ok: false })
        expect(await send({ ...acceptance, operationId: 'another-acceptance' })).toMatchObject({ ok: false })
        const restored = new SessionStore(join(root, 'sessions'), options)
        expect((await restored.load(storage)).goal).toMatchObject({ completionSource: 'user', turns: 1 })
        expect(await (await goalControl(restored, []))(acceptance)).toEqual({ ok: true })
      } finally {
        await authority?.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('accepts Goal controls on a routed owner Session and rejects a different Session ID', async () => {
    mkdirSync(root, { recursive: true })
    const store = new SessionStore(join(root, 'sessions'))
    await store.create({ sessionId: 'routed-goal', config, goal: goal(), organizationId: 'org-a' })
    await store.updateGoal('routed-goal', (current) => ({ ...current, status: 'completed', completionSource: 'model' }))
    const assertOwner = vi.fn(async (_sessionId: string) => {})
    const send = await goalControl(store, [], { sessionId: 'routed-goal', assertOwner })
    expect(await send({ sessionId: 'another-goal', operationId: 'wrong-route', action: 'complete' }))
      .toEqual({ ok: false, error: 'session_route_mismatch' })
    expect(await send({ sessionId: 'routed-goal', operationId: 'accept-routed', action: 'complete' }))
      .toEqual({ ok: true })
    expect(assertOwner).toHaveBeenCalledWith('routed-goal')
    expect(store.get('routed-goal')?.goal?.completionSource).toBe('user')
  })

  it('rejects Goal controls from a read-only ingress socket', async () => {
    mkdirSync(root, { recursive: true })
    const store = new SessionStore(join(root, 'sessions'))
    await store.create({ sessionId: 'viewer-goal', config, goal: goal(), organizationId: 'org-a' })
    const send = await goalControl(store, [], {
      sessionId: 'viewer-goal', role: 'viewer', assertOwner: async () => {},
    })
    expect(await send({ sessionId: 'viewer-goal', operationId: 'viewer-pause', action: 'pause' }))
      .toEqual({ ok: false, error: 'forbidden: runtime:write required' })
    expect(store.get('viewer-goal')?.goal?.status).toBe('active')
  })

  it('creates exactly one Goal and retains progress after reload in both Session authorities', async () => {
    for (const storage of ['jsonl', 'sqlite'] as const) {
      mkdirSync(root, { recursive: true })
      const authority = storage === 'sqlite' ? new SqliteSessionAuthority(join(root, 'goal.sqlite')) : undefined
      try {
        const options = authority ? { authority } : {}
        const store = new SessionStore(join(root, 'sessions'), options)
        const first = await store.ensure({ sessionId: storage, defaultConfig: config, goal: goal() })
        expect(first.created).toBe(true)
        expect(first.record.state.status).toBe('idle')
        expect(first.record.goal?.turns).toBe(0)
        const retry = await store.ensure({ sessionId: storage, defaultConfig: config, goal: goal() })
        expect(retry.created).toBe(false)
        await expect(store.ensure({ sessionId: storage, defaultConfig: config, goal: { ...goal(), objective: 'different' } }))
          .rejects.toThrow('conflicts')
        await store.updateGoal(storage, (current) => ({ ...current, status: 'paused', turns: 1, lastTerminalCursor: 3 }))
        const restored = new SessionStore(join(root, 'sessions'), options)
        expect((await restored.load(storage)).goal).toMatchObject({ status: 'paused', turns: 1, lastTerminalCursor: 3 })
        expect((await restored.listSummaries())[0]?.goal?.status).toBe('paused')
      } finally {
        await authority?.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('continues a settled Goal only up to the turn budget, in the same Session', async () => {
    mkdirSync(root, { recursive: true })
    const store = new SessionStore(join(root, 'sessions'))
    let calls = 0
    const loopDeps = {
      store,
      llm: {
        name: 'goal-test',
        async call() {
          calls += 1
          return {
            message: {
              role: 'assistant' as const,
              content: [{ type: 'text' as const, text: calls === 3 ? 'Criteria satisfied.\nGOAL_COMPLETE' : `step ${calls}` }],
            },
          }
        },
      },
      tools: { callTool: async () => ({ ok: true, content: '' }), cancelPending: () => {} },
      broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
    }
    const loop = runHostLoop(loopDeps)
    const summaries: unknown[] = []
    configureDashboardNamespace({
      use() { return this },
      on() { return this },
    } as unknown as DashboardNs, {
      store, loop, loopDeps,
      dashboardNs: { to() { return { emit(_event: string, value: unknown) { summaries.push(value) } } } },
      mutableReady: () => true,
      messageQueues: { pending: () => 0 },
    } as unknown as DashboardDeps)
    await store.create({ sessionId: 'goal-budget', config, goal: goal() })
    await Promise.resolve()
    expect(calls).toBe(0)
    await loop.dispatch('goal-budget', { kind: 'user_message', text: 'Write a concise answer', operationId: 'initial-goal-turn' })
    await vi.waitFor(() => expect(store.get('goal-budget')?.goal?.status).toBe('budget_exhausted'))
    await loop.waitForActiveTurn('goal-budget')
    expect(store.get('goal-budget')?.goal?.turns).toBe(2)
    expect(calls).toBe(2)
    const history = await store.readHistory('goal-budget')
    expect(history.events.filter((entry) => entry.event.kind === 'user_message')).toHaveLength(2)
    expect(summaries.length).toBeGreaterThan(0)
    await store.create({ sessionId: 'goal-model', config, goal: goal(3) })
    await loop.dispatch('goal-model', { kind: 'user_message', text: 'Write a concise answer' })
    expect(store.get('goal-model')?.goal).toMatchObject({ status: 'completed', completionSource: 'model', turns: 1 })
    expect(calls).toBe(3)
  })

  it.each(['counted', 'uncounted'] as const)(
    'recovers a %s settled Goal after authorized reattachment without replaying prior effects',
    async (checkpoint) => {
      mkdirSync(root, { recursive: true })
      const sessionId = `restart-${checkpoint}`
      const original = new SessionStore(join(root, 'sessions'))
      await original.create({ sessionId, config, goal: goal() })
      const firstCall = vi.fn(async () => ({
        message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Work in progress' }] },
      }))
      const first = runHostLoop({
        store: original,
        llm: { name: 'before-restart', call: firstCall },
        tools: { callTool: async () => ({ ok: true, content: '' }), cancelPending: () => {} },
        broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
      })
      await first.dispatch(sessionId, { kind: 'user_message', text: 'Initial objective', operationId: 'initial' })
      if (checkpoint === 'counted') {
        await original.updateGoal(sessionId, (current, record) => ({
          ...current, turns: 1, lastTerminalCursor: record.state.cursor,
        }))
      }
      const restarted = new SessionStore(join(root, 'sessions'))
      const record = await restarted.load(sessionId)
      expect(record.state.status).toBe('done')
      const secondCall = vi.fn(async (request: LLMCallParams) => {
        const prompt = request.messages.at(-1)?.content.map((block) => block.type === 'text' ? block.text : '').join('')
        expect(prompt).toContain(goal().objective)
        expect(prompt).toContain(goal().successCriteria)
        return { message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Further work' }] } }
      })
      const assertOwner = vi.fn(async (_sessionId: string) => {})
      const loopDeps: HostLoopDeps = {
        store: restarted,
        llm: { name: 'after-restart', call: secondCall },
        tools: { callTool: async () => ({ ok: true, content: '' }), cancelPending: () => {} },
        broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
        assertSessionEffectOwner: assertOwner,
      }
      const loop = runHostLoop(loopDeps)
      configureDashboardNamespace({ use() { return this }, on() { return this } } as unknown as DashboardNs, {
        store: restarted, loop, loopDeps, mutableReady: () => true,
        messageQueues: { pending: () => 0 },
        dashboardNs: { to() { return { emit() {} } } },
      } as unknown as DashboardDeps)
      await loopDeps.onGoalReconnected?.(sessionId)
      await vi.waitFor(() => expect(restarted.get(sessionId)?.goal?.status).toBe('budget_exhausted'))
      await loop.waitForActiveTurn(sessionId)
      await loopDeps.onGoalReconnected?.(sessionId)
      expect(firstCall).toHaveBeenCalledTimes(1)
      expect(secondCall).toHaveBeenCalledTimes(1)
      expect(assertOwner).toHaveBeenCalledWith(sessionId)
      expect((await restarted.readHistory(sessionId)).events.filter((entry) => entry.event.kind === 'user_message')).toHaveLength(2)
    },
  )

  it('does not replay a dangling Goal turn after restart', async () => {
    mkdirSync(root, { recursive: true })
    const original = new SessionStore(join(root, 'sessions'))
    const record = await original.create({ sessionId: 'goal-uncertain', config, goal: goal() })
    const event = { kind: 'user_message' as const, text: 'Write a concise answer', operationId: 'initial-goal-turn' }
    const { next, effects } = step(record.state, event, config)
    await original.record(record.sessionId, event, effects, next)
    const restarted = new SessionStore(join(root, 'sessions'))
    const recovered = await restarted.load(record.sessionId)
    expect(recovered.state.status).toBe('thinking')
    const llm = vi.fn(async () => ({ message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'unsafe replay' }] } }))
    const loop = runHostLoop({
      store: restarted,
      llm: { name: 'must-not-replay', call: llm },
      tools: { callTool: async () => ({ ok: true, content: '' }), cancelPending: () => {} },
      broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
    })
    expect(await loop.resumeSession(record.sessionId)).toBe(false)
    expect(llm).not.toHaveBeenCalled()
    expect((await restarted.listSummaries())[0]?.goal?.status).toBe('paused')
    expect(recovered.goal?.turns).toBe(0)
  })
})
