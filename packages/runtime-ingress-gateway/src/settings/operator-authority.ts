import type { SqlExecutor } from '../persistence/postgres.js'
import { assertRestrictedControlRole, type RestrictedControlRole } from '../persistence/restricted-role.js'

const policy: RestrictedControlRole = {
  select: ['public.organizations', 'public.workspaces', 'public.executor_pools', 'public.executors',
    'public.executor_enrollment_tokens', 'public.contract_entitlements', 'public.organization_memberships',
    'public.organization_model_management', 'public.organization_webhook_secret_bindings',
    'public.settings_operator_operations', 'public.control_plane_schema_migrations',
    'public.webhook_endpoints', 'public.webhook_deliveries',
    'kala_installation_claim.marker', 'kala_installation_claim.recovery_checkpoint'],
  insert: ['public.settings_operator_operations', 'public.organization_model_management',
    'public.organization_webhook_secret_bindings', 'public.audit_events'],
  update: {
    'public.workspaces': ['name', 'status'],
    'public.executor_pools': ['name', 'mode', 'workspace_id'],
    'public.contract_entitlements': ['contract_reference', 'support_tier', 'starts_at', 'ends_at', 'grace_ends_at',
      'seat_limit', 'concurrent_session_limit', 'workspace_limit', 'monthly_token_limit', 'storage_bytes_limit'],
    'public.organization_webhook_secret_bindings': ['label'],
    'public.settings_operator_operations': ['state', 'resulting_revision', 'after_value', 'updated_at', 'error_code', 'reverted_by'],
    'public.organization_model_management': ['desired_management', 'desired_revision', 'effective_management',
      'effective_revision', 'state', 'operation_id', 'required_serving_scope', 'updated_at'],
  },
}

export async function assertSettingsOperatorPrivileges(database: SqlExecutor, role?: string): Promise<void> {
  await assertRestrictedControlRole(database, policy, role)
}

export async function grantSettingsOperator(database: SqlExecutor, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(role)) throw new Error('Invalid Settings Operator role')
  await database.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${role}"`)
  await database.query(`DO $columns$ DECLARE c record; BEGIN
    FOR c IN SELECT n.nspname,t.relname,a.attname FROM pg_attribute a
      JOIN pg_class t ON a.attrelid=t.oid JOIN pg_namespace n ON t.relnamespace=n.oid
      WHERE n.nspname='public' AND t.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped LOOP
      EXECUTE format('REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON %I.%I FROM %I',
        c.attname,c.attname,c.attname,c.attname,c.nspname,c.relname,'${role}');
    END LOOP;
  END $columns$`)
  await database.query(`GRANT CONNECT ON DATABASE runlab_control TO "${role}"`)
  await database.query(`GRANT USAGE ON SCHEMA public,kala_installation_claim TO "${role}"`)
  await database.query(`GRANT SELECT ON ${policy.select.join(',')} TO "${role}"`)
  await database.query(`GRANT INSERT ON ${policy.insert.join(',')} TO "${role}"`)
  for (const [table, columns] of Object.entries(policy.update)) {
    await database.query(`GRANT UPDATE (${columns.join(',')}) ON ${table} TO "${role}"`)
  }
  await assertSettingsOperatorPrivileges(database, role)
}
