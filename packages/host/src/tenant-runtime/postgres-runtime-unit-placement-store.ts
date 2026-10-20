import { createRequire } from 'node:module'

import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from './unit.js'

type QueryResultRow = Record<string, unknown>
type QueryResult<Row extends QueryResultRow = QueryResultRow> = { rows: Row[]; rowCount: number | null }
export interface RuntimeUnitPlacementSqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>
}
interface PgClient extends RuntimeUnitPlacementSqlExecutor { release(): void }
export interface RuntimeUnitPlacementDatabase extends RuntimeUnitPlacementSqlExecutor {
  connect(): Promise<PgClient>
  end(): Promise<void>
}
type PgPool = RuntimeUnitPlacementDatabase & { on(event: 'error', listener: (error: Error) => void): void }
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (config: Record<string, unknown>) => PgPool }

export type RuntimeUnitPlacementScope = {
  unitId: TenantRuntimeUnitId
  organizationId: string
}

export type RuntimeUnitLivePlacement = RuntimeUnitPlacementScope & {
  nodeId: string
  origin: string
  generation: bigint
  expiresAt: Date
  protocol?: 'parallel-v1'
}

/**
 * Fencing capability for one Runtime Unit activation. Callers must generate a
 * fresh, unguessable ownerToken for every activation, including restarts on the
 * same node; nodeId alone is deliberately not an ownership credential.
 */
export type RuntimeUnitPlacementLease = RuntimeUnitLivePlacement & {
  ownerToken: string
}

export type AcquireRuntimeUnitPlacementInput = RuntimeUnitPlacementScope & {
  nodeId: string
  ownerToken: string
  origin: string
}

export class RuntimeUnitPlacementHeldError extends Error {
  readonly code = 'RUNTIME_UNIT_PLACEMENT_HELD'

  constructor(readonly currentNodeId: string, readonly expiresAt: Date) {
    super(`runtime unit placement is held by ${currentNodeId} until ${expiresAt.toISOString()}`)
    this.name = 'RuntimeUnitPlacementHeldError'
  }
}

export class RuntimeUnitPlacementFencedError extends Error {
  readonly code = 'RUNTIME_UNIT_PLACEMENT_FENCED'

  constructor() {
    super('runtime unit placement lease was fenced by a newer activation or generation')
    this.name = 'RuntimeUnitPlacementFencedError'
  }
}

export class RuntimeUnitPlacementExpiredError extends Error {
  readonly code = 'RUNTIME_UNIT_PLACEMENT_EXPIRED'

  constructor(readonly expiresAt: Date) {
    super(`runtime unit placement lease expired at ${expiresAt.toISOString()}`)
    this.name = 'RuntimeUnitPlacementExpiredError'
  }
}

type PlacementRow = QueryResultRow & {
  unit_id: string
  organization_id: string
  node_id: string
  owner_token: string
  origin: string
  generation: string
  expires_at: Date
  is_live?: boolean
  feature_version?: number | null
  barrier_generation?: string | null
}

const PARALLEL_FEATURE_VERSION = 1
export const PARALLEL_PLACEMENT_BARRIER = 'kala-parallel-placement-barrier-v1'
export const PARALLEL_PLACEMENT_BARRIER_ORIGIN = 'https://parallel-placement-barrier.invalid'

export class RuntimeUnitPlacementProtocolError extends Error {
  readonly code = 'RUNTIME_UNIT_PLACEMENT_PROTOCOL_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'RuntimeUnitPlacementProtocolError'
  }
}

/**
 * PostgreSQL authority for exclusive Runtime Unit ownership and gateway
 * placement. initialize() is intended for experimental mode only; production
 * deployments must install the same schema through a versioned migration before
 * starting Runtime or Gateway processes.
 *
 * Origin validation only establishes a safe HTTP(S) origin shape. Deployment
 * policy (for example an internal Runtime origin allowlist) remains a caller
 * responsibility.
 */
export class PostgresRuntimeUnitPlacementStore {
  readonly #table: string
  readonly #gateTable: string
  #closed = false

  constructor(readonly database: RuntimeUnitPlacementDatabase, options: { schema?: string } = {}) {
    const schema = quoteIdentifier(options.schema ?? 'public')
    this.#table = `${schema}.tenant_runtime_unit_placement_leases`
    this.#gateTable = `${schema}.tenant_runtime_unit_protocol_gates`
  }

  /** Experimental bootstrap only. Production must use a versioned migration. */
  async initialize(): Promise<void> {
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      unit_id text NOT NULL,
      organization_id text NOT NULL,
      node_id text NOT NULL,
      owner_token text NOT NULL,
      origin text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (unit_id, organization_id)
    )`)
  }

  async acquire(input: AcquireRuntimeUnitPlacementInput, ttlMs: number): Promise<RuntimeUnitPlacementLease> {
    const normalized = validateAcquireInput(input)
    validateTtl(ttlMs)
    return this.#transaction(async (transaction) => {
      // Runtime roles have SELECT-only access to the operator gate; PostgreSQL
      // requires UPDATE privilege even for SELECT ... FOR SHARE on that table.
      const barrier = await this.#lookupParallelBarrier(transaction, normalized)
      if (barrier) return barrier
      const inserted = await transaction.query<PlacementRow>(`INSERT INTO ${this.#table}
        (unit_id, organization_id, node_id, owner_token, origin, generation, expires_at)
        VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp() + $6 * interval '1 millisecond')
        ON CONFLICT (unit_id, organization_id) DO NOTHING
        RETURNING *`, acquireValues(normalized, ttlMs))
      if (inserted.rows[0]) return placementLease(inserted.rows[0])

      const selected = await transaction.query<PlacementRow>(`SELECT * FROM ${this.#table}
        WHERE unit_id = $1 AND organization_id = $2
        FOR UPDATE`, scopeValues(normalized))
      const current = selected.rows[0]
      if (!current) throw new Error('runtime unit placement disappeared while being acquired')

      // No live-owner fast path exists: even the same node/token cannot reenter.
      const claimed = await transaction.query<PlacementRow>(`UPDATE ${this.#table}
        SET node_id = $3,
            owner_token = $4,
            origin = $5,
            generation = generation + 1,
            expires_at = clock_timestamp() + $6 * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE unit_id = $1 AND organization_id = $2
          AND expires_at <= clock_timestamp()
        RETURNING *`, acquireValues(normalized, ttlMs))
      if (claimed.rows[0]) return placementLease(claimed.rows[0])
      throw new RuntimeUnitPlacementHeldError(current.node_id, current.expires_at)
    })
  }

  async renew(lease: RuntimeUnitPlacementLease, ttlMs: number): Promise<RuntimeUnitPlacementLease> {
    validateLease(lease)
    validateTtl(ttlMs)
    if (lease.protocol === 'parallel-v1') return this.#assertParallelBarrier(lease)
    return this.#transaction(async (transaction) => {
      const renewed = await transaction.query<PlacementRow>(`UPDATE ${this.#table}
        SET expires_at = clock_timestamp() + $7 * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE unit_id = $1 AND organization_id = $2
          AND node_id = $3 AND owner_token = $4 AND generation = $5 AND origin = $6
          AND expires_at > clock_timestamp()
        RETURNING *`, leaseValues(lease, ttlMs))
      if (renewed.rows[0]) return placementLease(renewed.rows[0])
      return throwLeaseFailure(transaction, this.#table, lease)
    })
  }

  async release(lease: RuntimeUnitPlacementLease): Promise<void> {
    validateLease(lease)
    if (lease.protocol === 'parallel-v1') {
      await this.#assertParallelBarrier(lease)
      return
    }
    await this.#transaction(async (transaction) => {
      const released = await transaction.query(`UPDATE ${this.#table}
        SET expires_at = LEAST(expires_at, clock_timestamp()), updated_at = clock_timestamp()
        WHERE unit_id = $1 AND organization_id = $2
          AND node_id = $3 AND owner_token = $4 AND generation = $5 AND origin = $6`, leaseValues(lease))
      if (released.rowCount === 0) await throwLeaseFailure(transaction, this.#table, lease)
    })
  }

  /** Returns no route once the lease has expired according to PostgreSQL time. */
  async lookupLive(scope: RuntimeUnitPlacementScope): Promise<RuntimeUnitLivePlacement | undefined> {
    const validated = validateScope(scope)
    const barrier = await this.#lookupParallelBarrier(this.database, validated)
    if (barrier) return withoutOwnerToken(barrier)
    const result = await this.database.query<PlacementRow>(`SELECT * FROM ${this.#table}
      WHERE unit_id = $1 AND organization_id = $2
        AND expires_at > clock_timestamp()`, scopeValues(validated))
    const row = result.rows[0]
    if (row?.node_id === PARALLEL_PLACEMENT_BARRIER) {
      throw new RuntimeUnitPlacementProtocolError('parallel placement barrier exists without a valid operator protocol gate')
    }
    return row ? livePlacement(row) : undefined
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.database.end()
  }

  async #transaction<T>(operation: (transaction: RuntimeUnitPlacementSqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.database.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async #assertParallelBarrier(lease: RuntimeUnitPlacementLease): Promise<RuntimeUnitPlacementLease> {
    const current = await this.#lookupParallelBarrier(this.database, lease)
    if (!current || current.ownerToken !== lease.ownerToken || current.generation !== lease.generation) {
      throw new RuntimeUnitPlacementFencedError()
    }
    return current
  }

  async #lookupParallelBarrier(
    executor: RuntimeUnitPlacementSqlExecutor,
    scope: RuntimeUnitPlacementScope,
    lock = '',
  ): Promise<RuntimeUnitPlacementLease | undefined> {
    let result: QueryResult<PlacementRow>
    try {
      result = await executor.query<PlacementRow>(`SELECT placement.*, gate.feature_version, gate.barrier_generation
        FROM ${this.#gateTable} AS gate
        LEFT JOIN ${this.#table} AS placement
          ON placement.organization_id = gate.organization_id AND placement.unit_id = gate.unit_id
        WHERE gate.unit_id = $1 AND gate.organization_id = $2${lock}`, scopeValues(scope))
    } catch (error) {
      if (isUndefinedTable(error)) return undefined
      throw error
    }
    const row = result.rows[0]
    if (!row) return undefined
    if (Number(row.feature_version) !== PARALLEL_FEATURE_VERSION) {
      throw new RuntimeUnitPlacementProtocolError(`unsupported Runtime Unit parallel protocol feature version ${String(row.feature_version)}`)
    }
    if (row.node_id !== PARALLEL_PLACEMENT_BARRIER
      || row.owner_token !== PARALLEL_PLACEMENT_BARRIER
      || row.origin !== PARALLEL_PLACEMENT_BARRIER_ORIGIN
      || row.barrier_generation == null
      || BigInt(row.generation) !== BigInt(row.barrier_generation)) {
      throw new RuntimeUnitPlacementProtocolError('parallel protocol gate does not match its permanent placement barrier')
    }
    return placementLease(row, 'parallel-v1')
  }
}

export function createPostgresRuntimeUnitPlacementStore(options: {
  connectionString: string
  schema?: string
  applicationName?: string
  maxConnections?: number
  statementTimeoutMs?: number
  ssl?: unknown
}): PostgresRuntimeUnitPlacementStore {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'kala-runtime-unit-placement',
    max: options.maxConnections ?? 5,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  // Idle pg connections report partitions through EventEmitter, not query promises.
  pool.on('error', () => undefined)
  return new PostgresRuntimeUnitPlacementStore(pool, { schema: options.schema })
}

async function throwLeaseFailure(
  transaction: RuntimeUnitPlacementSqlExecutor,
  table: string,
  lease: RuntimeUnitPlacementLease,
): Promise<never> {
  const selected = await transaction.query<PlacementRow>(`SELECT *, expires_at > clock_timestamp() AS is_live
    FROM ${table}
    WHERE unit_id = $1 AND organization_id = $2
    FOR UPDATE`, scopeValues(lease))
  const current = selected.rows[0]
  if (!current
    || current.node_id !== lease.nodeId
    || current.owner_token !== lease.ownerToken
    || BigInt(current.generation) !== lease.generation
    || current.origin !== lease.origin) {
    throw new RuntimeUnitPlacementFencedError()
  }
  if (!current.is_live) throw new RuntimeUnitPlacementExpiredError(current.expires_at)
  throw new RuntimeUnitPlacementFencedError()
}

function placementLease(row: PlacementRow, protocol?: 'parallel-v1'): RuntimeUnitPlacementLease {
  return { ...livePlacement(row, protocol), ownerToken: row.owner_token }
}

function livePlacement(row: PlacementRow, protocol?: 'parallel-v1'): RuntimeUnitLivePlacement {
  return {
    unitId: parseTenantRuntimeUnitId(row.unit_id),
    organizationId: row.organization_id,
    nodeId: row.node_id,
    origin: row.origin,
    generation: BigInt(row.generation),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(8_640_000_000_000_000),
    ...(protocol ? { protocol } : {}),
  }
}

function withoutOwnerToken(lease: RuntimeUnitPlacementLease): RuntimeUnitLivePlacement {
  const { ownerToken: _ownerToken, ...live } = lease
  return live
}

function isUndefinedTable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '42P01'
}

function acquireValues(input: AcquireRuntimeUnitPlacementInput, ttlMs: number): readonly unknown[] {
  return [input.unitId, input.organizationId, input.nodeId, input.ownerToken, input.origin, ttlMs]
}

function leaseValues(lease: RuntimeUnitPlacementLease, ...rest: readonly unknown[]): readonly unknown[] {
  return [lease.unitId, lease.organizationId, lease.nodeId, lease.ownerToken, lease.generation, lease.origin, ...rest]
}

function scopeValues(scope: RuntimeUnitPlacementScope): readonly unknown[] {
  return [scope.unitId, scope.organizationId]
}

function validateScope(scope: RuntimeUnitPlacementScope): RuntimeUnitPlacementScope {
  const unitId = parseTenantRuntimeUnitId(scope.unitId)
  validateText(scope.organizationId, 'organizationId')
  return { unitId, organizationId: scope.organizationId }
}

function validateAcquireInput(input: AcquireRuntimeUnitPlacementInput): AcquireRuntimeUnitPlacementInput {
  const scope = validateScope(input)
  validateText(input.nodeId, 'nodeId')
  validateText(input.ownerToken, 'ownerToken')
  return { ...scope, nodeId: input.nodeId, ownerToken: input.ownerToken, origin: normalizeOrigin(input.origin) }
}

function validateLease(lease: RuntimeUnitPlacementLease): void {
  validateScope(lease)
  if (lease.protocol !== undefined && lease.protocol !== 'parallel-v1') throw new TypeError('unsupported placement protocol')
  validateText(lease.nodeId, 'nodeId')
  validateText(lease.ownerToken, 'ownerToken')
  if (typeof lease.generation !== 'bigint' || lease.generation < 1n) throw new RangeError('generation must be a positive bigint')
  if (normalizeOrigin(lease.origin) !== lease.origin) throw new TypeError('origin must be canonical')
}

function validateText(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive safe integer')
}

function normalizeOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('origin must be a valid absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('origin must use http or https')
  if (parsed.username || parsed.password) throw new TypeError('origin must not contain credentials')
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new TypeError('origin must not contain a path, query, or hash')
  return parsed.origin
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
