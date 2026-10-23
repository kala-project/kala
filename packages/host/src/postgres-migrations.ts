import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

export type PostgresSchemaManagement = 'initialize' | 'external'

export type PostgresMigrationExecutor = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>
}

export type PostgresMigrationClient = PostgresMigrationExecutor & { release(): void }
export type PostgresMigrationPool = PostgresMigrationExecutor & {
  connect(): Promise<PostgresMigrationClient>
  end(): Promise<void>
}

type PostgresMigration = {
  version: number
  name: string
  statements(schema: string): readonly string[]
}

type AppliedMigrationRow = Record<string, unknown> & {
  version: number
  name: string
  checksum: string
}

const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (config: Record<string, unknown>) => PostgresMigrationPool
}

const LOCK_NAMESPACE = 0x4b414c41 // "KALA"
const LOCK_SCHEMA_MIGRATIONS = 1
export const POSTGRES_MIGRATION_TABLE = 'kala_schema_migrations'
export const RUNTIME_UNIT_PROTOCOL_GATE_TABLE = 'tenant_runtime_unit_protocol_gates'
export const POSTGRES_GATEWAY_RUNTIME_READER_TABLES = [
  'tenant_runtime_unit_placement_leases',
  RUNTIME_UNIT_PROTOCOL_GATE_TABLE,
  'tenant_runtime_unit_replica_memberships',
  'tenant_runtime_resource_ownerships',
  'tenant_session_latest_projection',
] as const

const migrations: readonly PostgresMigration[] = [
  {
    version: 1,
    name: 'private_cloud_runtime_initial_schema',
    statements: initialSchemaStatements,
  },
  {
    version: 2,
    name: 'tenant_object_capacity_ledger',
    statements: objectCapacityStatements,
  },
  {
    version: 3,
    name: 'runtime_replica_resource_ownership',
    statements: runtimeResourceOwnershipStatements,
  },
  {
    version: 4,
    name: 'organization_global_resource_identity',
    statements: runtimeResourceIdentityStatements,
  },
  {
    version: 5,
    name: 'protected_parallel_runtime_unit_protocol',
    statements: runtimeUnitProtocolGateStatements,
  },
  {
    version: 6,
    name: 'leased_object_upload_intents',
    statements: leasedObjectUploadIntentStatements,
  },
]

export const LATEST_POSTGRES_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0

export type PostgresMigrationResult = {
  previousVersion: number
  currentVersion: number
  appliedVersions: readonly number[]
}

export async function migratePostgres(options: {
  connectionString: string
  schema?: string
  applicationName?: string
  ssl?: unknown
}): Promise<PostgresMigrationResult> {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'kala-postgres-migrate',
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  try {
    return await runPostgresMigrations(pool, { schema: options.schema })
  } finally {
    await pool.end()
  }
}

/** Operator-only: grant DML on Kala Runtime tables, never unrelated tables or migration writes. */
export async function grantPostgresRuntimeDml(options: {
  connectionString: string
  runtimeRole: string
  schema?: string
  ssl?: unknown
}): Promise<void> {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: 'kala-postgres-runtime-grants',
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  try {
    await grantPostgresRuntimePrivileges(pool, options)
  } finally {
    await pool.end()
  }
}

/** Operator-only: grant SELECT on only the Runtime tables queried by Gateway routing. */
export async function grantPostgresGatewayRuntimeReader(options: {
  connectionString: string
  readerRole: string
  schema?: string
  ssl?: unknown
}): Promise<void> {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: 'kala-postgres-gateway-runtime-reader-grants',
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  try {
    await grantPostgresGatewayRuntimeReaderPrivileges(pool, options)
  } finally {
    await pool.end()
  }
}

/** Caller must provide an existing, unprivileged reader role and an operator pool. */
export async function grantPostgresGatewayRuntimeReaderPrivileges(
  pool: PostgresMigrationPool,
  options: { readerRole: string; schema?: string },
): Promise<void> {
  const roleName = validateIdentifier(options.readerRole, 'readerRole')
  if (roleName.length > 63) throw new TypeError('readerRole exceeds PostgreSQL identifier length')
  const schemaName = validateIdentifier(options.schema ?? 'public', 'schema')
  const schema = quoteIdentifier(schemaName)
  const role = quoteIdentifier(roleName)
  const guardedTables = [...POSTGRES_GATEWAY_RUNTIME_READER_TABLES, POSTGRES_MIGRATION_TABLE]
    .map((table) => `${schema}.${quoteIdentifier(table)}`)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertPostgresSchemaCurrent(client, { schema: schemaName })
    const privilege = await client.query<{
      can_create: boolean; can_create_db: boolean; owns_schema: boolean; owns_table: boolean
      elevated: boolean; forbidden_dml: boolean
    }>(`SELECT
      has_schema_privilege($1, $2, 'CREATE') AS can_create,
      has_database_privilege($1, current_database(), 'CREATE') AS can_create_db,
      COALESCE((SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole) FROM pg_roles
        WHERE pg_has_role($1, rolname, 'MEMBER')), true) AS elevated,
      EXISTS (SELECT 1 FROM unnest($3::text[]) AS guarded(table_name)
        WHERE has_table_privilege($1, guarded.table_name, 'INSERT')
          OR has_table_privilege($1, guarded.table_name, 'UPDATE')
          OR has_table_privilege($1, guarded.table_name, 'DELETE')
          OR has_table_privilege($1, guarded.table_name, 'TRUNCATE')
          OR has_table_privilege($1, guarded.table_name, 'REFERENCES')
          OR has_table_privilege($1, guarded.table_name, 'TRIGGER')) AS forbidden_dml,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2
        AND pg_has_role($1, pg_get_userbyid(nspowner), 'MEMBER')) AS owns_schema,
      EXISTS (SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = $2 AND pg_has_role($1, pg_get_userbyid(c.relowner), 'MEMBER')) AS owns_table`,
    [roleName, schemaName, guardedTables])
    const permissions = privilege.rows[0]
    if (!permissions || permissions.can_create || permissions.can_create_db || permissions.elevated
      || permissions.forbidden_dml || permissions.owns_schema || permissions.owns_table) {
      throw new Error('Gateway Runtime reader role must not own tables or have DDL, DML, migration-write, or elevated privileges')
    }
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    for (const table of POSTGRES_GATEWAY_RUNTIME_READER_TABLES) {
      await client.query(`GRANT SELECT ON TABLE ${schema}.${quoteIdentifier(table)} TO ${role}`)
    }
    await grantInstallationClaimReadIfPresent(client, role, roleName)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Caller must provide an existing, non-owner Runtime role and an operator pool. */
export async function grantPostgresRuntimePrivileges(
  pool: PostgresMigrationPool,
  options: { runtimeRole: string; schema?: string },
): Promise<void> {
  const roleName = validateIdentifier(options.runtimeRole, 'runtimeRole')
  if (roleName.length > 63) throw new TypeError('runtimeRole exceeds PostgreSQL identifier length')
  const schemaName = validateIdentifier(options.schema ?? 'public', 'schema')
  const schema = quoteIdentifier(schemaName)
  const role = quoteIdentifier(roleName)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertPostgresSchemaCurrent(client, { schema: schemaName })
    const privilege = await client.query<{
      can_create: boolean; can_create_db: boolean; owns_schema: boolean; owns_table: boolean
      elevated: boolean; migration_write: boolean
    }>(`SELECT
      has_schema_privilege($1, $2, 'CREATE') AS can_create,
      has_database_privilege($1, current_database(), 'CREATE') AS can_create_db,
      COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = $1), true) AS elevated,
      has_table_privilege($1, $3, 'INSERT') OR has_table_privilege($1, $3, 'UPDATE')
        OR has_table_privilege($1, $3, 'DELETE') AS migration_write,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2 AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS owns_schema,
      EXISTS (SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = $2 AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS owns_table`,
    [roleName, schemaName, `${schema}.${quoteIdentifier(POSTGRES_MIGRATION_TABLE)}`])
    const permissions = privilege.rows[0]
    if (!permissions || permissions.can_create || permissions.can_create_db || permissions.elevated
      || permissions.migration_write || permissions.owns_schema || permissions.owns_table) {
      throw new Error('Runtime role must not own tables, edit migration history, or have DDL privileges')
    }
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    await client.query(`GRANT SELECT ON TABLE ${schema}.${quoteIdentifier(POSTGRES_MIGRATION_TABLE)} TO ${role}`)
    for (const table of postgresRuntimeTables()) {
      const privileges = table === RUNTIME_UNIT_PROTOCOL_GATE_TABLE ? 'SELECT' : 'SELECT, INSERT, UPDATE, DELETE'
      await client.query(`GRANT ${privileges} ON TABLE ${schema}.${quoteIdentifier(table)} TO ${role}`)
    }
    await grantInstallationClaimReadIfPresent(client, role, roleName)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function grantInstallationClaimReadIfPresent(client: PostgresMigrationClient, role: string, roleName: string): Promise<void> {
  const marker = await client.query<{ marker: string | null }>(`SELECT to_regclass('kala_installation_claim.marker')::text AS marker`)
  if (!marker.rows[0]?.marker) return // Legacy/standalone Runtime databases have no fresh-install claim.
  const rights = await client.query<{ can_create: boolean; can_write: boolean; owns_schema: boolean; owns_marker: boolean }>(`SELECT
    has_schema_privilege($1, 'kala_installation_claim', 'CREATE') AS can_create,
    has_table_privilege($1, 'kala_installation_claim.marker', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS can_write,
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kala_installation_claim'
      AND pg_has_role($1, pg_get_userbyid(nspowner), 'MEMBER')) AS owns_schema,
    EXISTS (SELECT 1 FROM pg_class WHERE oid = 'kala_installation_claim.marker'::regclass
      AND pg_has_role($1, pg_get_userbyid(relowner), 'MEMBER')) AS owns_marker`, [roleName])
  if (!rights.rows[0] || Object.values(rights.rows[0]).some(Boolean)) {
    throw new Error('Workload role must not own or mutate the installation claim')
  }
  await client.query(`GRANT USAGE ON SCHEMA kala_installation_claim TO ${role}`)
  await client.query(`GRANT SELECT ON TABLE kala_installation_claim.marker TO ${role}`)
}

function postgresRuntimeTables(): string[] {
  const tables = new Set<string>()
  const schema = '"__kala_schema__"'
  for (const migration of migrations) {
    for (const statement of migration.statements(schema)) {
      if (!statement.startsWith(`CREATE TABLE IF NOT EXISTS ${schema}.`)) continue
      const table = statement.slice(`CREATE TABLE IF NOT EXISTS ${schema}.`.length).match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0]
      if (!table) throw new Error(`cannot determine Runtime table for migration ${migration.version}`)
      tables.add(table)
    }
  }
  return [...tables].sort()
}

export async function checkPostgresSchemaVersion(options: {
  connectionString: string
  schema?: string
  applicationName?: string
  ssl?: unknown
}): Promise<number> {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'kala-postgres-schema-check',
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  })
  try {
    return await assertPostgresSchemaCurrent(pool, { schema: options.schema })
  } finally {
    await pool.end()
  }
}

/** Operator-only runner. It serializes all migrators for the database and applies each version atomically. */
export async function runPostgresMigrations(
  pool: PostgresMigrationPool,
  options: { schema?: string } = {},
): Promise<PostgresMigrationResult> {
  validateMigrationSequence(migrations)
  const schemaName = validateIdentifier(options.schema ?? 'public', 'schema')
  const schema = quoteIdentifier(schemaName)
  const table = `${schema}.${quoteIdentifier(POSTGRES_MIGRATION_TABLE)}`
  const client = await pool.connect()
  let locked = false
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, LOCK_SCHEMA_MIGRATIONS])
    locked = true
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`)

    const applied = await readAppliedMigrations(client, table)
    verifyAppliedMigrations(applied)
    const previousVersion = applied.at(-1)?.version ?? 0
    const appliedVersions: number[] = []

    for (const migration of migrations) {
      if (migration.version <= previousVersion) continue
      await client.query('BEGIN')
      try {
        for (const statement of migration.statements(schema)) await client.query(statement)
        await client.query(`INSERT INTO ${table} (version, name, checksum) VALUES ($1, $2, $3)`, [
          migration.version,
          migration.name,
          migrationChecksum(migration),
        ])
        await client.query('COMMIT')
        appliedVersions.push(migration.version)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }

    return { previousVersion, currentVersion: LATEST_POSTGRES_SCHEMA_VERSION, appliedVersions }
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_SCHEMA_MIGRATIONS]).catch(() => undefined)
    }
    client.release()
  }
}

/** Runtime-safe check: performs SELECT only and fails closed for missing, old, future, gapped, or modified migrations. */
export async function assertPostgresSchemaCurrent(
  executor: PostgresMigrationExecutor,
  options: { schema?: string } = {},
): Promise<number> {
  validateMigrationSequence(migrations)
  const schema = quoteIdentifier(validateIdentifier(options.schema ?? 'public', 'schema'))
  const table = `${schema}.${quoteIdentifier(POSTGRES_MIGRATION_TABLE)}`
  let applied: readonly AppliedMigrationRow[]
  try {
    applied = await readAppliedMigrations(executor, table)
  } catch (error) {
    if (postgresErrorCode(error) === '42P01' || postgresErrorCode(error) === '3F000') {
      throw new Error(`PostgreSQL schema is not migrated; run kala-postgres-migrate before Runtime startup`, { cause: error })
    }
    throw error
  }
  verifyAppliedMigrations(applied)
  const version = applied.at(-1)?.version ?? 0
  if (version !== LATEST_POSTGRES_SCHEMA_VERSION) {
    throw new Error(`PostgreSQL schema version ${version} is not current; expected ${LATEST_POSTGRES_SCHEMA_VERSION}`)
  }
  return version
}

export function postgresMigrationTable(schema = 'public'): string {
  return `${quoteIdentifier(validateIdentifier(schema, 'schema'))}.${quoteIdentifier(POSTGRES_MIGRATION_TABLE)}`
}

async function readAppliedMigrations(
  executor: PostgresMigrationExecutor,
  table: string,
): Promise<readonly AppliedMigrationRow[]> {
  const result = await executor.query<AppliedMigrationRow>(
    `SELECT version, name, checksum FROM ${table} ORDER BY version ASC`,
  )
  return result.rows
}

function verifyAppliedMigrations(applied: readonly AppliedMigrationRow[]): void {
  if (applied.length > migrations.length) {
    throw new Error(`PostgreSQL schema version ${applied.at(-1)?.version} is newer than this Runtime supports`)
  }
  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index]!
    const expected = migrations[index]!
    if (row.version !== expected.version) {
      throw new Error(`PostgreSQL migration history is not strictly ascending at version ${row.version}`)
    }
    if (row.name !== expected.name || row.checksum !== migrationChecksum(expected)) {
      throw new Error(`PostgreSQL migration ${row.version} does not match this release`)
    }
  }
}

function validateMigrationSequence(values: readonly PostgresMigration[]): void {
  for (let index = 0; index < values.length; index += 1) {
    const expectedVersion = index + 1
    if (values[index]?.version !== expectedVersion) {
      throw new Error(`PostgreSQL migrations must be consecutive and strictly ascending; expected ${expectedVersion}`)
    }
  }
}

function migrationChecksum(migration: PostgresMigration): string {
  const canonicalStatements = migration.statements('"__kala_schema__"')
  return createHash('sha256')
    .update(JSON.stringify([migration.version, migration.name, canonicalStatements]))
    .digest('hex')
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function validateIdentifier(identifier: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError(`${name} must be a simple PostgreSQL identifier`)
  return identifier
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`
}

function objectCapacityStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_object_capacity_accounts (
      tenant_id text PRIMARY KEY,
      limit_bytes bigint NOT NULL CHECK (limit_bytes > 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_object_capacity_allocations (
      tenant_id text NOT NULL,
      object_key text NOT NULL,
      reservation_id uuid NOT NULL,
      session_id text NOT NULL,
      object_kind text NOT NULL CHECK (object_kind IN ('session_artifact', 'message_attachment')),
      bytes bigint NOT NULL CHECK (bytes > 0),
      state text NOT NULL CHECK (state IN ('reserved', 'committed')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      committed_at timestamptz,
      PRIMARY KEY (tenant_id, object_key),
      UNIQUE (tenant_id, reservation_id),
      FOREIGN KEY (tenant_id) REFERENCES ${schema}.tenant_object_capacity_accounts (tenant_id) ON DELETE RESTRICT,
      CHECK ((state = 'reserved' AND committed_at IS NULL) OR (state = 'committed' AND committed_at IS NOT NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS tenant_object_capacity_allocations_state_idx
      ON ${schema}.tenant_object_capacity_allocations (tenant_id, state)`,
  ]
}

/** Development-only resource table bootstrap; production must run the versioned operator migrations. */
export async function initializeExperimentalRuntimeResourceOwnershipSchema(
  database: PostgresMigrationExecutor,
  options: { schema?: string } = {},
): Promise<void> {
  const schema = quoteIdentifier(validateIdentifier(options.schema ?? 'public', 'schema'))
  for (const statement of runtimeResourceOwnershipStatements(schema)) await database.query(statement)
  for (const statement of runtimeResourceIdentityStatements(schema)) await database.query(statement)
}

/** Session and Task hot state is keyed by organization and resource ID, not Unit. */
function runtimeResourceIdentityStatements(schema: string): readonly string[] {
  return [`CREATE UNIQUE INDEX IF NOT EXISTS tenant_runtime_resource_ownerships_global_resource_uidx
    ON ${schema}.tenant_runtime_resource_ownerships (organization_id, resource_type, resource_id)`]
}

function runtimeResourceOwnershipStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_unit_replica_memberships (
      organization_id text NOT NULL,
      unit_id text NOT NULL,
      replica_id text NOT NULL,
      membership_token text NOT NULL,
      origin text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, unit_id, replica_id)
    )`,
    `CREATE INDEX IF NOT EXISTS tenant_runtime_unit_replica_memberships_live_idx
      ON ${schema}.tenant_runtime_unit_replica_memberships (organization_id, unit_id, expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_resource_ownerships (
      organization_id text NOT NULL,
      resource_type text NOT NULL CHECK (resource_type IN ('session', 'task')),
      resource_id text NOT NULL,
      unit_id text NOT NULL,
      replica_id text NOT NULL,
      membership_generation bigint NOT NULL CHECK (membership_generation > 0),
      membership_token text NOT NULL,
      owner_token text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, unit_id, resource_type, resource_id),
      FOREIGN KEY (organization_id, unit_id, replica_id)
        REFERENCES ${schema}.tenant_runtime_unit_replica_memberships (organization_id, unit_id, replica_id)
        ON DELETE RESTRICT
    )`,
    `CREATE INDEX IF NOT EXISTS tenant_runtime_resource_ownerships_replica_idx
      ON ${schema}.tenant_runtime_resource_ownerships (organization_id, unit_id, replica_id)`,
  ]
}

/**
 * Operator-owned gate. Runtime receives SELECT only. The permanent placement
 * barrier remains visible to old binaries as a live exclusive owner.
 */
function runtimeUnitProtocolGateStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_unit_protocol_gates (
      organization_id text NOT NULL,
      unit_id text NOT NULL,
      feature_version integer NOT NULL CHECK (feature_version > 0),
      barrier_generation bigint NOT NULL CHECK (barrier_generation > 0),
      enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, unit_id)
    )`,
    `CREATE OR REPLACE FUNCTION ${schema}.kala_guard_parallel_placement_barrier()
      RETURNS trigger LANGUAGE plpgsql AS $kala$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.node_id = 'kala-parallel-placement-barrier-v1' THEN
            RAISE EXCEPTION 'cannot delete a permanent Kala parallel placement barrier'
              USING ERRCODE = 'object_in_use';
          END IF;
          RETURN OLD;
        END IF;
        IF NEW.node_id = 'kala-parallel-placement-barrier-v1' THEN
          IF NEW.owner_token <> 'kala-parallel-placement-barrier-v1'
            OR NEW.origin <> 'https://parallel-placement-barrier.invalid'
            OR NEW.expires_at <> 'infinity'::timestamptz THEN
            RAISE EXCEPTION 'invalid Kala parallel placement barrier' USING ERRCODE = 'check_violation';
          END IF;
          IF TG_OP = 'UPDATE'
            AND OLD.node_id <> 'kala-parallel-placement-barrier-v1'
            AND OLD.expires_at > clock_timestamp() THEN
            RAISE EXCEPTION 'cannot replace a live legacy Runtime Unit placement with a parallel barrier'
              USING ERRCODE = 'object_in_use';
          END IF;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.node_id = 'kala-parallel-placement-barrier-v1'
          AND (NEW.organization_id, NEW.unit_id, NEW.node_id, NEW.owner_token, NEW.origin, NEW.generation, NEW.expires_at)
            IS DISTINCT FROM (OLD.organization_id, OLD.unit_id, OLD.node_id, OLD.owner_token, OLD.origin, OLD.generation, OLD.expires_at) THEN
          RAISE EXCEPTION 'cannot modify a permanent Kala parallel placement barrier'
            USING ERRCODE = 'object_in_use';
        END IF;
        RETURN NEW;
      END
      $kala$`,
    `DROP TRIGGER IF EXISTS kala_guard_parallel_placement_barrier
      ON ${schema}.tenant_runtime_unit_placement_leases`,
    `CREATE TRIGGER kala_guard_parallel_placement_barrier
      BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.tenant_runtime_unit_placement_leases
      FOR EACH ROW EXECUTE FUNCTION ${schema}.kala_guard_parallel_placement_barrier()`,
    `CREATE OR REPLACE FUNCTION ${schema}.kala_validate_runtime_unit_protocol_gate()
      RETURNS trigger LANGUAGE plpgsql AS $kala$
      DECLARE placement record;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION 'Kala Runtime Unit protocol gates are permanent; drain replicas and apply a reviewed migration'
            USING ERRCODE = 'object_in_use';
        END IF;
        SELECT node_id, owner_token, origin, generation, expires_at INTO placement
          FROM ${schema}.tenant_runtime_unit_placement_leases
          WHERE organization_id = NEW.organization_id AND unit_id = NEW.unit_id
          FOR UPDATE;
        IF NOT FOUND
          OR placement.node_id <> 'kala-parallel-placement-barrier-v1'
          OR placement.owner_token <> 'kala-parallel-placement-barrier-v1'
          OR placement.origin <> 'https://parallel-placement-barrier.invalid'
          OR placement.generation <> NEW.barrier_generation
          OR placement.expires_at <> 'infinity'::timestamptz THEN
          RAISE EXCEPTION 'Runtime Unit protocol gate requires its exact permanent placement barrier'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $kala$`,
    `DROP TRIGGER IF EXISTS kala_validate_runtime_unit_protocol_gate
      ON ${schema}.tenant_runtime_unit_protocol_gates`,
    `CREATE TRIGGER kala_validate_runtime_unit_protocol_gate
      BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.tenant_runtime_unit_protocol_gates
      FOR EACH ROW EXECUTE FUNCTION ${schema}.kala_validate_runtime_unit_protocol_gate()`,
    `CREATE OR REPLACE FUNCTION ${schema}.kala_deny_parallel_protocol_truncate()
      RETURNS trigger LANGUAGE plpgsql AS $kala$
      BEGIN
        RAISE EXCEPTION 'cannot truncate Kala Runtime Unit placement or protocol gates; use a reviewed migration'
          USING ERRCODE = 'object_in_use';
      END
      $kala$`,
    `DROP TRIGGER IF EXISTS kala_deny_parallel_protocol_truncate
      ON ${schema}.tenant_runtime_unit_placement_leases`,
    `CREATE TRIGGER kala_deny_parallel_protocol_truncate
      BEFORE TRUNCATE ON ${schema}.tenant_runtime_unit_placement_leases
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.kala_deny_parallel_protocol_truncate()`,
    `DROP TRIGGER IF EXISTS kala_deny_parallel_protocol_truncate
      ON ${schema}.tenant_runtime_unit_protocol_gates`,
    `CREATE TRIGGER kala_deny_parallel_protocol_truncate
      BEFORE TRUNCATE ON ${schema}.tenant_runtime_unit_protocol_gates
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.kala_deny_parallel_protocol_truncate()`,
  ]
}

function leasedObjectUploadIntentStatements(schema: string): readonly string[] {
  return [
    `ALTER TABLE ${schema}.tenant_object_orphan_intents
      ADD COLUMN upload_expires_at timestamptz,
      ADD COLUMN owner_unit_id text,
      ADD COLUMN owner_replica_id text,
      ADD COLUMN owner_membership_generation bigint,
      ADD COLUMN owner_membership_token text,
      ADD COLUMN owner_token text,
      ADD COLUMN owner_generation bigint`,
    `UPDATE ${schema}.tenant_object_orphan_intents
      SET upload_expires_at = created_at WHERE upload_expires_at IS NULL`,
    `ALTER TABLE ${schema}.tenant_object_orphan_intents
      ALTER COLUMN upload_expires_at SET NOT NULL,
      ADD CONSTRAINT tenant_object_orphan_intents_owner_context_check CHECK (
        (owner_unit_id IS NULL AND owner_replica_id IS NULL AND owner_membership_generation IS NULL
          AND owner_membership_token IS NULL AND owner_token IS NULL AND owner_generation IS NULL)
        OR (owner_unit_id IS NOT NULL AND owner_replica_id IS NOT NULL AND owner_membership_generation IS NOT NULL
          AND owner_membership_token IS NOT NULL AND owner_token IS NOT NULL AND owner_generation IS NOT NULL))`,
    `CREATE INDEX tenant_object_orphan_intents_upload_lease_idx
      ON ${schema}.tenant_object_orphan_intents (tenant_id, state, upload_expires_at)`,
  ]
}

function initialSchemaStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_unit_materializations (
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
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_unit_placement_leases (
      unit_id text NOT NULL,
      organization_id text NOT NULL,
      node_id text NOT NULL,
      owner_token text NOT NULL,
      origin text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (unit_id, organization_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_hot_leases (
      tenant_id text NOT NULL,
      scope_type text NOT NULL CHECK (scope_type IN ('session', 'task')),
      scope_id text NOT NULL,
      owner_id text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, scope_type, scope_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_hot_events (
      tenant_id text NOT NULL,
      scope_type text NOT NULL CHECK (scope_type IN ('session', 'task')),
      scope_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence > 0),
      generation bigint NOT NULL CHECK (generation > 0),
      idempotency_key text NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, scope_type, scope_id, sequence),
      UNIQUE (tenant_id, scope_type, scope_id, idempotency_key),
      FOREIGN KEY (tenant_id, scope_type, scope_id)
        REFERENCES ${schema}.tenant_runtime_hot_leases (tenant_id, scope_type, scope_id)
        ON DELETE RESTRICT
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_state_memos (
      tenant_id text NOT NULL,
      owner text NOT NULL,
      content text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, owner)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_state_credentials (
      tenant_id text NOT NULL,
      credential_id text NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      auth_tag bytea NOT NULL,
      metadata jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, credential_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_dag_state (
      tenant_id text NOT NULL,
      unit_id text NOT NULL,
      state jsonb NOT NULL,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, unit_id),
      CHECK (jsonb_typeof(state) = 'object')
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.scheduled_task_writer_leases (
      namespace text NOT NULL,
      unit_id text NOT NULL,
      owner_id text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (namespace, unit_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.scheduled_task_states (
      namespace text NOT NULL,
      unit_id text NOT NULL,
      document jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (namespace, unit_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.workspace_aliases (
      organization_id text NOT NULL,
      workspace_id text NOT NULL,
      workspace_name text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, workspace_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.executor_installations (
      organization_id text NOT NULL,
      installation_id text NOT NULL,
      record jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, installation_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.executor_installation_idempotency (
      organization_id text NOT NULL,
      idempotency_key text NOT NULL,
      installation_id text NOT NULL,
      PRIMARY KEY (organization_id, idempotency_key),
      FOREIGN KEY (organization_id, installation_id)
        REFERENCES ${schema}.executor_installations (organization_id, installation_id)
        ON DELETE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS executor_installations_setup_code_hash
      ON ${schema}.executor_installations (organization_id, ((record ->> 'setupCodeHash')))
      WHERE record ? 'setupCodeHash'`,
    `CREATE TABLE IF NOT EXISTS ${schema}.executor_identities (
      organization_id text NOT NULL,
      unit_id text NOT NULL,
      record_kind text NOT NULL CHECK (record_kind IN ('identity', 'invite', 'pairing')),
      record_id text NOT NULL,
      record jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, unit_id, record_kind, record_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS executor_identities_active_workspace
      ON ${schema}.executor_identities (organization_id, unit_id, ((record ->> 'workspaceId')))
      WHERE record_kind = 'identity' AND NOT (record ? 'revokedAt')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS executor_identities_token_hash
      ON ${schema}.executor_identities (organization_id, unit_id, ((record ->> 'tokenHash')))
      WHERE record_kind = 'identity'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS executor_invites_hash
      ON ${schema}.executor_identities (organization_id, unit_id, ((record ->> 'inviteHash')))
      WHERE record_kind = 'invite'`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_message_queue (
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
      cancelled_operation_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cancelled_operation_ids) = 'array'),
      claim_owner text,
      claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claim_item_id text,
      claim_operation_id text,
      claim_expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, session_id),
      CHECK ((claim_owner IS NULL AND claim_item_id IS NULL AND claim_operation_id IS NULL AND claim_expires_at IS NULL)
        OR (claim_owner IS NOT NULL AND claim_item_id IS NOT NULL AND claim_operation_id IS NOT NULL AND claim_expires_at IS NOT NULL))
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_latest_projection (
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      version bigint NOT NULL CHECK (version > 0),
      document jsonb,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, session_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_object_orphan_intents (
      tenant_id text NOT NULL,
      object_key text NOT NULL,
      intent_id uuid NOT NULL,
      session_id text NOT NULL,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting')),
      claim_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      claimed_at timestamptz,
      PRIMARY KEY (tenant_id, object_key),
      UNIQUE (tenant_id, intent_id),
      CHECK ((state = 'pending' AND claim_id IS NULL AND claimed_at IS NULL)
        OR (state = 'deleting' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS tenant_object_orphan_intents_reconcile_idx
      ON ${schema}.tenant_object_orphan_intents (tenant_id, state, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_object_session_deletions (
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, session_id)
    )`,
  ]
}
