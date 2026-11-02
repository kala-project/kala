import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { MessageContent, ReferencedFileContent } from '@agent-kernel/kernel'
import {
  MAX_ATTACHMENT_STORE_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_SESSION_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENTS, PENDING_MESSAGE_ATTACHMENT_TTL_MS,
  type MessageAttachmentStorage, type ResolvedMessageAttachment,
} from '../message-attachment-store.js'
import { SqliteLocalObjects, installLocalObjectDeletionIntents, protectLocalObjectReference, requestLocalObjectDeletion } from './sqlite-local-objects.js'

type Row = {
  attachment_id: string; session_id: string; name: string; media_type: string
  bytes: number; sha256: string; created_at: string; committed_at: string | null
}

/** SQLite references to immutable local CAS bytes, selected only by fresh Portable installations. */
export class SqliteMessageAttachmentStore implements MessageAttachmentStorage {
  readonly databasePath: string
  readonly objects: SqliteLocalObjects
  #database?: DatabaseSync

  constructor(readonly stateRoot: string, options: { databasePath?: string; objects?: SqliteLocalObjects } = {}) {
    this.databasePath = options.databasePath ?? join(stateRoot, 'state.sqlite')
    this.objects = options.objects ?? new SqliteLocalObjects(stateRoot)
  }

  async load(): Promise<void> {
    if (this.#database) return
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(this.databasePath)
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS portable_message_attachments (
          attachment_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK (bytes > 0),
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          created_at TEXT NOT NULL,
          committed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS portable_message_attachments_session_idx
          ON portable_message_attachments(session_id, attachment_id);
        CREATE INDEX IF NOT EXISTS portable_message_attachments_hash_idx
          ON portable_message_attachments(sha256);
      `)
      installLocalObjectDeletionIntents(database)
      this.#database = database
      this.#transaction(() => {
        const cutoff = new Date(Date.now() - PENDING_MESSAGE_ATTACHMENT_TTL_MS).toISOString()
        const expired = database.prepare('SELECT DISTINCT sha256 FROM portable_message_attachments WHERE committed_at IS NULL AND created_at < ?')
          .all(cutoff) as { sha256: string }[]
        database.prepare('DELETE FROM portable_message_attachments WHERE committed_at IS NULL AND created_at < ?').run(cutoff)
        requestLocalObjectDeletion(database, expired.map((row) => row.sha256))
      })
    } catch (error) {
      database.close()
      this.#database = undefined
      throw error
    }
  }

  async register(input: { sessionId: string; name: string; mediaType?: string; data: Buffer }): Promise<ReferencedFileContent> {
    const sessionId = normalizeSessionId(input.sessionId)
    const name = safeDisplayName(input.name)
    const mediaType = safeMediaType(input.mediaType)
    if (input.data.length < 1 || input.data.length > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new Error(`Attachment must be between 1 byte and ${MAX_MESSAGE_ATTACHMENT_BYTES} bytes`)
    }
    // Bytes are fully published and hash-checked before any SQLite reference can be acknowledged.
    // A failed transaction leaves only reclaimable, unreferenced bytes.
    const object = await this.objects.write(input.data)
    return this.#transaction((db) => {
      assertLiveSession(db, sessionId)
      const duplicate = db.prepare(`SELECT * FROM portable_message_attachments
        WHERE session_id = ? AND sha256 = ? AND name = ? AND media_type = ? AND committed_at IS NOT NULL LIMIT 1`)
        .get(sessionId, object.sha256, name, mediaType) as Row | undefined
      if (duplicate) {
        protectLocalObjectReference(db, object.sha256)
        return reference(duplicate)
      }
      const usage = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
        FROM portable_message_attachments WHERE session_id = ?`).get(sessionId) as { count: number; bytes: number }
      if (usage.count >= MAX_SESSION_ATTACHMENTS) throw new Error(`Session attachment limit of ${MAX_SESSION_ATTACHMENTS} files exceeded`)
      if (usage.bytes + object.bytes > MAX_SESSION_ATTACHMENT_BYTES) {
        throw new Error(`Session attachment storage limit of ${MAX_SESSION_ATTACHMENT_BYTES} bytes exceeded`)
      }
      const total = db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
        SELECT MAX(bytes) AS bytes FROM portable_message_attachments GROUP BY sha256
      )`).get() as { bytes: number }
      const alreadyStored = db.prepare('SELECT 1 FROM portable_message_attachments WHERE sha256 = ? LIMIT 1').get(object.sha256)
      if (!alreadyStored && total.bytes + object.bytes > MAX_ATTACHMENT_STORE_BYTES) {
        throw new Error(`Host attachment storage limit of ${MAX_ATTACHMENT_STORE_BYTES} bytes exceeded`)
      }
      const row: Row = {
        attachment_id: randomUUID(), session_id: sessionId, name, media_type: mediaType,
        bytes: object.bytes, sha256: object.sha256, created_at: new Date().toISOString(), committed_at: null,
      }
      protectLocalObjectReference(db, object.sha256)
      db.prepare(`INSERT INTO portable_message_attachments
        (attachment_id, session_id, name, media_type, bytes, sha256, created_at, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(row.attachment_id, row.session_id, row.name, row.media_type, row.bytes, row.sha256, row.created_at)
      return reference(row)
    })
  }

  async commitReferences(sessionId: string, content: readonly MessageContent[] | undefined): Promise<void> {
    const files = (content ?? []).filter((block): block is ReferencedFileContent =>
      block.type === 'file' && 'source' in block && block.source.kind === 'host_ref')
    if (files.length === 0) return
    this.#transaction((db) => {
      assertLiveSession(db, sessionId)
      for (const file of files) {
        const row = this.#row(db, sessionId, file.source.attachmentId)
        if (!row || row.sha256 !== file.source.sha256 || row.bytes !== file.source.bytes
          || row.name !== file.name || row.media_type !== file.mediaType) {
          throw new Error('Attachment reference does not belong to this Session or has mismatched metadata')
        }
      }
      const update = db.prepare(`UPDATE portable_message_attachments SET committed_at = ?
        WHERE session_id = ? AND attachment_id = ? AND committed_at IS NULL`)
      for (const attachmentId of new Set(files.map((file) => file.source.attachmentId))) {
        update.run(new Date().toISOString(), sessionId, attachmentId)
      }
    })
  }

  async releasePending(sessionId: string, attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return
    this.#transaction((db) => {
      const find = db.prepare(`SELECT sha256 FROM portable_message_attachments
        WHERE session_id = ? AND attachment_id = ? AND committed_at IS NULL`)
      const remove = db.prepare(`DELETE FROM portable_message_attachments
        WHERE session_id = ? AND attachment_id = ? AND committed_at IS NULL`)
      const hashes: string[] = []
      for (const attachmentId of new Set(attachmentIds)) {
        const row = find.get(sessionId, attachmentId) as { sha256: string } | undefined
        if (row) hashes.push(row.sha256)
        remove.run(sessionId, attachmentId)
      }
      requestLocalObjectDeletion(db, hashes)
    })
    // A shared hash may be protected by an artifact or another Session; byte GC is separate.
  }

  resolve(sessionId: string, file: ReferencedFileContent): ResolvedMessageAttachment {
    const record = this.resolveById(sessionId, file.source.attachmentId)
    if (record.sha256 !== file.source.sha256 || record.bytes !== file.source.bytes
      || record.name !== file.name || record.mediaType !== file.mediaType) {
      throw new Error(`Attachment "${file.name}" reference metadata does not match Host storage`)
    }
    return record
  }

  resolveById(sessionId: string, attachmentId: string): ResolvedMessageAttachment {
    const db = this.#db()
    const row = this.#row(db, sessionId, attachmentId)
    if (!row || !isLiveSession(db, sessionId)) throw new Error('Attachment is unavailable or does not belong to this Session')
    const path = this.objects.pathForHash(row.sha256)
    return {
      attachmentId: row.attachment_id, sessionId: row.session_id, name: row.name, mediaType: row.media_type,
      bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at,
      ...(row.committed_at ? { committedAt: row.committed_at } : {}), path,
      read: async () => {
        if (!this.#row(this.#db(), sessionId, attachmentId) || !isLiveSession(this.#db(), sessionId)) {
          throw new Error('Attachment is unavailable or does not belong to this Session')
        }
        return await this.objects.read({ sha256: row.sha256, bytes: row.bytes })
      },
    }
  }

  async sdkFilePath(sessionId: string, file: ReferencedFileContent): Promise<string | undefined> {
    const record = this.resolve(sessionId, file)
    const info = await stat(record.path).catch(() => undefined)
    if (!info?.isFile() || info.size !== record.bytes) return undefined
    await this.objects.check(record)
    return record.path
  }

  allowsSdkRead(sessionId: string, requestedPath: string): boolean {
    if (!isAbsolute(requestedPath)) return false
    const db = this.#db()
    if (!isLiveSession(db, sessionId)) return false
    const path = resolve(requestedPath)
    const rows = db.prepare('SELECT sha256 FROM portable_message_attachments WHERE session_id = ?')
      .all(sessionId) as { sha256: string }[]
    return rows.some((row) => this.objects.pathForHash(row.sha256) === path)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.#transaction((db) => {
      const hashes = db.prepare('SELECT DISTINCT sha256 FROM portable_message_attachments WHERE session_id = ?')
        .all(sessionId) as { sha256: string }[]
      db.prepare('DELETE FROM portable_message_attachments WHERE session_id = ?').run(sessionId)
      requestLocalObjectDeletion(db, hashes.map((row) => row.sha256))
    })
  }

  async close(): Promise<void> { this.#database?.close(); this.#database = undefined }

  #row(db: DatabaseSync, sessionId: string, attachmentId: string): Row | undefined {
    return db.prepare('SELECT * FROM portable_message_attachments WHERE session_id = ? AND attachment_id = ?')
      .get(sessionId, attachmentId) as Row | undefined
  }
  #db(): DatabaseSync {
    if (!this.#database) throw new Error('SQLite message attachment store must be loaded before use')
    return this.#database
  }
  #transaction<T>(work: (db: DatabaseSync) => T): T {
    const db = this.#db()
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(db); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
}

function isLiveSession(db: DatabaseSync, sessionId: string): boolean {
  return db.prepare('SELECT 1 FROM portable_sessions WHERE session_id = ? AND deleting = 0').get(sessionId) !== undefined
}
function assertLiveSession(db: DatabaseSync, sessionId: string): void {
  if (!isLiveSession(db, sessionId)) throw new Error('Session is unavailable or deleting')
}
function reference(row: Row): ReferencedFileContent {
  return { type: 'file', name: row.name, mediaType: row.media_type,
    source: { kind: 'host_ref', attachmentId: row.attachment_id, sha256: row.sha256, bytes: row.bytes } }
}
function normalizeSessionId(value: string): string {
  const sessionId = value.trim()
  if (!sessionId || sessionId.length > 200) throw new Error('Invalid attachment Session id')
  return sessionId
}
function safeDisplayName(value: string): string {
  const name = value.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim() ?? ''
  if (!name || name === '.' || name === '..' || name.length > 255) throw new Error('Invalid attachment file name')
  return name
}
function safeMediaType(value: string | undefined): string {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream'
  if (mediaType.length > 255 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mediaType)) {
    throw new Error('Invalid attachment media type')
  }
  return mediaType
}
