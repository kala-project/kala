import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  DagDecision,
  DagEdge,
  DagEvent,
  DagGraphPatch,
  DagGraphVersion,
  DagGraphVersionNode,
  DagNode,
  DagNodeAttempt,
  DagNodeAttemptStatus,
  DagNodeStatus,
  DagPlanEdgeInput,
  DagRun,
  DagRunStatus,
  DagToolActivity,
} from '@agent-kernel/shared'

export const MAX_DAG_DECISIONS_PER_NODE = 8

import { assertDag, assertNodeTransition, assertSingleEntryReachability, readyNodeIds, scopesConflict } from './graph.js'
import type { ClaimedDagNode, DagStorage } from './storage.js'

const MAX_GRAPH_NODES = 100
const MAX_GRAPH_EDGES = 500

type RunRow = {
  id: string
  parent_session_id: string
  objective: string
  status: DagRunStatus
  graph_version: number
  result_node_id: string | null
  result: string | null
  error: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

type NodeRow = {
  id: string
  run_id: string
  title: string
  instructions: string
  status: DagNodeStatus
  depth: number
  write_scopes: string
  estimated_duration_minutes: number | null
  attempt: number
  child_session_id: string | null
  progress: string | null
  result: string | null
  error: string | null
  replaced_by: string | null
  started_at: string | null
  completed_at: string | null
  tool_activity: string
}

type EdgeRow = { id: string; run_id: string; source: string; target: string }

export class DagStore implements DagStorage {
  constructor(private readonly db: DatabaseSync) {}

  createRun(parentSessionId: string, objective: string, operationId: string, now = new Date().toISOString()): DagRun {
    const normalizedParent = requiredText(parentSessionId, 'DAG parent session id')
    const normalizedObjective = requiredText(objective, 'DAG objective')
    const existing = this.operationResult(operationId, 'create_run')
    if (existing) {
      const run = this.requireRun(existing)
      if (run.parentSessionId !== normalizedParent || run.objective !== normalizedObjective) {
        throw new Error('DAG operation id was already used for a different run')
      }
      return run
    }
    const id = randomUUID()
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO dag_runs (id, parent_session_id, objective, status, graph_version, created_at, updated_at)
        VALUES (?, ?, ?, 'planning', 0, ?, ?)
      `).run(id, normalizedParent, normalizedObjective, now, now)
      this.recordEvent(id, 'run', 'DAG run created', undefined, now)
      this.recordOperation(operationId, id, 'create_run', now)
    })
    return this.requireRun(id)
  }

  runForSession(parentSessionId: string): DagRun | undefined {
    const row = this.db.prepare(`
      SELECT id FROM dag_runs WHERE parent_session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(parentSessionId) as { id: string } | undefined
    return row ? this.requireRun(row.id) : undefined
  }

  runsForSession(parentSessionId: string): readonly DagRun[] {
    const rows = this.db.prepare(`
      SELECT id FROM dag_runs WHERE parent_session_id = ? ORDER BY created_at, rowid
    `).all(parentSessionId) as Array<{ id: string }>
    return rows.map((row) => this.requireRun(row.id))
  }

  activeParentSessionIds(): readonly string[] {
    return (this.db.prepare(`
      SELECT parent_session_id AS parentSessionId, MIN(created_at) AS firstCreated
      FROM dag_runs
      WHERE status IN ('planning', 'running', 'paused')
      GROUP BY parent_session_id
      ORDER BY firstCreated
    `).all() as Array<{ parentSessionId: string }>).map((row) => row.parentSessionId)
  }

  getRun(runId: string): DagRun | undefined {
    const row = this.db.prepare('SELECT * FROM dag_runs WHERE id = ?').get(runId) as RunRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  installGraph(runId: string, patch: DagGraphPatch, operationId: string, now = new Date().toISOString()): DagRun {
    const existing = this.operationResult(operationId, 'install_graph', runId)
    if (existing) return this.requireRun(existing)
    validatePatch(patch)
    this.transaction(() => {
      const run = this.requireRunRow(runId)
      if (run.status !== 'planning' || run.graph_version !== 0 || patch.expectedGraphVersion !== 0) {
        throw new Error('DAG initial graph can only be installed on a planning run at version 0')
      }
      const depths = graphDepths(patch.nodes.map((node) => node.id), patch.edges)
      const insertNode = this.db.prepare(`
        INSERT INTO dag_nodes (
          id, run_id, title, instructions, status, depth, write_scopes, estimated_duration_minutes, attempt
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0)
      `)
      for (const node of patch.nodes) {
        insertNode.run(
          node.id,
          runId,
          requiredText(node.title, 'DAG node title'),
          requiredText(node.instructions, 'DAG node instructions'),
          depths.get(node.id) ?? 0,
          JSON.stringify(normalizedScopes(node.writeScopes ?? [])),
          normalizedEstimate(node.estimatedDurationMinutes),
        )
      }
      this.insertEdges(runId, patch.edges)
      const updated = this.db.prepare(`
        UPDATE dag_runs SET status = 'running', graph_version = 1, result_node_id = ?, updated_at = ?
        WHERE id = ? AND status = 'planning' AND graph_version = 0
      `).run(patch.resultNodeId, now, runId)
      if (Number(updated.changes) !== 1) throw new Error('DAG initial graph installation lost its run fence')
      this.promoteReadyNodes(runId)
      this.recordGraphVersion(runId, 1, now)
      this.recordEvent(runId, 'graph', 'Graph version 1 installed', undefined, now)
      this.recordOperation(operationId, runId, 'install_graph', now)
    })
    return this.requireRun(runId)
  }

  replaceGraph(runId: string, patch: DagGraphPatch, operationId: string, now = new Date().toISOString()): DagRun {
    return this.installGraph(runId, patch, operationId, now)
  }

  expandNode(
    runId: string,
    nodeId: string,
    workerId: string,
    patch: DagGraphPatch,
    operationId: string,
    now = new Date().toISOString(),
    leaseGeneration?: number,
  ): DagRun {
    const existing = this.operationResult(operationId, 'expand_node', runId)
    if (existing) return this.requireRun(existing)
    validatePatch(patch)
    const entryId = assertSingleEntryReachability(patch.nodes.map((node) => node.id), patch.edges)
    this.transaction(() => {
      const run = this.requireMutableRun(runId)
      if (run.graph_version !== patch.expectedGraphVersion) throw new Error('DAG graph version conflict')
      const original = this.requireNode(runId, nodeId)
      if (original.status !== 'running') throw new Error('DAG graph expansion requires a running node')
      this.assertLease(runId, nodeId, workerId, now, leaseGeneration)

      const allNodes = this.nodeRows(runId)
      const allIds = new Set(allNodes.map((node) => node.id))
      for (const node of patch.nodes) {
        if (allIds.has(node.id)) throw new Error(`DAG node id already exists in run history: ${node.id}`)
      }
      if (allNodes.length + patch.nodes.length > MAX_GRAPH_NODES) throw new Error(`DAG run cannot exceed ${MAX_GRAPH_NODES} nodes`)

      const currentEdges = this.edgeRows(runId)
      const incoming = currentEdges.filter((edge) => edge.target === nodeId)
      const outgoing = currentEdges.filter((edge) => edge.source === nodeId)
      const replacementSources = new Set(patch.edges.map((edge) => edge.source))
      const leafIds = patch.nodes.map((node) => node.id).filter((id) => !replacementSources.has(id))
      const retainedEdges = currentEdges
        .filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
        .map(({ source, target }) => ({ source, target }))
      const rewired: DagPlanEdgeInput[] = [
        ...incoming.map((edge) => ({ source: edge.source, target: entryId })),
        ...outgoing.flatMap((edge) => leafIds.map((leaf) => ({ source: leaf, target: edge.target }))),
      ]
      const candidateEdges = uniqueEdges([...retainedEdges, ...patch.edges, ...rewired])
      const candidateNodeIds = allNodes
        .filter((node) => node.status !== 'replaced' && node.id !== nodeId)
        .map((node) => node.id)
        .concat(patch.nodes.map((node) => node.id))
      if (candidateEdges.length > MAX_GRAPH_EDGES) throw new Error(`DAG graph cannot exceed ${MAX_GRAPH_EDGES} edges`)
      assertDag(candidateNodeIds, candidateEdges)

      this.db.prepare('DELETE FROM dag_edges WHERE run_id = ? AND (source = ? OR target = ?)').run(runId, nodeId, nodeId)
      const insertNode = this.db.prepare(`
        INSERT INTO dag_nodes (
          id, run_id, title, instructions, status, depth, write_scopes, estimated_duration_minutes, attempt
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0)
      `)
      for (const node of patch.nodes) {
        insertNode.run(
          node.id,
          runId,
          requiredText(node.title, 'DAG node title'),
          requiredText(node.instructions, 'DAG node instructions'),
          original.depth + 1,
          JSON.stringify(normalizedScopes(node.writeScopes ?? [])),
          normalizedEstimate(node.estimatedDurationMinutes),
        )
      }
      this.insertEdges(runId, uniqueEdges([...patch.edges, ...rewired]))
      const replaced = this.db.prepare(`
        UPDATE dag_nodes
        SET status = 'replaced', progress = 'Replaced by graph expansion', replaced_by = ?, completed_at = ?
        WHERE run_id = ? AND id = ? AND status = 'running'
      `).run(entryId, now, runId, nodeId)
      if (Number(replaced.changes) !== 1) throw new Error('DAG graph expansion lost its node fence')
      this.db.prepare('DELETE FROM dag_leases WHERE run_id = ? AND node_id = ? AND owner = ?').run(runId, nodeId, workerId)
      this.settleAttempt(runId, nodeId, original.attempt, 'replaced', now)
      const nextVersion = run.graph_version + 1
      const nextResultNodeId = run.result_node_id === nodeId ? patch.resultNodeId : run.result_node_id
      const updated = this.db.prepare(`
        UPDATE dag_runs SET graph_version = ?, result_node_id = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND graph_version = ?
      `).run(nextVersion, nextResultNodeId, now, runId, run.graph_version)
      if (Number(updated.changes) !== 1) throw new Error('DAG graph expansion lost its version fence')
      this.promoteReadyNodes(runId)
      this.recordGraphVersion(runId, nextVersion, now)
      this.recordEvent(runId, 'graph', `Node replaced by graph version ${nextVersion}`, nodeId, now)
      this.recordOperation(operationId, runId, 'expand_node', now)
    })
    return this.requireRun(runId)
  }

  claimReadyNodes(
    runId: string,
    workerId: string,
    limit: number,
    leaseMs: number,
    now = new Date(),
  ): readonly ClaimedDagNode[] {
    const owner = requiredText(workerId, 'DAG worker id')
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('DAG claim limit must be 1-32')
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error('DAG lease must be at least 1000ms')
    const claimed: ClaimedDagNode[] = []
    this.transaction(() => {
      this.requireMutableRun(runId)
      const nowIso = now.toISOString()
      this.recoverExpiredLeases(runId, nowIso)
      this.promoteReadyNodes(runId)
      const runningScopes = this.runningWriteScopes(runId)
      for (const row of this.nodeRows(runId).filter((node) => node.status === 'ready')) {
        if (claimed.length >= limit) break
        const node = nodeFromRow(row)
        if (scopesConflict(node.writeScopes, runningScopes.flat())) continue
        const attempt = node.attempt + 1
        const result = this.db.prepare(`
          UPDATE dag_nodes
          SET status = 'running', attempt = ?, started_at = ?, completed_at = NULL,
              progress = 'Running', result = NULL, error = NULL
          WHERE run_id = ? AND id = ? AND status = 'ready'
        `).run(attempt, nowIso, runId, node.id)
        if (Number(result.changes) !== 1) continue
        const expiresAt = new Date(now.getTime() + leaseMs).toISOString()
        this.db.prepare(`
          INSERT INTO dag_leases (run_id, node_id, owner, expires_at, acquired_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(runId, node.id, owner, expiresAt, nowIso)
        this.db.prepare(`
          INSERT INTO dag_node_attempts (run_id, node_id, attempt, worker_id, status, started_at)
          VALUES (?, ?, ?, ?, 'running', ?)
        `).run(runId, node.id, attempt, owner, nowIso)
        this.recordEvent(runId, 'lease', `Node claimed by ${owner} for attempt ${attempt}`, node.id, nowIso)
        runningScopes.push([...node.writeScopes])
        claimed.push({ ...node, status: 'running', attempt, startedAt: nowIso, progress: 'Running', leaseGeneration: attempt })
      }
    })
    return claimed
  }

  attachChildSession(runId: string, nodeId: string, workerId: string, childSessionId: string, now = new Date().toISOString(), leaseGeneration?: number): void {
    this.transaction(() => {
      this.requireMutableRun(runId)
      this.assertLease(runId, nodeId, workerId, now, leaseGeneration)
      const result = this.db.prepare(`
        UPDATE dag_nodes SET child_session_id = ? WHERE run_id = ? AND id = ? AND status = 'running'
      `).run(requiredText(childSessionId, 'DAG child session id'), runId, nodeId)
      if (Number(result.changes) !== 1) throw new Error('DAG child session requires a running node')
    })
  }

  updateNodeProgress(runId: string, nodeId: string, workerId: string, progress: string, now = new Date().toISOString(), leaseGeneration?: number): DagRun {
    this.transaction(() => {
      this.requireMutableRun(runId)
      this.assertLease(runId, nodeId, workerId, now, leaseGeneration)
      const normalized = requiredText(progress, 'DAG node progress')
      const result = this.db.prepare(`
        UPDATE dag_nodes SET progress = ? WHERE run_id = ? AND id = ? AND status = 'running'
      `).run(normalized, runId, nodeId)
      if (Number(result.changes) !== 1) throw new Error('DAG progress requires a running node')
      this.recordEvent(runId, 'node', `Progress: ${normalized}`, nodeId, now)
    })
    return this.requireRun(runId)
  }

  renewLease(runId: string, nodeId: string, workerId: string, leaseMs: number, now = new Date(), leaseGeneration?: number): void {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error('DAG lease must be at least 1000ms')
    this.transaction(() => {
      this.requireMutableRun(runId)
      this.assertLease(runId, nodeId, workerId, now.toISOString(), leaseGeneration)
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString()
      const result = this.db.prepare(`
        UPDATE dag_leases SET expires_at = ? WHERE run_id = ? AND node_id = ? AND owner = ?
      `).run(expiresAt, runId, nodeId, workerId)
      if (Number(result.changes) !== 1) throw new Error('DAG node lease could not be renewed')
    })
  }

  completeNode(
    runId: string,
    nodeId: string,
    workerId: string,
    outcome: (
      | { status: 'succeeded'; result: string }
      | { status: 'failed' | 'cancelled'; error: string }
    ) & { toolActivity?: readonly DagToolActivity[] },
    operationId: string,
    now = new Date().toISOString(),
    leaseGeneration?: number,
  ): DagRun {
    const existing = this.operationResult(operationId, 'complete_node', runId)
    if (existing) return this.requireRun(existing)
    this.transaction(() => {
      this.requireMutableRun(runId)
      this.assertLease(runId, nodeId, workerId, now, leaseGeneration)
      const node = this.requireNode(runId, nodeId)
      assertNodeTransition(node.status, outcome.status)
      const completed = this.db.prepare(`
        UPDATE dag_nodes
        SET status = ?, progress = ?, result = ?, error = ?, completed_at = ?, tool_activity = ?
        WHERE run_id = ? AND id = ? AND status = 'running'
      `).run(
        outcome.status,
        outcome.status === 'succeeded' ? 'Completed' : 'Stopped',
        outcome.status === 'succeeded' ? requiredText(outcome.result, 'DAG node result') : null,
        outcome.status === 'succeeded' ? null : requiredText(outcome.error, 'DAG node error'),
        now,
        JSON.stringify(outcome.toolActivity ?? []),
        runId,
        nodeId,
      )
      if (Number(completed.changes) !== 1) throw new Error('DAG node completion lost its status fence')
      this.db.prepare('DELETE FROM dag_leases WHERE run_id = ? AND node_id = ? AND owner = ?').run(runId, nodeId, workerId)
      this.settleAttempt(
        runId,
        nodeId,
        node.attempt,
        outcome.status,
        now,
        outcome.status === 'succeeded' ? outcome.result : undefined,
        outcome.status === 'succeeded' ? undefined : outcome.error,
      )
      this.recordEvent(runId, 'node', `Node ${outcome.status}`, nodeId, now)
      if (outcome.status === 'failed' || outcome.status === 'cancelled') this.cancelBlockedDescendants(runId, nodeId, now)
      this.promoteReadyNodes(runId)
      this.settleRun(runId, now)
      this.recordOperation(operationId, runId, 'complete_node', now)
    })
    return this.requireRun(runId)
  }

  createDecision(
    input: Omit<DagDecision, 'status' | 'createdAt'> & { workerId: string; createdAt?: string; leaseGeneration?: number },
  ): DagDecision {
    const createdAt = input.createdAt ?? new Date().toISOString()
    let rejectedReason: string | undefined
    this.transaction(() => {
      this.requireMutableRun(input.runId)
      this.assertLease(input.runId, input.nodeId, input.workerId, createdAt, input.leaseGeneration)
      const node = this.requireNode(input.runId, input.nodeId)
      if (node.status !== 'running') throw new Error('DAG decisions require a running node')
      const decisionCount = Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM dag_decisions WHERE run_id = ? AND node_id = ?
      `).get(input.runId, input.nodeId) as { count: number }).count)
      if (decisionCount >= MAX_DAG_DECISIONS_PER_NODE) {
        rejectedReason = `DAG node exceeded the ${MAX_DAG_DECISIONS_PER_NODE}-decision safety limit`
        this.db.prepare(`
          UPDATE dag_nodes
          SET status = 'failed', progress = 'Stopped', error = ?, completed_at = ?
          WHERE run_id = ? AND id = ? AND status = 'running'
        `).run(rejectedReason, createdAt, input.runId, input.nodeId)
        this.db.prepare('DELETE FROM dag_leases WHERE run_id = ? AND node_id = ? AND owner = ?')
          .run(input.runId, input.nodeId, input.workerId)
        this.settleAttempt(input.runId, input.nodeId, node.attempt, 'failed', createdAt, undefined, rejectedReason)
        this.recordEvent(input.runId, 'decision', rejectedReason, input.nodeId, createdAt)
        this.cancelBlockedDescendants(input.runId, input.nodeId, createdAt)
        this.promoteReadyNodes(input.runId)
        this.settleRun(input.runId, createdAt)
        return
      }
      this.db.prepare(`
        INSERT INTO dag_decisions (
          id, run_id, node_id, question, context, choices, allow_freeform, recommendation,
          reason, risk_level, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        input.id,
        input.runId,
        input.nodeId,
        requiredText(input.question, 'DAG decision question'),
        input.context,
        JSON.stringify(input.choices),
        input.allowFreeform ? 1 : 0,
        input.recommendation ?? null,
        input.reason ?? null,
        input.riskLevel ?? null,
        createdAt,
      )
      this.db.prepare(`
        UPDATE dag_nodes SET status = 'waiting_user', progress = 'Waiting for a decision'
        WHERE run_id = ? AND id = ? AND status = 'running'
      `).run(input.runId, input.nodeId)
      this.db.prepare('DELETE FROM dag_leases WHERE run_id = ? AND node_id = ? AND owner = ?')
        .run(input.runId, input.nodeId, input.workerId)
      this.settleAttempt(input.runId, input.nodeId, node.attempt, 'waiting_user', createdAt)
      this.recordEvent(input.runId, 'decision', 'Decision requested; worker lease released', input.nodeId, createdAt)
    })
    if (rejectedReason) throw new Error(rejectedReason)
    return this.requireRun(input.runId).decisions.find((decision) => decision.id === input.id)!
  }

  answerDecision(runId: string, decisionId: string, answer: string, operationId: string, now = new Date().toISOString()): DagRun {
    const existing = this.operationResult(operationId, 'answer_decision', runId)
    if (existing) return this.requireRun(existing)
    this.transaction(() => {
      this.requireMutableRun(runId)
      const decision = this.db.prepare(`
        SELECT node_id AS nodeId, status FROM dag_decisions WHERE run_id = ? AND id = ?
      `).get(runId, decisionId) as { nodeId: string; status: string } | undefined
      if (!decision) throw new Error('DAG decision does not exist')
      if (decision.status !== 'pending') throw new Error('DAG decision is already settled')
      const node = this.requireNode(runId, decision.nodeId)
      if (node.status !== 'waiting_user') throw new Error('DAG decision node is not waiting for input')
      this.db.prepare(`
        UPDATE dag_decisions SET status = 'answered', answer = ?, answered_at = ? WHERE run_id = ? AND id = ?
      `).run(requiredText(answer, 'DAG decision answer'), now, runId, decisionId)
      this.db.prepare(`
        UPDATE dag_nodes SET status = 'ready', progress = 'Decision answered'
        WHERE run_id = ? AND id = ? AND status = 'waiting_user'
      `).run(runId, decision.nodeId)
      this.recordEvent(runId, 'decision', 'Decision answered; node ready to rerun', decision.nodeId, now)
      this.recordOperation(operationId, runId, 'answer_decision', now)
    })
    return this.requireRun(runId)
  }

  latestAnsweredDecision(runId: string, nodeId: string): DagDecision | undefined {
    const row = this.db.prepare(`
      SELECT * FROM dag_decisions
      WHERE run_id = ? AND node_id = ? AND status = 'answered'
      ORDER BY answered_at DESC, rowid DESC LIMIT 1
    `).get(runId, nodeId) as Record<string, unknown> | undefined
    return row ? decisionFromRow(row) : undefined
  }

  private hydrate(row: RunRow): DagRun {
    const decisions = this.db.prepare('SELECT * FROM dag_decisions WHERE run_id = ? ORDER BY created_at, id')
      .all(row.id) as Array<Record<string, unknown>>
    const events = this.db.prepare('SELECT id, run_id, type, message, node_id, created_at FROM dag_events WHERE run_id = ? ORDER BY id')
      .all(row.id) as Array<Record<string, unknown>>
    const attempts = this.db.prepare('SELECT * FROM dag_node_attempts WHERE run_id = ? ORDER BY id')
      .all(row.id) as Array<Record<string, unknown>>
    const history = this.db.prepare('SELECT * FROM dag_graph_versions WHERE run_id = ? ORDER BY version')
      .all(row.id) as Array<Record<string, unknown>>
    return {
      id: row.id,
      parentSessionId: row.parent_session_id,
      objective: row.objective,
      status: row.status,
      graphVersion: row.graph_version,
      ...(row.result_node_id ? { resultNodeId: row.result_node_id } : {}),
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodes: this.nodeRows(row.id).map(nodeFromRow),
      edges: this.edgeRows(row.id).map(edgeFromRow),
      decisions: decisions.map(decisionFromRow),
      events: events.map(eventFromRow),
      attempts: attempts.map(attemptFromRow),
      graphHistory: history.map(graphVersionFromRow),
    }
  }

  private promoteReadyNodes(runId: string): void {
    const nodes = this.nodeRows(runId).map(nodeFromRow)
    const edges = this.edgeRows(runId).map(edgeFromRow)
    for (const nodeId of readyNodeIds(nodes, edges)) {
      this.db.prepare(`
        UPDATE dag_nodes SET status = 'ready', progress = 'Ready'
        WHERE run_id = ? AND id = ? AND status = 'pending'
      `).run(runId, nodeId)
    }
  }

  private recoverExpiredLeases(runId: string, now: string): void {
    const expired = this.db.prepare(`
      SELECT l.node_id AS nodeId, n.attempt
      FROM dag_leases l
      JOIN dag_nodes n ON n.run_id = l.run_id AND n.id = l.node_id
      WHERE l.run_id = ? AND l.expires_at <= ?
    `).all(runId, now) as Array<{ nodeId: string; attempt: number }>
    for (const lease of expired) {
      this.db.prepare(`
        UPDATE dag_nodes SET status = 'ready', progress = 'Recovered after worker lease expired'
        WHERE run_id = ? AND id = ? AND status = 'running'
      `).run(runId, lease.nodeId)
      this.settleAttempt(runId, lease.nodeId, lease.attempt, 'interrupted', now, undefined, 'Worker lease expired')
      this.recordEvent(runId, 'lease', 'Expired worker lease recovered', lease.nodeId, now)
    }
    this.db.prepare('DELETE FROM dag_leases WHERE run_id = ? AND expires_at <= ?').run(runId, now)
  }

  private cancelBlockedDescendants(runId: string, nodeId: string, now: string): void {
    const edges = this.edgeRows(runId)
    const queue = [nodeId]
    const descendants = new Set<string>()
    while (queue.length > 0) {
      const source = queue.shift()!
      for (const edge of edges.filter((candidate) => candidate.source === source)) {
        if (descendants.has(edge.target)) continue
        descendants.add(edge.target)
        queue.push(edge.target)
      }
    }
    for (const descendant of descendants) {
      const result = this.db.prepare(`
        UPDATE dag_nodes
        SET status = 'cancelled', progress = 'Cancelled because a dependency failed', error = 'Blocked by failed dependency', completed_at = ?
        WHERE run_id = ? AND id = ? AND status IN ('pending', 'ready')
      `).run(now, runId, descendant)
      if (Number(result.changes) === 1) {
        this.recordEvent(runId, 'node', 'Node cancelled because a dependency failed', descendant, now)
      }
    }
  }

  private settleRun(runId: string, now: string): void {
    const run = this.requireRunRow(runId)
    if (run.status !== 'running') return
    const nodes = this.nodeRows(runId).map(nodeFromRow).filter((node) => node.status !== 'replaced')
    const live = nodes.some((node) => ['pending', 'ready', 'running', 'waiting_user'].includes(node.status))
    if (live || nodes.length === 0) return
    const status: DagRunStatus = nodes.some((node) => node.status === 'failed') ? 'failed' : 'completed'
    const resultNode = nodes.find((node) => node.id === run.result_node_id)
    if (!resultNode) throw new Error('DAG result node is unavailable at settlement')
    const runResult = status === 'completed' ? requiredText(resultNode.result ?? '', 'DAG run result') : null
    const runError = status === 'completed'
      ? null
      : resultNode.error ?? nodes.find((node) => node.status === 'failed')?.error ?? 'DAG run failed'
    const result = this.db.prepare(`
      UPDATE dag_runs
      SET status = ?, result = ?, error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(status, runResult, runError, now, now, runId)
    if (Number(result.changes) !== 1) throw new Error('DAG run settlement lost its status fence')
    this.recordEvent(runId, 'run', `DAG run ${status}`, undefined, now)
  }

  private recordGraphVersion(runId: string, version: number, createdAt: string): void {
    const nodes: DagGraphVersionNode[] = this.nodeRows(runId)
      .filter((node) => node.status !== 'replaced')
      .map((node) => ({
        id: node.id,
        title: node.title,
        instructions: node.instructions,
        depth: node.depth,
        writeScopes: parseStringArray(node.write_scopes),
        ...(node.estimated_duration_minutes === null ? {} : { estimatedDurationMinutes: node.estimated_duration_minutes }),
      }))
    const edges = this.edgeRows(runId).map(({ source, target }) => ({ source, target }))
    const resultNodeId = requiredText(this.requireRunRow(runId).result_node_id ?? '', 'DAG result node id')
    this.db.prepare(`
      INSERT INTO dag_graph_versions (run_id, version, result_node_id, nodes, edges, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, version, resultNodeId, JSON.stringify(nodes), JSON.stringify(edges), createdAt)
  }

  private settleAttempt(
    runId: string,
    nodeId: string,
    attempt: number,
    status: Exclude<DagNodeAttemptStatus, 'running'>,
    completedAt: string,
    result?: string,
    error?: string,
  ): void {
    const updated = this.db.prepare(`
      UPDATE dag_node_attempts
      SET status = ?, completed_at = ?, result = ?, error = ?
      WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'running'
    `).run(status, completedAt, result ?? null, error ?? null, runId, nodeId, attempt)
    if (Number(updated.changes) !== 1) throw new Error('DAG node attempt could not be settled')
  }

  private runningWriteScopes(runId: string): string[][] {
    return this.nodeRows(runId)
      .filter((node) => node.status === 'running')
      .map((node) => parseStringArray(node.write_scopes))
  }

  private assertLease(runId: string, nodeId: string, owner: string, now: string, generation?: number): void {
    const lease = this.db.prepare(`
      SELECT owner, expires_at AS expiresAt FROM dag_leases WHERE run_id = ? AND node_id = ?
    `).get(runId, nodeId) as { owner: string; expiresAt: string } | undefined
    if (!lease || lease.owner !== owner) throw new Error('DAG node lease is not owned by this worker')
    if (generation !== undefined && this.requireNode(runId, nodeId).attempt !== generation) {
      throw new Error('DAG node lease was fenced by a newer generation')
    }
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) throw new Error('DAG node lease has expired')
  }

  private requireRun(id: string): DagRun {
    const run = this.getRun(id)
    if (!run) throw new Error(`Unknown DAG run: ${id}`)
    return run
  }

  private requireRunRow(id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM dag_runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw new Error(`Unknown DAG run: ${id}`)
    return row
  }

  private requireMutableRun(id: string): RunRow {
    const run = this.requireRunRow(id)
    if (run.status !== 'running') throw new Error(`DAG run is not mutable while ${run.status}`)
    return run
  }

  private requireNode(runId: string, nodeId: string): DagNode {
    const row = this.db.prepare('SELECT * FROM dag_nodes WHERE run_id = ? AND id = ?').get(runId, nodeId) as NodeRow | undefined
    if (!row) throw new Error(`Unknown DAG node: ${nodeId}`)
    return nodeFromRow(row)
  }

  private nodeRows(runId: string): NodeRow[] {
    return this.db.prepare('SELECT * FROM dag_nodes WHERE run_id = ? ORDER BY rowid').all(runId) as NodeRow[]
  }

  private edgeRows(runId: string): EdgeRow[] {
    return this.db.prepare('SELECT id, run_id, source, target FROM dag_edges WHERE run_id = ? ORDER BY rowid')
      .all(runId) as EdgeRow[]
  }

  private insertEdges(runId: string, edges: readonly DagPlanEdgeInput[]): void {
    const insert = this.db.prepare('INSERT INTO dag_edges (id, run_id, source, target) VALUES (?, ?, ?, ?)')
    for (const edge of edges) insert.run(randomUUID(), runId, edge.source, edge.target)
  }

  private recordEvent(runId: string, type: DagEvent['type'], message: string, nodeId: string | undefined, createdAt: string): void {
    this.db.prepare(`
      INSERT INTO dag_events (run_id, type, message, node_id, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(runId, type, message, nodeId ?? null, createdAt)
  }

  private operationResult(operationId: string, expectedKind: string, expectedRunId?: string): string | undefined {
    const id = requiredText(operationId, 'DAG operation id')
    const row = this.db.prepare('SELECT run_id AS runId, kind FROM dag_operations WHERE operation_id = ?')
      .get(id) as { runId: string; kind: string } | undefined
    if (!row) return undefined
    if (row.kind !== expectedKind || (expectedRunId !== undefined && row.runId !== expectedRunId)) {
      throw new Error('DAG operation id was already used for a different operation')
    }
    return row.runId
  }

  private recordOperation(operationId: string, runId: string, kind: string, createdAt: string): void {
    this.db.prepare(`
      INSERT INTO dag_operations (operation_id, run_id, kind, created_at) VALUES (?, ?, ?, ?)
    `).run(requiredText(operationId, 'DAG operation id'), runId, kind, createdAt)
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function nodeFromRow(row: NodeRow): DagNode {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    depth: row.depth,
    writeScopes: parseStringArray(row.write_scopes),
    ...(row.estimated_duration_minutes === null ? {} : { estimatedDurationMinutes: row.estimated_duration_minutes }),
    attempt: row.attempt,
    ...(row.child_session_id ? { childSessionId: row.child_session_id } : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.replaced_by ? { replacedBy: row.replaced_by } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    toolActivity: parseToolActivity(row.tool_activity),
  }
}

function edgeFromRow(row: EdgeRow): DagEdge {
  return { id: row.id, runId: row.run_id, source: row.source, target: row.target }
}

function decisionFromRow(row: Record<string, unknown>): DagDecision {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    question: String(row.question),
    context: String(row.context),
    choices: parseStringArray(String(row.choices)),
    allowFreeform: row.allow_freeform === 1,
    ...(row.recommendation ? { recommendation: String(row.recommendation) } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.risk_level ? { riskLevel: row.risk_level as DagDecision['riskLevel'] } : {}),
    status: row.status as DagDecision['status'],
    ...(row.answer ? { answer: String(row.answer) } : {}),
    createdAt: String(row.created_at),
    ...(row.answered_at ? { answeredAt: String(row.answered_at) } : {}),
  }
}

function eventFromRow(row: Record<string, unknown>): DagEvent {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    type: row.type as DagEvent['type'],
    message: String(row.message),
    ...(row.node_id ? { nodeId: String(row.node_id) } : {}),
    createdAt: String(row.created_at),
  }
}

function attemptFromRow(row: Record<string, unknown>): DagNodeAttempt {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    attempt: Number(row.attempt),
    workerId: String(row.worker_id),
    status: row.status as DagNodeAttemptStatus,
    startedAt: String(row.started_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.result ? { result: String(row.result) } : {}),
    ...(row.error ? { error: String(row.error) } : {}),
  }
}

function graphVersionFromRow(row: Record<string, unknown>): DagGraphVersion {
  return {
    runId: String(row.run_id),
    version: Number(row.version),
    resultNodeId: String(row.result_node_id),
    nodes: parseJsonArray<DagGraphVersionNode>(String(row.nodes), 'DAG graph version nodes'),
    edges: parseJsonArray<DagPlanEdgeInput>(String(row.edges), 'DAG graph version edges'),
    createdAt: String(row.created_at),
  }
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new Error('Invalid DAG string array')
  return parsed
}

function parseJsonArray<T>(value: string, label: string): T[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error(`Invalid ${label}`)
  return parsed as T[]
}

function parseToolActivity(value: string): DagToolActivity[] {
  const parsed = parseJsonArray<DagToolActivity>(value, 'DAG tool activity')
  return parsed.filter((entry) =>
    entry
    && typeof entry.callId === 'string'
    && typeof entry.name === 'string'
    && typeof entry.summary === 'string',
  )
}

function normalizedScopes(scopes: readonly string[]): string[] {
  const unique = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))]
  for (const scope of unique) scopesConflict([scope], [scope])
  return unique
}

function normalizedEstimate(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isInteger(value) || value < 0) throw new Error('DAG estimated duration must be a non-negative integer')
  return value
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function validatePatch(patch: DagGraphPatch): void {
  if (!Number.isInteger(patch.expectedGraphVersion) || patch.expectedGraphVersion < 0) {
    throw new Error('DAG expected graph version must be a non-negative integer')
  }
  if (patch.nodes.length === 0 || patch.nodes.length > MAX_GRAPH_NODES) {
    throw new Error(`DAG graph must contain 1-${MAX_GRAPH_NODES} nodes`)
  }
  if (patch.edges.length > MAX_GRAPH_EDGES) throw new Error(`DAG graph cannot exceed ${MAX_GRAPH_EDGES} edges`)
  assertDag(patch.nodes.map((node) => node.id), patch.edges)
  if (!patch.nodes.some((node) => node.id === patch.resultNodeId)) {
    throw new Error('DAG result node must identify a graph node')
  }
  if (patch.edges.some((edge) => edge.source === patch.resultNodeId)) {
    throw new Error('DAG result node must be terminal')
  }
}

function uniqueEdges(edges: readonly DagPlanEdgeInput[]): DagPlanEdgeInput[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.source}\u0000${edge.target}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function graphDepths(nodeIds: readonly string[], edges: readonly DagPlanEdgeInput[]): Map<string, number> {
  const depths = new Map(nodeIds.map((id) => [id, 0]))
  const remaining = new Set(nodeIds)
  while (remaining.size > 0) {
    let changed = false
    for (const id of remaining) {
      const incoming = edges.filter((edge) => edge.target === id)
      if (incoming.some((edge) => remaining.has(edge.source))) continue
      depths.set(id, incoming.length === 0 ? 0 : Math.max(...incoming.map((edge) => depths.get(edge.source) ?? 0)) + 1)
      remaining.delete(id)
      changed = true
    }
    if (!changed) throw new Error('DAG depth calculation failed')
  }
  return depths
}
