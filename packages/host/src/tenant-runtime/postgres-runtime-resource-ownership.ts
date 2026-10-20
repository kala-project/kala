import { createRequire } from 'node:module'

import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from './unit.js'

type QueryResultRow = Record<string, unknown>
type QueryResult<Row extends QueryResultRow = QueryResultRow> = { rows: Row[]; rowCount: number | null }

export interface RuntimeResourceOwnershipSqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>
}

interface PgClient extends RuntimeResourceOwnershipSqlExecutor { release(): void }
export interface RuntimeResourceOwnershipDatabase extends RuntimeResourceOwnershipSqlExecutor {
  connect(): Promise<PgClient>
  end(): Promise<void>
}

const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (config: Record<string, unknown>) => RuntimeResourceOwnershipDatabase & { on(event: 'error', listener: (error: Error) => void): void }
}

export type RuntimeUnitReplicaScope = {
  organizationId: string
  unitId: TenantRuntimeUnitId
}

export type RegisterRuntimeUnitReplicaInput = RuntimeUnitReplicaScope & {
  replicaId: string
  membershipToken: string
  origin: string
}

/** A fencing capability for one activation of one independently leased Unit replica. */
export type RuntimeUnitReplicaMembership = RegisterRuntimeUnitReplicaInput & {
  generation: bigint
  expiresAt: Date
}

export type RuntimeUnitLiveReplica = Omit<RuntimeUnitReplicaMembership, 'membershipToken'>

export type RuntimeResourceScope = RuntimeUnitReplicaScope & {
  resourceType: 'session' | 'task'
  resourceId: string
}

export type RuntimeResourceOwnership = RuntimeResourceScope & {
  replicaId: string
  membershipGeneration: bigint
  membershipToken: string
  ownerToken: string
  generation: bigint
  expiresAt: Date
}

export type RuntimeResourceLiveOwner = Omit<RuntimeResourceOwnership, 'membershipToken' | 'ownerToken'> & {
  origin: string
}

export class RuntimeUnitReplicaMembershipHeldError extends Error {
  readonly code = 'RUNTIME_UNIT_REPLICA_MEMBERSHIP_HELD'
  constructor(readonly expiresAt: Date) {
    super(`runtime unit replica membership is live until ${expiresAt.toISOString()}`)
    this.name = 'RuntimeUnitReplicaMembershipHeldError'
  }
}

export class RuntimeUnitReplicaMembershipFencedError extends Error {
  readonly code = 'RUNTIME_UNIT_REPLICA_MEMBERSHIP_FENCED'
  constructor() {
    super('runtime unit replica membership was fenced by a newer activation or generation')
    this.name = 'RuntimeUnitReplicaMembershipFencedError'
  }
}

export class RuntimeUnitReplicaMembershipExpiredError extends Error {
  readonly code = 'RUNTIME_UNIT_REPLICA_MEMBERSHIP_EXPIRED'
  constructor(readonly expiresAt: Date) {
    super(`runtime unit replica membership expired at ${expiresAt.toISOString()}`)
    this.name = 'RuntimeUnitReplicaMembershipExpiredError'
  }
}

export class RuntimeResourceOwnershipHeldError extends Error {
  readonly code = 'RUNTIME_RESOURCE_OWNERSHIP_HELD'
  constructor(readonly replicaId: string, readonly expiresAt: Date) {
    super(`runtime resource ownership is held by replica ${replicaId} until ${expiresAt.toISOString()}`)
    this.name = 'RuntimeResourceOwnershipHeldError'
  }
}

export class RuntimeResourceOwnershipFencedError extends Error {
  readonly code = 'RUNTIME_RESOURCE_OWNERSHIP_FENCED'
  constructor() {
    super('runtime resource ownership was fenced by a newer owner, membership, or generation')
    this.name = 'RuntimeResourceOwnershipFencedError'
  }
}

export class RuntimeResourceOwnershipExpiredError extends Error {
  readonly code = 'RUNTIME_RESOURCE_OWNERSHIP_EXPIRED'
  constructor(readonly expiresAt: Date) {
    super(`runtime resource ownership expired at ${expiresAt.toISOString()}`)
    this.name = 'RuntimeResourceOwnershipExpiredError'
  }
}

type MembershipRow = QueryResultRow & {
  organization_id: string
  unit_id: string
  replica_id: string
  membership_token: string
  origin: string
  generation: string
  expires_at: Date
  is_live?: boolean
}

type OwnershipRow = QueryResultRow & {
  organization_id: string
  resource_type: 'session' | 'task'
  resource_id: string
  unit_id: string
  replica_id: string
  membership_generation: string
  membership_token: string
  owner_token: string
  generation: string
  expires_at: Date
  origin?: string
  is_live?: boolean
  membership_is_live?: boolean
}

/**
 * Experimental PostgreSQL primitives for multi-replica Unit membership and
 * Session/Task ownership. They are intentionally not wired into current Unit
 * placement or production routing.
 */
export class PostgresRuntimeResourceOwnershipStore {
  readonly #memberships: string
  readonly #ownerships: string
  #closed = false

  constructor(readonly database: RuntimeResourceOwnershipDatabase, options: { schema?: string } = {}) {
    const schema = quoteIdentifier(options.schema ?? 'public')
    this.#memberships = `${schema}.tenant_runtime_unit_replica_memberships`
    this.#ownerships = `${schema}.tenant_runtime_resource_ownerships`
  }

  async registerReplica(input: RegisterRuntimeUnitReplicaInput, ttlMs: number): Promise<RuntimeUnitReplicaMembership> {
    const normalized = validateRegistration(input)
    validateTtl(ttlMs)
    return await this.#transaction(async (transaction) => {
      const inserted = await transaction.query<MembershipRow>(`INSERT INTO ${this.#memberships}
        (organization_id, unit_id, replica_id, membership_token, origin, generation, expires_at)
        VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp() + $6 * interval '1 millisecond')
        ON CONFLICT (organization_id, unit_id, replica_id) DO NOTHING
        RETURNING *`, registrationValues(normalized, ttlMs))
      if (inserted.rows[0]) return membership(inserted.rows[0])

      const selected = await transaction.query<MembershipRow>(`SELECT * FROM ${this.#memberships}
        WHERE organization_id = $1 AND unit_id = $2 AND replica_id = $3
        FOR UPDATE`, replicaValues(normalized))
      const current = selected.rows[0]
      if (!current) throw new Error('runtime unit replica membership disappeared while being registered')
      const claimed = await transaction.query<MembershipRow>(`UPDATE ${this.#memberships}
        SET membership_token = $4,
            origin = $5,
            generation = generation + 1,
            expires_at = clock_timestamp() + $6 * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE organization_id = $1 AND unit_id = $2 AND replica_id = $3
          AND expires_at <= clock_timestamp()
        RETURNING *`, registrationValues(normalized, ttlMs))
      if (claimed.rows[0]) return membership(claimed.rows[0])
      throw new RuntimeUnitReplicaMembershipHeldError(current.expires_at)
    })
  }

  async renewReplica(lease: RuntimeUnitReplicaMembership, ttlMs: number): Promise<RuntimeUnitReplicaMembership> {
    validateMembership(lease)
    validateTtl(ttlMs)
    return await this.#transaction(async (transaction) => {
      const renewed = await transaction.query<MembershipRow>(`UPDATE ${this.#memberships}
        SET expires_at = clock_timestamp() + $7 * interval '1 millisecond', updated_at = clock_timestamp()
        WHERE organization_id = $1 AND unit_id = $2 AND replica_id = $3
          AND membership_token = $4 AND origin = $5 AND generation = $6
          AND expires_at > clock_timestamp()
        RETURNING *`, membershipValues(lease, ttlMs))
      if (renewed.rows[0]) return membership(renewed.rows[0])
      return await throwMembershipFailure(transaction, this.#memberships, lease)
    })
  }

  async releaseReplica(lease: RuntimeUnitReplicaMembership): Promise<void> {
    validateMembership(lease)
    await this.#transaction(async (transaction) => {
      const released = await transaction.query(`UPDATE ${this.#memberships}
        SET expires_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE organization_id = $1 AND unit_id = $2 AND replica_id = $3
          AND membership_token = $4 AND origin = $5 AND generation = $6
          AND expires_at > clock_timestamp()`, membershipValues(lease))
      if (released.rowCount !== 1) await throwMembershipFailure(transaction, this.#memberships, lease)
    })
  }

  async lookupLiveReplicas(scope: RuntimeUnitReplicaScope): Promise<readonly RuntimeUnitLiveReplica[]> {
    const normalized = validateReplicaScope(scope)
    const selected = await this.database.query<MembershipRow>(`SELECT * FROM ${this.#memberships}
      WHERE organization_id = $1 AND unit_id = $2 AND expires_at > clock_timestamp()
      ORDER BY replica_id`, [normalized.organizationId, normalized.unitId])
    return selected.rows.map(liveReplica)
  }

  async acquireResourceOwner(
    scope: RuntimeResourceScope,
    replica: RuntimeUnitReplicaMembership,
    ownerToken: string,
    ttlMs: number,
  ): Promise<RuntimeResourceOwnership> {
    const normalizedScope = validateResourceScope(scope)
    validateMembership(replica)
    validateText(ownerToken, 'ownerToken')
    validateTtl(ttlMs)
    if (normalizedScope.organizationId !== replica.organizationId || normalizedScope.unitId !== replica.unitId) {
      throw new TypeError('resource and replica organizationId and unitId must match')
    }

    return await this.#transaction(async (transaction) => {
      await assertMembership(transaction, this.#memberships, replica)
      const values = ownershipAcquireValues(normalizedScope, replica, ownerToken, ttlMs)
      const inserted = await transaction.query<OwnershipRow>(`INSERT INTO ${this.#ownerships}
        (organization_id, unit_id, resource_type, resource_id, replica_id,
          membership_generation, membership_token, owner_token, generation, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, clock_timestamp() + $9 * interval '1 millisecond')
        ON CONFLICT (organization_id, unit_id, resource_type, resource_id) DO NOTHING
        RETURNING *`, values)
      if (inserted.rows[0]) return ownership(inserted.rows[0])

      const selected = await transaction.query<OwnershipRow>(`SELECT * FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
        FOR UPDATE`, resourceValues(normalizedScope))
      const current = selected.rows[0]
      if (!current) throw new Error('runtime resource ownership disappeared while being acquired')
      const claimed = await transaction.query<OwnershipRow>(`UPDATE ${this.#ownerships} AS ownership
        SET replica_id = $5,
            membership_generation = $6,
            membership_token = $7,
            owner_token = $8,
            generation = ownership.generation + 1,
            expires_at = clock_timestamp() + $9 * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
          AND ownership.resource_type = $3 AND ownership.resource_id = $4
          AND (ownership.expires_at <= clock_timestamp() OR NOT EXISTS (
            SELECT 1 FROM ${this.#memberships} AS member
            WHERE member.organization_id = ownership.organization_id
              AND member.unit_id = ownership.unit_id
              AND member.replica_id = ownership.replica_id
              AND member.generation = ownership.membership_generation
              AND member.membership_token = ownership.membership_token
              AND member.expires_at > clock_timestamp()
          ))
        RETURNING ownership.*`, values)
      if (claimed.rows[0]) return ownership(claimed.rows[0])
      throw new RuntimeResourceOwnershipHeldError(current.replica_id, current.expires_at)
    })
  }

  async renewResourceOwner(lease: RuntimeResourceOwnership, ttlMs: number): Promise<RuntimeResourceOwnership> {
    validateOwnership(lease)
    validateTtl(ttlMs)
    return await this.#transaction(async (transaction) => {
      const renewed = await transaction.query<OwnershipRow>(`UPDATE ${this.#ownerships} AS ownership
        SET expires_at = clock_timestamp() + $10 * interval '1 millisecond', updated_at = clock_timestamp()
        WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
          AND ownership.resource_type = $3 AND ownership.resource_id = $4
          AND ownership.replica_id = $5
          AND ownership.membership_generation = $6 AND ownership.membership_token = $7
          AND ownership.owner_token = $8 AND ownership.generation = $9
          AND ownership.expires_at > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM ${this.#memberships} AS member
            WHERE member.organization_id = ownership.organization_id
              AND member.unit_id = ownership.unit_id AND member.replica_id = ownership.replica_id
              AND member.generation = ownership.membership_generation
              AND member.membership_token = ownership.membership_token
              AND member.expires_at > clock_timestamp()
          )
        RETURNING ownership.*`, ownershipValues(lease, ttlMs))
      if (renewed.rows[0]) return ownership(renewed.rows[0])
      return await throwOwnershipFailure(transaction, this.#memberships, this.#ownerships, lease)
    })
  }

  async releaseResourceOwner(lease: RuntimeResourceOwnership): Promise<void> {
    validateOwnership(lease)
    await this.#transaction(async (transaction) => {
      const released = await transaction.query(`UPDATE ${this.#ownerships} AS ownership
        SET expires_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
          AND ownership.resource_type = $3 AND ownership.resource_id = $4
          AND ownership.replica_id = $5
          AND ownership.membership_generation = $6 AND ownership.membership_token = $7
          AND ownership.owner_token = $8 AND ownership.generation = $9
          AND ownership.expires_at > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM ${this.#memberships} AS member
            WHERE member.organization_id = ownership.organization_id
              AND member.unit_id = ownership.unit_id AND member.replica_id = ownership.replica_id
              AND member.generation = ownership.membership_generation
              AND member.membership_token = ownership.membership_token
              AND member.expires_at > clock_timestamp()
          )`, ownershipValues(lease))
      if (released.rowCount !== 1) {
        await throwOwnershipFailure(transaction, this.#memberships, this.#ownerships, lease)
      }
    })
  }

  /** Returns an owner only while both ownership and its exact organization membership are live. */
  async lookupResourceOwner(scope: RuntimeResourceScope): Promise<RuntimeResourceLiveOwner | undefined> {
    const normalized = validateResourceScope(scope)
    const selected = await this.database.query<OwnershipRow>(`SELECT ownership.*, member.origin
      FROM ${this.#ownerships} AS ownership
      INNER JOIN ${this.#memberships} AS member
        ON member.organization_id = ownership.organization_id
        AND member.unit_id = ownership.unit_id
        AND member.replica_id = ownership.replica_id
        AND member.generation = ownership.membership_generation
        AND member.membership_token = ownership.membership_token
      WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
        AND ownership.resource_type = $3 AND ownership.resource_id = $4
        AND ownership.expires_at > clock_timestamp()
        AND member.expires_at > clock_timestamp()`, resourceValues(normalized))
    return selected.rows[0] ? liveOwner(selected.rows[0]) : undefined
  }

  /** Acquire share locks in the caller's transaction before any fenced resource mutation. */
  async assertResourceOwner(
    transaction: RuntimeResourceOwnershipSqlExecutor,
    lease: RuntimeResourceOwnership,
  ): Promise<void> {
    validateOwnership(lease)
    await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.database.end()
  }

  async #transaction<T>(operation: (transaction: RuntimeResourceOwnershipSqlExecutor) => Promise<T>): Promise<T> {
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
}

export function createPostgresRuntimeResourceOwnershipStore(options: {
  connectionString: string
  schema?: string
  applicationName?: string
  maxConnections?: number
  statementTimeoutMs?: number
  ssl?: unknown
}): PostgresRuntimeResourceOwnershipStore {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'kala-runtime-resource-ownership',
    max: options.maxConnections ?? 5,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  // A partition can close an idle client before the owner renewal query runs.
  pool.on('error', () => undefined)
  return new PostgresRuntimeResourceOwnershipStore(pool, { schema: options.schema })
}

/** Public-schema convenience for future PG stores already holding a SQL transaction. */
export async function assertResourceOwner(
  transaction: RuntimeResourceOwnershipSqlExecutor,
  lease: RuntimeResourceOwnership,
  options: { schema?: string } = {},
): Promise<void> {
  validateOwnership(lease)
  const schema = quoteIdentifier(options.schema ?? 'public')
  await assertResourceOwnerInTables(
    transaction,
    `${schema}.tenant_runtime_unit_replica_memberships`,
    `${schema}.tenant_runtime_resource_ownerships`,
    lease,
  )
}

async function assertMembership(
  transaction: RuntimeResourceOwnershipSqlExecutor,
  memberships: string,
  lease: RuntimeUnitReplicaMembership,
): Promise<void> {
  const selected = await transaction.query(`SELECT 1 FROM ${memberships}
    WHERE organization_id = $1 AND unit_id = $2 AND replica_id = $3
      AND membership_token = $4 AND origin = $5 AND generation = $6
      AND expires_at > clock_timestamp()
    FOR SHARE`, membershipValues(lease))
  if (selected.rowCount !== 1) throw new RuntimeUnitReplicaMembershipFencedError()
}

async function assertResourceOwnerInTables(
  transaction: RuntimeResourceOwnershipSqlExecutor,
  memberships: string,
  ownerships: string,
  lease: RuntimeResourceOwnership,
): Promise<void> {
  const selected = await transaction.query(`SELECT 1
    FROM ${ownerships} AS ownership
    INNER JOIN ${memberships} AS member
      ON member.organization_id = ownership.organization_id
      AND member.unit_id = ownership.unit_id AND member.replica_id = ownership.replica_id
      AND member.generation = ownership.membership_generation
      AND member.membership_token = ownership.membership_token
    WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
      AND ownership.resource_type = $3 AND ownership.resource_id = $4
      AND ownership.replica_id = $5
      AND ownership.membership_generation = $6 AND ownership.membership_token = $7
      AND ownership.owner_token = $8 AND ownership.generation = $9
      AND ownership.expires_at > clock_timestamp() AND member.expires_at > clock_timestamp()
    FOR SHARE OF ownership, member`, ownershipValues(lease))
  if (selected.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
}

async function throwMembershipFailure(
  transaction: RuntimeResourceOwnershipSqlExecutor,
  table: string,
  lease: RuntimeUnitReplicaMembership,
): Promise<never> {
  const selected = await transaction.query<MembershipRow>(`SELECT *, expires_at > clock_timestamp() AS is_live
    FROM ${table} WHERE organization_id = $1 AND unit_id = $2 AND replica_id = $3
    FOR UPDATE`, replicaValues(lease))
  const current = selected.rows[0]
  if (!current || current.membership_token !== lease.membershipToken
    || current.origin !== lease.origin || BigInt(current.generation) !== lease.generation) {
    throw new RuntimeUnitReplicaMembershipFencedError()
  }
  if (!current.is_live) throw new RuntimeUnitReplicaMembershipExpiredError(current.expires_at)
  throw new RuntimeUnitReplicaMembershipFencedError()
}

async function throwOwnershipFailure(
  transaction: RuntimeResourceOwnershipSqlExecutor,
  memberships: string,
  ownerships: string,
  lease: RuntimeResourceOwnership,
): Promise<never> {
  const selected = await transaction.query<OwnershipRow>(`SELECT ownership.*,
      ownership.expires_at > clock_timestamp() AS is_live,
      EXISTS (
        SELECT 1 FROM ${memberships} AS member
        WHERE member.organization_id = ownership.organization_id
          AND member.unit_id = ownership.unit_id AND member.replica_id = ownership.replica_id
          AND member.generation = ownership.membership_generation
          AND member.membership_token = ownership.membership_token
          AND member.expires_at > clock_timestamp()
      ) AS membership_is_live
    FROM ${ownerships} AS ownership
    WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
      AND ownership.resource_type = $3 AND ownership.resource_id = $4
    FOR UPDATE`, resourceValues(lease))
  const current = selected.rows[0]
  if (!current || current.unit_id !== lease.unitId || current.replica_id !== lease.replicaId
    || BigInt(current.membership_generation) !== lease.membershipGeneration
    || current.membership_token !== lease.membershipToken || current.owner_token !== lease.ownerToken
    || BigInt(current.generation) !== lease.generation || !current.membership_is_live) {
    throw new RuntimeResourceOwnershipFencedError()
  }
  if (!current.is_live) throw new RuntimeResourceOwnershipExpiredError(current.expires_at)
  throw new RuntimeResourceOwnershipFencedError()
}

function membership(row: MembershipRow): RuntimeUnitReplicaMembership {
  return {
    organizationId: row.organization_id,
    unitId: parseTenantRuntimeUnitId(row.unit_id),
    replicaId: row.replica_id,
    membershipToken: row.membership_token,
    origin: row.origin,
    generation: BigInt(row.generation),
    expiresAt: row.expires_at,
  }
}

function liveReplica(row: MembershipRow): RuntimeUnitLiveReplica {
  const { membershipToken: _membershipToken, ...live } = membership(row)
  return live
}

function ownership(row: OwnershipRow): RuntimeResourceOwnership {
  return {
    organizationId: row.organization_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    unitId: parseTenantRuntimeUnitId(row.unit_id),
    replicaId: row.replica_id,
    membershipGeneration: BigInt(row.membership_generation),
    membershipToken: row.membership_token,
    ownerToken: row.owner_token,
    generation: BigInt(row.generation),
    expiresAt: row.expires_at,
  }
}

function liveOwner(row: OwnershipRow): RuntimeResourceLiveOwner {
  const { membershipToken: _membershipToken, ownerToken: _ownerToken, ...live } = ownership(row)
  return { ...live, origin: row.origin! }
}

function replicaValues(scope: RuntimeUnitReplicaScope & { replicaId: string }): readonly unknown[] {
  return [scope.organizationId, scope.unitId, scope.replicaId]
}

function registrationValues(input: RegisterRuntimeUnitReplicaInput, ...rest: readonly unknown[]): readonly unknown[] {
  return [input.organizationId, input.unitId, input.replicaId, input.membershipToken, input.origin, ...rest]
}

function membershipValues(lease: RuntimeUnitReplicaMembership, ...rest: readonly unknown[]): readonly unknown[] {
  return [lease.organizationId, lease.unitId, lease.replicaId, lease.membershipToken, lease.origin, lease.generation, ...rest]
}

function resourceValues(scope: RuntimeResourceScope): readonly unknown[] {
  return [scope.organizationId, scope.unitId, scope.resourceType, scope.resourceId]
}

function ownershipAcquireValues(
  scope: RuntimeResourceScope,
  replica: RuntimeUnitReplicaMembership,
  ownerToken: string,
  ttlMs: number,
): readonly unknown[] {
  return [scope.organizationId, scope.unitId, scope.resourceType, scope.resourceId, replica.replicaId,
    replica.generation, replica.membershipToken, ownerToken, ttlMs]
}

function ownershipValues(lease: RuntimeResourceOwnership, ...rest: readonly unknown[]): readonly unknown[] {
  return [lease.organizationId, lease.unitId, lease.resourceType, lease.resourceId, lease.replicaId,
    lease.membershipGeneration, lease.membershipToken, lease.ownerToken, lease.generation, ...rest]
}

function validateReplicaScope(scope: RuntimeUnitReplicaScope): RuntimeUnitReplicaScope {
  validateText(scope.organizationId, 'organizationId')
  return { organizationId: scope.organizationId, unitId: parseTenantRuntimeUnitId(scope.unitId) }
}

function validateRegistration(input: RegisterRuntimeUnitReplicaInput): RegisterRuntimeUnitReplicaInput {
  const scope = validateReplicaScope(input)
  validateText(input.replicaId, 'replicaId')
  validateText(input.membershipToken, 'membershipToken')
  return { ...scope, replicaId: input.replicaId, membershipToken: input.membershipToken, origin: normalizeOrigin(input.origin) }
}

function validateMembership(lease: RuntimeUnitReplicaMembership): void {
  validateRegistration(lease)
  if (typeof lease.generation !== 'bigint' || lease.generation < 1n) {
    throw new RangeError('generation must be a positive bigint')
  }
}

function validateResourceScope(scope: RuntimeResourceScope): RuntimeResourceScope {
  const replicaScope = validateReplicaScope(scope)
  if (scope.resourceType !== 'session' && scope.resourceType !== 'task') {
    throw new TypeError('resourceType must be session or task')
  }
  validateText(scope.resourceId, 'resourceId')
  return { ...replicaScope, resourceType: scope.resourceType, resourceId: scope.resourceId }
}

function validateOwnership(lease: RuntimeResourceOwnership): void {
  validateResourceScope(lease)
  validateText(lease.replicaId, 'replicaId')
  validateText(lease.membershipToken, 'membershipToken')
  validateText(lease.ownerToken, 'ownerToken')
  if (typeof lease.membershipGeneration !== 'bigint' || lease.membershipGeneration < 1n) {
    throw new RangeError('membershipGeneration must be a positive bigint')
  }
  if (typeof lease.generation !== 'bigint' || lease.generation < 1n) {
    throw new RangeError('generation must be a positive bigint')
  }
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
