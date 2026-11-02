import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { nativeFsLimitsFromEnv } from '../store/native-session-fs.js'
import { createConfig } from '@agent-kernel/kernel'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store/session.js'
import { SqliteSessionAuthority } from '../store/sqlite-session-authority.js'

describe('authority-backed native Copilot SessionFs', () => {
  it('appends beyond the old snapshot cap without touching historical chunks or Session audit rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-native-chunk-scale-'))
    const databasePath = join(root, 'state.sqlite')
    const maxSessionBytes = 256 * 1024 * 1024
    const authority = new SqliteSessionAuthority(databasePath, { nativeFsLimits: { maxSessionBytes } })
    let db: DatabaseSync | undefined
    try {
      const store = new SessionStore(join(root, 'sessions'), { authority })
      await store.create({ sessionId: 'large-native', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
      const fs = store.copilotSessionFs('large-native')
      const large = 'x'.repeat(20 * 1024 * 1024)
      await fs.writeFile('/session-state/files/large.txt', large)
      db = new DatabaseSync(databasePath)
      const chunkCount = Number(db.prepare('SELECT count(*) AS n FROM portable_native_fs_chunks').get()!.n)
      expect(chunkCount).toBeGreaterThan(1)
      expect(Number(db.prepare('SELECT count(*) AS n FROM portable_session_events').get()!.n)).toBe(1)
      db.exec(`CREATE TRIGGER reject_native_history_update BEFORE UPDATE ON portable_native_fs_chunks BEGIN SELECT RAISE(ABORT, 'append rewrote native history'); END;
        CREATE TRIGGER reject_native_history_delete BEFORE DELETE ON portable_native_fs_chunks BEGIN SELECT RAISE(ABORT, 'append removed native history'); END;`)
      await fs.appendFile('/session-state/files/large.txt', '🙂final')
      expect(Number(db.prepare('SELECT count(*) AS n FROM portable_native_fs_chunks').get()!.n)).toBe(chunkCount + 1)
      expect(await fs.readFile('/session-state/files/large.txt')).toBe(large + '🙂final')
      expect(Number(db.prepare('SELECT count(*) AS n FROM portable_session_events').get()!.n)).toBe(1)
      expect(JSON.stringify(await authority.load('large-native'))).not.toContain('__kalaCopilotSessionFs')
      db.exec('DROP TRIGGER reject_native_history_update; DROP TRIGGER reject_native_history_delete;')
      const bytesBefore = Number(db.prepare('SELECT total_bytes FROM portable_native_fs_usage').get()!.total_bytes)
      db.prepare('UPDATE portable_native_fs_usage SET total_bytes = ?').run(maxSessionBytes)
      await expect(fs.appendFile('/session-state/files/large.txt', 'over quota')).rejects.toThrow('quota exceeded')
      expect(Number(db.prepare('SELECT count(*) AS n FROM portable_native_fs_chunks').get()!.n)).toBe(chunkCount + 1)
      db.prepare('UPDATE portable_native_fs_usage SET total_bytes = ?').run(bytesBefore)
      await expect(fs.writeFile('/session-state/files/\ud800', 'alias')).rejects.toThrow('Invalid SDK session filesystem path')
      await fs.writeFile('/session-state/files/emoji.txt', '🙂'.repeat(20_000))
      expect(await fs.readFile('/session-state/files/emoji.txt')).toBe('🙂'.repeat(20_000))
      await fs.rename('/session-state/files/large.txt', '/session-state/files/renamed.txt')
      expect((await fs.stat('/session-state/files/renamed.txt')).size).toBe(bytesBefore)
      db.exec(`UPDATE portable_native_fs_chunks SET content = 'corrupted' WHERE path = '/session-state/files/emoji.txt' AND chunk_no = 0`)
      await expect(fs.readFile('/session-state/files/emoji.txt')).rejects.toThrow('integrity validation')
      await store.requestDeletion('large-native')
      await expect(fs.readFile('/session-state/files/renamed.txt')).rejects.toThrow()
      await authority.delete('large-native')
      expect(Number(db.prepare('SELECT count(*) AS n FROM portable_native_fs_chunks').get()!.n)).toBe(0)
      expect(Number(db.prepare('SELECT count(*) AS n FROM portable_native_fs_usage').get()!.n)).toBe(0)
    } finally {
      db?.close()
      await authority.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults to unlimited file and Session bytes beyond the former hard-coded caps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-native-unlimited-'))
    const authority = new SqliteSessionAuthority(join(root, 'state.sqlite'))
    try {
      await authority.initialize()
      await authority.create({ sessionId: 'unlimited', state: { cursor: 0 } })
      const fs = authority.nativeSessionFs('unlimited')
      const text = 'x'.repeat(129 * 1024 * 1024)
      await fs.writeFile('/first.txt', text)
      await fs.writeFile('/second.txt', text)
      expect((await fs.stat('/first.txt')).size).toBe(text.length)
      expect((await fs.stat('/second.txt')).size).toBe(text.length)
      expect(await fs.readFile('/first.txt')).toBe(text)
    } finally {
      await authority.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('enforces configured byte/node quotas atomically without preventing reads or reductions after lowering them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-native-admin-limits-'))
    const databasePath = join(root, 'state.sqlite')
    const authority = new SqliteSessionAuthority(databasePath, {
      nativeFsLimits: { maxSessionBytes: 8, maxFileBytes: 6, maxNodes: 2 },
    })
    let reduced: SqliteSessionAuthority | undefined
    try {
      await authority.initialize()
      await authority.create({ sessionId: 'limited', state: { cursor: 0 } })
      const fs = authority.nativeSessionFs('limited')
      await fs.writeFile('/first', '🙂ab')
      await expect(fs.appendFile('/first', 'c')).rejects.toThrow('file storage quota')
      expect(await fs.readFile('/first')).toBe('🙂ab')
      await fs.writeFile('/second', 'xy')
      await expect(fs.appendFile('/second', 'z')).rejects.toThrow('session storage quota')
      await expect(fs.mkdir('/third', false)).rejects.toThrow('session storage quota')
      expect(await fs.readdir('/')).toEqual(['first', 'second'])
      reduced = new SqliteSessionAuthority(databasePath, {
        nativeFsLimits: { maxSessionBytes: 1, maxFileBytes: 1, maxNodes: 1 },
      })
      await reduced.initialize()
      const limited = reduced.nativeSessionFs('limited')
      expect(await limited.readFile('/first')).toBe('🙂ab')
      await limited.writeFile('/first', 'ab')
      await limited.rm('/second', false, false)
      await limited.writeFile('/first', 'a')
      expect(await limited.readFile('/first')).toBe('a')
      await expect(limited.appendFile('/first', 'b')).rejects.toThrow('file storage quota')
    } finally {
      await reduced?.close()
      await authority.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed operator configuration instead of silently treating it as unlimited', () => {
    for (const value of ['-1', '1.5', 'Infinity', 'wat', '', '9007199254740992']) {
      expect(() => nativeFsLimitsFromEnv({ KALA_NATIVE_FS_MAX_SESSION_BYTES: value })).toThrow('KALA_NATIVE_FS_MAX_SESSION_BYTES')
    }
    expect(nativeFsLimitsFromEnv({ KALA_NATIVE_FS_MAX_SESSION_BYTES: '0', KALA_NATIVE_FS_MAX_FILE_BYTES: '16' }))
      .toEqual({ maxSessionBytes: 0, maxFileBytes: 16, maxNodes: undefined })
    expect(() => new SqliteSessionAuthority(':memory:', { nativeFsLimits: { maxNodes: -1 } })).toThrow('maxNodes')
  })

  it('does not silently import a previous experimental V1 tree into native chunk authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-native-v1-preserve-'))
    const authority = new SqliteSessionAuthority(join(root, 'state.sqlite'))
    try {
      await authority.initialize()
      await authority.create({ sessionId: 'v1', state: { cursor: 0 }, __kalaCopilotSessionFsV1: { '/session-state/events.jsonl': { content: 'old' } } })
      const fs = authority.nativeSessionFs('v1')
      await expect(fs.writeFile('/session-state/events.jsonl', 'replacement')).rejects.toThrow('automatic migration is not supported')
      expect((await authority.load('v1'))?.__kalaCopilotSessionFsV1).toEqual({ '/session-state/events.jsonl': { content: 'old' } })
    } finally {
      await authority.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers native events independently of local SDK files; serializes appends and fences deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-native-session-fs-'))
    const databasePath = join(root, 'state.sqlite')
    const store = new SessionStore(join(root, 'sessions'), { authority: new SqliteSessionAuthority(databasePath) })
    await store.initialize()
    await store.create({ sessionId: 'native-state', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    const fs = store.copilotSessionFs('native-state')
    await fs.writeFile('/session-state/events.jsonl', '{"type":"session.start"}\n')
    await Promise.all(Array.from({ length: 8 }, (_, i) => fs.appendFile('/session-state/events.jsonl', `${i}\n`)))
    const secondStore = new SessionStore(join(root, 'different-node-scratch'), { authority: new SqliteSessionAuthority(databasePath) })
    await secondStore.initialize()
    const recovered = secondStore.copilotSessionFs('native-state')
    expect((await recovered.readFile('/session-state/events.jsonl')).split('\n').filter(Boolean)).toHaveLength(9)
    expect(await recovered.readdirWithTypes('/session-state')).toEqual([{ name: 'events.jsonl', type: 'file' }])
    await recovered.rename('/session-state/events.jsonl', '/session-state/journal.jsonl')
    expect(await recovered.exists('/session-state/events.jsonl')).toBe(false)
    expect((await recovered.stat('/session-state/journal.jsonl')).isFile).toBe(true)
    expect((await secondStore.load('native-state')).state.cursor).toBe(0)
    await expect(recovered.readFile('/session-state/../../etc/passwd')).rejects.toThrow('Invalid SDK')
    await expect(recovered.readFile('/etc/passwd')).rejects.toThrow('does not exist')
    await expect(recovered.rm('/session-state', false, false)).rejects.toThrow('not empty')
    await secondStore.requestDeletion('native-state')
    await expect(recovered.appendFile('/session-state/journal.jsonl', 'late')).rejects.toThrow()
    await expect(recovered.readFile('/session-state/journal.jsonl')).rejects.toThrow()
  })
})
