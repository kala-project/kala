import { randomUUID } from 'node:crypto'

import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import type { RuntimeResourceOwnership } from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { RuntimeResourceOwnershipFencedError } from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import {
  LeaseHeldError,
  type HotStateEvent,
  type HotStateSqlExecutor,
  type PostgresHotStateStore,
} from '../tenant-runtime/postgres-hot-state.js'
import type { ArtifactObjectStore } from './object-store.js'
import type { ObjectCapacityLedger, ObjectCapacityMutation } from './postgres-object-capacity.js'

export type ObjectMetadataEvent<Payload = unknown> = Pick<HotStateEvent<Payload>, 'sequence' | 'eventType' | 'payload' | 'createdAt'>

export type ObjectOrphanIntent = {
  intentId: string
  sessionId: string
  objectKey: string
}

export type OrphanReconciliationResult = {
  claimed: number
  deleted: number
  failed: number
}

export interface ObjectMetadataLog {
  initialize(): Promise<void>
  replay<Payload = unknown>(sessionId: string): Promise<readonly ObjectMetadataEvent<Payload>[]>
  beginSessionDeletion(sessionId: string): Promise<void>
  prepareObject(sessionId: string, objectKey: string): Promise<ObjectOrphanIntent>
  append<Payload>(sessionId: string, input: { idempotencyKey: string; eventType: string; payload: Payload; intent?: ObjectOrphanIntent; capacity?: ObjectCapacityMutation; allowDuringSessionDeletion?: boolean; guard?: (events: readonly ObjectMetadataEvent[]) => void }, sideEffect?: (transaction: HotStateSqlExecutor) => Promise<void>): Promise<void>
  completeObjectCleanup(intent: ObjectOrphanIntent): Promise<void>
}

export class ObjectMetadataSessionDeletingError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being deleted`)
    this.name = 'ObjectMetadataSessionDeletingError'
  }
}

type IntentRow = Record<string, unknown> & { intent_id: string; session_id: string; object_key: string }

/**
 * Stores only small attachment/artifact metadata in PostgreSQL. Object bytes
 * always stay in ArtifactObjectStore. Each Session is independently fenced so
 * two Runtime processes cannot concurrently assign conflicting event order.
 */
export class PostgresObjectMetadataLog implements ObjectMetadataLog {
  private readonly ownerId = `object-metadata-${randomUUID()}`
  private readonly tails = new Map<string, Promise<void>>()
  private readonly leaseTtlMs: number
  private readonly uploadIntentLeaseMs: number
  private readonly intentsTable: string
  private readonly eventsTable: string
  private readonly deletionsTable: string
  private readonly membershipsTable: string
  private readonly ownershipsTable: string
  private readonly schemaManagement: PostgresSchemaManagement
  private readonly capacity: ObjectCapacityLedger | undefined
  private readonly prepareSessionOwner?: (sessionId: string) => Promise<void>
  private readonly resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined

  constructor(
    private readonly organizationId: string,
    private readonly hotState: PostgresHotStateStore,
    options: number | { leaseTtlMs?: number; uploadIntentLeaseMs?: number; schema?: string; schemaManagement?: PostgresSchemaManagement; capacity?: ObjectCapacityLedger;
      prepareSessionOwner?: (sessionId: string) => Promise<void>; resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined } = {},
  ) {
    this.leaseTtlMs = typeof options === 'number' ? options : options.leaseTtlMs ?? 15_000
    this.uploadIntentLeaseMs = typeof options === 'number' ? 300_000 : options.uploadIntentLeaseMs ?? 300_000
    if (!Number.isSafeInteger(this.uploadIntentLeaseMs) || this.uploadIntentLeaseMs < 1) {
      throw new RangeError('Object upload intent lease must be a positive safe integer')
    }
    const schema = quoteIdentifier(typeof options === 'number' ? 'public' : options.schema ?? 'public')
    this.intentsTable = `${schema}.tenant_object_orphan_intents`
    this.eventsTable = `${schema}.tenant_runtime_hot_events`
    this.deletionsTable = `${schema}.tenant_object_session_deletions`
    this.membershipsTable = `${schema}.tenant_runtime_unit_replica_memberships`
    this.ownershipsTable = `${schema}.tenant_runtime_resource_ownerships`
    this.schemaManagement = typeof options === 'number' ? 'initialize' : options.schemaManagement ?? 'initialize'
    this.capacity = typeof options === 'number' ? undefined : options.capacity
    this.prepareSessionOwner = typeof options === 'number' ? undefined : options.prepareSessionOwner
    this.resourceOwnerForSession = typeof options === 'number' ? undefined : options.resourceOwnerForSession
    if (Boolean(this.prepareSessionOwner) !== Boolean(this.resourceOwnerForSession)) {
      throw new TypeError('Object metadata Session owner requires both prepare and live lease provider')
    }
  }

  async initialize(): Promise<void> {
    if (this.schemaManagement === 'external') return
    await this.hotState.initialize()
    await this.hotState.database.query(`CREATE TABLE IF NOT EXISTS ${this.intentsTable} (
      tenant_id text NOT NULL,
      object_key text NOT NULL,
      intent_id uuid NOT NULL,
      session_id text NOT NULL,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting')),
      claim_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      upload_expires_at timestamptz NOT NULL,
      claimed_at timestamptz,
      owner_unit_id text,
      owner_replica_id text,
      owner_membership_generation bigint,
      owner_membership_token text,
      owner_token text,
      owner_generation bigint,
      PRIMARY KEY (tenant_id, object_key),
      UNIQUE (tenant_id, intent_id),
      CHECK ((state = 'pending' AND claim_id IS NULL AND claimed_at IS NULL)
        OR (state = 'deleting' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)),
      CHECK ((owner_unit_id IS NULL AND owner_replica_id IS NULL AND owner_membership_generation IS NULL
          AND owner_membership_token IS NULL AND owner_token IS NULL AND owner_generation IS NULL)
        OR (owner_unit_id IS NOT NULL AND owner_replica_id IS NOT NULL AND owner_membership_generation IS NOT NULL
          AND owner_membership_token IS NOT NULL AND owner_token IS NOT NULL AND owner_generation IS NOT NULL))
    )`)
    await this.hotState.database.query(`CREATE INDEX IF NOT EXISTS tenant_object_orphan_intents_reconcile_idx
      ON ${this.intentsTable} (tenant_id, state, upload_expires_at)`)
    await this.hotState.database.query(`CREATE TABLE IF NOT EXISTS ${this.deletionsTable} (
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, session_id)
    )`)
  }

  async replay<Payload = unknown>(sessionId: string): Promise<readonly ObjectMetadataEvent<Payload>[]> {
    const events: ObjectMetadataEvent<Payload>[] = []
    let afterSequence = 0n
    while (true) {
      const page = await this.hotState.replay<Payload>(this.scope(sessionId), { afterSequence, limit: 1000 })
      events.push(...page)
      if (page.length < 1000) return events
      afterSequence = page.at(-1)!.sequence
    }
  }

  async prepareObject(sessionId: string, objectKey: string): Promise<ObjectOrphanIntent> {
    this.scope(sessionId)
    validateObjectKey(objectKey)
    const intent = { intentId: randomUUID(), sessionId, objectKey }
    await this.prepareSessionOwner?.(sessionId)
    const inserted = await this.hotState.database.transaction(async (transaction) => {
      const owner = this.currentOwner(sessionId)
      await this.assertOwner(transaction, sessionId, owner)
      return await transaction.query(`INSERT INTO ${this.intentsTable}
        (tenant_id, object_key, intent_id, session_id, upload_expires_at,
          owner_unit_id, owner_replica_id, owner_membership_generation, owner_membership_token, owner_token, owner_generation)
        SELECT $1, $2, $3, $4, clock_timestamp() + $5 * interval '1 millisecond', $6, $7, $8, $9, $10, $11
        WHERE NOT EXISTS (SELECT 1 FROM ${this.deletionsTable} WHERE tenant_id = $1 AND session_id = $4)
        RETURNING intent_id`, [this.organizationId, objectKey, intent.intentId, sessionId, this.uploadIntentLeaseMs,
        owner?.unitId ?? null, owner?.replicaId ?? null, owner?.membershipGeneration ?? null,
        owner?.membershipToken ?? null, owner?.ownerToken ?? null, owner?.generation ?? null])
    })
    if (inserted.rowCount !== 1) throw new ObjectMetadataSessionDeletingError(sessionId)
    return intent
  }

  async beginSessionDeletion(sessionId: string): Promise<void> {
    const scope = this.scope(sessionId)
    const predecessor = this.tails.get(sessionId) ?? Promise.resolve()
    const operation = predecessor.then(async () => {
      await this.prepareSessionOwner?.(sessionId)
      const deadline = Date.now() + 30_000
      while (true) {
        try {
          const token = await this.hotState.acquireLease(scope, this.ownerId, this.leaseTtlMs)
          try {
            await this.hotState.database.transaction(async (transaction) => {
              await this.assertOwner(transaction, sessionId)
              await transaction.query(`INSERT INTO ${this.deletionsTable} (tenant_id, session_id)
                VALUES ($1, $2) ON CONFLICT (tenant_id, session_id) DO NOTHING`, [this.organizationId, sessionId])
            })
          } finally {
            await this.hotState.releaseLease(token).catch(() => undefined)
          }
          return
        } catch (error) {
          if (!(error instanceof LeaseHeldError) || Date.now() >= deadline) throw error
          const waitMs = Math.max(10, Math.min(250, error.expiresAt.getTime() - Date.now()))
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }
      }
    })
    this.tails.set(sessionId, operation.catch(() => undefined))
    await operation
  }

  async append<Payload>(sessionId: string, input: { idempotencyKey: string; eventType: string; payload: Payload; intent?: ObjectOrphanIntent; capacity?: ObjectCapacityMutation; allowDuringSessionDeletion?: boolean; guard?: (events: readonly ObjectMetadataEvent[]) => void }, sideEffect?: (transaction: HotStateSqlExecutor) => Promise<void>): Promise<void> {
    if (input.intent) this.validateIntent(sessionId, input.intent)
    const predecessor = this.tails.get(sessionId) ?? Promise.resolve()
    const operation = predecessor.then(async () => {
      await this.prepareSessionOwner?.(sessionId)
      const deadline = Date.now() + 30_000
      while (true) {
        try {
          const token = await this.hotState.acquireLease(this.scope(sessionId), this.ownerId, this.leaseTtlMs,
            this.resourceOwnerForSession ? async (transaction) => await this.assertOwner(transaction, sessionId) : undefined)
          try {
            await this.hotState.appendEventWithSideEffect(token, input, async (transaction, event) => {
              // The PG lease row is locked until commit. Recheck candidate records
              // against the preceding durable events, never a replica's stale replay.
              if (input.guard) {
                const previous = await transaction.query<{ sequence: string; event_type: string; payload: unknown; created_at: Date }>(
                  `SELECT sequence, event_type, payload, created_at FROM ${this.eventsTable}
                    WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
                      AND sequence < $4 AND event_type LIKE 'message_attachment.%'
                    ORDER BY sequence ASC`, [event.tenantId, event.scopeType, event.scopeId, event.sequence])
                input.guard(previous.rows.map((row) => ({ sequence: BigInt(row.sequence), eventType: row.event_type, payload: row.payload, createdAt: row.created_at })))
              }
              if (!input.allowDuringSessionDeletion) {
                const deletion = await transaction.query(`SELECT 1 FROM ${this.deletionsTable}
                  WHERE tenant_id = $1 AND session_id = $2`, [this.organizationId, sessionId])
                if (deletion.rowCount !== 0) throw new ObjectMetadataSessionDeletingError(sessionId)
              }
              if (input.intent) await this.consumePendingIntent(transaction, input.intent)
              if (input.capacity) {
                if (!this.capacity) throw new Error('Object capacity authority is unavailable')
                await this.capacity.applyMutation(transaction, input.capacity)
              }
              await sideEffect?.(transaction)
            }, undefined, this.resourceOwnerForSession
              ? async (transaction) => await this.assertOwner(transaction, sessionId)
              : undefined)
          } finally {
            await this.hotState.releaseLease(token).catch(() => undefined)
          }
          return
        } catch (error) {
          if (!(error instanceof LeaseHeldError) || Date.now() >= deadline) throw error
          const waitMs = Math.max(10, Math.min(250, error.expiresAt.getTime() - Date.now()))
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }
      }
    })
    this.tails.set(sessionId, operation.catch(() => undefined))
    await operation
  }

  async completeObjectCleanup(intent: ObjectOrphanIntent): Promise<void> {
    this.validateIntent(intent.sessionId, intent)
    await this.hotState.database.transaction(async (transaction) => {
      await this.assertOwner(transaction, intent.sessionId)
      await transaction.query(`DELETE FROM ${this.intentsTable}
        WHERE tenant_id = $1 AND object_key = $2 AND intent_id = $3`,
      [this.organizationId, intent.objectKey, intent.intentId])
    })
  }

  /**
   * Claims at most one bounded tenant-local page. Claiming and metadata publish
   * are mutually exclusive in PostgreSQL; S3 deletion remains deliberately
   * outside that transaction and is retried after a claim lease expires.
   */
  async reconcileOrphanIntents(
    objects: ArtifactObjectStore,
    options: { limit?: number; claimTimeoutMs?: number } = {},
  ): Promise<OrphanReconciliationResult> {
    const limit = options.limit ?? 100
    const claimTimeoutMs = options.claimTimeoutMs ?? 60_000
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Orphan reconciliation limit must be between 1 and 1000')
    if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs < 1) throw new RangeError('Orphan claim timeout must be a positive safe integer')
    const pendingClaimPredicate = this.resourceOwnerForSession
      ? `NOT EXISTS (
          SELECT 1 FROM ${this.ownershipsTable} AS ownership
          INNER JOIN ${this.membershipsTable} AS member
            ON member.organization_id = ownership.organization_id
            AND member.unit_id = ownership.unit_id AND member.replica_id = ownership.replica_id
            AND member.generation = ownership.membership_generation
            AND member.membership_token = ownership.membership_token
          WHERE ownership.organization_id = candidate_intent.tenant_id
            AND ownership.resource_type = 'session' AND ownership.resource_id = candidate_intent.session_id
            AND ownership.unit_id = candidate_intent.owner_unit_id AND ownership.replica_id = candidate_intent.owner_replica_id
            AND ownership.membership_generation = candidate_intent.owner_membership_generation
            AND ownership.membership_token = candidate_intent.owner_membership_token
            AND ownership.owner_token = candidate_intent.owner_token AND ownership.generation = candidate_intent.owner_generation
            AND ownership.expires_at > clock_timestamp() AND member.expires_at > clock_timestamp()
        )`
      : 'upload_expires_at <= clock_timestamp()'
    const claimId = randomUUID()
    const claimed = await this.hotState.database.transaction(async (transaction) => {
      return await transaction.query<IntentRow>(`WITH candidates AS (
          SELECT tenant_id, object_key FROM ${this.intentsTable} AS candidate_intent
          WHERE tenant_id = $1
            AND ((state = 'pending' AND ${pendingClaimPredicate})
              OR (state = 'deleting' AND claimed_at <= clock_timestamp() - $2 * interval '1 millisecond'))
            AND NOT EXISTS (
              SELECT 1 FROM ${this.eventsTable} AS events
              WHERE events.tenant_id = $1
                AND jsonb_path_exists(events.payload, '$.**.objectKey ? (@ == $key)', jsonb_build_object('key', to_jsonb(object_key)))
            )
          ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END,
            CASE WHEN state = 'pending' THEN created_at ELSE claimed_at END,
            object_key
          LIMIT $3 FOR UPDATE SKIP LOCKED
        )
        UPDATE ${this.intentsTable} AS intents
        SET state = 'deleting', claim_id = $4, claimed_at = clock_timestamp()
        FROM candidates
        WHERE intents.tenant_id = candidates.tenant_id AND intents.object_key = candidates.object_key
        RETURNING intents.intent_id::text, intents.session_id, intents.object_key`,
      [this.organizationId, claimTimeoutMs, limit, claimId])
    })
    let deleted = 0
    let failed = 0
    for (const row of claimed.rows) {
      try {
        await objects.delete(this.organizationId, row.object_key)
        // Keep a durable deleting tombstone. PutObject already in flight during
        // a network partition cannot be reliably cancelled: it may recreate bytes
        // after this delete. Callers use unique, non-overwrite object keys, metadata
        // publication stays fenced, and future Runtimes re-delete that same key
        // after claim expiry. Only completed writer compensation may remove it.
        deleted += 1
      } catch {
        // An S3 error may be ambiguous. Keep the deleting claim so publication
        // stays fenced; a later pass retries the idempotent delete after timeout.
        failed += 1
      }
    }
    return { claimed: claimed.rows.length, deleted, failed }
  }

  private currentOwner(sessionId: string): RuntimeResourceOwnership | undefined {
    if (!this.resourceOwnerForSession) return
    const owner = this.resourceOwnerForSession(sessionId)
    if (!owner) throw new RuntimeResourceOwnershipFencedError()
    return owner
  }

  private async assertOwner(transaction: HotStateSqlExecutor, sessionId: string, owner = this.currentOwner(sessionId)): Promise<void> {
    if (!owner) return
    await this.hotState.assertResourceOwnerForScope(transaction, {
      tenantId: this.organizationId, scopeType: 'session', scopeId: sessionId,
    }, owner)
  }

  private async consumePendingIntent(transaction: HotStateSqlExecutor, intent: ObjectOrphanIntent): Promise<void> {
    const consumed = await transaction.query(`DELETE FROM ${this.intentsTable}
      WHERE tenant_id = $1 AND object_key = $2 AND intent_id = $3 AND session_id = $4 AND state = 'pending'`,
    [this.organizationId, intent.objectKey, intent.intentId, intent.sessionId])
    if (consumed.rowCount !== 1) throw new Error('Object orphan intent is unavailable for publication')
  }

  private validateIntent(sessionId: string, intent: ObjectOrphanIntent): void {
    if (intent.sessionId !== sessionId) throw new Error('Object orphan intent Session does not match metadata scope')
    validateObjectKey(intent.objectKey)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(intent.intentId)) throw new Error('Invalid object orphan intent id')
  }

  private scope(sessionId: string) {
    if (!sessionId.trim()) throw new Error('Session id is required for object metadata')
    // Object metadata is an experimental cutover: it intentionally does not
    // replay entries written to the former Session authority scope.
    return { tenantId: this.organizationId, scopeType: 'task' as const, scopeId: `object:${sessionId}` }
  }
}

function validateObjectKey(objectKey: string): void {
  if (typeof objectKey !== 'string' || objectKey.length < 1 || objectKey.length > 1024 || objectKey.includes('\0')) throw new Error('Invalid orphan intent object key')
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
