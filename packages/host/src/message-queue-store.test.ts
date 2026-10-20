import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConfig, step } from '@agent-kernel/kernel'
import { loadPersistedMessageQueue, loadPersistedMessageQueueState, MAX_CANCELLED_OPERATION_IDS, persistMessageQueueSnapshot } from './message-queue-store.js'
import { appendRuntimeMetadataEntry, readSessionLog } from './store/log.js'
import { SessionStore } from './store/session.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('durable message queue metadata', () => {
  it('does not run dangling Tool recovery before planned continuation owns the checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-planned-handoff-'))
    roots.push(root)
    const config = createConfig({
      tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, requiresApproval: false }],
    })
    const predecessor = new SessionStore(root)
    const record = await predecessor.create({ sessionId: 'planned-tool-session', config })
    const user = { kind: 'user_message', text: 'write once' } as const
    const afterUser = step(record.state, user, config)
    await predecessor.record(record.sessionId, user, afterUser.effects, afterUser.next)
    const response = {
      kind: 'llm_response',
      message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'write-once', name: 'write', input: {} }] },
    } as const
    const beforeTool = step(record.state, response, config)
    await predecessor.record(record.sessionId, response, beforeTool.effects, beforeTool.next)
    expect(record.state).toMatchObject({ cursor: 2, status: 'executing_tools' })

    const replacement = new SessionStore(root)
    await expect(loadPersistedMessageQueue(replacement, record.sessionId)).resolves.toEqual([])
    expect(replacement.get(record.sessionId)?.state).toMatchObject({ cursor: 2, status: 'executing_tools' })
    let parsed = await readSessionLog(record.logPath)
    expect(parsed.events).toHaveLength(2)
    expect(JSON.stringify(parsed.events)).not.toContain('host restarted while call was pending')

    await persistMessageQueueSnapshot(new SessionStore(root), record.sessionId, [{
      id: 'queue-1', operationId: 'operation-queue-1', text: 'after handoff', mode: 'queue', createdAt: new Date().toISOString(),
    }])
    parsed = await readSessionLog(record.logPath)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.runtimeMetadata.at(-1)).toMatchObject({ action: 'message_queue_snapshot', payload: { items: [{ operationId: 'operation-queue-1' }] } })
  })

  it('persists cancellation tombstones with an empty queue across an immediate reload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-cancelled-'))
    roots.push(root)
    const store = new SessionStore(root)
    const record = await store.create({ sessionId: 'cancelled-queue', config: createConfig({ tools: [] }) })

    await persistMessageQueueSnapshot(store, record.sessionId, [], ['operation-deleted-before-arrival', 'operation-stopped'])

    await expect(loadPersistedMessageQueueState(new SessionStore(root), record.sessionId)).resolves.toEqual({
      items: [],
      cancelledOperationIds: ['operation-deleted-before-arrival', 'operation-stopped'],
    })
    const parsed = await readSessionLog(record.logPath)
    expect(parsed.runtimeMetadata.at(-1)).toMatchObject({
      action: 'message_queue_snapshot',
      payload: { schemaVersion: 3, items: [], cancelledOperationIds: ['operation-deleted-before-arrival', 'operation-stopped'] },
    })
  })

  it('restores a shell command and its persisted result without re-execution state loss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-shell-'))
    roots.push(root)
    const store = new SessionStore(root)
    const record = await store.create({ sessionId: 'shell-queue', config: createConfig({ tools: [] }) })
    const item = {
      id: 'shell-item',
      operationId: 'shell-operation',
      text: '!printf hello',
      mode: 'queue' as const,
      createdAt: new Date().toISOString(),
      shell: { command: 'printf hello', state: 'nonzero' as const, result: 'persisted shell result' },
    }

    await persistMessageQueueSnapshot(store, record.sessionId, [item])

    await expect(loadPersistedMessageQueue(new SessionStore(root), record.sessionId)).resolves.toEqual([item])
  })

  it('restores an unknown shell result and its operator recovery guidance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-shell-unknown-'))
    roots.push(root)
    const store = new SessionStore(root)
    const record = await store.create({ sessionId: 'shell-queue-unknown', config: createConfig({ tools: [] }) })
    const item = {
      id: 'shell-unknown-item',
      operationId: 'shell-unknown-operation',
      text: '!printf maybe',
      mode: 'queue' as const,
      createdAt: new Date().toISOString(),
      shell: {
        command: 'printf maybe',
        state: 'unknown' as const,
        error: 'Inspect the workspace, delete/cancel this item, and retry with a new operation ID.',
      },
    }

    await persistMessageQueueSnapshot(store, record.sessionId, [item])

    await expect(loadPersistedMessageQueue(new SessionStore(root), record.sessionId)).resolves.toEqual([item])
  })

  it('rejects a new cancellation beyond the cap without dropping existing tombstones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-cancellation-cap-'))
    roots.push(root)
    const store = new SessionStore(root)
    const record = await store.create({ sessionId: 'cancellation-cap', config: createConfig({ tools: [] }) })
    const tombstones = Array.from({ length: MAX_CANCELLED_OPERATION_IDS }, (_, index) => `operation-${index}`)
    await persistMessageQueueSnapshot(store, record.sessionId, [], tombstones)
    const before = (await readSessionLog(record.logPath)).runtimeMetadata.length

    await expect(persistMessageQueueSnapshot(store, record.sessionId, [], [...tombstones, 'one-too-many']))
      .rejects.toThrow(`cancellation tombstone limit of ${MAX_CANCELLED_OPERATION_IDS} exceeded; existing cancellations were preserved`)

    expect((await readSessionLog(record.logPath)).runtimeMetadata).toHaveLength(before)
    await expect(loadPersistedMessageQueueState(new SessionStore(root), record.sessionId)).resolves.toEqual({
      items: [],
      cancelledOperationIds: tombstones,
    })
  })

  it.each([
    ['missing', undefined, 'expected an array'],
    ['malformed', ['operation-valid', ''], 'expected non-empty strings'],
    ['duplicate', ['operation-duplicate', 'operation-duplicate'], 'duplicate operation ID'],
    ['oversized', Array.from({ length: MAX_CANCELLED_OPERATION_IDS + 1 }, () => 'operation-duplicate'), `limit of ${MAX_CANCELLED_OPERATION_IDS} exceeded`],
  ])('fails closed for a %s persisted cancellation tombstone list', async (name, cancelledOperationIds, message) => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-invalid-cancellations-'))
    roots.push(root)
    const store = new SessionStore(root)
    const record = await store.create({ sessionId: `invalid-cancellations-${name}`, config: createConfig({ tools: [] }) })
    await appendRuntimeMetadataEntry(record.logPath, {
      sessionId: record.sessionId,
      action: 'message_queue_snapshot',
      payload: { schemaVersion: 2, items: [], ...(cancelledOperationIds === undefined ? {} : { cancelledOperationIds }) },
    })

    await expect(loadPersistedMessageQueueState(new SessionStore(root), record.sessionId)).rejects.toThrow(message)
  })

  it('restores a queued attachment-only message with an empty text field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-queue-attachment-only-'))
    roots.push(root)
    const store = new SessionStore(root)
    const record = await store.create({ sessionId: 'attachment-only', config: createConfig({ tools: [] }) })
    const file = {
      type: 'file',
      name: 'notes.md',
      mediaType: 'text/markdown',
      source: {
        kind: 'host_ref',
        attachmentId: '00000000-0000-4000-8000-000000000000',
        sha256: 'a'.repeat(64),
        bytes: 12,
      },
    } as const
    await persistMessageQueueSnapshot(store, record.sessionId, [{
      id: 'queue-file',
      operationId: 'operation-file',
      text: '',
      mode: 'queue',
      createdAt: new Date().toISOString(),
      content: [file],
    }])
    appendFileSync(record.logPath, '{"kind":"runtime_metadata","action":"older","malformed"\n', 'utf8')
    await persistMessageQueueSnapshot(store, record.sessionId, [{
      id: 'queue-file',
      operationId: 'operation-file',
      text: '',
      mode: 'queue',
      createdAt: new Date().toISOString(),
      content: [file],
    }])

    await expect(loadPersistedMessageQueue(store, record.sessionId)).resolves.toEqual([
      expect.objectContaining({ id: 'queue-file', text: '', content: [file] }),
    ])
  })
})
