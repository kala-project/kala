import { createHash } from 'node:crypto'
import type { SqlExecutor } from '../persistence/postgres.js'

export type ControlSettingsWriteOptions = {
  expectedRevision?: string
  expectedEtag?: string
  writeProtocol?: 'legacy-compatible' | 'conditional-required'
  authority?: string
}

export class ControlSettingsConflict extends Error {
  constructor(readonly status: 412 | 428 | 503, readonly code: string) { super(code) }
}

export function controlSettingsWriteProtocol(value = process.env.KALA_SETTINGS_WRITE_PROTOCOL): NonNullable<ControlSettingsWriteOptions['writeProtocol']> {
  if (value === undefined || value === 'legacy-compatible') return 'legacy-compatible'
  if (value === 'conditional-required') return value
  throw new Error('invalid settingsWriteProtocol; expected legacy-compatible or conditional-required')
}

export function controlSettingsEtag(organizationId: string, resource: 'retention' | 'attachment-policy', revision: string, authority = 'direct-control-authority'): string {
  if (!/^[1-9]\d*$/u.test(revision)) throw new ControlSettingsConflict(503, 'configuration_revisions_unavailable')
  return `"${createHash('sha256').update(JSON.stringify(['kala:control-settings:v1', authority, organizationId, resource, revision])).digest('base64url')}"`
}

export function assertControlSettingsWrite(
  organizationId: string, resource: 'retention' | 'attachment-policy', revision: string | undefined, options: ControlSettingsWriteOptions,
): void {
  const conditional = options.expectedRevision !== undefined || options.expectedEtag !== undefined
  if (!conditional && options.writeProtocol === 'conditional-required') throw new ControlSettingsConflict(428, 'client_upgrade_required')
  if (!conditional) return
  if (!revision) throw new ControlSettingsConflict(503, 'configuration_revisions_unavailable')
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision
    || options.expectedEtag !== undefined && options.expectedEtag !== controlSettingsEtag(organizationId, resource, revision, options.authority)) {
    throw new ControlSettingsConflict(412, 'configuration_conflict')
  }

}

export async function lockControlSettingsSchema(transaction: SqlExecutor): Promise<boolean> {
  await transaction.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kala:control-settings-schema:v1', 0))")
  const result = await transaction.query<{ present: boolean }>("SELECT to_regclass('public.settings_resource_versions') IS NOT NULL AS present")
  return result.rows[0]?.present === true
}

export async function lockAttachmentRevision(transaction: SqlExecutor, organizationId: string): Promise<string> {
  await transaction.query(`INSERT INTO settings_resource_versions(organization_id,resource_kind,resource_id,revision)
    VALUES ($1,'policy','attachment',1) ON CONFLICT DO NOTHING`, [organizationId])
  const result = await transaction.query<{ revision: string }>(`SELECT revision::text FROM settings_resource_versions
    WHERE organization_id=$1 AND resource_kind='policy' AND resource_id='attachment' FOR UPDATE`, [organizationId])
  if (!result.rows[0]) throw new ControlSettingsConflict(503, 'configuration_revisions_unavailable')
  return result.rows[0].revision
}
