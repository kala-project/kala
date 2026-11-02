import {
  defaultAgentRuntimeSettings,
  parseAgentRuntimeSettings,
  type AgentRuntimeSettings,
} from '../runtime-config.js'
import type { HotStateSqlExecutor } from './postgres-hot-state.js'

export function agentSettingsSchemaStatements(schema: string): readonly string[] {
  return [`CREATE TABLE IF NOT EXISTS ${schema}.tenant_agent_prompt_settings (
    tenant_id text PRIMARY KEY,
    settings jsonb NOT NULL,
    updated_at timestamptz NOT NULL
  )`]
}

export class PostgresAgentPromptSettingsStore {
  readonly configPath: string

  constructor(
    private readonly database: HotStateSqlExecutor,
    private readonly organizationId: string,
  ) {
    if (!organizationId) throw new TypeError('organizationId must be a non-empty string')
    this.configPath = `postgres:organization/${encodeURIComponent(organizationId)}/agent-prompt`
  }

  async initializeSchema(): Promise<void> {
    for (const statement of agentSettingsSchemaStatements('"public"')) await this.database.query(statement)
  }

  async load(): Promise<AgentRuntimeSettings> {
    const result = await this.database.query<{ settings: unknown }>(
      'SELECT settings FROM public.tenant_agent_prompt_settings WHERE tenant_id = $1',
      [this.organizationId],
    )
    const row = result.rows[0]
    if (!row) return defaultAgentRuntimeSettings()
    const settings = parseAgentRuntimeSettings(row.settings)
    if (!settings) throw new Error('Invalid persisted organization agent prompt settings')
    return settings
  }

  async save(input: AgentRuntimeSettings): Promise<void> {
    const settings = parseAgentRuntimeSettings(input)
    if (!settings) throw new Error('invalid agent prompt settings')
    await this.database.query(`INSERT INTO public.tenant_agent_prompt_settings (tenant_id, settings, updated_at)
      VALUES ($1, $2::jsonb, clock_timestamp())
      ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = clock_timestamp()`,
    [this.organizationId, JSON.stringify(settings)])
  }
}
