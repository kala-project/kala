import { chmod, copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { executionRequestDigest, ExecutionReceiptStore,
  learningReceiptArchivePath, learningReceiptIndexPath } from './execution-receipts.js'

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
    expect(Object.keys(persisted).sort()).toEqual(['__learningArchiveIndex', 'call-a', 'call-b', 'call-c'])
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

  it('archives completed learning receipts without losing started barriers or blocking unrelated admissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-receipts-'))
    const path = join(dir, 'receipts.json')
    const skillId = 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const memoryId = `memory-file-${'a'.repeat(64)}`
    const first = new ExecutionReceiptStore(path)
    await first.begin(`session:${skillId}`, skillId, 'b'.repeat(64), '7',
      { pgid: process.pid, leaderStartTicks: '123', bootId: '00000000-0000-0000-0000-000000000000', pidNamespace: 'pid:[1]' })
    await first.set(`session:${skillId}`, { callId: skillId, ok: true, content: 'done' })
    await first.begin(`session:${memoryId}`, memoryId, 'c'.repeat(64), '7',
      { pgid: process.pid, leaderStartTicks: '123', bootId: '00000000-0000-0000-0000-000000000000', pidNamespace: 'pid:[1]' })
    const disk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(disk.__learningArchiveIndex).toEqual({ version: 1, count: 1 })
    expect(JSON.parse(await readFile(learningReceiptIndexPath(path, `session:${skillId}`), 'utf8')))
      .toHaveProperty('archiveDigest')
    expect((await readFile(learningReceiptArchivePath(path, `session:${skillId}`), 'utf8')))
      .toContain('"completedAt"')
    for (let i = 0; i < 499; i++) {
      const id = `memory-file-${i.toString(16).padStart(64, '0')}`
      disk[`session:${id}`] = { startedAt: 1, callId: id, requestDigest: 'c'.repeat(64), ownerGeneration: '7' }
    }
    await writeFile(path, JSON.stringify(disk))
    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    expect(await restarted.query({ sessionId: 'session', callId: skillId,
      requestDigest: 'b'.repeat(64), ownerGeneration: '7' })).toMatchObject({
      status: 'completed', result: { ok: true },
    })
    expect(await restarted.query({ sessionId: 'session', callId: memoryId,
      requestDigest: 'c'.repeat(64), ownerGeneration: '7' })).toEqual({ status: 'started_unknown' })
    await expect(restarted.begin('session:new-call', 'new-call'))
      .rejects.toThrow('reconciliation')
    expect(await restarted.query({ sessionId: 'session', callId: skillId,
      requestDigest: 'b'.repeat(64), ownerGeneration: '7' })).toMatchObject({ status: 'completed' })
    await unlink(learningReceiptArchivePath(path, `session:${skillId}`))
    expect(await restarted.query({ sessionId: 'session', callId: skillId,
      requestDigest: 'b'.repeat(64), ownerGeneration: '7' })).toEqual({ status: 'unavailable' })
    await expect(new ExecutionReceiptStore(path).load()).rejects.toThrow('indexed learning archive entry missing')
  })

  it('keeps 501 original pinned completions replayable without the former 500-call admission stall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-archive-capacity-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)
    for (let index = 0; index < 501; index++) {
      const callId = `memory-file-${index.toString(16).padStart(64, '0')}`
      const key = `session:${callId}`
      await store.begin(key, callId, 'f'.repeat(64), '1')
      await store.set(key, { callId, ok: true, content: 'done' })
    }
    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    const journal = await readFile(path, 'utf8')
    expect(journal.length).toBeLessThan(200)
    expect(restarted.archiveHealth()).toMatchObject({ indexed: 501, retired: 0 })
    expect(await restarted.query({ sessionId: 'session',
      callId: `memory-file-${'0'.repeat(64)}`, requestDigest: 'f'.repeat(64), ownerGeneration: '1',
    })).toMatchObject({ status: 'completed', result: { ok: true } })
    await restarted.begin('session:ordinary-call', 'ordinary-call')
    expect(await restarted.query({ sessionId: 'session', callId: 'ordinary-call',
      requestDigest: 'a'.repeat(64), ownerGeneration: '1' })).toEqual({ status: 'unavailable' })
    await expect(restarted.begin(`session:memory-file-${'0'.repeat(64)}`,
      `memory-file-${'0'.repeat(64)}`)).rejects.toThrow('already recorded')
    await unlink(learningReceiptIndexPath(path, `session:memory-file-${'0'.repeat(64)}`))
    await expect(new ExecutionReceiptStore(path).load()).rejects.toThrow('index lost entries')
  }, 90_000)

  it('retains a verified permanent replay tombstone when a finalized archive moves to offline storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-offline-retirement-'))
    const path = join(dir, 'receipts.json')
    const cold = join(dir, 'cold')
    await mkdir(cold, { mode: 0o700 })
    const callId = `memory-file-${'d'.repeat(64)}`
    const key = `session:${callId}`
    const original = new ExecutionReceiptStore(path)
    await original.begin(key, callId, 'f'.repeat(64), '2')
    await original.set(key, { callId, ok: true, content: 'durable write' })
    const before = original.archiveHealth().activeBytes
    await expect(original.retireFinalizedLearning(key, 'e'.repeat(64), '2', cold, 'incident'))
      .rejects.toThrow('not available')
    await original.retireFinalizedLearning(key, 'f'.repeat(64), '2', cold, 'incident')
    expect(original.archiveHealth()).toMatchObject({ indexed: 1, retired: 1, activeBytes: 0 })
    expect(before).toBeGreaterThan(0)
    expect(original.get(key, 'f'.repeat(64))?.ok).toBe(false)
    expect(await original.query({ sessionId: 'session', callId,
      requestDigest: 'f'.repeat(64), ownerGeneration: '2' })).toEqual({ status: 'unavailable' })
    await expect(original.begin(key, callId)).rejects.toThrow('already recorded')
    await copyFile(join(cold, basename(learningReceiptArchivePath(path, key))),
      learningReceiptArchivePath(path, key))
    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    expect(restarted.archiveHealth().activeBytes).toBeGreaterThan(0)
    expect(restarted.inspectRetirement(key)).toEqual({
      requestDigest: 'f'.repeat(64), ownerGeneration: '2',
    })
    await restarted.verifyOfflineRetirement(key, cold)
    expect(restarted.get(key)?.ok).toBe(false)
    await restarted.retireFinalizedLearning(key, 'f'.repeat(64), '2', cold, 'incident')
    expect(restarted.archiveHealth().activeBytes).toBe(0)
    await restarted.begin('session:ordinary', 'ordinary')
    const coldPath = join(cold, basename(learningReceiptArchivePath(path, key)))
    await writeFile(coldPath, 'corrupted cold copy')
    await expect(restarted.verifyOfflineRetirement(key, cold)).rejects.toThrow('durable index')
  })

  it('durably denies new learning work at its archive cap while continuing unrelated tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-archive-limit-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path, { archiveMaxBytes: 65_536 })
    const callId = `memory-file-${'e'.repeat(64)}`
    await store.begin(`session:${callId}`, callId, 'a'.repeat(64), '2')
    await store.set(`session:${callId}`, { callId, ok: true, content: 'status '.repeat(5_000) })
    expect(store.archiveHealth().atCapacity).toBe(true)
    const refused = `memory-file-${'f'.repeat(64)}`
    await expect(store.begin(`session:${refused}`, refused, 'b'.repeat(64), '2'))
      .rejects.toThrow('durable never-admitted receipt persisted')
    expect(await store.query({ sessionId: 'session', callId: refused,
      requestDigest: 'b'.repeat(64), ownerGeneration: '2' })).toEqual({ status: 'denied' })
    await store.begin('session:ordinary', 'ordinary')
  })

  it('reports an oversized unarchived final receipt as full across restarts rather than admitting more learning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-oversized-'))
    const path = join(dir, 'receipts.json')
    const original = new ExecutionReceiptStore(path, { archiveMaxBytes: 65_536 })
    const callId = `memory-file-${'1'.repeat(64)}`
    await original.begin(`session:${callId}`, callId, 'a'.repeat(64), '2')
    await original.set(`session:${callId}`, { callId, ok: true, content: 'x'.repeat(66_000) })
    expect(original.archiveHealth()).toMatchObject({ indexed: 0, atCapacity: true })
    const restarted = new ExecutionReceiptStore(path, { archiveMaxBytes: 65_536 })
    await restarted.load()
    expect(restarted.archiveHealth().atCapacity).toBe(true)
    const refused = `memory-file-${'2'.repeat(64)}`
    await expect(restarted.begin(`session:${refused}`, refused, 'b'.repeat(64), '3'))
      .rejects.toThrow('durable never-admitted receipt persisted')
    expect(await restarted.query({ sessionId: 'session', callId: refused,
      requestDigest: 'b'.repeat(64), ownerGeneration: '3' })).toEqual({ status: 'denied' })
  })

  it('recovers a negative admission after archive publication but before its index is persisted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-negative-crash-'))
    const path = join(dir, 'receipts.json')
    const callId = `memory-file-${'3'.repeat(64)}`
    const key = `session:${callId}`
    const digest = 'a'.repeat(64)
    const indexDirectory = `${path}.learning-index`
    await mkdir(indexDirectory, { mode: 0o500 })
    const original = new ExecutionReceiptStore(path)
    await expect(original.denyLearning(key, callId, digest, '2')).rejects.toMatchObject({ code: 'EACCES' })
    const staged = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(staged[key]).toMatchObject({ neverAdmitted: true, requestDigest: digest, ownerGeneration: '2' })
    expect(JSON.parse(await readFile(learningReceiptArchivePath(path, key), 'utf8'))).toMatchObject({
      key, receipt: { neverAdmitted: true },
    })
    await expect(readFile(learningReceiptIndexPath(path, key))).rejects.toMatchObject({ code: 'ENOENT' })
    await chmod(indexDirectory, 0o700)
    const rebooted = new ExecutionReceiptStore(path)
    await rebooted.load()
    expect(await rebooted.query({ sessionId: 'session', callId,
      requestDigest: digest, ownerGeneration: '2' })).toEqual({ status: 'denied' })
    expect(rebooted.get(key, 'b'.repeat(64), callId)?.failure?.code).toBe('execution_conflict')
    await expect(rebooted.begin(key, callId, digest, '2')).rejects.toThrow('already recorded')
    await rebooted.begin('session:ordinary', 'ordinary')
  })

  it('fences an orphan negative archive with no matching journal entry instead of trusting its self-declared denial', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-legacy-orphan-'))
    const path = join(dir, 'receipts.json')
    const callId = `memory-file-${'4'.repeat(64)}`
    const key = `session:${callId}`
    const store = new ExecutionReceiptStore(path)
    await store.denyLearning(key, callId, 'a'.repeat(64), '2')
    const archived = await readFile(learningReceiptArchivePath(path, key), 'utf8')
    const index = JSON.parse(await readFile(learningReceiptIndexPath(path, key), 'utf8')) as { archiveDigest: string }
    await unlink(learningReceiptIndexPath(path, key))
    await writeFile(path, JSON.stringify({ __learningArchiveIndex: { version: 1, count: 0 } }))
    const rebooted = new ExecutionReceiptStore(path)
    await expect(rebooted.load()).rejects.toThrow('unindexed learning archive without journal evidence')
    expect(await rebooted.query({ sessionId: 'session', callId,
      requestDigest: 'a'.repeat(64), ownerGeneration: '2' })).toEqual({ status: 'unavailable' })
    await writeFile(path, JSON.stringify({
      __learningArchiveIndex: { version: 1, count: 0 }, [key]: { archiveDigest: index.archiveDigest },
    }))
    const pointerOnly = new ExecutionReceiptStore(path)
    await expect(pointerOnly.load()).rejects.toThrow('negative learning archive conflicts with original journal')
    expect(await pointerOnly.query({ sessionId: 'session', callId,
      requestDigest: 'a'.repeat(64), ownerGeneration: '2' })).toEqual({ status: 'unavailable' })
    expect(await readFile(learningReceiptArchivePath(path, key), 'utf8')).toBe(archived)
    await unlink(path)
    await expect(new ExecutionReceiptStore(path).load()).rejects.toThrow('journal missing')
  })

  it('does not replace a matching started journal with an old or forged negative archive, indexed or unindexed', async () => {
    for (const indexed of [true, false]) {
      const dir = await mkdtemp(join(tmpdir(), 'ak-learning-started-negative-'))
      const path = join(dir, 'receipts.json')
      const callId = `memory-file-${'5'.repeat(64)}`
      const key = `session:${callId}`
      const digest = 'a'.repeat(64)
      const original = new ExecutionReceiptStore(path)
      await original.denyLearning(key, callId, digest, '2')
      const archived = await readFile(learningReceiptArchivePath(path, key), 'utf8')
      const journal = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      journal[key] = { callId, startedAt: Date.now(), requestDigest: digest, ownerGeneration: '2' }
      if (!indexed) {
        await unlink(learningReceiptIndexPath(path, key))
        journal.__learningArchiveIndex = { version: 1, count: 0 }
      }
      await writeFile(path, JSON.stringify(journal))
      const rebooted = new ExecutionReceiptStore(path)
      await expect(rebooted.load()).rejects.toThrow('negative learning archive conflicts with original journal')
      expect(await rebooted.query({ sessionId: 'session', callId,
        requestDigest: digest, ownerGeneration: '2' })).toEqual({ status: 'unavailable' })
      expect(await readFile(learningReceiptArchivePath(path, key), 'utf8')).toBe(archived)
    }
  })

  it('rejects a changed completed journal even when an archived denial claims the same identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-conflicting-completion-'))
    const path = join(dir, 'receipts.json')
    const callId = `memory-file-${'6'.repeat(64)}`
    const key = `session:${callId}`
    const store = new ExecutionReceiptStore(path)
    await store.denyLearning(key, callId, 'a'.repeat(64), '2')
    const journal = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    journal[key] = { completedAt: Date.now(), requestDigest: 'a'.repeat(64),
      ownerGeneration: '2', result: { callId, ok: true, content: 'original completed write' } }
    await writeFile(path, JSON.stringify(journal))
    await expect(new ExecutionReceiptStore(path).load()).rejects.toThrow('conflicting learning receipt archive and journal')
    expect(await store.query({ sessionId: 'session', callId,
      requestDigest: 'a'.repeat(64), ownerGeneration: '2' })).toEqual({ status: 'unavailable' })
  })

  it('recovers a completed archive ahead of its pointer without replaying the old started journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-archive-crash-'))
    const path = join(dir, 'receipts.json')
    const callId = `memory-file-${'e'.repeat(64)}`
    const key = `session:${callId}`
    const original = new ExecutionReceiptStore(path)
    await original.begin(key, callId, 'f'.repeat(64), '2')
    const started = await readFile(path, 'utf8')
    await original.set(key, { callId, ok: true, content: 'written once' })
    await writeFile(path, started)
    const recovered = new ExecutionReceiptStore(path)
    await recovered.load()
    expect(await recovered.query({ sessionId: 'session', callId,
      requestDigest: 'f'.repeat(64), ownerGeneration: '2' })).toMatchObject({
      status: 'completed', result: { content: 'written once' },
    })
    await expect(recovered.begin(key, callId)).rejects.toThrow('already recorded')
    await recovered.begin('session:ordinary', 'ordinary')
    expect(JSON.parse(await readFile(path, 'utf8')).__learningArchiveIndex).toEqual({ version: 1, count: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))[key]).toBeUndefined()
  })

  it('migrates original completed learning journal entries to verified archives before admitting new calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-archive-upgrade-'))
    const path = join(dir, 'receipts.json')
    const callId = `memory-file-${'c'.repeat(64)}`
    const key = `session:${callId}`
    await writeFile(path, JSON.stringify({
      [key]: {
        completedAt: 1, result: { callId, ok: true, content: 'original completion' },
        requestDigest: 'a'.repeat(64), ownerGeneration: '2',
      },
    }))
    const store = new ExecutionReceiptStore(path)
    await store.load()
    expect(JSON.parse(await readFile(path, 'utf8')).__learningArchiveIndex).toEqual({ version: 1, count: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))[key]).toBeUndefined()
    expect(await store.query({ sessionId: 'session', callId,
      requestDigest: 'a'.repeat(64), ownerGeneration: '2' })).toMatchObject({
      status: 'completed', result: { content: 'original completion' },
    })
    await store.begin('session:new-call', 'new-call')
  })

  it('upgrades the prior per-call pointer journal without losing a durable completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-learning-pointer-upgrade-'))
    const path = join(dir, 'receipts.json')
    const callId = `memory-file-${'b'.repeat(64)}`
    const key = `session:${callId}`
    const original = new ExecutionReceiptStore(path)
    await original.begin(key, callId, 'a'.repeat(64), '2')
    await original.set(key, { callId, ok: true, content: 'original' })
    const indexPath = learningReceiptIndexPath(path, key)
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { archiveDigest: string }
    await writeFile(path, JSON.stringify({ [key]: { archiveDigest: index.archiveDigest } }))
    await unlink(indexPath)
    const upgraded = new ExecutionReceiptStore(path)
    await upgraded.load()
    expect(await upgraded.query({ sessionId: 'session', callId,
      requestDigest: 'a'.repeat(64), ownerGeneration: '2' })).toMatchObject({
      status: 'completed', result: { content: 'original' },
    })
    expect(JSON.parse(await readFile(path, 'utf8')).__learningArchiveIndex).toEqual({ version: 1, count: 1 })
    await expect(upgraded.begin(key, callId)).rejects.toThrow('already recorded')
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
