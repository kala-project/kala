import { createRequire } from 'node:module'

import type { RuntimeCapabilities } from '@agent-kernel/shared'

import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import type { RuntimeUnitMaterialization, RuntimeUnitMaterializationCatalog } from './materialization-store.js'
import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from './unit.js'

type QueryResultRow = Record<string, unknown>
type QueryResult<Row extends QueryResultRow = QueryResultRow> = { rows: Row[]; rowCount: number | null }
type PgExecutor = { query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> }
type PgClient = PgExecutor & { release(): void }
type PgPool = PgExecutor & { connect(): Promise<PgClient>; end(): Promise<void>; on(event: 'error', listener: (error: Error) => void): void }
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (config: Record<string, unknown>) => PgPool }

type MaterializationRow = QueryResultRow & {
  unit_id: string
  organization_id: string | null
  routing_key_digest: string
  routing_key_version: number
  generation: string
  desired_state: RuntimeUnitMaterialization['desiredState']
  data_root: string
  capabilities: RuntimeCapabilities
  operation_id: string
  updated_at: Date
}

/** PostgreSQL authority for RuntimeUnit lifecycle state; the in-process map is only a read cache. */
export class PostgresRuntimeUnitMaterializationStore implements RuntimeUnitMaterializationCatalog {
  readonly #entries = new Map<TenantRuntimeUnitId, RuntimeUnitMaterialization>()
  readonly #table: string
  readonly #schemaManagement: PostgresSchemaManagement
  #closed = false

  constructor(readonly database: PgPool, options: { schema?: string; schemaManagement?: PostgresSchemaManagement } = {}) {
    this.#table = `${quoteIdentifier(options.schema ?? 'public')}.tenant_runtime_unit_materializations`
    this.#schemaManagement = options.schemaManagement ?? 'initialize'
  }

  async load(): Promise<void> {
    await this.initialize()
    const result = await this.database.query<MaterializationRow>(`SELECT * FROM ${this.#table}`)
    this.#entries.clear()
    for (const row of result.rows) {
      const entry = materialization(row)
      this.#entries.set(entry.unitId, entry)
    }
  }

  get(id: TenantRuntimeUnitId): RuntimeUnitMaterialization | undefined {
    return this.#entries.get(id)
  }

  async refresh(id: TenantRuntimeUnitId): Promise<RuntimeUnitMaterialization | undefined> {
    const result = await this.database.query<MaterializationRow>(`SELECT * FROM ${this.#table} WHERE unit_id = $1`, [id])
    const row = result.rows[0]
    if (!row) {
      this.#entries.delete(id)
      return undefined
    }
    const entry = materialization(row)
    this.#entries.set(id, entry)
    return entry
  }

  list(): readonly RuntimeUnitMaterialization[] {
    return [...this.#entries.values()]
  }

  async apply(entry: RuntimeUnitMaterialization): Promise<RuntimeUnitMaterialization> {
    return this.#mutate(entry, false)
  }

  async tombstone(entry: RuntimeUnitMaterialization): Promise<RuntimeUnitMaterialization> {
    if (entry.desiredState !== 'deleted') throw new Error('TenantRuntimeUnit tombstone must be deleted')
    return this.#mutate(entry, true)
  }

  async remove(id: TenantRuntimeUnitId, operationId: string, generation: number): Promise<void> {
    const result = await this.#transaction(async (transaction) => {
      await lockUnit(transaction, id)
      const current = await selectUnit(transaction, this.#table, id)
      if (!current || current.lastOperationId === operationId) return current
      if (generation <= current.generation) throw new Error('stale TenantRuntimeUnit generation')
      const updated = await transaction.query<MaterializationRow>(`UPDATE ${this.#table}
        SET generation = $2, desired_state = 'deleted', operation_id = $3, updated_at = clock_timestamp()
        WHERE unit_id = $1 RETURNING *`, [id, generation, operationId])
      return materialization(updated.rows[0]!)
    })
    if (result) this.#entries.set(id, result)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.database.end()
  }

  private async initialize(): Promise<void> {
    if (this.#schemaManagement === 'external') return
    await this.database.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      unit_id text PRIMARY KEY,
      organization_id text,
      routing_key_digest text NOT NULL,
      routing_key_version integer NOT NULL CHECK (routing_key_version > 0),
      generation bigint NOT NULL CHECK (generation > 0),
      desired_state text NOT NULL CHECK (desired_state IN ('ready', 'suspended', 'deleted')),
      data_root text NOT NULL,
      capabilities jsonb NOT NULL,
      operation_id text NOT NULL,
      updated_at timestamptz NOT NULL
    )`)
  }

  async #mutate(entry: RuntimeUnitMaterialization, tombstone: boolean): Promise<RuntimeUnitMaterialization> {
    const id = parseTenantRuntimeUnitId(entry.unitId)
    const accepted = await this.#transaction(async (transaction) => {
      await lockUnit(transaction, id)
      const current = await selectUnit(transaction, this.#table, id)
      if (current?.lastOperationId === entry.lastOperationId) return current
      if (current && entry.generation <= current.generation) throw new Error('stale TenantRuntimeUnit generation')
      if (!tombstone && current?.desiredState === 'deleted' && entry.desiredState !== 'deleted') {
        throw new Error('deleted TenantRuntimeUnit cannot be resumed')
      }
      if (current?.organizationId && current.organizationId !== entry.organizationId) {
        throw new Error('runtime unit organization binding cannot change')
      }
      const values = entryValues({ ...entry, unitId: id })
      const changed = current
        ? await transaction.query<MaterializationRow>(`UPDATE ${this.#table} SET
            organization_id = $2, routing_key_digest = $3, routing_key_version = $4, generation = $5,
            desired_state = $6, data_root = $7, capabilities = $8::jsonb, operation_id = $9, updated_at = $10
          WHERE unit_id = $1 RETURNING *`, values)
        : await transaction.query<MaterializationRow>(`INSERT INTO ${this.#table}
            (unit_id, organization_id, routing_key_digest, routing_key_version, generation, desired_state,
             data_root, capabilities, operation_id, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *`, values)
      return materialization(changed.rows[0]!)
    })
    this.#entries.set(id, accepted)
    return accepted
  }

  async #transaction<T>(operation: (transaction: PgExecutor) => Promise<T>): Promise<T> {
    const client = await this.database.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

export function createPostgresRuntimeUnitMaterializationStore(options: {
  connectionString: string
  schema?: string
  applicationName?: string
  maxConnections?: number
  statementTimeoutMs?: number
  ssl?: unknown
  schemaManagement?: PostgresSchemaManagement
}): PostgresRuntimeUnitMaterializationStore {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'kala-runtime-unit-materializations',
    max: options.maxConnections ?? 5,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  // pg emits idle connection errors outside outstanding operation promises.
  pool.on('error', () => undefined)
  return new PostgresRuntimeUnitMaterializationStore(pool, {
    schema: options.schema,
    schemaManagement: options.schemaManagement,
  })
}

async function lockUnit(database: PgExecutor, id: TenantRuntimeUnitId): Promise<void> {
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id])
}

async function selectUnit(database: PgExecutor, table: string, id: TenantRuntimeUnitId): Promise<RuntimeUnitMaterialization | undefined> {
  const selected = await database.query<MaterializationRow>(`SELECT * FROM ${table} WHERE unit_id = $1 FOR UPDATE`, [id])
  return selected.rows[0] ? materialization(selected.rows[0]) : undefined
}

function entryValues(entry: RuntimeUnitMaterialization): readonly unknown[] {
  return [entry.unitId, entry.organizationId ?? null, entry.routingKeyDigest, entry.routingKeyVersion,
    entry.generation, entry.desiredState, entry.dataRoot, JSON.stringify(entry.capabilities),
    entry.lastOperationId, entry.updatedAt]
}

function materialization(row: MaterializationRow): RuntimeUnitMaterialization {
  const generation = Number(row.generation)
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid TenantRuntimeUnit generation in PostgreSQL')
  return {
    schemaVersion: 1,
    unitId: parseTenantRuntimeUnitId(row.unit_id),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    routingKeyDigest: row.routing_key_digest,
    routingKeyVersion: row.routing_key_version,
    generation,
    desiredState: row.desired_state,
    dataRoot: row.data_root,
    capabilities: row.capabilities,
    lastOperationId: row.operation_id,
    updatedAt: row.updated_at.toISOString(),
  }
}

function quoteIdentifier(value: string): string {
  if (value.length === 0) throw new TypeError('schema must not be empty')
  return `"${value.replaceAll('"', '""')}"`
}
