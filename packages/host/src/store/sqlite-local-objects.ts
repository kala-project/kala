import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export type LocalObjectDescriptor = {
  sha256: string
  bytes: number
  path: string
}

export type LocalObjectExpectation = {
  sha256: string
  bytes: number
}

/**
 * Immutable content-addressed bytes shared by fresh Portable SQLite stores.
 *
 * Publication writes and fsyncs a private staging file before atomically
 * linking it into the hash namespace. Staging files left by a crash are not
 * authoritative. There is deliberately no deletion API: references in more
 * than one SQLite-backed store can share a hash, so reclamation must be
 * coordinated across every reference table by a future GC pass.
 */
export class SqliteLocalObjects {
  readonly contentRoot: string

  constructor(readonly stateRoot: string) {
    this.contentRoot = resolve(stateRoot, 'objects', 'content')
  }

  pathForHash(sha256: string): string {
    validateSha256(sha256)
    const path = resolve(this.contentRoot, sha256.slice(0, 2), sha256)
    if (!isPathWithin(this.contentRoot, path)) throw new Error('Invalid local object path')
    return path
  }

  async write(data: Buffer): Promise<LocalObjectDescriptor> {
    const sha256 = createHash('sha256').update(data).digest('hex')
    const path = this.pathForHash(sha256)
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })

    const stagingPath = resolve(directory, `.${sha256}.stage-${process.pid}-${randomUUID()}`)
    if (!isPathWithin(directory, stagingPath)) throw new Error('Invalid local object staging path')
    const staging = await open(stagingPath, 'wx', 0o600)
    try {
      await staging.writeFile(data)
      await staging.sync()
    } finally {
      await staging.close()
    }

    try {
      await link(stagingPath, path)
      await syncDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await this.read({ sha256, bytes: data.length })
    } finally {
      await rm(stagingPath, { force: true })
    }

    return { sha256, bytes: data.length, path }
  }

  async read(expectation: LocalObjectExpectation): Promise<Buffer> {
    validateExpectation(expectation)
    const data = await readFile(this.pathForHash(expectation.sha256)).catch((error) => {
      throw new Error(`Local object ${expectation.sha256} bytes are unavailable: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (data.length !== expectation.bytes || createHash('sha256').update(data).digest('hex') !== expectation.sha256) {
      throw new Error(`Local object ${expectation.sha256} failed integrity validation`)
    }
    return data
  }

  async check(expectation: LocalObjectExpectation): Promise<void> {
    await this.read(expectation)
  }
}

/**
 * Deletion intents commit with reference removal, never with byte removal.
 * A collector must check BOTH reference tables and concurrent uploads before
 * unlinking; recording an intent here is not permission to unlink.
 */
export function installLocalObjectDeletionIntents(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS portable_object_delete_intents (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    requested_at TEXT NOT NULL
  )`)
}

export function requestLocalObjectDeletion(database: DatabaseSync, hashes: readonly string[]): void {
  const statement = database.prepare(`INSERT INTO portable_object_delete_intents (sha256, requested_at)
    VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING`)
  const requestedAt = new Date().toISOString()
  for (const hash of new Set(hashes)) {
    validateSha256(hash)
    statement.run(hash, requestedAt)
  }
}

export function protectLocalObjectReference(database: DatabaseSync, sha256: string): void {
  validateSha256(sha256)
  database.prepare('DELETE FROM portable_object_delete_intents WHERE sha256 = ?').run(sha256)
}

export function validateSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid local object content hash')
}

function validateExpectation(expectation: LocalObjectExpectation): void {
  validateSha256(expectation.sha256)
  if (!Number.isSafeInteger(expectation.bytes) || expectation.bytes < 0) {
    throw new Error('Invalid local object byte count')
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
