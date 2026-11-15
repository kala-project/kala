import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const statements = `CREATE TABLE settings_resource_versions (
  organization_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, resource_kind, resource_id)
)`

export const SQLITE_SETTINGS_MIGRATION = Object.freeze({
  version: 5,
  name: 'settings_resource_versions',
  checksum: createHash('sha256').update(statements).digest('hex'),
})

export function migrateSqliteSettings(database: DatabaseSync, existingVersion: number): void {
  if (existingVersion === 5) {
    const row = database.prepare('SELECT name, checksum FROM settings_schema_migrations WHERE version = 5').get() as
      { name: string; checksum: string } | undefined
    const count = database.prepare('SELECT COUNT(*) AS count FROM settings_schema_migrations').get() as { count: number }
    if (count.count !== 1 || row?.name !== SQLITE_SETTINGS_MIGRATION.name || row.checksum !== SQLITE_SETTINGS_MIGRATION.checksum) {
      throw new Error('state_settings_migration_history_mismatch')
    }
    return
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(statements)
    database.exec(`CREATE TABLE settings_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL
    )`)
    database.prepare('INSERT INTO settings_schema_migrations (version, name, checksum) VALUES (5, ?, ?)')
      .run(SQLITE_SETTINGS_MIGRATION.name, SQLITE_SETTINGS_MIGRATION.checksum)
    database.exec('PRAGMA user_version = 5; COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
