import { createRequire } from 'node:module'
import { observePostgresConnectionErrors, type PostgresConnectionErrorEvents } from '../postgres-connection-errors.js'

import { tracePostgresQuery, type OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'

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
  Pool: new (config: Record<string, unknown>) => RuntimeResourceOwnershipDatabase & PostgresConnectionErrorEvents
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

export class RuntimeWorkspaceEffectActiveError extends Error {
  readonly code = 'RUNTIME_WORKSPACE_EFFECT_ACTIVE'
  constructor() {
    super('runtime resource ownership cannot transfer while a workspace effect is unresolved')
    this.name = 'RuntimeWorkspaceEffectActiveError'
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
  readonly #effects: string
  readonly #learningJobs: string
  readonly #arenaClaims: string
  readonly #arenaNonAdmissions: string
  readonly #arenaReconcile: string
  readonly #arenaOperatorState: string
  readonly #arenaRepairInit: string
  #closed = false

  constructor(readonly database: RuntimeResourceOwnershipDatabase, options: { schema?: string } = {}) {
    const schema = quoteIdentifier(options.schema ?? 'public')
    this.#memberships = `${schema}.tenant_runtime_unit_replica_memberships`
    this.#ownerships = `${schema}.tenant_runtime_resource_ownerships`
    this.#effects = `${schema}.tenant_runtime_active_workspace_effects`
    this.#learningJobs = `${schema}.tenant_runtime_background_learning_jobs`
    this.#arenaClaims = `${schema}.tenant_runtime_arena_repository_claims`
    this.#arenaNonAdmissions = `${schema}.tenant_runtime_arena_non_admissions`
    this.#arenaReconcile = `${schema}.kala_reconcile_arena_effect`
    this.#arenaOperatorState = `${schema}.kala_arena_operator_state`
    this.#arenaRepairInit = `${schema}.kala_arena_repair_init`
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
      await this.#assertNoWorkspaceEffects(transaction, normalizedScope)
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
      const selected = await transaction.query<OwnershipRow>(`SELECT * FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
        FOR UPDATE`, resourceValues(lease))
      const current = selected.rows[0]
      if (current && current.owner_token === lease.ownerToken && BigInt(current.generation) === lease.generation
        && current.replica_id === lease.replicaId && current.membership_token === lease.membershipToken
        && BigInt(current.membership_generation) === lease.membershipGeneration) {
        await this.#assertNoWorkspaceEffects(transaction, lease)
      }
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

  /**
   * Declares an effect before Executor admission. An unresolved row survives
   * lease expiry, disconnects and crashes; only confirmed final process exit
   * (including descendants capable of mutation) permits completion.
   */
  async registerWorkspaceEffect(
    lease: RuntimeResourceOwnership, effectId: string, workspaceId?: string,
    repositoryIdentity?: string, arenaId?: string, prepared = false,
  ): Promise<void> {
    validateOwnership(lease)
    if (lease.resourceType !== 'session') throw new TypeError('workspace effects require a Session owner')
    validateText(effectId, 'effectId')
    if (workspaceId !== undefined) validateText(workspaceId, 'workspaceId')
    if (repositoryIdentity !== undefined) {
      validateText(repositoryIdentity, 'repositoryIdentity')
      validateText(arenaId ?? '', 'arenaId')
    }
    await this.#transaction(async (transaction) => {
      const selected = await transaction.query(`SELECT 1 FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
        FOR UPDATE`, resourceValues(lease))
      if (selected.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
      await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
      if (repositoryIdentity) {
        const claim = await transaction.query(`SELECT 1 FROM ${this.#arenaClaims}
          WHERE repository_identity = $1 AND organization_id = $2 AND unit_id = $3
            AND resource_id = $4 AND arena_id = $5 FOR UPDATE`,
        [repositoryIdentity, lease.organizationId, lease.unitId, lease.resourceId, arenaId])
        if (claim.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
      }
      await transaction.query(`INSERT INTO ${this.#effects}
        (organization_id, unit_id, resource_type, resource_id, effect_id, owner_token, generation, workspace_id, repository_identity, dispatch_started)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString(),
        workspaceId ?? null, repositoryIdentity ?? null, !prepared])
    })
  }

  /** Durable one-way authorization; commit this before emitting even one Executor tool frame. */
  async beginWorkspaceEffectDispatch(lease: RuntimeResourceOwnership, effectId: string, requestDigest?: string): Promise<void> {
    validateOwnership(lease)
    validateText(effectId, 'effectId')
    if (requestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(requestDigest)) throw new TypeError('Invalid Arena request digest')
    await this.#transaction(async (transaction) => {
      await transaction.query(`SELECT 1 FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
      resourceValues(lease))
      await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
      const changed = await transaction.query(`UPDATE ${this.#effects} SET dispatch_started = true, request_digest = $8
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
          AND effect_id = $5 AND owner_token = $6 AND generation = $7 AND dispatch_started = false`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString(), requestDigest ?? null])
      if (changed.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
    })
  }

  /** Audit and remove only a registered, still-never-dispatched identity. No remote absence is used as proof. */
  async completeNeverDispatchedWorkspaceEffect(
    lease: RuntimeResourceOwnership, effectId: string, workspaceId: string, reason: string,
  ): Promise<void> {
    validateOwnership(lease)
    for (const [value, field] of [[effectId, 'effectId'], [workspaceId, 'workspaceId'], [reason, 'reason']] as const) {
      validateText(value, field)
    }
    await this.#transaction(async (transaction) => {
      await transaction.query(`SELECT 1 FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
      resourceValues(lease))
      await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
      const removed = await transaction.query(`DELETE FROM ${this.#effects}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
          AND effect_id = $5 AND owner_token = $6 AND generation = $7 AND workspace_id = $8
          AND dispatch_started = false`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString(), workspaceId])
      if (removed.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
      await transaction.query(`INSERT INTO ${this.#arenaNonAdmissions}
        (organization_id, unit_id, resource_id, effect_id, generation, workspace_id, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [lease.organizationId, lease.unitId, lease.resourceId, effectId, lease.generation.toString(), workspaceId, reason])
    })
  }

  /** A claim persists throughout the Arena lifetime, not just while a Git call runs. */
  async claimArenaRepository(lease: RuntimeResourceOwnership, repositoryIdentity: string, arenaId: string): Promise<void> {
    validateOwnership(lease)
    if (lease.resourceType !== 'session') throw new TypeError('Arena claims require Session ownership')
    validateText(repositoryIdentity, 'repositoryIdentity')
    validateText(arenaId, 'arenaId')
    await this.#transaction(async (transaction) => {
      await transaction.query(`SELECT 1 FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
      resourceValues(lease))
      await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
      // Legacy/UNKNOWN Arena rows without an identity still block every
      // repository. Named Skill/memory effects instead fence their own Session.
      const unscoped = await transaction.query(`SELECT 1 FROM ${this.#effects}
        WHERE repository_identity = $1 OR (repository_identity IS NULL
          AND effect_id !~ '^(skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$')
        LIMIT 1`, [repositoryIdentity])
      if (unscoped.rowCount) throw new RuntimeWorkspaceEffectActiveError()
      await transaction.query(`INSERT INTO ${this.#arenaClaims}
        (repository_identity, organization_id, unit_id, resource_id, arena_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (repository_identity) DO NOTHING`,
      [repositoryIdentity, lease.organizationId, lease.unitId, lease.resourceId, arenaId])
      const claim = await transaction.query(`SELECT 1 FROM ${this.#arenaClaims}
        WHERE repository_identity = $1 AND organization_id = $2 AND unit_id = $3
          AND resource_id = $4 AND arena_id = $5 FOR UPDATE`,
      [repositoryIdentity, lease.organizationId, lease.unitId, lease.resourceId, arenaId])
      if (claim.rowCount !== 1) throw new RuntimeResourceOwnershipHeldError('arena-repository', lease.expiresAt)
    })
  }

  /** One commit either owns both the repository and its never-dispatched init effect, or neither. */
  async prepareArenaInitEffect(
    lease: RuntimeResourceOwnership, effectId: string, workspaceId: string,
    repositoryIdentity: string, arenaId: string,
  ): Promise<void> {
    validateOwnership(lease)
    if (lease.resourceType !== 'session' || !/^arena-init-[A-Z0-9]+$/u.test(effectId)) {
      throw new TypeError('Arena init requires a Session and named init effect')
    }
    for (const [value, field] of [[workspaceId, 'workspaceId'], [repositoryIdentity, 'repositoryIdentity'],
      [arenaId, 'arenaId']] as const) validateText(value, field)
    await this.#transaction(async (transaction) => {
      await transaction.query(`SELECT 1 FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
      resourceValues(lease))
      await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
      const blocked = await transaction.query(`SELECT 1 FROM ${this.#effects}
        WHERE repository_identity = $1 OR (repository_identity IS NULL
          AND effect_id !~ '^(skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$')
        LIMIT 1`, [repositoryIdentity])
      if (blocked.rowCount) throw new RuntimeWorkspaceEffectActiveError()
      const claimed = await transaction.query(`INSERT INTO ${this.#arenaClaims}
        (repository_identity, organization_id, unit_id, resource_id, arena_id)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (repository_identity) DO NOTHING RETURNING 1`,
      [repositoryIdentity, lease.organizationId, lease.unitId, lease.resourceId, arenaId])
      if (claimed.rowCount !== 1) throw new RuntimeResourceOwnershipHeldError('arena-repository', lease.expiresAt)
      await transaction.query(`INSERT INTO ${this.#effects}
        (organization_id, unit_id, resource_type, resource_id, effect_id,
          owner_token, generation, workspace_id, repository_identity, dispatch_started)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString(),
        workspaceId, repositoryIdentity])
    })
  }

  /** Legacy two-step release, retained for pre-v27 incident fixtures; production Host uses completeArenaCleanupEffect. */
  async releaseArenaRepository(
    lease: RuntimeResourceOwnership, repositoryIdentity: string, arenaId: string, cleanupEffectId: string,
  ): Promise<void> {
    validateOwnership(lease)
    for (const [value, label] of [[repositoryIdentity, 'repositoryIdentity'], [arenaId, 'arenaId'], [cleanupEffectId, 'cleanupEffectId']] as const) {
      validateText(value, label)
    }
    await this.#transaction(async (transaction) => {
      const selected = await transaction.query<OwnershipRow>(`SELECT * FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
      resourceValues(lease))
      const current = selected.rows[0]
      if (!current || current.owner_token !== lease.ownerToken || BigInt(current.generation) !== lease.generation) {
        throw new RuntimeResourceOwnershipFencedError()
      }
      const effect = await transaction.query(`SELECT 1 FROM ${this.#effects}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
          AND effect_id = $5 AND owner_token = $6 AND generation = $7 AND repository_identity = $8`,
      [...resourceValues(lease), cleanupEffectId, lease.ownerToken, lease.generation.toString(), repositoryIdentity])
      if (effect.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
      const removed = await transaction.query(`DELETE FROM ${this.#arenaClaims}
        WHERE repository_identity = $1 AND organization_id = $2 AND unit_id = $3
          AND resource_id = $4 AND arena_id = $5`,
      [repositoryIdentity, lease.organizationId, lease.unitId, lease.resourceId, arenaId])
      if (removed.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
    })
  }

  /** Completes the final stopped cleanup and releases its claim in one owner-fenced commit. */
  async completeArenaCleanupEffect(
    lease: RuntimeResourceOwnership, effectId: string, repositoryIdentity: string, arenaId: string,
  ): Promise<void> {
    validateOwnership(lease)
    if (lease.resourceType !== 'session' || !/^arena-cleanup-[A-Z0-9]+$/u.test(effectId)) {
      throw new TypeError('Arena cleanup requires a Session and named cleanup effect')
    }
    for (const [value, field] of [[repositoryIdentity, 'repositoryIdentity'],
      [arenaId, 'arenaId']] as const) validateText(value, field)
    await this.#transaction(async (transaction) => {
      const selected = await transaction.query<OwnershipRow>(`SELECT * FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
        FOR UPDATE`, resourceValues(lease))
      const owner = selected.rows[0]
      if (!owner || owner.owner_token !== lease.ownerToken || BigInt(owner.generation) !== lease.generation
        || owner.replica_id !== lease.replicaId || owner.membership_token !== lease.membershipToken
        || BigInt(owner.membership_generation) !== lease.membershipGeneration) {
        throw new RuntimeResourceOwnershipFencedError()
      }
      const effect = await transaction.query(`SELECT 1 FROM ${this.#effects}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
          AND effect_id = $5 AND owner_token = $6 AND generation = $7 AND repository_identity = $8
        FOR UPDATE`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString(), repositoryIdentity])
      if (effect.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
      const claim = await transaction.query(`DELETE FROM ${this.#arenaClaims}
        WHERE repository_identity = $1 AND organization_id = $2 AND unit_id = $3
          AND resource_id = $4 AND arena_id = $5`,
      [repositoryIdentity, lease.organizationId, lease.unitId, lease.resourceId, arenaId])
      if (claim.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
      const removed = await transaction.query(`DELETE FROM ${this.#effects}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
          AND effect_id = $5 AND owner_token = $6 AND generation = $7 AND repository_identity = $8`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString(), repositoryIdentity])
      if (removed.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
    })
  }

  /** Does not attest success; callers must prove the entire mutation tree has stopped. */
  async completeWorkspaceEffect(lease: RuntimeResourceOwnership, effectId: string): Promise<void> {
    validateOwnership(lease)
    if (lease.resourceType !== 'session') throw new TypeError('workspace effects require a Session owner')
    validateText(effectId, 'effectId')
    await this.#transaction(async (transaction) => {
      const selected = await transaction.query<OwnershipRow>(`SELECT * FROM ${this.#ownerships}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
        FOR UPDATE`, resourceValues(lease))
      const current = selected.rows[0]
      if (!current || current.owner_token !== lease.ownerToken || BigInt(current.generation) !== lease.generation
        || current.replica_id !== lease.replicaId || current.membership_token !== lease.membershipToken
        || BigInt(current.membership_generation) !== lease.membershipGeneration) {
        throw new RuntimeResourceOwnershipFencedError()
      }

      const removed = await transaction.query(`DELETE FROM ${this.#effects}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
          AND effect_id = $5 AND owner_token = $6 AND generation = $7`,
      [...resourceValues(lease), effectId, lease.ownerToken, lease.generation.toString()])
      if (removed.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
    })
  }

  async enqueueBackgroundLearning(lease: RuntimeResourceOwnership, fingerprint: string): Promise<void> {
    this.#validateLearningJob(lease, fingerprint)
    await this.#transaction(async (transaction) => {
      await this.#assertLearningOwner(transaction, lease)
      await transaction.query(`INSERT INTO ${this.#learningJobs}
        (organization_id, unit_id, resource_id, fingerprint, status)
        VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING`,
      [lease.organizationId, lease.unitId, lease.resourceId, fingerprint])
    })
  }

  /** One generation claims exactly once, before model extraction or any filesystem effect. */
  async claimBackgroundLearning(lease: RuntimeResourceOwnership, fingerprint: string): Promise<boolean> {
    this.#validateLearningJob(lease, fingerprint)
    return await this.#transaction(async (transaction) => {
      await this.#assertLearningOwner(transaction, lease)
      const changed = await transaction.query(`UPDATE ${this.#learningJobs}
        SET status = 'attempted', owner_generation = $5, attempted_at = clock_timestamp()
        WHERE organization_id = $1 AND unit_id = $2 AND resource_id = $3
          AND fingerprint = $4 AND status = 'pending' RETURNING fingerprint`,
      [lease.organizationId, lease.unitId, lease.resourceId, fingerprint, lease.generation.toString()])
      return changed.rowCount === 1
    })
  }

  async finishBackgroundLearning(lease: RuntimeResourceOwnership, fingerprint: string, error?: string): Promise<void> {
    this.#validateLearningJob(lease, fingerprint)
    await this.#transaction(async (transaction) => {
      await this.#assertLearningOwner(transaction, lease)
      const changed = await transaction.query(`UPDATE ${this.#learningJobs}
        SET status = 'completed', completed_at = clock_timestamp(), error = $6
        WHERE organization_id = $1 AND unit_id = $2 AND resource_id = $3
          AND fingerprint = $4 AND owner_generation = $5 AND status = 'attempted'`,
      [lease.organizationId, lease.unitId, lease.resourceId, fingerprint, lease.generation.toString(),
        error?.slice(0, 2_000) ?? null])
      if (changed.rowCount !== 1) throw new RuntimeResourceOwnershipFencedError()
    })
  }

  async pendingBackgroundLearning(lease: RuntimeResourceOwnership): Promise<string[]> {
    validateOwnership(lease)
    if (lease.resourceType !== 'session') throw new TypeError('background learning requires a Session owner')
    return await this.#transaction(async (transaction) => {
      await this.#assertLearningOwner(transaction, lease)
      const selected = await transaction.query<{ fingerprint: string }>(`SELECT fingerprint FROM ${this.#learningJobs}
        WHERE organization_id = $1 AND unit_id = $2 AND resource_id = $3 AND status = 'pending'
        ORDER BY created_at LIMIT 100`,
      [lease.organizationId, lease.unitId, lease.resourceId])
      return selected.rows.map((row) => row.fingerprint)
    })
  }

  #validateLearningJob(lease: RuntimeResourceOwnership, fingerprint: string): void {
    validateOwnership(lease)
    if (lease.resourceType !== 'session' || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new TypeError('background learning requires a Session owner and SHA-256 fingerprint')
    }
  }

  async #assertLearningOwner(transaction: RuntimeResourceOwnershipSqlExecutor,
    lease: RuntimeResourceOwnership): Promise<void> {
    await transaction.query(`SELECT 1 FROM ${this.#ownerships}
      WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
    resourceValues(lease))
    await assertResourceOwnerInTables(transaction, this.#memberships, this.#ownerships, lease)
  }

  /** Bounded operator read: never mutates ownership, claims, or unresolved effects. */
  async inspectWorkspaceEffects(scope: RuntimeResourceScope, limit = 20): Promise<Array<{
    effectId: string; generation: bigint; workspaceId: string | null
    repositoryIdentity: string | null; createdAt: Date
  }>> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Arena inspection requires a Session and limit of 1..100')
    }
    const rows = await this.database.query<{
      effect_id: string; generation: string; workspace_id: string | null
      repository_identity: string | null; created_at: Date
    }>(`SELECT effect_id, generation, workspace_id, repository_identity, created_at
      FROM ${this.#effects}
      WHERE organization_id = $1 AND unit_id = $2 AND resource_type = 'session' AND resource_id = $3
      ORDER BY created_at, effect_id LIMIT $4`,
    [normalized.organizationId, normalized.unitId, normalized.resourceId, limit])
    return rows.rows.map((row) => ({
      effectId: row.effect_id, generation: BigInt(row.generation),
      workspaceId: row.workspace_id, repositoryIdentity: row.repository_identity, createdAt: row.created_at,
    }))
  }

  /** Operator LOGIN sees only effects in its own organization through a scoped definer function. */
  async inspectOperatorArenaEffects(scope: RuntimeResourceScope, limit = 20): Promise<Array<{
    effectId: string; generation: bigint; workspaceId: string | null
    repositoryIdentity: string | null; createdAt: Date
  }>> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Arena inspection requires a Session and limit of 1..100')
    }
    const rows = await this.database.query<{
      effect_id: string; generation: string; workspace_id: string | null
      repository_identity: string | null; created_at: Date
    }>(`SELECT * FROM ${this.#arenaOperatorState.replace(/operator_state$/u, 'operator_effects')}($1,$2,$3,$4)`,
    [normalized.organizationId, normalized.unitId, normalized.resourceId, limit])
    return rows.rows.map((row) => ({
      effectId: row.effect_id, generation: BigInt(row.generation),
      workspaceId: row.workspace_id, repositoryIdentity: row.repository_identity, createdAt: row.created_at,
    }))
  }

  /** Tenant-scoped durable pre-dispatch marker; NULL means the effect is absent. */
  async inspectOperatorArenaDispatch(scope: RuntimeResourceScope, effectId: string): Promise<{
    started: boolean; digest: string | null
  } | null> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session') throw new TypeError('Arena inspection requires a Session')
    validateText(effectId, 'effectId')
    const rows = await this.database.query<{ dispatch: { started: boolean; digest: string | null } | null }>(
      `SELECT ${this.#arenaOperatorState.replace(/operator_state$/u, 'operator_dispatch')}(
        $1,$2,$3,$4) AS dispatch`,
      [normalized.organizationId, normalized.unitId, normalized.resourceId, effectId])
    return rows.rows[0]?.dispatch ?? null
  }

  /** Scoped incident inspection only; attempted extraction is not safe to replay. */
  async inspectOperatorLearningJobs(scope: RuntimeResourceScope, limit = 20): Promise<Array<{
    fingerprint: string; status: 'pending' | 'attempted' | 'completed'
    ownerGeneration: bigint | null; createdAt: Date; attemptedAt: Date | null
    completedAt: Date | null; error: string | null
  }>> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('learning inspection requires a Session and limit of 1..100')
    }
    const rows = await this.database.query<{
      fingerprint: string; status: 'pending' | 'attempted' | 'completed'
      owner_generation: string | null; created_at: Date; attempted_at: Date | null
      completed_at: Date | null; error: string | null
    }>(`SELECT * FROM ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_operator_learning_jobs')}(
      $1,$2,$3,$4)`,
    [normalized.organizationId, normalized.unitId, normalized.resourceId, limit])
    return rows.rows.map((row) => ({
      fingerprint: row.fingerprint, status: row.status,
      ownerGeneration: row.owner_generation === null ? null : BigInt(row.owner_generation),
      createdAt: row.created_at, attemptedAt: row.attempted_at,
      completedAt: row.completed_at, error: row.error,
    }))
  }

  /** Only PG's locked, still-prepared effect row proves no Executor frame could have been emitted. */
  async reconcileLearningPrepared(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    operatorId: string; incidentId: string
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session'
      || !/^(?:skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u.test(input.effectId)
      || input.generation < 1n) throw new TypeError('invalid prepared learning effect')
    for (const [value, field] of [[input.workspaceId, 'workspaceId'],
      [input.operatorId, 'operatorId'], [input.incidentId, 'incidentId']] as const) validateText(value, field)
    try {
      await this.database.query(`SELECT ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_reconcile_learning_prepared')}(
        $1,$2,$3,$4,$5::bigint,$6,$7,$8)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId,
        input.generation.toString(), input.workspaceId, input.operatorId, input.incidentId])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  /** Scoped operator-only release after an independent original-journal/process/target inspection. */
  async reconcileLearningCompleted(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    operatorId: string; incidentId: string; evidence: Record<string, unknown>
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session'
      || !/^(?:skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u.test(input.effectId)
      || input.generation < 1n || !input.evidence || JSON.stringify(input.evidence).length > 16_000) {
      throw new TypeError('invalid completed learning effect')
    }
    for (const [value, field] of [[input.workspaceId, 'workspaceId'],
      [input.operatorId, 'operatorId'], [input.incidentId, 'incidentId']] as const) validateText(value, field)
    try {
      await this.database.query(`SELECT ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_reconcile_learning_completed')}(
        $1,$2,$3,$4,$5::bigint,$6,$7,$8,$9::jsonb)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId,
        input.generation.toString(), input.workspaceId, input.operatorId, input.incidentId,
        JSON.stringify(input.evidence)])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  /** Scoped incident resolution only for an original durable negative admission. */
  async reconcileLearningDenied(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    operatorId: string; incidentId: string; evidence: Record<string, unknown>
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session'
      || !/^(?:skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u.test(input.effectId)
      || input.generation < 1n || !input.evidence || JSON.stringify(input.evidence).length > 16_000) {
      throw new TypeError('invalid denied learning effect')
    }
    for (const [value, field] of [[input.workspaceId, 'workspaceId'],
      [input.operatorId, 'operatorId'], [input.incidentId, 'incidentId']] as const) validateText(value, field)
    try {
      await this.database.query(`SELECT ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_reconcile_learning_denied')}(
        $1,$2,$3,$4,$5::bigint,$6,$7,$8,$9::jsonb)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId,
        input.generation.toString(), input.workspaceId, input.operatorId, input.incidentId,
        JSON.stringify(input.evidence)])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  /** Read-only tenant-operator proof that the original PG effect was finally removed. */
  async inspectOperatorLearningFinalization(scope: RuntimeResourceScope, effectId: string): Promise<{
    generation: bigint; workspaceId: string; requestDigest: string
  } | null> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session'
      || !/^(?:skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u.test(effectId)) {
      throw new TypeError('invalid learning finalization scope')
    }
    let rows: Array<{ generation: string; workspace_id: string; request_digest: string }>
    try {
      const result = await this.database.query<{
        generation: string; workspace_id: string; request_digest: string
      }>(`SELECT * FROM ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_operator_learning_finalization')}(
        $1,$2,$3,$4)`,
      [normalized.organizationId, normalized.unitId, normalized.resourceId, effectId])
      rows = result.rows
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
    const row = rows[0]
    return row ? {
      generation: BigInt(row.generation), workspaceId: row.workspace_id, requestDigest: row.request_digest,
    } : null
  }

  /** Scoped read for the legacy release-before-effect crash window; NULL is not proof of no other tenant's claim. */
  async inspectOperatorArenaClaim(scope: RuntimeResourceScope, repositoryIdentity: string): Promise<string | null> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session') throw new TypeError('Arena inspection requires a Session')
    validateText(repositoryIdentity, 'repositoryIdentity')
    const rows = await this.database.query<{ arena_id: string | null }>(
      `SELECT ${this.#arenaOperatorState.replace(/operator_state$/u, 'operator_claim')}(
        $1,$2,$3,$4) AS arena_id`,
      [normalized.organizationId, normalized.unitId, normalized.resourceId, repositoryIdentity])
    return rows.rows[0]?.arena_id ?? null
  }

  /** Only the scoped operator can atomically audit and release a proven never-dispatched or completed probe effect. */
  async reconcileArenaOffline(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    operatorId: string; incidentId: string; evidence: Record<string, unknown>
    arenaState: unknown; mode: 'prepared' | 'probe'
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session') throw new TypeError('Arena reconciliation requires a Session')
    for (const [value, field] of [[input.effectId, 'effectId'], [input.workspaceId, 'workspaceId'],
      [input.operatorId, 'operatorId'], [input.incidentId, 'incidentId']] as const) validateText(value, field)
    if (input.generation < 1n || !input.evidence
      || JSON.stringify(input.evidence).length > 32_000) throw new TypeError('Invalid Arena evidence')
    try {
      await this.database.query(`SELECT ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_reconcile_arena_offline')}(
        $1,$2,$3,$4,$5::bigint,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId,
        input.generation.toString(), input.workspaceId, input.operatorId, input.incidentId,
        JSON.stringify(input.evidence), input.arenaState == null ? null : JSON.stringify(input.arenaState), input.mode])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  /** Prepared init is special: the claim, effect and any initializing metadata are compensated together. */
  async reconcileArenaPreparedInit(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    operatorId: string; incidentId: string; evidence: Record<string, unknown>; arenaState: unknown
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session' || !/^arena-init-[A-Z0-9]+$/u.test(input.effectId)
      || input.generation < 1n || JSON.stringify(input.evidence).length > 32_000) {
      throw new TypeError('Invalid prepared Arena init evidence')
    }
    for (const [value, field] of [[input.workspaceId, 'workspaceId'], [input.operatorId, 'operatorId'],
      [input.incidentId, 'incidentId']] as const) validateText(value, field)
    try {
      await this.database.query(`SELECT ${this.#arenaOperatorState.replace(/kala_arena_operator_state$/u, 'kala_reconcile_arena_prepared_init')}(
        $1,$2,$3,$4,$5::bigint,$6,$7,$8,$9::jsonb,$10::jsonb)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId,
        input.generation.toString(), input.workspaceId, input.operatorId, input.incidentId,
        JSON.stringify(input.evidence), input.arenaState == null ? null : JSON.stringify(input.arenaState)])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  /** Exposes only the latest durable Arena metadata for a live Session, never arbitrary Session contents. */
  async readArenaAuthorityState(scope: RuntimeResourceScope): Promise<unknown> {
    const normalized = validateResourceScope(scope)
    if (normalized.resourceType !== 'session') throw new TypeError('Arena state requires a Session')
    const result = await this.database.query<{ arena: unknown }>(`SELECT ${this.#arenaOperatorState}($1, $2) AS arena`,
      [normalized.organizationId, normalized.resourceId])
    return result.rows[0]?.arena
  }

  /** Repairs only a fully verified init intent; leaves the active effect UNKNOWN for separate reconciliation. */
  async repairArenaInit(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    repositoryIdentity: string; operatorId: string; incidentId: string
    oldState: Record<string, unknown>; newState: Record<string, unknown>; evidence: Record<string, unknown>
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session') throw new TypeError('Arena init repair requires a Session')
    for (const [value, field] of [[input.effectId, 'effectId'], [input.workspaceId, 'workspaceId'],
      [input.repositoryIdentity, 'repositoryIdentity'], [input.operatorId, 'operatorId'],
      [input.incidentId, 'incidentId']] as const) validateText(value, field)
    if (input.generation < 1n || !input.oldState || !input.newState || !input.evidence
      || JSON.stringify(input.oldState).length > 32_000 || JSON.stringify(input.newState).length > 32_000
      || JSON.stringify(input.evidence).length > 32_000) throw new TypeError('Invalid Arena init repair evidence')
    try {
      await this.database.query(`SELECT ${this.#arenaRepairInit}(
        $1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId,
        input.generation.toString(), input.workspaceId, input.repositoryIdentity,
        input.operatorId, input.incidentId, JSON.stringify(input.oldState),
        JSON.stringify(input.newState), JSON.stringify(input.evidence)])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  /** Operator-only call after independent Linux process and repository verification. Never run on UNKNOWN automatically. */
  async reconcileArenaEffect(input: {
    scope: RuntimeResourceScope; effectId: string; generation: bigint; workspaceId: string
    repositoryIdentity: string | null; operatorId: string; incidentId: string
    evidence: Record<string, unknown>; arenaState: Record<string, unknown>; releaseClaimArenaId?: string
  }): Promise<void> {
    const scope = validateResourceScope(input.scope)
    if (scope.resourceType !== 'session') throw new TypeError('Arena reconciliation requires a Session')
    for (const [value, field] of [[input.effectId, 'effectId'], [input.workspaceId, 'workspaceId'],
      [input.operatorId, 'operatorId'], [input.incidentId, 'incidentId']] as const) validateText(value, field)
    if (input.repositoryIdentity !== null) validateText(input.repositoryIdentity, 'repositoryIdentity')
    if (input.releaseClaimArenaId) {
      validateText(input.releaseClaimArenaId, 'releaseClaimArenaId')
      if (input.evidence?.action !== 'cleanup') throw new TypeError('Only reconciled cleanup may release an Arena claim')
    }
    if (input.generation < 1n || !input.evidence || !input.arenaState
      || JSON.stringify(input.evidence).length > 32_000 || JSON.stringify(input.arenaState).length > 32_000) {
      throw new TypeError('Invalid or oversized Arena reconciliation evidence')
    }
    try {
      await this.database.query(`SELECT ${this.#arenaReconcile}(
        $1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb)`,
      [scope.organizationId, scope.unitId, scope.resourceId, input.effectId, input.generation.toString(),
        input.workspaceId, input.repositoryIdentity, input.operatorId, input.incidentId,
        JSON.stringify(input.evidence), input.releaseClaimArenaId ?? null, JSON.stringify(input.arenaState)])
    } catch (error) {
      if ((error as { code?: string }).code === 'P0001') throw new RuntimeResourceOwnershipFencedError()
      throw error
    }
  }

  async #assertNoWorkspaceEffects(
    transaction: RuntimeResourceOwnershipSqlExecutor,
    scope: RuntimeResourceScope,
  ): Promise<void> {
    const active = await transaction.query(`SELECT 1 FROM ${this.#effects}
      WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4
      LIMIT 1`, resourceValues(scope))
    if (active.rowCount !== 0) throw new RuntimeWorkspaceEffectActiveError()
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
  telemetry?: OnlineTelemetry
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
  observePostgresConnectionErrors(pool, 'resource-ownership')
  const database: RuntimeResourceOwnershipDatabase = options.telemetry ? {
    query: (text, values) => tracePostgresQuery(options.telemetry, () => pool.query(text, values)),
    async connect() {
      const client = await pool.connect()
      return {
        query: (text, values) => tracePostgresQuery(options.telemetry, () => client.query(text, values)),
        release: () => client.release(),
      }
    },
    end: () => pool.end(),
  } : pool
  return new PostgresRuntimeResourceOwnershipStore(database, { schema: options.schema })
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
