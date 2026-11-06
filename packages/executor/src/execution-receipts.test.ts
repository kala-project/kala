import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { executionRequestDigest, ExecutionReceiptStore } from './execution-receipts.js'

describe('ExecutionReceiptStore', () => {
  it('binds persisted started and completed receipts to canonical requests, not transport timeouts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-digest-'))
    const path = join(dir, 'receipts.json')
    const original = { sessionId: 'session', callId: 'call', name: 'shell', cwd: '/workspace', input: { command: 'effect', env: { Z: 'z', A: 'a' } } }
    const equivalent = { ...original, ackTimeoutMs: 42, ownerGeneration: '8', input: { env: { A: 'a', Z: 'z' }, command: 'effect' } }
    const digest = executionRequestDigest(original)
    expect(executionRequestDigest(equivalent)).toBe(digest)
    const store = new ExecutionReceiptStore(path)
    await store.begin('session:call', 'call', digest, '7')
    expect(JSON.parse(await readFile(path, 'utf8'))['session:call'].ownerGeneration).toBe('7')
    const pending = new ExecutionReceiptStore(path)
    await pending.load()
    expect(JSON.parse(pending.get('session:call', digest)!.content).outcome).toBe('execution_unknown')
    const changed = executionRequestDigest({ ...original, input: { command: 'different-effect' } })
    expect(JSON.parse(pending.get('session:call', changed)!.content).outcome).toBe('execution_conflict')
    await store.set('session:call', { callId: 'call', ok: true, content: 'done' })
    const completed = new ExecutionReceiptStore(path)
    await completed.load()
    expect(JSON.parse(await readFile(path, 'utf8'))['session:call'].ownerGeneration).toBe('7')
    expect(completed.get('session:call', digest)?.content).toBe('done')
    for (const request of [{ ...original, name: 'other' }, { ...original, cwd: '/other' }, { ...original, sessionId: 'other' }, { ...original, callId: 'replacement' }]) {
      const result = completed.get('session:call', executionRequestDigest(request), request.callId)!
      expect(result.callId).toBe(request.callId)
      expect(JSON.parse(result.content).outcome).toBe('execution_conflict')
    }
    expect(await readFile(path, 'utf8')).not.toContain('different-effect')
  })

  it('keeps legacy receipts as replay barriers without claiming that their requests match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-legacy-'))
    const path = join(dir, 'receipts.json')
    await writeFile(path, JSON.stringify({
      call: { completedAt: Date.now(), result: { callId: 'call', ok: true, content: 'old-result' } },
    }))
    const store = new ExecutionReceiptStore(path)
    await store.load()
    const digest = executionRequestDigest({ sessionId: 'session', callId: 'call', name: 'shell', input: {} })
    expect(JSON.parse(store.get('call', digest)!.content)).toMatchObject({ outcome: 'execution_unknown' })
    await expect(store.begin('call', 'call', digest)).rejects.toThrow('already recorded')
    expect(await readFile(path, 'utf8')).toContain('old-result')
  })

  it('persists completed call receipts across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-'))
    const path = join(dir, 'receipts.json')
    const first = new ExecutionReceiptStore(path)
    await first.load()
    await first.set('call-1', { callId: 'call-1', ok: true, content: 'done' })

    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    expect(restarted.get('call-1')).toEqual({ callId: 'call-1', ok: true, content: 'done' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('call-1')
  })

  it('coalesces a burst into one durable snapshot without losing receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-burst-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)

    await Promise.all([
      store.set('call-a', { callId: 'call-a', ok: true, content: 'a' }),
      store.set('call-b', { callId: 'call-b', ok: true, content: 'b' }),
      store.set('call-c', { callId: 'call-c', ok: false, content: 'c' }),
    ])
    await store.flush()

    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual(['call-a', 'call-b', 'call-c'])
  })

  it('serializes commits that arrive while a snapshot is being persisted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-serial-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)

    const first = store.set('call-a', { callId: 'call-a', ok: true, content: 'a' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const second = store.set('call-b', { callId: 'call-b', ok: true, content: 'b' })
    await Promise.all([first, second])

    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    expect(restarted.get('call-a')?.content).toBe('a')
    expect(restarted.get('call-b')?.content).toBe('b')
  })
  it('retains old unresolved calls across TTL and capacity pressure and denies overflow admission', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-pending-'))
    const path = join(dir, 'receipts.json')
    await writeFile(path, JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
      `pending-${index}`, { startedAt: 1, callId: `pending-${index}` },
    ]))))
    const store = new ExecutionReceiptStore(path)
    await store.load()
    await store.set('completed', { callId: 'completed', ok: true, content: 'done' })
    expect(JSON.parse(store.get('pending-0')!.content)).toMatchObject({ outcome: 'execution_unknown' })
    await expect(store.begin('new-call', 'new-call')).rejects.toThrow('reconciliation')
    const recovered = new ExecutionReceiptStore(path)
    await recovered.load()
    expect(recovered.get('pending-499')?.ok).toBe(false)
    // Only a confirmed completion releases an unresolved slot, never age/eviction.
    const completion = store.set('pending-0', { callId: 'pending-0', ok: true, content: 'confirmed' })
    await expect(store.begin('too-early', 'too-early')).rejects.toThrow('reconciliation')
    await completion
    await store.begin('new-call', 'new-call')
    expect(store.get('new-call')?.ok).toBe(false)
  })

  it('rejects a malformed journal without installing a partial cache or overwriting evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-invalid-'))
    const path = join(dir, 'receipts.json')
    const text = JSON.stringify({
      completed: { completedAt: Date.now(), result: { callId: 'completed', ok: true, content: 'done' } },
      unresolved: { startedAt: 1 },
    })
    await writeFile(path, text)
    const store = new ExecutionReceiptStore(path)
    await expect(store.load()).rejects.toThrow('invalid execution receipt journal entry')
    expect(store.get('completed')).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('releases failed pre-run admission so a later healthy commit cannot strand false unknown calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-admission-failure-'))
    const blocked = join(dir, 'blocked-parent')
    await writeFile(blocked, 'fixture')
    const path = join(blocked, 'receipts.json')
    const store = new ExecutionReceiptStore(path)
    await expect(store.begin('not-started', 'not-started')).rejects.toBeDefined()
    expect(store.get('not-started')).toBeUndefined()
    await unlink(blocked)
    await store.begin('healthy', 'healthy')
    const recovered = new ExecutionReceiptStore(path)
    await recovered.load()
    expect(recovered.get('not-started')).toBeUndefined()
    expect(recovered.get('healthy')?.ok).toBe(false)
  })

  it('queries only durable journal evidence without executing, and fails closed on missing, expired or corrupt evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-query-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)
    const query = { sessionId: 'session', callId: 'call', ownerGeneration: '3', requestDigest: 'a'.repeat(64) }
    expect(await store.query(query)).toEqual({ status: 'unavailable' })
    await store.begin('session:call', 'call', query.requestDigest, query.ownerGeneration)
    expect(await store.query(query)).toEqual({ status: 'started_unknown' })
    expect(await store.query({ ...query, ownerGeneration: '4' })).toEqual({ status: 'conflict' })
    expect(await store.query({ ...query, requestDigest: 'b'.repeat(64) })).toEqual({ status: 'conflict' })
    expect(await store.query({ ...query, callId: 'missing' })).toEqual({ status: 'absent_with_valid_journal' })
    await store.set('session:call', { callId: 'call', ok: true, content: 'durable' })
    expect(await store.query(query)).toEqual({ status: 'completed', result: { callId: 'call', ok: true, content: 'durable' } })
    await writeFile(path, JSON.stringify({ 'session:call': { completedAt: 1, ownerGeneration: '3', requestDigest: query.requestDigest, result: { callId: 'call', ok: true, content: 'expired' } } }))
    expect(await store.query(query)).toEqual({ status: 'unavailable' })
    await writeFile(path, '{"session:call":')
    expect(await store.query(query)).toEqual({ status: 'unavailable' })
    await writeFile(path, JSON.stringify({ 'session:call': { startedAt: 1 } }))
    expect(await store.query(query)).toEqual({ status: 'unavailable' })
    await unlink(path)
    expect(await store.query(query)).toEqual({ status: 'unavailable' })
  })

  it('durably marks an owner-fenced Stop before acknowledging a cancellation signal, never treating it as rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-cancel-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)
    const request = { sessionId: 's', callId: 'c', ownerGeneration: '2', requestDigest: 'a'.repeat(64), stopCommandId: 'stop-1' }
    expect(await store.requestCancellation(request)).toEqual({ status: 'unavailable' })
    await store.begin('s:c', 'c', request.requestDigest, request.ownerGeneration)
    expect(await store.requestCancellation({ ...request, ownerGeneration: '3' })).toEqual({ status: 'conflict' })
    expect(await store.requestCancellation({ ...request, requestDigest: 'b'.repeat(64) })).toEqual({ status: 'conflict' })
    expect(await store.requestCancellation(request)).toEqual({ status: 'cancel_requested' })
    expect(JSON.parse(await readFile(path, 'utf8'))['s:c']).toMatchObject({ stopCommandId: 'stop-1', cancelRequestedAt: expect.any(Number) })
    expect(await store.requestCancellation(request)).toEqual({ status: 'cancel_requested' })
    expect(await store.requestCancellation({ ...request, stopCommandId: 'stop-2' })).toEqual({ status: 'conflict' })
    await store.set('s:c', { callId: 'c', ok: true, content: 'effect happened before Stop' })
    expect(await store.requestCancellation(request)).toEqual({ status: 'completed', result: { callId: 'c', ok: true, content: 'effect happened before Stop' } })
    expect(JSON.parse(await readFile(path, 'utf8'))['s:c'].stopCommandId).toBe('stop-1')
    await writeFile(path, '{"bad":')
    expect(await store.requestCancellation(request)).toEqual({ status: 'unavailable' })
  })

})
