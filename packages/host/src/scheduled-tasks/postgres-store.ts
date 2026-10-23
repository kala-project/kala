import { createHash, randomUUID } from 'node:crypto'

import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import type { HotStateDatabase, HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import {
  assertResourceOwner,
  RuntimeResourceOwnershipFencedError,
  type RuntimeResourceOwnership,
} from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { nextOccurrence, validateSchedule } from './recurrence.js'
import type { ScheduledTaskStorage } from './store.js'
import type {
  CreateScheduledTask,
  ScheduledInbox,
  ScheduledInboxItem,
  ScheduledInboxSeenResult,
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskSnapshot,
  UpdateScheduledTask,
} from './types.js'

type InboxReceipt = { ownerKey: string; principal: string; occurrenceIds: string[]; updatedAt: string }
type State = { schemaVersion: 1; revision: number; tasks: ScheduledTask[]; runs: ScheduledRun[]; inboxReceipts?: InboxReceipt[] }
type LeaseToken = { unitId: string; ownerId: string; generation: bigint }
type LeaseRow = Record<string, unknown> & { owner_id: string; generation: string; is_live: boolean }
type StateRow = Record<string, unknown> & { document: unknown }

const MAX_RUNS = 10_000
const PARALLEL_OWNER_PREFIX = 'parallel-v1:'
const PARALLEL_BARRIER = 'kala-parallel-placement-barrier-v1'
const PARALLEL_BARRIER_ORIGIN = 'https://parallel-placement-barrier.invalid'

export class ScheduledTaskLeaseHeldError extends Error {
  readonly code = 'SCHEDULED_TASK_LEASE_HELD'
  constructor(readonly unitId: string) {
    super(`scheduled task writer lease is already held for Unit ${unitId}`)
    this.name = 'ScheduledTaskLeaseHeldError'
  }
}

export class ScheduledTaskFencedError extends Error {
  readonly code = 'SCHEDULED_TASK_FENCED'
  constructor() {
    super('scheduled task store was fenced by a newer Unit writer generation')
    this.name = 'ScheduledTaskFencedError'
  }
}

class ScheduledTaskParallelGateError extends ScheduledTaskFencedError {
  constructor() {
    super()
    this.name = 'ScheduledTaskParallelGateError'
  }
}

/**
 * Private Cloud scheduled-task authority. A single JSONB state document keeps
 * the local store's atomic state-machine semantics, while the lease row gives
 * every transaction a PostgreSQL row lock and persistent generation fence.
 * The database is shared with Session authority and is therefore never closed
 * by this store.
 */
export class PostgresScheduledTaskStore implements ScheduledTaskStorage {
  readonly #leases: string
  readonly #states: string
  readonly #ownerId = randomUUID()
  readonly #leaseTtlMs: number
  readonly #heartbeatMs: number
  readonly #now: () => Date
  readonly #schemaManagement: PostgresSchemaManagement
  readonly #schema: string
  readonly #prepareSessionOwner?: (sessionId: string) => Promise<void>
  readonly #resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined
  readonly #writerMode: 'exclusive' | 'parallel-v1'
  readonly #tryPrepareScheduledSessionOwner?: (sessionId: string) => Promise<boolean>
  #unitId: string | undefined
  #token: LeaseToken | undefined
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #mutation: Promise<void> = Promise.resolve()
  #closing = false
  #fenceError: Error | undefined

  constructor(
    private readonly database: HotStateDatabase,
    private readonly namespace: string,
    options: { schema?: string; leaseTtlMs?: number; heartbeatMs?: number; now?: () => Date;
      schemaManagement?: PostgresSchemaManagement;
      prepareSessionOwner?: (sessionId: string) => Promise<void>;
      resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined;
      writerMode?: 'exclusive' | 'parallel-v1';
      tryPrepareScheduledSessionOwner?: (sessionId: string) => Promise<boolean> } = {},
  ) {
    if (!namespace.trim()) throw new TypeError('scheduled task namespace must be a non-empty string')
    this.#schema = options.schema ?? 'public'
    const schema = quoteIdentifier(this.#schema)
    this.#leases = `${schema}.scheduled_task_writer_leases`
    this.#states = `${schema}.scheduled_task_states`
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000
    this.#heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(this.#leaseTtlMs / 3))
    this.#now = options.now ?? (() => new Date())
    this.#schemaManagement = options.schemaManagement ?? 'initialize'
    this.#prepareSessionOwner = options.prepareSessionOwner
    this.#resourceOwnerForSession = options.resourceOwnerForSession
    this.#writerMode = options.writerMode ?? 'exclusive'
    this.#tryPrepareScheduledSessionOwner = options.tryPrepareScheduledSessionOwner
    if (Boolean(this.#prepareSessionOwner) !== Boolean(this.#resourceOwnerForSession)) {
      throw new TypeError('scheduled task Session owner requires both prepare and live lease provider')
    }
    if (this.#writerMode === 'parallel-v1'
      && (!this.#prepareSessionOwner || !this.#resourceOwnerForSession || !this.#tryPrepareScheduledSessionOwner)) {
      throw new TypeError('parallel-v1 scheduled task writers require Session ownership and deterministic scheduler acquisition')
    }
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs < 100) throw new TypeError('leaseTtlMs must be an integer of at least 100')
    if (!Number.isSafeInteger(this.#heartbeatMs) || this.#heartbeatMs < 25 || this.#heartbeatMs >= this.#leaseTtlMs) throw new TypeError('heartbeatMs must be positive and less than leaseTtlMs')
  }

  async start(unitId: string): Promise<void> {
    if (!unitId.trim()) throw new TypeError('unitId must be a non-empty string')
    if (this.#unitId) throw new Error('scheduled task store is already started')
    await this.initialize()
    if (this.#writerMode === 'parallel-v1') return await this.startParallel(unitId)
    const token = await this.database.transaction(async (transaction) => {
      const inserted = await transaction.query<LeaseRow>(`INSERT INTO ${this.#leases}
        (namespace, unit_id, owner_id, generation, expires_at)
        VALUES ($1, $2, $3, 1, clock_timestamp() + $4 * interval '1 millisecond')
        ON CONFLICT (namespace, unit_id) DO NOTHING
        RETURNING owner_id, generation::text, true AS is_live`, [this.namespace, unitId, this.#ownerId, this.#leaseTtlMs])
      let generation: bigint
      if (inserted.rows[0]) {
        generation = BigInt(inserted.rows[0].generation)
      } else {
        const selected = await transaction.query<LeaseRow>(`SELECT owner_id, generation::text,
            expires_at > clock_timestamp() AS is_live
          FROM ${this.#leases}
          WHERE namespace = $1 AND unit_id = $2
          FOR UPDATE`, [this.namespace, unitId])
        const current = selected.rows[0]
        if (!current) throw new Error('scheduled task lease disappeared while being acquired')
        if (current.is_live) throw new ScheduledTaskLeaseHeldError(unitId)
        const claimed = await transaction.query<LeaseRow>(`UPDATE ${this.#leases}
          SET owner_id = $3, generation = generation + 1,
              expires_at = clock_timestamp() + $4 * interval '1 millisecond', updated_at = clock_timestamp()
          WHERE namespace = $1 AND unit_id = $2
          RETURNING owner_id, generation::text, true AS is_live`, [this.namespace, unitId, this.#ownerId, this.#leaseTtlMs])
        generation = BigInt(claimed.rows[0]!.generation)
      }
      await transaction.query(`INSERT INTO ${this.#states} (namespace, unit_id, document)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (namespace, unit_id) DO NOTHING`, [this.namespace, unitId, JSON.stringify(emptyState())])
      return { unitId, ownerId: this.#ownerId, generation }
    })
    this.#token = token
    this.#unitId = unitId
    try {
      // Validate the persisted document before the Unit is considered ready.
      await this.readState()
    } catch (error) {
      this.#token = undefined
      this.#unitId = undefined
      await this.release(token)
      throw error
    }
    this.#heartbeat = setInterval(() => { void this.renewInBackground() }, this.#heartbeatMs)
    this.#heartbeat.unref?.()
  }

  async close(): Promise<void> {
    this.#closing = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    await this.#mutation
    const token = this.#token
    this.#token = undefined
    this.#unitId = undefined
    if (token) await this.release(token)
  }

  async listTasks(ownerKey: string): Promise<ScheduledTask[]> {
    return (await this.readState()).tasks.filter((task) => task.ownerKey === ownerKey).map(clone)
  }

  async getTask(ownerKey: string, taskId: string): Promise<ScheduledTask | undefined> {
    const task = (await this.readState()).tasks.find((item) => item.id === taskId && item.ownerKey === ownerKey)
    return task ? clone(task) : undefined
  }

  async getTaskById(taskId: string): Promise<ScheduledTask | undefined> {
    const task = (await this.readState()).tasks.find((item) => item.id === taskId)
    return task ? clone(task) : undefined
  }

  async history(ownerKey: string, taskId: string): Promise<ScheduledRun[] | undefined> {
    const state = await this.readState()
    const owned = state.tasks.some((task) => task.id === taskId && task.ownerKey === ownerKey)
      || state.runs.some((run) => run.taskId === taskId && run.task.ownerKey === ownerKey)
    if (!owned) return undefined
    return state.runs.filter((run) => run.taskId === taskId).sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)).map(clone)
  }

  async origins(ownerKey: string, sessionId: string): Promise<Record<string, string>> {
    const origins: Record<string, string> = Object.create(null) as Record<string, string>
    for (const run of (await this.readState()).runs) {
      if (run.task.ownerKey === ownerKey && run.sessionId === sessionId) origins[run.operationId] = run.taskId
    }
    return origins
  }

  async inbox(ownerKey: string, principal: string): Promise<ScheduledInbox> {
    return inboxFor(await this.readState(), ownerKey, principal)
  }

  async markInboxSeen(ownerKey: string, principal: string, occurrenceIds: readonly string[]): Promise<ScheduledInboxSeenResult> {
    const requested = new Set(occurrenceIds)
    const candidateState = await this.readState()
    await this.prepareSessionOwners(sessionIdsForRuns(inboxRuns(candidateState, ownerKey, principal)
      .filter((run) => requested.has(run.occurrenceId))))
    return await this.mutate(async (state, transaction) => {
      const requestedRuns = inboxRuns(state, ownerKey, principal).filter((run) => requested.has(run.occurrenceId))
      await this.assertSessionOwners(transaction, sessionIdsForRuns(requestedRuns))
      const acknowledged = requestedRuns.map((run) => run.occurrenceId)
      if (acknowledged.length > 0) {
        state.inboxReceipts ??= []
        let receipt = state.inboxReceipts.find((item) => item.ownerKey === ownerKey && item.principal === principal)
        if (!receipt) {
          receipt = { ownerKey, principal, occurrenceIds: [], updatedAt: this.#now().toISOString() }
          state.inboxReceipts.push(receipt)
        }
        const seen = new Set(receipt.occurrenceIds)
        for (const occurrenceId of acknowledged) seen.add(occurrenceId)
        receipt.occurrenceIds = [...seen]
        receipt.updatedAt = this.#now().toISOString()
      }
      const inbox = inboxFor(state, ownerKey, principal)
      return { acknowledged, unreadCount: inbox.unreadCount }
    })
  }

  async create(input: CreateScheduledTask): Promise<ScheduledTask> {
    const sessionIds = sessionIdsForTarget(input.target)
    await this.prepareSessionOwners(sessionIds)
    return await this.mutate(async (state, transaction) => {
      await this.assertSessionOwners(transaction, sessionIds)
      validateTaskInput(input.prompt, input.target, input.schedule)
      const now = this.#now()
      const next = nextOccurrence(input.schedule, new Date(now.getTime() - 1))
      if (!next) throw new Error('once schedule must be in the future')
      const task: ScheduledTask = {
        id: randomUUID(), generation: 1, ownerKey: input.ownerKey, createdBy: input.createdBy, status: 'active',
        prompt: input.prompt, target: clone(input.target), schedule: clone(input.schedule),
        nextRunAt: next.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
      }
      state.tasks.push(task)
      return clone(task)
    })
  }

  async update(ownerKey: string, taskId: string, patch: UpdateScheduledTask): Promise<ScheduledTask> {
    const existing = await this.getTask(ownerKey, taskId)
    await this.prepareSessionOwners(uniqueSessionIds(
      ...(existing ? sessionIdsForTarget(existing.target) : []),
      ...(patch.target ? sessionIdsForTarget(patch.target) : []),
    ))
    return await this.mutate(async (state, transaction) => {
      const task = requiredTask(state, ownerKey, taskId)
      await this.assertSessionOwners(transaction, uniqueSessionIds(
        ...sessionIdsForTarget(task.target),
        ...(patch.target ? sessionIdsForTarget(patch.target) : []),
      ))
      const prompt = patch.prompt ?? task.prompt
      const target = patch.target ?? task.target
      const schedule = patch.schedule ?? task.schedule
      validateTaskInput(prompt, target, schedule)
      Object.assign(task, { prompt, target: clone(target), schedule: clone(schedule), updatedAt: this.#now().toISOString() })
      task.generation += 1
      if (patch.schedule) task.nextRunAt = nextOccurrence(schedule, new Date(this.#now().getTime() - 1))?.toISOString() ?? null
      return clone(task)
    })
  }

  async setPaused(ownerKey: string, taskId: string, paused: boolean): Promise<ScheduledTask> {
    const existing = await this.getTask(ownerKey, taskId)
    await this.prepareSessionOwners(existing ? sessionIdsForTarget(existing.target) : [])
    return await this.mutate(async (state, transaction) => {
      const task = requiredTask(state, ownerKey, taskId)
      await this.assertSessionOwners(transaction, sessionIdsForTarget(task.target))
      task.status = paused ? 'paused' : 'active'
      task.updatedAt = this.#now().toISOString()
      if (!paused && !task.nextRunAt) task.nextRunAt = nextOccurrence(task.schedule, new Date(this.#now().getTime() - 1))?.toISOString() ?? null
      return clone(task)
    })
  }

  async pauseSessionTargets(ownerKey: string, sessionIds: ReadonlySet<string>): Promise<number> {
    const prepared = (await this.listTasks(ownerKey))
      .filter((task) => task.target.kind === 'session' && sessionIds.has(task.target.sessionId))
      .map((task) => task.target.kind === 'session' ? task.target.sessionId : '')
    await this.prepareSessionOwners(prepared)
    return await this.mutate(async (state, transaction) => {
      const guarded = state.tasks
        .filter((task) => task.ownerKey === ownerKey && task.target.kind === 'session' && sessionIds.has(task.target.sessionId))
        .map((task) => task.target.kind === 'session' ? task.target.sessionId : '')
      await this.assertSessionOwners(transaction, guarded)
      let paused = 0
      const updatedAt = this.#now().toISOString()
      for (const task of state.tasks) {
        if (task.ownerKey !== ownerKey || task.status !== 'active' || task.target.kind !== 'session' || !sessionIds.has(task.target.sessionId)) continue
        task.status = 'paused'
        task.updatedAt = updatedAt
        paused += 1
      }
      return paused
    })
  }

  async delete(ownerKey: string, taskId: string): Promise<boolean> {
    const existing = await this.getTask(ownerKey, taskId)
    await this.prepareSessionOwners(existing ? sessionIdsForTarget(existing.target) : [])
    return await this.mutate(async (state, transaction) => {
      const index = state.tasks.findIndex((task) => task.id === taskId && task.ownerKey === ownerKey)
      if (index < 0) return false
      await this.assertSessionOwners(transaction, sessionIdsForTarget(state.tasks[index]!.target))
      if (state.tasks[index]!.status !== 'paused') throw new Error('scheduled task must be paused before deletion')
      if (state.runs.some((run) => run.taskId === taskId && run.status === 'claimed')) throw new Error('scheduled task has a claimed occurrence and cannot be deleted')
      state.tasks.splice(index, 1)
      return true
    })
  }

  async due(limit: number): Promise<ScheduledTask[]> {
    const now = this.#now().toISOString()
    if (this.#writerMode === 'parallel-v1') await this.tryBecomeParallelLeader()
    const candidates = (await this.readState()).tasks
      .filter((task) => task.status === 'active' && task.nextRunAt !== null && task.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    if (this.#writerMode !== 'parallel-v1') return candidates.slice(0, limit).map(clone)
    const runnable: ScheduledTask[] = []
    for (const task of candidates) {
      if (runnable.length >= limit) break
      const occurrenceId = stableId('occ', task.id, task.nextRunAt!)
      if (await this.canRunOccurrence(task, occurrenceId)) runnable.push(clone(task))
    }
    return runnable
  }

  async claim(taskId: string, scheduledFor: string): Promise<ScheduledRun | undefined> {
    const occurrenceId = stableId('occ', taskId, scheduledFor)
    const candidate = await this.getTaskById(taskId)
    if (this.#writerMode !== 'parallel-v1') {
      await this.prepareSessionOwners(candidate ? sessionIdsForOccurrence(candidate.target, occurrenceId) : [])
    }
    return await this.mutate(async (state, transaction) => {
      const task = state.tasks.find((item) => item.id === taskId)
      if (!task) return undefined
      await this.assertSessionOwners(transaction, sessionIdsForOccurrence(task.target, occurrenceId))
      const existing = state.runs.find((run) => run.occurrenceId === occurrenceId)
      if (existing) return clone(existing)
      if (task.status !== 'active' || task.nextRunAt !== scheduledFor) return undefined
      const now = this.#now().toISOString()
      const run: ScheduledRun = {
        occurrenceId, taskId, operationId: stableId('schedule', taskId, scheduledFor),
        scheduledFor, status: 'claimed', claimedAt: now, updatedAt: now, task: snapshot(task),
      }
      state.runs.push(run)
      let next = nextOccurrence(task.schedule, new Date(scheduledFor))
      let missed = 0
      while (next && next.getTime() <= this.#now().getTime()) {
        missed += 1
        if (missed <= 9) {
          const missedFor = next.toISOString()
          const skippedAt = this.#now().toISOString()
          state.runs.push({
            occurrenceId: stableId('occ', taskId, missedFor), taskId,
            operationId: stableId('schedule', taskId, missedFor), scheduledFor: missedFor,
            status: 'skipped', claimedAt: skippedAt, updatedAt: skippedAt, task: snapshot(task),
            error: 'bounded catchup skipped overdue occurrence',
          })
        }
        if (missed >= 10_000) throw new Error('schedule catchup exceeds safety bound')
        next = nextOccurrence(task.schedule, next)
      }
      task.nextRunAt = next?.toISOString() ?? null
      task.updatedAt = now
      trimRuns(state)
      return clone(run)
    })
  }

  async claimedRuns(): Promise<ScheduledRun[]> {
    const candidates = (await this.readState()).runs.filter((run) => run.status === 'claimed')
    if (this.#writerMode === 'parallel-v1') await this.tryBecomeParallelLeader()
    const runnable = this.#writerMode === 'parallel-v1'
      ? (await Promise.all(candidates.map(async (run) => await this.canRunOccurrence(run.task, run.occurrenceId) ? run : undefined)))
          .filter((run): run is ScheduledRun => Boolean(run))
      : candidates
    if (this.#writerMode !== 'parallel-v1') await this.prepareSessionOwners(sessionIdsForRuns(runnable))
    return await this.serialized(async () => await this.database.transaction(async (transaction) => {
      const unitId = await this.assertWritable(transaction)
      const result = await transaction.query<StateRow>(`SELECT document FROM ${this.#states}
        WHERE namespace = $1 AND unit_id = $2`, [this.namespace, unitId])
      if (!result.rows[0]) throw new Error('scheduled task state not found')
      const allowed = new Set(runnable.map((run) => run.occurrenceId))
      const claimed = parseState(result.rows[0].document).runs
        .filter((run) => run.status === 'claimed' && (this.#writerMode !== 'parallel-v1' || allowed.has(run.occurrenceId)))
      await this.assertSessionOwners(transaction, sessionIdsForRuns(claimed))
      return claimed.map(clone)
    }))
  }

  async finish(occurrenceId: string, status: Exclude<ScheduledRun['status'], 'claimed'>, detail: { sessionId?: string; error?: string } = {}): Promise<ScheduledRun> {
    const candidate = (await this.readState()).runs.find((run) => run.occurrenceId === occurrenceId)
    if (this.#writerMode !== 'parallel-v1') {
      await this.prepareSessionOwners(uniqueSessionIds(
        ...(candidate ? sessionIdsForRun(candidate) : []),
        ...(detail.sessionId ? [detail.sessionId] : []),
      ))
    }
    return await this.mutate(async (state, transaction) => {
      const run = state.runs.find((item) => item.occurrenceId === occurrenceId)
      if (!run) throw new Error('scheduled run not found')
      await this.assertSessionOwners(transaction, uniqueSessionIds(
        ...sessionIdsForRun(run),
        ...(detail.sessionId ? [detail.sessionId] : []),
      ))
      if (run.status !== 'claimed') return clone(run)
      Object.assign(run, { status, updatedAt: this.#now().toISOString(), ...detail })
      return clone(run)
    })
  }

  private async startParallel(unitId: string): Promise<void> {
    const ownerId = `${PARALLEL_OWNER_PREFIX}${this.#ownerId}`
    this.#unitId = unitId
    try {
      this.#token = await this.database.transaction(async (transaction) => {
        await this.assertParallelGate(transaction, unitId)
        await transaction.query(`INSERT INTO ${this.#states} (namespace, unit_id, document)
          VALUES ($1, $2, $3::jsonb)
          ON CONFLICT (namespace, unit_id) DO NOTHING`, [this.namespace, unitId, JSON.stringify(emptyState())])
        const inserted = await transaction.query<LeaseRow>(`INSERT INTO ${this.#leases}
          (namespace, unit_id, owner_id, generation, expires_at)
          VALUES ($1, $2, $3, 1, clock_timestamp() + $4 * interval '1 millisecond')
          ON CONFLICT (namespace, unit_id) DO NOTHING
          RETURNING owner_id, generation::text, true AS is_live`, [this.namespace, unitId, ownerId, this.#leaseTtlMs])
        if (inserted.rows[0]) return { unitId, ownerId, generation: BigInt(inserted.rows[0].generation) }
        const selected = await transaction.query<LeaseRow>(`SELECT owner_id, generation::text,
            expires_at > clock_timestamp() AS is_live
          FROM ${this.#leases}
          WHERE namespace = $1 AND unit_id = $2
          FOR UPDATE`, [this.namespace, unitId])
        const current = selected.rows[0]
        if (!current) throw new Error('scheduled task lease disappeared while parallel mode was starting')
        if (current.is_live) {
          if (!current.owner_id.startsWith(PARALLEL_OWNER_PREFIX)) throw new ScheduledTaskLeaseHeldError(unitId)
          return undefined
        }
        const claimed = await transaction.query<LeaseRow>(`UPDATE ${this.#leases}
          SET owner_id = $3, generation = generation + 1,
              expires_at = clock_timestamp() + $4 * interval '1 millisecond', updated_at = clock_timestamp()
          WHERE namespace = $1 AND unit_id = $2
          RETURNING owner_id, generation::text, true AS is_live`, [this.namespace, unitId, ownerId, this.#leaseTtlMs])
        return { unitId, ownerId, generation: BigInt(claimed.rows[0]!.generation) }
      })
      await this.readState()
      if (this.#token) this.startHeartbeat()
    } catch (error) {
      const token = this.#token
      this.#token = undefined
      this.#unitId = undefined
      if (token) await this.release(token)
      throw error
    }
  }

  private async initialize(): Promise<void> {
    if (this.#schemaManagement === 'external') return
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#leases} (
      namespace text NOT NULL,
      unit_id text NOT NULL,
      owner_id text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (namespace, unit_id)
    )`)
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#states} (
      namespace text NOT NULL,
      unit_id text NOT NULL,
      document jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (namespace, unit_id)
    )`)
  }

  private async readState(): Promise<State> {
    return await this.serialized(async () => await this.database.transaction(async (transaction) => {
      const unitId = await this.assertWritable(transaction)
      const result = await transaction.query<StateRow>(`SELECT document FROM ${this.#states}
        WHERE namespace = $1 AND unit_id = $2`, [this.namespace, unitId])
      if (!result.rows[0]) throw new Error('scheduled task state not found')
      return parseState(result.rows[0].document)
    }))
  }

  private async mutate<T>(operation: (state: State, transaction: HotStateSqlExecutor) => Promise<T> | T): Promise<T> {
    return await this.serialized(async () => await this.database.transaction(async (transaction) => {
      const unitId = await this.assertWritable(transaction)
      const selected = await transaction.query<StateRow>(`SELECT document FROM ${this.#states}
        WHERE namespace = $1 AND unit_id = $2
        FOR UPDATE`, [this.namespace, unitId])
      if (!selected.rows[0]) throw new Error('scheduled task state not found')
      const state = parseState(selected.rows[0].document)
      const value = await operation(state, transaction)
      state.revision += 1
      const updated = await transaction.query(`UPDATE ${this.#states} SET document = $3::jsonb, updated_at = clock_timestamp()
        WHERE namespace = $1 AND unit_id = $2`, [this.namespace, unitId, JSON.stringify(state)])
      if (updated.rowCount !== 1) throw new ScheduledTaskFencedError()
      return value
    }))
  }

  private async assertWritable(transaction: HotStateSqlExecutor): Promise<string> {
    const unitId = this.requireUnitId()
    if (this.#writerMode === 'parallel-v1') {
      await this.assertParallelGate(transaction, unitId)
      return unitId
    }
    return (await this.assertAndRenew(transaction)).unitId
  }

  private async assertParallelGate(transaction: HotStateSqlExecutor, unitId: string): Promise<void> {
    const schema = quoteIdentifier(this.#schema)
    const selected = await transaction.query(`SELECT 1
      FROM ${schema}.tenant_runtime_unit_protocol_gates AS gate
      JOIN ${schema}.tenant_runtime_unit_placement_leases AS placement
        ON placement.organization_id = gate.organization_id AND placement.unit_id = gate.unit_id
      WHERE gate.organization_id = $1 AND gate.unit_id = $2
        AND gate.feature_version = 1 AND gate.barrier_generation = placement.generation
        AND placement.node_id = $3 AND placement.owner_token = $3 AND placement.origin = $4
      FOR SHARE OF placement`, [this.namespace, unitId, PARALLEL_BARRIER, PARALLEL_BARRIER_ORIGIN])
    if (selected.rowCount !== 1) throw new ScheduledTaskParallelGateError()
  }

  private async assertAndRenew(transaction: HotStateSqlExecutor): Promise<LeaseToken> {
    const token = this.requireToken()
    const renewed = await transaction.query(`UPDATE ${this.#leases}
      SET expires_at = clock_timestamp() + $5 * interval '1 millisecond', updated_at = clock_timestamp()
      WHERE namespace = $1 AND unit_id = $2 AND owner_id = $3 AND generation = $4
        AND expires_at > clock_timestamp()
      RETURNING generation`, [this.namespace, token.unitId, token.ownerId, token.generation.toString(), this.#leaseTtlMs])
    if (renewed.rowCount !== 1) throw new ScheduledTaskFencedError()
    return token
  }

  private async prepareSessionOwners(sessionIds: readonly string[]): Promise<void> {
    if (!this.#prepareSessionOwner) return
    for (const sessionId of uniqueSessionIds(...sessionIds)) await this.#prepareSessionOwner(sessionId)
  }

  private async assertSessionOwners(transaction: HotStateSqlExecutor, sessionIds: readonly string[]): Promise<void> {
    if (!this.#resourceOwnerForSession) return
    const unitId = this.requireUnitId()
    for (const sessionId of uniqueSessionIds(...sessionIds)) {
      const owner = this.#resourceOwnerForSession(sessionId)
      if (!owner) throw new RuntimeResourceOwnershipFencedError()
      if (owner.organizationId !== this.namespace || owner.unitId !== unitId
        || owner.resourceType !== 'session' || owner.resourceId !== sessionId) {
        throw new TypeError('scheduled task Session owner must match its tenant, Unit, and Session')
      }
      await assertResourceOwner(transaction, owner, { schema: this.#schema })
    }
  }

  private requireToken(): LeaseToken {
    this.requireUnitId()
    if (!this.#token) throw new Error('scheduled task store does not hold the scheduler leader lease')
    return this.#token
  }

  private requireUnitId(): string {
    if (this.#fenceError) throw this.#fenceError
    if (this.#closing) throw new Error('scheduled task store is closing')
    if (!this.#unitId) throw new Error('scheduled task store is not started')
    return this.#unitId
  }

  private async canRunOccurrence(task: ScheduledTaskSnapshot, occurrenceId: string): Promise<boolean> {
    const sessionIds = sessionIdsForOccurrence(task.target, occurrenceId)
    if (sessionIds.every((sessionId) => Boolean(this.#resourceOwnerForSession?.(sessionId)))) return true
    if (!this.#token || !this.#tryPrepareScheduledSessionOwner) return false
    for (const sessionId of sessionIds) {
      if (this.#resourceOwnerForSession?.(sessionId)) continue
      if (!await this.#tryPrepareScheduledSessionOwner(sessionId)) return false
      if (!this.#resourceOwnerForSession?.(sessionId)) throw new RuntimeResourceOwnershipFencedError()
    }
    return true
  }

  private async tryBecomeParallelLeader(): Promise<void> {
    if (this.#writerMode !== 'parallel-v1' || this.#token) return
    await this.serialized(async () => {
      const token = await this.database.transaction(async (transaction): Promise<LeaseToken | undefined> => {
        const unitId = this.requireUnitId()
        await this.assertParallelGate(transaction, unitId)
        const selected = await transaction.query<LeaseRow>(`SELECT owner_id, generation::text,
            expires_at > clock_timestamp() AS is_live
          FROM ${this.#leases} WHERE namespace = $1 AND unit_id = $2 FOR UPDATE`, [this.namespace, unitId])
        const current = selected.rows[0]
        if (!current) throw new Error('parallel scheduler leader lease not found')
        if (current.is_live) {
          if (!current.owner_id.startsWith(PARALLEL_OWNER_PREFIX)) throw new ScheduledTaskLeaseHeldError(unitId)
          return undefined
        }
        const ownerId = `${PARALLEL_OWNER_PREFIX}${this.#ownerId}`
        const claimed = await transaction.query<LeaseRow>(`UPDATE ${this.#leases}
          SET owner_id = $3, generation = generation + 1,
              expires_at = clock_timestamp() + $4 * interval '1 millisecond', updated_at = clock_timestamp()
          WHERE namespace = $1 AND unit_id = $2
          RETURNING owner_id, generation::text, true AS is_live`, [this.namespace, unitId, ownerId, this.#leaseTtlMs])
        return { unitId, ownerId, generation: BigInt(claimed.rows[0]!.generation) }
      })
      if (token) {
        this.#token = token
        this.startHeartbeat()
      }
    })
  }

  private startHeartbeat(): void {
    if (this.#heartbeat) return
    this.#heartbeat = setInterval(() => { void this.renewInBackground() }, this.#heartbeatMs)
    this.#heartbeat.unref?.()
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const pending = this.#mutation.then(async () => {
      try { resolveResult(await operation()) } catch (error) { rejectResult(error) }
    })
    this.#mutation = pending.then(() => undefined, () => undefined)
    return await result
  }

  private async release(token: LeaseToken): Promise<void> {
    await this.database.query(`UPDATE ${this.#leases}
      SET expires_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE namespace = $1 AND unit_id = $2 AND owner_id = $3 AND generation = $4`,
    [this.namespace, token.unitId, token.ownerId, token.generation.toString()]).catch(() => undefined)
  }

  private async renewInBackground(): Promise<void> {
    if (this.#closing || this.#fenceError || !this.#token) return
    try {
      await this.serialized(async () => await this.database.transaction(async (transaction) => {
        if (this.#writerMode === 'parallel-v1') await this.assertParallelGate(transaction, this.requireUnitId())
        await this.assertAndRenew(transaction)
      }))
    } catch (error) {
      if (this.#writerMode !== 'parallel-v1' || error instanceof ScheduledTaskParallelGateError) {
        this.#fenceError = error instanceof Error ? error : new ScheduledTaskFencedError()
      } else {
        // Losing scheduler leadership does not revoke this process's Session-owned
        // writer capability. A later scan may rejoin the election after failover.
        this.#token = undefined
      }
      if (this.#heartbeat) clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
  }
}

function emptyState(): State { return { schemaVersion: 1, revision: 0, tasks: [], runs: [] } }

function parseState(document: unknown): State {
  const state = (typeof document === 'string' ? JSON.parse(document) : document) as State
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) throw new Error('invalid scheduled task state')
  return clone(state)
}

function validateTaskInput(prompt: string, target: CreateScheduledTask['target'], schedule: CreateScheduledTask['schedule']): void {
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 100_000) throw new Error('prompt is required and must not exceed 100000 characters')
  if (target.kind === 'session' && !target.sessionId) throw new Error('sessionId is required')
  if (target.kind === 'workspace' && !target.workspaceId) throw new Error('workspaceId is required')
  validateSchedule(schedule)
}

function requiredTask(state: State, ownerKey: string, taskId: string): ScheduledTask {
  const task = state.tasks.find((item) => item.id === taskId && item.ownerKey === ownerKey)
  if (!task) throw new Error('scheduled task not found')
  return task
}

function stableId(prefix: string, taskId: string, scheduledFor: string): string {
  return `${prefix}_${createHash('sha256').update(`${taskId}\0${scheduledFor}`).digest('hex').slice(0, 40)}`
}

function sessionIdsForTarget(target: CreateScheduledTask['target']): string[] {
  return target.kind === 'session' ? [target.sessionId] : []
}

function sessionIdsForOccurrence(target: CreateScheduledTask['target'], occurrenceId: string): string[] {
  return target.kind === 'session'
    ? [target.sessionId]
    : [`scheduled_${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 32)}`]
}

function sessionIdsForRun(run: ScheduledRun): string[] {
  return uniqueSessionIds(...sessionIdsForOccurrence(run.task.target, run.occurrenceId), ...(run.sessionId ? [run.sessionId] : []))
}

function sessionIdsForRuns(runs: readonly ScheduledRun[]): string[] {
  return uniqueSessionIds(...runs.flatMap(sessionIdsForRun))
}

function uniqueSessionIds(...sessionIds: string[]): string[] {
  return [...new Set(sessionIds.filter(Boolean))]
}

function trimRuns(state: State): void {
  if (state.runs.length <= MAX_RUNS) return
  const removable = state.runs.filter((run) => run.status !== 'claimed').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  const remove = new Set(removable.slice(0, state.runs.length - MAX_RUNS).map((run) => run.occurrenceId))
  state.runs = state.runs.filter((run) => !remove.has(run.occurrenceId))
  for (const receipt of state.inboxReceipts ?? []) receipt.occurrenceIds = receipt.occurrenceIds.filter((occurrenceId) => !remove.has(occurrenceId))
}

function inboxRuns(state: State, ownerKey: string, principal: string): Array<ScheduledRun & { status: ScheduledInboxItem['status'] }> {
  return state.runs.filter((run): run is ScheduledRun & { status: ScheduledInboxItem['status'] } =>
    run.task.ownerKey === ownerKey && run.task.createdBy === principal
    && (run.status === 'enqueued' || run.status === 'failed' || run.status === 'needs_review'))
}

function inboxFor(state: State, ownerKey: string, principal: string): ScheduledInbox {
  const seen = new Set(state.inboxReceipts?.find((receipt) => receipt.ownerKey === ownerKey && receipt.principal === principal)?.occurrenceIds ?? [])
  const items = inboxRuns(state, ownerKey, principal)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.occurrenceId.localeCompare(a.occurrenceId))
    .map((run): ScheduledInboxItem => ({
      occurrenceId: run.occurrenceId, taskId: run.taskId, status: run.status,
      scheduledFor: run.scheduledFor, updatedAt: run.updatedAt, seen: seen.has(run.occurrenceId),
      taskLabel: run.task.prompt.trim().split(/\r?\n/u)[0]!.slice(0, 200),
      target: clone(run.task.target),
      claimedAt: run.claimedAt,
      ...(run.error ? { error: run.error.slice(0, 2_000) } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    }))
  return { items, unreadCount: items.reduce((count, item) => count + (item.seen ? 0 : 1), 0) }
}

function snapshot(task: ScheduledTask): ScheduledRun['task'] {
  return clone({ id: task.id, generation: task.generation, ownerKey: task.ownerKey, createdBy: task.createdBy, prompt: task.prompt, target: task.target })
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError(`invalid PostgreSQL identifier: ${value}`)
  return `"${value}"`
}

function clone<T>(value: T): T { return structuredClone(value) }
