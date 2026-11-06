import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createConfig, step } from '@agent-kernel/kernel'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionDeletingError } from './session-authority.js'
import { SessionStore } from './session.js'
import { SqliteSessionAuthority } from './sqlite-session-authority.js'

const config = createConfig({ tools: [], systemPrompt: 'portable' })

describe('SqliteSessionAuthority', () => {
  const roots: string[] = []
  const authorities: SqliteSessionAuthority[] = []

  afterEach(async () => {
    await Promise.all(authorities.splice(0).map(async (authority) => await authority.close()))
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function fixture(): { root: string; databasePath: string; sessionsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'kala-sqlite-session-'))
    roots.push(root)
    return {
      root,
      databasePath: join(root, 'state.sqlite'),
      sessionsDir: join(root, 'sessions-must-not-be-created'),
    }
  }

  function authority(databasePath: string): SqliteSessionAuthority {
    const value = new SqliteSessionAuthority(databasePath)
    authorities.push(value)
    return value
  }

  it('preserves authoritative root selections and MCP descriptors when refreshing runtime config after restart', async () => {
    const { databasePath, sessionsDir } = fixture()
    const shell = { name: 'shell', description: 'shell', inputSchema: { type: 'object' }, requiresApproval: false }
    const mcp = { ...shell, name: 'workspace__lookup', description: 'workspace MCP', executionKind: 'executor' as const, schemaHash: 'mcp' }
    const selected = createConfig({ tools: [mcp, shell], systemPrompt: 'selected prompt' })
    const runtimeConfig = createConfig({ tools: [{ ...shell, description: 'current shell' }, { ...shell, name: 'write_file' }], systemPrompt: 'default prompt', contextLimit: 99_999 })
    const firstAuthority = authority(databasePath)
    const first = new SessionStore(sessionsDir, { authority: firstAuthority })
    const record = await first.create({ sessionId: 'runtime-refresh-root', config: selected })
    await first.create({ sessionId: 'runtime-refresh-child', parentSessionId: record.sessionId, config: { ...selected, tools: [mcp] } })
    await first.load(record.sessionId, { runtimeConfig })
    expect(record.config.tools.map((tool) => tool.name)).toEqual(['workspace__lookup', 'shell'])
    await firstAuthority.close()
    const reader = new SessionStore(sessionsDir, { authority: authority(databasePath), runtimeConfig })
    const restored = await reader.load(record.sessionId)
    expect(restored.config.tools).toEqual([mcp, runtimeConfig.tools[0]])
    expect(restored.config.systemPrompt).toBe('selected prompt')
    expect(restored.config.contextLimit).toBe(99_999)
    expect((await reader.load('runtime-refresh-child')).config.tools).toEqual([mcp])
    expect(existsSync(sessionsDir)).toBe(false)
  })

  it('only adds explicitly confirmed tools to an idle root Session and persists their lock', async () => {
    const { databasePath, sessionsDir } = fixture()
    const current = authority(databasePath)
    const writer = new SessionStore(sessionsDir, { authority: current })
    const scheduled = { name: 'scheduled_task', description: 'Manage scheduled tasks', inputSchema: { type: 'object' }, requiresApproval: false }
    const other = { ...scheduled, name: 'other_new_tool' }
    const catalog = createConfig({ tools: [scheduled, other], systemPrompt: 'current defaults' })
    const root = await writer.create({ sessionId: 'old-root', config })
    const child = await writer.create({ sessionId: 'old-child', config, parentSessionId: root.sessionId })
    expect(root.config.tools).toEqual([])
    await expect(writer.upgradeSessionTools(child.sessionId, [scheduled.name], catalog)).rejects.toThrow('root')
    await expect(writer.upgradeSessionTools(root.sessionId, ['unknown'], catalog)).rejects.toThrow('available')
    await expect(writer.upgradeSessionTools(root.sessionId, [scheduled.name], catalog)).resolves.toEqual([scheduled.name])
    expect(root.config.tools.map((tool) => tool.name)).toEqual([scheduled.name])
    expect(root.toolLock).toHaveProperty(scheduled.name)
    await expect(writer.upgradeSessionTools(root.sessionId, [scheduled.name], catalog)).rejects.toThrow('already enabled')
    const reader = new SessionStore(sessionsDir, { authority: authority(databasePath), runtimeConfig: catalog })
    const restored = await reader.load(root.sessionId)
    expect(restored.config.tools.map((tool) => tool.name)).toEqual([scheduled.name])
    expect(restored.toolLock).toHaveProperty(scheduled.name)
    expect((await reader.load(child.sessionId)).config.tools).toEqual([])
  })

  it('restricts summary reads to selected authoritative projections', async () => {
    const { databasePath, sessionsDir } = fixture()
    const durable = authority(databasePath)
    const writer = new SessionStore(sessionsDir, { authority: durable })
    await writer.create({ sessionId: 'summary-a', config, organizationId: 'org-a' })
    await writer.create({ sessionId: 'summary-b', config })
    const reader = new SessionStore(sessionsDir, { authority: authority(databasePath) })
    expect((await reader.listSummaries({ sessionIds: ['summary-b', 'summary-missing', 'summary-b'] }))
      .map(({ sessionId }) => sessionId)).toEqual(['summary-b'])
    await expect(reader.listSummaries({ sessionIds: [] })).resolves.toEqual([])
    expect((await reader.listSummaries({ organizationId: 'org-a' })).map(({ sessionId }) => sessionId)).toEqual(['summary-a'])
    expect((await reader.listSummaries({ organizationId: undefined })).map(({ sessionId }) => sessionId)).toEqual(['summary-b'])
  })

  it('reloads a read-only projection before a new owner activation can write it', async () => {
    const { root, databasePath, sessionsDir } = fixture()
    const writer = new SessionStore(sessionsDir, { authority: authority(databasePath) })
    const record = await writer.create({ sessionId: 'owner-cache', agentRuntime: 'copilot', config })
    await writer.recordRuntimeProjection(record.sessionId, { ...record.state, cursor: 1, status: 'done' }, 'copilot.seed', {})
    let ownerKey: string | undefined
    const observerAuthority = Object.assign(authority(databasePath), { currentOwnerCacheKey: () => ownerKey })
    const observer = new SessionStore(join(root, 'observer'), { authority: observerAuthority })
    const snapshot = await observer.load(record.sessionId, { recoverDangling: false })
    expect(snapshot.state.cursor).toBe(1)
    expect(observer.get(record.sessionId)).toBeUndefined()
    await writer.recordRuntimeProjection(record.sessionId, {
      ...record.state, cursor: 2, status: 'done',
      messages: [...record.state.messages, { role: 'assistant', content: [{ type: 'text', text: 'latest durable reply' }] }],
    }, 'copilot.reply', {})
    ownerKey = 'new-owner-activation'
    const recovered = await observer.load(record.sessionId)
    expect(recovered.state.cursor).toBe(2)
    expect(JSON.stringify(recovered.state.messages)).toContain('latest durable reply')
    expect(observer.get(record.sessionId)).toBe(recovered)
    await observer.recordRuntimeProjection(record.sessionId, { ...recovered.state, cursor: 3 }, 'copilot.next', {})
    expect((await observerAuthority.load(record.sessionId))?.state.cursor).toBe(3)
    ownerKey = 'subsequent-owner-activation'
    expect(observer.get(record.sessionId)).toBeUndefined()
    expect((await observer.load(record.sessionId)).state.cursor).toBe(3)
  })

  it('persists authoritative state and ordered cursor history across restart without JSONL', async () => {
    const { databasePath, sessionsDir } = fixture()
    const firstAuthority = authority(databasePath)
    const first = new SessionStore(sessionsDir, { authority: firstAuthority })
    const record = await first.create({ sessionId: 'restart-session', config, organizationId: 'org-a' })

    for (const text of ['first', 'second']) {
      const event = { kind: 'user_message', text } as const
      const transition = step(record.state, event, record.config)
      await first.record(record.sessionId, event, transition.effects, transition.next)
    }
    await first.appendRuntimeMetadata(record.sessionId, { action: 'portable.checkpoint', payload: { value: 2 } })
    expect(existsSync(sessionsDir)).toBe(false)
    await firstAuthority.close()

    const secondAuthority = authority(databasePath)
    const second = new SessionStore(sessionsDir, { authority: secondAuthority })
    await second.initialize()
    const recovered = await second.load(record.sessionId)
    expect(recovered.state.cursor).toBe(2)
    expect((await second.readEventEntries(record.sessionId)).map((entry) => [entry.seq, entry.event.kind])).toEqual([
      [1, 'user_message'],
      [2, 'user_message'],
    ])
    await expect(second.readHistory(record.sessionId)).resolves.toMatchObject({
      events: [{ seq: 1 }, { seq: 2 }],
      runtimeMetadata: [{ action: 'portable.checkpoint', payload: { value: 2 } }],
    })
    expect(existsSync(sessionsDir)).toBe(false)

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    database.close()
  })

  it('recovers a dispatched external tool as execution-unknown, never as a confirmed failure or success', async () => {
    const { databasePath, sessionsDir } = fixture()
    const firstAuthority = authority(databasePath)
    const first = new SessionStore(sessionsDir, { authority: firstAuthority })
    const record = await first.create({ sessionId: 'unknown-effect', agentRuntime: 'copilot', config })
    await first.recordRuntimeProjection(record.sessionId, {
      ...record.state, cursor: 1, status: 'executing_tools',
      pendingCalls: [{ callId: 'effect-call', name: 'shell', input: { command: 'test-only' }, status: 'dispatched' }],
    }, 'copilot.tool_call', { callId: 'effect-call' })
    await firstAuthority.close()
    const second = new SessionStore(sessionsDir, { authority: authority(databasePath) })
    const recovered = await second.load(record.sessionId)
    expect(recovered.state).toMatchObject({ status: 'error', pendingCalls: [], error: expect.stringContaining('outcome is unknown') })
    expect(JSON.stringify(recovered.state.messages)).toContain('execution_unknown')
    expect(JSON.stringify(recovered.state.messages)).toContain('Do not automatically retry')
    const entry = await second.findLatestRuntimeMetadata(record.sessionId, 'copilot.recovered_interrupted_turn')
    expect(entry?.payload).toMatchObject({ unknownEffects: [{ callId: 'effect-call', name: 'shell', outcome: 'execution_unknown' }] })
    const cursor = recovered.state.cursor
    expect((await second.load(record.sessionId)).state.cursor).toBe(cursor)
  })

  it('rolls back the audit append when projection update fails', async () => {
    const { databasePath } = fixture()
    const first = authority(databasePath)
    await first.initialize()
    await first.create({ sessionId: 'rollback-session', state: { cursor: 0 }, config: {} })
    await first.close()

    const setup = new DatabaseSync(databasePath)
    setup.exec(`
      CREATE TRIGGER reject_portable_projection_update
      BEFORE UPDATE ON portable_sessions
      BEGIN
        SELECT RAISE(FAIL, 'injected projection failure');
      END;
    `)
    setup.close()

    const failing = authority(databasePath)
    await failing.initialize()
    await expect(failing.mutate('rollback-session', {
      mutationId: 'cursor:1',
      eventType: 'session.test',
      apply(current) {
        if (!current) throw new Error('missing current document')
        return { ...current, state: { cursor: 1 } }
      },
    })).rejects.toThrow('injected projection failure')
    await failing.close()

    const inspect = new DatabaseSync(databasePath)
    expect((inspect.prepare(`
      SELECT COUNT(*) AS count FROM portable_session_events WHERE session_id = ?
    `).get('rollback-session') as { count: number }).count).toBe(1)
    expect(JSON.parse((inspect.prepare(`
      SELECT document FROM portable_sessions WHERE session_id = ?
    `).get('rollback-session') as { document: string }).document)).toMatchObject({ state: { cursor: 0 } })
    inspect.exec('DROP TRIGGER reject_portable_projection_update')
    inspect.close()

    const recovered = authority(databasePath)
    await recovered.initialize()
    await expect(recovered.mutate('rollback-session', {
      mutationId: 'cursor:1',
      eventType: 'session.test',
      apply(current) {
        if (!current) throw new Error('missing current document')
        return { ...current, state: { cursor: 1 } }
      },
    })).resolves.toMatchObject({ state: { cursor: 1 } })
  })

  it('forks from an exact durable prefix and keeps deletion tombstones recoverable', async () => {
    const { databasePath, sessionsDir } = fixture()
    const sqlite = authority(databasePath)
    const store = new SessionStore(sessionsDir, { authority: sqlite })
    const parent = await store.create({ sessionId: 'fork-parent', config, organizationId: 'org-a' })
    for (const text of ['kept', 'not-kept']) {
      const event = { kind: 'user_message', text } as const
      const transition = step(parent.state, event, parent.config)
      await store.record(parent.sessionId, event, transition.effects, transition.next)
    }

    const child = await store.fork({ sourceSessionId: parent.sessionId, cursor: 1, sessionId: 'fork-child' })
    expect(child.state.cursor).toBe(1)
    expect(child.parentSessionId).toBe(parent.sessionId)
    expect(child.parentCursor).toBe(1)
    expect(child.delegationDepth).toBe(0)
    await expect(sqlite.load(child.sessionId)).resolves.toMatchObject({ delegationDepth: 0 })
    await expect(store.fork({ sourceSessionId: parent.sessionId, cursor: 3, sessionId: 'invalid-child' }))
      .rejects.toThrow('Invalid fork cursor 3')
    await expect(sqlite.load('invalid-child')).resolves.toBeUndefined()

    await expect(sqlite.requestDeletion(parent.sessionId, 'delete-parent')).resolves.toBe(true)
    await expect(sqlite.create(
      { sessionId: 'late-fork', state: { cursor: 0 }, config: {} },
      'late-fork-create',
      { fenceSessionId: parent.sessionId },
    )).rejects.toBeInstanceOf(SessionDeletingError)
    await expect(sqlite.load('late-fork')).resolves.toBeUndefined()

    await expect(sqlite.requestDeletion(child.sessionId, 'delete-child')).resolves.toBe(true)
    await expect(sqlite.load(child.sessionId)).resolves.toBeUndefined()
    await expect(sqlite.listDeleting()).resolves.toEqual([
      expect.objectContaining({ sessionId: child.sessionId }),
      expect.objectContaining({ sessionId: parent.sessionId }),
    ])
    await sqlite.close()

    const restarted = authority(databasePath)
    await restarted.initialize()
    await expect(restarted.loadDeleting(child.sessionId)).resolves.toMatchObject({ sessionId: child.sessionId })
    await restarted.delete(child.sessionId, 'finish-delete-child')
    await expect(restarted.loadDeleting(child.sessionId)).resolves.toBeUndefined()
    await expect(restarted.create({ sessionId: child.sessionId, state: { cursor: 0 }, config: {} }))
      .rejects.toBeInstanceOf(SessionDeletingError)
  })
})
