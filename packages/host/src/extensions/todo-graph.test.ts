import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyTodoGraphOperations, latestTodoGraph, type TodoGraphSnapshot } from './todo-graph.js'

const empty: TodoGraphSnapshot = {
  version: 1,
  revision: 0,
  nodes: [],
  edges: [],
  summary: { total: 0, completed: 0, active: 0, ready: 0, blocked: 0, cancelled: 0 },
  ready: [],
  blocked: [],
  changed: [],
}

describe('todo graph', () => {
  it('defaults omitted replacement edges to empty, never to historical edges', () => {
    const nodes = [
      { id: 'a', content: 'A', status: 'pending' },
      { id: 'b', content: 'B', status: 'pending' },
    ]
    const previous = applyTodoGraphOperations(empty, [{ op: 'replace', nodes, edges: [{ from: 'a', to: 'b' }] }])
    const replaced = applyTodoGraphOperations(previous, [{ op: 'replace', nodes }])
    expect(replaced.edges).toEqual([])
    expect(replaced.ready).toEqual(['a', 'b'])
    expect(previous.edges).toEqual([{ from: 'a', to: 'b' }])
    for (const edges of [null, {}, 'invalid']) {
      expect(() => applyTodoGraphOperations(previous, [{ op: 'replace', nodes, edges }])).toThrow(/EINVAL/)
    }
  })

  it('creates branches and derives ready and blocked nodes', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'analyze', content: 'Analyze', status: 'completed' },
        { id: 'host', content: 'Host', status: 'pending' },
        { id: 'ui', content: 'UI', status: 'pending' },
        { id: 'test', content: 'Test', status: 'pending' },
      ],
      edges: [
        { from: 'analyze', to: 'host' },
        { from: 'analyze', to: 'ui' },
        { from: 'host', to: 'test' },
        { from: 'ui', to: 'test' },
      ],
    }])

    expect(graph.revision).toBe(1)
    expect(graph.ready).toEqual(['host', 'ui'])
    expect(graph.blocked).toEqual([{ id: 'test', waitingOn: ['host', 'ui'] }])
  })

  it('removes incident edges, replaces and clears without mutating historical graphs', () => {
    const graph = applyTodoGraphOperations(empty, [{ op: 'replace', nodes: [
      { id: 'old', content: 'Verified outcome', status: 'completed' },
      { id: 'pending', content: 'Explicit handoff required', status: 'pending' },
    ], edges: [{ from: 'old', to: 'pending' }] }])
    expect(() => applyTodoGraphOperations(graph, [{ op: 'remove_node', id: 'old' }])).toThrow(/ECONFLICT/)
    const pruned = applyTodoGraphOperations(graph, [{ op: 'remove_node', id: 'old', cascade: true }])
    expect(pruned.nodes.map((n) => n.id)).toEqual(['pending'])
    expect(pruned.edges).toEqual([])
    const replaced = applyTodoGraphOperations(pruned, [{ op: 'replace', nodes: [{ id: 'current', content: 'Current goal', status: 'in_progress' }], edges: [] }])
    expect(applyTodoGraphOperations(replaced, [{ op: 'clear' }])).toMatchObject({ nodes: [], edges: [], summary: { total: 0 }, ready: [], blocked: [] })
    expect(graph.nodes).toHaveLength(2)
  })

  it('rejects cycles atomically', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'a', content: 'A', status: 'pending' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }])

    expect(() => applyTodoGraphOperations(graph, [{ op: 'add_edge', from: 'b', to: 'a' }])).toThrow(/ECYCLE/)
    expect(graph.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('rejects starting blocked work and permits parallel active nodes', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'root', content: 'Root', status: 'pending' },
        { id: 'blocked', content: 'Blocked', status: 'pending' },
        { id: 'parallel', content: 'Parallel', status: 'pending' },
      ],
      edges: [{ from: 'root', to: 'blocked' }],
    }])

    expect(() => applyTodoGraphOperations(graph, [{ op: 'update_node', id: 'blocked', status: 'in_progress' }])).toThrow(/EBLOCKED/)
    const active = applyTodoGraphOperations(graph, [
      { op: 'update_node', id: 'root', status: 'in_progress' },
      { op: 'update_node', id: 'parallel', status: 'in_progress' },
    ])
    expect(active.summary.active).toBe(2)
  })

  it('does not treat a cancelled dependency as completed', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'a', content: 'A', status: 'cancelled' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }])
    expect(graph.blocked).toEqual([{ id: 'b', waitingOn: ['a'] }])
  })

  it('recovers the latest graph from an external runtime log without a full read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-graph-external-'))
    try {
      const path = join(dir, 'session.jsonl')
      const graph = applyTodoGraphOperations(empty, [{
        op: 'replace',
        nodes: [{ id: 'done', content: 'Done', status: 'completed' }],
        edges: [],
      }])
      writeFileSync(path, `${JSON.stringify({
        kind: 'header',
        sessionId: 'external-todo-graph',
        agentRuntime: 'copilot',
        initialState: { cursor: 0 },
      })}\n`)
      appendFileSync(path, `${JSON.stringify({
        kind: 'event',
        seq: 1,
        event: { kind: 'tool_result', callId: 'call-1', ok: true, content: JSON.stringify(graph) },
        effects: [],
      })}\n`)

      await expect(latestTodoGraph(path)).resolves.toMatchObject({
        revision: 1,
        nodes: [{ id: 'done', content: 'Done', status: 'completed' }],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
