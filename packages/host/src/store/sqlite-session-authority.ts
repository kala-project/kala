import type { SessionFsProvider } from '@github/copilot-sdk'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { EventEntry, RuntimeMetadataEntry } from '@agent-kernel/shared'

import type { ParsedHistory, SessionOperationMatch } from './log.js'
import { emptyAgentBoard, type AgentBoardState } from './agent-board-state.js'
import { createNativeSessionFsProvider, nativeFsPlan, nativeFsSchemaStatements, validateNativeFsLimits, type NativeFsLimits, type NativeFsTables } from './native-session-fs.js'
import {
  SessionDeletingError,
  type PersistedSessionDocument,
  type SessionAuthority,
  type SessionAuthorityMutation,
} from './session-authority.js'

const SESSION_DELETION_FIELD = '__kalaSessionDeletion'
const NATIVE_FS_TABLES: NativeFsTables = {
  usage: 'portable_native_fs_usage', nodes: 'portable_native_fs_nodes', chunks: 'portable_native_fs_chunks',
}


type SessionDeletionTombstone = {
  requestId: string
  requestedAt: string
}

type ProjectionRow = {
  version: number
  document: string
}

type EventRow = {
  sequence: number
  mutation_id: string
  event_type: string
  before_document: string | null
  document: string | null
  entry: string | null
}

/**
 * SQLite Session authority for explicitly selected fresh Portable storage.
 *
 * This adapter never inspects or imports JSONL and is not selected by the Host
 * default. Its projection and append-only event rows commit in one immediate
 * transaction. The database user_version is deliberately left to KalaStateStore.
 */
export class SqliteSessionAuthority implements SessionAuthority {
  #database?: DatabaseSync
  readonly #nativeFsLimits: Readonly<NativeFsLimits>

  constructor(readonly databasePath: string, options: { nativeFsLimits?: NativeFsLimits } = {}) {
    this.#nativeFsLimits = validateNativeFsLimits(options.nativeFsLimits ?? {})
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
        CREATE TABLE IF NOT EXISTS portable_sessions (
          session_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version > 0),
          document TEXT NOT NULL,
          deleting INTEGER NOT NULL CHECK (deleting IN (0, 1)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS portable_session_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          mutation_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          before_document TEXT,
          document TEXT,
          entry TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (session_id, mutation_id)
        );
        CREATE INDEX IF NOT EXISTS portable_session_events_session_sequence_idx
          ON portable_session_events(session_id, sequence);
        CREATE TABLE IF NOT EXISTS portable_agent_boards (
          root_session_id TEXT PRIMARY KEY,
          state TEXT NOT NULL
        );
      `)
      for (const statement of nativeFsSchemaStatements(NATIVE_FS_TABLES)) database.exec(statement)
      this.#database = database
    } catch (error) {
      database.close()
      throw error
    }
  }

  nativeSessionFs(sessionId: string): SessionFsProvider {
    validateSessionId(sessionId)
    return createNativeSessionFsProvider(async (request) => {
      // No await inside this synchronous transaction: DatabaseSync must not
      // block the event loop waiting for another suspended SQLite writer.
      const database = this.#db()
      database.exec('BEGIN IMMEDIATE')
      try {
        const document = this.#loadIncludingDeleting(sessionId)
        if (!document || sessionDeletion(document)) throw new SessionDeletingError(sessionId)
        const previous = document.__kalaCopilotSessionFsV1
        if (previous && (typeof previous !== 'object' || Object.keys(previous).length > 0)) {
          throw new Error('Unsupported nonempty native filesystem V1 snapshot; automatic migration is not supported')
        }
        database.prepare(`INSERT INTO ${NATIVE_FS_TABLES.usage} (tenant_id, session_id, total_bytes, total_nodes)
          VALUES ('', ?, 0, 0) ON CONFLICT (tenant_id, session_id) DO NOTHING`).run(sessionId)
        const plan = nativeFsPlan(request, NATIVE_FS_TABLES, '', sessionId, this.#nativeFsLimits)
        let next = plan.next()
        while (!next.done) {
          const statement = database.prepare(next.value.sql)
          const reader = /^\s*SELECT\b/iu.test(next.value.sql)
          if (reader) {
            const rows = statement.all(...next.value.values) as Record<string, unknown>[]
            next = plan.next({ rows, rowCount: rows.length })
          } else {
            const result = statement.run(...next.value.values)
            next = plan.next({ rows: [], rowCount: Number(result.changes) })
          }
        }
        database.exec('COMMIT')
        return next.value
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  async load(sessionId: string): Promise<PersistedSessionDocument | undefined> {
    const document = this.#loadIncludingDeleting(sessionId)
    return document && !sessionDeletion(document) ? document : undefined
  }

  async agentBoardTransaction<T>(
    sessionId: string,
    operation: (rootSessionId: string, board: AgentBoardState, actor: { sessionId: string; parentSessionId?: unknown; agentType?: unknown }) => T,
  ): Promise<T> {
    validateSessionId(sessionId)
    const database = this.#db()
    database.exec('BEGIN IMMEDIATE')
    try {
      const visited = new Set<string>()
      let id = sessionId
      let actor: PersistedSessionDocument | undefined
      for (;;) {
        if (visited.has(id) || visited.size >= 32) throw new Error('Invalid cyclic or excessively deep Session tree')
        visited.add(id)
        const document = this.#loadIncludingDeleting(id)
        if (!document || sessionDeletion(document)) throw new SessionDeletingError(id)
        if (!actor) actor = document
        if (typeof document.parentSessionId !== 'string' || !document.parentSessionId) break
        validateSessionId(document.parentSessionId)
        id = document.parentSessionId
      }
      database.prepare('INSERT OR IGNORE INTO portable_agent_boards (root_session_id, state) VALUES (?, ?)')
        .run(id, JSON.stringify(emptyAgentBoard()))
      const row = database.prepare('SELECT state FROM portable_agent_boards WHERE root_session_id = ?')
        .get(id) as { state: string }
      const board = JSON.parse(row.state) as AgentBoardState
      const revision = board.revision
      const result = operation(id, board, actor!)
      if (revision !== board.revision) {
        database.prepare('UPDATE portable_agent_boards SET state = ? WHERE root_session_id = ?')
          .run(JSON.stringify(board), id)
      }
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  async mutate(sessionId: string, mutation: SessionAuthorityMutation): Promise<PersistedSessionDocument | undefined> {
    validateSessionId(sessionId)
    if (!mutation.mutationId) throw new TypeError('mutationId must be a non-empty string')
    if (!mutation.eventType) throw new TypeError('eventType must be a non-empty string')
    const database = this.#db()
    database.exec('BEGIN IMMEDIATE')
    try {
      // BEGIN IMMEDIATE serializes the parent check with child creation, so a
      // fork cannot commit after the parent has been deleted or tombstoned.
      if (mutation.fenceSessionId) {
        validateSessionId(mutation.fenceSessionId)
        const parent = this.#loadIncludingDeleting(mutation.fenceSessionId)
        if (!parent || sessionDeletion(parent)) {
          throw new SessionDeletingError(mutation.fenceSessionId)
        }
      }
      const existing = database.prepare(`
        SELECT sequence, mutation_id, event_type, before_document, document, entry
        FROM portable_session_events
        WHERE session_id = ? AND mutation_id = ?
      `).get(sessionId, mutation.mutationId) as EventRow | undefined
      const latest = database.prepare(`
        SELECT sequence, mutation_id, event_type, before_document, document, entry
        FROM portable_session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1
      `).get(sessionId) as EventRow | undefined

      if (existing) {
        if (latest?.event_type === 'session.deleted') {
          if (mutation.eventType === 'session.delete_requested') {
            database.exec('COMMIT')
            return undefined
          }
          if (!mutation.allowDeletingSession) throw new SessionDeletingError(sessionId)
        }
        const previous = parseDocument(existing.before_document)
        const retried = mutation.apply(previous)
        const committed = parseDocument(existing.document)
        if (stableJson(retried ?? null) !== stableJson(committed ?? null)) {
          throw new Error(`Idempotency conflict for Session mutation ${mutation.mutationId}`)
        }
        database.exec('COMMIT')
        return committed
      }

      if (latest?.event_type === 'session.deleted' && mutation.eventType !== 'session.deleted') {
        if (mutation.eventType === 'session.delete_requested') {
          database.exec('COMMIT')
          return undefined
        }
        throw new SessionDeletingError(sessionId)
      }

      const projection = database.prepare(`
        SELECT version, document FROM portable_sessions WHERE session_id = ?
      `).get(sessionId) as ProjectionRow | undefined
      const current = projection ? parseDocument(projection.document) : undefined
      if (!mutation.allowDeletingSession && current && sessionDeletion(current)) {
        throw new SessionDeletingError(sessionId)
      }
      const next = mutation.apply(current)
      if (mutation.eventType === 'session.deleted' && next === undefined) {
        database.prepare('DELETE FROM portable_agent_boards WHERE root_session_id = ?').run(sessionId)
      }
      if (next && next.sessionId !== sessionId) {
        throw new Error(`Session authority mutation changed identity from ${sessionId} to ${next.sessionId}`)
      }

      const inserted = database.prepare(`
        INSERT INTO portable_session_events
          (session_id, mutation_id, event_type, before_document, document, entry, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        mutation.mutationId,
        mutation.eventType,
        serializeDocument(current),
        serializeDocument(next),
        mutation.entry ? JSON.stringify(mutation.entry) : null,
        new Date().toISOString(),
      )
      const version = Number(inserted.lastInsertRowid)
      if (next) {
        database.prepare(`
          INSERT INTO portable_sessions (session_id, version, document, deleting, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            version = excluded.version,
            document = excluded.document,
            deleting = excluded.deleting,
            updated_at = excluded.updated_at
        `).run(sessionId, version, JSON.stringify(next), sessionDeletion(next) ? 1 : 0, new Date().toISOString())
      } else {
        database.prepare(`DELETE FROM ${NATIVE_FS_TABLES.usage} WHERE tenant_id = '' AND session_id = ?`).run(sessionId)
        database.prepare('DELETE FROM portable_sessions WHERE session_id = ?').run(sessionId)
      }
      database.exec('COMMIT')
      return next
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
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

  async listDeleting(limit = 64, afterSessionId = ''): Promise<readonly PersistedSessionDocument[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer')
    const rows = this.#db().prepare(`
      SELECT document FROM portable_sessions
      WHERE deleting = 1 AND session_id > ? ORDER BY session_id LIMIT ?
    `).all(afterSessionId, limit) as Array<{ document: string }>
    return rows.map(({ document }) => parseDocument(document))
      .filter((document): document is PersistedSessionDocument => Boolean(document && sessionDeletion(document)))
  }

  async loadDeleting(sessionId: string): Promise<PersistedSessionDocument | undefined> {
    validateSessionId(sessionId)
    const document = this.#loadIncludingDeleting(sessionId)
    return document && sessionDeletion(document) ? document : undefined
  }

  async list(sessionIds?: readonly string[]): Promise<readonly PersistedSessionDocument[]> {
    const selected = sessionIds === undefined ? undefined : [...new Set(sessionIds)]
    if (selected?.length === 0) return []
    selected?.forEach(validateSessionId)
    const rows = this.#db().prepare(`SELECT document FROM portable_sessions
      ${selected ? `WHERE session_id IN (${selected.map(() => '?').join(',')})` : ''}
      ORDER BY session_id`).all(...(selected ?? [])) as Array<{ document: string }>
    return rows.map(({ document }) => parseDocument(document))
      .filter((document): document is PersistedSessionDocument => Boolean(document && !sessionDeletion(document)))
  }

  async findOperation(sessionId: string, operationId: string): Promise<SessionOperationMatch | undefined> {
    validateSessionId(sessionId)
    if (!operationId) throw new TypeError('operationId must be a non-empty string')
    for (const entry of this.#entries(sessionId).reverse()) {
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
    }
    return undefined
  }

  async findLatestRuntimeMetadata(sessionId: string, action: string): Promise<RuntimeMetadataEntry | undefined> {
    validateSessionId(sessionId)
    if (!action) throw new TypeError('runtime metadata action is required')
    return this.#entries(sessionId).reverse().find(
      (entry): entry is RuntimeMetadataEntry => entry.kind === 'runtime_metadata' && entry.action === action,
    )
  }

  async readEventEntries(sessionId: string): Promise<readonly EventEntry[]> {
    validateSessionId(sessionId)
    return this.#entries(sessionId).filter((entry): entry is EventEntry => entry.kind === 'event')
  }

  async readHistory(sessionId: string): Promise<ParsedHistory> {
    validateSessionId(sessionId)
    const rows = this.#eventRows(sessionId)
    const created = rows[0]
    if (!created || created.event_type !== 'session.created') throw new Error(`Session ${sessionId} has no creation history`)
    const initialDocument = parseDocument(created.document)
    if (!initialDocument || initialDocument.sessionId !== sessionId
      || !initialDocument.state || !Number.isSafeInteger(initialDocument.state.cursor)
      || !initialDocument.config || typeof initialDocument.config !== 'object') {
      throw new Error(`Session ${sessionId} has invalid creation history`)
    }
    const events: EventEntry[] = []
    const runtimeMetadata: RuntimeMetadataEntry[] = []
    for (const entry of rows.map(({ entry }) => parseEntry(entry))) {
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
    this.#database?.close()
    this.#database = undefined
  }

  #db(): DatabaseSync {
    if (!this.#database) throw new Error('SQLite Session authority is not initialized')
    return this.#database
  }

  #loadIncludingDeleting(sessionId: string): PersistedSessionDocument | undefined {
    validateSessionId(sessionId)
    const row = this.#db().prepare('SELECT document FROM portable_sessions WHERE session_id = ?').get(sessionId) as
      | { document: string }
      | undefined
    return row ? parseDocument(row.document) : undefined
  }

  #eventRows(sessionId: string): EventRow[] {
    return this.#db().prepare(`
      SELECT sequence, mutation_id, event_type, before_document, document, entry
      FROM portable_session_events WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId).map((row) => {
      if (!row || typeof row !== 'object'
        || !('sequence' in row) || typeof row.sequence !== 'number'
        || !('mutation_id' in row) || typeof row.mutation_id !== 'string'
        || !('event_type' in row) || typeof row.event_type !== 'string'
        || !('before_document' in row) || (row.before_document !== null && typeof row.before_document !== 'string')
        || !('document' in row) || (row.document !== null && typeof row.document !== 'string')
        || !('entry' in row) || (row.entry !== null && typeof row.entry !== 'string')) {
        throw new Error('Invalid SQLite session event row')
      }
      return {
        sequence: row.sequence, mutation_id: row.mutation_id, event_type: row.event_type,
        before_document: row.before_document, document: row.document, entry: row.entry,
      }
    })
  }

  #entries(sessionId: string): Array<EventEntry | RuntimeMetadataEntry> {
    return this.#eventRows(sessionId).map(({ entry }) => parseEntry(entry))
      .filter((entry): entry is EventEntry | RuntimeMetadataEntry => entry !== undefined)
  }
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

function serializeDocument(document: PersistedSessionDocument | undefined): string | null {
  return document ? JSON.stringify(document) : null
}

function parseDocument(value: string | null): PersistedSessionDocument | undefined {
  return value === null ? undefined : JSON.parse(value) as PersistedSessionDocument
}

function parseEntry(value: string | null): EventEntry | RuntimeMetadataEntry | undefined {
  return value === null ? undefined : JSON.parse(value) as EventEntry | RuntimeMetadataEntry
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
