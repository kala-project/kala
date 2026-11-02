import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { QueuedUserMessage } from '../connection/dashboard-ns.js'
import {
  type MessageQueueAuthority,
  type MessageQueueClaim,
  type MessageQueueClaimResult,
  type MessageQueueMutation,
  QueueClaimFencedError,
  QueueItemClaimedError,
} from '../message-queue-authority.js'
import {
  MAX_CANCELLED_OPERATION_IDS,
  normalizeQueuedMessage,
  serializeQueuedMessage,
  type PersistedMessageQueueState,
} from '../message-queue-store.js'
import { SessionDeletingError } from './session-authority.js'

type ItemRow = { item: string }
type OperationRow = { item: string; status: 'queued' | 'dequeued' | 'cancelled' }
type ClaimRow = {
  session_id: string
  owner_id: string | null
  generation: number
  item_id: string | null
  operation_id: string | null
  expires_at: number | null
}
type ReceiptRow = {
  item_id: string
  owner_id: string
  generation: number
}

const UNKNOWN_SHELL_EXECUTION_ERROR = 'Shell execution result is unknown after queue lease takeover. Inspect the workspace, then delete/cancel this item and retry with a new operation ID if needed.'

export type SqliteMessageQueueMutation = MessageQueueMutation
export type SqliteMessageQueueClaim = MessageQueueClaim

/**
 * Durable SQLite queue authority for explicitly selected Portable storage.
 *
 * Claims never remove queue rows. BEGIN IMMEDIATE serializes each transition,
 * and monotonically increasing generations fence stale owners. When the
 * portable Session projection is in the same database, admission checks its
 * existence and deletion tombstone in that same transaction.
 */
export class SqliteMessageQueueStore implements MessageQueueAuthority {
  #database?: DatabaseSync
  readonly #maxCancelledOperationIds: number
  readonly #now: () => number

  constructor(
    readonly databasePath: string,
    options: { maxCancelledOperationIds?: number; now?: () => number } = {},
  ) {
    const limit = options.maxCancelledOperationIds ?? MAX_CANCELLED_OPERATION_IDS
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CANCELLED_OPERATION_IDS) {
      throw new RangeError(`maxCancelledOperationIds must be an integer between 0 and ${MAX_CANCELLED_OPERATION_IDS}`)
    }
    this.#maxCancelledOperationIds = limit
    this.#now = options.now ?? Date.now
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
        CREATE TABLE IF NOT EXISTS portable_message_queue_sessions (
          session_id TEXT PRIMARY KEY,
          initialized_at TEXT NOT NULL
        );
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
        CREATE TABLE IF NOT EXISTS portable_message_queue_claims (
          session_id TEXT PRIMARY KEY,
          owner_id TEXT,
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          item_id TEXT,
          operation_id TEXT,
          expires_at INTEGER,
          CHECK ((owner_id IS NULL AND item_id IS NULL AND operation_id IS NULL AND expires_at IS NULL)
            OR (owner_id IS NOT NULL AND item_id IS NOT NULL AND operation_id IS NOT NULL AND expires_at IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS portable_message_queue_receipts (
          session_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation > 0),
          completed_at TEXT NOT NULL,
          PRIMARY KEY (session_id, operation_id)
        );
        INSERT OR IGNORE INTO portable_message_queue_sessions (session_id, initialized_at)
          SELECT session_id, MIN(created_at) FROM portable_message_queue_items GROUP BY session_id;
        INSERT OR IGNORE INTO portable_message_queue_sessions (session_id, initialized_at)
          SELECT session_id, MIN(cancelled_at) FROM portable_message_queue_cancellations GROUP BY session_id;
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

  async loadOrInitialize(
    sessionId: string,
    legacyLoader: () => Promise<PersistedMessageQueueState>,
  ): Promise<PersistedMessageQueueState> {
    validateText(sessionId, 'sessionId')
    if (this.#isInitialized(this.#db(), sessionId)) return this.#loadState(this.#db(), sessionId)
    const legacy = normalizeState(await legacyLoader(), this.#maxCancelledOperationIds)
    return this.#transaction((database) => {
      if (this.#isInitialized(database, sessionId)) return this.#loadState(database, sessionId)
      this.#assertSessionAdmissible(database, sessionId)
      this.#initializeSession(database, sessionId)
      const cancelled = new Set(legacy.cancelledOperationIds)
      for (const operationId of legacy.cancelledOperationIds) this.#insertCancellation(database, sessionId, operationId)
      for (const item of legacy.items) {
        if (cancelled.has(item.operationId)) continue
        this.#insertOperation(database, sessionId, item)
      }
      this.#rewriteItems(database, sessionId, legacy.items.filter((item) => !cancelled.has(item.operationId)))
      return this.#loadState(database, sessionId)
    })
  }

  async enqueue(
    sessionId: string,
    item: QueuedUserMessage,
    priority: 'front' | 'back' = 'back',
  ): Promise<MessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    if (priority !== 'front' && priority !== 'back') throw new TypeError('priority must be front or back')
    const candidate = normalizeItem(item)
    return this.#transaction((database) => {
      this.#assertSessionAdmissible(database, sessionId)
      this.#initializeSession(database, sessionId)
      const existing = database.prepare(`
        SELECT item, status FROM portable_message_queue_operations
        WHERE session_id = ? AND operation_id = ?
      `).get(sessionId, candidate.operationId) as OperationRow | undefined
      if (existing) {
        assertOperationCompatible(parseItem(existing.item), candidate)
        return { state: this.#loadState(database, sessionId), changed: false }
      }
      if (this.#isCancelled(database, sessionId, candidate.operationId)) {
        return { state: this.#loadState(database, sessionId), changed: false }
      }
      const state = this.#loadState(database, sessionId)
      if (state.items.some(({ id }) => id === candidate.id)) throw new Error('message item ID conflict')
      let insertAt = state.items.length
      if (priority === 'front') {
        insertAt = this.#hasLiveClaim(this.#claimRow(database, sessionId)) ? 1 : 0
        while (state.items[insertAt]?.mode === 'steer') insertAt += 1
      }
      state.items.splice(insertAt, 0, candidate)
      this.#insertOperation(database, sessionId, candidate)
      this.#rewriteItems(database, sessionId, state.items)
      return { state, changed: true }
    })
  }

  async reorder(sessionId: string, id: string, beforeId?: string): Promise<MessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    validateText(id, 'id')
    return this.#mutation(sessionId, (database, state) => {
      this.#assertNotClaimed(database, sessionId, id, beforeId)
      const from = state.items.findIndex((item) => item.id === id)
      if (from === -1) return false
      const [item] = state.items.splice(from, 1)
      if (!item) return false
      const to = beforeId ? state.items.findIndex((candidate) => candidate.id === beforeId) : -1
      if (to === -1) state.items.push(item)
      else state.items.splice(to, 0, item)
      return true
    })
  }

  async update(sessionId: string, id: string, replacement: QueuedUserMessage): Promise<MessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    validateText(id, 'id')
    const candidate = normalizeItem(replacement)
    return this.#mutation(sessionId, (database, state) => {
      this.#assertNotClaimed(database, sessionId, id)
      const index = state.items.findIndex((item) => item.id === id)
      const current = state.items[index]
      if (!current) return false
      const next = { ...candidate, id: current.id, operationId: current.operationId, createdAt: current.createdAt }
      state.items[index] = next
      database.prepare(`UPDATE portable_message_queue_operations SET item = ?
        WHERE session_id = ? AND operation_id = ? AND status = 'queued'`)
        .run(serializeItem(next), sessionId, current.operationId)
      return true
    })
  }

  async delete(sessionId: string, id: string): Promise<MessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    validateText(id, 'id')
    return this.#transaction((database) => {
      this.#assertNotClaimed(database, sessionId, id)
      this.#initializeSession(database, sessionId)
      const state = this.#loadState(database, sessionId)
      const removed = state.items.filter((item) => item.id === id || item.operationId === id)
      const next = state.items.filter((item) => item.id !== id && item.operationId !== id)
      const operationIds = new Set([id, ...removed.map(({ operationId }) => operationId)])
      let changed = removed.length > 0
      for (const operationId of operationIds) {
        changed = this.#insertCancellation(database, sessionId, operationId) || changed
        database.prepare(`UPDATE portable_message_queue_operations SET status = 'cancelled'
          WHERE session_id = ? AND operation_id = ? AND status = 'queued'`).run(sessionId, operationId)
      }
      this.#assertCancellationLimit(database, sessionId)
      if (removed.length) this.#rewriteItems(database, sessionId, next)
      return { state: this.#loadState(database, sessionId), changed }
    })
  }

  /** Compatibility alias for callers that still name queue deletion cancel. */
  async cancel(sessionId: string, id: string): Promise<MessageQueueMutation> {
    return await this.delete(sessionId, id)
  }

  async stop(sessionId: string): Promise<MessageQueueMutation> {
    validateText(sessionId, 'sessionId')
    return this.#transaction((database) => {
      this.#initializeSession(database, sessionId)
      const state = this.#loadState(database, sessionId)
      const claim = this.#claimRow(database, sessionId)
      const operationIds = new Set(state.items.map(({ operationId }) => operationId))
      if (claim?.operation_id) operationIds.add(claim.operation_id)
      for (const operationId of operationIds) {
        this.#insertCancellation(database, sessionId, operationId)
        database.prepare(`UPDATE portable_message_queue_operations SET status = 'cancelled'
          WHERE session_id = ? AND operation_id = ? AND status = 'queued'`).run(sessionId, operationId)
      }
      this.#assertCancellationLimit(database, sessionId)
      if (state.items.length) this.#rewriteItems(database, sessionId, [])
      return { state: this.#loadState(database, sessionId), changed: state.items.length > 0 }
    })
  }

  async claimHead(sessionId: string, ownerId: string, ttlMs: number): Promise<MessageQueueClaimResult> {
    validateText(sessionId, 'sessionId')
    validateText(ownerId, 'ownerId')
    validateTtl(ttlMs)
    return this.#transaction((database) => {
      this.#initializeSession(database, sessionId)
      const state = this.#loadState(database, sessionId)
      const item = state.items[0]
      const previous = this.#ensureClaimRow(database, sessionId)
      if (!item || this.#hasLiveClaim(previous)) return { state }
      const takesOverSameItem = previous.owner_id !== null
        && previous.item_id === item.id && previous.operation_id === item.operationId
      if (takesOverSameItem && item.shell?.state === 'running' && !item.shell.result) {
        state.items[0] = { ...item, shell: { ...item.shell, state: 'unknown', error: UNKNOWN_SHELL_EXECUTION_ERROR } }
        this.#rewriteItems(database, sessionId, state.items)
        this.#clearClaim(database, sessionId)
        return { state, executionUnknown: true }
      }
      if (item.shell?.state === 'unknown' && !item.shell.result) return { state }
      const generation = previous.generation + 1
      if (!Number.isSafeInteger(generation)) throw new Error('SQLite message queue claim generation exhausted')
      const expiresAt = this.#now() + ttlMs
      database.prepare(`UPDATE portable_message_queue_claims
        SET owner_id = ?, generation = ?, item_id = ?, operation_id = ?, expires_at = ?
        WHERE session_id = ?`).run(ownerId, generation, item.id, item.operationId, expiresAt, sessionId)
      return {
        state,
        claim: { sessionId, item: cloneItem(item), ownerId, generation: BigInt(generation), expiresAt: new Date(expiresAt) },
      }
    })
  }

  async confirmClaim(claim: MessageQueueClaim): Promise<boolean> {
    validateClaim(claim)
    const database = this.#db()
    const row = this.#claimRow(database, claim.sessionId)
    if (!this.#matchesClaim(row, claim, true)) return false
    const head = this.#loadState(database, claim.sessionId).items[0]
    return head?.id === claim.item.id && head.operationId === claim.item.operationId
  }

  async completeClaim(claim: MessageQueueClaim): Promise<MessageQueueMutation> {
    validateClaim(claim)
    return this.#transaction((database) => {
      const receipt = this.#receipt(database, claim.sessionId, claim.item.operationId)
      if (receipt) {
        if (receipt.item_id === claim.item.id && receipt.owner_id === claim.ownerId
          && BigInt(receipt.generation) === claim.generation) {
          return { state: this.#loadState(database, claim.sessionId), changed: false }
        }
        throw new QueueClaimFencedError()
      }
      this.#assertClaim(database, claim, true)
      const state = this.#loadState(database, claim.sessionId)
      const head = state.items[0]
      if (!head || head.id !== claim.item.id || head.operationId !== claim.item.operationId) throw new QueueClaimFencedError()
      state.items.shift()
      this.#rewriteItems(database, claim.sessionId, state.items)
      const completed = database.prepare(`UPDATE portable_message_queue_operations SET status = 'dequeued'
        WHERE session_id = ? AND operation_id = ? AND status = 'queued'`).run(claim.sessionId, claim.item.operationId)
      if (completed.changes !== 1) throw new QueueClaimFencedError()
      database.prepare(`INSERT INTO portable_message_queue_receipts
        (session_id, operation_id, item_id, owner_id, generation, completed_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(claim.sessionId, claim.item.operationId, claim.item.id, claim.ownerId, claimGeneration(claim), this.#isoNow())
      this.#clearClaim(database, claim.sessionId)
      return { state, changed: true }
    })
  }

  async persistShellResult(
    claim: MessageQueueClaim,
    shell: NonNullable<QueuedUserMessage['shell']>,
  ): Promise<MessageQueueMutation> {
    validateClaim(claim)
    return this.#transaction((database) => {
      this.#assertClaim(database, claim, true)
      const state = this.#loadState(database, claim.sessionId)
      const head = state.items[0]
      if (!head?.shell || head.id !== claim.item.id || head.operationId !== claim.item.operationId
        || state.cancelledOperationIds.includes(head.operationId)) throw new QueueClaimFencedError()
      if (JSON.stringify(head.shell) === JSON.stringify(shell)) return { state, changed: false }
      state.items[0] = { ...head, shell }
      database.prepare(`UPDATE portable_message_queue_operations SET item = ?
        WHERE session_id = ? AND operation_id = ? AND status = 'queued'`)
        .run(serializeItem(state.items[0]), claim.sessionId, head.operationId)
      this.#rewriteItems(database, claim.sessionId, state.items)
      return { state, changed: true }
    })
  }

  async renewClaim(claim: MessageQueueClaim, ttlMs: number): Promise<MessageQueueClaim> {
    validateClaim(claim)
    validateTtl(ttlMs)
    return this.#transaction((database) => {
      this.#assertClaim(database, claim, true)
      const expiresAt = this.#now() + ttlMs
      database.prepare(`UPDATE portable_message_queue_claims SET expires_at = ? WHERE session_id = ?`)
        .run(expiresAt, claim.sessionId)
      return { ...claim, expiresAt: new Date(expiresAt) }
    })
  }

  async releaseClaim(claim: MessageQueueClaim): Promise<boolean> {
    validateClaim(claim)
    return this.#transaction((database) => {
      if (!this.#matchesClaim(this.#claimRow(database, claim.sessionId), claim, true)) return false
      this.#clearClaim(database, claim.sessionId)
      return true
    })
  }

  async markExecutionUnknown(claim: MessageQueueClaim): Promise<MessageQueueMutation> {
    validateClaim(claim)
    return this.#transaction((database) => {
      this.#assertClaim(database, claim, false)
      const state = this.#loadState(database, claim.sessionId)
      const head = state.items[0]
      if (!head?.shell || head.id !== claim.item.id || head.operationId !== claim.item.operationId) {
        throw new QueueClaimFencedError()
      }
      if (head.shell.result) throw new QueueClaimFencedError()
      const changed = head.shell.state !== 'unknown'
      if (changed) {
        state.items[0] = { ...head, shell: { ...head.shell, state: 'unknown', error: UNKNOWN_SHELL_EXECUTION_ERROR } }
        database.prepare(`UPDATE portable_message_queue_operations SET item = ?
          WHERE session_id = ? AND operation_id = ? AND status = 'queued'`)
          .run(serializeItem(state.items[0]), claim.sessionId, head.operationId)
        this.#rewriteItems(database, claim.sessionId, state.items)
      }
      this.#clearClaim(database, claim.sessionId)
      return { state, changed }
    })
  }

  async close(): Promise<void> {
    this.#database?.close()
    this.#database = undefined
  }

  #mutation(
    sessionId: string,
    mutation: (database: DatabaseSync, state: PersistedMessageQueueState) => boolean,
  ): MessageQueueMutation {
    return this.#transaction((database) => {
      this.#initializeSession(database, sessionId)
      const state = this.#loadState(database, sessionId)
      const changed = mutation(database, state)
      if (changed) this.#rewriteItems(database, sessionId, state.items)
      return { state, changed }
    })
  }

  #transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.#db()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation(database)
      database.exec('COMMIT')
      return result
    } catch (error) {
      try { database.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
  }

  #loadState(database: DatabaseSync, sessionId: string): PersistedMessageQueueState {
    const itemRows = database.prepare(`SELECT item FROM portable_message_queue_items
      WHERE session_id = ? ORDER BY position ASC, sequence ASC`).all(sessionId) as unknown as ItemRow[]
    const cancellationRows = database.prepare(`SELECT operation_id FROM portable_message_queue_cancellations
      WHERE session_id = ? ORDER BY sequence ASC`).all(sessionId) as unknown as Array<{ operation_id: string }>
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

  #rewriteItems(database: DatabaseSync, sessionId: string, items: readonly QueuedUserMessage[]): void {
    database.prepare('DELETE FROM portable_message_queue_items WHERE session_id = ?').run(sessionId)
    const insert = database.prepare(`INSERT INTO portable_message_queue_items
      (session_id, position, item_id, operation_id, item, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    items.forEach((item, index) => insert.run(sessionId, index, item.id, item.operationId, serializeItem(item), item.createdAt))
  }

  #insertOperation(database: DatabaseSync, sessionId: string, item: QueuedUserMessage): void {
    database.prepare(`INSERT INTO portable_message_queue_operations (session_id, operation_id, item, status)
      VALUES (?, ?, ?, 'queued')`).run(sessionId, item.operationId, serializeItem(item))
  }

  #insertCancellation(database: DatabaseSync, sessionId: string, operationId: string): boolean {
    return database.prepare(`INSERT INTO portable_message_queue_cancellations
      (session_id, operation_id, cancelled_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id, operation_id) DO NOTHING`).run(sessionId, operationId, this.#isoNow()).changes === 1
  }

  #isCancelled(database: DatabaseSync, sessionId: string, operationId: string): boolean {
    return database.prepare(`SELECT 1 FROM portable_message_queue_cancellations
      WHERE session_id = ? AND operation_id = ?`).get(sessionId, operationId) !== undefined
  }

  #assertCancellationLimit(database: DatabaseSync, sessionId: string): void {
    const { count } = database.prepare(`SELECT COUNT(*) AS count FROM portable_message_queue_cancellations
      WHERE session_id = ?`).get(sessionId) as { count: number }
    if (count > this.#maxCancelledOperationIds) {
      throw new Error(`message queue cancellation tombstone limit of ${this.#maxCancelledOperationIds} exceeded; existing cancellations were preserved`)
    }
  }

  #isInitialized(database: DatabaseSync, sessionId: string): boolean {
    return database.prepare('SELECT 1 FROM portable_message_queue_sessions WHERE session_id = ?').get(sessionId) !== undefined
  }

  #initializeSession(database: DatabaseSync, sessionId: string): void {
    database.prepare(`INSERT INTO portable_message_queue_sessions (session_id, initialized_at) VALUES (?, ?)
      ON CONFLICT(session_id) DO NOTHING`).run(sessionId, this.#isoNow())
  }

  #assertSessionAdmissible(database: DatabaseSync, sessionId: string): void {
    const hasSessions = database.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'portable_sessions'`).get() !== undefined
    if (!hasSessions) return
    const row = database.prepare('SELECT deleting FROM portable_sessions WHERE session_id = ?').get(sessionId) as
      | { deleting: number }
      | undefined
    if (!row || row.deleting !== 0) throw new SessionDeletingError(sessionId)
  }

  #ensureClaimRow(database: DatabaseSync, sessionId: string): ClaimRow {
    database.prepare(`INSERT INTO portable_message_queue_claims (session_id) VALUES (?)
      ON CONFLICT(session_id) DO NOTHING`).run(sessionId)
    return this.#claimRow(database, sessionId)!
  }

  #claimRow(database: DatabaseSync, sessionId: string): ClaimRow | undefined {
    return database.prepare('SELECT * FROM portable_message_queue_claims WHERE session_id = ?').get(sessionId) as ClaimRow | undefined
  }

  #hasLiveClaim(row: ClaimRow | undefined): boolean {
    return Boolean(row && row.owner_id !== null && row.expires_at !== null && row.expires_at > this.#now())
  }

  #matchesClaim(row: ClaimRow | undefined, claim: MessageQueueClaim, requireLive: boolean): boolean {
    if (!row || row.owner_id !== claim.ownerId || BigInt(row.generation) !== claim.generation
      || row.item_id !== claim.item.id || row.operation_id !== claim.item.operationId) return false
    return !requireLive || (row.expires_at !== null && row.expires_at > this.#now())
  }

  #assertClaim(database: DatabaseSync, claim: MessageQueueClaim, requireLive: boolean): void {
    if (!this.#matchesClaim(this.#claimRow(database, claim.sessionId), claim, requireLive)) throw new QueueClaimFencedError()
  }

  #assertNotClaimed(database: DatabaseSync, sessionId: string, ...ids: (string | undefined)[]): void {
    const row = this.#claimRow(database, sessionId)
    if (!this.#hasLiveClaim(row)) return
    if (ids.some((id) => id && (id === row?.item_id || id === row?.operation_id))) {
      throw new QueueItemClaimedError(row!.item_id!)
    }
  }

  #clearClaim(database: DatabaseSync, sessionId: string): void {
    database.prepare(`UPDATE portable_message_queue_claims
      SET owner_id = NULL, item_id = NULL, operation_id = NULL, expires_at = NULL WHERE session_id = ?`).run(sessionId)
  }

  #receipt(database: DatabaseSync, sessionId: string, operationId: string): ReceiptRow | undefined {
    return database.prepare(`SELECT item_id, owner_id, generation FROM portable_message_queue_receipts
      WHERE session_id = ? AND operation_id = ?`).get(sessionId, operationId) as ReceiptRow | undefined
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }

  #db(): DatabaseSync {
    if (!this.#database) throw new Error('SQLite message queue is not initialized')
    return this.#database
  }
}

function normalizeState(state: PersistedMessageQueueState, cancellationLimit: number): PersistedMessageQueueState {
  if (!Array.isArray(state.items) || !Array.isArray(state.cancelledOperationIds)) throw new TypeError('invalid legacy message queue state')
  const items = state.items.map(normalizeItem)
  const cancelledOperationIds = state.cancelledOperationIds.map((value) => {
    validateText(value, 'cancelled operation ID')
    return value
  })
  if (new Set(cancelledOperationIds).size !== cancelledOperationIds.length) throw new Error('duplicate message queue cancellation tombstone')
  if (cancelledOperationIds.length > cancellationLimit) throw new Error(`message queue cancellation tombstone limit of ${cancellationLimit} exceeded`)
  if (new Set(items.map(({ id }) => id)).size !== items.length
    || new Set(items.map(({ operationId }) => operationId)).size !== items.length) throw new Error('duplicate legacy message queue item')
  return { items, cancelledOperationIds }
}

function normalizeItem(item: QueuedUserMessage): QueuedUserMessage {
  validateText(item.id, 'item.id')
  validateText(item.operationId, 'item.operationId')
  const normalized = normalizeQueuedMessage(serializeQueuedMessage(item))
  if (!normalized) throw new TypeError('invalid queued message')
  return normalized
}

function serializeItem(item: QueuedUserMessage): string {
  return JSON.stringify(serializeQueuedMessage(item))
}

function parseItem(value: string): QueuedUserMessage {
  const normalized = normalizeQueuedMessage(JSON.parse(value) as unknown)
  if (!normalized) throw new Error('invalid SQLite message queue item')
  return normalized
}

function cloneItem(item: QueuedUserMessage): QueuedUserMessage {
  return parseItem(serializeItem(item))
}

function assertOperationCompatible(existing: QueuedUserMessage, candidate: QueuedUserMessage): void {
  if (existing.text !== candidate.text || JSON.stringify(existing.content ?? []) !== JSON.stringify(candidate.content ?? [])
    || existing.shell?.command !== candidate.shell?.command) throw new Error('message operation ID conflict')
}

function claimGeneration(claim: MessageQueueClaim): number {
  const generation = Number(claim.generation)
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new QueueClaimFencedError()
  return generation
}

function validateClaim(claim: MessageQueueClaim): void {
  validateText(claim.sessionId, 'claim.sessionId')
  validateText(claim.ownerId, 'claim.ownerId')
  validateText(claim.item.id, 'claim.item.id')
  validateText(claim.item.operationId, 'claim.item.operationId')
  claimGeneration(claim)
}

function validateText(value: string, name: string): void {
  if (!value) throw new TypeError(`${name} must be a non-empty string`)
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive safe integer')
}
