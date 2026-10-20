import type { HotStateDatabase } from '../tenant-runtime/postgres-hot-state.js'

/**
 * Experimental bootstrap for isolated development and tests. Production must
 * apply the equivalent DDL through its migration pipeline before startup.
 */
export async function initializePrivateCloudExperimentalStorageSchema(
  database: HotStateDatabase,
  options: { schema?: string } = {},
): Promise<void> {
  const schema = quoteIdentifier(options.schema ?? 'public')
  await database.query(`CREATE TABLE IF NOT EXISTS ${schema}.workspace_aliases (
    organization_id text NOT NULL,
    workspace_id text NOT NULL,
    workspace_name text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, workspace_id)
  )`)
  await database.query(`CREATE TABLE IF NOT EXISTS ${schema}.executor_installations (
    organization_id text NOT NULL,
    installation_id text NOT NULL,
    record jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, installation_id)
  )`)
  await database.query(`CREATE TABLE IF NOT EXISTS ${schema}.executor_installation_idempotency (
    organization_id text NOT NULL,
    idempotency_key text NOT NULL,
    installation_id text NOT NULL,
    PRIMARY KEY (organization_id, idempotency_key),
    FOREIGN KEY (organization_id, installation_id)
      REFERENCES ${schema}.executor_installations (organization_id, installation_id)
      ON DELETE CASCADE
  )`)
  await database.query(`CREATE UNIQUE INDEX IF NOT EXISTS executor_installations_setup_code_hash
    ON ${schema}.executor_installations (organization_id, ((record ->> 'setupCodeHash')))
    WHERE record ? 'setupCodeHash'`)
  await database.query(`CREATE TABLE IF NOT EXISTS ${schema}.executor_identities (
    organization_id text NOT NULL,
    unit_id text NOT NULL,
    record_kind text NOT NULL CHECK (record_kind IN ('identity', 'invite', 'pairing')),
    record_id text NOT NULL,
    record jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, unit_id, record_kind, record_id)
  )`)
  await database.query(`CREATE UNIQUE INDEX IF NOT EXISTS executor_identities_active_workspace
    ON ${schema}.executor_identities (organization_id, unit_id, ((record ->> 'workspaceId')))
    WHERE record_kind = 'identity' AND NOT (record ? 'revokedAt')`)
  await database.query(`CREATE UNIQUE INDEX IF NOT EXISTS executor_identities_token_hash
    ON ${schema}.executor_identities (organization_id, unit_id, ((record ->> 'tokenHash')))
    WHERE record_kind = 'identity'`)
  await database.query(`CREATE UNIQUE INDEX IF NOT EXISTS executor_invites_hash
    ON ${schema}.executor_identities (organization_id, unit_id, ((record ->> 'inviteHash')))
    WHERE record_kind = 'invite'`)
}

export function privateCloudStorageTable(schema: string | undefined, table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(table)) throw new TypeError('table must be a simple PostgreSQL identifier')
  return `${quoteIdentifier(schema ?? 'public')}.${quoteIdentifier(table)}`
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new TypeError('schema must be a simple PostgreSQL identifier')
  return `"${identifier}"`
}
