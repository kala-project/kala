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
    expect(migrations.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6])
    expect(migrations[1]?.name).toBe('0002_service_accounts_webhooks.sql')
    expect(migrations[2]?.name).toBe('0003_workspace_entitlement.sql')
    expect(migrations[5]?.name).toBe('0006_oidc_login_states.sql')
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
})

class FakeDatabase implements ControlPlaneDatabase, SqlExecutor {
  readonly executed: string[] = []
  transactionCount = 0
  constructor(readonly applied = new Map<number, string>()) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    const normalized = text.trim()
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS control_plane_schema_migrations')) return result([])
    if (normalized.startsWith('SELECT version, checksum')) return result([...this.applied].map(([version, checksum]) => ({ version, checksum })) as unknown as Row[])
    if (normalized.startsWith('INSERT INTO control_plane_schema_migrations')) {
      this.applied.set(Number(values?.[0]), String(values?.[2])); return result([])
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
