import { randomUUID } from 'node:crypto'

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
  DagPlanEdgeInput,
  DagRun,
  DagRunStatus,
  DagToolActivity,
} from '@agent-kernel/shared'

import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import type { HotStateDatabase, HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import {
  assertResourceOwner,
  RuntimeResourceOwnershipFencedError,
  type RuntimeResourceOwnership,
} from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { assertDag, assertNodeTransition, assertSingleEntryReachability, readyNodeIds, scopesConflict } from './graph.js'
import { MAX_DAG_DECISIONS_PER_NODE } from './store.js'
import type { ClaimedDagNode, DagStorage } from './storage.js'

const MAX_GRAPH_NODES = 100
const MAX_GRAPH_EDGES = 500
const UNKNOWN_EFFECT_ERROR = 'Worker lease expired while node side effects may have occurred; automatic retry is blocked because the execution outcome is unknown'

type MutableRun = Omit<DagRun, 'nodes' | 'edges' | 'decisions' | 'events' | 'attempts' | 'graphHistory'> & {
  nodes: DagNode[]
  edges: DagEdge[]
  decisions: DagDecision[]
  events: DagEvent[]
  attempts: DagNodeAttempt[]
  graphHistory: DagGraphVersion[]
}
type Lease = { owner: string; generation: number; expiresAt: string; acquiredAt: string }
type Operation = { runId: string; kind: string; createdAt: string }
type PersistedDagState = {
  runs: MutableRun[]
  leases: Record<string, Lease>
  operations: Record<string, Operation>
  nextEventId: number
  nextAttemptId: number
}
type StateRow = Record<string, unknown> & { state: PersistedDagState }

/** PostgreSQL DAG authority bound to one trusted tenant and unit namespace. */
export class PostgresDagStore implements DagStorage {
  readonly #table: string
  readonly #schema: string
  readonly #schemaManagement: PostgresSchemaManagement
  readonly #prepareSessionOwner?: (sessionId: string) => Promise<void>
  readonly #resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined
  #ready: Promise<void> | undefined

  constructor(
    readonly database: HotStateDatabase,
    readonly tenantId: string,
    readonly unitId: string,
    options: { schema?: string; schemaManagement?: PostgresSchemaManagement;
      prepareSessionOwner?: (sessionId: string) => Promise<void>;
      resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined } = {},
  ) {
    requiredText(tenantId, 'DAG tenant id')
    requiredText(unitId, 'DAG unit id')
    this.#schema = options.schema ?? 'public'
    this.#table = `${quoteIdentifier(this.#schema)}.tenant_dag_state`
    this.#schemaManagement = options.schemaManagement ?? 'initialize'
    this.#prepareSessionOwner = options.prepareSessionOwner
    this.#resourceOwnerForSession = options.resourceOwnerForSession
    if (Boolean(this.#prepareSessionOwner) !== Boolean(this.#resourceOwnerForSession)) {
      throw new TypeError('DAG Session owner requires both prepare and live lease provider')
    }
  }

  initialize(): Promise<void> {
    if (this.#schemaManagement === 'external') return Promise.resolve()
    return this.#ready ??= this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      tenant_id text NOT NULL,
      unit_id text NOT NULL,
      state jsonb NOT NULL,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, unit_id),
      CHECK (jsonb_typeof(state) = 'object')
    )`).then(() => undefined)
  }

  async createRun(parentSessionId: string, objective: string, operationId: string, now = new Date().toISOString()): Promise<DagRun> {
    const parent = requiredText(parentSessionId, 'DAG parent session id')
    const normalizedObjective = requiredText(objective, 'DAG objective')
    return await this.#mutate({ parentSessionId: parent }, (state) => {
      const prior = operationResult(state, operationId, 'create_run')
      if (prior) {
        const run = requireRun(state, prior)
        if (run.parentSessionId !== parent || run.objective !== normalizedObjective) throw new Error('DAG operation id was already used for a different run')
        return clone(run)
      }
      const run: MutableRun = {
        id: randomUUID(), parentSessionId: parent, objective: normalizedObjective, status: 'planning', graphVersion: 0,
        createdAt: now, updatedAt: now, nodes: [], edges: [], decisions: [], events: [], attempts: [], graphHistory: [],
      }
      state.runs.push(run)
      event(state, run, 'run', 'DAG run created', undefined, now)
      operation(state, operationId, run.id, 'create_run', now)
      return clone(run)
    })
  }

  async runForSession(parentSessionId: string): Promise<DagRun | undefined> {
    const state = await this.#read()
    const runs = state.runs.filter((run) => run.parentSessionId === parentSessionId)
    return clone(runs.sort(compareCreated).at(-1))
  }

  async runsForSession(parentSessionId: string): Promise<readonly DagRun[]> {
    const state = await this.#read()
    return clone(state.runs.filter((run) => run.parentSessionId === parentSessionId).sort(compareCreated))
  }

  async activeParentSessionIds(): Promise<readonly string[]> {
    const state = await this.#read()
    const first = new Map<string, string>()
    for (const run of state.runs) {
      if (!['planning', 'running', 'paused'].includes(run.status)) continue
      const existing = first.get(run.parentSessionId)
      if (!existing || run.createdAt < existing) first.set(run.parentSessionId, run.createdAt)
    }
    return [...first].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id)
  }

  async getRun(runId: string): Promise<DagRun | undefined> {
    return clone((await this.#read()).runs.find((run) => run.id === runId))
  }

  async installGraph(runId: string, patch: DagGraphPatch, operationId: string, now = new Date().toISOString()): Promise<DagRun> {
    return await this.#mutate({ runId }, (state) => {
      const prior = operationResult(state, operationId, 'install_graph', runId)
      if (prior) return clone(requireRun(state, prior))
      validatePatch(patch)
      const run = requireRun(state, runId)
      if (run.status !== 'planning' || run.graphVersion !== 0 || patch.expectedGraphVersion !== 0) {
        throw new Error('DAG initial graph can only be installed on a planning run at version 0')
      }
      const depths = graphDepths(patch.nodes.map((node) => node.id), patch.edges)
      run.nodes.push(...patch.nodes.map((node): DagNode => ({
        id: node.id, runId, title: requiredText(node.title, 'DAG node title'), instructions: requiredText(node.instructions, 'DAG node instructions'),
        status: 'pending', depth: depths.get(node.id) ?? 0, writeScopes: normalizedScopes(node.writeScopes ?? []),
        ...(node.estimatedDurationMinutes === undefined ? {} : { estimatedDurationMinutes: normalizedEstimate(node.estimatedDurationMinutes) }),
        attempt: 0, toolActivity: [],
      })))
      insertEdges(run, patch.edges)
      run.status = 'running'
      run.graphVersion = 1
      run.resultNodeId = patch.resultNodeId
      run.updatedAt = now
      promoteReady(run)
      graphVersion(run, now)
      event(state, run, 'graph', 'Graph version 1 installed', undefined, now)
      operation(state, operationId, runId, 'install_graph', now)
      return clone(run)
    })
  }

  replaceGraph(runId: string, patch: DagGraphPatch, operationId: string, now?: string): Promise<DagRun> {
    return this.installGraph(runId, patch, operationId, now)
  }

  async expandNode(runId: string, nodeId: string, workerId: string, patch: DagGraphPatch, operationId: string, now = new Date().toISOString(), leaseGeneration?: number): Promise<DagRun> {
    return await this.#mutate({ runId }, (state) => {
      const prior = operationResult(state, operationId, 'expand_node', runId)
      if (prior) return clone(requireRun(state, prior))
      validatePatch(patch)
      const entryId = assertSingleEntryReachability(patch.nodes.map((node) => node.id), patch.edges)
      const run = requireMutableRun(state, runId)
      if (run.graphVersion !== patch.expectedGraphVersion) throw new Error('DAG graph version conflict')
      const original = requireNode(run, nodeId)
      if (original.status !== 'running') throw new Error('DAG graph expansion requires a running node')
      assertLease(state, run, nodeId, workerId, now, leaseGeneration)
      const allIds = new Set(run.nodes.map((node) => node.id))
      for (const node of patch.nodes) if (allIds.has(node.id)) throw new Error(`DAG node id already exists in run history: ${node.id}`)
      if (run.nodes.length + patch.nodes.length > MAX_GRAPH_NODES) throw new Error(`DAG run cannot exceed ${MAX_GRAPH_NODES} nodes`)
      const incoming = run.edges.filter((edge) => edge.target === nodeId)
      const outgoing = run.edges.filter((edge) => edge.source === nodeId)
      const sources = new Set(patch.edges.map((edge) => edge.source))
      const leaves = patch.nodes.map((node) => node.id).filter((id) => !sources.has(id))
      const retained = run.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId).map(({ source, target }) => ({ source, target }))
      const rewired = [
        ...incoming.map((edge) => ({ source: edge.source, target: entryId })),
        ...outgoing.flatMap((edge) => leaves.map((leaf) => ({ source: leaf, target: edge.target }))),
      ]
      const candidateEdges = uniqueEdges([...retained, ...patch.edges, ...rewired])
      const candidateIds = run.nodes.filter((node) => node.status !== 'replaced' && node.id !== nodeId).map((node) => node.id).concat(patch.nodes.map((node) => node.id))
      if (candidateEdges.length > MAX_GRAPH_EDGES) throw new Error(`DAG graph cannot exceed ${MAX_GRAPH_EDGES} edges`)
      assertDag(candidateIds, candidateEdges)
      run.edges = run.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
      run.nodes.push(...patch.nodes.map((node): DagNode => ({
        id: node.id, runId, title: requiredText(node.title, 'DAG node title'), instructions: requiredText(node.instructions, 'DAG node instructions'),
        status: 'pending', depth: original.depth + 1, writeScopes: normalizedScopes(node.writeScopes ?? []),
        ...(node.estimatedDurationMinutes === undefined ? {} : { estimatedDurationMinutes: normalizedEstimate(node.estimatedDurationMinutes) }),
        attempt: 0, toolActivity: [],
      })))
      insertEdges(run, uniqueEdges([...patch.edges, ...rewired]))
      original.status = 'replaced'; original.progress = 'Replaced by graph expansion'; original.replacedBy = entryId; original.completedAt = now
      delete state.leases[leaseKey(runId, nodeId)]
      settleAttempt(run, nodeId, original.attempt, 'replaced', now)
      run.graphVersion += 1
      if (run.resultNodeId === nodeId) run.resultNodeId = patch.resultNodeId
      run.updatedAt = now
      promoteReady(run); graphVersion(run, now)
      event(state, run, 'graph', `Node replaced by graph version ${run.graphVersion}`, nodeId, now)
      operation(state, operationId, runId, 'expand_node', now)
      return clone(run)
    })
  }

  async claimReadyNodes(runId: string, workerId: string, limit: number, leaseMs: number, now = new Date()): Promise<readonly ClaimedDagNode[]> {
    const owner = requiredText(workerId, 'DAG worker id')
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('DAG claim limit must be 1-32')
    validateLeaseMs(leaseMs)
    return await this.#mutate({ runId }, (state) => {
      const run = requireMutableRun(state, runId)
      const nowIso = now.toISOString()
      recoverExpiredLeases(state, run, nowIso)
      if (run.status !== 'running') return []
      promoteReady(run)
      const runningScopes = run.nodes.filter((node) => node.status === 'running').map((node) => node.writeScopes)
      const claimed: ClaimedDagNode[] = []
      for (const node of run.nodes.filter((candidate) => candidate.status === 'ready')) {
        if (claimed.length >= limit) break
        if (scopesConflict(node.writeScopes, runningScopes.flat())) continue
        node.status = 'running'; node.attempt += 1; node.startedAt = nowIso; delete node.completedAt
        node.progress = 'Running'; delete node.result; delete node.error
        const generation = node.attempt
        state.leases[leaseKey(runId, node.id)] = { owner, generation, acquiredAt: nowIso, expiresAt: new Date(now.getTime() + leaseMs).toISOString() }
        run.attempts.push({ id: state.nextAttemptId++, runId, nodeId: node.id, attempt: node.attempt, workerId: owner, status: 'running', startedAt: nowIso })
        event(state, run, 'lease', `Node claimed by ${owner} for attempt ${node.attempt}`, node.id, nowIso)
        runningScopes.push([...node.writeScopes])
        claimed.push({ ...clone(node), leaseGeneration: generation })
      }
      return claimed
    })
  }

  async attachChildSession(runId: string, nodeId: string, workerId: string, childSessionId: string, now = new Date().toISOString(), leaseGeneration?: number): Promise<void> {
    await this.#mutate({ runId }, (state) => {
      const run = requireMutableRun(state, runId); assertLease(state, run, nodeId, workerId, now, leaseGeneration)
      const node = requireNode(run, nodeId)
      if (node.status !== 'running') throw new Error('DAG child session requires a running node')
      node.childSessionId = requiredText(childSessionId, 'DAG child session id')
    })
  }

  async updateNodeProgress(runId: string, nodeId: string, workerId: string, progress: string, now = new Date().toISOString(), leaseGeneration?: number): Promise<DagRun> {
    return await this.#mutate({ runId }, (state) => {
      const run = requireMutableRun(state, runId); assertLease(state, run, nodeId, workerId, now, leaseGeneration)
      const node = requireNode(run, nodeId)
      if (node.status !== 'running') throw new Error('DAG progress requires a running node')
      node.progress = requiredText(progress, 'DAG node progress')
      event(state, run, 'node', `Progress: ${node.progress}`, nodeId, now)
      return clone(run)
    })
  }

  async renewLease(runId: string, nodeId: string, workerId: string, leaseMs: number, now = new Date(), leaseGeneration?: number): Promise<void> {
    validateLeaseMs(leaseMs)
    await this.#mutate({ runId }, (state) => {
      const run = requireMutableRun(state, runId); assertLease(state, run, nodeId, workerId, now.toISOString(), leaseGeneration)
      state.leases[leaseKey(runId, nodeId)]!.expiresAt = new Date(now.getTime() + leaseMs).toISOString()
    })
  }

  async completeNode(runId: string, nodeId: string, workerId: string, outcome: ({ status: 'succeeded'; result: string } | { status: 'failed' | 'cancelled'; error: string }) & { toolActivity?: readonly DagToolActivity[] }, operationId: string, now = new Date().toISOString(), leaseGeneration?: number): Promise<DagRun> {
    return await this.#mutate({ runId }, (state) => {
      const prior = operationResult(state, operationId, 'complete_node', runId)
      if (prior) return clone(requireRun(state, prior))
      const run = requireMutableRun(state, runId); assertLease(state, run, nodeId, workerId, now, leaseGeneration)
      const node = requireNode(run, nodeId); assertNodeTransition(node.status, outcome.status)
      node.status = outcome.status; node.progress = outcome.status === 'succeeded' ? 'Completed' : 'Stopped'; node.completedAt = now
      node.toolActivity = [...(outcome.toolActivity ?? [])]
      if (outcome.status === 'succeeded') { node.result = requiredText(outcome.result, 'DAG node result'); delete node.error }
      else { node.error = requiredText(outcome.error, 'DAG node error'); delete node.result }
      delete state.leases[leaseKey(runId, nodeId)]
      settleAttempt(run, nodeId, node.attempt, outcome.status, now, outcome.status === 'succeeded' ? outcome.result : undefined, outcome.status === 'succeeded' ? undefined : outcome.error)
      event(state, run, 'node', `Node ${outcome.status}`, nodeId, now)
      if (outcome.status !== 'succeeded') cancelDescendants(state, run, nodeId, now)
      promoteReady(run); settleRun(state, run, now)
      operation(state, operationId, runId, 'complete_node', now)
      return clone(run)
    })
  }

  async createDecision(input: Omit<DagDecision, 'status' | 'createdAt'> & { workerId: string; createdAt?: string; leaseGeneration?: number }): Promise<DagDecision> {
    const createdAt = input.createdAt ?? new Date().toISOString()
    return await this.#mutate({ runId: input.runId }, (state) => {
      const run = requireMutableRun(state, input.runId); assertLease(state, run, input.nodeId, input.workerId, createdAt, input.leaseGeneration)
      const node = requireNode(run, input.nodeId)
      if (node.status !== 'running') throw new Error('DAG decisions require a running node')
      if (run.decisions.filter((decision) => decision.nodeId === input.nodeId).length >= MAX_DAG_DECISIONS_PER_NODE) {
        const reason = `DAG node exceeded the ${MAX_DAG_DECISIONS_PER_NODE}-decision safety limit`
        node.status = 'failed'; node.progress = 'Stopped'; node.error = reason; node.completedAt = createdAt
        delete state.leases[leaseKey(run.id, node.id)]
        settleAttempt(run, node.id, node.attempt, 'failed', createdAt, undefined, reason)
        event(state, run, 'decision', reason, node.id, createdAt)
        cancelDescendants(state, run, node.id, createdAt); promoteReady(run); settleRun(state, run, createdAt)
        throw new DurableMutationError(reason, state)
      }
      if (run.decisions.some((decision) => decision.id === input.id)) throw new Error('DAG decision id already exists')
      const decision: DagDecision = {
        id: input.id, runId: input.runId, nodeId: input.nodeId, question: requiredText(input.question, 'DAG decision question'),
        context: input.context, choices: [...input.choices], allowFreeform: input.allowFreeform,
        ...(input.recommendation ? { recommendation: input.recommendation } : {}), ...(input.reason ? { reason: input.reason } : {}),
        ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}), status: 'pending', createdAt,
      }
      run.decisions.push(decision)
      node.status = 'waiting_user'; node.progress = 'Waiting for a decision'
      delete state.leases[leaseKey(run.id, node.id)]
      settleAttempt(run, node.id, node.attempt, 'waiting_user', createdAt)
      event(state, run, 'decision', 'Decision requested; worker lease released', node.id, createdAt)
      return clone(decision)
    })
  }

  async answerDecision(runId: string, decisionId: string, answer: string, operationId: string, now = new Date().toISOString()): Promise<DagRun> {
    return await this.#mutate({ runId }, (state) => {
      const prior = operationResult(state, operationId, 'answer_decision', runId)
      if (prior) return clone(requireRun(state, prior))
      const run = requireMutableRun(state, runId)
      const decision = run.decisions.find((candidate) => candidate.id === decisionId)
      if (!decision) throw new Error('DAG decision does not exist')
      if (decision.status !== 'pending') throw new Error('DAG decision is already settled')
      const node = requireNode(run, decision.nodeId)
      if (node.status !== 'waiting_user') throw new Error('DAG decision node is not waiting for input')
      decision.status = 'answered'; decision.answer = requiredText(answer, 'DAG decision answer'); decision.answeredAt = now
      node.status = 'ready'; node.progress = 'Decision answered'
      event(state, run, 'decision', 'Decision answered; node ready to rerun', node.id, now)
      operation(state, operationId, runId, 'answer_decision', now)
      return clone(run)
    })
  }

  async latestAnsweredDecision(runId: string, nodeId: string): Promise<DagDecision | undefined> {
    const run = (await this.#read()).runs.find((candidate) => candidate.id === runId)
    return clone(run?.decisions.filter((decision) => decision.nodeId === nodeId && decision.status === 'answered').sort((a, b) => (a.answeredAt ?? '').localeCompare(b.answeredAt ?? '')).at(-1))
  }

  async #read(): Promise<PersistedDagState> {
    await this.initialize()
    const result = await this.database.query<StateRow>(`SELECT state FROM ${this.#table} WHERE tenant_id = $1 AND unit_id = $2`, [this.tenantId, this.unitId])
    return normalizeState(result.rows[0]?.state)
  }

  async #mutate<T>(scope: { parentSessionId: string } | { runId: string }, work: (state: PersistedDagState) => T): Promise<T> {
    await this.initialize()
    if (this.#prepareSessionOwner) {
      const parentSessionId = 'parentSessionId' in scope
        ? scope.parentSessionId
        : (await this.#read()).runs.find((run) => run.id === scope.runId)?.parentSessionId
      if (parentSessionId) await this.#prepareSessionOwner(parentSessionId)
    }
    let durableError: DurableMutationError | undefined
    const result = await this.database.transaction(async (transaction) => {
      await transaction.query(`INSERT INTO ${this.#table} (tenant_id, unit_id, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`, [this.tenantId, this.unitId, JSON.stringify(emptyState())])
      const selected = await transaction.query<StateRow>(`SELECT state FROM ${this.#table} WHERE tenant_id = $1 AND unit_id = $2 FOR UPDATE`, [this.tenantId, this.unitId])
      const state = normalizeState(selected.rows[0]?.state)
      const parentSessionId = 'parentSessionId' in scope
        ? scope.parentSessionId
        : requireRun(state, scope.runId).parentSessionId
      await this.#assertSessionOwner(transaction, parentSessionId)
      let value: T | undefined
      try { value = work(state) } catch (error) {
        if (!(error instanceof DurableMutationError)) throw error
        durableError = error
      }
      await writeState(transaction, this.#table, this.tenantId, this.unitId, state)
      return value
    })
    if (durableError) throw new Error(durableError.message)
    return result as T
  }

  async #assertSessionOwner(transaction: HotStateSqlExecutor, sessionId: string): Promise<void> {
    if (!this.#resourceOwnerForSession) return
    const owner = this.#resourceOwnerForSession(sessionId)
    if (!owner) throw new RuntimeResourceOwnershipFencedError()
    if (owner.organizationId !== this.tenantId || owner.unitId !== this.unitId
      || owner.resourceType !== 'session' || owner.resourceId !== sessionId) {
      throw new TypeError('DAG Session owner must match its tenant, Unit, and parent Session')
    }
    await assertResourceOwner(transaction, owner, { schema: this.#schema })
  }
}

class DurableMutationError extends Error {
  constructor(message: string, readonly state: PersistedDagState) { super(message) }
}

function emptyState(): PersistedDagState { return { runs: [], leases: {}, operations: {}, nextEventId: 1, nextAttemptId: 1 } }
function normalizeState(value: PersistedDagState | undefined): PersistedDagState {
  if (!value || !Array.isArray(value.runs)) return emptyState()
  return { runs: value.runs, leases: value.leases ?? {}, operations: value.operations ?? {}, nextEventId: value.nextEventId ?? 1, nextAttemptId: value.nextAttemptId ?? 1 }
}
async function writeState(db: HotStateSqlExecutor, table: string, tenantId: string, unitId: string, state: PersistedDagState): Promise<void> {
  await db.query(`UPDATE ${table} SET state = $3::jsonb, revision = revision + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND unit_id = $2`, [tenantId, unitId, JSON.stringify(state)])
}
function operationResult(state: PersistedDagState, id: string, kind: string, runId?: string): string | undefined {
  const operationId = requiredText(id, 'DAG operation id'); const existing = state.operations[operationId]
  if (!existing) return undefined
  if (existing.kind !== kind || (runId !== undefined && existing.runId !== runId)) throw new Error('DAG operation id was already used for a different operation')
  return existing.runId
}
function operation(state: PersistedDagState, id: string, runId: string, kind: string, createdAt: string): void { state.operations[requiredText(id, 'DAG operation id')] = { runId, kind, createdAt } }
function requireRun(state: PersistedDagState, id: string): MutableRun { const run = state.runs.find((candidate) => candidate.id === id); if (!run) throw new Error(`Unknown DAG run: ${id}`); return run }
function requireMutableRun(state: PersistedDagState, id: string): MutableRun { const run = requireRun(state, id); if (run.status !== 'running') throw new Error(`DAG run is not mutable while ${run.status}`); return run }
function requireNode(run: MutableRun, id: string): DagNode { const node = run.nodes.find((candidate) => candidate.id === id); if (!node) throw new Error(`Unknown DAG node: ${id}`); return node }
function event(state: PersistedDagState, run: MutableRun, type: DagEvent['type'], message: string, nodeId: string | undefined, createdAt: string): void { run.events.push({ id: state.nextEventId++, runId: run.id, type, message, ...(nodeId ? { nodeId } : {}), createdAt }) }
function leaseKey(runId: string, nodeId: string): string { return JSON.stringify([runId, nodeId]) }
function assertLease(state: PersistedDagState, run: MutableRun, nodeId: string, owner: string, now: string, generation?: number): void {
  if (generation === undefined) throw new Error('DAG lease generation is required for PostgreSQL operations')
  const lease = state.leases[leaseKey(run.id, nodeId)]
  if (!lease || lease.owner !== owner) throw new Error('DAG node lease is not owned by this worker')
  if (lease.generation !== generation) throw new Error('DAG node lease was fenced by a newer generation')
  if (Date.parse(lease.expiresAt) <= Date.parse(now)) throw new Error('DAG node lease has expired')
}
function recoverExpiredLeases(state: PersistedDagState, run: MutableRun, now: string): void {
  for (const node of run.nodes) {
    const key = leaseKey(run.id, node.id); const lease = state.leases[key]
    if (!lease || Date.parse(lease.expiresAt) > Date.parse(now)) continue
    delete state.leases[key]
    if (node.status !== 'running') continue
    node.status = 'failed'; node.progress = 'Execution outcome unknown'; node.error = UNKNOWN_EFFECT_ERROR; node.completedAt = now
    settleAttempt(run, node.id, node.attempt, 'interrupted', now, undefined, UNKNOWN_EFFECT_ERROR)
    event(state, run, 'lease', UNKNOWN_EFFECT_ERROR, node.id, now)
    cancelDescendants(state, run, node.id, now)
  }
  settleRun(state, run, now)
}
function settleAttempt(run: MutableRun, nodeId: string, attempt: number, status: Exclude<DagNodeAttemptStatus, 'running'>, completedAt: string, result?: string, error?: string): void {
  const row = run.attempts.find((candidate) => candidate.nodeId === nodeId && candidate.attempt === attempt && candidate.status === 'running')
  if (!row) throw new Error('DAG node attempt could not be settled')
  row.status = status; row.completedAt = completedAt
  if (result !== undefined) row.result = result
  if (error !== undefined) row.error = error
}
function promoteReady(run: MutableRun): void { for (const id of readyNodeIds(run.nodes, run.edges)) { const node = requireNode(run, id); if (node.status === 'pending') { node.status = 'ready'; node.progress = 'Ready' } } }
function cancelDescendants(state: PersistedDagState, run: MutableRun, nodeId: string, now: string): void {
  const queue = [nodeId]; const descendants = new Set<string>()
  while (queue.length) { const source = queue.shift()!; for (const edge of run.edges.filter((candidate) => candidate.source === source)) if (!descendants.has(edge.target)) { descendants.add(edge.target); queue.push(edge.target) } }
  for (const id of descendants) { const node = requireNode(run, id); if (!['pending', 'ready'].includes(node.status)) continue; node.status = 'cancelled'; node.progress = 'Cancelled because a dependency failed'; node.error = 'Blocked by failed dependency'; node.completedAt = now; event(state, run, 'node', 'Node cancelled because a dependency failed', id, now) }
}
function settleRun(state: PersistedDagState, run: MutableRun, now: string): void {
  if (run.status !== 'running') return
  const nodes = run.nodes.filter((node) => node.status !== 'replaced')
  if (nodes.length === 0 || nodes.some((node) => ['pending', 'ready', 'running', 'waiting_user'].includes(node.status))) return
  const status: DagRunStatus = nodes.some((node) => node.status === 'failed') ? 'failed' : 'completed'
  const resultNode = nodes.find((node) => node.id === run.resultNodeId); if (!resultNode) throw new Error('DAG result node is unavailable at settlement')
  run.status = status; run.completedAt = now; run.updatedAt = now
  if (status === 'completed') run.result = requiredText(resultNode.result ?? '', 'DAG run result')
  else run.error = resultNode.error ?? nodes.find((node) => node.status === 'failed')?.error ?? 'DAG run failed'
  event(state, run, 'run', `DAG run ${status}`, undefined, now)
}
function graphVersion(run: MutableRun, createdAt: string): void {
  const nodes: DagGraphVersionNode[] = run.nodes.filter((node) => node.status !== 'replaced').map((node) => ({ id: node.id, title: node.title, instructions: node.instructions, depth: node.depth, writeScopes: [...node.writeScopes], ...(node.estimatedDurationMinutes === undefined ? {} : { estimatedDurationMinutes: node.estimatedDurationMinutes }) }))
  run.graphHistory.push({ runId: run.id, version: run.graphVersion, resultNodeId: requiredText(run.resultNodeId ?? '', 'DAG result node id'), nodes, edges: run.edges.map(({ source, target }) => ({ source, target })), createdAt })
}
function insertEdges(run: MutableRun, edges: readonly DagPlanEdgeInput[]): void { run.edges.push(...edges.map((edge): DagEdge => ({ id: randomUUID(), runId: run.id, source: edge.source, target: edge.target }))) }
function compareCreated(a: DagRun, b: DagRun): number { return a.createdAt.localeCompare(b.createdAt) }
function clone<T>(value: T): T { return value === undefined ? value : structuredClone(value) }
function requiredText(value: string, label: string): string { const text = value.trim(); if (!text) throw new Error(`${label} is required`); return text }
function validateLeaseMs(value: number): void { if (!Number.isInteger(value) || value < 1_000) throw new Error('DAG lease must be at least 1000ms') }
function normalizedScopes(scopes: readonly string[]): string[] { const unique = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))]; for (const scope of unique) scopesConflict([scope], [scope]); return unique }
function normalizedEstimate(value: number): number { if (!Number.isInteger(value) || value < 0) throw new Error('DAG estimated duration must be a non-negative integer'); return value }
function validatePatch(patch: DagGraphPatch): void {
  if (!Number.isInteger(patch.expectedGraphVersion) || patch.expectedGraphVersion < 0) throw new Error('DAG expected graph version must be a non-negative integer')
  if (patch.nodes.length === 0 || patch.nodes.length > MAX_GRAPH_NODES) throw new Error(`DAG graph must contain 1-${MAX_GRAPH_NODES} nodes`)
  if (patch.edges.length > MAX_GRAPH_EDGES) throw new Error(`DAG graph cannot exceed ${MAX_GRAPH_EDGES} edges`)
  assertDag(patch.nodes.map((node) => node.id), patch.edges)
  if (!patch.nodes.some((node) => node.id === patch.resultNodeId)) throw new Error('DAG result node must identify a graph node')
  if (patch.edges.some((edge) => edge.source === patch.resultNodeId)) throw new Error('DAG result node must be terminal')
}
function uniqueEdges(edges: readonly DagPlanEdgeInput[]): DagPlanEdgeInput[] { const seen = new Set<string>(); return edges.filter((edge) => { const key = `${edge.source}\u0000${edge.target}`; if (seen.has(key)) return false; seen.add(key); return true }) }
function graphDepths(ids: readonly string[], edges: readonly DagPlanEdgeInput[]): Map<string, number> {
  const depths = new Map(ids.map((id) => [id, 0])); const remaining = new Set(ids)
  while (remaining.size) { let changed = false; for (const id of remaining) { const incoming = edges.filter((edge) => edge.target === id); if (incoming.some((edge) => remaining.has(edge.source))) continue; depths.set(id, incoming.length ? Math.max(...incoming.map((edge) => depths.get(edge.source) ?? 0)) + 1 : 0); remaining.delete(id); changed = true } if (!changed) throw new Error('DAG depth calculation failed') }
  return depths
}
function quoteIdentifier(value: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError('invalid PostgreSQL identifier'); return `"${value.replaceAll('"', '""')}"` }
