/**
 * Executor tool-call idempotency.
 *
 * Ensures that when the host re-emits the same `tool:call` (which happens
 * on the reconnect path via `redispatchPending`), the executor doesn't
 * re-run the tool. Instead it returns the cached result via ack.
 *
 * Regression guard against duplicate side effects: `bash rm foo`, `write`,
 * anything with observable state — a naive re-emit would run twice.
 */

import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { schema } from '@agent-kernel/shared'
import { createExecutorSharedExecution, startExecutor } from './client.js'
import { ExecutionReceiptStore, executionRequestDigest } from './execution-receipts.js'
import type { Tool } from './tools/registry.js'
import { skillFileTool } from './tools/skill-file.js'
import { memoryTool } from './tools/memory.js'
import { leaderIdentity } from './tools/arena-process-groups.js'

async function testKeeper(root: string) {
  const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  if (!keeper.pid) throw new Error('test keeper did not start')
  const path = join(root, 'keeper.json')
  await writeFile(path, JSON.stringify(await leaderIdentity(keeper.pid)), { mode: 0o600 })
  return { path, stop: async () => {
    if (keeper.exitCode === null && keeper.signalCode === null) {
      keeper.kill('SIGTERM')
      await once(keeper, 'exit')
    }
  } }
}

type Handler = (...args: unknown[]) => void

/**
 * Minimal socket.io-client mock that exposes `emit` / `on` / `disconnect`
 * with the shape startExecutor uses. Also lets the test synthesize
 * inbound events by invoking the registered handler manually.
 */
function makeMockSocket() {
  const emitter = new EventEmitter()
  const managerEmitter = new EventEmitter()
  const emitted: Array<{ event: string; args: unknown[] }> = []
  const socket = {
    connected: true,
    auth: undefined as unknown,
    // Socket.IO client exposes `.io` = the underlying Manager, which also
    // implements EventEmitter. Real code subscribes to `reconnect_failed`
    // there. The test doesn't need to emit those, but the attach must not
    // throw.
    io: managerEmitter,
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args })
      return true
    },
    on: (event: string, handler: Handler) => {
      emitter.on(event, handler)
    },
    off: (event: string, handler: Handler) => {
      emitter.off(event, handler)
    },
    timeout: (_ms: number) => socket,
    disconnect: () => {
      socket.connected = false
    },
    __trigger(event: string, ...args: unknown[]) {
      emitter.emit(event, ...args)
    },
    __emitted: emitted,
  }
  return socket
}

describe('executor idempotency', () => {
  it('preserves every field of the emitted announcement through the Host wire schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-announcement-wire-'))
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-announcement', executorId: 'executor-announcement',
      sandboxRoots: [root], tools: [], receiptStorePath: false, ioFactory: (() => socket) as never,
    })
    try {
      socket.__trigger('connect')
      await vi.waitFor(() => expect(socket.__emitted.some((entry) => entry.event === 'executor:announce')).toBe(true))
      const announcement = socket.__emitted.find((entry) => entry.event === 'executor:announce')!.args[0]
      expect(schema.ExecutorAnnounceSchema.parse(announcement)).toEqual(announcement)
      expect(announcement).toMatchObject({ attachmentTransferVersion: 1, appDebugVersion: 1 })
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('requires both attachment generations to be absent in Portable mode', async () => {
    const root = await mkdtemp(join(process.cwd(), '.attachment-generation-test-'))
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-generation', executorId: 'executor-generation',
      sandboxRoots: [root], tools: [], receiptStorePath: false, ioFactory: (() => socket) as never,
    })
    try {
      const request = { sessionId: 'session', callId: 'begin', name: '__workspace_attachment_transfer',
        origin: 'host' as const,
        input: { action: 'begin', transferId: 'generation-check', path: 'a.bin', bytes: 1, sha256: '0'.repeat(64) } }
      const first = vi.fn()
      socket.__trigger('tool:call', { ...request, ownerGeneration: '2' }, first)
      await vi.waitFor(() => expect(first).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, content: expect.stringContaining('input owner generation') })))
      const second = vi.fn()
      socket.__trigger('tool:call', { ...request, input: { ...request.input, ownerGeneration: '2' } }, second)
      await vi.waitFor(() => expect(second).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, content: expect.stringContaining('input owner generation') })))
      await expect(lstat(join(root, '.kala', 'attachment-transfers'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await handle.close(); await rm(root, { force: true, recursive: true }) }
  })

  it('rejects forged attachment transfer calls at the transport before dispatch', async () => {
    const root = await mkdtemp(join(process.cwd(), '.attachment-transport-test-'))
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-transfer', executorId: 'executor-transfer',
      sandboxRoots: [root], tools: [], receiptStorePath: false, ioFactory: (() => socket) as never,
    })
    try {
      const request = { sessionId: 'session', callId: 'begin-1', name: '__workspace_attachment_transfer',
        input: { action: 'begin', transferId: 'transport-check', path: 'a.bin', bytes: 1, sha256: '0'.repeat(64) } }
      const reply = vi.fn()
      socket.__trigger('tool:call', request, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, content: expect.stringContaining('Host admission') })))
      socket.__trigger('tool:call', { ...request, origin: 'host', ownerGeneration: 'invalid' }, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2))
      expect(reply.mock.calls[1]![0]).toMatchObject({ ok: false })
      await expect(lstat(join(root, '.kala', 'attachment-transfers'))).rejects.toMatchObject({ code: 'ENOENT' })
      socket.__trigger('tool:call', {
        ...request, origin: 'host', ownerGeneration: '2',
        input: { ...request.input, ownerGeneration: '1' },
      }, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(3))
      expect(reply.mock.calls[2]![0]).toMatchObject({
        ok: false, content: expect.stringContaining('input owner generation does not match dispatch generation'),
      })
      await expect(lstat(join(root, '.kala', 'attachment-transfers'))).rejects.toMatchObject({ code: 'ENOENT' })
      socket.__trigger('tool:call', { ...request, origin: 'host' }, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(4))
      expect(reply.mock.calls[3]![0]).toMatchObject({ ok: true })
      expect(JSON.parse(reply.mock.calls[3]![0].content)).toMatchObject({ ok: true, state: 'active' })
      socket.__trigger('tool:call', {
        ...request, callId: 'status-forged', origin: 'host', ownerGeneration: '2',
        input: { ...request.input, action: 'status', ownerGeneration: '2' },
      }, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(5))
      expect(reply.mock.calls[4]![0]).toMatchObject({
        ok: false, content: expect.stringContaining('owner generation or session mismatch'),
      })
      socket.__trigger('tool:call', {
        ...request, callId: 'begin-fenced', origin: 'host', ownerGeneration: '2',
        input: { ...request.input, transferId: 'fenced', ownerGeneration: '2' },
      }, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(6))
      expect(JSON.parse(reply.mock.calls[5]![0].content)).toMatchObject({ ok: true, state: 'active' })
      socket.__trigger('tool:call', {
        ...request, callId: 'chunk-stale', origin: 'host', ownerGeneration: '3',
        input: { ...request.input, action: 'chunk', transferId: 'fenced', ownerGeneration: '2',
          offset: 0, data: Buffer.from([1]).toString('base64') },
      }, reply)
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(7))
      expect(reply.mock.calls[6]![0]).toMatchObject({
        ok: false, content: expect.stringContaining('input owner generation does not match dispatch generation'),
      })
      expect(await lstat(join(root, 'a.bin')).catch(() => undefined)).toBeUndefined()
    } finally { await handle.close(); await rm(root, { force: true, recursive: true }) }
  })

  it.skipIf(process.platform !== 'linux')('advertises recoverable v2 effects only for exact built-ins with a live keeper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-learning-capability-'))
    const keeper = await testKeeper(root)
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-builtins', executorId: 'executor-builtins',
      sandboxRoots: [root], tools: [skillFileTool, memoryTool],
      arenaKeeperIdentityFile: keeper.path, ioFactory: (() => socket) as never,
    })
    try {
      socket.__trigger('connect')
      await vi.waitFor(() => expect(socket.__emitted.find((entry) => entry.event === 'executor:announce')?.args[0])
        .toMatchObject({ skillFileEffectVersion: 2, memoryEffectVersion: 2, arenaKeeperVersion: 1 }))
      const announcement = socket.__emitted.find((entry) => entry.event === 'executor:announce')!.args[0]
      expect(schema.ExecutorAnnounceSchema.parse(announcement)).toEqual(announcement)
    } finally { await handle.close(); await keeper.stop(); await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'linux')('durably receipts a generation-bound skill mutation and replays without a second filesystem write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-skill-receipt-'))
    const keeper = await testKeeper(root)
    const socket = makeMockSocket()
    const run = vi.fn(skillFileTool.run)
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-skill', executorId: 'executor-skill',
      sandboxRoots: [root], tools: [{ name: 'skill_file', run }],
      arenaKeeperIdentityFile: keeper.path,
      ioFactory: (() => socket) as never,
    })

    try {
      const call = {
        sessionId: 'session-skill', callId: 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'skill_file', input: { action: 'create', name: 'procedure', content: 'durable skill',
          ownerGeneration: '7' },
        origin: 'host' as const, ownerGeneration: '7', cwd: root,
      }
      const ack = vi.fn()
      socket.__trigger('tool:call', { ...call, origin: undefined }, ack)
      await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, content: expect.stringContaining('generation-bound Host admission') })))
      expect(run).not.toHaveBeenCalled()
      socket.__trigger('tool:call', call, ack)
      await vi.waitFor(() => expect(ack).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true })))
      const query = { sessionId: call.sessionId, callId: call.callId,
        ownerGeneration: '7', requestDigest: executionRequestDigest(call) }
      const proof = vi.fn()
      socket.__trigger('tool:receipt_query', query, proof)
      await vi.waitFor(() => expect(proof).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', result: expect.objectContaining({ ok: true }) })))
      const journalPath = join(root, '.kala', 'execution-receipts.json')
      const journal = new ExecutionReceiptStore(journalPath)
      await journal.load()
      expect(journal.inspectArena(`${call.sessionId}:${call.callId}`)).toMatchObject({
        state: 'completed',
        ownerGeneration: '7', requestDigest: query.requestDigest,
        executorProcess: await leaderIdentity(process.pid),
        target: { tool: 'skill_file', action: 'create',
          pathDigest: createHash('sha256').update(join(root, '.agent', 'skills', 'procedure', 'SKILL.md')).digest('hex'),
          contentDigest: createHash('sha256').update('durable skill').digest('hex') },
      })
      expect(await readFile(journalPath, 'utf8')).not.toContain('durable skill')
      const replay = vi.fn()
      socket.__trigger('tool:call', call, replay)
      await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true })))
      expect(run).toHaveBeenCalledTimes(1)
      expect(await readFile(join(root, '.agent', 'skills', 'procedure', 'SKILL.md'), 'utf8')).toBe('durable skill')
    } finally {
      await handle.close()
      await keeper.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'linux')('durably receipts generation-bound generic memory writes and rejects non-Host admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-memory-receipt-'))
    const keeper = await testKeeper(root)
    const socket = makeMockSocket()
    const run = vi.fn(memoryTool.run)
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-memory', executorId: 'executor-memory',
      sandboxRoots: [root], tools: [{ name: 'memory', run }],
      arenaKeeperIdentityFile: keeper.path,
      ioFactory: (() => socket) as never,
    })
    try {
      const call = {
        sessionId: 'session-memory', callId: `memory-file-${'a'.repeat(64)}`,
        name: 'memory', input: { operation: 'write', scope: 'workspace',
          key: 'note', content: 'first write', ownerGeneration: '9' },
        origin: 'host' as const, ownerGeneration: '9', cwd: root,
      }
      const denied = vi.fn()
      socket.__trigger('tool:call', { ...call, origin: undefined }, denied)
      await vi.waitFor(() => expect(denied).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, content: expect.stringContaining('generation-bound Host admission') })))
      expect(run).not.toHaveBeenCalled()
      const written = vi.fn()
      socket.__trigger('tool:call', call, written)
      await vi.waitFor(() => expect(written).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
      const query = { sessionId: call.sessionId, callId: call.callId,
        ownerGeneration: '9', requestDigest: executionRequestDigest(call) }
      const final = vi.fn()
      socket.__trigger('tool:receipt_query', query, final)
      await vi.waitFor(() => expect(final).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', result: expect.objectContaining({ ok: true }) })))
      const journalPath = join(root, '.kala', 'execution-receipts.json')
      const journal = new ExecutionReceiptStore(journalPath)
      await journal.load()
      expect(journal.inspectArena(`${call.sessionId}:${call.callId}`)).toMatchObject({
        state: 'completed',
        ownerGeneration: '9', requestDigest: query.requestDigest,
        executorProcess: await leaderIdentity(process.pid),
        target: { tool: 'memory', action: 'write',
          pathDigest: createHash('sha256').update(join(root, '.kala', 'memory', 'note.md')).digest('hex'),
          contentDigest: createHash('sha256').update('first write').digest('hex') },
      })
      expect(await readFile(journalPath, 'utf8')).not.toContain('first write')
      const replay = vi.fn()
      socket.__trigger('tool:call', call, replay)
      await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(written.mock.calls[0]![0]))
      expect(run).toHaveBeenCalledTimes(1)
      expect(await readFile(join(root, '.kala', 'memory', 'note.md'), 'utf8')).toBe('first write')
    } finally {
      await handle.close()
      await keeper.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'linux')('refuses fenced learning mutation before journal admission without a keeper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-learning-no-keeper-'))
    const socket = makeMockSocket()
    const run = vi.fn(skillFileTool.run)
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-no-keeper', executorId: 'executor-no-keeper',
      sandboxRoots: [root], tools: [{ name: 'skill_file', run }],
      ioFactory: (() => socket) as never,
    })
    try {
      const call = {
        sessionId: 'no-keeper', callId: 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'skill_file', input: { action: 'create', name: 'procedure', content: 'blocked', ownerGeneration: '7' },
        origin: 'host' as const, ownerGeneration: '7', cwd: root,
      }
      const ack = vi.fn()
      socket.__trigger('tool:call', call, ack)
      await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, failure: expect.objectContaining({ code: 'learning_not_admitted' }) })))
      expect(run).not.toHaveBeenCalled()
      const journal = new ExecutionReceiptStore(join(root, '.kala', 'execution-receipts.json'))
      await journal.load()
      expect(journal.inspectArena(`${call.sessionId}:${call.callId}`)).toMatchObject({
        state: 'denied', requestDigest: executionRequestDigest(call), ownerGeneration: '7',
      })
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'linux')('durably denies invalid fenced memory content and Skill cwd before any tool runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-learning-negative-admission-'))
    const keeper = await testKeeper(root)
    const socket = makeMockSocket()
    const memoryRun = vi.fn(memoryTool.run)
    const skillRun = vi.fn(skillFileTool.run)
    const journalPath = join(root, 'receipts.json')
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-negative-admission', executorId: 'executor-negative-admission',
      sandboxRoots: [root], receiptStorePath: journalPath,
      tools: [{ name: 'memory', run: memoryRun }, { name: 'skill_file', run: skillRun }],
      arenaKeeperIdentityFile: keeper.path, ioFactory: (() => socket) as never,
    })
    try {
      const calls = [
        { sessionId: 'session', callId: `memory-file-${'d'.repeat(64)}`, name: 'memory',
          input: { operation: 'write', scope: 'workspace', key: 'note', ownerGeneration: '2' },
          ownerGeneration: '2', origin: 'host' as const, cwd: root },
        { sessionId: 'session', callId: 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'skill_file',
          input: { action: 'create', name: 'note', content: 'not written', ownerGeneration: '2' },
          ownerGeneration: '2', origin: 'host' as const, cwd: 'relative-cwd' },
      ]
      for (const call of calls) {
        const ack = vi.fn()
        socket.__trigger('tool:call', call, ack)
        await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, failure: expect.objectContaining({ code: 'learning_not_admitted' }) })))
        const receipts = new ExecutionReceiptStore(journalPath)
        await receipts.load()
        expect(receipts.inspectArena(`${call.sessionId}:${call.callId}`)).toMatchObject({
          state: 'denied', requestDigest: executionRequestDigest(call), ownerGeneration: '2',
        })
        expect(await receipts.query({ sessionId: call.sessionId, callId: call.callId,
          requestDigest: executionRequestDigest(call), ownerGeneration: '2' })).toEqual({ status: 'denied' })
        const replay = vi.fn()
        socket.__trigger('tool:call', call, replay)
        await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(ack.mock.calls[0]![0]))
      }
      expect(memoryRun).not.toHaveBeenCalled()
      expect(skillRun).not.toHaveBeenCalled()
    } finally { await handle.close(); await keeper.stop(); await rm(root, { recursive: true, force: true }) }
  })

  it('only aborts the matching live runner after the Stop intent is durable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kala-stop-wire-'))
    const sharedExecution = createExecutorSharedExecution(join(dir, 'receipts.json'))
    const socket = makeMockSocket()
    const runs = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) =>
      await new Promise<string>((resolve) => context.signal.addEventListener('abort', () => resolve('aborted with possible prior effects'), { once: true })))
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-stop', executorId: 'executor-stop',
      tools: [{ name: 'effect', run: runs } satisfies Tool], sharedExecution, ioFactory: (() => socket) as never,
    })
    const call = { sessionId: 'child', callId: 'call', name: 'effect', input: {}, ownerGeneration: '2' }
    const result = vi.fn()
    socket.__trigger('tool:call', call, result)
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(1))
    const request = { sessionId: call.sessionId, callId: call.callId, ownerGeneration: '2',
      requestDigest: executionRequestDigest(call), stopCommandId: 'stop-1' }
    const wrong = vi.fn()
    socket.__trigger('tool:cancel_ack', { ...request, ownerGeneration: '3' }, wrong)
    await vi.waitFor(() => expect(wrong).toHaveBeenCalledWith({ status: 'conflict' }))
    expect(result).not.toHaveBeenCalled()
    const ack = vi.fn()
    socket.__trigger('tool:cancel_ack', request, ack)
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ status: 'cancel_requested' }))
    await vi.waitFor(() => expect(result).toHaveBeenCalled())
    expect(result.mock.calls[0]![0]).toMatchObject({ ok: true, content: 'aborted with possible prior effects' })
    const recovered = vi.fn()
    socket.__trigger('tool:receipt_query', request, recovered)
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledWith({
      status: 'completed', result: expect.objectContaining({ callId: 'call', ok: true }),
    }))
    await handle.close()
  })

  it('serves receipt queries from durable evidence without calling the tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kala-receipt-query-wire-'))
    const sharedExecution = createExecutorSharedExecution(join(dir, 'receipts.json'))
    const socket = makeMockSocket()
    const runs = vi.fn(async () => 'effect')
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'ws-query', executorId: 'executor-query',
      tools: [{ name: 'effect', run: runs } satisfies Tool], sharedExecution, ioFactory: (() => socket) as never,
    })
    const query = { sessionId: 'session', callId: 'call', ownerGeneration: '2', requestDigest: 'a'.repeat(64) }
    const missing = vi.fn()
    socket.__trigger('tool:receipt_query', query, missing)
    await vi.waitFor(() => expect(missing).toHaveBeenCalledWith({ status: 'unavailable' }))
    await sharedExecution.receiptStore!.begin('session:call', 'call', query.requestDigest, query.ownerGeneration)
    const started = vi.fn()
    socket.__trigger('tool:receipt_query', query, started)
    await vi.waitFor(() => expect(started).toHaveBeenCalledWith({ status: 'started_unknown' }))
    await sharedExecution.receiptStore!.set('session:call', { callId: 'call', ok: true, content: 'persisted' })
    const completed = vi.fn()
    socket.__trigger('tool:receipt_query', query, completed)
    await vi.waitFor(() => expect(completed).toHaveBeenCalledWith({ status: 'completed', result: { callId: 'call', ok: true, content: 'persisted' } }))
    expect(runs).not.toHaveBeenCalled()
    await handle.close()
  })

  it('fails closed on high-risk shell calls without a Host approval and admits verified calls', async () => {
    const runs = vi.fn(async (_input: Record<string, unknown>, _ctx: Parameters<Tool['run']>[1]) => 'executed')
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://localhost',
      workspaceId: 'ws-shell-proof',
      executorId: 'exec-shell-proof',
      receiptStorePath: false,
      tools: [{ name: 'bash', run: runs }],
      ioFactory: (() => socket) as never,
    })
    const call = { sessionId: 'session', callId: 'shell-1', name: 'bash', input: { command: 'git reset --hard HEAD' } }
    const denied = vi.fn()
    socket.__trigger('tool:call', call, denied)
    await vi.waitFor(() => expect(socket.__emitted.some((e) => e.event === 'executor:shell_authorize')).toBe(true))
    const duplicate = vi.fn()
    socket.__trigger('tool:call', call, duplicate)
    expect(socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')).toHaveLength(1)
    const firstAuth = socket.__emitted.find((e) => e.event === 'executor:shell_authorize')!
    expect(firstAuth.args[0]).toEqual({
      sessionId: 'session', callId: 'shell-1', name: 'bash', command: 'git reset --hard HEAD',
    })
    ;(firstAuth.args[1] as (error: Error | undefined, reply?: { authorized: boolean; reason?: string }) => void)(undefined, { authorized: false, reason: 'workspace_mismatch' })
    await vi.waitFor(() => expect(denied).toHaveBeenCalled())
    expect(duplicate).toHaveBeenCalledWith(denied.mock.calls[0]![0])
    expect(denied.mock.calls[0]![0]).toMatchObject({ ok: false, content: expect.stringContaining('EACCES') })
    expect(denied.mock.calls[0]![0].content).toContain('reconnect the selected workspace Executor')
    expect(runs).not.toHaveBeenCalled()

    const allowed = vi.fn()
    socket.__trigger('tool:call', { ...call, callId: 'shell-2' }, allowed)
    await vi.waitFor(() => expect(socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')).toHaveLength(2))
    const secondAuth = socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')[1]!
    ;(secondAuth.args[1] as (error: Error | undefined, reply?: { authorized: boolean }) => void)(undefined, { authorized: true })
    await vi.waitFor(() => expect(allowed).toHaveBeenCalled())
    expect(allowed.mock.calls[0]![0]).toMatchObject({ ok: true, content: 'executed' })
    expect(runs).toHaveBeenCalledTimes(1)
    expect(runs.mock.calls[0]?.[1]).toMatchObject({ shellApprovalVerified: true })

    const unavailable = vi.fn()
    socket.__trigger('tool:call', { ...call, callId: 'shell-3' }, unavailable)
    await vi.waitFor(() => expect(socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')).toHaveLength(3))
    const thirdAuth = socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')[2]!
    ;(thirdAuth.args[1] as (error: Error) => void)(new Error('host approval RPC unavailable'))
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled())
    expect(unavailable.mock.calls[0]![0]).toMatchObject({ ok: false, content: expect.stringContaining('EACCES') })
    expect(runs).toHaveBeenCalledTimes(1)

    const blocked = vi.fn()
    socket.__trigger('tool:call', { ...call, callId: 'shell-4', input: { command: 'echo "$(git reset --hard' } }, blocked)
    await vi.waitFor(() => expect(blocked).toHaveBeenCalled())
    expect(blocked.mock.calls[0]![0]).toMatchObject({ ok: false, content: expect.stringContaining('shell.parse.incomplete') })
    expect(socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')).toHaveLength(3)

    const safe = vi.fn()
    socket.__trigger('tool:call', { ...call, callId: 'shell-5', input: { command: 'git status' } }, safe)
    await vi.waitFor(() => expect(safe).toHaveBeenCalled())
    expect(safe.mock.calls[0]![0]).toMatchObject({ ok: true })
    expect(socket.__emitted.filter((e) => e.event === 'executor:shell_authorize')).toHaveLength(3)
    expect(runs).toHaveBeenCalledTimes(2)
    await handle.close()
  })

  it('rejects different requests sharing an execution identity while running and after completion', async () => {
    let finish!: (value: string) => void
    const runs = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = makeMockSocket()
    const second = makeMockSocket()
    const sharedExecution = createExecutorSharedExecution(false)
    const common = {
      host: 'http://localhost', workspaceId: 'ws-conflict', executorId: 'executor-conflict',
      tools: [{ name: 'effect', run: runs } satisfies Tool], sharedExecution,
    }
    const handles = [
      startExecutor({ ...common, ioFactory: (() => first) as never }),
      startExecutor({ ...common, ioFactory: (() => second) as never }),
    ]
    const call = { sessionId: 'session', callId: 'call', name: 'effect', input: { value: 'original' } }
    const originalAck = vi.fn()
    first.__trigger('tool:call', call, originalAck)
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(1))
    const conflictingAck = vi.fn()
    second.__trigger('tool:call', { ...call, input: { value: 'replacement' } }, conflictingAck)
    await vi.waitFor(() => expect(conflictingAck).toHaveBeenCalled())
    expect(JSON.parse(conflictingAck.mock.calls[0]![0].content)).toMatchObject({ outcome: 'execution_conflict' })
    expect(originalAck).not.toHaveBeenCalled()
    finish('original-result')
    await vi.waitFor(() => expect(originalAck).toHaveBeenCalled())
    const completedConflict = vi.fn()
    second.__trigger('tool:call', { ...call, cwd: '/different' }, completedConflict)
    await vi.waitFor(() => expect(completedConflict).toHaveBeenCalled())
    expect(JSON.parse(completedConflict.mock.calls[0]![0].content)).toMatchObject({ outcome: 'execution_conflict' })
    expect(runs).toHaveBeenCalledTimes(1)
    await Promise.all(handles.map((handle) => handle.close()))
  })

  it('serves a duplicate tool:call from cache without re-running the tool', async () => {
    const runs = vi.fn(async () => 'ran-tool')
    const testTool: Tool = { name: 'stub', run: runs }
    const socket = makeMockSocket()

    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-idem',
      workspaceName: 'ws-idem',
      executorId: 'ex-idem',
      tools: [testTool],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    // trigger 'connect' so startExecutor emits the announce (harmless here)
    socket.__trigger('connect')

    // first tool:call — real run
    const ack1 = vi.fn()
    socket.__trigger(
      'tool:call',
      { sessionId: 's1', callId: 'call-A', name: 'stub', input: {} },
      ack1,
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(runs).toHaveBeenCalledTimes(1)
    expect(ack1).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-A', ok: true, content: 'ran-tool', durationMs: expect.any(Number) }))

    // second tool:call with same callId — must NOT re-run, must ack from cache
    const ack2 = vi.fn()
    socket.__trigger(
      'tool:call',
      { sessionId: 's1', callId: 'call-A', name: 'stub', input: {} },
      ack2,
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(runs).toHaveBeenCalledTimes(1) // still 1 — didn't re-run
    expect(ack2).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-A', ok: true, content: 'ran-tool', durationMs: expect.any(Number) }))
  })

  it('does not collide when two Sessions reuse the same provider callId', async () => {
    const runs = vi.fn(async (_input, context) => `ran-${context.sessionId}`)
    const socket = makeMockSocket()
    startExecutor({
      host: 'http://x', workspaceId: 'ws-scoped', workspaceName: 'ws-scoped', executorId: 'ex-scoped',
      tools: [{ name: 'stub', run: runs }], ioFactory: (() => socket) as never, receiptStorePath: false,
    })
    socket.__trigger('connect')

    const first = vi.fn()
    socket.__trigger('tool:call', { sessionId: 'session-a', callId: 'same-call', name: 'stub', input: {} }, first)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = vi.fn()
    socket.__trigger('tool:call', { sessionId: 'session-b', callId: 'same-call', name: 'stub', input: {} }, second)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runs).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ callId: 'same-call', ok: true, content: 'ran-session-a', durationMs: expect.any(Number) }))
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ callId: 'same-call', ok: true, content: 'ran-session-b', durationMs: expect.any(Number) }))
  })

  it('acks internal directory RPCs even when the workspace receipt path is unwritable', async () => {
    const socket = makeMockSocket()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    startExecutor({
      host: 'http://x', workspaceId: 'ws-internal', workspaceName: 'ws-internal', executorId: 'ex-internal',
      tools: [{ name: '__fs_list_dirs', run: vi.fn(async () => JSON.stringify({ requestId: 'r1', workspaceId: 'ws-internal', path: '/workspace', roots: ['/workspace'], entries: [] })) }],
      ioFactory: (() => socket) as never,
      receiptStorePath: '/dev/null/execution-receipts.json',
      logger,
    })
    socket.__trigger('connect')

    const ack = vi.fn()
    socket.__trigger('tool:call', { sessionId: '__internal:ws-internal', callId: 'direct-1', name: '__fs_list_dirs', input: { requestId: 'r1', workspaceId: 'ws-internal', path: '/workspace' } }, ack)
    await vi.waitFor(() => expect(ack).toHaveBeenCalled())

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ tool: '__fs_list_dirs', internal: true, input: expect.objectContaining({ path: '/workspace' }) }), 'tool execution started')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('rejects an agent tool before execution when its journal cannot be loaded', async () => {
    const socket = makeMockSocket()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const runs = vi.fn(async () => 'SIDE_EFFECT_COMPLETED')
    startExecutor({
      host: 'http://x', workspaceId: 'ws-durability', workspaceName: 'ws-durability', executorId: 'ex-durability',
      tools: [{ name: 'shell', run: runs }],
      ioFactory: (() => socket) as never,
      receiptStorePath: '/dev/null/execution-receipts.json',
      logger,
    })
    socket.__trigger('connect')

    const ack = vi.fn()
    socket.__trigger('tool:call', { sessionId: 'session-1', callId: 'call-durability', name: 'shell', input: { command: 'printf ok', env: { API_TOKEN: 'secret-token', NODE_ENV: 'test' } } }, ack)
    await vi.waitFor(() => expect(ack).toHaveBeenCalled())

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, content: expect.stringContaining('EDURABILITY') }))
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'shell' }), expect.stringContaining('durability failed'))
    expect(runs).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'tool execution started')
  })

  it('returns unknown rather than confirmed success when completion persistence fails after a side effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kala-receipt-completion-failure-'))
    const sharedExecution = createExecutorSharedExecution(join(dir, 'receipts.json'))
    await sharedExecution.receiptStoreReady
    const persist = vi.spyOn(sharedExecution.receiptStore!, 'set').mockRejectedValue(new Error('fixture disk failure'))
    const socket = makeMockSocket()
    const runs = vi.fn(async () => 'SIDE_EFFECT_COMPLETED')
    const handle = startExecutor({
      host: 'http://x', workspaceId: 'ws-completion-failure', workspaceName: 'fixture', executorId: 'fixture',
      tools: [{ name: 'effect', run: runs }], sharedExecution, ioFactory: (() => socket) as never,
    })
    const call = { sessionId: 'session-fixture', callId: 'effect-fixture', name: 'effect', input: {} }
    const first = vi.fn()
    socket.__trigger('tool:call', call, first)
    await vi.waitFor(() => expect(first).toHaveBeenCalled())
    expect(JSON.parse(first.mock.calls[0]![0].content)).toMatchObject({ outcome: 'execution_unknown' })
    const replay = vi.fn()
    socket.__trigger('tool:call', call, replay)
    await vi.waitFor(() => expect(replay).toHaveBeenCalled())
    expect(replay).toHaveBeenCalledWith(first.mock.calls[0]![0])
    expect(runs).toHaveBeenCalledTimes(1)
    persist.mockRestore()
    await handle.close()
  })

  it('fans out completion to duplicate in-flight ACK callbacks without double-spawn', async () => {
    let resolveRun: ((v: string) => void) | null = null
    const runs = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve
        }),
    )
    const testTool: Tool = { name: 'slow', run: runs }
    const socket = makeMockSocket()

    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-slow',
      workspaceName: 'ws-slow',
      executorId: 'ex-slow',
      tools: [testTool],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })
    socket.__trigger('connect')

    // fire twice while runner is still awaited
    const ack1 = vi.fn()
    socket.__trigger('tool:call', { sessionId: 's1', callId: 'call-B', name: 'slow', input: {} }, ack1)
    await new Promise((r) => setTimeout(r, 5))

    const ack2 = vi.fn()
    socket.__trigger('tool:call', { sessionId: 's1', callId: 'call-B', name: 'slow', input: {} }, ack2)
    await new Promise((r) => setTimeout(r, 5))

    // Neither callback fires until the single invocation completes.
    expect(ack2).not.toHaveBeenCalled()
    expect(runs).toHaveBeenCalledTimes(1)

    // Finish once; both the old and replacement socket callbacks receive the
    // result so the host cannot strand pending ownership after reconnect.
    resolveRun!('slow-done')
    await new Promise((r) => setTimeout(r, 10))

    const expected = expect.objectContaining({ callId: 'call-B', ok: true, content: 'slow-done', durationMs: expect.any(Number) })
    expect(ack1).toHaveBeenCalledWith(expected)
    expect(ack2).toHaveBeenCalledWith(expected)
    expect(runs).toHaveBeenCalledTimes(1) // never re-ran
  })

  it('coalesces the same durable call across replica sockets even after its dispatch socket closes', async () => {
    let finish!: (value: string) => void
    const runs = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = makeMockSocket()
    const second = makeMockSocket()
    const dir = await mkdtemp(join(tmpdir(), 'kala-replica-receipts-'))
    const sharedExecution = createExecutorSharedExecution(join(dir, 'receipts.json'))
    const common = {
      host: 'http://localhost', workspaceId: 'ws-replicas', workspaceName: 'replicas', executorId: 'executor-one',
      tools: [{ name: 'effect', run: runs } satisfies Tool], sharedExecution,
    }
    const firstHandle = startExecutor({ ...common, replicaId: 'runtime-x', ioFactory: (() => first) as never })
    const secondHandle = startExecutor({ ...common, replicaId: 'runtime-y', ioFactory: (() => second) as never })
    first.__trigger('connect')
    second.__trigger('connect')

    const ackX = vi.fn()
    const ackY = vi.fn()
    const call = { sessionId: 'session-takeover', callId: 'same-call', name: 'effect', input: {} }
    first.__trigger('tool:call', call, ackX)
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(1))
    await firstHandle.close()
    // Abort is only a request: an external effect may ignore it or settle later.
    // Keep the shared execution barrier until its result/receipt is committed.
    expect(sharedExecution.inFlight.size).toBe(1)
    second.__trigger('tool:call', call, ackY)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runs).toHaveBeenCalledTimes(1)
    expect(ackY).not.toHaveBeenCalled()
    finish('one-effect')
    await vi.waitFor(() => expect(ackY).toHaveBeenCalled())

    expect(ackX).toHaveBeenCalledWith(expect.objectContaining({ ok: true, content: 'one-effect' }))
    expect(ackY).toHaveBeenCalledWith(expect.objectContaining({ ok: true, content: 'one-effect' }))
    expect(runs).toHaveBeenCalledTimes(1)

    const replay = vi.fn()
    second.__trigger('tool:call', call, replay)
    await vi.waitFor(() => expect(replay).toHaveBeenCalled())
    expect(runs).toHaveBeenCalledTimes(1)
    await sharedExecution.receiptStore?.flush()
    expect(sharedExecution.inFlight.size).toBe(0)
    await secondHandle.close()
  })

  it('resolves permanentError on executor:host_reject', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-reject',
      workspaceName: 'ws-reject',
      executorId: 'ex-reject',
      tools: [],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })
    socket.__trigger('connect')

    // Simulate host emitting an inbound executor:host_reject.
    socket.__trigger('executor:host_reject', {
      code: 'workspace_id_conflict',
      message: 'someone else already has this workspaceId',
    })

    await expect(handle.permanentError).resolves.toEqual({
      code: 'workspace_id_conflict',
      message: 'someone else already has this workspaceId',
    })
    // The permanent-error handler should have disconnected the socket to
    // stop socket.io's own reconnection loop.
    expect(socket.connected).toBe(false)
  })

  it('passes executor:welcome long-term token to the persistence callback', () => {
    const socket = makeMockSocket()
    const onToken = vi.fn()
    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-welcome',
      workspaceName: 'ws-welcome',
      executorId: 'ex-welcome',
      tools: [],
      onToken,
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    socket.__trigger('executor:welcome', { token: 'ak_exec_saved', workspaceId: 'ws-welcome' })

    expect(onToken).toHaveBeenCalledWith('ak_exec_saved')
    expect(socket.auth).toEqual({
      role: 'executor',
      clientVersion: expect.any(String),
      token: 'ak_exec_saved',
    })
  })

  it('logs transient connection failures as compact summaries without raw error objects', () => {
    const socket = makeMockSocket()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    startExecutor({
      host: 'https://host.example',
      workspaceId: 'ws-log',
      workspaceName: 'ws-log',
      executorId: 'ex-log',
      tools: [],
      logger,
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })
    const error = Object.assign(new Error('websocket error'), {
      type: 'TransportError',
      description: { message: 'Client network socket disconnected\nbefore secure TLS connection was established', code: 'ECONNRESET' },
    })

    socket.__trigger('connect_error', error)

    expect(logger.warn).toHaveBeenCalledWith({
      errorType: 'TransportError',
      reason: 'Client network socket disconnected before secure TLS connection was established',
      code: 'ECONNRESET',
    }, 'host connection failed; retrying')
    const warning = logger.warn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(warning).not.toHaveProperty('err')
    expect(JSON.stringify(warning)).not.toContain('stack')
    expect(JSON.stringify(warning)).not.toContain('\\n')
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      errorType: 'TransportError',
      diagnostic: expect.not.stringContaining('\n'),
    }), 'host connection failure diagnostic')
  })

  it('resolves permanentError on version_incompatible connect_error', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-ver',
      workspaceName: 'ws-ver',
      executorId: 'ex-ver',
      tools: [],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    socket.__trigger('connect_error', new Error('version_incompatible'))

    await expect(handle.permanentError).resolves.toEqual({
      code: 'version_incompatible',
      message: 'version_incompatible',
    })
    expect(socket.connected).toBe(false)
  })

  it('keeps the executor alive when socket.io reports reconnect_failed', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-retry',
      workspaceName: 'ws-retry',
      executorId: 'ex-retry',
      tools: [],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    const resolved = await Promise.race([
      handle.permanentError.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])
    socket.io.emit('reconnect_failed')
    const resolvedAfterFailure = await Promise.race([
      handle.permanentError.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])

    expect(resolved).toBe(false)
    expect(resolvedAfterFailure).toBe(false)
    expect(socket.connected).toBe(true)
    handle.close()
  })

  it('configures socket.io to retry forever with a bounded one minute backoff', () => {
    const socket = makeMockSocket()
    const ioFactory = vi.fn(() => socket)

    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-retry-config',
      workspaceName: 'ws-retry-config',
      executorId: 'ex-retry-config',
      tools: [],
      ioFactory: ioFactory as never,
    })

    expect(ioFactory).toHaveBeenCalledWith(
      'http://x/executor',
      expect.objectContaining({
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 60_000,
        reconnectionAttempts: Infinity,
      }),
    )
  })
})
