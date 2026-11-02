import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  detectImageMime,
  extensionForMime,
  MAX_IMAGE_BYTES,
  type ResolvedSessionArtifact,
  type SessionArtifactRecord,
  type SessionArtifactStorage,
} from '../session-artifact-registry.js'
import { SqliteLocalObjects, installLocalObjectDeletionIntents, protectLocalObjectReference, requestLocalObjectDeletion } from './sqlite-local-objects.js'

type ArtifactRow = {
  artifact_id: string
  session_id: string
  title: string
  media_type: string
  bytes: number
  sha256: string
  file_name: string
  created_at: string
}

/**
 * Session image metadata for explicitly selected fresh Portable storage.
 * Bytes are published before their reference transaction, making a failed or
 * interrupted registration leave at most an unreferenced, safe CAS object.
 */
export class SqliteSessionArtifactStore implements SessionArtifactStorage {
  readonly databasePath: string
  readonly objects: SqliteLocalObjects
  #database?: DatabaseSync

  constructor(
    readonly stateRoot: string,
    options: { databasePath?: string; objects?: SqliteLocalObjects } = {},
  ) {
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
        CREATE TABLE IF NOT EXISTS portable_session_artifacts (
          artifact_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          media_type TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK (bytes > 0),
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          file_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS portable_session_artifacts_session_idx
          ON portable_session_artifacts(session_id, artifact_id);
        CREATE INDEX IF NOT EXISTS portable_session_artifacts_hash_idx
          ON portable_session_artifacts(sha256);
      `)
      installLocalObjectDeletionIntents(database)
      this.#database = database
    } catch (error) {
      database.close()
      throw error
    }
  }

  async registerImage(input: {
    sessionId: string
    title?: string
    fileName: string
    data: Buffer
  }): Promise<SessionArtifactRecord> {
    const mediaType = detectImageMime(input.data, input.fileName)
    if (!mediaType) throw new Error('unsupported image type')
    if (input.data.length === 0 || input.data.length > MAX_IMAGE_BYTES) {
      throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`)
    }
    if (!input.sessionId) throw new TypeError('sessionId must be a non-empty string')

    const object = await this.objects.write(input.data)
    const artifactId = randomUUID()
    const record: SessionArtifactRecord = {
      artifactId,
      sessionId: input.sessionId,
      title: input.title?.trim() || basename(input.fileName),
      mediaType,
      bytes: object.bytes,
      sha256: object.sha256,
      fileName: `${artifactId}${extensionForMime(mediaType)}`,
      createdAt: new Date().toISOString(),
    }

    const database = this.#db()
    database.exec('BEGIN IMMEDIATE')
    try {
      const session = database.prepare(`
        SELECT 1 AS admitted FROM portable_sessions WHERE session_id = ? AND deleting = 0
      `).get(record.sessionId)
      if (!session) throw new Error('Session is unavailable or deleting')
      protectLocalObjectReference(database, record.sha256)
      database.prepare(`
        INSERT INTO portable_session_artifacts (
          artifact_id, session_id, title, media_type, bytes, sha256, file_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.artifactId,
        record.sessionId,
        record.title,
        record.mediaType,
        record.bytes,
        record.sha256,
        record.fileName,
        record.createdAt,
      )
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return record
  }

  async get(sessionId: string, artifactId: string): Promise<ResolvedSessionArtifact | undefined> {
    const record = this.#loadAuthorized(sessionId, artifactId)
    if (!record) return undefined
    await this.objects.check(record)
    return {
      ...record,
      read: async () => {
        const current = this.#loadAuthorized(sessionId, artifactId)
        if (!current || current.sha256 !== record.sha256 || current.bytes !== record.bytes) {
          throw new Error(`Artifact "${record.title}" is unavailable or does not belong to this Session`)
        }
        try {
          return await this.objects.read(current)
        } catch (error) {
          throw new Error(`Artifact "${record.title}" failed Host integrity validation: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId must be a non-empty string')
    const database = this.#db()
    database.exec('BEGIN IMMEDIATE')
    try {
      const hashes = database.prepare('SELECT DISTINCT sha256 FROM portable_session_artifacts WHERE session_id = ?')
        .all(sessionId) as { sha256: string }[]
      database.prepare('DELETE FROM portable_session_artifacts WHERE session_id = ?').run(sessionId)
      requestLocalObjectDeletion(database, hashes.map((row) => row.sha256))
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    // CAS bytes are retained intentionally. Artifact and attachment rows can
    // share a hash, so only a GC transaction covering both stores may unlink.
  }

  async close(): Promise<void> {
    this.#database?.close()
    this.#database = undefined
  }

  #db(): DatabaseSync {
    if (!this.#database) throw new Error('SQLite Session artifact store is not loaded')
    return this.#database
  }

  #loadAuthorized(sessionId: string, artifactId: string): SessionArtifactRecord | undefined {
    if (!sessionId || !artifactId) return undefined
    const row = this.#db().prepare(`
      SELECT
        artifact.artifact_id,
        artifact.session_id,
        artifact.title,
        artifact.media_type,
        artifact.bytes,
        artifact.sha256,
        artifact.file_name,
        artifact.created_at
      FROM portable_session_artifacts AS artifact
      INNER JOIN portable_sessions AS session ON session.session_id = artifact.session_id
      WHERE artifact.session_id = ? AND artifact.artifact_id = ? AND session.deleting = 0
    `).get(sessionId, artifactId) as ArtifactRow | undefined
    return row ? fromRow(row) : undefined
  }
}

function fromRow(row: ArtifactRow): SessionArtifactRecord {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    title: row.title,
    mediaType: row.media_type,
    bytes: row.bytes,
    sha256: row.sha256,
    fileName: row.file_name,
    createdAt: row.created_at,
  }
}
