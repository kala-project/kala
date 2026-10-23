import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { writeJsonFile } from '../tenant-runtime/atomic-json-file.js'
import { nextOccurrence, validateSchedule } from './recurrence.js'
import type {
  CreateScheduledTask,
  ScheduledInbox,
  ScheduledInboxItem,
  ScheduledInboxSeenResult,
  ScheduledRun,
  ScheduledTask,
  UpdateScheduledTask,
} from './types.js'

type InboxReceipt = { ownerKey: string; principal: string; occurrenceIds: string[]; updatedAt: string }
type State = { schemaVersion: 1; revision: number; tasks: ScheduledTask[]; runs: ScheduledRun[]; inboxReceipts?: InboxReceipt[] }
const MAX_RUNS = 10_000

/** Complete persistence contract consumed by the API and Unit scheduler. */
export interface ScheduledTaskStorage {
  start(unitId: string): Promise<void>
  close(): Promise<void>
  listTasks(ownerKey: string): Promise<ScheduledTask[]>
  getTask(ownerKey: string, taskId: string): Promise<ScheduledTask | undefined>
  getTaskById(taskId: string): Promise<ScheduledTask | undefined>
  history(ownerKey: string, taskId: string): Promise<ScheduledRun[] | undefined>
  origins(ownerKey: string, sessionId: string): Promise<Record<string, string>>
  inbox(ownerKey: string, principal: string): Promise<ScheduledInbox>
  markInboxSeen(ownerKey: string, principal: string, occurrenceIds: readonly string[]): Promise<ScheduledInboxSeenResult>
  create(input: CreateScheduledTask): Promise<ScheduledTask>
  update(ownerKey: string, taskId: string, patch: UpdateScheduledTask): Promise<ScheduledTask>
  setPaused(ownerKey: string, taskId: string, paused: boolean): Promise<ScheduledTask>
  pauseSessionTargets(ownerKey: string, sessionIds: ReadonlySet<string>): Promise<number>
  delete(ownerKey: string, taskId: string): Promise<boolean>
  due(limit: number): Promise<ScheduledTask[]>
  claim(taskId: string, scheduledFor: string): Promise<ScheduledRun | undefined>
  claimedRuns(): Promise<ScheduledRun[]>
  finish(occurrenceId: string, status: Exclude<ScheduledRun['status'], 'claimed'>, detail?: { sessionId?: string; error?: string }): Promise<ScheduledRun>
}

export class ScheduledTaskStore implements ScheduledTaskStorage {
  private readonly statePath: string
  private readonly leasePath: string
  private mutation = Promise.resolve()
  private lease: DatabaseSync | undefined
  private closing = false

  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {
    this.statePath = join(directory, 'state.json')
    this.leasePath = join(directory, 'lease.sqlite')
  }

  async start(unitId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    let lease: DatabaseSync | undefined
    try {
      lease = new DatabaseSync(this.leasePath)
      // This database is used only as an OS-backed lifetime lease. In rollback
      // journal mode BEGIN EXCLUSIVE prevents another connection from acquiring
      // the lease, and SQLite releases it when this connection closes or dies.
      lease.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE')
      this.lease = lease
    } catch (error) {
      try { lease?.close() } catch { /* Preserve the acquisition error. */ }
      if (isSqliteBusy(error)) throw new Error(`scheduled task writer lease is already held for Unit ${unitId}; another local writer may still be running`)
      throw error
    }
    try {
      // Parse eagerly so corrupt state prevents the Unit from becoming ready.
      await this.read()
    } catch (error) {
      this.releaseLease()
      throw error
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await this.mutation
    this.releaseLease()
  }

  async listTasks(ownerKey: string): Promise<ScheduledTask[]> {
    return (await this.read()).tasks.filter((task) => task.ownerKey === ownerKey).map(clone)
  }

  async getTask(ownerKey: string, taskId: string): Promise<ScheduledTask | undefined> {
    const task = (await this.read()).tasks.find((item) => item.id === taskId && item.ownerKey === ownerKey)
    return task ? clone(task) : undefined
  }

  /** Unit-internal recovery lookup; management callers must use the owner-scoped method above. */
  async getTaskById(taskId: string): Promise<ScheduledTask | undefined> {
    const task = (await this.read()).tasks.find((item) => item.id === taskId)
    return task ? clone(task) : undefined
  }

  async history(ownerKey: string, taskId: string): Promise<ScheduledRun[] | undefined> {
    const state = await this.read()
    const owned = state.tasks.some((task) => task.id === taskId && task.ownerKey === ownerKey)
      || state.runs.some((run) => run.taskId === taskId && run.task.ownerKey === ownerKey)
    if (!owned) return undefined
    return state.runs.filter((run) => run.taskId === taskId).sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)).map(clone)
  }

  async origins(ownerKey: string, sessionId: string): Promise<Record<string, string>> {
    const origins: Record<string, string> = Object.create(null) as Record<string, string>
    for (const run of (await this.read()).runs) {
      if (run.task.ownerKey === ownerKey && run.sessionId === sessionId) origins[run.operationId] = run.taskId
    }
    return origins
  }

  async inbox(ownerKey: string, principal: string): Promise<ScheduledInbox> {
    return inboxFor(await this.read(), ownerKey, principal)
  }

  async markInboxSeen(ownerKey: string, principal: string, occurrenceIds: readonly string[]): Promise<ScheduledInboxSeenResult> {
    return await this.serialize(async (state) => {
      const requested = new Set(occurrenceIds)
      const acknowledged = inboxRuns(state, ownerKey, principal)
        .filter((run) => requested.has(run.occurrenceId))
        .map((run) => run.occurrenceId)
      if (acknowledged.length > 0) {
        state.inboxReceipts ??= []
        let receipt = state.inboxReceipts.find((item) => item.ownerKey === ownerKey && item.principal === principal)
        if (!receipt) {
          receipt = { ownerKey, principal, occurrenceIds: [], updatedAt: this.now().toISOString() }
          state.inboxReceipts.push(receipt)
        }
        const seen = new Set(receipt.occurrenceIds)
        for (const occurrenceId of acknowledged) seen.add(occurrenceId)
        receipt.occurrenceIds = [...seen]
        receipt.updatedAt = this.now().toISOString()
      }
      const inbox = inboxFor(state, ownerKey, principal)
      return { acknowledged, unreadCount: inbox.unreadCount }
    })
  }

  async create(input: CreateScheduledTask): Promise<ScheduledTask> {
    return await this.serialize(async (state) => {
      validateTaskInput(input.prompt, input.target, input.schedule)
      const now = this.now()
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
    return await this.serialize(async (state) => {
      const task = requiredTask(state, ownerKey, taskId)
      const prompt = patch.prompt ?? task.prompt
      const target = patch.target ?? task.target
      const schedule = patch.schedule ?? task.schedule
      validateTaskInput(prompt, target, schedule)
      Object.assign(task, { prompt, target: clone(target), schedule: clone(schedule), updatedAt: this.now().toISOString() })
      task.generation += 1
      if (patch.schedule) task.nextRunAt = nextOccurrence(schedule, new Date(this.now().getTime() - 1))?.toISOString() ?? null
      return clone(task)
    })
  }

  async setPaused(ownerKey: string, taskId: string, paused: boolean): Promise<ScheduledTask> {
    return await this.serialize(async (state) => {
      const task = requiredTask(state, ownerKey, taskId)
      task.status = paused ? 'paused' : 'active'
      task.updatedAt = this.now().toISOString()
      if (!paused && !task.nextRunAt) task.nextRunAt = nextOccurrence(task.schedule, new Date(this.now().getTime() - 1))?.toISOString() ?? null
      return clone(task)
    })
  }

  async pauseSessionTargets(ownerKey: string, sessionIds: ReadonlySet<string>): Promise<number> {
    return await this.serialize(async (state) => {
      let paused = 0
      const updatedAt = this.now().toISOString()
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
    return await this.serialize(async (state) => {
      const index = state.tasks.findIndex((task) => task.id === taskId && task.ownerKey === ownerKey)
      if (index < 0) return false
      if (state.tasks[index]!.status !== 'paused') throw new Error('scheduled task must be paused before deletion')
      if (state.runs.some((run) => run.taskId === taskId && run.status === 'claimed')) throw new Error('scheduled task has a claimed occurrence and cannot be deleted')
      state.tasks.splice(index, 1)
      return true
    })
  }

  async due(limit: number): Promise<ScheduledTask[]> {
    const now = this.now().toISOString()
    return (await this.read()).tasks
      .filter((task) => task.status === 'active' && task.nextRunAt !== null && task.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, limit).map(clone)
  }

  async claim(taskId: string, scheduledFor: string): Promise<ScheduledRun | undefined> {
    return await this.serialize(async (state) => {
      const task = state.tasks.find((item) => item.id === taskId)
      if (!task || task.status !== 'active' || task.nextRunAt !== scheduledFor) return undefined
      const occurrenceId = stableId('occ', taskId, scheduledFor)
      const existing = state.runs.find((run) => run.occurrenceId === occurrenceId)
      if (existing) return clone(existing)
      const now = this.now().toISOString()
      const run: ScheduledRun = {
        occurrenceId, taskId, operationId: stableId('schedule', taskId, scheduledFor),
        scheduledFor, status: 'claimed', claimedAt: now, updatedAt: now, task: snapshot(task),
      }
      state.runs.push(run)
      let next = nextOccurrence(task.schedule, new Date(scheduledFor))
      let missed = 0
      // Execute at most one overdue occurrence per task. Collapse older backlog
      // into at most nine visible skipped records, then move to the first future
      // wall-clock slot so long outages cannot unleash unbounded agent effects.
      while (next && next.getTime() <= this.now().getTime()) {
        missed += 1
        if (missed <= 9) {
          const missedFor = next.toISOString()
          const skippedAt = this.now().toISOString()
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
    return (await this.read()).runs.filter((run) => run.status === 'claimed').map(clone)
  }

  async finish(occurrenceId: string, status: Exclude<ScheduledRun['status'], 'claimed'>, detail: { sessionId?: string; error?: string } = {}): Promise<ScheduledRun> {
    return await this.serialize(async (state) => {
      const run = state.runs.find((item) => item.occurrenceId === occurrenceId)
      if (!run) throw new Error('scheduled run not found')
      if (run.status !== 'claimed') return clone(run)
      Object.assign(run, { status, updatedAt: this.now().toISOString(), ...detail })
      return clone(run)
    })
  }

  private async serialize<T>(operation: (state: State) => Promise<T> | T): Promise<T> {
    if (this.closing) throw new Error('scheduled task store is closing')
    const result = this.mutation.then(async () => {
      const state = await this.read()
      const value = await operation(state)
      state.revision += 1
      await writeJsonFile(this.statePath, state)
      return value
    })
    this.mutation = result.then(() => undefined, () => undefined)
    return await result
  }

  private async read(): Promise<State> {
    let raw: string
    try { raw = await readFile(this.statePath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, revision: 0, tasks: [], runs: [] }
      throw error
    }
    const state = JSON.parse(raw) as State
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) throw new Error('invalid scheduled task state')
    return state
  }

  private releaseLease(): void {
    const lease = this.lease
    this.lease = undefined
    lease?.close()
  }
}

function isSqliteBusy(error: unknown): boolean {
  const sqlite = error as { errcode?: unknown; errstr?: unknown }
  return sqlite?.errcode === 5 || sqlite?.errstr === 'database is locked'
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

function trimRuns(state: State): void {
  if (state.runs.length <= MAX_RUNS) return
  const removable = state.runs.filter((run) => run.status !== 'claimed').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  const remove = new Set(removable.slice(0, state.runs.length - MAX_RUNS).map((run) => run.occurrenceId))
  state.runs = state.runs.filter((run) => !remove.has(run.occurrenceId))
  for (const receipt of state.inboxReceipts ?? []) {
    receipt.occurrenceIds = receipt.occurrenceIds.filter((occurrenceId) => !remove.has(occurrenceId))
  }
}

function inboxRuns(state: State, ownerKey: string, principal: string): Array<ScheduledRun & { status: ScheduledInboxItem['status'] }> {
  return state.runs.filter((run): run is ScheduledRun & { status: ScheduledInboxItem['status'] } =>
    run.task.ownerKey === ownerKey
    && run.task.createdBy === principal
    && (run.status === 'enqueued' || run.status === 'failed' || run.status === 'needs_review'))
}

function inboxFor(state: State, ownerKey: string, principal: string): ScheduledInbox {
  const seen = new Set(state.inboxReceipts
    ?.find((receipt) => receipt.ownerKey === ownerKey && receipt.principal === principal)
    ?.occurrenceIds ?? [])
  const items = inboxRuns(state, ownerKey, principal)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.occurrenceId.localeCompare(a.occurrenceId))
    .map((run): ScheduledInboxItem => ({
      occurrenceId: run.occurrenceId,
      taskId: run.taskId,
      status: run.status,
      scheduledFor: run.scheduledFor,
      updatedAt: run.updatedAt,
      seen: seen.has(run.occurrenceId),
      taskLabel: run.task.prompt.trim().split(/\r?\n/u)[0]!.slice(0, 200),
      target: clone(run.task.target),
      claimedAt: run.claimedAt,
      ...(run.error ? { error: run.error.slice(0, 2_000) } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    }))
  return { items, unreadCount: items.reduce((count, item) => count + (item.seen ? 0 : 1), 0) }
}

function snapshot(task: ScheduledTask): ScheduledRun['task'] {
  return clone({
    id: task.id, generation: task.generation, ownerKey: task.ownerKey, createdBy: task.createdBy,
    prompt: task.prompt, target: task.target,
  })
}

function clone<T>(value: T): T { return structuredClone(value) }
