import type { CallToolEffect } from '@agent-kernel/kernel'
import { open } from 'node:fs/promises'

import type { HostLoopDeps } from '../loop-types.js'
import { readSessionLog } from '../store/log.js'

export type TodoGraphStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TodoGraphPriority = 'high' | 'medium' | 'low'
export type TodoGraphNode = { id: string; content: string; status: TodoGraphStatus; priority?: TodoGraphPriority }
export type TodoGraphEdge = { from: string; to: string }
export type TodoGraphSnapshot = {
  version: 1
  revision: number
  nodes: TodoGraphNode[]
  edges: TodoGraphEdge[]
  summary: { total: number; completed: number; active: number; ready: number; blocked: number; cancelled: number }
  ready: string[]
  blocked: Array<{ id: string; waitingOn: string[] }>
  changed: string[]
}

type Operation =
  | { op: 'replace'; nodes: TodoGraphNode[]; edges: TodoGraphEdge[] }
  | { op: 'add_node'; node: TodoGraphNode }
  | { op: 'update_node'; id: string; content?: string; status?: TodoGraphStatus; priority?: TodoGraphPriority | null }
  | { op: 'remove_node'; id: string; cascade?: boolean }
  | { op: 'add_edge'; from: string; to: string }
  | { op: 'remove_edge'; from: string; to: string }
  | { op: 'clear' }

const EMPTY: TodoGraphSnapshot = {
  version: 1, revision: 0, nodes: [], edges: [],
  summary: { total: 0, completed: 0, active: 0, ready: 0, blocked: 0, cancelled: 0 },
  ready: [], blocked: [], changed: [],
}
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const STATUSES = new Set<TodoGraphStatus>(['pending', 'in_progress', 'completed', 'cancelled'])
const PRIORITIES = new Set<TodoGraphPriority>(['high', 'medium', 'low'])
const liveGraphs = new Map<string, TodoGraphSnapshot>()
const graphLocks = new Map<string, Promise<void>>()
const TODO_GRAPH_SCAN_BYTES = 64 * 1024 * 1024

export async function runTodoGraphTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
): Promise<{ ok: boolean; content: string }> {
  const previous = graphLocks.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const currentLock = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => currentLock)
  graphLocks.set(sessionId, queued)
  await previous
  try {
    const record = deps.store.get(sessionId)
    if (!record) throw new GraphError('ENOENT', `unknown session: ${sessionId}`)
    const current = liveGraphs.get(record.sessionId) ?? await latestTodoGraphForSession(deps.store, record.sessionId, record.logPath)
    const input = effect.input as { operations?: unknown; expectedRevision?: unknown }
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new GraphError('ECONFLICT', `revision mismatch; expected ${String(input.expectedRevision)}, current ${current.revision}`)
    }
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new GraphError('EINVAL', 'operations must be a non-empty array')
    }
    if (input.operations.length > 100) throw new GraphError('ELIMIT', 'at most 100 operations are allowed')
    const next = applyTodoGraphOperations(current, input.operations)
    liveGraphs.set(record.sessionId, next)
    return { ok: true, content: JSON.stringify(next) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, content: `ERROR: ${message}` }
  } finally {
    release()
    if (graphLocks.get(sessionId) === queued) graphLocks.delete(sessionId)
  }
}

export function applyTodoGraphOperations(current: TodoGraphSnapshot, rawOperations: readonly unknown[]): TodoGraphSnapshot {
  let nodes = current.nodes.map((node) => ({ ...node }))
  let edges = current.edges.map((edge) => ({ ...edge }))
  const changed = new Set<string>()

  for (let i = 0; i < rawOperations.length; i++) {
    const operation = parseOperation(rawOperations[i], i)
    switch (operation.op) {
      case 'replace':
        nodes = operation.nodes.map((node) => ({ ...node }))
        edges = operation.edges.map((edge) => ({ ...edge }))
        operation.nodes.forEach((node) => changed.add(node.id))
        break
      case 'clear':
        nodes.forEach((node) => changed.add(node.id))
        nodes = []
        edges = []
        break
      case 'add_node':
        if (nodes.some((node) => node.id === operation.node.id)) throw new GraphError('ECONFLICT', `node already exists: ${operation.node.id}`)
        nodes.push({ ...operation.node })
        changed.add(operation.node.id)
        break
      case 'update_node': { // eslint-disable-line no-case-declarations
        const index = nodes.findIndex((node) => node.id === operation.id)
        if (index < 0) throw new GraphError('ENOENT', `unknown node: ${operation.id}`)
        const old = nodes[index]!
        nodes[index] = {
          ...old,
          ...(operation.content !== undefined ? { content: operation.content } : {}),
          ...(operation.status !== undefined ? { status: operation.status } : {}),
          ...(operation.priority === null ? { priority: undefined } : operation.priority !== undefined ? { priority: operation.priority } : {}),
        }
        changed.add(operation.id)
        break
      }
      case 'remove_node': { // eslint-disable-line no-case-declarations
        if (!nodes.some((node) => node.id === operation.id)) throw new GraphError('ENOENT', `unknown node: ${operation.id}`)
        const related = edges.some((edge) => edge.from === operation.id || edge.to === operation.id)
        if (related && !operation.cascade) throw new GraphError('ECONFLICT', `node ${operation.id} has dependency edges; remove them first or set cascade=true`)
        nodes = nodes.filter((node) => node.id !== operation.id)
        edges = edges.filter((edge) => edge.from !== operation.id && edge.to !== operation.id)
        changed.add(operation.id)
        break
      }
      case 'add_edge':
        if (edges.some((edge) => edge.from === operation.from && edge.to === operation.to)) throw new GraphError('ECONFLICT', `edge already exists: ${operation.from} -> ${operation.to}`)
        edges.push({ from: operation.from, to: operation.to })
        changed.add(operation.from); changed.add(operation.to)
        break
      case 'remove_edge': { // eslint-disable-line no-case-declarations
        const before = edges.length
        edges = edges.filter((edge) => edge.from !== operation.from || edge.to !== operation.to)
        if (edges.length === before) throw new GraphError('ENOENT', `unknown edge: ${operation.from} -> ${operation.to}`)
        changed.add(operation.from); changed.add(operation.to)
        break
      }
    }
    validateGraph(nodes, edges)
  }

  const derived = derive(nodes, edges)
  for (const node of nodes) {
    if (node.status === 'in_progress' && derived.blocked.some((item) => item.id === node.id)) {
      throw new GraphError('EBLOCKED', `node ${node.id} cannot be in_progress; dependencies are incomplete`)
    }
  }
  return { version: 1, revision: current.revision + 1, nodes, edges, ...derived, changed: [...changed] }
}

export function parseTodoGraphSnapshot(content: string): TodoGraphSnapshot | undefined {
  try {
    const value = JSON.parse(content) as TodoGraphSnapshot
    if (value?.version !== 1 || !Number.isInteger(value.revision) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return undefined
    validateGraph(value.nodes, value.edges)
    return value
  } catch {
    return undefined
  }
}

export async function latestTodoGraph(logPath: string): Promise<TodoGraphSnapshot> {
  let parsed: Awaited<ReturnType<typeof readSessionLog>>
  try {
    parsed = await readSessionLog(logPath)
  } catch (error) {
    if (error instanceof Error && error.message.includes('refuses to fully read external Runtime session')) {
      return await latestTodoGraphFromTail(logPath)
    }
    throw error
  }
  const calls = new Map<string, string>()
  let snapshot = EMPTY
  for (const entry of parsed.events) {
    for (const effect of entry.effects) {
      if (effect.kind === 'call_tool') calls.set(effect.callId, effect.name)
    }
    if (entry.event.kind !== 'tool_result' || !entry.event.ok || calls.get(entry.event.callId) !== 'todo_graph') continue
    const candidate = parseTodoGraphSnapshot(entry.event.content)
    if (candidate) snapshot = candidate
  }
  return snapshot
}

type TodoGraphEventStore = Pick<HostLoopDeps['store'], 'readEventEntries'>

export async function latestTodoGraphForSession(store: TodoGraphEventStore, sessionId: string, localLogPath?: string): Promise<TodoGraphSnapshot> {
  let entries
  try {
    entries = await store.readEventEntries(sessionId)
  } catch (error) {
    if (localLogPath && error instanceof Error && error.message.includes('refuses to fully read external Runtime session')) {
      return latestTodoGraphFromTail(localLogPath)
    }
    throw error
  }
  const calls = new Map<string, string>()
  let snapshot = EMPTY
  for (const entry of entries) {
    for (const effect of entry.effects) {
      if (effect.kind === 'call_tool') calls.set(effect.callId, effect.name)
    }
    if (entry.event.kind !== 'tool_result' || !entry.event.ok || calls.get(entry.event.callId) !== 'todo_graph') continue
    const candidate = parseTodoGraphSnapshot(entry.event.content)
    if (candidate) snapshot = candidate
  }
  return snapshot
}

async function latestTodoGraphFromTail(logPath: string): Promise<TodoGraphSnapshot> {
  const handle = await open(logPath, 'r')
  const needle = Buffer.from('"kind":"tool_result"')
  const chunkSize = 4 * 1024 * 1024
  let carry = Buffer.alloc(0)
  try {
    const stat = await handle.stat()
    let end = stat.size
    const minimumOffset = Math.max(0, stat.size - TODO_GRAPH_SCAN_BYTES)
    while (end > minimumOffset) {
      const start = Math.max(minimumOffset, end - chunkSize)
      const chunk = Buffer.allocUnsafe(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let match = data.lastIndexOf(needle)
      while (match >= 0 && match < chunk.length) {
        const line = await readLineContaining(handle, start + match, stat.size)
        if (line.startsWith('{"kind":"event"')) {
          const entry = JSON.parse(line) as { kind?: string; event?: { kind?: string; ok?: boolean; content?: string } }
          if (entry.kind === 'event' && entry.event?.kind === 'tool_result' && entry.event.ok === true && typeof entry.event.content === 'string') {
            const snapshot = parseTodoGraphSnapshot(entry.event.content)
            if (snapshot) return snapshot
          }
        }
        match = data.lastIndexOf(needle, match - 1)
      }
      carry = chunk.subarray(0, Math.min(needle.length - 1, chunk.length))
      end = start
    }
    return EMPTY
  } finally {
    await handle.close()
  }
}

async function readLineContaining(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  fileSize: number,
): Promise<string> {
  const blockSize = 64 * 1024
  let lineStart = offset
  while (lineStart > 0) {
    const start = Math.max(0, lineStart - blockSize)
    const chunk = Buffer.allocUnsafe(lineStart - start)
    await handle.read(chunk, 0, chunk.length, start)
    const newline = chunk.lastIndexOf(10)
    if (newline >= 0) {
      lineStart = start + newline + 1
      break
    }
    lineStart = start
  }

  let lineEnd = offset
  while (lineEnd < fileSize) {
    const length = Math.min(blockSize, fileSize - lineEnd)
    const chunk = Buffer.allocUnsafe(length)
    await handle.read(chunk, 0, length, lineEnd)
    const newline = chunk.indexOf(10)
    if (newline >= 0) {
      lineEnd += newline
      break
    }
    lineEnd += length
  }

  const line = Buffer.allocUnsafe(lineEnd - lineStart)
  await handle.read(line, 0, line.length, lineStart)
  return line.toString('utf8')
}

/**
 * A graph with active or ready work is a durable autonomous-work obligation.
 * It is used by the Host loop to recover from an accidental terminal LLM reply
 * and to resume after automatic context compaction.
 */
export async function todoGraphContinuationState(
  deps: HostLoopDeps,
  sessionId: string,
): Promise<{ revision: number; needsContinuation: boolean }> {
  const record = deps.store.get(sessionId)
  if (!record) return { revision: 0, needsContinuation: false }
  let snapshot: TodoGraphSnapshot
  try {
    // Continuation is a durable obligation: a process-global cache may belong
    // to another SessionStore instance with the same ID, or contain a Tool
    // result that has not committed yet. Always consult the selected authority.
    snapshot = await latestTodoGraphForSession(deps.store, record.sessionId, record.logPath)
  } catch (error) {
    // Session teardown/tests can remove the log after the terminal event has
    // committed but before this optional continuation check runs.
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { revision: 0, needsContinuation: false }
    throw error
  }
  liveGraphs.set(record.sessionId, snapshot)
  return {
    revision: snapshot.revision,
    needsContinuation: snapshot.summary.active > 0 || snapshot.summary.ready > 0,
  }
}

function parseOperation(value: unknown, index: number): Operation {
  if (!value || typeof value !== 'object') throw new GraphError('EINVAL', `operations[${index}] must be an object`)
  const rec = value as Record<string, unknown>
  const op = rec.op
  if (op === 'clear') return { op }
  if (op === 'replace') {
    if (!Array.isArray(rec.nodes) || !Array.isArray(rec.edges)) throw new GraphError('EINVAL', `operations[${index}] replace requires nodes and edges arrays`)
    return { op, nodes: rec.nodes.map((node, i) => parseNode(node, `operations[${index}].nodes[${i}]`)), edges: rec.edges.map((edge, i) => parseEdge(edge, `operations[${index}].edges[${i}]`)) }
  }
  if (op === 'add_node') return { op, node: parseNode(rec.node, `operations[${index}].node`) }
  if (op === 'update_node') {
    const id = parseId(rec.id, `operations[${index}].id`)
    const content = rec.content === undefined ? undefined : parseContent(rec.content, `operations[${index}].content`)
    const status = rec.status === undefined ? undefined : parseStatus(rec.status, `operations[${index}].status`)
    const priority = rec.priority === null ? null : rec.priority === undefined ? undefined : parsePriority(rec.priority, `operations[${index}].priority`)
    if (content === undefined && status === undefined && priority === undefined) throw new GraphError('EINVAL', `operations[${index}] update_node has no changes`)
    return { op, id, ...(content !== undefined ? { content } : {}), ...(status !== undefined ? { status } : {}), ...(priority !== undefined ? { priority } : {}) }
  }
  if (op === 'remove_node') return { op, id: parseId(rec.id, `operations[${index}].id`), ...(typeof rec.cascade === 'boolean' ? { cascade: rec.cascade } : {}) }
  if (op === 'add_edge' || op === 'remove_edge') return { op, from: parseId(rec.from, `operations[${index}].from`), to: parseId(rec.to, `operations[${index}].to`) }
  throw new GraphError('EINVAL', `operations[${index}].op is invalid`)
}

function parseNode(value: unknown, path: string): TodoGraphNode {
  if (!value || typeof value !== 'object') throw new GraphError('EINVAL', `${path} must be an object`)
  const rec = value as Record<string, unknown>
  return { id: parseId(rec.id, `${path}.id`), content: parseContent(rec.content, `${path}.content`), status: parseStatus(rec.status, `${path}.status`), ...(rec.priority !== undefined ? { priority: parsePriority(rec.priority, `${path}.priority`) } : {}) }
}
function parseEdge(value: unknown, path: string): TodoGraphEdge {
  if (!value || typeof value !== 'object') throw new GraphError('EINVAL', `${path} must be an object`)
  const rec = value as Record<string, unknown>
  return { from: parseId(rec.from, `${path}.from`), to: parseId(rec.to, `${path}.to`) }
}
function parseId(value: unknown, path: string): string { if (typeof value !== 'string' || !ID.test(value)) throw new GraphError('EINVAL', `${path} must match ${ID}`); return value }
function parseContent(value: unknown, path: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new GraphError('EINVAL', `${path} must be 1-500 characters`); return value }
function parseStatus(value: unknown, path: string): TodoGraphStatus { if (typeof value !== 'string' || !STATUSES.has(value as TodoGraphStatus)) throw new GraphError('EINVAL', `${path} has an invalid status`); return value as TodoGraphStatus }
function parsePriority(value: unknown, path: string): TodoGraphPriority { if (typeof value !== 'string' || !PRIORITIES.has(value as TodoGraphPriority)) throw new GraphError('EINVAL', `${path} has an invalid priority`); return value as TodoGraphPriority }

function validateGraph(nodes: readonly TodoGraphNode[], edges: readonly TodoGraphEdge[]): void {
  if (nodes.length > 200 || edges.length > 1000) throw new GraphError('ELIMIT', 'graph exceeds 200 nodes or 1000 edges')
  const ids = new Set<string>()
  for (const node of nodes) {
    parseNode(node, `node ${node.id || '?'}`)
    if (ids.has(node.id)) throw new GraphError('ECONFLICT', `duplicate node: ${node.id}`)
    ids.add(node.id)
  }
  const seen = new Set<string>()
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new GraphError('ENOENT', `edge references unknown node: ${edge.from} -> ${edge.to}`)
    if (edge.from === edge.to) throw new GraphError('ECYCLE', `self dependency: ${edge.from}`)
    const key = `${edge.from}\0${edge.to}`
    if (seen.has(key)) throw new GraphError('ECONFLICT', `duplicate edge: ${edge.from} -> ${edge.to}`)
    seen.add(key)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
    indegree.set(edge.to, indegree.get(edge.to)! + 1)
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!; visited++
    for (const next of outgoing.get(id) ?? []) { const degree = indegree.get(next)! - 1; indegree.set(next, degree); if (degree === 0) queue.push(next) }
  }
  if (visited !== nodes.length) throw new GraphError('ECYCLE', 'dependency graph must be acyclic')
}

function derive(nodes: readonly TodoGraphNode[], edges: readonly TodoGraphEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const blocked: Array<{ id: string; waitingOn: string[] }> = []
  const ready: string[] = []
  let completed = 0, active = 0, cancelled = 0
  for (const node of nodes) {
    if (node.status === 'completed') { completed++; continue }
    if (node.status === 'cancelled') { cancelled++; continue }
    if (node.status === 'in_progress') active++
    const waitingOn = edges.filter((edge) => edge.to === node.id && byId.get(edge.from)?.status !== 'completed').map((edge) => edge.from)
    if (waitingOn.length) blocked.push({ id: node.id, waitingOn })
    else if (node.status === 'pending') ready.push(node.id)
  }
  return { summary: { total: nodes.length, completed, active, ready: ready.length, blocked: blocked.length, cancelled }, ready, blocked }
}

class GraphError extends Error {
  constructor(code: string, message: string) { super(`${code}: ${message}`) }
}
