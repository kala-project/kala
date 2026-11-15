import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { KalaStateStore } from './state-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'kala-state-store-'))
  roots.push(value)
  return value
}

describe('KalaStateStore', () => {
  it('persists memo revisions transactionally across store instances', () => {
    const directory = root()
    const first = new KalaStateStore(directory)
    const second = new KalaStateStore(directory)
    expect(first.writeMemo('owner', { content: 'one', expectedRevision: 0 }).revision).toBe(1)
    expect(() => second.writeMemo('owner', { content: 'stale', expectedRevision: 0 })).toThrow('memo_revision_conflict')
    expect(second.readMemo('owner')).toMatchObject({ content: 'one', revision: 1 })
    first.close()
    second.close()
  })

  it('encrypts credentials with an external key and fails closed after tampering', () => {
    const directory = root()
    const keyPath = join(directory, 'keys', 'master.key')
    const state = new KalaStateStore(join(directory, 'state'), { keyPath })
    state.setCredential('serper', 'secret-value', { provider: 'serper' })
    expect(readFileSync(join(directory, 'state', 'state.sqlite')).toString('utf8')).not.toContain('secret-value')
    expect(readFileSync(keyPath)).toHaveLength(32)
    expect(state.getCredential('serper')?.secret).toBe('secret-value')
    state.close()

    const database = new DatabaseSync(join(directory, 'state', 'state.sqlite'))
    database.prepare("UPDATE credentials SET auth_tag = ? WHERE provider = 'serper'").run(Buffer.alloc(16))
    database.close()
    expect(() => new KalaStateStore(join(directory, 'state'), { keyPath }).getCredential('serper')).toThrow()
  })

  it('lazily imports legacy memos without deleting rollback data', () => {
    const directory = root()
    const memos = join(directory, 'memos')
    mkdirSync(memos)
    const owner = 'principal:memo'
    const name = createHash('sha256').update(owner).digest('hex')
    writeFileSync(join(memos, `${name}.json`), JSON.stringify({ content: 'legacy', revision: 7, updatedAt: '2026-09-29T00:00:00.000Z' }))
    const state = new KalaStateStore(directory, { legacyMemoDirectory: memos })
    expect(state.readMemo(owner)).toEqual({ content: 'legacy', revision: 7, updatedAt: '2026-09-29T00:00:00.000Z' })
    expect(readFileSync(join(memos, `${name}.json`), 'utf8')).toContain('legacy')
  })

  it('imports legacy encrypted Search credentials once', () => {
    const directory = root()
    const credentials = join(directory, 'credentials')
    mkdirSync(credentials)
    const legacyKey = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv)
    cipher.setAAD(Buffer.from('agent-runlab:web-search-credential:v1:serper'))
    const ciphertext = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()])
    writeFileSync(join(credentials, 'master.key'), legacyKey)
    writeFileSync(join(credentials, 'web-search.json'), JSON.stringify({
      version: 1,
      provider: 'serper',
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      updatedAt: '2026-09-29T00:00:00.000Z',
    }))
    const state = new KalaStateStore(directory, { legacyCredentialDirectory: credentials })
    expect(state.getCredential('serper')?.secret).toBe('legacy-secret')
    writeFileSync(join(credentials, 'web-search.json'), '{broken')
    expect(state.getCredential('serper')?.secret).toBe('legacy-secret')
    expect(state.credentialConfiguration('serper').revision).toBe('1')
    state.deleteCredential('serper', { expectedRevision: '1' })
    expect(state.credentialConfiguration('serper')).toEqual({ revision: '2', value: undefined })
    expect(state.getCredential('serper')).toBeUndefined()
  })

  it('commits ciphertext and resource revisions together and retains deletion tombstones across reopen', () => {
    const directory = root()
    const state = new KalaStateStore(directory)
    expect(state.credentialConfiguration('serper')).toEqual({ revision: '1', value: undefined })
    state.setCredential('serper', 'first-secret', {}, undefined, { expectedRevision: '1' })
    const inspect = new DatabaseSync(join(directory, 'state.sqlite'))
    inspect.exec(`CREATE TRIGGER reject_revision BEFORE UPDATE ON settings_resource_versions
      BEGIN SELECT RAISE(ABORT, 'fixture_revision_failure'); END`)
    expect(() => state.setCredential('serper', 'must-roll-back', {}, undefined, { expectedRevision: '2' })).toThrow('fixture_revision_failure')
    expect(state.credentialConfiguration('serper')).toMatchObject({ revision: '2', value: { secret: 'first-secret' } })
    inspect.exec('DROP TRIGGER reject_revision')
    expect(() => state.deleteCredential('serper', { expectedRevision: '1' })).toThrow('configuration_conflict')
    expect(() => state.deleteCredential('serper', { writeProtocol: 'conditional-required' })).toThrow('client_upgrade_required')
    state.deleteCredential('serper', { expectedRevision: '2' })
    state.close()
    const reopened = new KalaStateStore(directory)
    expect(reopened.credentialConfiguration('serper')).toEqual({ revision: '3', value: undefined })
    reopened.setCredential('serper', 'recreated', {}, undefined, { expectedRevision: '3' })
    expect(reopened.credentialConfiguration('serper')).toMatchObject({ revision: '4', value: { secret: 'recreated' } })
    reopened.close()
    expect(readFileSync(join(directory, 'state.sqlite')).includes(Buffer.from('first-secret'))).toBe(false)
    inspect.close()
  })

  it('migrates schema4 without rewriting credentials, accepts post-upgrade writes and rejects unreviewed histories', () => {
    const directory = root()
    const state = new KalaStateStore(directory)
    state.setCredential('azure_speech', 'existing-key', { enabled: true })
    state.close()
    const before = new DatabaseSync(join(directory, 'state.sqlite'))
    const ciphertext = before.prepare("SELECT hex(ciphertext) AS value FROM credentials WHERE provider = 'azure_speech'").get()
    before.exec('DROP TABLE settings_resource_versions; DROP TABLE settings_schema_migrations; PRAGMA user_version = 4')
    before.close()
    const upgraded = new KalaStateStore(directory)
    expect(upgraded.credentialConfiguration('azure_speech')).toMatchObject({ revision: '1', value: { secret: 'existing-key' } })
    const check = new DatabaseSync(join(directory, 'state.sqlite'))
    expect(check.prepare("SELECT hex(ciphertext) AS value FROM credentials WHERE provider = 'azure_speech'").get()).toEqual(ciphertext)
    upgraded.setCredential('azure_speech', 'new-key', {}, undefined, { expectedRevision: '1' })
    upgraded.close()
    const rollbackWriter = new KalaStateStore(directory)
    expect(rollbackWriter.credentialConfiguration('azure_speech')).toMatchObject({ revision: '2', value: { secret: 'new-key' } })
    rollbackWriter.setCredential('azure_speech', 'compatibility-write', {})
    expect(rollbackWriter.credentialConfiguration('azure_speech').revision).toBe('3')
    rollbackWriter.close()
    check.prepare("UPDATE settings_schema_migrations SET checksum = 'altered' WHERE version = 5").run()
    expect(() => new KalaStateStore(directory).dagStore()).toThrow('state_settings_migration_history_mismatch')
    check.exec('PRAGMA user_version = 6')
    expect(() => new KalaStateStore(directory).dagStore()).toThrow('unsupported state database version: 6')
    check.close()
  })

  it('backfills each legacy graph version with a result node present in that snapshot', () => {
    const directory = root()
    const state = new KalaStateStore(directory)
    state.dagStore()
    state.close()

    const database = new DatabaseSync(join(directory, 'state.sqlite'))
    const timestamp = '2026-09-30T00:00:00.000Z'
    database.prepare(`
      INSERT INTO dag_runs (
        id, parent_session_id, objective, status, graph_version,
        result_node_id, result, error, completed_at, created_at, updated_at
      ) VALUES ('run', 'session', 'objective', 'completed', 2, NULL, NULL, NULL, NULL, ?, ?)
    `).run(timestamp, timestamp)
    const insertNode = database.prepare(`
      INSERT INTO dag_nodes (
        id, run_id, title, instructions, status, depth, write_scopes,
        estimated_duration_minutes, attempt, child_session_id, progress, result,
        error, replaced_by, started_at, completed_at, tool_activity
      ) VALUES (?, 'run', ?, 'instructions', ?, 0, '[]', NULL, 1, NULL, NULL, ?, NULL, ?, ?, ?, '[]')
    `)
    insertNode.run('target', 'target', 'replaced', 'old result', 'part-a', timestamp, timestamp)
    insertNode.run('part-a', 'part-a', 'succeeded', 'part result', null, timestamp, timestamp)
    insertNode.run('part-b', 'part-b', 'succeeded', 'final result', null, timestamp, timestamp)
    database.prepare("INSERT INTO dag_edges (id, run_id, source, target) VALUES ('edge', 'run', 'part-a', 'part-b')").run()
    const insertVersion = database.prepare(`
      INSERT INTO dag_graph_versions (run_id, version, result_node_id, nodes, edges, created_at)
      VALUES ('run', ?, NULL, ?, ?, ?)
    `)
    insertVersion.run(1, JSON.stringify([{ id: 'target' }]), '[]', timestamp)
    insertVersion.run(2, JSON.stringify([{ id: 'part-a' }, { id: 'part-b' }]), JSON.stringify([{ source: 'part-a', target: 'part-b' }]), timestamp)
    database.exec('DROP TABLE settings_resource_versions; DROP TABLE settings_schema_migrations; PRAGMA user_version = 3')
    database.close()

    const migrated = new KalaStateStore(directory)
    migrated.dagStore()
    migrated.close()
    const verified = new DatabaseSync(join(directory, 'state.sqlite'))
    expect(verified.prepare('SELECT version, result_node_id FROM dag_graph_versions ORDER BY version').all()).toEqual([
      { version: 1, result_node_id: 'target' },
      { version: 2, result_node_id: 'part-b' },
    ])
    expect(verified.prepare("SELECT result_node_id, result FROM dag_runs WHERE id = 'run'").get()).toEqual({
      result_node_id: 'part-b',
      result: 'final result',
    })
    verified.close()
  })
})
