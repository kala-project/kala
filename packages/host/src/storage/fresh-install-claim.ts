import { GetObjectCommand, ListObjectVersionsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createRequire } from 'node:module'

export const INSTALLATION_CLAIM_SCHEMA = 'kala_installation_claim'
export const INSTALLATION_CLAIM_OBJECT_KEY = '_kala/installation-claim.json'

const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (config: Record<string, unknown>) => PostgresClaimPool
}

export interface PostgresClaimExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>
}

export interface PostgresClaimPool extends PostgresClaimExecutor {
  connect(): Promise<PostgresClaimClient>
  end(): Promise<void>
}

export interface PostgresClaimClient extends PostgresClaimExecutor {
  release(): void
}

export interface S3ClaimClient {
  send(command: unknown): Promise<unknown>
}

export interface FreshInstallationAuthorities {
  controlDatabase: PostgresClaimPool
  runtimeDatabase: PostgresClaimPool
  objectStore: S3ClaimClient
}

export interface FreshInstallationClaimOptions {
  installationId: string
  bucket: string
  authorities: FreshInstallationAuthorities
}

const USER_OBJECTS_QUERY = `SELECT EXISTS (
  SELECT 1
  FROM pg_namespace AS n
  WHERE n.nspname <> 'public'
    AND n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
  UNION ALL
  SELECT 1
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 1
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
  UNION ALL
  SELECT 1
  FROM pg_type AS t
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
    AND t.typtype IN ('c', 'd', 'e', 'r', 'm')
) AS has_user_objects`

const CREATE_MARKER_QUERY = `CREATE SCHEMA IF NOT EXISTS ${INSTALLATION_CLAIM_SCHEMA};
CREATE TABLE IF NOT EXISTS ${INSTALLATION_CLAIM_SCHEMA}.marker (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`

export function assertInstallationId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('installation ID file must contain one canonical UUID')
  }
}

/**
 * Claims empty external authorities; no local volume or receipt decides whether
 * this installation may resume. A partial set of external markers blocks retry.
 */
export async function claimFreshInstallation(options: FreshInstallationClaimOptions): Promise<'claimed' | 'verified'> {
  assertInstallationId(options.installationId)
  if (!options.bucket.trim()) throw new Error('S3 bucket is required')

  const controlMarker = await readPostgresMarker(options.authorities.controlDatabase)
  const runtimeMarker = await readPostgresMarker(options.authorities.runtimeDatabase)
  const objectMarker = await readS3Marker(options.authorities.objectStore, options.bucket)
  const markers = [controlMarker, runtimeMarker, objectMarker]
  if (markers.every((marker) => marker === options.installationId)) return 'verified'
  if (markers.some((marker) => marker !== undefined)) {
    throw new Error('external storage has a different or incomplete installation claim; manual recovery is required')
  }

  await assertPostgresEmpty(options.authorities.controlDatabase, 'control PostgreSQL')
  await assertPostgresEmpty(options.authorities.runtimeDatabase, 'Runtime PostgreSQL')
  await assertBucketEmpty(options.authorities.objectStore, options.bucket)

  await writePostgresMarker(options.authorities.controlDatabase, options.installationId, 'control PostgreSQL')
  await writePostgresMarker(options.authorities.runtimeDatabase, options.installationId, 'Runtime PostgreSQL')
  await writeS3Marker(options.authorities.objectStore, options.bucket, options.installationId)
  return 'claimed'
}

export async function assertPostgresEmpty(pool: PostgresClaimPool, label: string): Promise<void> {
  const result = await pool.query<{ has_user_objects: boolean }>(USER_OBJECTS_QUERY)
  if (result.rows.length !== 1 || result.rows[0]?.has_user_objects !== false) {
    throw new Error(`${label} is not empty; fresh installation claim refused`)
  }
}

export async function assertBucketEmpty(client: S3ClaimClient, bucket: string): Promise<void> {
  let continuationToken: string | undefined
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    })) as { Contents?: readonly unknown[]; IsTruncated?: boolean; NextContinuationToken?: string }
    if ((response.Contents?.length ?? 0) > 0) {
      throw new Error('S3 bucket is not empty; fresh installation claim refused')
    }
    if (!response.IsTruncated) break
    const next = response.NextContinuationToken?.trim()
    if (!next || next === continuationToken) throw new Error('S3 listing was truncated without a usable continuation token')
    continuationToken = next
  } while (true)
  // ListObjectsV2 hides non-current versions and delete markers. Refuse to
  // claim a bucket with recoverable history, even when its current view is empty.
  // Missing API permission fails closed rather than accepting an unsafe bucket.
  const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1 })) as {
    Versions?: readonly unknown[]; DeleteMarkers?: readonly unknown[]; IsTruncated?: boolean
  }
  if ((versions.Versions?.length ?? 0) > 0 || (versions.DeleteMarkers?.length ?? 0) > 0 || versions.IsTruncated) {
    throw new Error('S3 bucket has object versions or delete markers; fresh installation claim refused')
  }
}

async function writePostgresMarker(pool: PostgresClaimPool, installationId: string, label: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(CREATE_MARKER_QUERY)
    const inserted = await client.query(
      `INSERT INTO ${INSTALLATION_CLAIM_SCHEMA}.marker (singleton, installation_id) VALUES (true, $1)`,
      [installationId],
    )
    if (inserted.rowCount !== 1) throw new Error(`${label} marker was not written`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error(`${label} claim failed; partial claims require operator intervention and must not be deleted automatically`, { cause: error })
  } finally {
    client.release()
  }
}

async function readPostgresMarker(pool: PostgresClaimPool): Promise<string | undefined> {
  const present = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('${INSTALLATION_CLAIM_SCHEMA}.marker') IS NOT NULL AS exists`,
  )
  if (present.rows[0]?.exists !== true) return undefined
  const result = await pool.query<{ installation_id: string }>(
    `SELECT installation_id FROM ${INSTALLATION_CLAIM_SCHEMA}.marker WHERE singleton = true`,
  )
  if (result.rowCount !== 1 || !result.rows[0]?.installation_id) throw new Error('PostgreSQL has an incomplete installation claim')
  return result.rows[0].installation_id
}

function markerBody(installationId: string): string {
  return `${JSON.stringify({ format: 1, installationId })}\n`
}

async function writeS3Marker(client: S3ClaimClient, bucket: string, installationId: string): Promise<void> {
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: INSTALLATION_CLAIM_OBJECT_KEY,
      Body: markerBody(installationId),
      ContentType: 'application/json',
      IfNoneMatch: '*',
    }))
  } catch (error) {
    throw new Error('S3 claim failed; partial claims require operator intervention and must not be deleted automatically', { cause: error })
  }
}

async function readS3Marker(client: S3ClaimClient, bucket: string): Promise<string | undefined> {
  let response: { Body?: { transformToString(): Promise<string> } }
  try {
    response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: INSTALLATION_CLAIM_OBJECT_KEY })) as typeof response
  } catch (error) {
    const missing = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (missing.name === 'NoSuchKey' || missing.$metadata?.httpStatusCode === 404 && missing.name !== 'NoSuchBucket') return undefined
    throw new Error('S3 installation marker could not be checked', { cause: error })
  }
  if (!response.Body) throw new Error('S3 installation marker has no body')
  const body = await response.Body.transformToString()
  let marker: { format?: unknown; installationId?: unknown }
  try { marker = JSON.parse(body) } catch { throw new Error('S3 installation marker is invalid') }
  if (marker.format !== 1 || typeof marker.installationId !== 'string') throw new Error('S3 installation marker is invalid')
  return marker.installationId
}

export function createPostgresClaimPool(connectionString: string, applicationName: string): PostgresClaimPool {
  return new Pool({ connectionString, application_name: applicationName, max: 1, connectionTimeoutMillis: 5_000 })
}

export function createS3ClaimClient(options: {
  endpoint?: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}): S3ClaimClient {
  return new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  })
}
