import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createConfig, step } from '@agent-kernel/kernel'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { loadPersistedMessageQueueState, persistMessageQueueSnapshot } from '../message-queue-store.js'
import { createPostgresHotStateStore, LeaseFencedError, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { PostgresSessionAuthority, SessionDeletingError } from './postgres-session-authority.js'
import { SessionNotFoundError, SessionStore } from './session.js'
import { NATIVE_POSIX_BLOCK_BYTES } from './native-posix-fs.js'
import { authorizeExecutorShellCall } from '../connection/executor-ns.js'
import { PostgresObjectCapacityLedger } from '../artifacts/postgres-object-capacity.js'
import { PostgresStorageInventory } from './postgres-storage-inventory.js'
import { migratePostgres } from '../postgres-migrations.js'

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
    await eventually(async () => await migratePostgres({ connectionString }), 30_000)
    const probe = makeAuthority('probe')
    await probe.initialize()
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(hotStores.map(async (store) => await store.close()))
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function makeAuthority(owner: string, tenantId = 'tenant-a'): PostgresSessionAuthority {
    const hot = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${owner}` })
    hotStores.push(hot)
    return new PostgresSessionAuthority(hot, tenantId, { ownerId: owner, leaseTtlMs: 2_000, leaseWaitMs: 5_000 })
  }

  function makeStore(owner: string, deleteRegisteredArtifacts?: (sessionId: string) => Promise<void>): { store: SessionStore; root: string; authority: PostgresSessionAuthority } {
    const parent = mkdtempSync(join(tmpdir(), 'kala-pg-session-'))
    const root = join(parent, 'sessions-not-created')
    roots.push(parent)
    const authority = makeAuthority(owner)
    return { store: new SessionStore(root, { authority, deleteRegisteredArtifacts }), root, authority }
  }

  it('measures persisted session, native file, and committed object bytes within the tenant', async () => {
    const tenantId = `storage-${randomUUID()}`
    const authority = makeAuthority('storage-measure', tenantId)
    await authority.initialize()
    await authority.create({ sessionId: 'storage-parent', state: { cursor: 0 } })
    await authority.create({ sessionId: 'storage-child', parentSessionId: 'storage-parent', state: { cursor: 0 } })
    const ledger = new PostgresObjectCapacityLedger(tenantId, 1024, authority.hotState)
    await ledger.initialize()
    const committed = await ledger.reserve({
      sessionId: 'storage-child', objectKey: 'storage-committed', kind: 'session_artifact', bytes: 42,
    })
    const reserved = await ledger.reserve({
      sessionId: 'storage-parent', objectKey: 'storage-reserved', kind: 'message_attachment', bytes: 99,
    })
    await authority.hotState.database.transaction(async (transaction) => {
      await ledger.applyMutation(transaction, { kind: 'commit', reservation: committed })
    })
    const inventory = new PostgresStorageInventory(authority)
    await inventory.reconcile()
    expect(inventory.getCachedTree('storage-parent')?.treeCategories['session-artifacts']).toEqual({ bytes: 42, files: 1 })
    expect(inventory.getCachedTree('storage-parent')?.descendantCount).toBe(1)
    expect(inventory.getCachedGlobal().categories.snapshot.bytes).toBeGreaterThan(0)
    expect(inventory.getCachedGlobal().categories.jsonl.bytes).toBeGreaterThan(0)
    expect(inventory.getCachedGlobal().categories['session-artifacts'].bytes).toBe(42)
    expect(inventory.getCachedGlobal().state.source).toBe('postgres')
    await ledger.release(reserved)
    const other = makeAuthority('storage-other-tenant', `other-${randomUUID()}`)
    await other.initialize()
    await other.create({ sessionId: 'other-tenant-session', state: { cursor: 0 } })
    await inventory.reconcile()
    expect(inventory.getCachedTree('other-tenant-session')).toBeUndefined()
  })

  it('replays a completion whose timestamp precedes a later child that committed first', async () => {
    const first = makeAuthority('late-completion-a', 'completion-race')
    const second = makeAuthority('late-completion-b', 'completion-race')
    await first.initialize()
    await second.initialize()
    await first.create({ sessionId: 'race-parent', state: { cursor: 0 } })
    for (const id of ['race-child-a', 'race-child-b']) {
      await first.create({
        sessionId: id, parentSessionId: 'race-parent', parentCallId: `call-${id}`,
        state: { cursor: 0 },
      })
    }
    let prepared!: () => void
    let commit!: () => void
    const aPrepared = new Promise<void>((resolve) => { prepared = resolve })
    const allowACommit = new Promise<void>((resolve) => { commit = resolve })
    const insert = async (transaction: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> },
      child: string, completedAt: Date): Promise<void> => {
      await transaction.query(`SELECT 1 FROM tenant_session_latest_projection
        WHERE tenant_id='completion-race' AND session_id='race-parent' FOR UPDATE`)
      await transaction.query(`INSERT INTO tenant_session_child_commands
        (tenant_id,parent_session_id,child_session_id,command_id,ordinal,kind,message,status,outcome,completed_at,completion_sequence)
        SELECT 'completion-race','race-parent',$1,'call-'||$1,1,'message','prompt','completed',
          '{"ok":true,"content":"done"}'::jsonb,$2,
          COALESCE(MAX(completion_sequence),0)+1
        FROM tenant_session_child_commands WHERE tenant_id='completion-race' AND parent_session_id='race-parent'`,
      [child, completedAt])
    }
    const transactionA = first.hotState.database.transaction(async (transaction) => {
      const { rows } = await transaction.query<{ completed_at: Date }>(
        'SELECT date_trunc(\'milliseconds\',clock_timestamp()) AS completed_at')
      prepared()
      await allowACommit
      await insert(transaction, 'race-child-a', rows[0]!.completed_at)
    })
    try {
      await aPrepared
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      await second.hotState.database.transaction(async (transaction) => {
        await insert(transaction, 'race-child-b', new Date())
      })
      const firstPage = await second.childCommandInbox.readFinishedChildCompletions('race-parent')
      expect(firstPage.map(({ childSessionId, sequence }) => [childSessionId, sequence]))
        .toEqual([['race-child-b', '1']])
      commit()
      await transactionA
      const latePage = await second.childCommandInbox.readFinishedChildCompletions('race-parent', {
        sequence: firstPage[0]!.sequence,
      })
      expect(latePage.map(({ childSessionId, sequence }) => [childSessionId, sequence]))
        .toEqual([['race-child-a', '2']])
      expect(Date.parse(latePage[0]!.completedAt)).toBeLessThan(Date.parse(firstPage[0]!.completedAt))
      await second.hotState.database.query(`INSERT INTO tenant_session_latest_projection
        (tenant_id,session_id,version,document)
        SELECT 'completion-race','long-child-'||n,1,
          jsonb_build_object('parentSessionId','race-parent','parentCallId','call-long-child-'||n)
        FROM generate_series(3,1100) AS n`)
      await second.hotState.database.query(`INSERT INTO tenant_session_child_commands
        (tenant_id,parent_session_id,child_session_id,command_id,ordinal,kind,message,status,outcome,completed_at,completion_sequence)
        SELECT 'completion-race','race-parent','long-child-'||n,'call-long-child-'||n,1,
          'message','prompt','completed','{"ok":true,"content":"done"}'::jsonb,clock_timestamp(),n
        FROM generate_series(3,1100) AS n`)
      let cursor: { sequence: string } | undefined
      const seen = new Set<string>()
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await second.childCommandInbox.readFinishedChildCompletions('race-parent', cursor, 64)
        if (!page.length) break
        for (const notice of page) {
          expect(seen.has(notice.childSessionId)).toBe(false)
          seen.add(notice.childSessionId)
        }
        cursor = { sequence: page.at(-1)!.sequence }
      }
      expect(seen.size).toBe(1_100)
      expect(await second.childCommandInbox.readFinishedChildCompletions('race-parent', cursor, 64)).toEqual([])
    } finally {
      commit()
      await transactionA
    }
  })

  it('serializes competing board claims and topic CAS across PostgreSQL clients and survives restart', async () => {
    const first = makeAuthority('board-first', 'board-tree')
    const second = makeAuthority('board-second', 'board-tree')
    await first.initialize()
    await second.initialize()
    await first.create({ sessionId: 'board-parent', state: { cursor: 0 } })
    for (const id of ['board-child-a', 'board-child-b']) {
      await first.create({ sessionId: id, parentSessionId: 'board-parent', state: { cursor: 0 } })
    }
    const claim = (authority: PostgresSessionAuthority, id: string) =>
      authority.agentBoardTransaction(id, (_root, board) => {
        if (board.fileClaims['src/owned.ts']) return false
        board.fileClaims['src/owned.ts'] = { path: 'src/owned.ts', holderSessionId: id, claimedAt: new Date().toISOString() }
        board.revision += 1
        return true
      })
    const [claimedA, claimedB] = await Promise.all([
      claim(first, 'board-child-a'), claim(second, 'board-child-b'),
    ])
    expect([claimedA, claimedB].sort()).toEqual([false, true])
    const post = (authority: PostgresSessionAuthority, id: string) =>
      authority.agentBoardTransaction(id, (_root, board) => {
        if (board.entries.contract) return false
        board.entries.contract = { topic: 'contract', content: id, tags: [], authorSessionId: id,
          revision: 1, updatedAt: new Date().toISOString() }
        board.revision += 1
        return true
      })
    expect((await Promise.all([post(first, 'board-child-a'), post(second, 'board-child-b')])).sort())
      .toEqual([false, true])
    const restarted = makeAuthority('board-restart', 'board-tree')
    const result = await restarted.agentBoardTransaction('board-parent', (_root, board) => ({
      claims: Object.values(board.fileClaims), topics: Object.values(board.entries),
    }))
    expect(result.claims).toHaveLength(1)
    expect(result.topics).toHaveLength(1)
    await first.requestDeletion('board-parent')
    await expect(second.agentBoardTransaction('board-child-b', () => undefined))
      .rejects.toBeInstanceOf(SessionDeletingError)
  })

  it('batches summary projections, scopes selected IDs, and repairs only missing projections', async () => {
    const authority = makeAuthority('batch-reader', 'batch-reader-tenant')
    const other = makeAuthority('batch-other', 'batch-other-tenant')
    await authority.initialize()
    for (const sessionId of ['batch-a', 'batch-b', 'batch-deleted', 'batch-deleting']) {
      await authority.create({ sessionId, state: { cursor: 0 } })
    }
    await other.create({ sessionId: 'batch-foreign', state: { cursor: 0 } })
    await authority.requestDeletion('batch-deleted')
    await authority.delete('batch-deleted')
    await authority.requestDeletion('batch-deleting')
    const reads = vi.spyOn(authority.hotState.database, 'query')
    try {
      expect((await authority.list()).map(({ sessionId }) => sessionId)).toEqual(['batch-a', 'batch-b'])
      expect(reads).toHaveBeenCalledTimes(1)
      reads.mockClear()
      expect((await authority.list(['batch-b', 'batch-foreign', 'batch-missing', 'batch-b']))
        .map(({ sessionId }) => sessionId)).toEqual(['batch-b'])
      expect(reads).toHaveBeenCalledTimes(1)
      reads.mockClear()
      await expect(authority.list([])).resolves.toEqual([])
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
    await authority.hotState.database.query(`DELETE FROM tenant_session_latest_projection
      WHERE tenant_id = $1 AND session_id = $2`, ['batch-reader-tenant', 'batch-a'])
    expect((await authority.list(['batch-a'])).map(({ sessionId }) => sessionId)).toEqual(['batch-a'])
    await expect(authority.load('batch-a')).resolves.toMatchObject({ state: { cursor: 0 } })
  })

  it('persists binary native ranges across clients without whole-file text encoding', async () => {
    const writer = makeAuthority('posix-ranges', 'posix-a')
    await writer.initialize()
    await writer.create({ sessionId: 'posix-ranges', state: { cursor: 0 } })
    await writer.initializeEmptyNativePosixSession('posix-ranges')
    const native = writer.nativePosixSessionFs('posix-ranges')
    await native.mkdir('/checkpoints', 0o700)
    await native.create('/checkpoints/events', 0o600)
    const original = Buffer.alloc(NATIVE_POSIX_BLOCK_BYTES * 2 + 5, 0x81)
    original[0] = 0; original[original.length - 1] = 0xff
    await native.write('/checkpoints/events', 0, original)
    await native.write('/checkpoints/events', NATIVE_POSIX_BLOCK_BYTES - 2, Buffer.from([0, 0xfe, 0xfd, 0]))
    original.set([0, 0xfe, 0xfd, 0], NATIVE_POSIX_BLOCK_BYTES - 2)
    await native.sync('/checkpoints/events')
    const reader = makeAuthority('posix-ranges-reader', 'posix-a').nativePosixSessionFs('posix-ranges')
    await expect(reader.read('/checkpoints/events', 0, original.length)).resolves.toEqual(original)
    await expect(reader.read('/checkpoints/events', original.length, 100)).resolves.toEqual(Buffer.alloc(0))
    await expect(reader.readdir('/checkpoints')).resolves.toEqual(['events'])
    await expect(reader.read('/checkpoints/events', -1, 1)).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(reader.read('/checkpoints/events', 0, 1024 * 1024 + 1)).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(reader.stat('/../events')).rejects.toMatchObject({ code: 'EINVAL' })
    const other = new PostgresSessionAuthority(writer.hotState, 'tenant-b')
    await other.create({ sessionId: 'posix-ranges', state: { cursor: 0 } })
    await other.initializeEmptyNativePosixSession('posix-ranges')
    await expect(other.nativePosixSessionFs('posix-ranges').stat('/checkpoints')).rejects.toMatchObject({ code: 'ENOENT' })
    await writer.requestDeletion('posix-ranges')
    await expect(reader.read('/checkpoints/events', 0, 1)).rejects.toBeInstanceOf(SessionDeletingError)
    await writer.delete('posix-ranges')
    const { rows } = await writer.hotState.database.query(`SELECT count(*)::int AS count
      FROM tenant_session_native_posix_blocks WHERE tenant_id='posix-a' AND session_id='posix-ranges'`)
    expect(rows).toEqual([{ count: 0 }])
  })

  it('zeroes native gaps and truncated tails and atomically renames binary subtrees', async () => {
    const authority = makeAuthority('posix-truncate', 'posix-a')
    await authority.initialize()
    await authority.create({ sessionId: 'posix-truncate', state: { cursor: 0 } })
    await authority.initializeEmptyNativePosixSession('posix-truncate')
    const native = authority.nativePosixSessionFs('posix-truncate')
    await native.mkdir('/one', 0o700)
    await native.create('/one/cache.db', 0o600)
    await native.write('/one/cache.db', NATIVE_POSIX_BLOCK_BYTES + 2, Buffer.from([255]))
    const initial = await native.read('/one/cache.db', 0, NATIVE_POSIX_BLOCK_BYTES + 3)
    expect(initial.subarray(0, -1)).toEqual(Buffer.alloc(initial.length - 1))
    expect(initial.at(-1)).toBe(255)
    await native.truncate('/one/cache.db', NATIVE_POSIX_BLOCK_BYTES + 1)
    await native.truncate('/one/cache.db', NATIVE_POSIX_BLOCK_BYTES + 4)
    await expect(native.read('/one/cache.db', NATIVE_POSIX_BLOCK_BYTES, 4)).resolves.toEqual(Buffer.alloc(4))
    await native.rename('/one', '/two')
    await expect(native.stat('/one/cache.db')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(native.stat('/two/cache.db')).resolves.toMatchObject({ bytes: NATIVE_POSIX_BLOCK_BYTES + 4 })
    await expect(native.remove('/two', true)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await native.create('/replacement', 0o600)
    await native.write('/replacement', 0, Buffer.from('old'))
    await native.rename('/two/cache.db', '/replacement')
    await expect(native.read('/replacement', NATIVE_POSIX_BLOCK_BYTES, 4)).resolves.toEqual(Buffer.alloc(4))
    await native.remove('/two', true)
    await native.truncate('/replacement', 0)
    await expect(native.read('/replacement', 0, 10)).resolves.toEqual(Buffer.alloc(0))
    const { rows } = await authority.hotState.database.query(`SELECT total_bytes,total_nodes
      FROM tenant_session_native_posix_usage WHERE tenant_id='posix-a' AND session_id='posix-truncate'`)
    expect(rows).toEqual([{ total_bytes: '0', total_nodes: '1' }])
  })

  it('rolls native quotas back without losing committed bytes and detects block corruption', async () => {
    const hot = createPostgresHotStateStore({ connectionString })
    hotStores.push(hot)
    const authority = new PostgresSessionAuthority(hot, 'posix-a', { nativeFsLimits: { maxSessionBytes: 4 } })
    await authority.initialize()
    await authority.create({ sessionId: 'posix-quota', state: { cursor: 0 } })
    await authority.initializeEmptyNativePosixSession('posix-quota')
    const native = authority.nativePosixSessionFs('posix-quota')
    await native.create('/cache.db', 0o600)
    await native.write('/cache.db', 0, Buffer.from([0, 1, 0xff, 3]))
    await expect(native.write('/cache.db', 3, Buffer.from([1, 2]))).rejects.toMatchObject({ code: 'ENOSPC' })
    await expect(native.read('/cache.db', 0, 8)).resolves.toEqual(Buffer.from([0, 1, 0xff, 3]))
    await hot.database.query(`UPDATE tenant_session_native_posix_blocks SET sha256=repeat('0',64)
      WHERE tenant_id='posix-a' AND session_id='posix-quota' AND path='/cache.db'`)
    await expect(native.read('/cache.db', 0, 1)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('freezes text writes during a recoverable native import and admits exactly one verified binary authority', async () => {
    const authority = makeAuthority('posix-admission', 'posix-admission')
    await authority.initialize()
    const sessionId = 'imported'
    await authority.create({ sessionId, state: { cursor: 42, messages: [{ role: 'user' }] } })
    const text = authority.nativeSessionFs(sessionId)
    await text.writeFile('/session-state/events.jsonl', 'legacy text recovery\n')
    const native = authority.nativePosixSessionFs(sessionId)
    await expect(native.create('/events.jsonl', 0o600)).rejects.toThrow('blocked by text')
    await expect(authority.initializeEmptyNativePosixSession(sessionId)).rejects.toThrow('explicit native filesystem import')
    await authority.beginNativePosixImport(sessionId, 'import-one')
    await authority.beginNativePosixImport(sessionId, 'import-one')
    await expect(authority.beginNativePosixImport(sessionId, 'import-two')).rejects.toThrow('conflicts')
    await expect(text.appendFile('/session-state/events.jsonl', 'late')).rejects.toThrow('blocked by posix-import')
    await expect(native.stat('/')).rejects.toThrow('blocked by posix-import')
    await expect(authority.nativePosixSessionFs(sessionId, { importId: 'import-two' }).stat('/')).rejects.toThrow('blocked')
    const importer = authority.nativePosixSessionFs(sessionId, { importId: 'import-one' })
    await expect(authority.completeNativePosixImport(sessionId, 'import-one', 'a'.repeat(64))).rejects.toThrow('events.jsonl')
    await importer.create('/events.jsonl', 0o600)
    const bytes = Buffer.from([0, 255, 1, 128])
    await importer.write('/events.jsonl', 0, bytes)
    await expect(importer.read('/events.jsonl', 0, bytes.length)).resolves.toEqual(bytes)
    await authority.completeNativePosixImport(sessionId, 'import-one', 'a'.repeat(64))
    await authority.completeNativePosixImport(sessionId, 'import-one', 'a'.repeat(64))
    await expect(authority.completeNativePosixImport(sessionId, 'import-one', 'b'.repeat(64))).rejects.toThrow('blocked')
    await expect(importer.write('/events.jsonl', 0, Buffer.from('stale importer'))).rejects.toThrow('blocked by posix')
    await expect(native.read('/events.jsonl', 0, bytes.length)).resolves.toEqual(bytes)
    await expect(text.readFile('/session-state/events.jsonl')).rejects.toThrow('blocked by posix')
    const recovery = await authority.hotState.database.query(`SELECT content FROM tenant_session_native_fs_chunks
      WHERE tenant_id=$1 AND session_id=$2`, ['posix-admission', sessionId])
    expect(recovery.rows.map(row => row.content).join('')).toBe('legacy text recovery\n')
    await authority.requestDeletion(sessionId)
    await authority.delete(sessionId)
    const admission = await authority.hotState.database.query(`SELECT 1 FROM tenant_session_native_fs_admission
      WHERE tenant_id=$1 AND session_id=$2`, ['posix-admission', sessionId])
    expect(admission.rows).toEqual([])
  })

  it('admits an empty Copilot conversation after approval mode changes, but not after other events', async () => {
    const authority = makeAuthority('posix-approval', 'posix-approval')
    await authority.initialize()
    const root = mkdtempSync(join(tmpdir(), 'kala-posix-approval-'))
    roots.push(root)
    const store = new SessionStore(root, { authority })
    const sessionId = 'approval-before-first-turn'
    const record = await store.create({ sessionId, agentRuntime: 'copilot', config })
    await store.recordRuntimeProjection(sessionId, {
      ...record.state, cursor: 1, approvalMode: 'ask',
    }, 'copilot.approval_mode_changed', { mode: 'ask' })
    await authority.initializeEmptyNativePosixSession(sessionId)
    await authority.initializeEmptyNativePosixSession(sessionId)
    const other = await store.create({ sessionId: 'other-before-first-turn', agentRuntime: 'copilot', config })
    await store.recordRuntimeProjection(other.sessionId, {
      ...other.state, cursor: 1,
    }, 'copilot.other_event', {})
    await expect(authority.initializeEmptyNativePosixSession(other.sessionId))
      .rejects.toThrow('explicit native filesystem import')
  })

  it('applies local cleanup leases and quarantine guards to binary native files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-posix-cleanup-'))
    roots.push(root)
    const authority = makeAuthority('posix-cleanup', 'posix-a')
    const store = new SessionStore(join(root, 'sessions'), { authority })
    const record = await store.create({ sessionId: 'posix-cleanup', agentRuntime: 'copilot', config })
    await authority.initializeEmptyNativePosixSession(record.sessionId)
    const native = store.copilotNativePosixSessionFs(record.sessionId)
    await native.create('/cache.db', 0o600)
    await native.write('/cache.db', 0, Buffer.from([0, 255]))
    await store.withStorageMutationLease([record.sessionId], async () => {
      await expect(native.write('/cache.db', 0, Buffer.from([1]))).rejects.toThrow('locked for storage cleanup')
    })
    await expect(native.read('/cache.db', 0, 2)).resolves.toEqual(Buffer.from([0, 255]))
    store.installStorageTombstones([record.sessionId])
    await expect(native.read('/cache.db', 0, 2)).rejects.toThrow('quarantined')
  })

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

  it('lists PostgreSQL summaries without transferring transcripts and still repairs missing projections', async () => {
    const tenantId = `summary-${randomUUID()}`
    const authority = makeAuthority('summary-reader', tenantId)
    const root = mkdtempSync(join(tmpdir(), 'kala-summary-reader-'))
    roots.push(root)
    const store = new SessionStore(root, { authority })
    const record = await store.create({
      sessionId: 'large-summary-session', agentRuntime: 'copilot', config,
      organizationId: 'summary-org', workspaceId: 'summary-workspace',
    })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state,
      cursor: 1,
      status: 'done',
      messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: `first message ${'x'.repeat(1024 * 1024)}` }] }],
    }, 'summary.large_message', {})
    await store.rename(record.sessionId, 'Summary label')
    await store.updatePreferences(record.sessionId, { toolCardMode: 'standard' })

    const [document] = await authority.listSummaryDocuments()
    expect(document).toMatchObject({
      sessionId: record.sessionId, state: { cursor: 1, status: 'done' },
      label: 'Summary label', workspaceId: 'summary-workspace',
    })
    expect(document).not.toHaveProperty('config')
    expect(document?.state).not.toHaveProperty('messages')
    expect(JSON.stringify(document).length).toBeLessThan(5_000)
    expect((await store.listSummaries({ organizationId: 'summary-org' }))[0]).toMatchObject({
      sessionId: record.sessionId, eventCount: 1, status: 'done',
      workspaceId: 'summary-workspace', label: 'Summary label',
      preferences: { toolCardMode: 'standard' },
    })
    expect(await store.listSummaries({ organizationId: undefined })).toEqual([])

    await authority.hotState.database.query(`DELETE FROM tenant_session_latest_projection
      WHERE tenant_id=$1 AND session_id=$2`, [tenantId, record.sessionId])
    expect((await store.listSummaries({ sessionIds: [record.sessionId] }))[0]?.eventCount).toBe(1)
    await authority.requestDeletion(record.sessionId)
    expect(await store.listSummaries({ sessionIds: [record.sessionId] })).toEqual([])
    await authority.delete(record.sessionId)
    expect(await store.listSummaries({ sessionIds: [record.sessionId] })).toEqual([])
  })

  it('replays explicit shell approval and command identity from PostgreSQL authority', async () => {
    const authority = makeAuthority('shell-approval-writer', 'shell-approval')
    const writer = new SessionStore(join(process.cwd(), '.kala-pg-shell-writer'), {
      authority,
    })
    const shellConfig = createConfig({
      systemPrompt: 'shell test',
      tools: [{
        name: 'bash',
        description: 'Shell',
        inputSchema: { type: 'object' },
        requiresApproval: false,
        executionKind: 'executor',
        executionHandler: 'bash',
      }],
    })
    const sessionId = `pg-shell-${randomUUID()}`
    const record = await writer.create({
      sessionId, config: shellConfig, workspaceId: 'pg-shell-workspace', initialApprovalMode: 'ask',
    })
    const events = [
      { kind: 'user_message' as const, text: 'test approval' },
      {
        kind: 'llm_response' as const,
        message: {
          role: 'assistant' as const,
          content: [{
            type: 'tool_call' as const,
            callId: 'shell-approved',
            name: 'bash',
            input: { command: 'git reset --hard HEAD' },
          }],
        },
      },
    ]
    for (const event of events) {
      const transition = step(record.state, event, shellConfig)
      await writer.record(sessionId, event, transition.effects, transition.next)
    }
    expect(record.state.pendingCalls[0]?.status).toBe('awaiting_approval')
    const approval = { kind: 'user_approve' as const, callId: 'shell-approved' }
    const next = step(record.state, approval, shellConfig)
    await writer.record(sessionId, approval, next.effects, next.next)
    await authority.hotState.database.query(
      'DELETE FROM tenant_session_latest_projection WHERE tenant_id=$1 AND session_id=$2',
      ['shell-approval', sessionId],
    )
    const reader = new SessionStore(join(process.cwd(), '.kala-pg-shell-reader'), {
      authority: makeAuthority('shell-approval-reader', 'shell-approval'),
    })
    const recovered = await reader.load(sessionId, { recoverDangling: false })
    expect(recovered.state.pendingCalls[0]).toMatchObject({
      callId: 'shell-approved', status: 'dispatched', explicitlyApproved: true,
    })
    expect(authorizeExecutorShellCall(recovered, 'pg-shell-workspace', {
      sessionId, callId: 'shell-approved', name: 'bash', command: 'git reset --hard HEAD',
    })).toBe(true)
    expect(authorizeExecutorShellCall(recovered, 'pg-shell-workspace', {
      sessionId, callId: 'shell-approved', name: 'bash', command: 'git reset --hard HEAD~1',
    })).toBe(false)
  })

  it('preserves NUL and lone surrogate tool text in projections, audit replay and extracted history', async () => {
    const authority = makeAuthority('binary-tool-text', 'binary-tool-text')
    await authority.initialize()
    const text = 'binary\0tool\ud800output\udfff🙂'
    const sessionId = 'binary-tool-text'
    await authority.create({ sessionId, state: { cursor: 0 }, config: { prompt: text } })
    const entry = { kind: 'runtime_metadata', sessionId, ts: new Date().toISOString(),
      action: 'copilot.user_message', payload: { text, operationId: 'binary-text-operation' } } as const
    await authority.mutate(sessionId, { mutationId: 'binary-text', eventType: 'session.runtime_projection',
      entry, apply: current => current && { ...current, output: text } })
    await expect(authority.load(sessionId)).resolves.toMatchObject({ output: text })
    await expect(authority.findOperation(sessionId, 'binary-text-operation')).resolves.toMatchObject({ text })
    await expect(authority.findLatestRuntimeMetadata(sessionId, entry.action)).resolves.toEqual(entry)
    expect((await authority.readHistory(sessionId)).runtimeMetadata).toEqual([entry])
    await authority.hotState.database.query(`DELETE FROM tenant_session_latest_projection
      WHERE tenant_id=$1 AND session_id=$2`, ['binary-tool-text', sessionId])
    await expect(authority.load(sessionId)).resolves.toMatchObject({ output: text, config: { prompt: text } })
    await expect(authority.mutate(sessionId, { mutationId: 'binary-text', eventType: 'session.runtime_projection',
      entry, apply: current => current && { ...current, output: text } })).resolves.toMatchObject({ output: text })
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

  it('rejects a transaction whose checked-out connection dies between queries without crashing the Runtime', async () => {
    const writer = makeAuthority('connection-gap-writer').hotState
    const killer = makeAuthority('connection-gap-killer').hotState
    await writer.database.query('CREATE TABLE connection_gap_probe (value integer NOT NULL)')
    await expect(writer.database.transaction(async (transaction) => {
      await transaction.query('INSERT INTO connection_gap_probe VALUES (1)')
      const { rows } = await transaction.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await killer.database.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid])
      await new Promise((resolve) => setTimeout(resolve, 50))
      await transaction.query('SELECT 1')
    })).rejects.toThrow()
    const { rows } = await writer.database.query<{ count: string }>('SELECT count(*)::text AS count FROM connection_gap_probe')
    expect(rows).toEqual([{ count: '0' }])
  })

  it('validates a tiny synthetic legacy mapping without modifying its JSONL source or dispatching effects', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'kala-synthetic-legacy-'))
    roots.push(sourceRoot)
    const source = new SessionStore(sourceRoot)
    const sessionId = 'synthetic-legacy-mapping'
    const record = await source.create({ sessionId, config, organizationId: 'org-a', workspaceId: 'workspace-a' })
    const { logPath, memoryPolicy: _memoryPolicy, ...initialDocument } = structuredClone(record)
    const events = [
      { kind: 'user_message', text: 'synthetic only', operationId: 'legacy-request-1' },
      {
        kind: 'llm_response',
        message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic response' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ] as const
    for (const event of events) {
      const transition = step(record.state, event, config)
      await source.record(sessionId, event, transition.effects, transition.next)
    }
    await persistMessageQueueSnapshot(source, sessionId, [{
      id: 'legacy-queue-1', operationId: 'legacy-queued-operation-1', text: 'not dispatched',
      mode: 'queue', createdAt: '2026-10-30T00:00:00.000Z',
    }], ['legacy-cancelled-operation-1'])
    const sourceBytes = readFileSync(logPath)
    const history = await source.readHistory(sessionId)
    const queue = await loadPersistedMessageQueueState(source, sessionId)
    const target = makeStore('synthetic-mapping-writer')
    const mapFixture = async (): Promise<void> => {
      await target.authority.create(initialDocument, 'synthetic-mapping:header')
      let state = history.initialState
      for (const entry of history.events) {
        const transition = step(state, entry.event, history.config)
        const next = transition.next
        await target.authority.mutate(sessionId, {
          mutationId: `synthetic-mapping:event:${entry.seq}`, eventType: 'session.imported_event', entry,
          apply(current) {
            if (!current) throw new Error('synthetic mapping lost its target header')
            return { ...current, state: next, lastEventAt: entry.ts }
          },
        })
        state = next
      }
      for (const [index, entry] of history.runtimeMetadata.entries()) {
        await target.authority.mutate(sessionId, {
          mutationId: `synthetic-mapping:metadata:${index}`, eventType: 'session.imported_metadata', entry,
          apply: (current) => current,
        })
      }
      await target.authority.messageQueue.loadOrInitialize(sessionId, async () => queue)
    }
    await mapFixture()
    await mapFixture()
    const reader = makeStore('synthetic-mapping-cold-reader')
    const restored = await reader.store.load(sessionId, { recoverDangling: false })
    expect(restored).toMatchObject({
      sessionId, createdAt: record.createdAt, organizationId: 'org-a', workspaceId: 'workspace-a',
      state: record.state, config: record.config, toolLock: record.toolLock,
    })
    expect(await reader.store.readHistory(sessionId)).toEqual(history)
    expect(await reader.store.findOperation(sessionId, 'legacy-request-1')).toMatchObject({ kind: 'event', cursor: 1 })
    expect(await reader.authority.messageQueue.load(sessionId)).toEqual(queue)
    expect(readFileSync(logPath)).toEqual(sourceBytes)
    expect(existsSync(reader.root)).toBe(false)
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

  it.each([undefined, '2026-10-01T00:00:00.000Z'])('synchronizes live Copilot turn timing with PostgreSQL when the previous start is %s', async (previousStart) => {
    const creator = makeStore(`copilot-timing-creator-${previousStart ?? 'new'}`)
    const sessionId = `copilot-timing-${previousStart ?? 'new'}`
    await creator.store.create({ sessionId, agentRuntime: 'copilot', config })
    if (previousStart) {
      await creator.authority.mutate(sessionId, {
        mutationId: 'fixture.previous-turn',
        eventType: 'fixture.previous-turn',
        apply: (current) => current && { ...current, turnStartedAt: previousStart },
      })
    }
    const writer = makeStore(`copilot-timing-writer-${previousStart ?? 'new'}`)
    const record = await writer.store.load(sessionId, { recoverDangling: false })
    expect(record.turnStartedAt).toBe(previousStart)
    const before = Date.now()
    await writer.store.recordRuntimeProjection(sessionId, {
      ...record.state,
      cursor: record.state.cursor + 1,
      status: 'thinking',
      messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'new turn' }] }],
    }, 'copilot.user_message', { text: 'new turn' })

    const persisted = await writer.authority.load(sessionId)
    expect(record.turnStartedAt).toBe(persisted?.turnStartedAt)
    expect(Date.parse(record.turnStartedAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(record.turnStartedAt!)).toBeLessThanOrEqual(Date.now())
    const startedAt = record.turnStartedAt
    await writer.store.recordRuntimeProjection(sessionId, {
      ...record.state, cursor: record.state.cursor + 1, status: 'done',
    }, 'copilot.turn_end', {})
    expect(record.turnStartedAt).toBe(startedAt)
    const reader = makeStore(`copilot-timing-reader-${previousStart ?? 'new'}`)
    const reloaded = await reader.store.load(sessionId, { recoverDangling: false })
    expect(reloaded.turnStartedAt).toBe(startedAt)
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
      delegationDepth: 0,
      organizationId: 'org-a',
      principal: 'principal-a',
      organizationRole: 'member',
      workspaceId: 'workspace-a',
      preferences: { selectedModel: 'fork-model' },
    })
    expect((await writer.store.load(parent.sessionId)).state).toEqual(second.next)

    const delegated = await writer.store.create({
      sessionId: 'fork-delegated-source', config, parentSessionId: parent.sessionId,
      parentCallId: 'fork-delegation-call', delegationDepth: 1,
    })
    const delegatedFork = await writer.store.fork({
      sourceSessionId: delegated.sessionId, cursor: 0, sessionId: 'fork-delegated-child',
    })
    const coldReader = makeStore('fork-depth-reader')
    expect(coldReader.store.get(parent.sessionId)).toBeUndefined()
    expect((await coldReader.store.load(child.sessionId, { recoverDangling: false })).delegationDepth).toBe(0)
    expect((await coldReader.store.load(delegatedFork.sessionId, { recoverDangling: false })).delegationDepth).toBe(1)
    expect(coldReader.store.get(delegated.sessionId)).toBeUndefined()

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
