import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { QueuedUserMessage } from '../connection/dashboard-ns.js'
import {
  MAX_CANCELLED_OPERATION_IDS,
  normalizeQueuedMessage,
  serializeQueuedMessage,
  type PersistedMessageQueueState,
} from '../message-queue-store.js'

type ItemRow = {
  item: string
}

type OperationRow = {
  item: string
  status: 'queued' | 'dequeued' | 'cancelled'
}

export type SqliteMessageQueueMutation = {
  state: PersistedMessageQueueState
  changed: boolean
}

export type SqliteMessageQueueDequeue = SqliteMessageQueueMutation & {
  item?: QueuedUserMessage
}

/**
 * Isolated SQLite Queue authority for explicitly selected Portable storage.
 *
 * The tables deliberately have their own prefix, do not alter user_version,
 * and are never initialized unless this adapter is explicitly constructed and
 * initialized. Queue writes use independent immediate transactions; this slice
 * does not imply atomic admission with the separate Session authority.
 */
export class SqliteMessageQueueStore {
  #database?: DatabaseSync
  readonly #maxCancelledOperationIds: number

  constructor(
    readonly databasePath: string,
    options: { maxCancelledOperationIds?: number } = {},
  ) {
    const limit = options.maxCancelledOperationIds ?? MAX_CANCELLED_OPERATION_IDS
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CANCELLED_OPERATION_IDS) {
      throw new RangeError(`maxCancelledOperationIds must be an integer between 0 and ${MAX_CANCELLED_OPERATION_IDS}`)
    }
    this.#maxCancelledOperationIds = limit
  }

  async initialize(): Promise<void> {
    if (this.#database) return
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(this.databasePath)
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS portable_message_queue_items (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          item_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          item TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (session_id, position),
          UNIQUE (session_id, item_id),
          UNIQUE (session_id, operation_id)
        );
        CREATE INDEX IF NOT EXISTS portable_message_queue_items_order_idx
          ON portable_message_queue_items(session_id, position, sequence);
        CREATE TABLE IF NOT EXISTS portable_message_queue_operations (
          session_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          item TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'dequeued', 'cancelled')),
          PRIMARY KEY (session_id, operation_id)
        );
        CREATE TABLE IF NOT EXISTS portable_message_queue_cancellations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          cancelled_at TEXT NOT NULL,
          UNIQUE (session_id, operation_id)
        );
        CREATE INDEX IF NOT EXISTS portable_message_queue_cancellations_session_idx
          ON portable_message_queue_cancellations(session_id, sequence);
      `)
      this.#database = database
    } catch (error) {
      database.close()
      throw error
    }
  }

  async load(sessionId: string): Promise<PersistedMessageQueueState> {
    validateText(sessionId, 'sessionId')
    return this.#loadState(this.#db(), sessionId)
  }

  async enqueue(
    sessionId: string,
    item: QueuedUserMessage,
    priority: 'front' | 'back' = 'back',
  ): Promise<SqliteMessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    if (priority !== 'front' && priority !== 'back') throw new TypeError('priority must be front or back')
    const candidate = normalizeItem(item)
    return this.#transaction((database) => {
      const existing = database.prepare(`
        SELECT item, status FROM portable_message_queue_operations
        WHERE session_id = ? AND operation_id = ?
      `).get(sessionId, candidate.operationId) as OperationRow | undefined
      if (existing) {
        assertOperationCompatible(parseItem(existing.item), candidate)
        return { state: this.#loadState(database, sessionId), changed: false }
      }
      const itemId = database.prepare(`
        SELECT item FROM portable_message_queue_items WHERE session_id = ? AND item_id = ?
      `).get(sessionId, candidate.id) as OperationRow | undefined
      if (itemId) throw new Error('message item ID conflict')
      if (this.#isCancelled(database, sessionId, candidate.operationId)) {
        return { state: this.#loadState(database, sessionId), changed: false }
      }
      const position = database.prepare(`
        SELECT CASE ?
          WHEN 'front' THEN COALESCE(MIN(position), 0) - 1
          ELSE COALESCE(MAX(position), 0) + 1
        END AS position
        FROM portable_message_queue_items WHERE session_id = ?
      `).get(priority, sessionId) as { position: number }
      const serialized = JSON.stringify(serializeQueuedMessage(candidate))
      database.prepare(`
        INSERT INTO portable_message_queue_operations (session_id, operation_id, item, status)
        VALUES (?, ?, ?, 'queued')
      `).run(sessionId, candidate.operationId, serialized)
      database.prepare(`
        INSERT INTO portable_message_queue_items
          (session_id, position, item_id, operation_id, item, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, position.position, candidate.id, candidate.operationId, serialized, new Date().toISOString())
      return { state: this.#loadState(database, sessionId), changed: true }
    })
  }

  /** Cancel an item or future retry by item ID or operation ID. */
  async cancel(sessionId: string, id: string): Promise<SqliteMessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    validateText(id, 'id')
    return this.#transaction((database) => {
      const matches = database.prepare(`
        SELECT operation_id FROM portable_message_queue_items
        WHERE session_id = ? AND (item_id = ? OR operation_id = ?)
      `).all(sessionId, id, id) as unknown as Array<{ operation_id: string }>
      const operationIds = new Set([id, ...matches.map(({ operation_id }) => operation_id)])
      let changed = matches.length > 0
      for (const operationId of operationIds) {
        const inserted = database.prepare(`
          INSERT INTO portable_message_queue_cancellations
            (session_id, operation_id, cancelled_at)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id, operation_id) DO NOTHING
        `).run(sessionId, operationId, new Date().toISOString())
        changed ||= inserted.changes === 1
      }
      this.#assertCancellationLimit(database, sessionId)
      for (const operationId of operationIds) {
        database.prepare(`
          UPDATE portable_message_queue_operations SET status = 'cancelled'
          WHERE session_id = ? AND operation_id = ? AND status = 'queued'
        `).run(sessionId, operationId)
      }
      database.prepare(`
        DELETE FROM portable_message_queue_items
        WHERE session_id = ? AND (item_id = ? OR operation_id = ?)
      `).run(sessionId, id, id)
      return { state: this.#loadState(database, sessionId), changed }
    })
  }

  /** Atomically reads and removes the current head item. */
  async dequeue(sessionId: string): Promise<SqliteMessageQueueDequeue> {
    validateText(sessionId, 'sessionId')
    return this.#transaction((database) => {
      const row = database.prepare(`
        SELECT item FROM portable_message_queue_items
        WHERE session_id = ? ORDER BY position ASC, sequence ASC LIMIT 1
      `).get(sessionId) as ItemRow | undefined
      if (!row) return { state: this.#loadState(database, sessionId), changed: false }
      const item = parseItem(row.item)
      const removed = database.prepare(`
        DELETE FROM portable_message_queue_items
        WHERE session_id = ? AND operation_id = ?
      `).run(sessionId, item.operationId)
      if (removed.changes !== 1) throw new Error('message queue head disappeared while dequeuing')
      const receipt = database.prepare(`
        UPDATE portable_message_queue_operations SET status = 'dequeued'
        WHERE session_id = ? AND operation_id = ? AND status = 'queued'
      `).run(sessionId, item.operationId)
      if (receipt.changes !== 1) throw new Error('message queue operation receipt disappeared while dequeuing')
      return { item, state: this.#loadState(database, sessionId), changed: true }
    })
  }

  async close(): Promise<void> {
    this.#database?.close()
    this.#database = undefined
  }

  #transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.#db()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation(database)
      database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original mutation or commit failure.
      }
      throw error
    }
  }

  #loadState(database: DatabaseSync, sessionId: string): PersistedMessageQueueState {
    const itemRows = database.prepare(`
      SELECT item FROM portable_message_queue_items
      WHERE session_id = ? ORDER BY position ASC, sequence ASC
    `).all(sessionId) as unknown as ItemRow[]
    const cancellationRows = database.prepare(`
      SELECT operation_id FROM portable_message_queue_cancellations
      WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId) as unknown as Array<{ operation_id: string }>
    if (cancellationRows.length > this.#maxCancelledOperationIds) {
      throw new Error(`message queue cancellation tombstone limit of ${this.#maxCancelledOperationIds} exceeded`)
    }
    const cancelledOperationIds = cancellationRows.map(({ operation_id }) => operation_id)
    const cancelled = new Set(cancelledOperationIds)
    return {
      items: itemRows.map(({ item }) => parseItem(item)).filter((item) => !cancelled.has(item.operationId)),
      cancelledOperationIds,
    }
  }

  #isCancelled(database: DatabaseSync, sessionId: string, operationId: string): boolean {
    return database.prepare(`
      SELECT 1 FROM portable_message_queue_cancellations
      WHERE session_id = ? AND operation_id = ?
    `).get(sessionId, operationId) !== undefined
  }

  #assertCancellationLimit(database: DatabaseSync, sessionId: string): void {
    const { count } = database.prepare(`
      SELECT COUNT(*) AS count FROM portable_message_queue_cancellations WHERE session_id = ?
    `).get(sessionId) as { count: number }
    if (count > this.#maxCancelledOperationIds) {
      throw new Error(`message queue cancellation tombstone limit of ${this.#maxCancelledOperationIds} exceeded; existing cancellations were preserved`)
    }
  }

  #db(): DatabaseSync {
    if (!this.#database) throw new Error('SQLite message queue is not initialized')
    return this.#database
  }
}

function normalizeItem(item: QueuedUserMessage): QueuedUserMessage {
  validateText(item.id, 'item.id')
  validateText(item.operationId, 'item.operationId')
  const normalized = normalizeQueuedMessage(serializeQueuedMessage(item))
  if (!normalized) throw new TypeError('invalid queued message')
  return normalized
}

function parseItem(value: string): QueuedUserMessage {
  const normalized = normalizeQueuedMessage(JSON.parse(value) as unknown)
  if (!normalized) throw new Error('invalid SQLite message queue item')
  return normalized
}

function assertOperationCompatible(existing: QueuedUserMessage, candidate: QueuedUserMessage): void {
  if (existing.text !== candidate.text || JSON.stringify(existing.content ?? []) !== JSON.stringify(candidate.content ?? [])
    || existing.shell?.command !== candidate.shell?.command) throw new Error('message operation ID conflict')
}

function validateText(value: string, name: string): void {
  if (!value) throw new TypeError(`${name} must be a non-empty string`)
}
