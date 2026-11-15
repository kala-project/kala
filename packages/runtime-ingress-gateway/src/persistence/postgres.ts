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

export async function migrateControlPlane(database: ControlPlaneDatabase, migrations: readonly ControlPlaneMigration[], options: {
  beforeApply?: (transaction: SqlExecutor) => Promise<void>
  afterApply?: (transaction: SqlExecutor) => Promise<void>
} = {}): Promise<number> {
  const lockKey = advisoryLockKey('agent-runlab-control-plane-migrations')
  return database.transaction(async (transaction) => {
    await transaction.query("SET LOCAL lock_timeout = '5s'")
    await transaction.query("SET LOCAL statement_timeout = '60s'")
    await transaction.query('SELECT pg_advisory_xact_lock($1)', [lockKey])
    // Take the schema fence before any DDL, including earlier steps in a batched upgrade.
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended('kala:control-settings-schema:v1', 0))")
    await options.beforeApply?.(transaction)
    await transaction.query(`CREATE TABLE IF NOT EXISTS control_plane_schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const applied = await transaction.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM control_plane_schema_migrations ORDER BY version')
    if (applied.rows.some((row, index) => row.version !== migrations[index]?.version || row.name !== migrations[index]?.name)) {
      throw new Error('control-plane migration history is not a known release prefix; refuse partial/ahead schema')
    }
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
    await options.afterApply?.(transaction)
    return migrations.at(-1)?.version ?? 0
  })
}

export async function assertControlPlaneSchema(database: ControlPlaneDatabase, migrations: readonly ControlPlaneMigration[]): Promise<number> {
  const expected = migrations.at(-1)?.version ?? 0
  const health = await database.health()
  const serviceAccountBridge = migrations.length === 13 && migrations.every((migration, index) => migration.version === index + 1)
    && migrations[12]?.name === '0013_service_account_principal_identity.sql'
  const settingsBridge = [14, 15, 16, 17].includes(migrations.length) && migrations.every((migration, index) => migration.version === index + 1)
    && migrations[12]?.name === '0013_service_account_principal_identity.sql'
    && migrations[13]?.name === '0014_authoritative_settings_resource_versions.sql'
    && (migrations.length === 14 || migrations[14]?.name === '0015_immutable_webhook_bindings.sql')
    && (migrations.length < 16 || migrations[15]?.name === '0016_operator_settings_authority.sql')
    && (migrations.length < 17 || migrations[16]?.name === '0017_workspace_operation_fences.sql')
  const compatible = settingsBridge ? Array.from({ length: expected - 11 }, (_, index) => index + 12) : serviceAccountBridge ? [12, 13] : [expected]
  if (!compatible.includes(health.schemaVersion)) {
    const direction = health.schemaVersion < expected ? 'behind' : 'ahead'
    throw new Error(`control-plane schema version ${health.schemaVersion} is ${direction} expected version ${expected}; run the migrator with the matching release before starting ingress`)
  }
  if (serviceAccountBridge || settingsBridge) {
    const history = await database.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM control_plane_schema_migrations ORDER BY version',
    )
    if (history.rows.length !== health.schemaVersion || history.rows.some((row, index) =>
      row.version !== index + 1 || row.name !== migrations[index]?.name || row.checksum !== migrations[index]?.checksum)) {
      throw new Error('control-plane schema history does not match the reviewed Settings bridge')
    }
  }
  return health.schemaVersion
}

function advisoryLockKey(value: string): number {
  return createHash('sha256').update(value).digest().readInt32BE(0)
}
