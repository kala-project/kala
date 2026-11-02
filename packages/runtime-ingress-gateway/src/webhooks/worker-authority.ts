import type { SqlExecutor } from '../persistence/postgres.js'

const fanoutColumns = ['webhook_fanout_state', 'webhook_fanout_error', 'webhook_materialized_at']
const deliveryColumns = ['state', 'attempt_count', 'available_at', 'lease_token', 'lease_generation', 'lease_expires_at', 'last_error', 'last_status', 'completed_at', 'updated_at']

/** Operator pre-creates this identity; migrations never create global roles. */
export async function grantWebhookWorker(database: SqlExecutor, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(role)) throw new Error('Invalid webhook worker role')
  await database.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${role}"`)
  await database.query(`GRANT CONNECT ON DATABASE runlab_control TO "${role}"`)
  await database.query(`GRANT USAGE ON SCHEMA public,kala_installation_claim TO "${role}"`)
  await database.query(`GRANT SELECT ON control_plane_schema_migrations,outbox_events,webhook_endpoints,webhook_deliveries,
    kala_installation_claim.marker,kala_installation_claim.recovery_checkpoint TO "${role}"`)
  await database.query(`GRANT UPDATE (${fanoutColumns.join(',')}) ON outbox_events TO "${role}"`)
  await database.query(`GRANT INSERT ON webhook_deliveries TO "${role}"`)
  await database.query(`GRANT UPDATE (${deliveryColumns.join(',')}) ON webhook_deliveries TO "${role}"`)
  await assertWebhookWorkerPrivileges(database, role)
}

/** Audit effective privileges, including inherited/table/column privileges and ownership. */
export async function assertWebhookWorkerPrivileges(database: SqlExecutor, role?: string): Promise<void> {
  const result = await database.query<{ safe: boolean }>(`WITH identity AS (
    SELECT oid,rolname,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=COALESCE($1,current_user)
  ), relations AS MATERIALIZED (
    SELECT cls.oid,cls.relname,cls.relowner,ns.nspname FROM pg_class cls JOIN pg_namespace ns ON ns.oid=cls.relnamespace
    WHERE cls.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema')
      AND ns.nspname NOT LIKE 'pg_toast%'
  ), audited_columns AS MATERIALIZED (
    SELECT r.*,a.attname FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid
    WHERE a.attnum>0 AND NOT a.attisdropped
  ) SELECT NOT (
    identity.rolsuper OR identity.rolcreaterole OR identity.rolcreatedb OR identity.rolreplication OR identity.rolbypassrls
    OR has_database_privilege(identity.rolname,current_database(),'CREATE')
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=identity.oid)
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
      WHERE p.prosecdef AND ns.nspname NOT IN ('pg_catalog','information_schema')
        AND has_function_privilege(identity.rolname,p.oid,'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_class WHERE CASE WHEN relkind='S'
      THEN has_sequence_privilege(identity.rolname,oid,'USAGE,SELECT,UPDATE') ELSE false END)
    OR EXISTS (SELECT 1 FROM pg_namespace ns WHERE ns.nspname NOT LIKE 'pg_%' AND ns.nspname<>'information_schema'
      AND (has_schema_privilege(identity.rolname,ns.oid,'CREATE') OR pg_has_role(identity.oid,ns.nspowner,'MEMBER')))
    OR EXISTS (SELECT 1 FROM relations r WHERE pg_has_role(identity.oid,r.relowner,'MEMBER')
      OR has_table_privilege(identity.rolname,r.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR (has_table_privilege(identity.rolname,r.oid,'INSERT') AND NOT (r.nspname='public' AND r.relname='webhook_deliveries'))
      OR has_table_privilege(identity.rolname,r.oid,'UPDATE'))
    OR EXISTS (SELECT 1 FROM audited_columns r
      WHERE (has_column_privilege(identity.rolname,r.oid,r.attname,'UPDATE') AND NOT
        (r.nspname='public' AND ((r.relname='outbox_events' AND r.attname=ANY($2::text[]))
          OR (r.relname='webhook_deliveries' AND r.attname=ANY($3::text[])))))
      OR (has_column_privilege(identity.rolname,r.oid,r.attname,'INSERT') AND NOT (r.nspname='public' AND r.relname='webhook_deliveries'))
      OR (has_column_privilege(identity.rolname,r.oid,r.attname,'SELECT') AND NOT
        ((r.nspname='public' AND r.relname IN ('control_plane_schema_migrations','outbox_events','webhook_endpoints','webhook_deliveries'))
          OR (r.nspname='kala_installation_claim' AND r.relname IN ('marker','recovery_checkpoint')))))
    OR EXISTS (SELECT 1 FROM relations r WHERE has_table_privilege(identity.rolname,r.oid,'SELECT') AND NOT
      ((r.nspname='public' AND r.relname IN ('control_plane_schema_migrations','outbox_events','webhook_endpoints','webhook_deliveries'))
        OR (r.nspname='kala_installation_claim' AND r.relname IN ('marker','recovery_checkpoint'))))
  ) AND has_table_privilege(identity.rolname,'outbox_events','SELECT')
    AND has_table_privilege(identity.rolname,'webhook_endpoints','SELECT')
    AND has_table_privilege(identity.rolname,'webhook_deliveries','SELECT')
    AND has_table_privilege(identity.rolname,'webhook_deliveries','INSERT')
    AND has_table_privilege(identity.rolname,'control_plane_schema_migrations','SELECT')
    AND has_table_privilege(identity.rolname,'kala_installation_claim.marker','SELECT')
    AND has_table_privilege(identity.rolname,'kala_installation_claim.recovery_checkpoint','SELECT')
    AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS col(name) WHERE NOT has_column_privilege(identity.rolname,'outbox_events',col.name,'UPDATE'))
    AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) AS col(name) WHERE NOT has_column_privilege(identity.rolname,'webhook_deliveries',col.name,'UPDATE')) AS safe FROM identity`, [role ?? null, fanoutColumns, deliveryColumns])
  if (result.rowCount !== 1 || !result.rows[0]?.safe) throw new Error('Webhook worker identity has excessive database authority')
}

export async function assertWebhookInstallation(database: SqlExecutor, installationId: string): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(installationId)) throw new Error('Invalid installation identity')
  const marker = await database.query<{ installation_id: string }>('SELECT installation_id FROM kala_installation_claim.marker WHERE singleton=true')
  const recovery = await database.query<{ installation_id: string; checkpoint_id: string; key_sha256: string }>(
    'SELECT installation_id,checkpoint_id,key_sha256 FROM kala_installation_claim.recovery_checkpoint WHERE singleton=true')
  const row = recovery.rows[0]
  if (marker.rowCount !== 1 || marker.rows[0]?.installation_id !== installationId || recovery.rowCount !== 1
    || row?.installation_id !== installationId || !uuid.test(row.checkpoint_id) || !/^[0-9a-f]{64}$/i.test(row.key_sha256)) {
    throw new Error('Webhook control database installation or recovery checkpoint does not match')
  }
}
