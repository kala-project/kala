import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig, createInitialState } from '@agent-kernel/kernel'

import type { HostLoopDeps } from '../loop-types.js'
import type { SessionRecord } from '../store/session.js'
import {
  persistLearningCadence, removeLearningCheckpoints, restoreLearningCadence,
  resumeBackgroundLearning, scheduleBackgroundLearning,
} from './background-learning.js'
import { getOrCreateLearningMetrics, recordToolDispatchForLearning, resetLearningMetrics } from './memory-consolidation.js'
import { createBuiltinExtensionRegistry } from './builtin-registry.js'
import type { LearningNudgeMetrics } from './memory-consolidation.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const dir = join(process.cwd(), `.background-learning-test-${randomUUID()}`)
  directories.push(dir)
  await mkdir(dir)
  const sessionId = randomUUID()
  const messages = Array.from({ length: 10 }, (_, n) => ({
    role: (n % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text' as const, text: `message ${n}` }],
  }))
  const record = {
    sessionId, logPath: join(dir, 'session.jsonl'),
    state: { ...createInitialState({ sessionId, cwd: dir }), status: 'idle', messages },
    config: createConfig({ tools: [] }),
  } as SessionRecord
  const callTool = vi.fn(async () => ({ ok: true, content: 'saved' }))
  const llmCall = vi.fn(async () => ({
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: JSON.stringify({
      memories: [{ name: 'reusable-preference', description: 'Preference', type: 'user',
        content: 'Prefer short answers', confidence: 0.9 }],
    }) }] },
  }))
  const deps = { store: { get: (id: string) => id === sessionId ? record : undefined },
    tools: { callTool }, llm: { call: llmCall } } as unknown as HostLoopDeps
  const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, messages])).digest('hex')
  const path = `${record.logPath}.learning-${fingerprint}.json`
  return { dir, sessionId, deps, callTool, llmCall, path, logPath: record.logPath }
}

const metrics: LearningNudgeMetrics = {
  toolCallsInTurn: 8, failedToolCallsInTurn: 0, recoveredFromFailure: false,
  turnsSinceLastNudge: 0, alreadySavedInTurn: false, nudgedInTurn: false,
}

describe('background learning checkpoint', () => {
  it('deduplicates concurrent and later triggers for the same transcript', async () => {
    const { deps, sessionId, path, callTool, llmCall } = await fixture()
    await Promise.all([
      scheduleBackgroundLearning(deps, sessionId, metrics),
      scheduleBackgroundLearning(deps, sessionId, metrics),
    ])
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed'))
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    expect(llmCall).toHaveBeenCalledTimes(1)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('drains a new transcript checkpoint queued during an active extraction', async () => {
    const { deps, sessionId, path, callTool, llmCall, logPath } = await fixture()
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    const original = llmCall.getMockImplementation()!
    llmCall.mockImplementationOnce(async () => {
      await gate
      return original()
    })
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    await vi.waitFor(() => expect(llmCall).toHaveBeenCalledTimes(1))
    const record = deps.store.get(sessionId)!
    record.state = { ...record.state, messages: [...record.state.messages,
      { role: 'user', content: [{ type: 'text', text: 'new turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] }] }
    const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, record.state.messages.slice(-40)])).digest('hex')
    const nextPath = `${logPath}.learning-${fingerprint}.json`
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    expect(JSON.parse(await readFile(nextPath, 'utf8')).status).toBe('pending')
    unblock()
    await vi.waitFor(async () => expect(JSON.parse(await readFile(nextPath, 'utf8')).status).toBe('completed'))
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed')
    expect(llmCall).toHaveBeenCalledTimes(2)
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('does not recreate a removed checkpoint after an in-flight local extraction finishes', async () => {
    const { deps, sessionId, path, logPath, llmCall } = await fixture()
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    const original = llmCall.getMockImplementation()!
    llmCall.mockImplementationOnce(async () => {
      await gate
      return original()
    })
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    await vi.waitFor(() => expect(llmCall).toHaveBeenCalledTimes(1))
    await removeLearningCheckpoints(logPath)
    unblock()
    await vi.waitFor(() => expect(llmCall.mock.results[0]?.type).toBe('return'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes pending jobs but never replays an attempted effect after restart', async () => {
    const { deps, sessionId, path, llmCall } = await fixture()
    const fingerprint = path.match(/\.learning-([a-f0-9]{64})\.json$/)?.[1]
    await writeFile(path, JSON.stringify({ status: 'pending', fingerprint }))
    await Promise.all([resumeBackgroundLearning(deps, sessionId), resumeBackgroundLearning(deps, sessionId)])
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed'))
    expect(llmCall).toHaveBeenCalledTimes(1)
    await writeFile(path, JSON.stringify({ status: 'attempted', fingerprint }))
    await resumeBackgroundLearning(deps, sessionId)
    expect(llmCall).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue work on owner-fenced Runtimes', async () => {
    const { deps, dir, sessionId, llmCall } = await fixture()
    deps.assertSessionEffectOwner = async () => ({ ownerGeneration: 'old-owner' })
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    await resumeBackgroundLearning(deps, sessionId)
    expect(await readdir(dir)).toEqual([])
    expect(llmCall).not.toHaveBeenCalled()
  })

  it('uses a durable shared-owner claim, never a local checkpoint or replay of attempted work', async () => {
    const { deps, dir, sessionId, llmCall, callTool } = await fixture()
    Object.assign(deps.store.get(sessionId)!, { workspaceId: 'remote-executor' })
    deps.store.get(sessionId)!.state.cwd = dir
    deps.assertSessionEffectOwner = async () => ({ ownerGeneration: '9' })
    deps.requireMemoryEffectBarrier = true
    const jobs = new Map<string, 'pending' | 'attempted' | 'completed'>()
    const errors: string[] = []
    const claim = vi.fn(async (_session: string, fingerprint: string) => {
      if (jobs.get(fingerprint) !== 'pending') return false
      jobs.set(fingerprint, 'attempted')
      return true
    })
    deps.backgroundLearningJobs = {
      enqueue: async (_session, fingerprint) => {
        if (!jobs.has(fingerprint)) jobs.set(fingerprint, 'pending')
      },
      claim,
      complete: async (_session, fingerprint, error) => {
        if (error) errors.push(error)
        jobs.set(fingerprint, 'completed')
      },
      pending: async () => [...jobs].filter(([, state]) => state === 'pending').map(([fingerprint]) => fingerprint),
    }
    await Promise.all([
      scheduleBackgroundLearning(deps, sessionId, metrics),
      scheduleBackgroundLearning(deps, sessionId, metrics),
    ])
    await vi.waitFor(() => expect([...jobs.values()]).toEqual(['completed']))
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    await resumeBackgroundLearning(deps, sessionId)
    expect(errors).toEqual([])
    expect(llmCall).toHaveBeenCalledTimes(1)
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(claim).toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
    jobs.set([...jobs.keys()][0]!, 'attempted')
    await resumeBackgroundLearning(deps, sessionId)
    expect(llmCall).toHaveBeenCalledTimes(1)
  })

  it('resumes a pending shared-owner job without relying on a Host-local checkpoint', async () => {
    const { deps, dir, sessionId, llmCall } = await fixture()
    Object.assign(deps.store.get(sessionId)!, { workspaceId: 'remote-executor' })
    deps.store.get(sessionId)!.state.cwd = dir
    deps.assertSessionEffectOwner = async () => ({ ownerGeneration: '9' })
    deps.requireMemoryEffectBarrier = true
    let status: 'pending' | 'attempted' | 'completed' = 'pending'
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([sessionId, deps.store.get(sessionId)!.state.messages.slice(-40)])).digest('hex')
    deps.backgroundLearningJobs = {
      enqueue: async () => { throw new Error('resume must not enqueue') },
      pending: async () => status === 'pending' ? [fingerprint] : [],
      claim: async (_session, actual) => {
        expect(actual).toBe(fingerprint)
        if (status !== 'pending') return false
        status = 'attempted'
        return true
      },
      complete: async () => { status = 'completed' },
    }
    await resumeBackgroundLearning(deps, sessionId)
    await vi.waitFor(() => expect(status).toBe('completed'))
    await resumeBackgroundLearning(deps, sessionId)
    expect(llmCall).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })

  it('does not enqueue work for an Executor-bound workspace even without an owner callback', async () => {
    const { deps, dir, sessionId, llmCall } = await fixture()
    Object.assign(deps.store.get(sessionId)!, { workspaceId: 'remote-executor' })
    await scheduleBackgroundLearning(deps, sessionId, metrics)
    await resumeBackgroundLearning(deps, sessionId)
    expect(await readdir(dir)).toEqual([])
    expect(llmCall).not.toHaveBeenCalled()
  })

  it('restores periodic nudge cadence and removes only its own checkpoints on deletion', async () => {
    const { deps, sessionId, dir, logPath } = await fixture()
    getOrCreateLearningMetrics(sessionId).turnsSinceLastNudge = 9
    await persistLearningCadence(deps, sessionId)
    resetLearningMetrics(sessionId)
    await restoreLearningCadence(deps, sessionId)
    expect(getOrCreateLearningMetrics(sessionId).turnsSinceLastNudge).toBe(9)
    await writeFile(join(dir, 'unrelated.json'), '{}')
    await removeLearningCheckpoints(logPath)
    expect(await readdir(dir)).toEqual(['unrelated.json'])
    resetLearningMetrics(sessionId)
  })

  it('schedules from the real after-turn lifecycle without blocking the turn on extraction', async () => {
    const { deps, sessionId, path, callTool } = await fixture()
    for (let i = 0; i < 8; i++) recordToolDispatchForLearning(sessionId, 'read_file', {}, true)
    await createBuiltinExtensionRegistry().afterTurn({
      deps, sessionId, event: { kind: 'clear' }, loop: {} as never,
      autoCompact: async () => {}, resumeDurableWork: async () => {},
    })
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed'))
    expect(callTool).toHaveBeenCalledTimes(1)
    resetLearningMetrics(sessionId)
  })
})
