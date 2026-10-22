import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createConfig, step } from '@agent-kernel/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadPersistedMessageQueueState, persistMessageQueueSnapshot } from '../message-queue-store.js'
import { createPostgresHotStateStore, LeaseFencedError, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { PostgresSessionAuthority, SessionDeletingError } from './postgres-session-authority.js'
import { SessionNotFoundError, SessionStore } from './session.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const config = createConfig({ tools: [], systemPrompt: 'private cloud' })

integrationDescribe('SessionStore PostgreSQL authority integration', () => {
  const testProject = `kala-session-store-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const roots: string[] = []
  const hotStores: PostgresHotStateStore[] = []
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_session_store_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${port}/kala_session_store_test`
    const probe = makeAuthority('probe')
    await eventually(async () => await probe.initialize(), 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(hotStores.map(async (store) => await store.close()))
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function makeAuthority(owner: string): PostgresSessionAuthority {
    const hot = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${owner}` })
    hotStores.push(hot)
    return new PostgresSessionAuthority(hot, 'tenant-a', { ownerId: owner, leaseTtlMs: 2_000, leaseWaitMs: 5_000 })
  }

  function makeStore(owner: string, deleteRegisteredArtifacts?: (sessionId: string) => Promise<void>): { store: SessionStore; root: string; authority: PostgresSessionAuthority } {
    const parent = mkdtempSync(join(tmpdir(), 'kala-pg-session-'))
    const root = join(parent, 'sessions-not-created')
    roots.push(parent)
    const authority = makeAuthority(owner)
    return { store: new SessionStore(root, { authority, deleteRegisteredArtifacts }), root, authority }
  }

  it('recovers committed state in a new process without creating Session JSONL directories', async () => {
    const first = makeStore('recovery-writer')
    const record = await first.store.create({
      sessionId: 'recovery-session',
      config,
      organizationId: 'org-a',
      workspaceId: 'workspace-a',
    })
    const event = { kind: 'user_message', text: 'persist me' } as const
    const transition = step(record.state, event, record.config)
    await first.store.record(record.sessionId, event, transition.effects, transition.next)

    expect(existsSync(first.root)).toBe(false)
    const second = makeStore('recovery-reader')
    const recovered = await second.store.load(record.sessionId, { recoverDangling: false })
    expect(recovered.state).toEqual(transition.next)
    expect(recovered.firstUserMessage).toBe('persist me')
    expect(await second.store.listSessionIdsForOrganization('org-a')).toEqual(['recovery-session'])
    expect((await second.store.listSummaries())[0]).toMatchObject({ sessionId: 'recovery-session', eventCount: 1 })
    expect(existsSync(second.root)).toBe(false)
  })

  it('replays delta audit history in another client when the latest projection is missing', async () => {
    const writer = makeAuthority('delta-recovery-writer')
    await writer.initialize()
    const sessionId = 'delta-recovery-session'
    await writer.create({ sessionId, state: { cursor: 0 }, chunks: [] })
    for (let index = 1; index <= 3; index += 1) {
      await writer.mutate(sessionId, {
        mutationId: `delta-recovery-${index}`,
        eventType: 'session.chunk_appended',
        apply(current) {
          if (!current) throw new Error('missing delta recovery document')
          return {
            ...current,
            state: { cursor: index },
            chunks: [...current.chunks as string[], `chunk-${index}`],
          }
        },
      })
    }
    await writer.hotState.database.query(`DELETE FROM tenant_session_latest_projection
      WHERE tenant_id = $1 AND session_id = $2`, ['tenant-a', sessionId])

    const reader = makeAuthority('delta-recovery-reader')
    await reader.initialize()
    await expect(reader.load(sessionId)).resolves.toMatchObject({
      state: { cursor: 3 }, chunks: ['chunk-1', 'chunk-2', 'chunk-3'],
    })
    const repaired = await reader.hotState.database.query<{ version: string }>(`SELECT version
      FROM tenant_session_latest_projection WHERE tenant_id = $1 AND session_id = $2`, ['tenant-a', sessionId])
    expect(repaired.rows).toEqual([{ version: '4' }])
  })

  it('keeps long-Session audit growth proportional to deltas rather than repeated documents', async () => {
    const authority = makeAuthority('write-amplification')
    await authority.initialize()
    const sessionId = 'write-amplification-session'
    await authority.create({ sessionId, state: { cursor: 0 }, chunks: [] })
    const chunkCount = 64
    for (let index = 1; index <= chunkCount; index += 1) {
      await authority.mutate(sessionId, {
        mutationId: `write-amplification-${index}`,
        eventType: 'session.chunk_appended',
        apply(current) {
          if (!current) throw new Error('missing write amplification document')
          return {
            ...current,
            state: { cursor: index },
            chunks: [...current.chunks as string[], `${String(index).padStart(4, '0')}:${'x'.repeat(1_024)}`],
          }
        },
      })
    }

    const sizes = await authority.hotState.database.query<{
      audit_bytes: string
      document_bytes: string
      full_document_events: string
    }>(`SELECT
        SUM(octet_length(event.payload::text))::text AS audit_bytes,
        octet_length(projection.document::text)::text AS document_bytes,
        COUNT(*) FILTER (WHERE event.payload ? 'document')::text AS full_document_events
      FROM tenant_runtime_hot_events event
      JOIN tenant_session_latest_projection projection
        ON projection.tenant_id = event.tenant_id AND projection.session_id = event.scope_id
      WHERE event.tenant_id = $1 AND event.scope_type = 'session' AND event.scope_id = $2
      GROUP BY projection.document`, ['tenant-a', sessionId])
    const [size] = sizes.rows
    expect(size).toBeDefined()
    expect(size!.full_document_events).toBe('0')
    expect(Number(size!.audit_bytes)).toBeLessThan(Number(size!.document_bytes) * 2)
    expect((await authority.load(sessionId))?.state.cursor).toBe(chunkCount)
  }, 30_000)

  it('replays unversioned and schema-version 2 full-document rows before new deltas', async () => {
    const writer = makeAuthority('legacy-row-writer')
    await writer.initialize()
    const sessionId = 'legacy-row-session'
    const scope = { tenantId: 'tenant-a', scopeType: 'session' as const, scopeId: sessionId }
    const lease = await writer.hotState.acquireLease(scope, 'legacy-row-fixture', 2_000)
    await writer.hotState.appendEvent(lease, {
      idempotencyKey: 'legacy-create',
      eventType: 'session.created',
      payload: { document: { sessionId, state: { cursor: 1 }, chunks: ['unversioned'] } },
    })
    await writer.hotState.appendEvent(lease, {
      idempotencyKey: 'legacy-v2-update',
      eventType: 'session.updated',
      payload: { schemaVersion: 2, document: { sessionId, state: { cursor: 2 }, chunks: ['legacy-v2'] } },
    })
    await writer.hotState.releaseLease(lease)

    const upgrader = makeAuthority('legacy-row-upgrader')
    await upgrader.initialize()
    await expect(upgrader.load(sessionId)).resolves.toMatchObject({ chunks: ['legacy-v2'] })
    await upgrader.mutate(sessionId, {
      mutationId: 'after-legacy',
      eventType: 'session.chunk_appended',
      apply(current) {
        if (!current) throw new Error('missing legacy document')
        return { ...current, state: { cursor: 3 }, chunks: [...current.chunks as string[], 'delta'] }
      },
    })
    await upgrader.hotState.database.query(`DELETE FROM tenant_session_latest_projection
      WHERE tenant_id = $1 AND session_id = $2`, ['tenant-a', sessionId])

    const reader = makeAuthority('legacy-row-reader')
    await reader.initialize()
    await expect(reader.load(sessionId)).resolves.toMatchObject({
      state: { cursor: 3 }, chunks: ['legacy-v2', 'delta'],
    })
    const payloads = await reader.hotState.database.query<{ schema_version: string | null; has_document: boolean }>(`SELECT
        payload->>'schemaVersion' AS schema_version, payload ? 'document' AS has_document
      FROM tenant_runtime_hot_events
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
      ORDER BY sequence`, ['tenant-a', sessionId])
    expect(payloads.rows).toEqual([
      { schema_version: null, has_document: true },
      { schema_version: '2', has_document: true },
      { schema_version: '3', has_document: false },
    ])
  })

  it('fences concurrent stale transitions from independent SessionStore instances', async () => {
    const writer = makeStore('concurrency-writer')
    const created = await writer.store.create({ sessionId: 'concurrent-session', config })
    const contender = makeStore('concurrency-contender')
    const stale = await contender.store.load(created.sessionId, { recoverDangling: false })
    const firstEvent = { kind: 'user_message', text: 'winner' } as const
    const secondEvent = { kind: 'user_message', text: 'loser' } as const
    const first = step(created.state, firstEvent, created.config)
    const second = step(stale.state, secondEvent, stale.config)

    const results = await Promise.allSettled([
      writer.store.record(created.sessionId, firstEvent, first.effects, first.next),
      contender.store.record(stale.sessionId, secondEvent, second.effects, second.next),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const verifier = makeStore('concurrency-verifier')
    const recovered = await verifier.store.load(created.sessionId, { recoverDangling: false })
    expect(recovered.state.cursor).toBe(1)
    const userTexts = recovered.state.messages.flatMap((message) => message.content)
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
    expect(userTexts.filter((text) => text === 'winner' || text === 'loser')).toHaveLength(1)
  })

  it('serializes queue metadata with a kernel event in one authority instance', async () => {
    const fixture = makeStore('same-authority-concurrency')
    const record = await fixture.store.create({ sessionId: 'metadata-record-concurrency', config })
    const event = { kind: 'user_message', text: 'concurrent kernel event' } as const
    const transition = step(record.state, event, record.config)

    await Promise.all([
      fixture.store.record(record.sessionId, event, transition.effects, transition.next),
      persistMessageQueueSnapshot(fixture.store, record.sessionId, [{
        id: 'concurrent-queue-1',
        operationId: 'concurrent-operation-1',
        text: 'queued concurrently',
        mode: 'queue',
        createdAt: '2026-10-18T20:00:00.000Z',
      }]),
    ])

    const verifier = makeStore('same-authority-verifier')
    const recovered = await verifier.store.load(record.sessionId, { recoverDangling: false })
    expect(recovered.state).toEqual(transition.next)
    await expect(loadPersistedMessageQueueState(verifier.store, record.sessionId)).resolves.toEqual({
      items: [expect.objectContaining({ id: 'concurrent-queue-1' })],
      cancelledOperationIds: [],
    })
  })

  it('merges different preference patches from independent SessionStore instances', async () => {
    const creator = makeStore('preferences-creator')
    const record = await creator.store.create({ sessionId: 'concurrent-preferences', config })
    const first = makeStore('preferences-first')
    const second = makeStore('preferences-second')
    await Promise.all([
      first.store.load(record.sessionId, { recoverDangling: false }),
      second.store.load(record.sessionId, { recoverDangling: false }),
    ])

    await Promise.all([
      first.store.updatePreferences(record.sessionId, { selectedModel: 'model-from-first' }),
      second.store.updatePreferences(record.sessionId, { toolCardMode: 'standard' }),
    ])

    const verifier = makeStore('preferences-verifier')
    const recovered = await verifier.store.load(record.sessionId, { recoverDangling: false })
    expect(recovered.preferences).toEqual({ selectedModel: 'model-from-first', toolCardMode: 'standard' })
  })

  it('keeps an expired old writer fenced after a newer generation commits', async () => {
    const fixture = makeAuthority('fencing')
    await fixture.initialize()
    const scope = { tenantId: 'tenant-a', scopeType: 'session' as const, scopeId: 'old-writer-fencing' }
    const old = await fixture.hotState.acquireLease(scope, 'old-writer', 40)
    await new Promise((resolve) => setTimeout(resolve, 70))
    const current = await fixture.hotState.acquireLease(scope, 'new-writer', 2_000)
    await fixture.hotState.appendEvent(current, {
      idempotencyKey: 'new-writer-event', eventType: 'test.new_writer', payload: { winner: 'new' },
    })

    await expect(fixture.hotState.appendEvent(old, {
      idempotencyKey: 'old-writer-event', eventType: 'test.old_writer', payload: { winner: 'old' },
    })).rejects.toBeInstanceOf(LeaseFencedError)
    const events = await fixture.hotState.replay(scope)
    expect(events.map((entry) => entry.idempotencyKey)).toEqual(['new-writer-event'])
  })

  it('persists operation lookup, timing history, and an atomic queue snapshot across stores', async () => {
    const writer = makeStore('interfaces-writer')
    const record = await writer.store.create({ sessionId: 'interfaces-session', config })
    const event = { kind: 'user_message', text: 'queued request', operationId: 'operation-event-1' } as const
    const transition = step(record.state, event, record.config)
    const timing = { turnId: 'turn-pg-1', turnStartedAt: '2026-10-18T19:00:00.000Z' }
    await writer.store.record(record.sessionId, event, transition.effects, transition.next, undefined, undefined, undefined, timing)
    await persistMessageQueueSnapshot(writer.store, record.sessionId, [{
      id: 'queue-1',
      operationId: 'operation-queue-1',
      text: 'later',
      mode: 'queue',
      createdAt: '2026-10-18T19:01:00.000Z',
    }], ['operation-cancelled-1'])
    await writer.store.appendRuntimeMetadata(record.sessionId, {
      action: 'request.received',
      payload: { operationId: 'operation-runtime-1', text: 'accepted', requestFingerprint: 'fingerprint-1' },
    }, { durable: true })

    const reader = makeStore('interfaces-reader')
    await expect(reader.store.findOperation(record.sessionId, 'operation-event-1')).resolves.toMatchObject({
      kind: 'event', cursor: 1, event: { operationId: 'operation-event-1' },
    })
    await expect(reader.store.findOperation(record.sessionId, 'operation-runtime-1')).resolves.toEqual({
      kind: 'runtime_metadata', action: 'request.received', text: 'accepted', requestFingerprint: 'fingerprint-1',
    })
    await expect(reader.store.readEventEntries(record.sessionId)).resolves.toEqual([
      expect.objectContaining({ seq: 1, timing }),
    ])
    await expect(reader.store.readHistory(record.sessionId)).resolves.toEqual({
      initialState: expect.objectContaining({ sessionId: record.sessionId, cursor: 0 }),
      config,
      events: [expect.objectContaining({ seq: 1, timing })],
      runtimeMetadata: [
        expect.objectContaining({ action: 'message_queue_snapshot' }),
        expect.objectContaining({ action: 'request.received' }),
      ],
    })
    await expect(loadPersistedMessageQueueState(reader.store, record.sessionId)).resolves.toEqual({
      items: [expect.objectContaining({ id: 'queue-1', operationId: 'operation-queue-1' })],
      cancelledOperationIds: ['operation-cancelled-1'],
    })

    const projection = await reader.authority.hotState.database.query<{ version: string; cursor: string }>(`SELECT version, document #>> '{state,cursor}' AS cursor
      FROM tenant_session_latest_projection WHERE tenant_id = $1 AND session_id = $2`, ['tenant-a', record.sessionId])
    expect(projection.rows).toEqual([{ version: '4', cursor: '1' }])
    expect(existsSync(reader.root)).toBe(false)
  })

  it('forks from the durable event prefix instead of the latest projection and rejects conflicting children', async () => {
    const writer = makeStore('fork-writer')
    const parent = await writer.store.create({
      sessionId: 'fork-parent',
      config,
      organizationId: 'org-a',
      principal: 'principal-a',
      organizationRole: 'member',
      workspaceId: 'workspace-a',
    })
    const firstEvent = { kind: 'user_message', text: 'first' } as const
    const first = step(parent.state, firstEvent, parent.config)
    await writer.store.record(parent.sessionId, firstEvent, first.effects, first.next)
    const secondEvent = {
      kind: 'llm_response',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    } as const
    const second = step(first.next, secondEvent, parent.config)
    await writer.store.record(parent.sessionId, secondEvent, second.effects, second.next)

    const child = await writer.store.fork({
      sourceSessionId: parent.sessionId,
      cursor: 1,
      sessionId: 'fork-child',
      preferences: { selectedModel: 'fork-model' },
    })
    expect(child.state).toEqual({ ...first.next, sessionId: child.sessionId })
    expect(child.state).not.toEqual({ ...second.next, sessionId: child.sessionId })
    expect(child).toMatchObject({
      parentSessionId: parent.sessionId,
      parentCursor: 1,
      organizationId: 'org-a',
      principal: 'principal-a',
      organizationRole: 'member',
      workspaceId: 'workspace-a',
      preferences: { selectedModel: 'fork-model' },
    })
    expect((await writer.store.load(parent.sessionId)).state).toEqual(second.next)

    await expect(writer.store.fork({
      sourceSessionId: parent.sessionId,
      cursor: 3,
      sessionId: 'invalid-fork-child',
    })).rejects.toThrow('Invalid fork cursor 3')
    await expect(writer.authority.load('invalid-fork-child')).resolves.toBeUndefined()

    const firstContender = makeStore('fork-contender-a')
    const secondContender = makeStore('fork-contender-b')
    const conflicts = await Promise.allSettled([
      firstContender.store.fork({ sourceSessionId: parent.sessionId, cursor: 1, sessionId: 'fork-conflict-child' }),
      secondContender.store.fork({ sourceSessionId: parent.sessionId, cursor: 2, sessionId: 'fork-conflict-child' }),
    ])
    expect(conflicts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(conflicts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const conflictEvents = await writer.authority.hotState.replay({
      tenantId: 'tenant-a', scopeType: 'session', scopeId: 'fork-conflict-child',
    })
    expect(conflictEvents.map((event) => event.eventType)).toEqual(['session.created'])
  })

  it('tombstones before cleanup and resumes a failed deletion after restart', async () => {
    let cleanupAttempts = 0
    const fixture = makeStore('delete-failure-writer', async () => {
      cleanupAttempts += 1
      if (cleanupAttempts === 1) throw new Error('injected object cleanup failure')
    })
    await fixture.store.create({ sessionId: 'recoverable-delete-session', config, organizationId: 'org-a' })

    await expect(fixture.store.delete('recoverable-delete-session')).rejects.toThrow('injected object cleanup failure')
    await expect(fixture.authority.load('recoverable-delete-session')).resolves.toBeUndefined()
    await expect(fixture.authority.list()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'recoverable-delete-session' }),
    ]))
    await expect(fixture.authority.listDeleting()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'recoverable-delete-session' }),
    ]))
    await expect(fixture.authority.mutate('recoverable-delete-session', {
      mutationId: 'late-write-after-delete-request',
      eventType: 'session.late_write',
      apply: (current) => current,
    })).rejects.toBeInstanceOf(SessionDeletingError)
    await expect(fixture.authority.messageQueue.enqueue('recoverable-delete-session', {
      id: 'late-queue', operationId: 'late-operation', text: 'must not be accepted',
      mode: 'queue', createdAt: new Date().toISOString(),
    }, 'back')).rejects.toBeInstanceOf(SessionDeletingError)
    await expect(fixture.authority.messageQueue.stop('recoverable-delete-session')).resolves.toBeDefined()
    await expect(fixture.store.finishRequestedDeletion('recoverable-delete-session', 'org-other')).resolves.toBe(false)

    const restarted = makeStore('delete-failure-recovery', async () => { cleanupAttempts += 1 })
    await restarted.store.initialize()
    await expect(restarted.store.listSessionIds()).resolves.not.toContain('recoverable-delete-session')
    await expect(restarted.authority.listDeleting()).resolves.toEqual([])
    expect(cleanupAttempts).toBe(2)
  })

  it('deduplicates a retried authority mutation and makes deletion authoritative', async () => {
    const fixture = makeStore('idempotency-writer')
    await fixture.store.create({ sessionId: 'idempotent-session', config })
    let applications = 0
    const mutation = {
      mutationId: 'rename-request-1',
      eventType: 'session.renamed',
      apply(current: Awaited<ReturnType<typeof fixture.authority.load>>) {
        applications += 1
        return current ? { ...current, label: 'once' } : undefined
      },
    }
    await fixture.authority.mutate('idempotent-session', mutation)
    await fixture.authority.mutate('idempotent-session', mutation)
    expect(applications).toBe(2)
    expect((await fixture.authority.load('idempotent-session'))?.label).toBe('once')
    const events = await fixture.authority.hotState.replay({
      tenantId: 'tenant-a', scopeType: 'session', scopeId: 'idempotent-session',
    })
    expect(events).toHaveLength(2)

    await fixture.store.delete('idempotent-session')
    await fixture.store.delete('idempotent-session')
    await expect(fixture.store.create({ sessionId: 'idempotent-session', config })).rejects.toBeInstanceOf(SessionDeletingError)
    await expect(fixture.authority.mutate('idempotent-session', {
      mutationId: 'late-recreate', eventType: 'session.recreated',
      apply: () => { throw new Error('deleted Session must not be recreated') },
    })).rejects.toBeInstanceOf(SessionDeletingError)
    expect(await fixture.store.listSessionIds()).not.toContain('idempotent-session')
    const reader = makeStore('delete-reader')
    await expect(reader.store.load('idempotent-session', { recoverDangling: false })).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(existsSync(fixture.root)).toBe(false)
  })
})

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}
