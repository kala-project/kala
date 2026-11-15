import { checkSettingsPrecondition, nextSettingsRevision, type SettingsWriteOptions } from '../settings-concurrency.js'
import type { HotStateSqlExecutor } from './postgres-hot-state.js'

export function settingsRevisionSchemaStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.settings_resource_versions (
      organization_id text NOT NULL,
      resource_kind text NOT NULL,
      resource_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id, resource_kind, resource_id)
    )`,
    `INSERT INTO ${schema}.settings_resource_versions
      (organization_id, resource_kind, resource_id, revision, updated_at)
      SELECT tenant_id,
        CASE credential_id WHEN 'serper' THEN 'search' WHEN 'azure_speech' THEN 'speech'
          WHEN 'dedicated-model-settings:v1' THEN 'models' WHEN 'organization-model-settings:v1' THEN 'models' ELSE 'credential' END,
        CASE credential_id WHEN 'serper' THEN 'serper' WHEN 'azure_speech' THEN 'azure'
          WHEN 'dedicated-model-settings:v1' THEN 'catalog' WHEN 'organization-model-settings:v1' THEN 'catalog' ELSE credential_id END,
        1, updated_at FROM ${schema}.tenant_state_credentials
      ON CONFLICT DO NOTHING`,
    `INSERT INTO ${schema}.settings_resource_versions
      (organization_id, resource_kind, resource_id, revision, updated_at)
      SELECT tenant_id, 'agent', 'runtime', 1, updated_at FROM ${schema}.tenant_agent_prompt_settings
      ON CONFLICT DO NOTHING`,
  ]
}

export class PostgresSettingsRevisions {
  readonly table: string
  constructor(private readonly organizationId: string, schema = 'public') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new TypeError('schema must be a simple PostgreSQL identifier')
    this.table = `"${schema}".settings_resource_versions`
  }

  async available(transaction: HotStateSqlExecutor): Promise<boolean> {
    const result = await transaction.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [this.table])
    return result.rows[0]?.present === true
  }

  async lock(transaction: HotStateSqlExecutor, resource: { kind: string; id: string }): Promise<string | undefined> {
    if (!await this.available(transaction)) return undefined
    await transaction.query(`INSERT INTO ${this.table}
      (organization_id, resource_kind, resource_id, revision, updated_at)
      VALUES ($1, $2, $3, 1, clock_timestamp()) ON CONFLICT DO NOTHING`,
    [this.organizationId, resource.kind, resource.id])
    const result = await transaction.query<{ revision: string }>(`SELECT revision::text AS revision FROM ${this.table}
      WHERE organization_id = $1 AND resource_kind = $2 AND resource_id = $3 FOR UPDATE`,
    [this.organizationId, resource.kind, resource.id])
    if (!result.rows[0]) throw new Error('settings_revision_unavailable')
    return result.rows[0].revision
  }

  async mutate<T>(
    transaction: HotStateSqlExecutor, resource: { kind: string; id: string },
    options: SettingsWriteOptions, operation: () => Promise<T>,
  ): Promise<T> {
    const revision = await this.lock(transaction, resource)
    if (!revision) {
      if (options.expectedRevision !== undefined || options.writeProtocol === 'conditional-required') {
        throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
      }
      return operation()
    }
    checkSettingsPrecondition(revision, options)
    const next = nextSettingsRevision(revision)
    const result = await operation()
    await transaction.query(`UPDATE ${this.table} SET revision = $4::bigint, updated_at = clock_timestamp()
      WHERE organization_id = $1 AND resource_kind = $2 AND resource_id = $3`,
    [this.organizationId, resource.kind, resource.id, next])
    return result
  }
}

export function credentialSettingsResource(id: string): { kind: string; id: string } {
  if (id === 'serper') return { kind: 'search', id: 'serper' }
  if (id === 'azure_speech') return { kind: 'speech', id: 'azure' }
  if (id === 'dedicated-model-settings:v1' || id === 'organization-model-settings:v1') return { kind: 'models', id: 'catalog' }
  return { kind: 'credential', id }
}
