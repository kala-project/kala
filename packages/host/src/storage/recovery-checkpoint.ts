import { createHash } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

import { assertInstallationId, type PostgresClaimExecutor, type PostgresClaimPool, type S3ClaimClient } from './fresh-install-claim.js'

export const RECOVERY_CHECKPOINT_OBJECT_KEY = '_kala/recovery-checkpoint.json'
const CHECKPOINT_TABLE = 'kala_installation_claim.recovery_checkpoint'
const MAX_CHECKPOINT_BYTES = 4096

export interface RecoveryCheckpoint {
  installationId: string
  checkpointId: string
  keySha256: string
}

export function stateKeySha256(key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error('Runtime state master key must contain exactly 32 bytes')
  return createHash('sha256').update(key).digest('hex')
}

function validCheckpoint(value: RecoveryCheckpoint): RecoveryCheckpoint {
  assertInstallationId(value.installationId)
  assertInstallationId(value.checkpointId)
  if (!/^[a-f0-9]{64}$/u.test(value.keySha256)) throw new Error('Recovery checkpoint has invalid key fingerprint')
  return value
}

export async function readPostgresRecoveryCheckpoint(db: PostgresClaimExecutor): Promise<RecoveryCheckpoint> {
  // Missing tables, permissions and incomplete records must all fail closed.
  const result = await db.query<{ installation_id: string; checkpoint_id: string; key_sha256: string }>(
    `SELECT installation_id, checkpoint_id, key_sha256 FROM ${CHECKPOINT_TABLE} WHERE singleton = true`,
  )
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error('PostgreSQL recovery checkpoint is missing')
  const row = result.rows[0]
  return validCheckpoint({ installationId: row.installation_id, checkpointId: row.checkpoint_id, keySha256: row.key_sha256 })
}

export async function readS3RecoveryCheckpoint(client: S3ClaimClient, bucket: string): Promise<RecoveryCheckpoint> {
  return (await fetchS3Checkpoint(client, bucket)).checkpoint
}

async function fetchS3Checkpoint(client: S3ClaimClient, bucket: string): Promise<{ checkpoint: RecoveryCheckpoint; etag: string }> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: RECOVERY_CHECKPOINT_OBJECT_KEY })) as {
    Body?: AsyncIterable<Uint8Array> & { destroy?(): void }; ContentLength?: number; ETag?: string
  }
  if (!result.Body) throw new Error('S3 recovery checkpoint has no body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (result.ContentLength !== undefined && result.ContentLength > MAX_CHECKPOINT_BYTES) throw new Error('S3 recovery checkpoint exceeds size limit')
    for await (const chunk of result.Body) {
      size += chunk.byteLength
      if (size > MAX_CHECKPOINT_BYTES) throw new Error('S3 recovery checkpoint exceeds size limit')
      chunks.push(chunk)
    }
  } finally {
    result.Body.destroy?.()
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { throw new Error('S3 recovery checkpoint is invalid') }
  if (!value || typeof value !== 'object' || (value as { format?: unknown }).format !== 1) throw new Error('S3 recovery checkpoint is invalid')
  const parsed = value as Partial<RecoveryCheckpoint>
  const checkpoint = validCheckpoint({ installationId: parsed.installationId!, checkpointId: parsed.checkpointId!, keySha256: parsed.keySha256! })
  if (!result.ETag) throw new Error('S3 recovery checkpoint has no ETag for conditional update')
  return { checkpoint, etag: result.ETag }
}

export function assertRecoveryCheckpoint(value: RecoveryCheckpoint, expected: RecoveryCheckpoint, label: string): void {
  if (value.installationId !== expected.installationId || value.checkpointId !== expected.checkpointId || value.keySha256 !== expected.keySha256) {
    throw new Error(`${label} recovery checkpoint does not match the expected recovery set or Runtime state key`)
  }
}

export async function initializeRecoveryCheckpoints(options: {
  control: PostgresClaimPool; runtime: PostgresClaimPool; objectStore: S3ClaimClient; bucket: string; checkpoint: RecoveryCheckpoint
}): Promise<void> {
  const checkpoint = validCheckpoint(options.checkpoint)
  // The bootstrap job is the only writer. A failed partial write is NOT repaired automatically.
  await insertPostgresCheckpoint(options.control, checkpoint)
  await insertPostgresCheckpoint(options.runtime, checkpoint)
  await options.objectStore.send(new PutObjectCommand({
    Bucket: options.bucket, Key: RECOVERY_CHECKPOINT_OBJECT_KEY, Body: JSON.stringify({ format: 1, ...checkpoint }),
    ContentType: 'application/json', IfNoneMatch: '*',
  }))
}

async function insertPostgresCheckpoint(pool: PostgresClaimPool, checkpoint: RecoveryCheckpoint): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE TABLE ${CHECKPOINT_TABLE} (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      installation_id text NOT NULL, checkpoint_id text NOT NULL, key_sha256 text NOT NULL
    )`)
    const inserted = await client.query(`INSERT INTO ${CHECKPOINT_TABLE} (singleton, installation_id, checkpoint_id, key_sha256) VALUES (true, $1, $2, $3)`,
      [checkpoint.installationId, checkpoint.checkpointId, checkpoint.keySha256])
    if (inserted.rowCount !== 1) throw new Error('PostgreSQL checkpoint insert failed')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** Offline-only CAS; caller must have isolated ALL former writers and retain the same target ID on retry. */
export async function advanceRecoveryCheckpoints(options: {
  control: PostgresClaimPool; runtime: PostgresClaimPool; objectStore: S3ClaimClient; bucket: string
  previous: RecoveryCheckpoint; next: RecoveryCheckpoint; resumePartial: boolean
}): Promise<void> {
  const { control, runtime, objectStore, bucket, previous, next, resumePartial } = options
  validCheckpoint(previous); validCheckpoint(next)
  if (previous.installationId !== next.installationId || previous.keySha256 !== next.keySha256 || previous.checkpointId === next.checkpointId) {
    throw new Error('Recovery checkpoint transition must keep installation and key while advancing the checkpoint ID')
  }
  const [controlRow, runtimeRow, s3Row] = await Promise.all([
    readPostgresRecoveryCheckpoint(control), readPostgresRecoveryCheckpoint(runtime), readS3RecoveryCheckpoint(objectStore, bucket),
  ])
  const rows = [controlRow, runtimeRow, s3Row]
  if (rows.some((row) => !sameCheckpoint(row, previous) && !sameCheckpoint(row, next))) throw new Error('Recovery authority contains an unexpected checkpoint; manual investigation required')
  if (!resumePartial && rows.some((row) => sameCheckpoint(row, next))) throw new Error('Partial checkpoint exists; explicitly retry the same transition with --resume-partial')
  if (sameCheckpoint(controlRow, previous)) await updatePostgresCheckpoint(control, previous, next)
  if (sameCheckpoint(runtimeRow, previous)) await updatePostgresCheckpoint(runtime, previous, next)
  if (sameCheckpoint(s3Row, previous)) {
    // Compare the fetched body as well as its ETag; never CAS against an unrelated intervening checkpoint.
    const current = await fetchS3Checkpoint(objectStore, bucket)
    if (!sameCheckpoint(current.checkpoint, previous)) throw new Error('Concurrent S3 recovery checkpoint update; stop and investigate')
    await objectStore.send(new PutObjectCommand({
      Bucket: bucket, Key: RECOVERY_CHECKPOINT_OBJECT_KEY, Body: JSON.stringify({ format: 1, ...next }),
      ContentType: 'application/json', IfMatch: current.etag,
    }))
  }
  const verified = await Promise.all([
    readPostgresRecoveryCheckpoint(control), readPostgresRecoveryCheckpoint(runtime), readS3RecoveryCheckpoint(objectStore, bucket),
  ])
  for (const [index, row] of verified.entries()) assertRecoveryCheckpoint(row, next, ['control PostgreSQL', 'Runtime PostgreSQL', 'S3'][index]!)
}

function sameCheckpoint(a: RecoveryCheckpoint, b: RecoveryCheckpoint): boolean {
  return a.installationId === b.installationId && a.checkpointId === b.checkpointId && a.keySha256 === b.keySha256
}

async function updatePostgresCheckpoint(pool: PostgresClaimPool, previous: RecoveryCheckpoint, next: RecoveryCheckpoint): Promise<void> {
  const updated = await pool.query(`UPDATE ${CHECKPOINT_TABLE} SET checkpoint_id = $4 WHERE singleton = true AND installation_id = $1 AND checkpoint_id = $2 AND key_sha256 = $3`,
    [previous.installationId, previous.checkpointId, previous.keySha256, next.checkpointId])
  if (updated.rowCount !== 1) throw new Error('Concurrent PostgreSQL recovery checkpoint update; stop and investigate')
}
