import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bashTool, createSandbox } from '@agent-kernel/executor'
import { arenaGitInitTool, arenaGitApplyTool, arenaGitCleanupTool } from '../../../executor/src/tools/arena-git-mutation.js'
import { arenaGitProbeTool } from '../../../executor/src/tools/arena-git-probe.js'
import type { CallToolEffect } from '@agent-kernel/kernel'
import { createConfig } from '@agent-kernel/kernel'

import { builtinTools } from '../builtin-tools.js'
import type { HostLoopDeps, ToolDispatcher } from '../loop-types.js'
import { SessionStore } from '../store/session.js'
import { SqliteSessionAuthority } from '../store/sqlite-session-authority.js'
import { runWorktreeArenaTool } from './worktree-arena.js'

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(process.cwd(), 'kala-arena-repo-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n', 'utf8')
  execFileSync('git', ['add', 'app.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir })
  return dir
}

function makeExecutorToolDispatcher(repoDir: string, store: SessionStore): ToolDispatcher {
  const sandbox = createSandbox({ roots: [repoDir] })
  const execute = async (sessionId: string, eff: CallToolEffect, shellApprovalVerified = false) => {
    try {
      const content = await bashTool.run(eff.input, {
        sandbox, cwd: repoDir, sessionId, callId: eff.callId,
        signal: new AbortController().signal, ...(shellApprovalVerified ? { shellApprovalVerified: true } : {}),
      })
      return { ok: true, content }
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err) }
    }
  }
  return {
    async callTool(sessionId: string, eff: CallToolEffect) {
      if (eff.name !== 'bash' && eff.name !== 'shell') {
        return { ok: false, content: `unsupported tool: ${eff.name}` }
      }
      return await execute(sessionId, eff)
    },
    async callArenaShell(sessionId: string, parentCallId: string, eff: CallToolEffect) {
      const parent = store.get(sessionId)?.state.pendingCalls.find((call) =>
        call.callId === parentCallId && call.name === 'worktree_arena'
        && call.status === 'dispatched' && call.explicitlyApproved === true)
      if (!parent || eff.name !== 'bash' || !eff.callId.startsWith('arena-')) {
        return { ok: false, content: 'No explicitly approved Arena parent' }
      }
      return await execute(sessionId, eff, true)
    },
    cancelPending() {},
  }
}

describe('worktree_arena tool', () => {
  let repoDir: string
  let storeDir: string

  beforeEach(() => {
    repoDir = initTempGitRepo()
    storeDir = mkdtempSync(join(process.cwd(), 'kala-arena-store-'))
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(storeDir, { recursive: true, force: true })
  })

  function makeDeps(store: SessionStore): HostLoopDeps {
    return {
      store,
      llm: { async complete() { throw new Error('unused') } },
      tools: makeExecutorToolDispatcher(repoDir, store),
      broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
    }
  }

  async function call(deps: HostLoopDeps, sessionId: string, input: Record<string, unknown>,
    callId = `test-${String(input.action)}`) {
    const record = deps.requireArenaEffectBarrier ? undefined : deps.store.get(sessionId)
    const parent = { callId, name: 'worktree_arena', status: 'dispatched' as const,
      input, explicitlyApproved: true }
    record?.state.pendingCalls.push(parent)
    try {
      return await runWorktreeArenaTool(deps, sessionId, {
        kind: 'call_tool', callId, name: 'worktree_arena', input,
      })
    } finally {
      if (record) record.state.pendingCalls = record.state.pendingCalls.filter((call) => call !== parent)
    }
  }

  it('refuses Portable synthetic Bash without a matching, explicitly approved parent', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'portable-unapproved',
      config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const deps = makeDeps(store)
    const effect = { kind: 'call_tool' as const, callId: 'unapproved', name: 'worktree_arena',
      input: { action: 'init', arena_id: 'unapproved', candidates: ['one'] } }
    expect(await runWorktreeArenaTool(deps, record.sessionId, effect)).toMatchObject({ ok: false })
    record.state.pendingCalls.push({ callId: 'unapproved', name: 'worktree_arena',
      status: 'dispatched', input: effect.input, explicitlyApproved: false })
    expect(await runWorktreeArenaTool(deps, record.sessionId, effect)).toMatchObject({ ok: false })
    record.state.pendingCalls[0]!.explicitlyApproved = true
    expect(await runWorktreeArenaTool(deps, record.sessionId, {
      ...effect, input: { ...effect.input, arena_id: 'different' },
    })).toMatchObject({ ok: false })
    expect(existsSync(join(repoDir, '.kala-arena'))).toBe(false)
  })

  it('does not dispatch synthetic Bash for PostgreSQL-owned Sessions without final-effect and parent-call authorization', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({
      sessionId: 'pg-owned-arena',
      config: createConfig({ systemPrompt: 'test', tools: builtinTools }),
    })
    let dispatched = 0
    let registered = 0
    const deps: HostLoopDeps = {
      ...makeDeps(store),
      requireArenaEffectBarrier: true,
      assertSessionEffectOwner: async () => ({ ownerGeneration: '1' }),
      registerArenaEffect: async () => { registered++; throw new Error('unapproved parent cannot register') },
      tools: {
        async callTool() { dispatched++; throw new Error('Bash must not be admitted') },
        cancelPending() {},
      },
    }
    for (const action of ['init', 'status', 'diff', 'apply', 'cleanup']) {
      const result = await call(deps, record.sessionId, { action, arena_id: 'blocked', candidates: ['one'] })
      expect(result).toMatchObject({ ok: false })
      expect(result.content).toContain('No command was dispatched')
    }
    expect(dispatched).toBe(0)
    expect(registered).toBe(0)
    expect(await store.findLatestRuntimeMetadata(record.sessionId, 'worktree_arena.state')).toBeUndefined()
    expect(existsSync(join(repoDir, '.kala-arena'))).toBe(false)
  })

  it('dispatches approved named PG init/apply/cleanup after registration and persists state before completion', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({
      sessionId: 'pg-named-mutations',
      config: createConfig({ systemPrompt: 'test', tools: builtinTools }),
    })
    const sandbox = createSandbox({ roots: [repoDir] })
    let active = false
    let registrations = 0
    let completions = 0
    let simulateUnknown = false
    let pendingInput: Record<string, unknown> = {}
    let pendingAction = ''
    const deps: HostLoopDeps = {
      ...makeDeps(store),
      requireArenaEffectBarrier: true,
      store: {
        ...store,
        get: () => ({ ...record, workspaceId: 'pg-workspace', state: {
          ...record.state, pendingCalls: [{ callId: `test-${pendingAction}`, name: 'worktree_arena', status: 'dispatched', input: pendingInput }],
        } }),
        findLatestRuntimeMetadata: store.findLatestRuntimeMetadata.bind(store),
        appendRuntimeMetadata: store.appendRuntimeMetadata.bind(store),
      } as HostLoopDeps['store'],
      assertSessionEffectOwner: async () => ({ ownerGeneration: '1' }),
      registerArenaEffect: async (_session, generation, id, workspace) => {
        expect(generation).toBe('1')
        expect(workspace).toBe('pg-workspace')
        expect(id).toMatch(/^arena-(probe|init|apply|cleanup)-/)
        expect(active).toBe(false)
        active = true
        registrations++
        return async () => {
          expect(active).toBe(true)
          if (!id.startsWith('arena-probe-')) {
            expect(await store.findLatestRuntimeMetadata(record.sessionId, 'worktree_arena.state')).toBeDefined()
          }
          active = false
          completions++
        }
      },
      claimArenaRepository: async (_session, generation, identity, arenaId) => {
        expect(generation).toBe('1')
        expect(identity).toMatch(/^git-common-inode:\d+:\d+$/)
        expect(arenaId).toMatch(/^(named|uncertain)$/)
      },
      prepareArenaInitEffect: async (session, generation, id, workspace, identity, arenaId) => {
        await deps.claimArenaRepository!(session, generation, identity, arenaId)
        const complete = await deps.registerArenaEffect!(session, generation, id, workspace, identity, arenaId)
        return async () => await complete()
      },
      tools: {
        async callTool(sessionId, effect) {
          expect(active).toBe(true)
          expect(effect.name).toMatch(/^arena_git_(probe|init|apply|cleanup)$/)
          expect(effect.input.parentCallId).toBe(`test-${pendingAction}`)
          expect(effect.input.ownerGeneration).toBe('1')
          if (simulateUnknown && effect.name === 'arena_git_apply') {
            return { ok: false, content: 'Executor acknowledgement lost', failure: {
              code: 'execution_unknown', category: 'infrastructure',
              outcome: 'indeterminate', retryable: false, responsibility: 'system',
            } }
          }
          const tool = [arenaGitProbeTool, arenaGitInitTool, arenaGitApplyTool, arenaGitCleanupTool].find((item) => item.name === effect.name)!
          expect(tool).toBeDefined()
          try {
            return { ok: true, content: await tool.run(effect.input, {
              origin: 'host', sandbox, cwd: effect.cwd ?? repoDir, sessionId,
              callId: effect.callId, signal: new AbortController().signal,
            }) }
          } catch (error) {
            return { ok: false, content: String(error) }
          }
        },
        cancelPending() {},
      },
    }
    const run = async (input: Record<string, unknown>) => {
      pendingInput = input
      pendingAction = String(input.action)
      return await call(deps, record.sessionId, input)
    }
    const init = await run({ action: 'init', arena_id: 'named', candidates: ['one'] })
    expect(init, init.content).toMatchObject({ ok: true })
    const candidate = JSON.parse(init.content).candidates[0] as { worktreePath: string }
    writeFileSync(join(candidate.worktreePath, 'app.ts'), 'winner\n')
    expect(await run({ action: 'apply', candidate_id: 'one', strategy: 'merge' })).toMatchObject({ ok: true })
    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('winner\n')
    expect(await run({ action: 'cleanup' })).toMatchObject({ ok: true })
    expect(existsSync(candidate.worktreePath)).toBe(false)
    expect(registrations).toBe(6)
    expect(completions).toBe(6)
    const second = await run({ action: 'init', arena_id: 'uncertain', candidates: ['one'] })
    expect(second).toMatchObject({ ok: true })
    writeFileSync(join(JSON.parse(second.content).candidates[0].worktreePath as string, 'app.ts'), 'uncertain\n')
    simulateUnknown = true
    const unknown = await run({ action: 'apply', candidate_id: 'one' })
    expect(unknown).toMatchObject({ ok: false, content: expect.stringContaining('effect remains registered') })
    expect(active).toBe(true)
    expect(completions).toBe(9)
    expect((await store.findLatestRuntimeMetadata(record.sessionId, 'worktree_arena.state'))?.payload.arena)
      .toMatchObject({ status: 'applying' })
    expect(await run({ action: 'cleanup' })).toMatchObject({ ok: false })
    expect(registrations).toBe(10)
  })

  it('refuses another session with a colliding arena ID without deleting its worktree or branch', async () => {
    const store = new SessionStore(storeDir)
    const config = createConfig({ systemPrompt: 'test', tools: builtinTools })
    const first = await store.create({ sessionId: 'owner-a', config })
    const second = await store.create({ sessionId: 'owner-b', config })
    const deps = makeDeps(store)
    const created = await call(deps, first.sessionId, { action: 'init', arena_id: 'shared', candidates: ['one'] })
    expect(created.ok).toBe(true)
    const path = (JSON.parse(created.content) as { candidates: Array<{ worktreePath: string }> }).candidates[0]!.worktreePath
    writeFileSync(join(path, 'app.ts'), 'kept\n')

    const collision = await call(deps, second.sessionId, { action: 'init', arena_id: 'shared', candidates: ['one'] })
    expect(collision.ok).toBe(false)
    expect(readFileSync(join(path, 'app.ts'), 'utf8')).toBe('kept\n')
    expect(execFileSync('git', ['branch', '--list', 'kala-arena/shared/one'], { cwd: repoDir, encoding: 'utf8' })).toContain('kala-arena/shared/one')
    expect((await call(deps, first.sessionId, { action: 'cleanup' })).ok).toBe(true)
  })

  it('fails closed on replaced worktree symlinks, leaving external files untouched', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-symlink', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const deps = makeDeps(store)
    const created = await call(deps, record.sessionId, { action: 'init', arena_id: 'linked', candidates: ['one'] })
    expect(created.ok).toBe(true)
    const path = (JSON.parse(created.content) as { candidates: Array<{ worktreePath: string }> }).candidates[0]!.worktreePath
    execFileSync('git', ['worktree', 'remove', '--force', path], { cwd: repoDir })
    const outside = join(storeDir, 'victim')
    writeFileSync(outside, 'safe\n')
    symlinkSync(storeDir, path)

    for (const input of [{ action: 'diff' }, { action: 'apply', candidate_id: 'one' }, { action: 'cleanup' }]) {
      expect((await call(deps, record.sessionId, input)).ok).toBe(false)
      expect(readFileSync(outside, 'utf8')).toBe('safe\n')
    }
  })

  it('refuses a symlinked Git exclude rather than writing to its target', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-exclude', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const outside = join(storeDir, 'victim')
    writeFileSync(outside, 'safe\n')
    rmSync(join(repoDir, '.git', 'info', 'exclude'), { force: true })
    symlinkSync(outside, join(repoDir, '.git', 'info', 'exclude'))
    const result = await call(makeDeps(store), record.sessionId, { action: 'init', arena_id: 'exclude', candidates: ['one'] })
    expect(result.ok).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('safe\n')
    expect(existsSync(join(repoDir, '.kala-arena', 'exclude'))).toBe(false)
  })

  it('does not apply into a dirty or advanced primary worktree and cannot replay a winner', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-apply', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const deps = makeDeps(store)
    const created = await call(deps, record.sessionId, { action: 'init', arena_id: 'conflict', candidates: ['one'] })
    expect(created.ok).toBe(true)
    const path = (JSON.parse(created.content) as { candidates: Array<{ worktreePath: string }> }).candidates[0]!.worktreePath
    writeFileSync(join(path, 'app.ts'), 'winner\n')
    writeFileSync(join(repoDir, 'app.ts'), 'local\n')
    expect((await call(deps, record.sessionId, { action: 'apply', candidate_id: 'one', strategy: 'merge' })).ok).toBe(false)
    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('local\n')
    execFileSync('git', ['checkout', '--', 'app.ts'], { cwd: repoDir })

    expect((await call(deps, record.sessionId, { action: 'apply', candidate_id: 'one', strategy: 'patch' })).ok).toBe(true)
    expect((await call(deps, record.sessionId, { action: 'apply', candidate_id: 'one', strategy: 'patch' })).ok).toBe(false)
    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('winner\n')
    expect((await call(deps, record.sessionId, { action: 'cleanup' })).ok).toBe(true)
  })

  it('records partial initialization so a later owner can clean it without deleting other work', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-partial', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const tools = makeExecutorToolDispatcher(repoDir, store)
    const deps: HostLoopDeps = {
      ...makeDeps(store),
      tools: {
        ...tools,
        async callArenaShell(sessionId, parentCallId, effect) {
          if (String(effect.input.command).includes('git worktree add -b') &&
            String(effect.input.command).includes('/second')) {
            return { ok: false, content: 'Executor disconnected before second add' }
          }
          return tools.callArenaShell!(sessionId, parentCallId, effect)
        },
      },
    }
    const init = await call(deps, record.sessionId, { action: 'init', arena_id: 'partial', candidates: ['first', 'second'] })
    expect(init.ok).toBe(false)
    const state = await store.findLatestRuntimeMetadata(record.sessionId, 'worktree_arena.state')
    expect(state?.payload?.arena).toMatchObject({
      status: 'initializing',
      candidates: [{ status: 'active' }, { status: 'pending' }],
    })
    expect((await call(makeDeps(store), record.sessionId, { action: 'cleanup' })).ok).toBe(true)
    expect(existsSync(join(repoDir, '.kala-arena', 'partial'))).toBe(false)
  })

  it('rejects a command result after owner generation changes without provisioning or recording state', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-generation', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const tools = makeExecutorToolDispatcher(repoDir, store)
    let generation = 'first'
    const deps: HostLoopDeps = {
      ...makeDeps(store),
      assertSessionEffectOwner: async () => ({ ownerGeneration: generation }),
      tools: {
        ...tools,
        async callArenaShell(sessionId, parentCallId, effect) {
          const result = await tools.callArenaShell!(sessionId, parentCallId, effect)
          generation = 'second'
          return result
        },
      },
    }
    const init = await call(deps, record.sessionId, { action: 'init', arena_id: 'fenced', candidates: ['one'] })
    expect(init.ok).toBe(false)
    expect(init.content).toContain('owner generation changed')
    expect(existsSync(join(repoDir, '.kala-arena', 'fenced'))).toBe(false)
    expect(await store.findLatestRuntimeMetadata(record.sessionId, 'worktree_arena.state')).toBeUndefined()
  })

  it('documents the unfenced final effect: an admitted shell can mutate after owner transfer', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-inflight', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const tools = makeExecutorToolDispatcher(repoDir, store)
    let generation = 'first'
    let transferred = false
    const deps: HostLoopDeps = {
      ...makeDeps(store),
      assertSessionEffectOwner: async () => ({ ownerGeneration: generation }),
      tools: {
        ...tools,
        async callArenaShell(sessionId, parentCallId, effect) {
          if (!String(effect.input.command).includes('git worktree add -b')) {
            return tools.callArenaShell!(sessionId, parentCallId, effect)
          }
          const running = tools.callArenaShell!(sessionId, parentCallId, {
            ...effect,
            input: { ...effect.input, command: `sleep 0.15 && ${String(effect.input.command)}` },
          })
          await new Promise((resolve) => setTimeout(resolve, 30))
          generation = 'second'
          transferred = true
          return await running
        },
      },
    }

    const result = await call(deps, record.sessionId, { action: 'init', arena_id: 'inflight', candidates: ['one'] })
    expect(transferred).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('owner generation changed')
    expect(existsSync(join(repoDir, '.kala-arena', 'inflight', 'one', 'app.ts'))).toBe(true)
    expect((await call(makeDeps(store), record.sessionId, { action: 'cleanup' })).ok).toBe(true)
  })

  it('rejects an advanced primary HEAD even if its working tree is clean', async () => {
    const store = new SessionStore(storeDir)
    const record = await store.create({ sessionId: 'owner-advanced', config: createConfig({ systemPrompt: 'test', tools: builtinTools }) })
    const deps = makeDeps(store)
    const created = await call(deps, record.sessionId, { action: 'init', arena_id: 'advanced', candidates: ['one'] })
    expect(created.ok).toBe(true)
    const path = (JSON.parse(created.content) as { candidates: Array<{ worktreePath: string }> }).candidates[0]!.worktreePath
    writeFileSync(join(path, 'app.ts'), 'candidate\n')
    writeFileSync(join(repoDir, 'app.ts'), 'new main\n')
    execFileSync('git', ['add', 'app.ts'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'advance primary'], { cwd: repoDir })
    expect((await call(deps, record.sessionId, { action: 'apply', candidate_id: 'one', strategy: 'merge' })).ok).toBe(false)
    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('new main\n')
    expect((await call(deps, record.sessionId, { action: 'cleanup' })).ok).toBe(true)
  })

  it('provisions isolated candidate worktrees, keeps main git status clean, compares diffs, applies winner, and cleans up (Portable mode)', async () => {
    const store = new SessionStore(storeDir)
    const config = createConfig({
      systemPrompt: 'test',
      tools: builtinTools,
    })
    const record = await store.create({ sessionId: 'sess-arena-portable', config })
    const deps: HostLoopDeps = {
      store,
      llm: { async complete() { throw new Error('unused') } },
      tools: makeExecutorToolDispatcher(repoDir, store),
      broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
    }

    // 1. Initialize arena with 2 candidates
    const initRes = await call(deps, record.sessionId, {
        action: 'init',
        arena_id: 'perf-bakeoff',
        candidates: [
          { id: 'cand-a', label: 'Map Cache', description: 'In-memory Map implementation' },
          { id: 'cand-b', label: 'LRU Cache', description: 'Bounded LRU implementation' },
        ],
      }, 'c-init')
    expect(initRes.ok).toBe(true)
    const initPayload = JSON.parse(initRes.content) as {
      arenaId: string
      baseSha: string
      candidates: Array<{ id: string; worktreePath: string; branch: string }>
    }
    expect(initPayload.arenaId).toBe('perf-bakeoff')
    expect(initPayload.candidates).toHaveLength(2)

    const candAPath = initPayload.candidates[0]!.worktreePath
    const candBPath = initPayload.candidates[1]!.worktreePath
    expect(existsSync(join(candAPath, 'app.ts'))).toBe(true)
    expect(existsSync(join(candBPath, 'app.ts'))).toBe(true)

    // Main repo's git status must remain completely clean (.kala-arena/ excluded via .git/info/exclude)
    const mainPorcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })
    expect(mainPorcelain.trim()).toBe('')

    // 2. Simulate parallel sub-agents editing their respective worktrees without colliding
    writeFileSync(join(candAPath, 'app.ts'), 'export const version = 2\nexport const strategy = "map"\n', 'utf8')
    writeFileSync(join(candBPath, 'app.ts'), 'export const version = 2\nexport const strategy = "lru"\n', 'utf8')
    writeFileSync(join(candBPath, 'lru.ts'), 'export class LruCache {}\n', 'utf8')

    // 3. Inspect status across candidates
    const statusRes = await call(deps, record.sessionId, { action: 'status' }, 'c-status')
    expect(statusRes.ok).toBe(true)
    const statusPayload = JSON.parse(statusRes.content) as {
      candidates: Array<{ id: string; dirtyFileCount: number; changedFiles: string[] }>
    }
    expect(statusPayload.candidates.find((c) => c.id === 'cand-a')?.dirtyFileCount).toBe(1)
    expect(statusPayload.candidates.find((c) => c.id === 'cand-b')?.dirtyFileCount).toBe(2)

    // 4. Inspect side-by-side diffs
    const diffRes = await call(deps, record.sessionId, { action: 'diff' }, 'c-diff')
    expect(diffRes.ok).toBe(true)
    const diffPayload = JSON.parse(diffRes.content) as {
      candidates: Array<{ id: string; diff: string }>
    }
    expect(diffPayload.candidates.find((c) => c.id === 'cand-a')?.diff).toContain('strategy = "map"')
    expect(diffPayload.candidates.find((c) => c.id === 'cand-b')?.diff).toContain('strategy = "lru"')
    expect(diffPayload.candidates.find((c) => c.id === 'cand-b')?.diff).toContain('export class LruCache')

    // 5. Apply winning candidate (cand-b) with merge + cleanup_after=true
    const applyRes = await call(deps, record.sessionId, {
        action: 'apply',
        candidate_id: 'cand-b',
        strategy: 'merge',
        cleanup_after: true,
      }, 'c-apply')
    expect(applyRes.ok).toBe(true)
    const applyPayload = JSON.parse(applyRes.content) as {
      appliedCandidate: string
      cleanedUp: boolean
      status: string
    }
    expect(applyPayload.appliedCandidate).toBe('cand-b')
    expect(applyPayload.cleanedUp).toBe(true)
    expect(applyPayload.status).toBe('cleaned')

    // Verify main workspace now has cand-b's changes and worktrees were removed
    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toContain('strategy = "lru"')
    expect(readFileSync(join(repoDir, 'lru.ts'), 'utf8')).toContain('export class LruCache')
    expect(existsSync(candAPath)).toBe(false)
    expect(existsSync(candBPath)).toBe(false)
  })

  it('persists state across SessionStore replicas and checks the owner at Host boundaries (not final-effect fencing)', async () => {
    const dbPath = join(storeDir, 'authority.sqlite')
    const authorityA = new SqliteSessionAuthority(dbPath)
    const authorityB = new SqliteSessionAuthority(dbPath)
    const storeA = new SessionStore(join(storeDir, 'host-a'), { authority: authorityA })
    const storeB = new SessionStore(join(storeDir, 'host-b'), { authority: authorityB })

    const config = createConfig({
      systemPrompt: 'test',
      tools: builtinTools,
    })
    const record = await storeA.create({ sessionId: 'sess-arena-cloud', config })
    let activeOwner = 'host-a'

    const depsA: HostLoopDeps = {
      store: storeA,
      llm: { async complete() { throw new Error('unused') } },
      tools: makeExecutorToolDispatcher(repoDir, storeA),
      broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
      async assertSessionEffectOwner() {
        if (activeOwner !== 'host-a') throw new Error('session lease lost by host-a')
      },
    }

    const depsB: HostLoopDeps = {
      store: storeB,
      llm: { async complete() { throw new Error('unused') } },
      tools: makeExecutorToolDispatcher(repoDir, storeB),
      broadcast: { onEvent() {}, onApprovalRequired() {}, onError() {} },
      async assertSessionEffectOwner() {
        if (activeOwner !== 'host-b') throw new Error('session lease lost by host-b')
      },
    }

    // Host A initializes the arena
    const initRes = await call(depsA, record.sessionId, {
        action: 'init',
        arena_id: 'cloud-arena',
        candidates: ['fast-patch'],
      }, 'c-cloud-init')
    expect(initRes.ok).toBe(true)
    const initPayload = JSON.parse(initRes.content) as {
      candidates: Array<{ id: string; worktreePath: string }>
    }
    writeFileSync(join(initPayload.candidates[0]!.worktreePath, 'app.ts'), 'export const version = 99\n', 'utf8')

    // Simulate failover of Session ownership lease from Host A to Host B
    activeOwner = 'host-b'

    // Host A is now fenced out and cannot mutate the arena
    const fencedRes = await call(depsA, record.sessionId, { action: 'cleanup' }, 'c-fenced')
    expect(fencedRes.ok).toBe(false)
    expect(fencedRes.content).toContain('session lease lost by host-a')

    // Host B recovers arena state from SqliteSessionAuthority and applies patch + cleans up
    await storeB.load(record.sessionId)
    const applyRes = await call(depsB, record.sessionId, {
        action: 'apply',
        candidate_id: 'fast-patch',
        strategy: 'patch',
        cleanup_after: true,
      }, 'c-cloud-apply')
    expect(applyRes.ok).toBe(true)
    expect(readFileSync(join(repoDir, 'app.ts'), 'utf8')).toBe('export const version = 99\n')

    await authorityA.close()
    await authorityB.close()
  })
})
