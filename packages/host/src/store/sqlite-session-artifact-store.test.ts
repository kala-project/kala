import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { MAX_IMAGE_BYTES } from '../session-artifact-registry.js'
import { SqliteLocalObjects } from './sqlite-local-objects.js'
import { SqliteSessionArtifactStore } from './sqlite-session-artifact-store.js'
import { SqliteSessionAuthority } from './sqlite-session-authority.js'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const gif = Buffer.from('GIF89a-portable-artifact', 'ascii')

describe('SqliteLocalObjects', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('race-safely publishes fsynced content under only its SHA-256 path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-local-objects-'))
    roots.push(root)
    const objects = new SqliteLocalObjects(root)
    const [first, second] = await Promise.all([objects.write(png), objects.write(png)])
    const sha256 = createHash('sha256').update(png).digest('hex')

    expect(first).toEqual(second)
    expect(first.path).toBe(join(root, 'objects', 'content', sha256.slice(0, 2), sha256))
    await expect(objects.read(first)).resolves.toEqual(png)
    expect(() => objects.pathForHash('../../outside')).toThrow('Invalid local object content hash')
  })
})

describe('SqliteSessionArtifactStore', () => {
  const roots: string[] = []
  const authorities: SqliteSessionAuthority[] = []
  const stores: SqliteSessionArtifactStore[] = []

  afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => await store.close()))
    await Promise.all(authorities.splice(0).map(async (authority) => await authority.close()))
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function fixture(sessionIds: readonly string[] = ['session-a']): Promise<{
    root: string
    databasePath: string
    authority: SqliteSessionAuthority
    store: SqliteSessionArtifactStore
  }> {
    const root = mkdtempSync(join(tmpdir(), 'kala-sqlite-artifacts-'))
    roots.push(root)
    const databasePath = join(root, 'state.sqlite')
    const authority = new SqliteSessionAuthority(databasePath)
    authorities.push(authority)
    await authority.initialize()
    for (const sessionId of sessionIds) {
      await authority.create({ sessionId, state: { cursor: 0 }, config: {} })
    }
    const store = new SqliteSessionArtifactStore(root)
    stores.push(store)
    await store.load()
    return { root, databasePath, authority, store }
  }

  it('persists authorized metadata and verified bytes across reopen without using user paths', async () => {
    const { root, databasePath, store } = await fixture(['session-a', 'session-b'])
    const record = await store.registerImage({
      sessionId: 'session-a',
      fileName: '../../untrusted/image.png',
      data: png,
    })

    expect(record.title).toBe('image.png')
    expect(record.fileName).toMatch(/^[a-f0-9-]+\.png$/u)
    expect(record.fileName).not.toContain('untrusted')
    const objectPath = store.objects.pathForHash(record.sha256)
    expect(objectPath).toBe(join(root, 'objects', 'content', record.sha256.slice(0, 2), record.sha256))
    expect(existsSync(join(root, 'registry.json'))).toBe(false)
    await expect((await store.get('session-a', record.artifactId))?.read()).resolves.toEqual(png)
    await expect(store.get('session-b', record.artifactId)).resolves.toBeUndefined()

    await store.close()
    const reopened = new SqliteSessionArtifactStore(root)
    stores.push(reopened)
    await reopened.load()
    await expect((await reopened.get('session-a', record.artifactId))?.read()).resolves.toEqual(png)

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare(`
      SELECT sha256, bytes FROM portable_session_artifacts WHERE artifact_id = ?
    `).get(record.artifactId) as { sha256: string; bytes: number })).toEqual({
      sha256: record.sha256,
      bytes: png.length,
    })
    database.close()
  })

  it('checks live Session admission in the reference transaction', async () => {
    const { databasePath, authority, store } = await fixture()

    await expect(store.registerImage({ sessionId: 'missing', fileName: 'missing.gif', data: gif }))
      .rejects.toThrow('Session is unavailable or deleting')
    await authority.requestDeletion('session-a', 'delete-session-a')
    await expect(store.registerImage({ sessionId: 'session-a', fileName: 'late.gif', data: gif }))
      .rejects.toThrow('Session is unavailable or deleting')

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare('SELECT COUNT(*) AS count FROM portable_session_artifacts').get() as { count: number }).count).toBe(0)
    database.close()
    const hash = createHash('sha256').update(gif).digest('hex')
    expect(existsSync(store.objects.pathForHash(hash))).toBe(true)
  })

  it('detects missing or modified protected bytes before returning an artifact', async () => {
    const { store } = await fixture()
    const record = await store.registerImage({ sessionId: 'session-a', fileName: 'image.png', data: png })
    writeFileSync(store.objects.pathForHash(record.sha256), Buffer.from('tampered'))

    await expect(store.get('session-a', record.artifactId)).rejects.toThrow('failed integrity validation')
  })

  it('deletes only Session references and conservatively retains shared CAS bytes', async () => {
    const { databasePath, store } = await fixture(['session-a', 'session-b'])
    const first = await store.registerImage({ sessionId: 'session-a', fileName: 'one.png', data: png })
    const second = await store.registerImage({ sessionId: 'session-b', fileName: 'two.png', data: png })
    expect(second.sha256).toBe(first.sha256)

    await store.deleteSession('session-a')
    await expect(store.get('session-a', first.artifactId)).resolves.toBeUndefined()
    await expect((await store.get('session-b', second.artifactId))?.read()).resolves.toEqual(png)

    await store.deleteSession('session-b')
    expect(existsSync(store.objects.pathForHash(first.sha256))).toBe(true)
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare('SELECT COUNT(*) AS count FROM portable_session_artifacts').get() as { count: number }).count).toBe(0)
    database.close()
  })

  it('keeps image MIME and size validation ahead of metadata insertion', async () => {
    const { databasePath, store } = await fixture()
    await expect(store.registerImage({ sessionId: 'session-a', fileName: 'note.txt', data: Buffer.from('not an image') }))
      .rejects.toThrow('unsupported image type')
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    png.copy(oversized)
    await expect(store.registerImage({ sessionId: 'session-a', fileName: 'too-large.png', data: oversized }))
      .rejects.toThrow(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`)

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare('SELECT COUNT(*) AS count FROM portable_session_artifacts').get() as { count: number }).count).toBe(0)
    database.close()
    expect(basename(store.objects.contentRoot)).toBe('content')
  })
})
