import type { SqlExecutor } from '../persistence/postgres.js'
import { assertRestrictedControlRole } from '../persistence/restricted-role.js'

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
  await assertRestrictedControlRole(database, {
    select: ['public.control_plane_schema_migrations','public.outbox_events','public.webhook_endpoints','public.webhook_deliveries',
      'kala_installation_claim.marker','kala_installation_claim.recovery_checkpoint'],
    insert: ['public.webhook_deliveries'],
    update: { 'public.outbox_events': fanoutColumns, 'public.webhook_deliveries': deliveryColumns },
  }, role)
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
