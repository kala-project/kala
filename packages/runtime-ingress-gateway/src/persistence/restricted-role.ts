import type { SqlExecutor } from './postgres.js'

export type RestrictedControlRole = {
  select: readonly string[]
  insert: readonly string[]
  delete?: readonly string[]
  update: Readonly<Record<string, readonly string[]>>
}

/** Effective authority, not merely the grants this initializer happened to issue. */
export async function assertRestrictedControlRole(database: SqlExecutor, policy: RestrictedControlRole, role?: string): Promise<void> {
  const result = await database.query<{ safe: boolean }>(`WITH identity AS (
    SELECT oid,rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=COALESCE($1,current_user)
  ), relations AS MATERIALIZED (
    SELECT c.oid,c.relowner,n.nspname||'.'||c.relname AS qualified_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  ), columns AS MATERIALIZED (
    SELECT r.*,a.attname FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid WHERE a.attnum>0 AND NOT a.attisdropped
  ) SELECT NOT (
    NOT identity.rolcanlogin OR ($1 IS NULL AND session_user<>current_user)
    OR identity.rolsuper OR identity.rolcreaterole OR identity.rolcreatedb OR identity.rolreplication OR identity.rolbypassrls
    OR has_database_privilege(identity.rolname,current_database(),'CREATE')
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=identity.oid)
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND has_function_privilege(identity.rolname,p.oid,'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_class WHERE CASE WHEN relkind='S' THEN has_sequence_privilege(identity.rolname,oid,'USAGE,SELECT,UPDATE') ELSE false END)
    OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND (has_schema_privilege(identity.rolname,n.oid,'CREATE') OR pg_has_role(identity.oid,n.nspowner,'MEMBER')))
    OR EXISTS (SELECT 1 FROM relations r WHERE pg_has_role(identity.oid,r.relowner,'MEMBER')
      OR has_table_privilege(identity.rolname,r.oid,'UPDATE,TRUNCATE,REFERENCES,TRIGGER')
      OR (has_table_privilege(identity.rolname,r.oid,'DELETE') AND NOT r.qualified_name=ANY($4::text[]))
      OR (has_table_privilege(identity.rolname,r.oid,'INSERT') AND NOT r.qualified_name=ANY($3::text[]))
      OR (has_table_privilege(identity.rolname,r.oid,'SELECT') AND NOT r.qualified_name=ANY($2::text[])))
    OR EXISTS (SELECT 1 FROM columns c WHERE
      (has_column_privilege(identity.rolname,c.oid,c.attname,'UPDATE') AND NOT COALESCE(($5::jsonb -> c.qualified_name) ? c.attname,false))
      OR (has_column_privilege(identity.rolname,c.oid,c.attname,'INSERT') AND NOT c.qualified_name=ANY($3::text[]))
      OR (has_column_privilege(identity.rolname,c.oid,c.attname,'SELECT') AND NOT c.qualified_name=ANY($2::text[])))
  ) AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(name) WHERE NOT has_table_privilege(identity.rolname,t.name,'SELECT'))
    AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) AS t(name) WHERE NOT has_table_privilege(identity.rolname,t.name,'INSERT'))
    AND NOT EXISTS (SELECT 1 FROM unnest($4::text[]) AS t(name) WHERE NOT has_table_privilege(identity.rolname,t.name,'DELETE'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_each($5::jsonb) AS t(name,cols),jsonb_array_elements_text(t.cols) AS c(name)
      WHERE NOT has_column_privilege(identity.rolname,t.name,c.name,'UPDATE')) AS safe FROM identity`,
  [role ?? null, policy.select, policy.insert, policy.delete ?? [], JSON.stringify(policy.update)])
  if (result.rowCount !== 1 || !result.rows[0]?.safe) throw new Error('Control database identity has excessive or missing authority')
}
