import { describe, expect, it } from 'vitest'

import {
  assertBucketEmpty,
  assertPostgresInstallationClaim,
  assertS3InstallationClaim,
  claimFreshInstallation,
  INSTALLATION_CLAIM_OBJECT_KEY,
  type PostgresClaimClient,
  type PostgresClaimPool,
  type S3ClaimClient,
} from './fresh-install-claim.js'

const INSTALLATION_ID = '018f5f8e-7f3d-7cc1-9c2b-52f7d83a6e41'

class FakePostgres implements PostgresClaimPool {
  hasObjects = false
  marker: string | undefined
  readonly statements: string[] = []

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    this.statements.push(text)
    if (text.includes('AS exists')) return { rows: [{ exists: this.marker !== undefined }] as Row[], rowCount: 1 }
    if (text.includes('AS has_user_objects')) {
      return { rows: [{ has_user_objects: this.hasObjects }] as Row[], rowCount: 1 }
    }
    if (text.startsWith('SELECT installation_id')) {
      const rows = this.marker ? [{ installation_id: this.marker }] : []
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (text.startsWith('INSERT INTO')) {
      if (this.marker !== undefined) throw new Error('duplicate marker')
      this.marker = String(values?.[0])
      this.hasObjects = true
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  async connect(): Promise<PostgresClaimClient> {
    return { query: this.query.bind(this), release: () => undefined }
  }

  async end(): Promise<void> {}
}

class FakeS3 implements S3ClaimClient {
  readonly commands: Array<{ name: string; input: Record<string, unknown> }> = []
  marker: string | undefined
  listResponses: Array<Record<string, unknown>> = [{ IsTruncated: false, Contents: [] }]
  versionResponse: Record<string, unknown> = { IsTruncated: false, Versions: [], DeleteMarkers: [] }
  failPut = false

  async send(command: unknown): Promise<unknown> {
    const typed = command as { constructor: { name: string }; input: Record<string, unknown> }
    this.commands.push({ name: typed.constructor.name, input: typed.input })
    if (typed.constructor.name === 'ListObjectsV2Command') return this.listResponses.shift() ?? { IsTruncated: false, Contents: [] }
    if (typed.constructor.name === 'ListObjectVersionsCommand') return this.versionResponse
    if (typed.constructor.name === 'PutObjectCommand') {
      if (this.failPut) throw new Error('conditional write failed')
      if (this.marker !== undefined) throw new Error('precondition failed')
      this.marker = String(typed.input.Body)
      return {}
    }
    if (typed.constructor.name === 'GetObjectCommand') {
      if (this.marker === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' })
      const marker = this.marker
      return { Body: { async *[Symbol.asyncIterator]() { yield Buffer.from(marker) } } }
    }
    throw new Error(`unexpected command ${typed.constructor.name}`)
  }
}

describe('fresh PG/S3 installation claim', () => {
  it('checks existing external identities without writing or repairing a missing, stale or unreadable claim', async () => {
    const database = new FakePostgres()
    const objectStore = new FakeS3()
    await expect(assertPostgresInstallationClaim(database, INSTALLATION_ID, 'Runtime PostgreSQL')).rejects.toThrow('missing or does not match')
    await expect(assertS3InstallationClaim(objectStore, 'bucket', INSTALLATION_ID)).rejects.toThrow('missing or does not match')
    database.marker = '123e4567-e89b-42d3-a456-426614174001'
    objectStore.marker = JSON.stringify({ format: 1, installationId: database.marker })
    await expect(assertPostgresInstallationClaim(database, INSTALLATION_ID, 'Runtime PostgreSQL')).rejects.toThrow('missing or does not match')
    await expect(assertS3InstallationClaim(objectStore, 'bucket', INSTALLATION_ID)).rejects.toThrow('missing or does not match')
    database.marker = INSTALLATION_ID
    objectStore.marker = JSON.stringify({ format: 1, installationId: INSTALLATION_ID })
    await expect(assertPostgresInstallationClaim(database, INSTALLATION_ID, 'Runtime PostgreSQL')).resolves.toBeUndefined()
    await expect(assertS3InstallationClaim(objectStore, 'bucket', INSTALLATION_ID)).resolves.toBeUndefined()
    expect(database.statements.every((sql) => sql.startsWith('SELECT'))).toBe(true)
    expect(objectStore.commands.every((command) => command.name === 'GetObjectCommand')).toBe(true)
    objectStore.marker = `${objectStore.marker}${' '.repeat(5_000)}`
    await expect(assertS3InstallationClaim(objectStore, 'bucket', INSTALLATION_ID)).rejects.toThrow('size limit')
  })
  it('claims two empty databases and the entire empty bucket with a fixed conditional marker', async () => {
    const controlDatabase = new FakePostgres()
    const runtimeDatabase = new FakePostgres()
    const objectStore = new FakeS3()

    await expect(claimFreshInstallation({
      installationId: INSTALLATION_ID,
      bucket: 'fresh-bucket',
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    })).resolves.toBe('claimed')

    expect(controlDatabase.marker).toBe(INSTALLATION_ID)
    expect(runtimeDatabase.marker).toBe(INSTALLATION_ID)
    expect(objectStore.commands).toContainEqual(expect.objectContaining({ name: 'ListObjectsV2Command', input: { Bucket: 'fresh-bucket', MaxKeys: 1 } }))
    expect(objectStore.commands).toContainEqual(expect.objectContaining({ name: 'ListObjectVersionsCommand', input: { Bucket: 'fresh-bucket', MaxKeys: 1 } }))
    expect(objectStore.commands.at(-1)).toMatchObject({
      name: 'PutObjectCommand',
      input: { Key: INSTALLATION_CLAIM_OBJECT_KEY, IfNoneMatch: '*' },
    })
  })

  it('rejects an existing control database object without mutating other authorities', async () => {
    const controlDatabase = new FakePostgres()
    const runtimeDatabase = new FakePostgres()
    const objectStore = new FakeS3()
    controlDatabase.hasObjects = true

    await expect(claimFreshInstallation({
      installationId: INSTALLATION_ID,
      bucket: 'fresh-bucket',
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    })).rejects.toThrow('control PostgreSQL is not empty')
    expect(runtimeDatabase.marker).toBeUndefined()
    expect(objectStore.commands.some((command) => command.name === 'PutObjectCommand')).toBe(false)
  })

  it('rejects any old object, including an object under the reserved marker prefix, before writing PG markers', async () => {
    const controlDatabase = new FakePostgres()
    const runtimeDatabase = new FakePostgres()
    const objectStore = new FakeS3()
    objectStore.listResponses = [{ IsTruncated: false, Contents: [{ Key: INSTALLATION_CLAIM_OBJECT_KEY }] }]

    await expect(claimFreshInstallation({
      installationId: INSTALLATION_ID,
      bucket: 'used-bucket',
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    })).rejects.toThrow('S3 bucket is not empty')
    expect(controlDatabase.marker).toBeUndefined()
    expect(runtimeDatabase.marker).toBeUndefined()
  })

  it('paginates fail-closed with MaxKeys 1 when an S3 implementation returns an empty truncated page', async () => {
    const objectStore = new FakeS3()
    objectStore.listResponses = [
      { IsTruncated: true, Contents: [], NextContinuationToken: 'next' },
      { IsTruncated: false, Contents: [] },
    ]

    await expect(assertBucketEmpty(objectStore, 'fresh-bucket')).resolves.toBeUndefined()
    expect(objectStore.commands).toHaveLength(3)
    expect(objectStore.commands[1]?.input).toMatchObject({ MaxKeys: 1, ContinuationToken: 'next' })
    expect(objectStore.commands[2]).toMatchObject({ name: 'ListObjectVersionsCommand', input: { Bucket: 'fresh-bucket', MaxKeys: 1 } })
  })

  it('rejects a bucket whose current view is empty but whose older object versions remain', async () => {
    const objectStore = new FakeS3()
    objectStore.versionResponse = { Versions: [{ Key: 'customer-object', VersionId: 'old' }] }
    await expect(assertBucketEmpty(objectStore, 'used-bucket')).rejects.toThrow('object versions or delete markers')
  })

  it('leaves partial PG markers in place and blocks an automatic retry when the S3 conditional claim fails', async () => {
    const controlDatabase = new FakePostgres()
    const runtimeDatabase = new FakePostgres()
    const objectStore = new FakeS3()
    objectStore.failPut = true
    const options = {
      installationId: INSTALLATION_ID,
      bucket: 'fresh-bucket',
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    }

    await expect(claimFreshInstallation(options)).rejects.toThrow('partial claims require operator intervention')
    expect(controlDatabase.marker).toBe(INSTALLATION_ID)
    expect(runtimeDatabase.marker).toBe(INSTALLATION_ID)
    await expect(claimFreshInstallation(options)).rejects.toThrow('different or incomplete installation claim')
    expect(objectStore.commands.filter((command) => command.name === 'PutObjectCommand')).toHaveLength(1)
  })

  it('retries only when all three external markers match the installation UUID', async () => {
    const controlDatabase = new FakePostgres()
    const runtimeDatabase = new FakePostgres()
    const objectStore = new FakeS3()
    controlDatabase.marker = INSTALLATION_ID
    runtimeDatabase.marker = INSTALLATION_ID
    objectStore.marker = `${JSON.stringify({ format: 1, installationId: INSTALLATION_ID })}\n`

    await expect(claimFreshInstallation({
      installationId: INSTALLATION_ID,
      bucket: 'claimed-bucket',
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    })).resolves.toBe('verified')

    runtimeDatabase.marker = '123e4567-e89b-42d3-a456-426614174001'
    await expect(claimFreshInstallation({
      installationId: INSTALLATION_ID,
      bucket: 'claimed-bucket',
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    })).rejects.toThrow('different or incomplete installation claim')
  })
})
