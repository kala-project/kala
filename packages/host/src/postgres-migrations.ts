import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { nativeFsSchemaStatements, type NativeFsTables } from './store/native-session-fs.js'
import { agentSettingsSchemaStatements } from './tenant-runtime/postgres-agent-settings.js'
import { nativePosixSchemaStatements } from './store/native-posix-fs.js'
import { nativeFsAdmissionSchemaStatements } from './store/native-fs-admission.js'

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
  {
    version: 7,
    name: 'native_copilot_session_filesystem',
    statements: nativeSessionFsStatements,
  },
  {
    version: 8,
    name: 'organization_agent_prompt_settings',
    statements: agentSettingsSchemaStatements,
  },
  {
    version: 9,
    name: 'native_session_storage_wide_counters',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_session_native_fs_usage
        ALTER COLUMN total_bytes TYPE bigint,
        ALTER COLUMN total_nodes TYPE bigint`,
      `ALTER TABLE ${schema}.tenant_session_native_fs_nodes
        ALTER COLUMN bytes TYPE bigint,
        ALTER COLUMN next_chunk TYPE bigint`,
      `ALTER TABLE ${schema}.tenant_session_native_fs_chunks
        ALTER COLUMN chunk_no TYPE bigint`,
    ],
  },
  {
    version: 10,
    name: 'binary_native_posix_filesystem',
    statements: nativePosixSchemaStatements,
  },
  {
    version: 11,
    name: 'exclusive_native_filesystem_admission',
    statements: nativeFsAdmissionSchemaStatements,
  },
  {
    version: 12,
    name: 'session_tree_agent_boards',
    statements: (schema) => [
      `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_agent_boards (
        tenant_id text NOT NULL,
        root_session_id text NOT NULL,
        state jsonb NOT NULL,
        PRIMARY KEY (tenant_id, root_session_id)
      )`,
    ],
  },
  {
    version: 13,
    name: 'fenced_child_command_inbox',
    statements: (schema) => [
      `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_child_commands (
        tenant_id text NOT NULL,
        parent_session_id text NOT NULL,
        child_session_id text NOT NULL,
        command_id text NOT NULL,
        ordinal bigint NOT NULL CHECK (ordinal > 0),
        kind text NOT NULL CHECK (kind IN ('message', 'stop')),
        message text,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed')),
        owner_generation bigint,
        owner_token text,
        outcome jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, child_session_id, command_id),
        UNIQUE (tenant_id, child_session_id, ordinal),
        CHECK ((kind = 'message' AND message IS NOT NULL) OR (kind = 'stop' AND message IS NULL)),
        CHECK ((status = 'claimed' AND owner_generation IS NOT NULL AND owner_token IS NOT NULL)
          OR (status <> 'claimed' AND owner_generation IS NULL AND owner_token IS NULL)),
        CHECK ((status = 'completed') = (outcome IS NOT NULL))
      )`,
      `CREATE INDEX IF NOT EXISTS tenant_session_child_commands_pending_idx
        ON ${schema}.tenant_session_child_commands (tenant_id, child_session_id, ordinal)
        WHERE status <> 'completed'`,
    ],
  },
  {
    version: 14,
    name: 'child_command_dispatch_fence',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_session_child_commands
        ADD COLUMN dispatched_at timestamptz`,
    ],
  },
  {
    version: 15,
    name: 'child_command_dispatch_owner_provenance',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_session_child_commands
        ADD COLUMN dispatched_owner_generation bigint`,
    ],
  },
  {
    version: 16,
    name: 'child_command_completion_outbox',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_session_child_commands
        ADD COLUMN completed_at timestamptz,
        ADD COLUMN completion_notified_at timestamptz`,
      `CREATE INDEX tenant_session_child_commands_completion_idx
        ON ${schema}.tenant_session_child_commands (tenant_id, parent_session_id, child_session_id)
        WHERE kind = 'message' AND status = 'completed' AND completion_notified_at IS NULL`,
      `CREATE INDEX tenant_session_child_commands_fanout_idx
        ON ${schema}.tenant_session_child_commands (tenant_id, parent_session_id, completed_at, child_session_id)
        WHERE kind = 'message' AND status = 'completed' AND completed_at IS NOT NULL
          AND outcome->>'ok' = 'true'`,
    ],
  },
  {
    version: 17,
    name: 'child_command_budgets',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_session_child_commands
        ADD COLUMN timeout_ms integer CHECK (timeout_ms > 0),
        ADD COLUMN max_turns integer CHECK (max_turns > 0)`,
    ],
  },
  {
    version: 18,
    name: 'commit_ordered_child_completion_fanout',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_session_child_commands
        ADD COLUMN completion_sequence bigint CHECK (completion_sequence > 0)`,
      `WITH ranked AS (
        SELECT tenant_id, child_session_id, command_id,
          row_number() OVER (PARTITION BY tenant_id, parent_session_id
            ORDER BY completed_at, child_session_id)::bigint AS sequence
        FROM ${schema}.tenant_session_child_commands
        WHERE kind = 'message' AND status = 'completed' AND completed_at IS NOT NULL
          AND outcome->>'ok' = 'true'
      )
      UPDATE ${schema}.tenant_session_child_commands AS commands SET completion_sequence = ranked.sequence
      FROM ranked WHERE commands.tenant_id = ranked.tenant_id
        AND commands.child_session_id = ranked.child_session_id AND commands.command_id = ranked.command_id`,
      `CREATE UNIQUE INDEX tenant_session_child_commands_sequence_idx
        ON ${schema}.tenant_session_child_commands (tenant_id, parent_session_id, completion_sequence)
        WHERE completion_sequence IS NOT NULL`,
      `DROP INDEX IF EXISTS ${schema}.tenant_session_child_commands_fanout_idx`,
      `ALTER TABLE ${schema}.tenant_session_child_commands
        ADD CONSTRAINT tenant_session_child_commands_sequence_required
        CHECK (kind <> 'message' OR status <> 'completed' OR outcome->>'ok' <> 'true'
          OR completed_at IS NULL OR completion_sequence IS NOT NULL)`,
    ],
  },
  {
    version: 19,
    name: 'active_workspace_effect_barrier',
    statements: (schema) => [
      `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_active_workspace_effects (
        organization_id text NOT NULL,
        unit_id text NOT NULL,
        resource_type text NOT NULL CHECK (resource_type = 'session'),
        resource_id text NOT NULL,
        effect_id text NOT NULL,
        owner_token text NOT NULL,
        generation bigint NOT NULL CHECK (generation > 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_type, resource_id, effect_id),
        FOREIGN KEY (organization_id, unit_id, resource_type, resource_id)
          REFERENCES ${schema}.tenant_runtime_resource_ownerships (organization_id, unit_id, resource_type, resource_id)
          ON DELETE RESTRICT
      )`,
    ],
  },
  {
    version: 20,
    name: 'exclusive_workspace_effect_admission',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_runtime_active_workspace_effects
        ADD COLUMN workspace_id text`,
      `CREATE UNIQUE INDEX tenant_runtime_active_workspace_effects_workspace_uidx
        ON ${schema}.tenant_runtime_active_workspace_effects (workspace_id)
        WHERE workspace_id IS NOT NULL`,
    ],
  },
  {
    version: 21,
    name: 'arena_canonical_repository_claim',
    statements: (schema) => [
      `CREATE TABLE ${schema}.tenant_runtime_arena_repository_claims (
        repository_identity text PRIMARY KEY,
        organization_id text NOT NULL,
        unit_id text NOT NULL,
        resource_type text NOT NULL DEFAULT 'session' CHECK (resource_type = 'session'),
        resource_id text NOT NULL,
        arena_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (organization_id, unit_id, resource_type, resource_id)
          REFERENCES ${schema}.tenant_runtime_resource_ownerships (organization_id, unit_id, resource_type, resource_id)
          ON DELETE RESTRICT
      )`,
      `ALTER TABLE ${schema}.tenant_runtime_active_workspace_effects
        ADD COLUMN repository_identity text`,
      `CREATE UNIQUE INDEX tenant_runtime_active_workspace_effects_repo_uidx
        ON ${schema}.tenant_runtime_active_workspace_effects (repository_identity)
        WHERE repository_identity IS NOT NULL`,
    ],
  },
  {
    version: 22,
    name: 'audited_arena_effect_reconciliation',
    statements: (schema) => [
      `CREATE TABLE ${schema}.tenant_runtime_arena_reconciliations (
        organization_id text NOT NULL,
        unit_id text NOT NULL,
        resource_id text NOT NULL,
        effect_id text NOT NULL,
        generation bigint NOT NULL,
        repository_identity text,
        operator_id text NOT NULL,
        incident_id text NOT NULL,
        evidence jsonb NOT NULL,
        reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
    ],
  },
  {
    version: 23,
    name: 'operator_only_arena_effect_reconciliation',
    statements: (schema) => [
      `CREATE FUNCTION ${schema}.kala_reconcile_arena_effect(
        p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
        p_workspace text, p_identity text, p_operator text, p_incident text,
        p_evidence jsonb, p_release_arena text, p_arena_state jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $arena$
        DECLARE owner_row record; effect_row record; latest_state jsonb;
        BEGIN
          IF p_operator IS DISTINCT FROM session_user OR p_operator = ''
            OR p_org = '' OR p_unit = '' OR p_session = '' OR p_effect = ''
            OR p_workspace = '' OR p_identity = '' OR p_incident = ''
            OR p_generation < 1 OR p_evidence IS NULL OR p_arena_state IS NULL
            OR jsonb_typeof(p_evidence) <> 'object'
            OR length(p_evidence::text) > 32000
            OR (p_release_arena IS NOT NULL AND (p_release_arena = ''
              OR p_evidence->>'action' <> 'cleanup')) THEN
            RAISE EXCEPTION 'invalid Arena operator reconciliation' USING ERRCODE = 'P0001';
          END IF;
          SELECT owner_token, generation, expires_at INTO owner_row FROM ${schema}.tenant_runtime_resource_ownerships
            WHERE organization_id = p_org AND unit_id = p_unit
              AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
          SELECT owner_token, generation, workspace_id, repository_identity INTO effect_row
            FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
          IF NOT FOUND OR owner_row.expires_at > clock_timestamp()
            OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
            OR owner_row.generation IS DISTINCT FROM p_generation
            OR effect_row.generation IS DISTINCT FROM p_generation
            OR effect_row.workspace_id IS DISTINCT FROM p_workspace
            OR effect_row.repository_identity IS DISTINCT FROM p_identity THEN
            RAISE EXCEPTION 'Arena effect ownership changed' USING ERRCODE = 'P0001';
          END IF;
          PERFORM 1 FROM ${schema}.tenant_session_latest_projection
            WHERE tenant_id = p_org AND session_id = p_session AND document IS NOT NULL
              AND NOT document ? '__kalaSessionDeletion' FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Arena Session is not live' USING ERRCODE = 'P0001'; END IF;
          SELECT events.payload #> '{entry,payload,arena}' INTO latest_state
            FROM ${schema}.tenant_runtime_hot_events AS events
            WHERE events.tenant_id = p_org AND events.scope_type = 'session' AND events.scope_id = p_session
              AND events.payload #>> '{entry,kind}' = 'runtime_metadata'
              AND events.payload #>> '{entry,action}' = 'worktree_arena.state'
            ORDER BY events.sequence DESC LIMIT 1;
          IF latest_state IS DISTINCT FROM p_arena_state THEN
            RAISE EXCEPTION 'Arena state changed after verification' USING ERRCODE = 'P0001';
          END IF;
          IF p_release_arena IS NOT NULL THEN
            DELETE FROM ${schema}.tenant_runtime_arena_repository_claims
              WHERE repository_identity = p_identity AND organization_id = p_org
                AND unit_id = p_unit AND resource_id = p_session AND arena_id = p_release_arena;
            IF NOT FOUND THEN RAISE EXCEPTION 'Arena claim changed' USING ERRCODE = 'P0001'; END IF;
          END IF;
          INSERT INTO ${schema}.tenant_runtime_arena_reconciliations
            (organization_id, unit_id, resource_id, effect_id, generation, repository_identity,
             operator_id, incident_id, evidence)
            VALUES (p_org, p_unit, p_session, p_effect, p_generation, p_identity,
              p_operator, p_incident, p_evidence);
          DELETE FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect AND owner_token = effect_row.owner_token
              AND generation = p_generation AND workspace_id = p_workspace
              AND repository_identity = p_identity;
          IF NOT FOUND THEN RAISE EXCEPTION 'Arena effect changed' USING ERRCODE = 'P0001'; END IF;
        END
        $arena$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_reconcile_arena_effect(
        text, text, text, text, bigint, text, text, text, text, jsonb, text, jsonb) FROM PUBLIC`,
      `CREATE FUNCTION ${schema}.kala_arena_operator_state(p_org text, p_session text)
        RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $arena$
          SELECT events.payload #> '{entry,payload,arena}'
          FROM ${schema}.tenant_runtime_hot_events AS events
          WHERE events.tenant_id = p_org AND events.scope_type = 'session' AND events.scope_id = p_session
            AND events.payload #>> '{entry,kind}' = 'runtime_metadata'
            AND events.payload #>> '{entry,action}' = 'worktree_arena.state'
            AND EXISTS (SELECT 1 FROM ${schema}.tenant_session_latest_projection AS projection
              WHERE projection.tenant_id = p_org AND projection.session_id = p_session
                AND projection.document IS NOT NULL
                AND NOT projection.document ? '__kalaSessionDeletion')
          ORDER BY events.sequence DESC LIMIT 1
        $arena$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_arena_operator_state(text, text) FROM PUBLIC`,
      `CREATE TABLE ${schema}.tenant_runtime_arena_state_repairs (
        organization_id text NOT NULL,
        unit_id text NOT NULL,
        resource_id text NOT NULL,
        effect_id text NOT NULL,
        generation bigint NOT NULL,
        operator_id text NOT NULL,
        incident_id text NOT NULL,
        old_state jsonb NOT NULL,
        new_state jsonb NOT NULL,
        evidence jsonb NOT NULL,
        repaired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
      `CREATE FUNCTION ${schema}.kala_arena_repair_init(
        p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
        p_workspace text, p_identity text, p_operator text, p_incident text,
        p_old jsonb, p_new jsonb, p_evidence jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $arena$
        DECLARE owner_row record; effect_row record; lease_row record; projection_row record;
          current_state jsonb; old_candidate jsonb; new_candidate jsonb; next_sequence bigint; index_number integer;
        BEGIN
          IF p_operator IS DISTINCT FROM session_user OR p_operator = '' OR p_incident = ''
            OR p_org = '' OR p_unit = '' OR p_session = '' OR p_workspace = '' OR p_identity = ''
            OR p_effect !~ '^arena-init-[A-Z0-9]+$' OR p_generation < 1
            OR p_old->>'status' IS DISTINCT FROM 'initializing'
            OR p_new->>'status' IS DISTINCT FROM 'active'
            OR p_old->>'arenaId' IS DISTINCT FROM p_new->>'arenaId'
            OR p_old->>'baseRef' IS DISTINCT FROM p_new->>'baseRef'
            OR p_new->>'repositoryIdentity' IS DISTINCT FROM p_identity
            OR p_new->>'baseSha' !~ '^[a-f0-9]{40,64}$'
            OR p_new->>'repoRoot' IS NULL
            OR jsonb_typeof(p_old->'candidates') IS DISTINCT FROM 'array'
            OR jsonb_typeof(p_new->'candidates') IS DISTINCT FROM 'array'
            OR jsonb_array_length(p_old->'candidates') NOT BETWEEN 1 AND 6
            OR jsonb_array_length(p_old->'candidates') <> jsonb_array_length(p_new->'candidates')
            OR p_evidence IS NULL OR length(p_evidence::text) > 32000
            OR length(p_new::text) > 32000 THEN
            RAISE EXCEPTION 'invalid Arena init repair' USING ERRCODE = 'P0001';
          END IF;
          FOR index_number IN 0..jsonb_array_length(p_old->'candidates') - 1 LOOP
            old_candidate := p_old->'candidates'->index_number;
            new_candidate := p_new->'candidates'->index_number;
            IF old_candidate->>'status' IS DISTINCT FROM 'pending'
              OR new_candidate->>'status' IS DISTINCT FROM 'active'
              OR old_candidate->>'id' !~ '^[A-Za-z0-9_-]{1,48}$'
              OR old_candidate->>'branch' IS DISTINCT FROM
                ('kala-arena/' || (p_old->>'arenaId') || '/' || (old_candidate->>'id'))
              OR new_candidate - 'status' - 'worktreePath' IS DISTINCT FROM
                old_candidate - 'status' - 'worktreePath'
              OR new_candidate->>'worktreePath' IS DISTINCT FROM
                (p_new->>'repoRoot') || '/.kala-arena/' || (p_new->>'arenaId') || '/' || (new_candidate->>'id') THEN
              RAISE EXCEPTION 'Arena candidate repair changed identity' USING ERRCODE = 'P0001';
            END IF;
          END LOOP;
          SELECT owner_token, generation, expires_at INTO owner_row FROM ${schema}.tenant_runtime_resource_ownerships
            WHERE organization_id = p_org AND unit_id = p_unit
              AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
          SELECT owner_token, generation, workspace_id, repository_identity INTO effect_row
            FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
          IF NOT FOUND OR owner_row.expires_at > clock_timestamp()
            OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
            OR owner_row.generation IS DISTINCT FROM p_generation
            OR effect_row.generation IS DISTINCT FROM p_generation
            OR effect_row.workspace_id IS DISTINCT FROM p_workspace
            OR effect_row.repository_identity IS DISTINCT FROM p_identity THEN
            RAISE EXCEPTION 'Arena init repair ownership changed' USING ERRCODE = 'P0001';
          END IF;
          SELECT last_sequence, generation INTO lease_row FROM ${schema}.tenant_runtime_hot_leases
            WHERE tenant_id = p_org AND scope_type = 'session' AND scope_id = p_session FOR UPDATE;
          SELECT version, document INTO projection_row FROM ${schema}.tenant_session_latest_projection
            WHERE tenant_id = p_org AND session_id = p_session FOR UPDATE;
          IF NOT FOUND OR projection_row.document IS NULL
            OR projection_row.document ? '__kalaSessionDeletion'
            OR projection_row.version IS DISTINCT FROM lease_row.last_sequence THEN
            RAISE EXCEPTION 'Arena Session projection is not current' USING ERRCODE = 'P0001';
          END IF;
          SELECT events.payload #> '{entry,payload,arena}' INTO current_state
            FROM ${schema}.tenant_runtime_hot_events AS events
            WHERE events.tenant_id = p_org AND events.scope_type = 'session' AND events.scope_id = p_session
              AND events.payload #>> '{entry,kind}' = 'runtime_metadata'
              AND events.payload #>> '{entry,action}' = 'worktree_arena.state'
            ORDER BY events.sequence DESC LIMIT 1;
          IF current_state IS DISTINCT FROM p_old THEN
            RAISE EXCEPTION 'Arena state changed after verification' USING ERRCODE = 'P0001';
          END IF;
          next_sequence := lease_row.last_sequence + 1;
          INSERT INTO ${schema}.tenant_runtime_hot_events
            (tenant_id, scope_type, scope_id, sequence, generation, idempotency_key, event_type, payload)
            VALUES (p_org, 'session', p_session, next_sequence, lease_row.generation,
              'arena.operator.init.repair:' || p_effect, 'runtime.metadata.worktree_arena.state',
              jsonb_build_object('schemaVersion', 3, 'baseVersion', lease_row.last_sequence::text,
                'delta', '[]'::jsonb, 'entry', jsonb_build_object(
                  'kind', 'runtime_metadata', 'ts', to_char(clock_timestamp() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'sessionId', p_session,
                  'action', 'worktree_arena.state', 'payload', jsonb_build_object('arena', p_new))));
          UPDATE ${schema}.tenant_session_latest_projection
            SET version = next_sequence, updated_at = clock_timestamp()
            WHERE tenant_id = p_org AND session_id = p_session;
          UPDATE ${schema}.tenant_runtime_hot_leases
            SET last_sequence = next_sequence, updated_at = clock_timestamp()
            WHERE tenant_id = p_org AND scope_type = 'session' AND scope_id = p_session;
          INSERT INTO ${schema}.tenant_runtime_arena_state_repairs
            (organization_id, unit_id, resource_id, effect_id, generation,
              operator_id, incident_id, old_state, new_state, evidence)
            VALUES (p_org, p_unit, p_session, p_effect, p_generation,
              p_operator, p_incident, p_old, p_new, p_evidence);
        END
        $arena$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_arena_repair_init(
        text, text, text, text, bigint, text, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC`,
    ],
  },
  {
    version: 24,
    name: 'tenant_scoped_arena_incident_operator',
    statements: (schema) => {
      const previous = migrations.find((migration) => migration.version === 23)!.statements(schema)
      const scoped = previous.filter((statement) => statement.startsWith('CREATE FUNCTION'))
        .map((statement) => {
          if (statement.includes('kala_arena_operator_state(')) {
            return statement.replace('WHERE events.tenant_id = p_org', () => `WHERE session_user = 'arena_operator_' || replace(p_org, '-', '')
            AND p_org ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            AND events.tenant_id = p_org`).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
          }
          const anchor = 'IF p_operator IS DISTINCT FROM session_user OR p_operator = '
          if (!statement.includes(anchor)) throw new Error('Arena operator function guard changed')
          return statement.replace(anchor, () => `IF p_operator IS DISTINCT FROM session_user
            OR session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR p_operator = `).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        })
      if (scoped.length !== 3) throw new Error('Expected three Arena operator functions')
      return [
        ...scoped,
        `CREATE FUNCTION ${schema}.kala_arena_operator_effects(
          p_org text, p_unit text, p_session text, p_limit integer)
          RETURNS TABLE(effect_id text, generation bigint, workspace_id text,
            repository_identity text, created_at timestamptz)
          LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $arena$
          BEGIN
            IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
              OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
              OR p_limit NOT BETWEEN 1 AND 100 THEN
              RAISE EXCEPTION 'Arena operator tenant mismatch' USING ERRCODE = 'P0001';
            END IF;
            RETURN QUERY SELECT effects.effect_id, effects.generation,
              effects.workspace_id, effects.repository_identity, effects.created_at
              FROM ${schema}.tenant_runtime_active_workspace_effects AS effects
              WHERE effects.organization_id = p_org AND effects.unit_id = p_unit
                AND effects.resource_type = 'session' AND effects.resource_id = p_session
              ORDER BY effects.created_at, effects.effect_id LIMIT p_limit;
          END
          $arena$`,
        `REVOKE ALL ON FUNCTION ${schema}.kala_arena_operator_effects(text,text,text,integer) FROM PUBLIC`,
        // Remove the Arena v23 column grant from any previously provisioned operator, without
        // changing unrelated Runtime DML grants. Its functions are now tenant-checked.
        `DO $arena$ DECLARE role_name text; BEGIN
          FOR role_name IN
            SELECT DISTINCT roles.rolname FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(proc.proacl) AS acl
            JOIN pg_catalog.pg_roles AS roles ON roles.oid = acl.grantee
            WHERE proc.oid = '${schema}.kala_arena_operator_state(text,text)'::regprocedure
              AND acl.privilege_type = 'EXECUTE'
          LOOP
            EXECUTE 'REVOKE SELECT (organization_id, unit_id, resource_type, resource_id,
              effect_id, generation, workspace_id, repository_identity, created_at)
              ON ${schema}.tenant_runtime_active_workspace_effects FROM ' ||
              pg_catalog.quote_ident(role_name);
          END LOOP;
        END $arena$`,
      ]
    },
  },
  {
    version: 25,
    name: 'durable_arena_dispatch_intent',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_runtime_active_workspace_effects
        ADD COLUMN dispatch_started boolean NOT NULL DEFAULT true`,
      `CREATE TABLE ${schema}.tenant_runtime_arena_non_admissions (
        organization_id text NOT NULL, unit_id text NOT NULL, resource_id text NOT NULL,
        effect_id text NOT NULL, generation bigint NOT NULL, workspace_id text NOT NULL,
        reason text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
    ],
  },
  {
    version: 26,
    name: 'scoped_offline_arena_effect_reconciliation',
    statements: (schema) => [
      `ALTER TABLE ${schema}.tenant_runtime_active_workspace_effects
        ADD COLUMN request_digest text CHECK (request_digest ~ '^[a-f0-9]{64}$')`,
      `CREATE FUNCTION ${schema}.kala_arena_operator_dispatch(
        p_org text, p_unit text, p_session text, p_effect text)
        RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp AS $arena$
        DECLARE record_row record;
        BEGIN
          IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Arena operator tenant mismatch' USING ERRCODE = 'P0001';
          END IF;
          SELECT dispatch_started, request_digest INTO record_row FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect;
          IF NOT FOUND THEN RETURN NULL; END IF;
          RETURN jsonb_build_object('started', record_row.dispatch_started, 'digest', record_row.request_digest);
        END
        $arena$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_arena_operator_dispatch(text,text,text,text) FROM PUBLIC`,
      `CREATE FUNCTION ${schema}.kala_reconcile_arena_offline(
        p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
        p_workspace text, p_operator text, p_incident text, p_evidence jsonb,
        p_arena_state jsonb, p_mode text)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $arena$
        DECLARE owner_row record; effect_row record; latest_state jsonb;
        BEGIN
          IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR p_operator IS DISTINCT FROM session_user OR p_incident IS NULL OR p_incident = ''
            OR p_session IS NULL OR p_session = '' OR p_workspace IS NULL OR p_workspace = ''
            OR p_generation < 1 OR COALESCE(p_effect, '') !~ '^arena-(probe|init|apply|cleanup|status|diff)-[A-Z0-9]+$'
            OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
            OR length(p_evidence::text) > 32000 OR COALESCE(p_mode, '') NOT IN ('prepared', 'probe')
            OR (p_mode = 'prepared' AND (p_evidence->>'dispatchStarted' IS DISTINCT FROM 'false'
              OR p_evidence->>'action' IS DISTINCT FROM 'prepared'))
            OR (p_mode = 'probe' AND (COALESCE(p_effect, '') !~ '^arena-probe-[A-Z0-9]+$'
              OR p_evidence->>'receiptState' IS DISTINCT FROM 'completed'
              OR p_evidence->>'receiptGeneration' IS DISTINCT FROM p_generation::text
              OR p_evidence->>'finalEffectStopped' IS DISTINCT FROM 'true'
              OR p_evidence->>'executorStopped' IS DISTINCT FROM 'true'
              OR p_evidence->>'gitGroupsStopped' IS DISTINCT FROM 'true'
              OR COALESCE(p_evidence->>'requestDigest', '') !~ '^[a-f0-9]{64}$'
              OR COALESCE(p_evidence->>'journalSha256', '') !~ '^[a-f0-9]{64}$')) THEN
            RAISE EXCEPTION 'invalid offline Arena reconciliation' USING ERRCODE = 'P0001';
          END IF;
          SELECT owner_token, generation, expires_at INTO owner_row
            FROM ${schema}.tenant_runtime_resource_ownerships
            WHERE organization_id = p_org AND unit_id = p_unit
              AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
          SELECT owner_token, generation, workspace_id, repository_identity, dispatch_started, request_digest
            INTO effect_row FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
          IF NOT FOUND OR owner_row.generation IS NULL OR owner_row.expires_at > clock_timestamp()
            OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
            OR owner_row.generation IS DISTINCT FROM p_generation
            OR effect_row.generation IS DISTINCT FROM p_generation
            OR effect_row.workspace_id IS DISTINCT FROM p_workspace
            OR effect_row.dispatch_started IS DISTINCT FROM (p_mode = 'probe')
            OR (p_mode = 'probe' AND (effect_row.repository_identity IS NOT NULL
              OR effect_row.request_digest IS DISTINCT FROM p_evidence->>'requestDigest')) THEN
            RAISE EXCEPTION 'Arena effect ownership or dispatch changed' USING ERRCODE = 'P0001';
          END IF;
          PERFORM 1 FROM ${schema}.tenant_session_latest_projection
            WHERE tenant_id = p_org AND session_id = p_session AND document IS NOT NULL
              AND NOT document ? '__kalaSessionDeletion' FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Arena Session is not live' USING ERRCODE = 'P0001'; END IF;
          SELECT events.payload #> '{entry,payload,arena}' INTO latest_state
            FROM ${schema}.tenant_runtime_hot_events AS events
            WHERE events.tenant_id = p_org AND events.scope_type = 'session' AND events.scope_id = p_session
              AND events.payload #>> '{entry,kind}' = 'runtime_metadata'
              AND events.payload #>> '{entry,action}' = 'worktree_arena.state'
            ORDER BY events.sequence DESC LIMIT 1;
          IF latest_state IS DISTINCT FROM p_arena_state THEN
            RAISE EXCEPTION 'Arena state changed after verification' USING ERRCODE = 'P0001';
          END IF;
          INSERT INTO ${schema}.tenant_runtime_arena_reconciliations
            (organization_id, unit_id, resource_id, effect_id, generation, repository_identity,
              operator_id, incident_id, evidence)
            VALUES (p_org, p_unit, p_session, p_effect, p_generation,
              effect_row.repository_identity, p_operator, p_incident, p_evidence);
          DELETE FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect AND owner_token = effect_row.owner_token
              AND generation = p_generation AND workspace_id = p_workspace
              AND dispatch_started = (p_mode = 'probe');
          IF NOT FOUND THEN RAISE EXCEPTION 'Arena effect changed' USING ERRCODE = 'P0001'; END IF;
        END
        $arena$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_reconcile_arena_offline(
        text,text,text,text,bigint,text,text,text,jsonb,jsonb,text) FROM PUBLIC`,
    ],
  },
  {
    version: 27,
    name: 'atomic_arena_init_cleanup_and_legacy_operator_repair',
    statements: (schema) => {
      const offline = migrations.find((migration) => migration.version === 26)!.statements(schema)
        .find((statement) => statement.startsWith(`CREATE FUNCTION ${schema}.kala_reconcile_arena_offline(`))
      const scoped = migrations.find((migration) => migration.version === 24)!.statements(schema)
        .find((statement) => statement.startsWith(`CREATE OR REPLACE FUNCTION ${schema}.kala_reconcile_arena_effect(`))
      if (!offline || !scoped) throw new Error('Missing scoped Arena operator migration')
      return [
        offline.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace(
          `OR effect_row.dispatch_started IS DISTINCT FROM (p_mode = 'probe')`,
          () => `OR effect_row.dispatch_started IS DISTINCT FROM (p_mode = 'probe')
            OR (p_mode = 'prepared' AND p_effect ~ '^arena-init-[A-Z0-9]+$'
              AND effect_row.repository_identity IS NOT NULL)`),
        scoped.replace(`IF NOT FOUND THEN RAISE EXCEPTION 'Arena claim changed' USING ERRCODE = 'P0001'; END IF;`,
          `IF NOT FOUND THEN
              IF p_evidence->>'claimMissing' IS DISTINCT FROM 'true'
                OR EXISTS (SELECT 1 FROM ${schema}.tenant_runtime_arena_repository_claims
                  WHERE repository_identity = p_identity) THEN
                RAISE EXCEPTION 'Arena claim changed' USING ERRCODE = 'P0001';
              END IF;
            ELSIF p_evidence->>'claimMissing' = 'true' THEN
              RAISE EXCEPTION 'Arena claim evidence changed' USING ERRCODE = 'P0001';
            END IF;`),
        `CREATE FUNCTION ${schema}.kala_arena_operator_claim(
          p_org text, p_unit text, p_session text, p_identity text)
          RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
          SET search_path = pg_catalog, pg_temp AS $arena$
          DECLARE found_arena text;
          BEGIN
            IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
              OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
              RAISE EXCEPTION 'Arena operator tenant mismatch' USING ERRCODE = 'P0001';
            END IF;
            SELECT arena_id INTO found_arena FROM ${schema}.tenant_runtime_arena_repository_claims
              WHERE repository_identity = p_identity AND organization_id = p_org
                AND unit_id = p_unit AND resource_id = p_session;
            RETURN found_arena;
          END
          $arena$`,
        `REVOKE ALL ON FUNCTION ${schema}.kala_arena_operator_claim(text,text,text,text) FROM PUBLIC`,
        `CREATE FUNCTION ${schema}.kala_reconcile_arena_prepared_init(
          p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
          p_workspace text, p_operator text, p_incident text, p_evidence jsonb, p_arena_state jsonb)
          RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $arena$
          DECLARE owner_row record; effect_row record; claim_row record; lease_row record;
            projection_row record; current_state jsonb; prior_state jsonb; next_sequence bigint;
          BEGIN
            IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
              OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
              OR p_operator IS DISTINCT FROM session_user OR p_incident IS NULL OR p_incident = ''
              OR COALESCE(p_effect, '') !~ '^arena-init-[A-Z0-9]+$'
              OR p_workspace IS NULL OR p_workspace = '' OR p_generation < 1
              OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
              OR length(p_evidence::text) > 32000
              OR p_evidence->>'dispatchStarted' IS DISTINCT FROM 'false'
              OR p_evidence->>'action' IS DISTINCT FROM 'prepared' THEN
              RAISE EXCEPTION 'invalid prepared init reconciliation' USING ERRCODE = 'P0001';
            END IF;
            SELECT owner_token, generation, expires_at INTO owner_row
              FROM ${schema}.tenant_runtime_resource_ownerships
              WHERE organization_id = p_org AND unit_id = p_unit
                AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
            SELECT owner_token, generation, workspace_id, repository_identity, dispatch_started
              INTO effect_row FROM ${schema}.tenant_runtime_active_workspace_effects
              WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
                AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
            IF NOT FOUND OR owner_row.generation IS NULL OR owner_row.expires_at > clock_timestamp()
              OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
              OR owner_row.generation IS DISTINCT FROM p_generation
              OR effect_row.generation IS DISTINCT FROM p_generation
              OR effect_row.workspace_id IS DISTINCT FROM p_workspace
              OR effect_row.repository_identity IS NULL OR effect_row.dispatch_started IS DISTINCT FROM false THEN
              RAISE EXCEPTION 'prepared init ownership or dispatch changed' USING ERRCODE = 'P0001';
            END IF;
            SELECT arena_id INTO claim_row FROM ${schema}.tenant_runtime_arena_repository_claims
              WHERE repository_identity = effect_row.repository_identity AND organization_id = p_org
                AND unit_id = p_unit AND resource_id = p_session FOR UPDATE;
            IF NOT FOUND THEN RAISE EXCEPTION 'prepared init claim missing' USING ERRCODE = 'P0001'; END IF;
            SELECT last_sequence, generation INTO lease_row FROM ${schema}.tenant_runtime_hot_leases
              WHERE tenant_id = p_org AND scope_type = 'session' AND scope_id = p_session FOR UPDATE;
            SELECT version, document INTO projection_row FROM ${schema}.tenant_session_latest_projection
              WHERE tenant_id = p_org AND session_id = p_session FOR UPDATE;
            IF NOT FOUND OR projection_row.document IS NULL OR projection_row.document ? '__kalaSessionDeletion'
              OR projection_row.version IS DISTINCT FROM lease_row.last_sequence THEN
              RAISE EXCEPTION 'prepared init Session projection changed' USING ERRCODE = 'P0001';
            END IF;
            SELECT events.payload #> '{entry,payload,arena}' INTO current_state
              FROM ${schema}.tenant_runtime_hot_events AS events
              WHERE events.tenant_id = p_org AND events.scope_type = 'session' AND events.scope_id = p_session
                AND events.payload #>> '{entry,kind}' = 'runtime_metadata'
                AND events.payload #>> '{entry,action}' = 'worktree_arena.state'
              ORDER BY events.sequence DESC LIMIT 1;
            IF current_state = 'null'::jsonb THEN current_state := NULL; END IF;
            IF current_state IS DISTINCT FROM p_arena_state
              OR (current_state IS NOT NULL AND (current_state->>'status' IS NULL
                OR current_state->>'status' NOT IN ('cleaned', 'initializing')))
              OR (current_state->>'status' = 'initializing'
                AND current_state->>'arenaId' IS DISTINCT FROM claim_row.arena_id) THEN
              RAISE EXCEPTION 'prepared init Arena state changed' USING ERRCODE = 'P0001';
            END IF;
            IF current_state->>'status' = 'initializing' THEN
              SELECT events.payload #> '{entry,payload,arena}' INTO prior_state
                FROM ${schema}.tenant_runtime_hot_events AS events
                WHERE events.tenant_id = p_org AND events.scope_type = 'session' AND events.scope_id = p_session
                  AND events.payload #>> '{entry,kind}' = 'runtime_metadata'
                  AND events.payload #>> '{entry,action}' = 'worktree_arena.state'
                ORDER BY events.sequence DESC OFFSET 1 LIMIT 1;
              IF prior_state = 'null'::jsonb THEN prior_state := NULL; END IF;
              IF prior_state IS NOT NULL AND prior_state->>'status' IS DISTINCT FROM 'cleaned' THEN
                RAISE EXCEPTION 'prepared init prior Arena state cannot be restored' USING ERRCODE = 'P0001';
              END IF;
              next_sequence := lease_row.last_sequence + 1;
              INSERT INTO ${schema}.tenant_runtime_hot_events
                (tenant_id, scope_type, scope_id, sequence, generation, idempotency_key, event_type, payload)
                VALUES (p_org, 'session', p_session, next_sequence, lease_row.generation,
                  'arena.operator.init.not_dispatched:' || p_effect, 'runtime.metadata.worktree_arena.state',
                  jsonb_build_object('schemaVersion', 3, 'baseVersion', lease_row.last_sequence::text,
                    'delta', '[]'::jsonb, 'entry', jsonb_build_object(
                      'kind', 'runtime_metadata', 'ts', to_char(clock_timestamp() AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'sessionId', p_session,
                      'action', 'worktree_arena.state', 'payload',
                      jsonb_build_object('arena', prior_state))));
              UPDATE ${schema}.tenant_session_latest_projection
                SET version = next_sequence, updated_at = clock_timestamp()
                WHERE tenant_id = p_org AND session_id = p_session;
              UPDATE ${schema}.tenant_runtime_hot_leases
                SET last_sequence = next_sequence, updated_at = clock_timestamp()
                WHERE tenant_id = p_org AND scope_type = 'session' AND scope_id = p_session;
            END IF;
            DELETE FROM ${schema}.tenant_runtime_arena_repository_claims
              WHERE repository_identity = effect_row.repository_identity AND organization_id = p_org
                AND unit_id = p_unit AND resource_id = p_session AND arena_id = claim_row.arena_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'prepared init claim changed' USING ERRCODE = 'P0001'; END IF;
            INSERT INTO ${schema}.tenant_runtime_arena_reconciliations
              (organization_id, unit_id, resource_id, effect_id, generation, repository_identity,
                operator_id, incident_id, evidence)
              VALUES (p_org, p_unit, p_session, p_effect, p_generation,
                effect_row.repository_identity, p_operator, p_incident,
                p_evidence || jsonb_build_object('claimReleased', claim_row.arena_id,
                  'priorArenaRestored', COALESCE(current_state->>'status' = 'initializing', false)));
            DELETE FROM ${schema}.tenant_runtime_active_workspace_effects
              WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
                AND resource_id = p_session AND effect_id = p_effect AND owner_token = effect_row.owner_token
                AND generation = p_generation AND workspace_id = p_workspace AND dispatch_started = false;
            IF NOT FOUND THEN RAISE EXCEPTION 'prepared init effect changed' USING ERRCODE = 'P0001'; END IF;
          END
          $arena$`,
        `REVOKE ALL ON FUNCTION ${schema}.kala_reconcile_arena_prepared_init(
          text,text,text,text,bigint,text,text,text,jsonb,jsonb) FROM PUBLIC`,
      ]
    },
  },
  {
    version: 28,
    name: 'durable_shared_owner_background_learning_claims',
    statements: (schema) => [
      `CREATE TABLE IF NOT EXISTS ${schema}.tenant_runtime_background_learning_jobs (
        organization_id text NOT NULL,
        unit_id text NOT NULL,
        resource_id text NOT NULL,
        fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        status text NOT NULL CHECK (status IN ('pending', 'attempted', 'completed')),
        owner_generation bigint,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        attempted_at timestamptz,
        completed_at timestamptz,
        error text,
        PRIMARY KEY (organization_id, unit_id, resource_id, fingerprint),
        CHECK ((status = 'pending' AND owner_generation IS NULL AND attempted_at IS NULL)
          OR (status IN ('attempted', 'completed') AND owner_generation > 0 AND attempted_at IS NOT NULL))
      )`,
      `CREATE INDEX IF NOT EXISTS tenant_runtime_background_learning_pending_idx
        ON ${schema}.tenant_runtime_background_learning_jobs
        (organization_id, unit_id, resource_id, created_at) WHERE status = 'pending'`,
    ],
  },
  {
    version: 29,
    name: 'scoped_learning_prepared_effect_reconciliation',
    statements: (schema) => [
      `CREATE TABLE ${schema}.tenant_runtime_learning_reconciliations (
        organization_id text NOT NULL,
        unit_id text NOT NULL,
        resource_id text NOT NULL,
        effect_id text NOT NULL,
        generation bigint NOT NULL,
        workspace_id text NOT NULL,
        operator_id text NOT NULL,
        incident_id text NOT NULL,
        proof text NOT NULL CHECK (proof = 'never_dispatched'),
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
      `CREATE FUNCTION ${schema}.kala_reconcile_learning_prepared(
        p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
        p_workspace text, p_operator text, p_incident text)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $learning$
        DECLARE owner_row record; effect_row record;
        BEGIN
          IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR p_operator IS DISTINCT FROM session_user OR COALESCE(p_incident, '') = ''
            OR COALESCE(p_session, '') = '' OR COALESCE(p_workspace, '') = ''
            OR p_generation < 1 OR NOT (
              COALESCE(p_effect, '') ~ '^skill-file-[0-9A-HJKMNP-TV-Z]{26}$'
              OR COALESCE(p_effect, '') ~ '^memory-file-[a-f0-9]{64}$'
            ) THEN
            RAISE EXCEPTION 'invalid scoped learning reconciliation' USING ERRCODE = 'P0001';
          END IF;
          SELECT owner_token, generation, expires_at INTO owner_row
            FROM ${schema}.tenant_runtime_resource_ownerships
            WHERE organization_id = p_org AND unit_id = p_unit
              AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
          SELECT owner_token, generation, workspace_id, repository_identity, dispatch_started, request_digest
            INTO effect_row FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
          IF NOT FOUND OR owner_row.generation IS NULL OR owner_row.expires_at > clock_timestamp()
            OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
            OR owner_row.generation IS DISTINCT FROM p_generation
            OR effect_row.generation IS DISTINCT FROM p_generation
            OR effect_row.workspace_id IS DISTINCT FROM p_workspace
            OR effect_row.repository_identity IS NOT NULL
            OR effect_row.dispatch_started IS DISTINCT FROM false
            OR effect_row.request_digest IS NOT NULL THEN
            RAISE EXCEPTION 'learning effect not proven never dispatched' USING ERRCODE = 'P0001';
          END IF;
          PERFORM 1 FROM ${schema}.tenant_session_latest_projection
            WHERE tenant_id = p_org AND session_id = p_session AND document IS NOT NULL
              AND NOT document ? '__kalaSessionDeletion' FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'learning Session is not live' USING ERRCODE = 'P0001'; END IF;
          INSERT INTO ${schema}.tenant_runtime_learning_reconciliations
            (organization_id, unit_id, resource_id, effect_id, generation, workspace_id,
              operator_id, incident_id, proof)
            VALUES (p_org, p_unit, p_session, p_effect, p_generation, p_workspace,
              p_operator, p_incident, 'never_dispatched');
          DELETE FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect
              AND owner_token = effect_row.owner_token AND generation = p_generation
              AND workspace_id = p_workspace AND dispatch_started = false AND request_digest IS NULL;
          IF NOT FOUND THEN RAISE EXCEPTION 'learning effect changed' USING ERRCODE = 'P0001'; END IF;
        END
        $learning$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_reconcile_learning_prepared(
        text,text,text,text,bigint,text,text,text) FROM PUBLIC`,
      `CREATE FUNCTION ${schema}.kala_operator_learning_jobs(
        p_org text, p_unit text, p_session text, p_limit integer)
        RETURNS TABLE(fingerprint text, status text, owner_generation bigint,
          created_at timestamptz, attempted_at timestamptz, completed_at timestamptz, error text)
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $learning$
        BEGIN
          IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR p_limit NOT BETWEEN 1 AND 100 THEN
            RAISE EXCEPTION 'learning operator tenant mismatch' USING ERRCODE = 'P0001';
          END IF;
          RETURN QUERY SELECT jobs.fingerprint, jobs.status, jobs.owner_generation,
            jobs.created_at, jobs.attempted_at, jobs.completed_at, jobs.error
            FROM ${schema}.tenant_runtime_background_learning_jobs AS jobs
            WHERE jobs.organization_id = p_org AND jobs.unit_id = p_unit AND jobs.resource_id = p_session
            ORDER BY jobs.created_at, jobs.fingerprint LIMIT p_limit;
        END
        $learning$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_operator_learning_jobs(text,text,text,integer) FROM PUBLIC`,
    ],
  },
  {
    version: 30,
    name: 'scoped_completed_learning_effect_reconciliation',
    statements: (schema) => [
      `CREATE TABLE ${schema}.tenant_runtime_learning_completed_reconciliations (
        organization_id text NOT NULL, unit_id text NOT NULL, resource_id text NOT NULL,
        effect_id text NOT NULL, generation bigint NOT NULL, workspace_id text NOT NULL,
        request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
        operator_id text NOT NULL, incident_id text NOT NULL, evidence jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
      `CREATE FUNCTION ${schema}.kala_reconcile_learning_completed(
        p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
        p_workspace text, p_operator text, p_incident text, p_evidence jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $learning$
        DECLARE owner_row record; effect_row record;
        BEGIN
          IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR p_operator IS DISTINCT FROM session_user OR COALESCE(p_incident, '') = ''
            OR COALESCE(p_session, '') = '' OR COALESCE(p_workspace, '') = ''
            OR p_generation < 1 OR NOT (
              COALESCE(p_effect, '') ~ '^skill-file-[0-9A-HJKMNP-TV-Z]{26}$'
              OR COALESCE(p_effect, '') ~ '^memory-file-[a-f0-9]{64}$'
            ) OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
            OR length(p_evidence::text) > 16000
            OR COALESCE(p_evidence->>'journalSha256', '') !~ '^[a-f0-9]{64}$'
            OR COALESCE(p_evidence->>'targetPathDigest', '') !~ '^[a-f0-9]{64}$'
            OR COALESCE(p_evidence->>'requestDigest', '') !~ '^[a-f0-9]{64}$'
            OR COALESCE(p_evidence->>'resultDigest', '') !~ '^[a-f0-9]{64}$'
            OR p_evidence->>'receiptState' IS DISTINCT FROM 'completed'
            OR p_evidence->>'receiptGeneration' IS DISTINCT FROM p_generation::text
            OR p_evidence->>'toolImplementation' IS DISTINCT FROM 'builtin-v2'
            OR p_evidence->>'resultOk' IS DISTINCT FROM 'true'
            OR p_evidence->>'executorStopped' IS DISTINCT FROM 'true'
            OR p_evidence->>'processGroupsStopped' IS DISTINCT FROM 'true'
            OR p_evidence->>'keeperVerified' IS DISTINCT FROM 'true'
            OR p_evidence->>'finalStateVerified' IS DISTINCT FROM 'true'
            OR (p_effect LIKE 'skill-file-%' AND p_evidence->>'tool' IS DISTINCT FROM 'skill_file')
            OR (p_effect LIKE 'memory-file-%' AND p_evidence->>'tool' IS DISTINCT FROM 'memory')
            OR (p_evidence->>'tool' = 'skill_file'
              AND COALESCE(p_evidence->>'action', '') NOT IN ('create', 'replace', 'delete'))
            OR (p_evidence->>'tool' = 'memory'
              AND COALESCE(p_evidence->>'action', '') NOT IN ('write', 'delete'))
            OR (p_evidence->>'action' IN ('create', 'replace', 'write')
              AND (COALESCE(p_evidence->>'contentDigest', '') !~ '^[a-f0-9]{64}$'
                OR p_evidence->>'contentDigest' IS DISTINCT FROM p_evidence->>'observedDigest'))
            OR (p_evidence->>'action' = 'delete' AND p_evidence ? 'contentDigest')
          THEN RAISE EXCEPTION 'invalid completed learning evidence' USING ERRCODE = 'P0001'; END IF;
          SELECT owner_token, generation, expires_at INTO owner_row
            FROM ${schema}.tenant_runtime_resource_ownerships
            WHERE organization_id = p_org AND unit_id = p_unit
              AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
          SELECT owner_token, generation, workspace_id, repository_identity, dispatch_started, request_digest
            INTO effect_row FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
          IF NOT FOUND OR owner_row.generation IS NULL OR owner_row.expires_at > clock_timestamp()
            OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
            OR owner_row.generation IS DISTINCT FROM p_generation
            OR effect_row.generation IS DISTINCT FROM p_generation
            OR effect_row.workspace_id IS DISTINCT FROM p_workspace
            OR effect_row.repository_identity IS NOT NULL
            OR effect_row.dispatch_started IS DISTINCT FROM true
            OR effect_row.request_digest IS DISTINCT FROM p_evidence->>'requestDigest' THEN
            RAISE EXCEPTION 'learning effect ownership or dispatch changed' USING ERRCODE = 'P0001';
          END IF;
          PERFORM 1 FROM ${schema}.tenant_session_latest_projection
            WHERE tenant_id = p_org AND session_id = p_session AND document IS NOT NULL
              AND NOT document ? '__kalaSessionDeletion' FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'learning Session is not live' USING ERRCODE = 'P0001'; END IF;
          INSERT INTO ${schema}.tenant_runtime_learning_completed_reconciliations
            (organization_id, unit_id, resource_id, effect_id, generation, workspace_id,
              request_digest, operator_id, incident_id, evidence)
            VALUES (p_org, p_unit, p_session, p_effect, p_generation, p_workspace,
              effect_row.request_digest, p_operator, p_incident, p_evidence);
          DELETE FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect
              AND owner_token = effect_row.owner_token AND generation = p_generation
              AND workspace_id = p_workspace AND dispatch_started = true
              AND request_digest = effect_row.request_digest;
          IF NOT FOUND THEN RAISE EXCEPTION 'learning effect changed' USING ERRCODE = 'P0001'; END IF;
        END
        $learning$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_reconcile_learning_completed(
        text,text,text,text,bigint,text,text,text,jsonb) FROM PUBLIC`,
    ],
  },
  {
    version: 31,
    name: 'scoped_never_admitted_learning_effect_reconciliation',
    statements: (schema) => [
      `CREATE TABLE ${schema}.tenant_runtime_learning_denied_reconciliations (
        organization_id text NOT NULL, unit_id text NOT NULL, resource_id text NOT NULL,
        effect_id text NOT NULL, generation bigint NOT NULL, workspace_id text NOT NULL,
        request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
        operator_id text NOT NULL, incident_id text NOT NULL, evidence jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
      `CREATE FUNCTION ${schema}.kala_reconcile_learning_denied(
        p_org text, p_unit text, p_session text, p_effect text, p_generation bigint,
        p_workspace text, p_operator text, p_incident text, p_evidence jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $learning$
        DECLARE owner_row record; effect_row record;
        BEGIN
          IF session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '')
            OR p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR p_operator IS DISTINCT FROM session_user OR COALESCE(p_incident, '') = ''
            OR COALESCE(p_session, '') = '' OR COALESCE(p_workspace, '') = ''
            OR p_generation < 1 OR NOT (
              COALESCE(p_effect, '') ~ '^skill-file-[0-9A-HJKMNP-TV-Z]{26}$'
              OR COALESCE(p_effect, '') ~ '^memory-file-[a-f0-9]{64}$'
            ) OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
            OR length(p_evidence::text) > 16000
            OR COALESCE(p_evidence->>'journalSha256', '') !~ '^[a-f0-9]{64}$'
            OR COALESCE(p_evidence->>'requestDigest', '') !~ '^[a-f0-9]{64}$'
            OR (p_evidence ? 'archiveSha256'
              AND COALESCE(p_evidence->>'archiveSha256', '') !~ '^[a-f0-9]{64}$')
            OR p_evidence->>'receiptState' IS DISTINCT FROM 'denied'
            OR p_evidence->>'neverAdmitted' IS DISTINCT FROM 'true'
            OR p_evidence->>'failureCode' IS DISTINCT FROM 'learning_not_admitted'
            OR p_evidence->>'receiptGeneration' IS DISTINCT FROM p_generation::text
          THEN RAISE EXCEPTION 'invalid never-admitted learning evidence' USING ERRCODE = 'P0001'; END IF;
          SELECT owner_token, generation, expires_at INTO owner_row
            FROM ${schema}.tenant_runtime_resource_ownerships
            WHERE organization_id = p_org AND unit_id = p_unit
              AND resource_type = 'session' AND resource_id = p_session FOR UPDATE;
          SELECT owner_token, generation, workspace_id, repository_identity, dispatch_started, request_digest
            INTO effect_row FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect FOR UPDATE;
          IF NOT FOUND OR owner_row.generation IS NULL OR owner_row.expires_at > clock_timestamp()
            OR owner_row.owner_token IS DISTINCT FROM effect_row.owner_token
            OR owner_row.generation IS DISTINCT FROM p_generation
            OR effect_row.generation IS DISTINCT FROM p_generation
            OR effect_row.workspace_id IS DISTINCT FROM p_workspace
            OR effect_row.repository_identity IS NOT NULL
            OR effect_row.dispatch_started IS DISTINCT FROM true
            OR effect_row.request_digest IS DISTINCT FROM p_evidence->>'requestDigest' THEN
            RAISE EXCEPTION 'learning effect ownership or dispatch changed' USING ERRCODE = 'P0001';
          END IF;
          PERFORM 1 FROM ${schema}.tenant_session_latest_projection
            WHERE tenant_id = p_org AND session_id = p_session AND document IS NOT NULL
              AND NOT document ? '__kalaSessionDeletion' FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'learning Session is not live' USING ERRCODE = 'P0001'; END IF;
          INSERT INTO ${schema}.tenant_runtime_learning_denied_reconciliations
            (organization_id, unit_id, resource_id, effect_id, generation, workspace_id,
              request_digest, operator_id, incident_id, evidence)
            VALUES (p_org, p_unit, p_session, p_effect, p_generation, p_workspace,
              effect_row.request_digest, p_operator, p_incident, p_evidence);
          DELETE FROM ${schema}.tenant_runtime_active_workspace_effects
            WHERE organization_id = p_org AND unit_id = p_unit AND resource_type = 'session'
              AND resource_id = p_session AND effect_id = p_effect
              AND owner_token = effect_row.owner_token AND generation = p_generation
              AND workspace_id = p_workspace AND dispatch_started = true
              AND request_digest = effect_row.request_digest;
          IF NOT FOUND THEN RAISE EXCEPTION 'learning effect changed' USING ERRCODE = 'P0001'; END IF;
        END
        $learning$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_reconcile_learning_denied(
        text,text,text,text,bigint,text,text,text,jsonb) FROM PUBLIC`,
    ],
  },
  {
    version: 32,
    name: 'learning_effect_finalization_evidence',
    statements: (schema) => [
      `CREATE TABLE ${schema}.tenant_runtime_learning_effect_finalizations (
        organization_id text NOT NULL, unit_id text NOT NULL, resource_id text NOT NULL,
        effect_id text NOT NULL, generation bigint NOT NULL, workspace_id text NOT NULL,
        request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
        finalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, unit_id, resource_id, effect_id)
      )`,
      `CREATE FUNCTION ${schema}.kala_record_learning_effect_finalization()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $learning$
        BEGIN
          INSERT INTO ${schema}.tenant_runtime_learning_effect_finalizations
            (organization_id, unit_id, resource_id, effect_id, generation, workspace_id, request_digest)
            VALUES (OLD.organization_id, OLD.unit_id, OLD.resource_id, OLD.effect_id,
              OLD.generation, OLD.workspace_id, OLD.request_digest);
          RETURN OLD;
        END
        $learning$`,
      `CREATE TRIGGER kala_learning_effect_finalization
        AFTER DELETE ON ${schema}.tenant_runtime_active_workspace_effects
        FOR EACH ROW WHEN (
          OLD.dispatch_started = true AND OLD.workspace_id IS NOT NULL
          AND OLD.request_digest ~ '^[a-f0-9]{64}$'
          AND OLD.repository_identity IS NULL
          AND (OLD.effect_id ~ '^skill-file-[0-9A-HJKMNP-TV-Z]{26}$'
            OR OLD.effect_id ~ '^memory-file-[a-f0-9]{64}$'))
        EXECUTE FUNCTION ${schema}.kala_record_learning_effect_finalization()`,
      `CREATE FUNCTION ${schema}.kala_operator_learning_finalization(
        p_org text, p_unit text, p_session text, p_effect text)
        RETURNS TABLE(generation bigint, workspace_id text, request_digest text)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $learning$
        BEGIN
          IF p_org !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            OR session_user IS DISTINCT FROM 'arena_operator_' || replace(p_org, '-', '') THEN
            RAISE EXCEPTION 'wrong learning operator scope' USING ERRCODE = 'P0001';
          END IF;
          RETURN QUERY SELECT f.generation, f.workspace_id, f.request_digest
            FROM ${schema}.tenant_runtime_learning_effect_finalizations f
            WHERE f.organization_id = p_org AND f.unit_id = p_unit
              AND f.resource_id = p_session AND f.effect_id = p_effect;
        END
        $learning$`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_operator_learning_finalization(text,text,text,text) FROM PUBLIC`,
      `REVOKE ALL ON FUNCTION ${schema}.kala_record_learning_effect_finalization() FROM PUBLIC`,
    ],
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

/** An existing individual LOGIN receives only read access and the exact audited reconciliation routine. */
export async function grantPostgresArenaOperator(options: {
  connectionString: string; operatorRole: string; organizationId: string; schema?: string; ssl?: unknown
}): Promise<void> {
  const roleName = validateIdentifier(options.operatorRole, 'operatorRole')
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(options.organizationId)
    || roleName !== `arena_operator_${options.organizationId.replaceAll('-', '')}`) {
    throw new TypeError('Arena operator LOGIN must identify its exact organization')
  }
  if (roleName.length > 63) throw new TypeError('operatorRole exceeds PostgreSQL identifier length')
  const schemaName = validateIdentifier(options.schema ?? 'public', 'schema')
  const schema = quoteIdentifier(schemaName)
  const role = quoteIdentifier(roleName)
  const pool = new Pool({ connectionString: options.connectionString,
    application_name: 'kala-postgres-arena-operator-grants', max: 1, connectionTimeoutMillis: 5_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}) })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertPostgresSchemaCurrent(client, { schema: schemaName })
    const guarded = [...new Set([...postgresRuntimeTables(), 'tenant_runtime_arena_reconciliations',
      'tenant_runtime_arena_state_repairs', 'tenant_runtime_learning_reconciliations',
      'tenant_runtime_learning_completed_reconciliations',
      'tenant_runtime_learning_denied_reconciliations',
      'tenant_runtime_learning_effect_finalizations', POSTGRES_MIGRATION_TABLE])]
      .map((table) => `${schema}.${quoteIdentifier(table)}`)
    const rights = await client.query<{ login: boolean; elevated: boolean; inherits: boolean;
      ddl: boolean; owns: boolean; dml: boolean; excessive_read: boolean }>(`SELECT
      COALESCE((SELECT rolcanlogin FROM pg_roles WHERE rolname = $1), false) AS login,
      COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        FROM pg_roles WHERE rolname = $1), true) AS elevated,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS inherits,
      has_schema_privilege($1, $2, 'CREATE') OR has_database_privilege($1, current_database(), 'CREATE') AS ddl,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2 AND pg_has_role($1, pg_get_userbyid(nspowner), 'MEMBER'))
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $2 AND pg_has_role($1, pg_get_userbyid(c.relowner), 'MEMBER')) AS owns,
      EXISTS (SELECT 1 FROM unnest($3::text[]) AS t(name)
        WHERE has_table_privilege($1, t.name, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) AS dml,
      EXISTS (SELECT 1 FROM unnest($3::text[]) AS t(name)
        WHERE has_table_privilege($1, t.name, 'SELECT')) AS excessive_read`,
    [roleName, schemaName, guarded])
    const actual = rights.rows[0]
    if (!actual?.login || actual.elevated || actual.inherits || actual.ddl || actual.owns
      || actual.dml || actual.excessive_read) {
      throw new Error('Arena operator must be a dedicated unprivileged LOGIN without inherited roles, DDL, table DML or unrelated Runtime reads')
    }
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    await client.query(`REVOKE SELECT (organization_id, unit_id, resource_type, resource_id,
      effect_id, generation, workspace_id, repository_identity, created_at)
      ON ${schema}.tenant_runtime_active_workspace_effects FROM ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_reconcile_arena_effect(
      text, text, text, text, bigint, text, text, text, text, jsonb, text, jsonb) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_arena_operator_state(text, text) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_arena_repair_init(
      text, text, text, text, bigint, text, text, text, text, jsonb, jsonb, jsonb) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_arena_operator_effects(
      text, text, text, integer) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_arena_operator_dispatch(
      text, text, text, text) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_reconcile_arena_offline(
      text, text, text, text, bigint, text, text, text, jsonb, jsonb, text) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_reconcile_arena_prepared_init(
      text, text, text, text, bigint, text, text, text, jsonb, jsonb) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_arena_operator_claim(
      text, text, text, text) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_reconcile_learning_prepared(
      text,text,text,text,bigint,text,text,text) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_operator_learning_jobs(
      text,text,text,integer) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_reconcile_learning_completed(
      text,text,text,text,bigint,text,text,text,jsonb) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_reconcile_learning_denied(
      text,text,text,text,bigint,text,text,text,jsonb) TO ${role}`)
    await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.kala_operator_learning_finalization(
      text,text,text,text) TO ${role}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release(); await pool.end() }
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
    await client.query(`REVOKE UPDATE, DELETE ON TABLE ${schema}.tenant_runtime_arena_non_admissions FROM ${role}`)
    for (const table of postgresRuntimeTables()) {
      const privileges = table === RUNTIME_UNIT_PROTOCOL_GATE_TABLE ? 'SELECT'
        : table === 'tenant_runtime_arena_reconciliations' || table === 'tenant_runtime_arena_non_admissions' ? 'SELECT, INSERT'
          : 'SELECT, INSERT, UPDATE, DELETE'
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
  const recovery = await client.query<{ checkpoint: string | null }>(`SELECT to_regclass('kala_installation_claim.recovery_checkpoint')::text AS checkpoint`)
  if (!recovery.rows[0]?.checkpoint) throw new Error('Installation claim has no coordinated recovery checkpoint')
  const rights = await client.query<{ can_create: boolean; can_write: boolean; owns_schema: boolean; owns_marker: boolean }>(`SELECT
    has_schema_privilege($1, 'kala_installation_claim', 'CREATE') AS can_create,
    EXISTS (SELECT 1 FROM unnest(ARRAY['kala_installation_claim.marker', 'kala_installation_claim.recovery_checkpoint']) AS records(table_name)
      WHERE has_table_privilege($1, records.table_name, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) AS can_write,
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kala_installation_claim'
      AND pg_has_role($1, pg_get_userbyid(nspowner), 'MEMBER')) AS owns_schema,
    EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('kala_installation_claim.marker'::regclass, 'kala_installation_claim.recovery_checkpoint'::regclass)
      AND pg_has_role($1, pg_get_userbyid(relowner), 'MEMBER')) AS owns_marker`, [roleName])
  if (!rights.rows[0] || Object.values(rights.rows[0]).some(Boolean)) {
    throw new Error('Workload role must not own or mutate the installation claim or recovery checkpoint')
  }
  await client.query(`GRANT USAGE ON SCHEMA kala_installation_claim TO ${role}`)
  await client.query(`GRANT SELECT ON TABLE kala_installation_claim.marker, kala_installation_claim.recovery_checkpoint TO ${role}`)
}

function postgresRuntimeTables(): string[] {
  const tables = new Set<string>()
  tables.add('tenant_runtime_arena_non_admissions')
  const schema = '"__kala_schema__"'
  for (const migration of migrations) {
    for (const statement of migration.statements(schema)) {
      if (!statement.startsWith(`CREATE TABLE IF NOT EXISTS ${schema}.`)) continue
      const tableToken = statement.slice(`CREATE TABLE IF NOT EXISTS ${schema}.`.length)
        .match(/^(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/u)
      const table = tableToken?.[1] ?? tableToken?.[2]
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
  options: { schema?: string; throughVersion?: number } = {},
): Promise<PostgresMigrationResult> {
  validateMigrationSequence(migrations)
  if (options.throughVersion !== undefined
    && (!Number.isInteger(options.throughVersion) || options.throughVersion < 1
      || options.throughVersion > LATEST_POSTGRES_SCHEMA_VERSION)) {
    throw new TypeError('Invalid explicit migration target')
  }
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
      if (options.throughVersion !== undefined && migration.version > options.throughVersion) break
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

    return { previousVersion, currentVersion: options.throughVersion ?? LATEST_POSTGRES_SCHEMA_VERSION, appliedVersions }
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
      throw new Error(`PostgreSQL migration ${row.version} does not match this release${
        row.version >= 12 && row.version <= 18
          ? ' (possible private Arena / Board migration identity conflict; back up and review an offline compatibility plan; never renumber applied history)'
          : ''}`)
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

function nativeSessionFsStatements(schema: string): readonly string[] {
  const tables: NativeFsTables = {
    usage: `${schema}."tenant_session_native_fs_usage"`,
    nodes: `${schema}."tenant_session_native_fs_nodes"`,
    chunks: `${schema}."tenant_session_native_fs_chunks"`,
  }
  return nativeFsSchemaStatements(tables)
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
