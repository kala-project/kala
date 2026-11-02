import { DatabaseSync } from 'node:sqlite'

import { validateSchedule } from './recurrence.js'
import { ScheduledTaskStateStore, type ScheduledTaskState } from './state-store.js'
import type { ScheduleSpec } from './types.js'

const TABLE = 'portable_scheduled_state'
const SCHEMA_VERSION = 1

type SnapshotRow = { singleton: number; schema_version: number; revision: number; state_json: string }
type TableColumn = { name: string; type: string; notnull: number; pk: number }

/** Scheduled-task authority stored atomically inside a fresh Portable state.sqlite. */
export class SqliteScheduledTaskStore extends ScheduledTaskStateStore {
  private database: DatabaseSync | undefined
  private mutation = Promise.resolve()
  private lifecycle: 'new' | 'started' | 'closing' | 'closed' = 'new'

  constructor(private readonly databasePath: string, now: () => Date = () => new Date()) {
    super(now)
  }

  async start(_unitId: string): Promise<void> {
    if (this.lifecycle !== 'new') throw new Error(`SQLite scheduled task store cannot start while ${this.lifecycle}`)
    const database = new DatabaseSync(this.databasePath)
    try {
      database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            state_json TEXT NOT NULL
          )
        `)
        validateTable(database)
        const rows = database.prepare(`SELECT singleton, schema_version, revision, state_json FROM ${TABLE}`).all() as SnapshotRow[]
        if (rows.length === 0) {
          const state: ScheduledTaskState = { schemaVersion: SCHEMA_VERSION, revision: 0, tasks: [], runs: [] }
          database.prepare(`INSERT INTO ${TABLE} (singleton, schema_version, revision, state_json) VALUES (1, ?, 0, ?)`)
            .run(SCHEMA_VERSION, JSON.stringify(state))
        } else {
          parseSnapshotRows(rows)
        }
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
      this.database = database
      this.lifecycle = 'started'
    } catch (error) {
      database.close()
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.lifecycle === 'closed') return
    if (this.lifecycle === 'new') {
      this.lifecycle = 'closed'
      return
    }
    this.lifecycle = 'closing'
    await this.mutation
    const database = this.database
    this.database = undefined
    database?.close()
    this.lifecycle = 'closed'
  }

  protected async readState(): Promise<ScheduledTaskState> {
    const database = this.requiredDatabase()
    const rows = database.prepare(`SELECT singleton, schema_version, revision, state_json FROM ${TABLE}`).all() as SnapshotRow[]
    return parseSnapshotRows(rows)
  }

  protected async mutateState<T>(operation: (state: ScheduledTaskState) => T): Promise<T> {
    if (this.lifecycle !== 'started') throw new Error('SQLite scheduled task store is not started')
    const database = this.requiredDatabase()
    const result = this.mutation.then(() => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const rows = database.prepare(`SELECT singleton, schema_version, revision, state_json FROM ${TABLE}`).all() as SnapshotRow[]
        const state = parseSnapshotRows(rows)
        const value = operation(state)
        state.revision += 1
        const changed = database.prepare(`
          UPDATE ${TABLE}
          SET schema_version = ?, revision = ?, state_json = ?
          WHERE singleton = 1 AND schema_version = ? AND revision = ?
        `).run(SCHEMA_VERSION, state.revision, JSON.stringify(state), SCHEMA_VERSION, state.revision - 1)
        if (changed.changes !== 1) throw new Error('scheduled task snapshot changed during transaction')
        database.exec('COMMIT')
        return value
      } catch (error) {
        rollback(database)
        throw error
      }
    })
    this.mutation = result.then(() => undefined, () => undefined)
    return await result
  }

  private requiredDatabase(): DatabaseSync {
    if (this.lifecycle !== 'started' || !this.database) throw new Error('SQLite scheduled task store is not started')
    return this.database
  }
}

function validateTable(database: DatabaseSync): void {
  const columns = database.prepare(`PRAGMA table_info(${TABLE})`).all() as TableColumn[]
  const expected: TableColumn[] = [
    { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'state_json', type: 'TEXT', notnull: 1, pk: 0 },
  ]
  if (columns.length !== expected.length || expected.some((column, index) => {
    const actual = columns[index]
    return !actual || actual.name !== column.name || actual.type.toUpperCase() !== column.type
      || actual.notnull !== column.notnull || actual.pk !== column.pk
  })) throw new Error(`invalid ${TABLE} schema`)
}

function parseSnapshotRows(rows: SnapshotRow[]): ScheduledTaskState {
  if (rows.length !== 1) throw new Error('invalid portable scheduled task snapshot cardinality')
  const row = rows[0]!
  if (row.singleton !== 1 || row.schema_version !== SCHEMA_VERSION || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.state_json !== 'string') {
    throw new Error('invalid portable scheduled task snapshot metadata')
  }
  let state: unknown
  try { state = JSON.parse(row.state_json) } catch { throw new Error('invalid portable scheduled task snapshot JSON') }
  if (!isRecord(state)
    || state.schemaVersion !== SCHEMA_VERSION
    || state.revision !== row.revision
    || !Array.isArray(state.tasks)
    || !Array.isArray(state.runs)
    || !state.tasks.every(isTask)
    || !state.runs.every(isRun)
    || (state.inboxReceipts !== undefined
      && (!Array.isArray(state.inboxReceipts) || !state.inboxReceipts.every(isInboxReceipt)))) {
    throw new Error('invalid portable scheduled task snapshot state')
  }
  return state as ScheduledTaskState
}

function isTask(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id) && Number.isSafeInteger(value.generation) && (value.generation as number) >= 1
    && isString(value.ownerKey) && isString(value.createdBy)
    && (value.status === 'active' || value.status === 'paused')
    && isString(value.prompt) && isTarget(value.target) && isSchedule(value.schedule)
    && (value.nextRunAt === null || isString(value.nextRunAt))
    && isString(value.createdAt) && isString(value.updatedAt)
}

function isRun(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.occurrenceId) || !isString(value.taskId) || !isString(value.operationId)
    || !isString(value.scheduledFor) || !isString(value.claimedAt) || !isString(value.updatedAt)
    || !['claimed', 'enqueued', 'failed', 'needs_review', 'skipped'].includes(String(value.status))
    || (value.sessionId !== undefined && !isString(value.sessionId))
    || (value.error !== undefined && !isString(value.error))) return false
  const task = value.task
  return isRecord(task) && isString(task.id) && Number.isSafeInteger(task.generation) && (task.generation as number) >= 1
    && isString(task.ownerKey) && isString(task.createdBy) && isString(task.prompt) && isTarget(task.target)
}

function isInboxReceipt(value: unknown): boolean {
  return isRecord(value) && isString(value.ownerKey) && isString(value.principal) && isString(value.updatedAt)
    && Array.isArray(value.occurrenceIds) && value.occurrenceIds.every(isString)
}

function isTarget(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === 'session') return isString(value.sessionId)
  return value.kind === 'workspace' && isString(value.workspaceId)
    && (value.workspaceName === undefined || isString(value.workspaceName))
    && (value.cwd === undefined || isString(value.cwd))
}

function isSchedule(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind)) return false
  try {
    validateSchedule(value as ScheduleSpec)
    return true
  } catch {
    return false
  }
}

function rollback(database: DatabaseSync): void {
  try { database.exec('ROLLBACK') } catch { /* Preserve the transaction failure. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string { return typeof value === 'string' }
