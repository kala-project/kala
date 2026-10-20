import { randomUUID } from 'node:crypto'

import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import type { RuntimeResourceOwnership } from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { RuntimeResourceOwnershipFencedError } from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import type { HotStateSqlExecutor, PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'

export type ObjectCapacityKind = 'session_artifact' | 'message_attachment'

export type ObjectCapacityReservation = {
  reservationId: string
  objectKey: string
  sessionId: string
  kind: ObjectCapacityKind
  bytes: number
}

export type ObjectCapacityMutation =
  | { kind: 'commit'; reservation: ObjectCapacityReservation }
  | { kind: 'release_committed'; objectKeys: readonly string[] }

export interface ObjectCapacityLedger {
  initialize(): Promise<void>
  reserve(input: { objectKey: string; sessionId: string; kind: ObjectCapacityKind; bytes: number }): Promise<ObjectCapacityReservation>
  release(reservation: ObjectCapacityReservation): Promise<void>
  usageBytes(): Promise<number>
  reservationState(reservation: ObjectCapacityReservation): Promise<'reserved' | 'committed' | 'missing'>
  applyMutation(transaction: HotStateSqlExecutor, mutation: ObjectCapacityMutation): Promise<void>
}

export class ObjectCapacityExceededError extends Error {
  constructor(readonly limitBytes: number, readonly usedBytes: number, readonly requestedBytes: number) {
    super(`Runtime Unit artifact quota exceeded (limit ${limitBytes} bytes, used ${usedBytes} bytes, requested ${requestedBytes} bytes)`)
    this.name = 'ObjectCapacityExceededError'
  }
}

type AccountRow = Record<string, unknown> & { limit_bytes: string }
type UsageRow = Record<string, unknown> & { bytes: string }

/** Organization-bound PostgreSQL authority for Artifact and attachment bytes. */
export class PostgresObjectCapacityLedger implements ObjectCapacityLedger {
  private readonly accountsTable: string
  private readonly allocationsTable: string
  private readonly eventsTable: string
  private readonly intentsTable: string
  private readonly schemaManagement: PostgresSchemaManagement
  private readonly prepareSessionOwner?: (sessionId: string) => Promise<void>
  private readonly resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined

  constructor(
    private readonly organizationId: string,
    private readonly maxBytes: number,
    private readonly hotState: PostgresHotStateStore,
    options: { schema?: string; schemaManagement?: PostgresSchemaManagement;
      prepareSessionOwner?: (sessionId: string) => Promise<void>; resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined } = {},
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Object capacity limit must be a positive safe integer')
    const schema = quoteIdentifier(options.schema ?? 'public')
    this.accountsTable = `${schema}.tenant_object_capacity_accounts`
    this.allocationsTable = `${schema}.tenant_object_capacity_allocations`
    this.eventsTable = `${schema}.tenant_runtime_hot_events`
    this.intentsTable = `${schema}.tenant_object_orphan_intents`
    this.schemaManagement = options.schemaManagement ?? 'initialize'
    this.prepareSessionOwner = options.prepareSessionOwner
    this.resourceOwnerForSession = options.resourceOwnerForSession
    if (Boolean(this.prepareSessionOwner) !== Boolean(this.resourceOwnerForSession)) {
      throw new TypeError('Object capacity Session owner requires both prepare and live lease provider')
    }
  }

  async initialize(): Promise<void> {
    if (this.schemaManagement !== 'external') {
      await this.hotState.initialize()
      await this.hotState.database.query(`CREATE TABLE IF NOT EXISTS ${this.accountsTable} (
        tenant_id text PRIMARY KEY,
        limit_bytes bigint NOT NULL CHECK (limit_bytes > 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`)
      await this.hotState.database.query(`CREATE TABLE IF NOT EXISTS ${this.allocationsTable} (
        tenant_id text NOT NULL,
        object_key text NOT NULL,
        reservation_id uuid NOT NULL,
        session_id text NOT NULL,
        object_kind text NOT NULL CHECK (object_kind IN ('session_artifact', 'message_attachment')),
        bytes bigint NOT NULL CHECK (bytes > 0),
        state text NOT NULL CHECK (state IN ('reserved', 'committed')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        committed_at timestamptz,
        PRIMARY KEY (tenant_id, object_key),
        UNIQUE (tenant_id, reservation_id),
        FOREIGN KEY (tenant_id) REFERENCES ${this.accountsTable} (tenant_id) ON DELETE RESTRICT,
        CHECK ((state = 'reserved' AND committed_at IS NULL) OR (state = 'committed' AND committed_at IS NOT NULL))
      )`)
      await this.hotState.database.query(`CREATE INDEX IF NOT EXISTS tenant_object_capacity_allocations_state_idx
        ON ${this.allocationsTable} (tenant_id, state)`)
    }
    await this.hotState.database.transaction(async (transaction) => {
      await transaction.query(`INSERT INTO ${this.accountsTable} (tenant_id, limit_bytes)
        VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, [this.organizationId, this.maxBytes])
      const account = await this.lockAccount(transaction)
      if (Number(account.limit_bytes) !== this.maxBytes) {
        throw new Error(`Configured object capacity ${this.maxBytes} does not match persisted tenant limit ${account.limit_bytes}`)
      }
      // Onboard metadata published before the capacity ledger existed. A delete is
      // credited only after its durable delete_completed event, so failures never
      // make usage smaller than bytes that may still exist in object storage.
      await transaction.query(`INSERT INTO ${this.allocationsTable}
          (tenant_id, object_key, reservation_id, session_id, object_kind, bytes, state, committed_at)
        SELECT events.tenant_id,
          events.payload -> 'record' ->> 'objectKey',
          md5(events.tenant_id || ':' || (events.payload -> 'record' ->> 'objectKey'))::uuid,
          events.payload -> 'record' ->> 'sessionId',
          CASE events.event_type
            WHEN 'session_artifact.registered' THEN 'session_artifact'
            ELSE 'message_attachment'
          END,
          (events.payload -> 'record' ->> 'bytes')::bigint,
          'committed', events.created_at
        FROM ${this.eventsTable} AS events
        WHERE events.tenant_id = $1
          AND events.event_type IN ('session_artifact.registered', 'message_attachment.registered')
          AND (events.payload -> 'record' ->> 'bytes') ~ '^[1-9][0-9]*$'
          AND NOT EXISTS (
            SELECT 1 FROM ${this.eventsTable} AS deleted
            WHERE deleted.tenant_id = events.tenant_id
              AND deleted.event_type IN ('session_artifact.delete_completed', 'message_attachment.delete_completed')
              AND (deleted.payload -> 'objectKeys') ? (events.payload -> 'record' ->> 'objectKey')
          )
        ON CONFLICT (tenant_id, object_key) DO NOTHING`, [this.organizationId])
      const unmeteredIntent = await transaction.query(`SELECT 1
        FROM ${this.intentsTable} AS intents
        LEFT JOIN ${this.allocationsTable} AS allocations
          ON allocations.tenant_id = intents.tenant_id AND allocations.object_key = intents.object_key
        WHERE intents.tenant_id = $1 AND allocations.object_key IS NULL
        LIMIT 1`, [this.organizationId])
      if (unmeteredIntent.rowCount !== 0) {
        throw new Error('Legacy object intents have unknown byte usage; uploads are disabled until operator reconciliation')
      }
    })
  }

  async reserve(input: { objectKey: string; sessionId: string; kind: ObjectCapacityKind; bytes: number }): Promise<ObjectCapacityReservation> {
    validateBytes(input.bytes)
    validateText(input.objectKey, 'object key')
    validateText(input.sessionId, 'Session id')
    const reservation: ObjectCapacityReservation = { ...input, reservationId: randomUUID() }
    await this.prepareSessionOwner?.(input.sessionId)
    await this.hotState.database.transaction(async (transaction) => {
      if (this.resourceOwnerForSession) {
        const owner = this.resourceOwnerForSession(input.sessionId)
        if (!owner) throw new RuntimeResourceOwnershipFencedError()
        await this.hotState.assertResourceOwnerForScope(transaction, {
          tenantId: this.organizationId, scopeType: 'session', scopeId: input.sessionId,
        }, owner)
      }
      const account = await this.lockAccount(transaction)
      const usage = await this.readUsage(transaction)
      const limit = Number(account.limit_bytes)
      if (usage + input.bytes > limit) throw new ObjectCapacityExceededError(limit, usage, input.bytes)
      await transaction.query(`INSERT INTO ${this.allocationsTable}
        (tenant_id, object_key, reservation_id, session_id, object_kind, bytes, state)
        VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`,
      [this.organizationId, input.objectKey, reservation.reservationId, input.sessionId, input.kind, input.bytes])
    })
    return reservation
  }

  async release(reservation: ObjectCapacityReservation): Promise<void> {
    await this.hotState.database.transaction(async (transaction) => {
      await this.lockAccount(transaction)
      await transaction.query(`DELETE FROM ${this.allocationsTable}
        WHERE tenant_id = $1 AND object_key = $2 AND reservation_id = $3 AND state = 'reserved'`,
      [this.organizationId, reservation.objectKey, reservation.reservationId])
    })
  }

  async usageBytes(): Promise<number> {
    const result = await this.hotState.database.query<UsageRow>(`SELECT COALESCE(SUM(bytes), 0)::text AS bytes
      FROM ${this.allocationsTable} WHERE tenant_id = $1`, [this.organizationId])
    const usage = Number(result.rows[0]?.bytes ?? 0)
    if (!Number.isSafeInteger(usage) || usage < 0) throw new Error('Persisted object capacity usage is outside the safe integer range')
    return usage
  }

  async reservationState(reservation: ObjectCapacityReservation): Promise<'reserved' | 'committed' | 'missing'> {
    const result = await this.hotState.database.query<Record<string, unknown> & { state: 'reserved' | 'committed' }>(`SELECT state
      FROM ${this.allocationsTable} WHERE tenant_id = $1 AND object_key = $2 AND reservation_id = $3`,
    [this.organizationId, reservation.objectKey, reservation.reservationId])
    return result.rows[0]?.state ?? 'missing'
  }

  async applyMutation(transaction: HotStateSqlExecutor, mutation: ObjectCapacityMutation): Promise<void> {
    await this.lockAccount(transaction)
    if (mutation.kind === 'commit') {
      const reservation = mutation.reservation
      const updated = await transaction.query(`UPDATE ${this.allocationsTable}
        SET state = 'committed', committed_at = clock_timestamp()
        WHERE tenant_id = $1 AND object_key = $2 AND reservation_id = $3 AND session_id = $4
          AND object_kind = $5 AND bytes = $6 AND state = 'reserved'`,
      [this.organizationId, reservation.objectKey, reservation.reservationId, reservation.sessionId, reservation.kind, reservation.bytes])
      if (updated.rowCount !== 1) throw new Error('Object capacity reservation is unavailable for commit')
      return
    }
    if (mutation.objectKeys.length === 0) return
    await transaction.query(`DELETE FROM ${this.allocationsTable}
      WHERE tenant_id = $1 AND state = 'committed' AND object_key = ANY($2::text[])`,
    [this.organizationId, [...mutation.objectKeys]])
  }

  private async lockAccount(transaction: HotStateSqlExecutor): Promise<AccountRow> {
    const result = await transaction.query<AccountRow>(`SELECT limit_bytes::text FROM ${this.accountsTable}
      WHERE tenant_id = $1 FOR UPDATE`, [this.organizationId])
    if (!result.rows[0]) throw new Error('Object capacity account is not initialized')
    return result.rows[0]
  }

  private async readUsage(transaction: HotStateSqlExecutor): Promise<number> {
    const result = await transaction.query<UsageRow>(`SELECT COALESCE(SUM(bytes), 0)::text AS bytes
      FROM ${this.allocationsTable} WHERE tenant_id = $1`, [this.organizationId])
    const usage = Number(result.rows[0]?.bytes ?? 0)
    if (!Number.isSafeInteger(usage) || usage < 0) throw new Error('Persisted object capacity usage is outside the safe integer range')
    return usage
  }
}

function validateBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError('Object capacity bytes must be a positive safe integer')
}
function validateText(value: string, name: string): void {
  if (!value || value.length > 1024 || value.includes('\0')) throw new Error(`Invalid ${name}`)
}
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
