import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startExecutor } from './client.js'
import { ExecutionReceiptStore } from './execution-receipts.js'
import { leaderIdentity } from './tools/arena-process-groups.js'
import type { Tool } from './tools/registry.js'

function socket() {
  const events = new EventEmitter()
  return {
    io: new EventEmitter(), connected: true, auth: undefined,
    emit: () => true,
    on: (name: string, handler: (...args: unknown[]) => void) => { events.on(name, handler) },
    off: (name: string, handler: (...args: unknown[]) => void) => { events.off(name, handler) },
    disconnect() { this.connected = false },
    trigger(name: string, ...args: unknown[]) { events.emit(name, ...args) },
  }
}

describe('arena status durable receipt admission', () => {
  const dirs: string[] = []
  const keepers: ChildProcess[] = []
  afterEach(() => {
    for (const child of keepers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('fails named admission closed without a keeper while leaving an ordinary tool available', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'arena-no-keeper-'))
    dirs.push(dir)
    const target = socket()
    const run = vi.fn(async () => 'ok')
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'legacy', sandboxRoots: [dir],
      receiptStorePath: join(dir, 'journal.json'), ioFactory: (() => target) as never,
      tools: [{ name: 'arena_git_status', run }, { name: 'ordinary_tool', run }],
    })
    const denied = vi.fn()
    target.trigger('tool:call', {
      sessionId: 's', callId: 'arena-status-NOKEEPER', name: 'arena_git_status',
      origin: 'host', ownerGeneration: '1', input: { ownerGeneration: '1' },
    }, denied)
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, content: expect.stringContaining('keeper is unavailable') })))
    expect(run).not.toHaveBeenCalled()
    const allowed = vi.fn()
    target.trigger('tool:call', { sessionId: 's', callId: 'ordinary', name: 'ordinary_tool', input: {} }, allowed)
    await vi.waitFor(() => expect(allowed).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    await handle.close()
  })

  it.skipIf(process.platform !== 'linux')('rejects unbound or non-durable requests and replays only the completed exact generation', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'arena-receipt-'))
    dirs.push(dir)
    const receiptStorePath = join(dir, 'receipts.json')
    const keeperFile = join(dir, 'keeper.json')
    const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'],
      { stdio: 'ignore' })
    keepers.push(keeper)
    writeFileSync(keeperFile, JSON.stringify(await leaderIdentity(keeper.pid!)), { mode: 0o600 })
    const runs = vi.fn(async () => JSON.stringify({ finalEffectStopped: true, candidates: [] }))
    const tool: Tool = { name: 'arena_git_status', run: runs }
    const diffTool: Tool = { name: 'arena_git_diff', run: runs }
    const mutations = ['init', 'apply', 'cleanup'].map((action): Tool => ({ name: `arena_git_${action}`, run: runs }))
    const tools = [tool, diffTool, ...mutations]
    const first = socket()
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'arena-test', executorId: 'arena-executor',
      sandboxRoots: [dir], receiptStorePath, arenaKeeperIdentityFile: keeperFile,
      tools, ioFactory: (() => first) as never,
    })
    const call = {
      sessionId: 'session', callId: 'arena-status-123', name: 'arena_git_status',
      origin: 'host', ownerGeneration: '1', input: { ownerGeneration: '1' },
    }
    const volatileSocket = socket()
    const volatile = startExecutor({
      host: 'http://localhost', workspaceId: 'arena-volatile', executorId: 'volatile',
      sandboxRoots: [dir], receiptStorePath: false, tools, ioFactory: (() => volatileSocket) as never,
    })
    const noJournal = vi.fn()
    volatileSocket.trigger('tool:call', call, noJournal)
    await vi.waitFor(() => expect(noJournal).toHaveBeenCalledWith(expect.objectContaining({ ok: false })))
    expect(runs).not.toHaveBeenCalled()
    await volatile.close()
    const rejected = vi.fn()
    first.trigger('tool:call', { ...call, ownerGeneration: '2' }, rejected)
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ ok: false })))
    expect(runs).not.toHaveBeenCalled()
    const ack = vi.fn()
    first.trigger('tool:call', call, ack)
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    expect(JSON.parse(readFileSync(receiptStorePath, 'utf8'))).toMatchObject({
      'session:arena-status-123': { ownerGeneration: '1', result: { ok: true } },
    })
    const diffCall = { ...call, callId: 'arena-diff-456', name: 'arena_git_diff' }
    rmSync(keeperFile)
    const unavailable = vi.fn()
    first.trigger('tool:call', diffCall, unavailable)
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, content: expect.stringContaining('keeper is unavailable') })))
    const negative = vi.fn()
    first.trigger('executor:arena_receipt_inspect', { sessionId: 'session', callId: diffCall.callId }, negative)
    await vi.waitFor(() => expect(negative).toHaveBeenCalledWith(expect.objectContaining({
      state: 'denied', ownerGeneration: '1', result: expect.objectContaining({
        ok: false, failure: expect.objectContaining({ code: 'arena_not_admitted' }),
      }),
    })))
    expect(runs).toHaveBeenCalledTimes(1)
    writeFileSync(keeperFile, JSON.stringify(await leaderIdentity(keeper.pid!)), { mode: 0o600 })
    const deniedReplay = vi.fn()
    first.trigger('tool:call', diffCall, deniedReplay)
    await vi.waitFor(() => expect(deniedReplay).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, failure: expect.objectContaining({ code: 'arena_not_admitted' }),
    })))
    const admittedDiff = { ...diffCall, callId: 'arena-diff-457' }
    const diffAck = vi.fn()
    first.trigger('tool:call', admittedDiff, diffAck)
    await vi.waitFor(() => expect(diffAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    expect(JSON.parse(readFileSync(receiptStorePath, 'utf8'))).toMatchObject({
      'session:arena-diff-457': { ownerGeneration: '1', result: { ok: true } },
    })
    const mutationCalls = mutations.map((item, index) => ({
      ...call, name: item.name, callId: `arena-${item.name.slice('arena_git_'.length)}-${index}`,
    }))
    for (const mutation of mutationCalls) {
      const wrongAction = vi.fn()
      first.trigger('tool:call', { ...mutation, callId: 'arena-status-999' }, wrongAction)
      await vi.waitFor(() => expect(wrongAction).toHaveBeenCalledWith(expect.objectContaining({ ok: false })))
      const admitted = vi.fn()
      first.trigger('tool:call', mutation, admitted)
      await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
      expect(JSON.parse(readFileSync(receiptStorePath, 'utf8'))).toMatchObject({
        [`session:${mutation.callId}`]: { ownerGeneration: '1', result: { ok: true } },
      })
    }
    await handle.close()
    const journal = new ExecutionReceiptStore(receiptStorePath)
    await journal.load()
    await journal.begin('session:arena-apply-HUNG', 'arena-apply-HUNG', '0'.repeat(64), '1')
    const replaySocket = socket()
    const replay = startExecutor({
      host: 'http://localhost', workspaceId: 'arena-test', executorId: 'arena-executor-restarted',
      sandboxRoots: [dir], receiptStorePath, arenaKeeperIdentityFile: keeperFile,
      tools, ioFactory: (() => replaySocket) as never,
    })
    const cached = vi.fn()
    replaySocket.trigger('tool:call', call, cached)
    await vi.waitFor(() => expect(cached).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    const inspected = vi.fn()
    replaySocket.trigger('executor:arena_receipt_inspect', { sessionId: 'session', callId: 'arena-apply-HUNG' }, inspected)
    await vi.waitFor(() => expect(inspected).toHaveBeenCalledWith({
      state: 'started', ownerGeneration: '1', requestDigest: '0'.repeat(64),
    }))
    const completedInspection = vi.fn()
    replaySocket.trigger('executor:arena_receipt_inspect', { sessionId: 'session', callId: 'arena-status-123' }, completedInspection)
    await vi.waitFor(() => expect(completedInspection).toHaveBeenCalledWith(expect.objectContaining({
      state: 'completed', ownerGeneration: '1', result: expect.objectContaining({ ok: true }),
    })))
    const diffCached = vi.fn()
    replaySocket.trigger('tool:call', admittedDiff, diffCached)
    await vi.waitFor(() => expect(diffCached).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    const deniedAfterRestart = vi.fn()
    replaySocket.trigger('executor:arena_receipt_inspect', { sessionId: 'session', callId: diffCall.callId }, deniedAfterRestart)
    await vi.waitFor(() => expect(deniedAfterRestart).toHaveBeenCalledWith(expect.objectContaining({ state: 'denied' })))
    for (const mutation of mutationCalls) {
      const cachedMutation = vi.fn()
      replaySocket.trigger('tool:call', mutation, cachedMutation)
      await vi.waitFor(() => expect(cachedMutation).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    }
    expect(runs).toHaveBeenCalledTimes(5)
    const differentGeneration = vi.fn()
    replaySocket.trigger('tool:call', { ...call, ownerGeneration: '2', input: { ownerGeneration: '2' } }, differentGeneration)
    await vi.waitFor(() => expect(differentGeneration).toHaveBeenCalledWith(expect.objectContaining({ ok: false })))
    expect(runs).toHaveBeenCalledTimes(5)
    await replay.close()
  })

  it('keeps Arena receipts beyond normal completed-call TTL for bounded manual inspection', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'arena-pinned-'))
    dirs.push(dir)
    const path = join(dir, 'journal.json')
    const store = new ExecutionReceiptStore(path)
    await store.begin('session:arena-apply-PINNED', 'arena-apply-PINNED', '0'.repeat(64), '1')
    await store.set('session:arena-apply-PINNED', {
      callId: 'arena-apply-PINNED', ok: true, content: '{"finalEffectStopped":true}',
    })
    const entries = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { completedAt: number }>
    entries['session:arena-apply-PINNED']!.completedAt = Date.now() - 3 * 24 * 60 * 60_000
    writeFileSync(path, JSON.stringify(entries))
    const recovered = new ExecutionReceiptStore(path)
    await recovered.load()
    expect(recovered.inspectArena('session:arena-apply-PINNED')).toMatchObject({
      state: 'completed', ownerGeneration: '1', result: { ok: true },
    })
  })
})
