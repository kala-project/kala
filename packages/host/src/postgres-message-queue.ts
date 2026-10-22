import type { QueuedUserMessage } from './connection/dashboard-ns.js'
import {
  MAX_CANCELLED_OPERATION_IDS,
  normalizeQueuedMessage,
  serializeQueuedMessage,
  type PersistedMessageQueueState,
} from './message-queue-store.js'
import type { PostgresSchemaManagement } from './postgres-migrations.js'
import type { HotStateDatabase, HotStateSqlExecutor } from './tenant-runtime/postgres-hot-state.js'

export type PostgresMessageQueueClaim = {
  sessionId: string
  item: QueuedUserMessage
  ownerId: string
  generation: bigint
  expiresAt: Date
}

const UNKNOWN_SHELL_EXECUTION_ERROR = 'Shell execution result is unknown after queue lease takeover. Inspect the workspace, then delete/cancel this item and retry with a new operation ID if needed.'

type QueueRow = Record<string, unknown> & {
  items: unknown
  cancelled_operation_ids: unknown
  claim_owner: string | null
  claim_generation: string
  claim_item_id: string | null
  claim_operation_id: string | null
  claim_expires_at: Date | null
  claim_is_live?: boolean
}

export class QueueClaimFencedError extends Error {
  readonly code = 'QUEUE_CLAIM_FENCED'
  constructor() {
    super('message queue claim was expired or fenced by a newer owner or generation')
    this.name = 'QueueClaimFencedError'
  }
}

export class QueueItemClaimedError extends Error {
  constructor(readonly itemId: string) {
    super(`queued message ${itemId} is already dispatching`)
    this.name = 'QueueItemClaimedError'
  }
}

/** PostgreSQL authority for Private Cloud queued user messages. */
export class PostgresMessageQueueStore {
  readonly #table: string
  readonly #schemaManagement: PostgresSchemaManagement
  readonly #fenceSession?: (transaction: HotStateSqlExecutor, sessionId: string) => Promise<void>
  readonly #prepareSession?: (sessionId: string) => Promise<void>
  readonly #assertSessionAdmissible?: (transaction: HotStateSqlExecutor, sessionId: string) => Promise<void>
  #ready: Promise<void> | undefined

  constructor(
    readonly database: HotStateDatabase,
    readonly tenantId: string,
    options: {
      schema?: string
      schemaManagement?: PostgresSchemaManagement
      /** Optional Session owner check, required within the same SQL transaction as every queue write. */
      fenceSession?: (transaction: HotStateSqlExecutor, sessionId: string) => Promise<void>
      /** Acquire a server-side Session owner before taking any PG transaction locks. */
      prepareSession?: (sessionId: string) => Promise<void>
      /** Locks the Session projection so new admissions serialize with deletion tombstones. */
      assertSessionAdmissible?: (transaction: HotStateSqlExecutor, sessionId: string) => Promise<void>
    } = {},
  ) {
    if (!tenantId) throw new TypeError('tenantId must be a non-empty string')
    this.#table = `${quoteIdentifier(options.schema ?? 'public')}.tenant_session_message_queue`
    this.#schemaManagement = options.schemaManagement ?? 'initialize'
    if (options.fenceSession && this.#schemaManagement !== 'external') {
      throw new TypeError('Session owner fencing requires an operator-migrated message queue schema')
    }
    if (options.prepareSession && !options.fenceSession) {
      throw new TypeError('Session preparation requires a same-transaction Session owner fence')
    }
    this.#fenceSession = options.fenceSession
    this.#prepareSession = options.prepareSession
    this.#assertSessionAdmissible = options.assertSessionAdmissible
  }

  initialize(): Promise<void> {
    if (this.#schemaManagement === 'external') return Promise.resolve()
    return this.#ready ??= this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
      cancelled_operation_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cancelled_operation_ids) = 'array'),
      claim_owner text,
      claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claim_item_id text,
      claim_operation_id text,
      claim_expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, session_id),
      CHECK ((claim_owner IS NULL AND claim_item_id IS NULL AND claim_operation_id IS NULL AND claim_expires_at IS NULL)
        OR (claim_owner IS NOT NULL AND claim_item_id IS NOT NULL AND claim_operation_id IS NOT NULL AND claim_expires_at IS NOT NULL))
    )`).then(() => undefined)
  }

  async load(sessionId: string): Promise<PersistedMessageQueueState> {
    await this.initialize()
    validateText(sessionId, 'sessionId')
    const result = await this.#sessionQuery<QueueRow>(sessionId, `SELECT * FROM ${this.#table}
      WHERE tenant_id = $1 AND session_id = $2`, [this.tenantId, sessionId])
    return result.rows[0] ? stateFromRow(result.rows[0]) : emptyState()
  }

  /** Atomically imports the last authority snapshot only when no PG queue row exists yet. */
  async loadOrInitialize(
    sessionId: string,
    legacyLoader: () => Promise<PersistedMessageQueueState>,
  ): Promise<PersistedMessageQueueState> {
    await this.initialize()
    validateText(sessionId, 'sessionId')
    const existing = await this.#sessionQuery<QueueRow>(sessionId, `SELECT * FROM ${this.#table}
      WHERE tenant_id = $1 AND session_id = $2`, [this.tenantId, sessionId])
    if (existing.rows[0]) return stateFromRow(existing.rows[0])
    const legacy = await legacyLoader()
    assertCancellationLimit(new Set(legacy.cancelledOperationIds))
    return await this.#sessionTransaction(sessionId, async (transaction) => {
      await transaction.query(`INSERT INTO ${this.#table}
        (tenant_id, session_id, items, cancelled_operation_ids)
        VALUES ($1, $2, $3::jsonb, $4::jsonb)
        ON CONFLICT (tenant_id, session_id) DO NOTHING`, [
        this.tenantId,
        sessionId,
        JSON.stringify(legacy.items.map(serializeQueuedMessage)),
        JSON.stringify(legacy.cancelledOperationIds),
      ])
      const selected = await transaction.query<QueueRow>(`SELECT * FROM ${this.#table}
        WHERE tenant_id = $1 AND session_id = $2 FOR UPDATE`, [this.tenantId, sessionId])
      const row = selected.rows[0]
      if (!row) throw new Error('message queue row disappeared while initializing')
      return stateFromRow(row)
    })
  }

  async enqueue(
    sessionId: string,
    item: QueuedUserMessage,
    priority: 'front' | 'back',
  ): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#transactionRow(sessionId, async (transaction, row) => {
      const result = this.#enqueueState(row, item, priority)
      if (result.changed) await this.#write(transaction, sessionId, result.state, false)
      return result
    }, true)
  }

  /** Called only as a side effect of an attachment metadata event in the same PG transaction. */
  async enqueueWithinTransaction(
    transaction: HotStateSqlExecutor, sessionId: string, item: QueuedUserMessage, priority: 'front' | 'back',
  ): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    validateText(sessionId, 'sessionId')
    await this.#fenceSession?.(transaction, sessionId)
    await this.#assertSessionAdmissible?.(transaction, sessionId)
    await transaction.query(`INSERT INTO ${this.#table} (tenant_id, session_id) VALUES ($1, $2)
      ON CONFLICT (tenant_id, session_id) DO NOTHING`, [this.tenantId, sessionId])
    const selected = await transaction.query<QueueRow>(`SELECT *, (claim_expires_at > clock_timestamp()) AS claim_is_live FROM ${this.#table}
      WHERE tenant_id = $1 AND session_id = $2 FOR UPDATE`, [this.tenantId, sessionId])
    const row = selected.rows[0]
    if (!row) throw new Error('message queue row disappeared while locked')
    const result = this.#enqueueState(row, item, priority)
    if (result.changed) await this.#write(transaction, sessionId, result.state, false)
    return result
  }

  #enqueueState(row: QueueRow, item: QueuedUserMessage, priority: 'front' | 'back'): { state: PersistedMessageQueueState; changed: boolean } {
    const state = stateFromRow(row)
    const existing = state.items.find((candidate) => candidate.operationId === item.operationId)
    if (existing) {
      assertOperationCompatible(existing, item)
      return { state, changed: false }
    }
    if (state.cancelledOperationIds.includes(item.operationId)) return { state, changed: false }
    if (priority === 'back') state.items.push(item)
    else {
      let insertAt = hasLiveClaim(row) ? 1 : 0
      while (state.items[insertAt]?.mode === 'steer') insertAt += 1
      state.items.splice(insertAt, 0, item)
    }
    return { state, changed: true }
  }

  async reorder(sessionId: string, id: string, beforeId?: string): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#mutate(sessionId, (row) => {
      assertNotClaimed(row, id, beforeId)
      const state = stateFromRow(row)
      const from = state.items.findIndex((item) => item.id === id)
      if (from === -1) return { state, changed: false }
      const [item] = state.items.splice(from, 1)
      if (!item) return { state, changed: false }
      const to = beforeId ? state.items.findIndex((candidate) => candidate.id === beforeId) : -1
      if (to === -1) state.items.push(item)
      else state.items.splice(to, 0, item)
      return { state, changed: true }
    })
  }

  async update(sessionId: string, id: string, replacement: QueuedUserMessage): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#mutate(sessionId, (row) => {
      assertNotClaimed(row, id)
      const state = stateFromRow(row)
      const index = state.items.findIndex((item) => item.id === id)
      if (index === -1) return { state, changed: false }
      state.items[index] = { ...replacement, id: state.items[index]!.id, operationId: state.items[index]!.operationId, createdAt: state.items[index]!.createdAt }
      return { state, changed: true }
    })
  }

  async delete(sessionId: string, id: string): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#mutate(sessionId, (row) => {
      assertNotClaimed(row, id)
      const state = stateFromRow(row)
      const removed = state.items.filter((item) => item.id === id || item.operationId === id)
      const next = state.items.filter((item) => item.id !== id && item.operationId !== id)
      const cancelled = new Set(state.cancelledOperationIds)
      for (const operationId of [id, ...removed.map((item) => item.operationId)]) cancelled.add(operationId)
      assertCancellationLimit(cancelled)
      const changed = next.length !== state.items.length || cancelled.size !== state.cancelledOperationIds.length
      return { state: { items: next, cancelledOperationIds: [...cancelled] }, changed }
    })
  }

  async stop(sessionId: string): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#mutate(sessionId, (row) => {
      const state = stateFromRow(row)
      const cancelled = new Set(state.cancelledOperationIds)
      for (const item of state.items) cancelled.add(item.operationId)
      if (row.claim_operation_id) cancelled.add(row.claim_operation_id)
      assertCancellationLimit(cancelled)
      return { state: { items: [], cancelledOperationIds: [...cancelled] }, changed: state.items.length > 0 }
    })
  }

  async claimHead(sessionId: string, ownerId: string, ttlMs: number): Promise<{ claim?: PostgresMessageQueueClaim; state: PersistedMessageQueueState; executionUnknown?: boolean }> {
    validateText(ownerId, 'ownerId')
    validateTtl(ttlMs)
    return await this.#transactionRow(sessionId, async (transaction, row) => {
      const state = stateFromRow(row)
      const item = state.items[0]
      if (!item || hasLiveClaim(row)) return { state }
      // A durable `running` marker is written immediately before the external
      // shell effect. If that owner's lease expired without a result receipt,
      // neither PostgreSQL nor a replacement Host can know whether the effect
      // happened. Atomically block the item instead of transferring a claim
      // that would execute it a second time.
      const takesOverSameItem = row.claim_owner !== null
        && row.claim_item_id === item.id
        && row.claim_operation_id === item.operationId
      if (takesOverSameItem && item.shell?.state === 'running' && !item.shell.result) {
        state.items[0] = {
          ...item,
          shell: { ...item.shell, state: 'unknown', error: UNKNOWN_SHELL_EXECUTION_ERROR },
        }
        await this.#write(transaction, sessionId, state, true)
        return { state, executionUnknown: true }
      }
      // Unknown effects require explicit operator action (delete/cancel and a
      // fresh operation ID); routine drain attempts must leave them untouched.
      if (item.shell?.state === 'unknown' && !item.shell.result) return { state }
      const claimed = await transaction.query<QueueRow>(`UPDATE ${this.#table}
        SET claim_owner = $3, claim_generation = claim_generation + 1,
          claim_item_id = $4, claim_operation_id = $5,
          claim_expires_at = clock_timestamp() + $6 * interval '1 millisecond', updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND session_id = $2
          AND (claim_owner IS NULL OR claim_expires_at <= clock_timestamp())
        RETURNING *`, [this.tenantId, sessionId, ownerId, item.id, item.operationId, ttlMs])
      const next = claimed.rows[0]
      if (!next) return { state }
      return {
        state,
        claim: {
          sessionId,
          item: cloneItem(item),
          ownerId,
          generation: BigInt(next.claim_generation),
          expiresAt: next.claim_expires_at!,
        },
      }
    })
  }

  async confirmClaim(claim: PostgresMessageQueueClaim): Promise<boolean> {
    await this.initialize()
    const result = await this.#sessionQuery(claim.sessionId, `SELECT 1 FROM ${this.#table}
      WHERE tenant_id = $1 AND session_id = $2 AND claim_owner = $3 AND claim_generation = $4
        AND claim_item_id = $5 AND claim_operation_id = $6 AND claim_expires_at > clock_timestamp()
        AND items->0->>'id' = $5 AND items->0->>'operationId' = $6
        AND NOT (cancelled_operation_ids ? $6)`, claimValues(this.tenantId, claim))
    return result.rowCount === 1
  }

  async completeClaim(claim: PostgresMessageQueueClaim): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#claimedMutation(claim, (state) => {
      const head = state.items[0]
      if (!head || head.id !== claim.item.id || head.operationId !== claim.item.operationId) throw new QueueClaimFencedError()
      state.items.shift()
      return { state, changed: true, clearClaim: true }
    })
  }

  async persistShellResult(
    claim: PostgresMessageQueueClaim,
    shell: NonNullable<QueuedUserMessage['shell']>,
  ): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#claimedMutation(claim, (state) => {
      const head = state.items[0]
      if (!head?.shell || head.id !== claim.item.id || head.operationId !== claim.item.operationId
        || state.cancelledOperationIds.includes(head.operationId)) throw new QueueClaimFencedError()
      state.items[0] = { ...head, shell }
      return { state, changed: true, clearClaim: false }
    })
  }

  async renewClaim(claim: PostgresMessageQueueClaim, ttlMs: number): Promise<PostgresMessageQueueClaim> {
    await this.initialize()
    validateTtl(ttlMs)
    const result = await this.#sessionQuery<{ claim_expires_at: Date }>(claim.sessionId, `UPDATE ${this.#table}
      SET claim_expires_at = clock_timestamp() + $7 * interval '1 millisecond', updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND session_id = $2 AND claim_owner = $3 AND claim_generation = $4
        AND claim_item_id = $5 AND claim_operation_id = $6 AND claim_expires_at > clock_timestamp()
      RETURNING claim_expires_at`, [...claimValues(this.tenantId, claim), ttlMs])
    const renewed = result.rows[0]
    if (!renewed) throw new QueueClaimFencedError()
    return { ...claim, expiresAt: renewed.claim_expires_at }
  }

  async releaseClaim(claim: PostgresMessageQueueClaim): Promise<boolean> {
    await this.initialize()
    const result = await this.#sessionQuery(claim.sessionId, `UPDATE ${this.#table}
      SET claim_owner = NULL, claim_item_id = NULL, claim_operation_id = NULL, claim_expires_at = NULL,
        updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND session_id = $2 AND claim_owner = $3 AND claim_generation = $4
        AND claim_item_id = $5 AND claim_operation_id = $6 AND claim_expires_at > clock_timestamp()`, claimValues(this.tenantId, claim))
    return result.rowCount === 1
  }

  async #claimedMutation(
    claim: PostgresMessageQueueClaim,
    mutation: (state: PersistedMessageQueueState) => { state: PersistedMessageQueueState; changed: boolean; clearClaim: boolean },
  ): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#transactionRow(claim.sessionId, async (transaction, row) => {
      assertClaim(row, claim)
      const result = mutation(stateFromRow(row))
      assertCancellationLimit(new Set(result.state.cancelledOperationIds))
      const updated = await transaction.query(`UPDATE ${this.#table}
        SET items = $7::jsonb, cancelled_operation_ids = $8::jsonb, updated_at = clock_timestamp()
          ${result.clearClaim ? ', claim_owner = NULL, claim_item_id = NULL, claim_operation_id = NULL, claim_expires_at = NULL' : ''}
        WHERE tenant_id = $1 AND session_id = $2 AND claim_owner = $3 AND claim_generation = $4
          AND claim_item_id = $5 AND claim_operation_id = $6 AND claim_expires_at > clock_timestamp()`, [
        ...claimValues(this.tenantId, claim),
        JSON.stringify(result.state.items.map(serializeQueuedMessage)),
        JSON.stringify(result.state.cancelledOperationIds),
      ])
      if (updated.rowCount !== 1) throw new QueueClaimFencedError()
      return { state: result.state, changed: result.changed }
    })
  }

  async #mutate(
    sessionId: string,
    mutation: (row: QueueRow) => { state: PersistedMessageQueueState; changed: boolean },
  ): Promise<{ state: PersistedMessageQueueState; changed: boolean }> {
    return await this.#transactionRow(sessionId, async (transaction, row) => {
      const result = mutation(row)
      if (result.changed) await this.#write(transaction, sessionId, result.state, false)
      return result
    })
  }

  async #transactionRow<T>(sessionId: string, operation: (transaction: HotStateSqlExecutor, row: QueueRow) => Promise<T>, admission = false): Promise<T> {
    await this.initialize()
    validateText(sessionId, 'sessionId')
    return await this.#sessionTransaction(sessionId, async (transaction) => {
      // Lock projection before Queue: delete requests update projection before stopping Queue.
      if (admission) await this.#assertSessionAdmissible?.(transaction, sessionId)
      await transaction.query(`INSERT INTO ${this.#table} (tenant_id, session_id) VALUES ($1, $2)
        ON CONFLICT (tenant_id, session_id) DO NOTHING`, [this.tenantId, sessionId])
      const selected = await transaction.query<QueueRow>(`SELECT *, (claim_expires_at > clock_timestamp()) AS claim_is_live FROM ${this.#table}
        WHERE tenant_id = $1 AND session_id = $2 FOR UPDATE`, [this.tenantId, sessionId])
      const row = selected.rows[0]
      if (!row) throw new Error('message queue row disappeared while locked')
      return await operation(transaction, row)
    })
  }

  async #sessionTransaction<T>(sessionId: string, operation: (transaction: HotStateSqlExecutor) => Promise<T>): Promise<T> {
    await this.#prepareSession?.(sessionId)
    return await this.database.transaction(async (transaction) => {
      if (this.#fenceSession) await this.#fenceSession(transaction, sessionId)
      return await operation(transaction)
    })
  }

  async #sessionQuery<Row extends Record<string, unknown>>(
    sessionId: string, text: string, values: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    if (!this.#fenceSession) return await this.database.query<Row>(text, values)
    return await this.#sessionTransaction(sessionId, async (transaction) => await transaction.query<Row>(text, values))
  }

  async #write(transaction: HotStateSqlExecutor, sessionId: string, state: PersistedMessageQueueState, clearClaim: boolean): Promise<void> {
    assertCancellationLimit(new Set(state.cancelledOperationIds))
    await transaction.query(`UPDATE ${this.#table}
      SET items = $3::jsonb, cancelled_operation_ids = $4::jsonb, updated_at = clock_timestamp()
        ${clearClaim ? ', claim_owner = NULL, claim_item_id = NULL, claim_operation_id = NULL, claim_expires_at = NULL' : ''}
      WHERE tenant_id = $1 AND session_id = $2`, [
      this.tenantId,
      sessionId,
      JSON.stringify(state.items.map(serializeQueuedMessage)),
      JSON.stringify(state.cancelledOperationIds),
    ])
  }
}

function stateFromRow(row: QueueRow): PersistedMessageQueueState {
  if (!Array.isArray(row.items) || !Array.isArray(row.cancelled_operation_ids)) throw new Error('invalid PostgreSQL message queue state')
  const items = row.items.map(normalizeQueuedMessage)
  if (items.some((item) => !item)) throw new Error('invalid PostgreSQL message queue item')
  const cancelledOperationIds = row.cancelled_operation_ids.map((value) => {
    if (typeof value !== 'string' || !value) throw new Error('invalid PostgreSQL message queue cancellation tombstone')
    return value
  })
  if (new Set(cancelledOperationIds).size !== cancelledOperationIds.length) throw new Error('duplicate PostgreSQL message queue cancellation tombstone')
  assertCancellationLimit(new Set(cancelledOperationIds))
  const cancelled = new Set(cancelledOperationIds)
  return { items: (items as QueuedUserMessage[]).filter((item) => !cancelled.has(item.operationId)), cancelledOperationIds }
}

function emptyState(): PersistedMessageQueueState {
  return { items: [], cancelledOperationIds: [] }
}

function hasLiveClaim(row: QueueRow): boolean {
  return row.claim_owner !== null && row.claim_is_live === true
}

function assertNotClaimed(row: QueueRow, ...ids: (string | undefined)[]): void {
  if (!hasLiveClaim(row)) return
  if (ids.some((id) => id && (id === row.claim_item_id || id === row.claim_operation_id))) {
    throw new QueueItemClaimedError(row.claim_item_id!)
  }
}

function assertClaim(row: QueueRow, claim: PostgresMessageQueueClaim): void {
  if (row.claim_owner !== claim.ownerId || BigInt(row.claim_generation) !== claim.generation
    || row.claim_item_id !== claim.item.id || row.claim_operation_id !== claim.item.operationId
    || row.claim_is_live !== true) throw new QueueClaimFencedError()
}

function claimValues(tenantId: string, claim: PostgresMessageQueueClaim): readonly unknown[] {
  return [tenantId, claim.sessionId, claim.ownerId, claim.generation, claim.item.id, claim.item.operationId]
}

function assertOperationCompatible(existing: QueuedUserMessage, candidate: QueuedUserMessage): void {
  if (existing.text !== candidate.text || JSON.stringify(existing.content ?? []) !== JSON.stringify(candidate.content ?? [])
    || existing.shell?.command !== candidate.shell?.command) throw new Error('message operation ID conflict')
}

function assertCancellationLimit(cancelled: Set<string>): void {
  if (cancelled.size > MAX_CANCELLED_OPERATION_IDS) {
    throw new Error(`message queue cancellation tombstone limit of ${MAX_CANCELLED_OPERATION_IDS} exceeded; existing cancellations were preserved`)
  }
}

function cloneItem(item: QueuedUserMessage): QueuedUserMessage {
  return normalizeQueuedMessage(serializeQueuedMessage(item))!
}

function validateText(value: string, name: string): void {
  if (!value) throw new TypeError(`${name} must be a non-empty string`)
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive safe integer')
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
