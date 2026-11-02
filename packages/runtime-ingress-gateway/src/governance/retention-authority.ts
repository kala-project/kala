import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations } from '../persistence/postgres.js'
import { assertRestrictedControlRole, type RestrictedControlRole } from '../persistence/restricted-role.js'
import { assertWebhookInstallation as assertControlInstallation } from '../webhooks/worker-authority.js'
import type { OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'

const policy: RestrictedControlRole = {
  select: ['public.organizations','public.retention_policies','public.retention_runs','public.browser_sessions','public.notification_devices',
    'public.control_plane_schema_migrations','kala_installation_claim.marker','kala_installation_claim.recovery_checkpoint'],
  insert: ['public.audit_events','public.retention_runs'],
  delete: ['public.browser_sessions','public.notification_devices'],
  update: { 'public.retention_runs': ['state','host_sessions','outcome_audit_id','completed_at'] },
}

export async function assertRetentionPrivileges(database: SqlExecutor, role?: string): Promise<void> {
  await assertRestrictedControlRole(database, policy, role)
}
export async function grantRetentionRole(database: SqlExecutor, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(role)) throw new Error('Invalid retention maintenance role')
  await database.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${role}"`)
  await database.query(`GRANT CONNECT ON DATABASE runlab_control TO "${role}"`)
  await database.query(`GRANT USAGE ON SCHEMA public,kala_installation_claim TO "${role}"`)
  await database.query(`GRANT SELECT ON ${policy.select.join(',')} TO "${role}"`)
  await database.query(`GRANT INSERT ON ${policy.insert.join(',')} TO "${role}"`)
  await database.query(`GRANT DELETE ON ${policy.delete!.join(',')} TO "${role}"`)
  await database.query(`GRANT UPDATE (${policy.update['public.retention_runs']!.join(',')}) ON public.retention_runs TO "${role}"`)
  await assertRetentionPrivileges(database, role)
}

/** Separate pool and credential: never borrow the Gateway writer if missing. */
export async function openRetentionDatabase(options: {
  enabled: boolean; readSecret(name: string): Promise<string>; migrationsDirectory: string
  installationId: string; telemetry?: OnlineTelemetry
}): Promise<ControlPlaneDatabase | undefined> {
  if (!options.enabled) return undefined
  const database = createPostgresControlPlaneDatabase({ connectionString: await options.readSecret('KALA_RETENTION_DATABASE_URL'),
    applicationName: 'kala-retention-maintenance', maxConnections: 2, statementTimeoutMs: 5_000, telemetry: options.telemetry })
  try {
    await assertControlPlaneSchema(database, await readControlPlaneMigrations(options.migrationsDirectory))
    await assertRetentionPrivileges(database)
    await assertControlInstallation(database, options.installationId)
    return database
  } catch { await database.close().catch(() => undefined); throw new Error('Retention maintenance authority unavailable') }
}
