import { createRequire } from 'node:module'

import {
  RuntimeUnitPlacementFencedError,
  type RuntimeUnitPlacementLease,
} from './postgres-runtime-unit-placement-store.js'
import { assertResourceOwner, type RuntimeResourceOwnership } from './postgres-runtime-resource-ownership.js'

type QueryResultRow = Record<string, unknown>
export type SqlQueryResult<Row extends QueryResultRow = QueryResultRow> = {
  rows: Row[]
  rowCount: number | null
}
type PgClient = HotStateSqlExecutor & { release(): void }
type PgPool = HotStateSqlExecutor & { connect(): Promise<PgClient>; end(): Promise<void>; on(event: 'error', listener: (error: Error) => void): PgPool }
const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (config: Record<string, unknown>) => PgPool
}

export type HotStateScope = {
  tenantId: string
  scopeType: 'session' | 'task'
  scopeId: string
}

export type LeaseToken = HotStateScope & {
  ownerId: string
  generation: bigint
  expiresAt: Date
}

export type HotStateEvent<Payload = unknown> = HotStateScope & {
  sequence: bigint
  generation: bigint
  idempotencyKey: string
  eventType: string
  payload: Payload
  createdAt: Date
}

export type AppendEventInput<Payload = unknown> = {
  idempotencyKey: string
  eventType: string
  payload: Payload
}

export type ReplayOptions = {
  afterSequence?: bigint
  limit?: number
}

export interface HotStateSqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>
}

export interface HotStateDatabase extends HotStateSqlExecutor {
  transaction<T>(operation: (transaction: HotStateSqlExecutor) => Promise<T>): Promise<T>
  close?(): Promise<void>
}

export class LeaseHeldError extends Error {
  readonly code = 'LEASE_HELD'
  constructor(readonly currentOwnerId: string, readonly expiresAt: Date) {
    super(`lease is held by ${currentOwnerId} until ${expiresAt.toISOString()}`)
    this.name = 'LeaseHeldError'
  }
}

export class LeaseFencedError extends Error {
  readonly code = 'LEASE_FENCED'
  constructor() {
    super('lease token was fenced by a newer owner or generation')
    this.name = 'LeaseFencedError'
  }
}

export class LeaseExpiredError extends Error {
  readonly code = 'LEASE_EXPIRED'
  constructor(readonly expiresAt: Date) {
    super(`lease expired at ${expiresAt.toISOString()}`)
    this.name = 'LeaseExpiredError'
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT'
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with different event content`)
    this.name = 'IdempotencyConflictError'
  }
}

type LeaseRow = QueryResultRow & {
  tenant_id: string
  scope_type: 'session' | 'task'
  scope_id: string
  owner_id: string
  generation: string
  expires_at: Date
  last_sequence: string
  is_live?: boolean
}

type EventRow = QueryResultRow & {
  tenant_id: string
  scope_type: 'session' | 'task'
  scope_id: string
  sequence: string
  generation: string
  idempotency_key: string
  event_type: string
  payload: unknown
  created_at: Date
}

/**
 * PostgreSQL-backed hot state primitives. Every mutating operation is fenced by
 * a persistent lease row; no correctness decision relies on process-local state.
 */
export class PostgresHotStateStore {
  readonly #leases: string
  readonly #events: string
  readonly #schema: string
  readonly #placementLease?: RuntimeUnitPlacementLease

  constructor(readonly database: HotStateDatabase, options: { schema?: string; placementLease?: RuntimeUnitPlacementLease } = {}) {
    this.#schema = options.schema ?? 'public'
    this.#placementLease = options.placementLease
    const schema = quoteIdentifier(this.#schema)
    this.#leases = `${schema}.tenant_runtime_hot_leases`
    this.#events = `${schema}.tenant_runtime_hot_events`
  }

  /** Idempotent schema bootstrap; production deployments may run the same DDL as a migration. */
  async initialize(): Promise<void> {
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#leases} (
      tenant_id text NOT NULL,
      scope_type text NOT NULL CHECK (scope_type IN ('session', 'task')),
      scope_id text NOT NULL,
      owner_id text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, scope_type, scope_id)
    )`)
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#events} (
      tenant_id text NOT NULL,
      scope_type text NOT NULL CHECK (scope_type IN ('session', 'task')),
      scope_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence > 0),
      generation bigint NOT NULL CHECK (generation > 0),
      idempotency_key text NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, scope_type, scope_id, sequence),
      UNIQUE (tenant_id, scope_type, scope_id, idempotency_key),
      FOREIGN KEY (tenant_id, scope_type, scope_id)
        REFERENCES ${this.#leases} (tenant_id, scope_type, scope_id)
        ON DELETE RESTRICT
    )`)
  }

  async acquireLease(
    scope: HotStateScope, ownerId: string, ttlMs: number,
    assertAdditionalOwner?: (transaction: HotStateSqlExecutor) => Promise<void>,
  ): Promise<LeaseToken> {
    validateScope(scope)
    validateText(ownerId, 'ownerId')
    validateTtl(ttlMs)
    return this.database.transaction(async (transaction) => {
      // A stale object writer must not create/hold a task-scoped lease before
      // its later Session-owner-guarded event append rejects it.
      if (assertAdditionalOwner) await assertAdditionalOwner(transaction)
      const inserted = await transaction.query<LeaseRow>(`INSERT INTO ${this.#leases}
        (tenant_id, scope_type, scope_id, owner_id, generation, expires_at)
        VALUES ($1, $2, $3, $4, 1, clock_timestamp() + $5 * interval '1 millisecond')
        ON CONFLICT (tenant_id, scope_type, scope_id) DO NOTHING
        RETURNING *`, scopeValues(scope, ownerId, ttlMs))
      if (inserted.rows[0]) return leaseToken(inserted.rows[0])

      const selected = await transaction.query<LeaseRow>(`SELECT * FROM ${this.#leases}
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
        FOR UPDATE`, scopeValues(scope))
      const current = selected.rows[0]
      if (!current) throw new Error('lease disappeared while being acquired')

      const claimed = await transaction.query<LeaseRow>(`UPDATE ${this.#leases}
        SET owner_id = $4,
            generation = CASE
              WHEN expires_at <= clock_timestamp() THEN generation + 1
              ELSE generation
            END,
            expires_at = clock_timestamp() + $5 * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
          AND (expires_at <= clock_timestamp() OR owner_id = $4)
        RETURNING *`, scopeValues(scope, ownerId, ttlMs))
      if (claimed.rows[0]) return leaseToken(claimed.rows[0])
      throw new LeaseHeldError(current.owner_id, current.expires_at)
    })
  }

  async renewLease(token: LeaseToken, ttlMs: number): Promise<LeaseToken> {
    validateToken(token)
    validateTtl(ttlMs)
    return this.database.transaction(async (transaction) => {
      const renewed = await transaction.query<LeaseRow>(`UPDATE ${this.#leases}
        SET expires_at = clock_timestamp() + $6 * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
          AND owner_id = $4 AND generation = $5
          AND expires_at > clock_timestamp()
        RETURNING *`, tokenValues(token, ttlMs))
      if (renewed.rows[0]) return leaseToken(renewed.rows[0])
      return throwTokenFailure(transaction, this.#leases, token)
    })
  }

  async releaseLease(token: LeaseToken): Promise<void> {
    validateToken(token)
    await this.database.transaction(async (transaction) => {
      const released = await transaction.query(`UPDATE ${this.#leases}
        SET expires_at = LEAST(expires_at, clock_timestamp()), updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
          AND owner_id = $4 AND generation = $5`, tokenValues(token))
      if (released.rowCount === 0) await throwTokenFailure(transaction, this.#leases, token)
    })
  }

  async appendEvent<Payload>(token: LeaseToken, input: AppendEventInput<Payload>): Promise<HotStateEvent<Payload>> {
    return this.appendEventWithSideEffect(token, input, async () => undefined)
  }

  /**
   * Append a fenced event and update a caller-owned projection in the same
   * transaction. The callback is deliberately SQL-only: publishing process
   * state or performing external I/O before COMMIT would violate authority.
   */
  async appendEventWithSideEffect<Payload>(
    token: LeaseToken,
    input: AppendEventInput<Payload>,
    sideEffect: (transaction: HotStateSqlExecutor, event: HotStateEvent<Payload>) => Promise<void>,
    resourceOwner?: RuntimeResourceOwnership,
    assertAdditionalOwner?: (transaction: HotStateSqlExecutor) => Promise<void>,
  ): Promise<HotStateEvent<Payload>> {
    validateToken(token)
    if (resourceOwner) this.#validateResourceOwnerScope(token, resourceOwner)
    validateText(input.idempotencyKey, 'idempotencyKey')
    validateText(input.eventType, 'eventType')
    if (input.payload === undefined) throw new TypeError('payload must be JSON-serializable and not undefined')
    const encodedPayload = JSON.stringify(input.payload)
    if (encodedPayload === undefined) throw new TypeError('payload must be JSON-serializable and not undefined')

    return this.database.transaction(async (transaction) => {
      // The optional fence protects only explicit callers; legacy Unit writers
      // require a separate protocol gate before allowing simultaneous replicas.
      if (resourceOwner) await this.assertResourceOwnerForScope(transaction, token, resourceOwner)
      // Guard before idempotent lookup, not only in sideEffect: a stale owner
      // must never receive success for a repeated object metadata operation.
      if (assertAdditionalOwner) await assertAdditionalOwner(transaction)
      const lease = await assertToken(transaction, this.#leases, token, true)
      const existing = await transaction.query<EventRow & { same_content: boolean }>(`SELECT *,
          (event_type = $5 AND payload = $6::jsonb) AS same_content
        FROM ${this.#events}
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND idempotency_key = $4`,
      [...scopeValues(token), input.idempotencyKey, input.eventType, encodedPayload])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (!row.same_content) throw new IdempotencyConflictError(input.idempotencyKey)
        return hotStateEvent<Payload>(row)
      }

      const sequence = BigInt(lease.last_sequence) + 1n
      const inserted = await transaction.query<EventRow>(`INSERT INTO ${this.#events}
        (tenant_id, scope_type, scope_id, sequence, generation, idempotency_key, event_type, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *`, [token.tenantId, token.scopeType, token.scopeId, sequence, token.generation,
        input.idempotencyKey, input.eventType, encodedPayload])
      const event = hotStateEvent<Payload>(inserted.rows[0]!)
      await sideEffect(transaction, event)
      await transaction.query(`UPDATE ${this.#leases} SET last_sequence = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3`, [...scopeValues(token), sequence])
      return event
    })
  }

  /** Call only inside the caller's SQL transaction, before modifying its Session/Task projection. */
  async assertResourceOwnerForScope(
    transaction: HotStateSqlExecutor,
    scope: HotStateScope,
    owner: RuntimeResourceOwnership,
  ): Promise<void> {
    this.#validateResourceOwnerScope(scope, owner)
    await assertResourceOwner(transaction, owner, { schema: this.#schema })
  }

  #validateResourceOwnerScope(scope: HotStateScope, owner: RuntimeResourceOwnership): void {
    if (scope.tenantId !== owner.organizationId
      || scope.scopeType !== owner.resourceType || scope.scopeId !== owner.resourceId) {
      throw new TypeError('HotState event scope must match the resource owner scope')
    }
    if (this.#placementLease
      && (owner.organizationId !== this.#placementLease.organizationId
        || owner.unitId !== this.#placementLease.unitId)) {
      throw new TypeError('HotState resource owner must match its Unit placement')
    }
  }

  async replay<Payload = unknown>(scope: HotStateScope, options: ReplayOptions = {}): Promise<readonly HotStateEvent<Payload>[]> {
    validateScope(scope)
    const afterSequence = options.afterSequence ?? 0n
    if (afterSequence < 0n) throw new RangeError('afterSequence must be non-negative')
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be an integer from 1 to 1000')
    const result = await this.database.query<EventRow>(`SELECT * FROM ${this.#events}
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND sequence > $4
      ORDER BY sequence ASC LIMIT $5`, [...scopeValues(scope), afterSequence, limit])
    return result.rows.map(hotStateEvent<Payload>)
  }

  async close(): Promise<void> {
    await this.database.close?.()
  }
}

export function createPostgresHotStateStore(options: {
  connectionString: string
  schema?: string
  applicationName?: string
  maxConnections?: number
  statementTimeoutMs?: number
  ssl?: unknown
  placementLease?: RuntimeUnitPlacementLease
}): PostgresHotStateStore {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'kala-tenant-runtime-hot-state',
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  // pg emits 'error' for disconnected idle clients independently of query
  // promises. Without a listener a network partition kills the entire Runtime
  // before owner/membership renewal can suspend and fence only its Unit.
  // pg evicts the broken client; subsequent queries still fail until restored.
  pool.on('error', () => undefined)
  const placementTable = `${quoteIdentifier(options.schema ?? 'public')}.tenant_runtime_unit_placement_leases`
  const inTransaction = async <T>(operation: (transaction: HotStateSqlExecutor) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const transaction: HotStateSqlExecutor = {
        query: (text, values) => client.query(text, values as unknown[] | undefined),
      }
      if (options.placementLease) await assertRuntimeUnitPlacement(transaction, placementTable, options.placementLease)
      const result = await operation(transaction)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  const database: HotStateDatabase = {
    query: (text, values) => inTransaction(async (transaction) => await transaction.query(text, values)),
    transaction: inTransaction,
    close: () => pool.end(),
  }
  return new PostgresHotStateStore(database, { schema: options.schema, placementLease: options.placementLease })
}

async function assertRuntimeUnitPlacement(
  transaction: HotStateSqlExecutor,
  table: string,
  lease: RuntimeUnitPlacementLease,
): Promise<void> {
  const selected = await transaction.query(`SELECT 1 FROM ${table}
    WHERE unit_id = $1 AND organization_id = $2
      AND owner_token = $3 AND generation = $4
      AND expires_at > clock_timestamp()
    FOR SHARE`, [lease.unitId, lease.organizationId, lease.ownerToken, lease.generation])
  if (selected.rowCount !== 1) throw new RuntimeUnitPlacementFencedError()
}

function scopeValues(scope: HotStateScope, ...rest: readonly unknown[]): readonly unknown[] {
  return [scope.tenantId, scope.scopeType, scope.scopeId, ...rest]
}

function tokenValues(token: LeaseToken, ...rest: readonly unknown[]): readonly unknown[] {
  return [token.tenantId, token.scopeType, token.scopeId, token.ownerId, token.generation, ...rest]
}

function leaseToken(row: LeaseRow): LeaseToken {
  return {
    tenantId: row.tenant_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    ownerId: row.owner_id,
    generation: BigInt(row.generation),
    expiresAt: row.expires_at,
  }
}

function hotStateEvent<Payload>(row: EventRow): HotStateEvent<Payload> {
  return {
    tenantId: row.tenant_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    sequence: BigInt(row.sequence),
    generation: BigInt(row.generation),
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    payload: row.payload as Payload,
    createdAt: row.created_at,
  }
}

async function assertToken(transaction: HotStateSqlExecutor, leases: string, token: LeaseToken, lock: boolean): Promise<LeaseRow> {
  const selected = await transaction.query<LeaseRow>(`SELECT *, expires_at > clock_timestamp() AS is_live FROM ${leases}
    WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3${lock ? ' FOR UPDATE' : ''}`, scopeValues(token))
  const current = selected.rows[0]
  if (!current || current.owner_id !== token.ownerId || BigInt(current.generation) !== token.generation) throw new LeaseFencedError()
  if (!current.is_live) throw new LeaseExpiredError(current.expires_at)
  return current
}

async function throwTokenFailure(transaction: HotStateSqlExecutor, leases: string, token: LeaseToken): Promise<never> {
  await assertToken(transaction, leases, token, false)
  throw new LeaseFencedError()
}

function validateScope(scope: HotStateScope): void {
  validateText(scope.tenantId, 'tenantId')
  if (scope.scopeType !== 'session' && scope.scopeType !== 'task') throw new TypeError('scopeType must be session or task')
  validateText(scope.scopeId, 'scopeId')
}

function validateToken(token: LeaseToken): void {
  validateScope(token)
  validateText(token.ownerId, 'ownerId')
  if (token.generation < 1n) throw new RangeError('generation must be positive')
}

function validateText(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive safe integer')
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
