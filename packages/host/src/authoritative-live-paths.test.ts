import type { EventEntry, RuntimeMetadataEntry } from '@agent-kernel/shared'
import type { ToolSchema } from '@agent-kernel/kernel'
import { describe, expect, it, vi } from 'vitest'

import { KernelAgentRuntime } from './agent-runtime/kernel-runtime.js'
import { activeToolsFor, runToolCatalogTool } from './extensions/tool-catalog.js'
import { latestTodoGraphForSession } from './extensions/todo-graph.js'
import type { LoopHandle } from './loop-types.js'
import { SessionStore, type SessionRecord } from './store/session.js'
import { toolCatalogRevision } from './tool-disclosure.js'

const tools: ToolSchema[] = [
  { name: 'tool_search', description: 'discover tools', inputSchema: {}, requiresApproval: false },
  { name: 'tool_describe', description: 'describe tools', inputSchema: {}, requiresApproval: false },
  { name: 'write_file', description: 'write source files', inputSchema: {}, requiresApproval: true },
  { name: 'websearch', description: 'search the web', inputSchema: {}, requiresApproval: false },
]

function record(): SessionRecord {
  return {
    sessionId: 'pg-session',
    logPath: '/not-materialized/pg-session.jsonl',
    config: { tools },
  } as SessionRecord
}

function metadata(names: string[]): RuntimeMetadataEntry {
  return {
    kind: 'runtime_metadata',
    ts: '2026-10-19T00:00:00.000Z',
    sessionId: 'pg-session',
    action: 'tools_activated',
    payload: { catalogRevision: toolCatalogRevision(tools), names },
  }
}

describe('authoritative live paths', () => {
  it('reads and writes progressive Tool activation through the supplied store', async () => {
    const appendRuntimeMetadata = vi.fn(async () => metadata(['write_file', 'websearch']))
    const store = {
      findLatestRuntimeMetadata: vi.fn(async () => metadata(['write_file'])),
      appendRuntimeMetadata,
    }

    await expect(activeToolsFor(record(), store)).resolves.toEqual(new Set(['write_file']))
    const result = await runToolCatalogTool(record(), 'tool_describe', { names: ['websearch'] }, store)

    expect(result.ok).toBe(true)
    expect(appendRuntimeMetadata).toHaveBeenCalledWith('pg-session', {
      action: 'tools_activated',
      payload: {
        catalogRevision: toolCatalogRevision(tools),
        names: ['write_file', 'websearch'],
      },
    })
  })

  it('reconstructs todo graph state from authoritative event entries', async () => {
    const snapshot = {
      version: 1 as const,
      revision: 3,
      nodes: [{ id: 'ship', content: 'Ship fix', status: 'in_progress' as const }],
      edges: [],
      summary: { total: 1, completed: 0, active: 1, ready: 1, blocked: 0, cancelled: 0 },
      ready: ['ship'],
      blocked: [],
      changed: ['ship'],
    }
    const events = [
      { effects: [{ kind: 'call_tool', callId: 'call-1', name: 'todo_graph', input: {} }], event: { kind: 'llm_response' } },
      { effects: [], event: { kind: 'tool_result', callId: 'call-1', ok: true, content: JSON.stringify(snapshot) } },
    ] as unknown as EventEntry[]
    const store = { readEventEntries: vi.fn(async () => events) }

    await expect(latestTodoGraphForSession(store, 'pg-session')).resolves.toEqual(snapshot)
    expect(store.readEventEntries).toHaveBeenCalledWith('pg-session')
  })

  it('checks kernel receipts through SessionStore and never falls back to the absent log', async () => {
    const findPersistedKernelToolResult = vi.fn(async () => true)
    const runtime = new KernelAgentRuntime({} as LoopHandle, { findPersistedKernelToolResult })

    await expect(runtime.toolResultPersisted(record(), 'call-1')).resolves.toBe(true)
    expect(findPersistedKernelToolResult).toHaveBeenCalledWith('pg-session', 'call-1')
  })

  it('fails closed when a newer kernel invocation supersedes an older matching result', async () => {
    const entries = [
      { event: { kind: 'tool_result', callId: 'same-call' } },
      { event: { kind: 'llm_response', message: { content: [{ type: 'tool_call', callId: 'same-call' }] } } },
    ] as unknown as EventEntry[]
    const fakeStore = {
      options: { authority: {} },
      get: () => record(),
      readEventEntries: vi.fn(async () => entries),
    }

    const persisted = await SessionStore.prototype.findPersistedKernelToolResult.call(fakeStore, 'pg-session', 'same-call')
    expect(persisted).toBe(false)
  })
})
