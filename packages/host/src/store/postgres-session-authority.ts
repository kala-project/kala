import { randomUUID } from 'node:crypto'

import type { EventEntry, RuntimeMetadataEntry } from '@agent-kernel/shared'

import {
  IdempotencyConflictError,
  LeaseExpiredError,
  LeaseFencedError,
  LeaseHeldError,
  type HotStateEvent,
  type HotStateScope,
  type PostgresHotStateStore,
} from '../tenant-runtime/postgres-hot-state.js'
import {
  RuntimeResourceOwnershipFencedError,
  type RuntimeResourceOwnership,
} from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import type { ParsedHistory, SessionOperationMatch } from './log.js'
import { PostgresMessageQueueStore } from '../postgres-message-queue.js'
import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from '../tenant-runtime/unit.js'

export type PersistedSessionDocument = Record<string, unknown> & {
  sessionId: string
  state: { cursor: number }
}

export type SessionAuthorityMutation = {
  mutationId: string
  eventType: string
  entry?: EventEntry | RuntimeMetadataEntry
  /** Internal cross-Session fence used when child creation depends on a parent owned by this Unit. */
  fenceSessionId?: string
  /** Internal deletion-state transitions are the only writes allowed after tombstoning. */
  allowDeletingSession?: boolean
  apply(current: PersistedSessionDocument | undefined): PersistedSessionDocument | undefined
}

const SESSION_DELETION_FIELD = '__kalaSessionDeletion'

type SessionDeletionTombstone = {
  requestId: string
  requestedAt: string
}

export class SessionDeletingError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being deleted`)
    this.name = 'SessionDeletingError'
  }
}

type LegacySessionDocumentEvent = {
  schemaVersion?: 2
  document: PersistedSessionDocument | null
  entry?: EventEntry | RuntimeMetadataEntry
}

type SessionDocumentDeltaOperation =
  | { op: 'set'; path: readonly (string | number)[]; value: unknown }
  | { op: 'delete'; path: readonly (string | number)[] }
  | { op: 'truncate'; path: readonly (string | number)[]; length: number }
  | { op: 'append'; path: readonly (string | number)[]; values: readonly unknown[] }

type DeltaSessionDocumentEvent = {
  schemaVersion: 3
  /** Sequence whose reconstructed document is the input to delta. */
  baseVersion: string
  delta: readonly SessionDocumentDeltaOperation[]
  entry?: EventEntry | RuntimeMetadataEntry
}

type SessionDocumentEvent = LegacySessionDocumentEvent | DeltaSessionDocumentEvent

type ProjectionRow = Record<string, unknown> & {
  version: string
  document: PersistedSessionDocument | null
}

type EventRow = Record<string, unknown> & {
  sequence: string
  idempotency_key: string
  payload: SessionDocumentEvent
}

/**
 * PostgreSQL authority for Private Cloud Session documents.
 *
 * The append-only hot-state event stream remains the audit ledger. A versioned
 * latest projection is updated in the same fenced PostgreSQL transaction, so
 * ordinary reads and writes do not replay the complete stream. No legacy JSONL
 * is read or written while this authority is configured.
 *
 * Schema-version 3 audit events retain a replayable structural delta rather
 * than the complete document. The transactionally maintained projection is the
 * hot read authority; replay is reserved for repairing a missing/lagging
 * projection and for exact idempotency checks. Schema-version 2 and unversioned
 * full-document events remain replayable for existing installations.
 */
export class PostgresSessionAuthority {
  readonly #ownerIdPrefix: string
  readonly #eventsTable: string
  readonly #projectionTable: string
  readonly #schemaManagement: PostgresSchemaManagement
  readonly #resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined
  readonly #prepareSessionOwner?: (sessionId: string) => Promise<void>
  readonly #ownerUnitId?: TenantRuntimeUnitId
  readonly messageQueue: PostgresMessageQueueStore

  constructor(
    readonly hotState: PostgresHotStateStore,
    readonly tenantId: string,
    options: {
      ownerId?: string
      schema?: string
      leaseTtlMs?: number
      leaseWaitMs?: number
      schemaManagement?: PostgresSchemaManagement
      /** Required with resourceOwnerForSession; never derive this Unit ID from client input. */
      unitId?: string
      /** Opt-in: must return the manager's live owner lease; never trust a client-provided token. */
      resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined
      /** Optional trusted lease acquisition before reads and mutations; the SQL transaction still fences it. */
      prepareSessionOwner?: (sessionId: string) => Promise<void>
    } = {},
  ) {
    if (!tenantId) throw new TypeError('tenantId must be a non-empty string')
    const schemaName = options.schema ?? 'public'
    const schema = quoteIdentifier(schemaName)
    this.#ownerIdPrefix = options.ownerId ?? 'session-store'
    this.#eventsTable = `${schema}.tenant_runtime_hot_events`
    this.#projectionTable = `${schema}.tenant_session_latest_projection`
    this.#schemaManagement = options.schemaManagement ?? 'initialize'
    if (options.resourceOwnerForSession && !options.unitId) {
      throw new TypeError('Session owner fencing requires a trusted Unit ID')
    }
    if (options.resourceOwnerForSession && this.#schemaManagement !== 'external') {
      throw new TypeError('Session owner fencing requires an operator-migrated PostgreSQL schema')
    }
    if (options.prepareSessionOwner && !options.resourceOwnerForSession) {
      throw new TypeError('Session owner preparation requires a same-transaction resource owner fence')
    }
    this.#resourceOwnerForSession = options.resourceOwnerForSession
    this.#prepareSessionOwner = options.prepareSessionOwner
    this.#ownerUnitId = options.unitId ? parseTenantRuntimeUnitId(options.unitId) : undefined
    this.messageQueue = new PostgresMessageQueueStore(hotState.database, tenantId, {
      schema: schemaName,
      schemaManagement: this.#schemaManagement,
      ...(this.#resourceOwnerForSession ? {
        ...(this.#prepareSessionOwner ? { prepareSession: this.#prepareSessionOwner } : {}),
        fenceSession: async (transaction, sessionId) => {
          await hotState.assertResourceOwnerForScope(transaction, this.#scope(sessionId), this.#currentOwner(sessionId)!)
        },
      } : {}),
    })
    this.leaseTtlMs = options.leaseTtlMs ?? 15_000
    this.leaseWaitMs = options.leaseWaitMs ?? 10_000
  }

  readonly leaseTtlMs: number
  readonly leaseWaitMs: number

  async initialize(): Promise<void> {
    if (this.#schemaManagement === 'external') return
    await this.hotState.initialize()
    await Promise.all([
      this.messageQueue.initialize(),
      this.hotState.database.query(`CREATE TABLE IF NOT EXISTS ${this.#projectionTable} (
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        version bigint NOT NULL CHECK (version > 0),
        document jsonb,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, session_id)
      )`),
    ])
  }

  async load(sessionId: string): Promise<PersistedSessionDocument | undefined> {
    const document = await this.#loadIncludingDeleting(sessionId)
    return document && !sessionDeletion(document) ? document : undefined
  }

  async mutate(sessionId: string, mutation: SessionAuthorityMutation): Promise<PersistedSessionDocument | undefined> {
    validateSessionId(sessionId)
    if (!mutation.mutationId) throw new TypeError('mutationId must be a non-empty string')
    if (!mutation.eventType) throw new TypeError('eventType must be a non-empty string')
    const scope = this.#scope(sessionId)
    await this.#prepareSessionOwner?.(sessionId)
    if (mutation.fenceSessionId) await this.#prepareSessionOwner?.(mutation.fenceSessionId)
    this.#currentOwner(sessionId)
    if (mutation.fenceSessionId && this.#resourceOwnerForSession) this.#currentOwner(mutation.fenceSessionId)
    const deadline = Date.now() + this.leaseWaitMs
    for (;;) {
      const token = await this.#acquire(scope, deadline)
      try {
        const existing = await this.#eventByMutationId(sessionId, mutation.mutationId)
        if (existing) {
          // A retry must not let a stale owner observe success without proving
          // ownership again, even though it does not append another audit row.
          if (this.#resourceOwnerForSession) {
            await this.hotState.database.transaction(async (transaction) => {
              await this.hotState.assertResourceOwnerForScope(transaction, scope, this.#currentOwner(sessionId)!)
              if (mutation.fenceSessionId) {
                await this.hotState.assertResourceOwnerForScope(
                  transaction,
                  this.#scope(mutation.fenceSessionId),
                  this.#currentOwner(mutation.fenceSessionId)!,
                )
              }
            })
          }
          if ((await this.#latestEvent(scope))?.eventType === 'session.deleted') {
            if (mutation.eventType === 'session.delete_requested') return undefined
            if (!mutation.allowDeletingSession) throw new SessionDeletingError(sessionId)
          }
          const previous = await this.#documentBefore(sessionId, BigInt(existing.sequence))
          const retried = mutation.apply(previous)
          const committed = applySessionEvent(previous, existing.payload)
          if (stableJson(retried ?? null) !== stableJson(committed ?? null)) {
            throw new IdempotencyConflictError(mutation.mutationId)
          }
          return committed
        }

        const projection = await this.#projection(sessionId)
        const latest = await this.#latestEvent(scope)
        if (latest?.eventType === 'session.deleted' && mutation.eventType !== 'session.deleted') {
          if (mutation.eventType === 'session.delete_requested') return undefined
          throw new SessionDeletingError(sessionId)
        }
        const expectedVersion = BigInt(projection?.version ?? 0)
        // A projection created by an older writer may lag the audit stream. CAS
        // protects the projection row, while mutation.apply must use whichever
        // authoritative source has the greatest committed sequence.
        const projectionIsLatest = projection && BigInt(projection.version) >= (latest?.sequence ?? 0n)
        const current = projectionIsLatest
          ? projection.document ?? undefined
          : latest
            ? await this.#documentAt(sessionId, latest.sequence, projection)
            : undefined
        if (!mutation.allowDeletingSession && (current && sessionDeletion(current) || latest?.eventType === 'session.deleted')) {
          throw new SessionDeletingError(sessionId)
        }
        const next = mutation.apply(current ?? undefined)
        if (next && next.sessionId !== sessionId) {
          throw new Error(`Session authority mutation changed identity from ${sessionId} to ${next.sessionId}`)
        }
        const payload: DeltaSessionDocumentEvent = {
          schemaVersion: 3,
          baseVersion: String(latest?.sequence ?? 0n),
          delta: createDocumentDelta(current, next),
          ...(mutation.entry ? { entry: mutation.entry } : {}),
        }
        await this.hotState.appendEventWithSideEffect(token, {
          idempotencyKey: mutation.mutationId,
          eventType: mutation.eventType,
          payload,
        }, async (transaction, event) => {
          if (mutation.fenceSessionId && this.#resourceOwnerForSession) {
            await this.hotState.assertResourceOwnerForScope(
              transaction,
              this.#scope(mutation.fenceSessionId),
              this.#currentOwner(mutation.fenceSessionId)!,
            )
          }
          const updated = await transaction.query(`INSERT INTO ${this.#projectionTable}
            (tenant_id, session_id, version, document, updated_at)
            VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
            ON CONFLICT (tenant_id, session_id) DO UPDATE SET
              version = EXCLUDED.version,
              document = EXCLUDED.document,
              updated_at = EXCLUDED.updated_at
            WHERE ${this.#projectionTable}.version = $5
            RETURNING version`, [
            this.tenantId, sessionId, event.sequence, JSON.stringify(next ?? null), expectedVersion,
          ])
          if (updated.rowCount !== 1) throw new ProjectionConflictError()
        }, this.#currentOwner(sessionId))
        return next
      } catch (error) {
        if (!isRetryableMutationConflict(error) || Date.now() >= deadline) throw error
      } finally {
        await this.hotState.releaseLease(token).catch(() => undefined)
      }
    }
  }

  async create(
    document: PersistedSessionDocument,
    mutationId = 'session.create',
    options: { fenceSessionId?: string } = {},
  ): Promise<PersistedSessionDocument> {
    const result = await this.mutate(document.sessionId, {
      mutationId,
      eventType: 'session.created',
      ...(options.fenceSessionId ? { fenceSessionId: options.fenceSessionId } : {}),
      apply(current) {
        if (current) {
          if (stableJson(current) === stableJson(document)) return current
          throw new Error(`Session already exists: ${document.sessionId}`)
        }
        return document
      },
    })
    if (!result) throw new Error(`Session creation did not produce a document: ${document.sessionId}`)
    return result
  }

  async requestDeletion(sessionId: string, mutationId = `session.delete-requested:${randomUUID()}`): Promise<boolean> {
    const requestedAt = new Date().toISOString()
    const document = await this.mutate(sessionId, {
      mutationId,
      eventType: 'session.delete_requested',
      allowDeletingSession: true,
      apply: (current) => current && !sessionDeletion(current)
        ? { ...current, [SESSION_DELETION_FIELD]: { requestId: mutationId, requestedAt } satisfies SessionDeletionTombstone }
        : current,
    })
    return Boolean(document && sessionDeletion(document))
  }

  async delete(sessionId: string, mutationId = `session.delete:${randomUUID()}`): Promise<void> {
    await this.mutate(sessionId, {
      mutationId,
      eventType: 'session.deleted',
      allowDeletingSession: true,
      apply(current) {
        if (current && !sessionDeletion(current)) throw new Error(`Session ${sessionId} must be tombstoned before final deletion`)
        return undefined
      },
    })
  }

  async listDeleting(): Promise<readonly PersistedSessionDocument[]> {
    // Every delete request updates this projection in the same transaction as
    // its audit event, so recovery can scan only explicit tombstones instead of
    // replaying every Session (and opening an unbounded number of PG clients).
    const result = await this.hotState.database.query<{ document: PersistedSessionDocument }>(`SELECT document
      FROM ${this.#projectionTable}
      WHERE tenant_id = $1
        AND document->$2->>'requestId' IS NOT NULL
        AND document->$2->>'requestedAt' IS NOT NULL
      ORDER BY session_id`, [this.tenantId, SESSION_DELETION_FIELD])
    return result.rows.map(({ document }) => document).filter((document) => Boolean(sessionDeletion(document)))
  }

  async list(): Promise<readonly PersistedSessionDocument[]> {
    const scopes = await this.hotState.database.query<{ scope_id: string }>(`SELECT DISTINCT scope_id
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session'
      ORDER BY scope_id`, [this.tenantId])
    const documents = await Promise.all(scopes.rows.map(async ({ scope_id }) => await this.load(scope_id)))
    return documents.filter((document): document is PersistedSessionDocument => document !== undefined)
  }

  async findOperation(sessionId: string, operationId: string): Promise<SessionOperationMatch | undefined> {
    validateSessionId(sessionId)
    if (!operationId) throw new TypeError('operationId must be a non-empty string')
    const result = await this.hotState.database.query<{ entry: EventEntry | RuntimeMetadataEntry }>(`SELECT payload->'entry' AS entry
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
        AND payload ? 'entry'
        AND (
          payload #>> '{entry,event,operationId}' = $3
          OR payload #>> '{entry,payload,operationId}' = $3
        )
      ORDER BY sequence DESC LIMIT 1`, [this.tenantId, sessionId, operationId])
    const entry = result.rows[0]?.entry
    if (!entry) return undefined
    if (entry.kind === 'event' && entry.event.kind === 'user_message' && entry.event.operationId === operationId) {
      return { kind: 'event', cursor: entry.seq, event: entry.event }
    }
    if (entry.kind === 'runtime_metadata' && entry.payload.operationId === operationId) {
      return {
        kind: 'runtime_metadata',
        action: entry.action,
        ...(typeof entry.payload.text === 'string' ? { text: entry.payload.text } : {}),
        ...(typeof entry.payload.requestFingerprint === 'string' ? { requestFingerprint: entry.payload.requestFingerprint } : {}),
      }
    }
    return undefined
  }

  async findLatestRuntimeMetadata(sessionId: string, action: string): Promise<RuntimeMetadataEntry | undefined> {
    validateSessionId(sessionId)
    if (!action) throw new TypeError('runtime metadata action is required')
    const result = await this.hotState.database.query<{ entry: RuntimeMetadataEntry }>(`SELECT payload->'entry' AS entry
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
        AND payload #>> '{entry,kind}' = 'runtime_metadata'
        AND payload #>> '{entry,action}' = $3
      ORDER BY sequence DESC LIMIT 1`, [this.tenantId, sessionId, action])
    return result.rows[0]?.entry
  }

  async readEventEntries(sessionId: string): Promise<readonly EventEntry[]> {
    validateSessionId(sessionId)
    const result = await this.hotState.database.query<{ entry: EventEntry }>(`SELECT payload->'entry' AS entry
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
        AND payload #>> '{entry,kind}' = 'event'
      ORDER BY sequence ASC`, [this.tenantId, sessionId])
    return result.rows.map(({ entry }) => entry)
  }

  async readHistory(sessionId: string): Promise<ParsedHistory> {
    validateSessionId(sessionId)
    await this.#prepareSessionOwner?.(sessionId)
    type HistoryRow = {
      event_type: string
      payload: SessionDocumentEvent
      entry: EventEntry | RuntimeMetadataEntry | null
    }
    const statement = `SELECT event_type, payload, payload->'entry' AS entry
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
      ORDER BY sequence ASC`
    const parameters = [this.tenantId, sessionId]
    const result = this.#resourceOwnerForSession
      ? await this.hotState.database.transaction(async (transaction) => {
          await this.hotState.assertResourceOwnerForScope(transaction, this.#scope(sessionId), this.#currentOwner(sessionId)!)
          return transaction.query<HistoryRow>(statement, parameters)
        })
      : await this.hotState.database.query<HistoryRow>(statement, parameters)
    const created = result.rows[0]
    if (!created || created.event_type !== 'session.created') throw new Error(`Session ${sessionId} has no creation history`)
    const initialDocument = applySessionEvent(undefined, created.payload)
    if (!initialDocument || initialDocument.sessionId !== sessionId
      || !initialDocument.state || !Number.isSafeInteger(initialDocument.state.cursor)
      || !initialDocument.config || typeof initialDocument.config !== 'object') {
      throw new Error(`Session ${sessionId} has invalid creation history`)
    }
    const events: EventEntry[] = []
    const runtimeMetadata: RuntimeMetadataEntry[] = []
    for (const { entry } of result.rows) {
      if (entry?.kind === 'event') events.push(entry)
      else if (entry?.kind === 'runtime_metadata') runtimeMetadata.push(entry)
    }
    return {
      initialState: initialDocument.state as ParsedHistory['initialState'],
      config: initialDocument.config as ParsedHistory['config'],
      events,
      runtimeMetadata,
    }
  }

  async close(): Promise<void> {
    await this.hotState.close()
  }

  #scope(sessionId: string): HotStateScope {
    validateSessionId(sessionId)
    return { tenantId: this.tenantId, scopeType: 'session', scopeId: sessionId }
  }

  #currentOwner(sessionId: string): RuntimeResourceOwnership | undefined {
    if (!this.#resourceOwnerForSession) return undefined
    const owner = this.#resourceOwnerForSession(sessionId)
    if (!owner || owner.organizationId !== this.tenantId || owner.unitId !== this.#ownerUnitId
      || owner.resourceType !== 'session' || owner.resourceId !== sessionId
      || !(owner.expiresAt instanceof Date) || owner.expiresAt.getTime() <= Date.now()) {
      throw new RuntimeResourceOwnershipFencedError()
    }
    return owner
  }

  async #acquire(scope: HotStateScope, deadline = Date.now() + this.leaseWaitMs) {
    // A lease owner identifies one mutation attempt, never a process. Reusing a
    // process owner lets acquireLease re-enter without advancing generation and
    // permits two in-process writers to compute from the same projection.
    const ownerId = `${this.#ownerIdPrefix}:${randomUUID()}`
    for (;;) {
      try {
        return await this.hotState.acquireLease(scope, ownerId, this.leaseTtlMs)
      } catch (error) {
        if (!(error instanceof LeaseHeldError) || Date.now() >= deadline) throw error
        await delay(Math.min(25, Math.max(1, error.expiresAt.getTime() - Date.now())))
      }
    }
  }

  async #loadIncludingDeleting(sessionId: string): Promise<PersistedSessionDocument | undefined> {
    validateSessionId(sessionId)
    const projected = await this.#projection(sessionId)
    if (projected) return projected.document ?? undefined
    const latest = await this.#latestEvent(this.#scope(sessionId))
    if (!latest) return undefined
    const document = await this.#documentAt(sessionId, latest.sequence)
    await this.#checkpoint(sessionId, latest.sequence, document ?? null)
    return document
  }

  async #projection(sessionId: string): Promise<ProjectionRow | undefined> {
    const result = await this.hotState.database.query<ProjectionRow>(`SELECT version, document
      FROM ${this.#projectionTable} WHERE tenant_id = $1 AND session_id = $2`, [this.tenantId, sessionId])
    return result.rows[0]
  }

  async #checkpoint(sessionId: string, version: bigint, document: PersistedSessionDocument | null): Promise<void> {
    // Read-only Session listings must not pin every Session to this replica.
    // A missing projection is a real write, so acquire ownership before repair.
    await this.#prepareSessionOwner?.(sessionId)
    await this.hotState.database.transaction(async (transaction) => {
      if (this.#resourceOwnerForSession) {
        await this.hotState.assertResourceOwnerForScope(transaction, this.#scope(sessionId), this.#currentOwner(sessionId)!)
      }
      await transaction.query(`INSERT INTO ${this.#projectionTable}
        (tenant_id, session_id, version, document, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
        ON CONFLICT (tenant_id, session_id) DO UPDATE SET
          version = EXCLUDED.version, document = EXCLUDED.document, updated_at = EXCLUDED.updated_at
        WHERE ${this.#projectionTable}.version < EXCLUDED.version`, [this.tenantId, sessionId, version, JSON.stringify(document)])
    })
  }

  async #eventByMutationId(sessionId: string, mutationId: string): Promise<EventRow | undefined> {
    const result = await this.hotState.database.query<EventRow>(`SELECT sequence, idempotency_key, payload
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2 AND idempotency_key = $3`,
    [this.tenantId, sessionId, mutationId])
    return result.rows[0]
  }

  async #documentBefore(sessionId: string, sequence: bigint): Promise<PersistedSessionDocument | undefined> {
    if (sequence <= 1n) return undefined
    return this.#documentAt(sessionId, sequence - 1n)
  }

  async #documentAt(sessionId: string, sequence: bigint, projection?: ProjectionRow): Promise<PersistedSessionDocument | undefined> {
    let version = 0n
    let document: PersistedSessionDocument | undefined
    if (projection && BigInt(projection.version) <= sequence) {
      version = BigInt(projection.version)
      document = projection.document ?? undefined
    }
    const result = await this.hotState.database.query<{ sequence: string; payload: SessionDocumentEvent }>(`SELECT sequence, payload
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
        AND sequence > $3 AND sequence <= $4
      ORDER BY sequence ASC`, [this.tenantId, sessionId, version, sequence])
    for (const row of result.rows) {
      if (isDeltaSessionEvent(row.payload) && BigInt(row.payload.baseVersion) !== version) {
        throw new Error(`Session audit delta at sequence ${row.sequence} is based on ${row.payload.baseVersion}, expected ${version}`)
      }
      document = applySessionEvent(document, row.payload)
      version = BigInt(row.sequence)
    }
    if (version !== sequence) throw new Error(`Session audit history ends at ${version}, expected ${sequence}`)
    return document
  }

  async #latestEvent(scope: HotStateScope): Promise<HotStateEvent<SessionDocumentEvent> | undefined> {
    const result = await this.hotState.database.query<EventRow & { generation: string; event_type: string; created_at: Date }>(`SELECT sequence, generation, idempotency_key, event_type, payload, created_at
      FROM ${this.#eventsTable}
      WHERE tenant_id = $1 AND scope_type = 'session' AND scope_id = $2
      ORDER BY sequence DESC LIMIT 1`, [scope.tenantId, scope.scopeId])
    const row = result.rows[0]
    if (!row) return undefined
    return {
      ...scope,
      sequence: BigInt(row.sequence),
      generation: BigInt(row.generation),
      idempotencyKey: row.idempotency_key,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    }
  }
}

class ProjectionConflictError extends Error {
  constructor() {
    super('Session projection changed while applying a mutation')
    this.name = 'ProjectionConflictError'
  }
}

function isRetryableMutationConflict(error: unknown): boolean {
  return error instanceof ProjectionConflictError
    || error instanceof LeaseExpiredError
    || error instanceof LeaseFencedError
}

function sessionDeletion(document: PersistedSessionDocument): SessionDeletionTombstone | undefined {
  const value = document[SESSION_DELETION_FIELD]
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<SessionDeletionTombstone>
  return typeof candidate.requestId === 'string' && typeof candidate.requestedAt === 'string'
    ? candidate as SessionDeletionTombstone
    : undefined
}

function validateSessionId(sessionId: string): void {
  if (!sessionId) throw new TypeError('sessionId must be a non-empty string')
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}

function isDeltaSessionEvent(event: SessionDocumentEvent): event is DeltaSessionDocumentEvent {
  return event.schemaVersion === 3
}

function applySessionEvent(
  current: PersistedSessionDocument | undefined,
  event: SessionDocumentEvent,
): PersistedSessionDocument | undefined {
  if (!isDeltaSessionEvent(event)) return event.document ?? undefined
  let value: unknown = jsonClone(current ?? null)
  for (const operation of event.delta) {
    if (operation.op === 'set') {
      const replacement = jsonClone(operation.value)
      if (operation.path.length === 0) value = replacement
      else setAtPath(value, operation.path, replacement)
      continue
    }
    const target = operation.path.length === 0 ? value : valueAtPath(value, operation.path)
    if (operation.op === 'append') {
      if (!Array.isArray(target)) throw new Error('Session audit append delta does not target an array')
      target.push(...operation.values.map(jsonClone))
    } else if (operation.op === 'truncate') {
      if (!Array.isArray(target) || operation.length < 0 || operation.length > target.length) {
        throw new Error('Session audit truncate delta is invalid')
      }
      target.length = operation.length
    } else {
      deleteAtPath(value, operation.path)
    }
  }
  return value === null ? undefined : value as PersistedSessionDocument
}

function createDocumentDelta(
  current: PersistedSessionDocument | undefined,
  next: PersistedSessionDocument | undefined,
): readonly SessionDocumentDeltaOperation[] {
  const operations: SessionDocumentDeltaOperation[] = []
  diffJson(jsonClone(current ?? null), jsonClone(next ?? null), [], operations)
  return operations
}

function diffJson(
  current: unknown,
  next: unknown,
  path: readonly (string | number)[],
  operations: SessionDocumentDeltaOperation[],
): void {
  if (stableJson(current) === stableJson(next)) return
  if (Array.isArray(current) && Array.isArray(next)) {
    const sharedLength = Math.min(current.length, next.length)
    for (let index = 0; index < sharedLength; index += 1) {
      diffJson(current[index], next[index], [...path, index], operations)
    }
    if (next.length < current.length) operations.push({ op: 'truncate', path, length: next.length })
    if (next.length > current.length) operations.push({ op: 'append', path, values: next.slice(current.length) })
    return
  }
  if (isJsonObject(current) && isJsonObject(next)) {
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(next, key)) operations.push({ op: 'delete', path: [...path, key] })
    }
    for (const [key, value] of Object.entries(next)) {
      if (!Object.hasOwn(current, key)) operations.push({ op: 'set', path: [...path, key], value })
      else diffJson(current[key], value, [...path, key], operations)
    }
    return
  }
  operations.push({ op: 'set', path, value: next })
}

function valueAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root
  for (const segment of path) {
    if ((!isJsonObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, segment)) {
      throw new Error(`Session audit delta path does not exist: ${path.join('.')}`)
    }
    value = value[segment as keyof typeof value]
  }
  return value
}

function setAtPath(root: unknown, path: readonly (string | number)[], value: unknown): void {
  const key = path.at(-1)!
  const parent = valueAtPath(root, path.slice(0, -1))
  if (!isJsonObject(parent) && !Array.isArray(parent)) throw new Error('Session audit set delta has no object parent')
  Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true })
}

function deleteAtPath(root: unknown, path: readonly (string | number)[]): void {
  if (path.length === 0) throw new Error('Session audit delta cannot delete the document root')
  const key = path.at(-1)!
  const parent = valueAtPath(root, path.slice(0, -1))
  if (!isJsonObject(parent) || !Object.hasOwn(parent, key)) throw new Error('Session audit delete delta path does not exist')
  delete parent[key]
}

function isJsonObject(value: unknown): value is Record<string | number, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
  })
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
