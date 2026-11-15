import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertControlPlaneSchema, migrateControlPlane, readControlPlaneMigrations, type ControlPlaneDatabase, type SqlExecutor, type SqlQueryResult } from './postgres.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('control-plane migrations', () => {
  it('keeps release migrations uniquely numbered so a fresh installation can start', async () => {
    const migrations = await readControlPlaneMigrations(join(import.meta.dirname, '../../migrations'))
    expect(migrations.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(migrations[1]?.name).toBe('0002_service_accounts_webhooks.sql')
    expect(migrations[2]?.name).toBe('0003_workspace_entitlement.sql')
    expect(migrations[5]?.name).toBe('0006_oidc_login_states.sql')
    expect(migrations[6]?.name).toBe('0007_dedicated_owner_credentials.sql')
  })

  it('loads ordered immutable migration files with checksums', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runlab-migrations-')); roots.push(root)
    await writeFile(join(root, '0002_second.sql'), 'SELECT 2;\n')
    await writeFile(join(root, '0001_first.sql'), 'SELECT 1;\n')
    await writeFile(join(root, 'README.md'), 'ignored')
    const migrations = await readControlPlaneMigrations(root)
    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: '0001_first.sql' },
      { version: 2, name: '0002_second.sql' },
    ])
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('applies missing migrations once inside the migration transaction', async () => {
    const database = new FakeDatabase()
    const migrations = [
      { version: 1, name: '0001_one.sql', checksum: 'a', sql: 'CREATE ONE' },
      { version: 2, name: '0002_two.sql', checksum: 'b', sql: 'CREATE TWO' },
    ]
    await expect(migrateControlPlane(database, migrations)).resolves.toBe(2)
    expect(database.applied).toEqual(new Map([[1, 'a'], [2, 'b']]))
    expect(database.transactionCount).toBe(1)
    await expect(migrateControlPlane(database, migrations)).resolves.toBe(2)
    expect(database.executed.filter((statement) => statement.startsWith('CREATE '))).toEqual(['CREATE ONE', 'CREATE TWO'])
  })

  it('rejects checksum drift for an applied migration', async () => {
    const database = new FakeDatabase(new Map([[1, 'old']]))
    await expect(migrateControlPlane(database, [{ version: 1, name: '0001_one.sql', checksum: 'new', sql: 'CREATE ONE' }]))
      .rejects.toThrow('checksum mismatch')
  })

  it('fails closed when the database schema version does not match the release migrations', async () => {
    const migrations = [
      { version: 1, name: '0001_one.sql', checksum: 'a', sql: 'CREATE ONE' },
      { version: 2, name: '0002_two.sql', checksum: 'b', sql: 'CREATE TWO' },
    ]
    await expect(assertControlPlaneSchema(new FakeDatabase(new Map([[1, 'a']])), migrations))
      .rejects.toThrow('schema version 1 is behind expected version 2')
    await expect(assertControlPlaneSchema(new FakeDatabase(new Map([[3, 'c']])), migrations))
      .rejects.toThrow('schema version 3 is ahead expected version 2')
    await expect(assertControlPlaneSchema(new FakeDatabase(new Map([[1, 'a'], [2, 'b']])), migrations))
      .resolves.toBe(2)
  })

  it('accepts only exact reviewed 12–17 bridge histories and rejects gaps, modified checksums and future versions', async () => {
    const migrations = await readControlPlaneMigrations(join(import.meta.dirname, '../../migrations'))
    for (const version of [12, 13, 14, 15, 16, 17]) {
      const applied = migrations.slice(0, version)
      const database = new FakeDatabase(new Map(applied.map(migration => [migration.version, migration.checksum])))
      for (const migration of applied) database.names.set(migration.version, migration.name)
      await expect(assertControlPlaneSchema(database, migrations)).resolves.toBe(version)
      database.names.set(1, 'renamed.sql')
      await expect(assertControlPlaneSchema(database, migrations)).rejects.toThrow('reviewed Settings bridge')
      await expect(migrateControlPlane(database, migrations)).rejects.toThrow('not a known release prefix')
      database.names.set(1, migrations[0]!.name)
      database.applied.set(1, 'changed')
      await expect(assertControlPlaneSchema(database, migrations)).rejects.toThrow('reviewed Settings bridge')
      database.applied.set(1, migrations[0]!.checksum)
      database.applied.delete(2)
      await expect(assertControlPlaneSchema(database, migrations)).rejects.toThrow('reviewed Settings bridge')
    }
    await expect(assertControlPlaneSchema(new FakeDatabase(new Map([[11, 'old']])), migrations)).rejects.toThrow('schema version 11')
    await expect(assertControlPlaneSchema(new FakeDatabase(new Map([[18, 'future']])), migrations)).rejects.toThrow('schema version 18')
  })
})

class FakeDatabase implements ControlPlaneDatabase, SqlExecutor {
  readonly executed: string[] = []
  transactionCount = 0
  readonly names = new Map<number, string>()
  constructor(readonly applied = new Map<number, string>()) {
    this.names.set(1, '0001_one.sql')
    this.names.set(2, '0002_two.sql')
  }
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    const normalized = text.trim()
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS control_plane_schema_migrations')) return result([])
    if (normalized.startsWith('SELECT version, checksum')) return result([...this.applied].map(([version, checksum]) => ({ version, checksum })) as unknown as Row[])
    if (normalized.startsWith('SELECT version, name, checksum')) return result([...this.applied].map(([version, checksum]) => ({ version, name: this.names.get(version), checksum })) as unknown as Row[])
    if (normalized.startsWith('INSERT INTO control_plane_schema_migrations')) {
      this.applied.set(Number(values?.[0]), String(values?.[2]))
      this.names.set(Number(values?.[0]), String(values?.[1]))
      return result([])
    }
    if (!normalized.startsWith('SET LOCAL') && !normalized.startsWith('SELECT pg_advisory')) this.executed.push(normalized)
    return result([])
  }
  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { this.transactionCount += 1; return operation(this) }
  async health() { return { ok: true as const, schemaVersion: Math.max(0, ...this.applied.keys()) } }
  async close() {}
}

function result<Row extends Record<string, unknown>>(rows: Row[]): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}
