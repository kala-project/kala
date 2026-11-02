import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import pg from 'pg'

import { tracePostgresQuery, type OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'

const { Pool } = pg

export type SqlQueryResult<Row extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<Row>

export interface SqlExecutor {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>
}

export interface ControlPlaneDatabase extends SqlExecutor {
  transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T>
  health(): Promise<{ ok: true; schemaVersion: number }>
  close(): Promise<void>
}

export function createPostgresControlPlaneDatabase(options: {
  connectionString: string
  applicationName?: string
  maxConnections?: number
  statementTimeoutMs?: number
  ssl?: pg.PoolConfig['ssl']
  telemetry?: OnlineTelemetry
}): ControlPlaneDatabase {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'agent-runlab-control-plane',
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  return {
    query: (text, values) => tracePostgresQuery(options.telemetry, () => pool.query(text, values as unknown[] | undefined)),
    async transaction(operation) {
      const client = await pool.connect()
      try {
        await tracePostgresQuery(options.telemetry, () => client.query('BEGIN'))
        const result = await operation({
          query: (text, values) => tracePostgresQuery(options.telemetry, () => client.query(text, values as unknown[] | undefined)),
        })
        await tracePostgresQuery(options.telemetry, () => client.query('COMMIT'))
        return result
      } catch (error) {
        await tracePostgresQuery(options.telemetry, () => client.query('ROLLBACK')).catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    async health() {
      const result = await tracePostgresQuery(options.telemetry, () => pool.query<{ version: number }>('SELECT COALESCE(MAX(version), 0)::integer AS version FROM control_plane_schema_migrations'))
      return { ok: true, schemaVersion: result.rows[0]?.version ?? 0 }
    },
    close: () => pool.end(),
  }
}

export type ControlPlaneMigration = { version: number; name: string; checksum: string; sql: string }

export async function readControlPlaneMigrations(directory: string): Promise<readonly ControlPlaneMigration[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort()
  const migrations: ControlPlaneMigration[] = []
  for (const name of names) {
    const version = Number.parseInt(name.slice(0, 4), 10)
    const sql = await readFile(join(directory, name), 'utf8')
    migrations.push({ version, name: basename(name), checksum: createHash('sha256').update(sql).digest('hex'), sql })
  }
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]!.version >= migrations[index]!.version) throw new Error('control-plane migration versions must be strictly increasing')
  }
  return migrations
}

export async function migrateControlPlane(database: ControlPlaneDatabase, migrations: readonly ControlPlaneMigration[]): Promise<number> {
  await database.query(`CREATE TABLE IF NOT EXISTS control_plane_schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL UNIQUE,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  const lockKey = advisoryLockKey('agent-runlab-control-plane-migrations')
  return database.transaction(async (transaction) => {
    await transaction.query("SET LOCAL lock_timeout = '5s'")
    await transaction.query("SET LOCAL statement_timeout = '60s'")
    await transaction.query('SELECT pg_advisory_xact_lock($1)', [lockKey])
    const applied = await transaction.query<{ version: number; checksum: string }>('SELECT version, checksum FROM control_plane_schema_migrations ORDER BY version')
    const byVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]))
    for (const migration of migrations) {
      const checksum = byVersion.get(migration.version)
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) throw new Error(`control-plane migration ${migration.version} checksum mismatch`)
        continue
      }
      await transaction.query(migration.sql)
      await transaction.query('INSERT INTO control_plane_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, migration.checksum])
    }
    return migrations.at(-1)?.version ?? 0
  })
}

export async function assertControlPlaneSchema(database: ControlPlaneDatabase, migrations: readonly ControlPlaneMigration[]): Promise<number> {
  const expected = migrations.at(-1)?.version ?? 0
  const health = await database.health()
  if (health.schemaVersion !== expected) {
    const direction = health.schemaVersion < expected ? 'behind' : 'ahead'
    throw new Error(`control-plane schema version ${health.schemaVersion} is ${direction} expected version ${expected}; run the migrator with the matching release before starting ingress`)
  }
  return health.schemaVersion
}

function advisoryLockKey(value: string): number {
  return createHash('sha256').update(value).digest().readInt32BE(0)
}
