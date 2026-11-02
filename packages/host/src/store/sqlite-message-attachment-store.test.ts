import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'

import { SqliteSessionAuthority } from './sqlite-session-authority.js'
import { SqliteLocalObjects } from './sqlite-local-objects.js'
import { SqliteMessageAttachmentStore } from './sqlite-message-attachment-store.js'
import { SqliteSessionArtifactStore } from './sqlite-session-artifact-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kala-portable-objects-'))
  roots.push(root)
  const authority = new SqliteSessionAuthority(join(root, 'state.sqlite'))
  await authority.initialize()
  const db = new DatabaseSync(join(root, 'state.sqlite'))
  for (const id of ['session-a', 'session-b']) {
    db.prepare(`INSERT INTO portable_sessions (session_id, version, document, deleting, updated_at)
      VALUES (?, 1, '{}', 0, ?)`).run(id, new Date().toISOString())
  }
  const objects = new SqliteLocalObjects(root)
  const attachments = new SqliteMessageAttachmentStore(root, { objects })
  const artifacts = new SqliteSessionArtifactStore(root, { objects })
  await Promise.all([attachments.load(), artifacts.load()])
  return { root, authority, db, objects, attachments, artifacts }
}

it('protects attachment references and CAS bytes across restart without a JSON registry', async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.from('portable attachment')
    const ref = await f.attachments.register({ sessionId: 'session-a', name: '../report.txt', data: bytes })
    expect(ref.name).toBe('report.txt')
    await f.attachments.commitReferences('session-a', [ref])
    const id = ref.source.attachmentId
    const path = f.objects.pathForHash(ref.source.sha256)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(f.root, 'message-attachments', 'registry.json'))).toBe(false)
    await f.attachments.close()
    const reopened = new SqliteMessageAttachmentStore(f.root)
    await reopened.load()
    try {
      expect(await reopened.resolveById('session-a', id).read()).toEqual(bytes)
      expect(reopened.allowsSdkRead('session-a', path)).toBe(true)
      expect(() => reopened.resolveById('session-b', id)).toThrow('does not belong')
      await reopened.deleteSession('session-a')
      expect(() => reopened.resolveById('session-a', id)).toThrow('unavailable')
      expect(existsSync(path)).toBe(true) // reclaim only after cross-store reference reconciliation
    } finally { await reopened.close() }
  } finally {
    await f.artifacts.close(); await f.authority.close(); f.db.close()
  }
})

it('fences registration on deletion and preserves shared CAS bytes for surviving artifact references', async () => {
  const f = await fixture()
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1])
    const attachment = await f.attachments.register({ sessionId: 'session-a', name: 'image.png', data: png })
    const artifact = await f.artifacts.registerImage({ sessionId: 'session-b', fileName: 'image.png', data: png })
    expect(artifact.sha256).toBe(attachment.source.sha256)
    const path = f.objects.pathForHash(artifact.sha256)
    await f.attachments.releasePending('session-a', [attachment.source.attachmentId])
    expect(f.db.prepare('SELECT sha256 FROM portable_object_delete_intents WHERE sha256 = ?').get(artifact.sha256)).toBeDefined()
    expect(await (await f.artifacts.get('session-b', artifact.artifactId))?.read()).toEqual(png)
    await f.attachments.register({ sessionId: 'session-b', name: 'image.png', data: png })
    expect(f.db.prepare('SELECT sha256 FROM portable_object_delete_intents WHERE sha256 = ?').get(artifact.sha256)).toBeUndefined()
    expect(existsSync(path)).toBe(true)
    f.db.prepare('UPDATE portable_sessions SET deleting = 1 WHERE session_id = ?').run('session-a')
    await expect(f.attachments.register({ sessionId: 'session-a', name: 'late.txt', data: png })).rejects.toThrow('deleting')
    writeFileSync(path, Buffer.from('corrupt'))
    await expect(f.artifacts.get('session-b', artifact.artifactId)).rejects.toThrow('integrity')
  } finally {
    await f.artifacts.close(); await f.attachments.close(); await f.authority.close(); f.db.close()
  }
})

it('rejects a forged reference without committing another Session attachment', async () => {
  const f = await fixture()
  try {
    const ref = await f.attachments.register({ sessionId: 'session-a', name: 'data.txt', data: Buffer.from(randomUUID()) })
    await expect(f.attachments.commitReferences('session-b', [ref])).rejects.toThrow('does not belong')
    const row = f.db.prepare('SELECT committed_at FROM portable_message_attachments WHERE attachment_id = ?')
      .get(ref.source.attachmentId) as { committed_at: string | null }
    expect(row.committed_at).toBeNull()
  } finally {
    await f.artifacts.close(); await f.attachments.close(); await f.authority.close(); f.db.close()
  }
})
