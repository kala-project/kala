import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { MemoDocument } from '../memo-store.js'
import type { HotStateDatabase, HotStateSqlExecutor } from './postgres-hot-state.js'

const CIPHER = 'aes-256-gcm'
const NONCE_BYTES = 12
const MASTER_KEY_BYTES = 32
const EMPTY_MEMO_UPDATED_AT = new Date(0).toISOString()

type MemoRow = Record<string, unknown> & {
  content: string
  revision: string | number
  updated_at: Date | string
}

type CredentialRow = Record<string, unknown> & {
  ciphertext: Buffer
  nonce: Buffer
  auth_tag: Buffer
  metadata: unknown
  updated_at: Date | string
}

export type PostgresCredentialRecord = {
  secret: string
  metadata: Record<string, unknown>
  updatedAt: string
}

/**
 * Reads a raw externally-provisioned AES-256 key. The file must contain exactly
 * 32 bytes; this intentionally never creates or repairs key material.
 */
export async function loadPostgresStateMasterKey(keyPath: string): Promise<Buffer> {
  const key = await readFile(keyPath)
  if (key.length !== MASTER_KEY_BYTES) {
    key.fill(0)
    throw new Error(`PostgreSQL state master key must contain exactly ${MASTER_KEY_BYTES} bytes`)
  }
  return key
}

/**
 * Tenant-bound PostgreSQL state primitives for Private Cloud experimental
 * storage. The caller must derive tenantId from trusted runtime authority.
 * Construction performs no DDL; initializeSchema is only for migrations/tests.
 */
export class PostgresTenantStateStore {
  readonly #tenantId: string
  readonly #masterKey: Buffer
  readonly #memos: string
  readonly #credentials: string

  constructor(
    readonly database: HotStateDatabase,
    tenantId: string,
    masterKey: Uint8Array,
    options: { schema?: string } = {},
  ) {
    if (!tenantId) throw new TypeError('tenantId must be a non-empty string')
    if (masterKey.byteLength !== MASTER_KEY_BYTES) throw new TypeError(`masterKey must contain exactly ${MASTER_KEY_BYTES} bytes`)
    this.#tenantId = tenantId
    this.#masterKey = Buffer.from(masterKey)
    const schema = quoteIdentifier(options.schema ?? 'public')
    this.#memos = `${schema}.tenant_state_memos`
    this.#credentials = `${schema}.tenant_state_credentials`
  }

  /** Explicit schema bootstrap for migrations and isolated tests; never called by runtime constructors. */
  async initializeSchema(): Promise<void> {
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#memos} (
      tenant_id text NOT NULL,
      owner text NOT NULL,
      content text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, owner)
    )`)
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#credentials} (
      tenant_id text NOT NULL,
      credential_id text NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      auth_tag bytea NOT NULL,
      metadata jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, credential_id)
    )`)
  }

  async readMemo(owner: string): Promise<MemoDocument> {
    validateIdentifierValue(owner, 'owner')
    const result = await this.database.query<MemoRow>(`SELECT content, revision, updated_at
      FROM ${this.#memos} WHERE tenant_id = $1 AND owner = $2`, [this.#tenantId, owner])
    const row = result.rows[0]
    return row ? memoDocument(row) : { content: '', revision: 0, updatedAt: EMPTY_MEMO_UPDATED_AT }
  }

  async writeMemo(owner: string, input: { content: string; expectedRevision?: number }): Promise<MemoDocument> {
    validateIdentifierValue(owner, 'owner')
    if (typeof input.content !== 'string') throw new TypeError('content must be a string')
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
      throw new TypeError('expectedRevision must be a non-negative safe integer')
    }
    const result = await this.database.query<MemoRow>(`INSERT INTO ${this.#memos}
        (tenant_id, owner, content, revision, updated_at)
      SELECT $1, $2, $3, 1, clock_timestamp()
      WHERE $4::bigint IS NULL OR $4::bigint = 0
      ON CONFLICT (tenant_id, owner) DO UPDATE
        SET content = EXCLUDED.content,
            revision = ${this.#memos}.revision + 1,
            updated_at = clock_timestamp()
        WHERE $4::bigint IS NULL OR ${this.#memos}.revision = $4::bigint
      RETURNING content, revision, updated_at`, [this.#tenantId, owner, input.content, input.expectedRevision ?? null])
    const row = result.rows[0]
    if (!row) throw new Error('memo_revision_conflict')
    return memoDocument(row)
  }

  /** Serialize multi-step updates to a tenant credential across Runtime processes. */
  async withCredentialLock<T>(credentialId: string, operation: (transaction: HotStateSqlExecutor) => Promise<T>): Promise<T> {
    validateIdentifierValue(credentialId, 'credentialId')
    return this.database.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [this.#tenantId, credentialId])
      return operation(transaction)
    })
  }

  async getCredential(credentialId: string, executor: HotStateSqlExecutor = this.database): Promise<PostgresCredentialRecord | undefined> {
    validateIdentifierValue(credentialId, 'credentialId')
    const result = await executor.query<CredentialRow>(`SELECT ciphertext, nonce, auth_tag, metadata, updated_at
      FROM ${this.#credentials} WHERE tenant_id = $1 AND credential_id = $2`, [this.#tenantId, credentialId])
    const row = result.rows[0]
    if (!row) return undefined
    try {
      const decipher = createDecipheriv(CIPHER, this.#masterKey, row.nonce)
      decipher.setAAD(this.#aad(credentialId))
      decipher.setAuthTag(row.auth_tag)
      const secret = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
      return { secret, metadata: parseMetadata(row.metadata), updatedAt: isoTimestamp(row.updated_at) }
    } catch (cause) {
      throw new Error('credential_decryption_failed', { cause })
    }
  }

  async setCredential(
    credentialId: string,
    secret: string,
    metadata: Record<string, unknown>,
    updatedAt = new Date().toISOString(),
    executor: HotStateSqlExecutor = this.database,
  ): Promise<void> {
    validateIdentifierValue(credentialId, 'credentialId')
    if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('secret must be a non-empty string')
    const encodedMetadata = JSON.stringify(metadata)
    if (encodedMetadata === undefined) throw new TypeError('metadata must be JSON-serializable')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(CIPHER, this.#masterKey, nonce)
    cipher.setAAD(this.#aad(credentialId))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    await executor.query(`INSERT INTO ${this.#credentials}
        (tenant_id, credential_id, ciphertext, nonce, auth_tag, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
      ON CONFLICT (tenant_id, credential_id) DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        nonce = EXCLUDED.nonce,
        auth_tag = EXCLUDED.auth_tag,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
    [this.#tenantId, credentialId, ciphertext, nonce, authTag, encodedMetadata, updatedAt])
  }

  async deleteCredential(credentialId: string, executor: HotStateSqlExecutor = this.database): Promise<void> {
    validateIdentifierValue(credentialId, 'credentialId')
    await executor.query(`DELETE FROM ${this.#credentials}
      WHERE tenant_id = $1 AND credential_id = $2`, [this.#tenantId, credentialId])
  }

  #aad(credentialId: string): Buffer {
    return Buffer.from(`kala:tenant-state-credential:v1\0${this.#tenantId}\0${credentialId}`, 'utf8')
  }
}

function memoDocument(row: MemoRow): MemoDocument {
  const revision = Number(row.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid memo revision returned by PostgreSQL')
  return { content: row.content, revision, updatedAt: isoTimestamp(row.updated_at) }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid credential metadata returned by PostgreSQL')
  return parsed as Record<string, unknown>
}

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp returned by PostgreSQL')
  return date.toISOString()
}

function validateIdentifierValue(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
