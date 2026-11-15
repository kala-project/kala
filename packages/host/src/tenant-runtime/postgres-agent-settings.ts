import {
  defaultAgentRuntimeSettings,
  parseAgentRuntimeSettings,
  type AgentRuntimeSettings,
} from '../runtime-config.js'
import type { HotStateDatabase, HotStateSqlExecutor } from './postgres-hot-state.js'
import type { SettingsWriteOptions } from '../settings-concurrency.js'
import { PostgresSettingsRevisions } from './settings-revisions.js'
import type { PostgresSubscriptionState } from './postgres-notifications.js'

const agentSettingsChannel = 'kala_agent_settings_changed'

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
    private readonly database: HotStateDatabase,
    private readonly organizationId: string,
  ) {
    if (!organizationId) throw new TypeError('organizationId must be a non-empty string')
    this.configPath = `postgres:organization/${encodeURIComponent(organizationId)}/agent-prompt`
  }

  async initializeSchema(): Promise<void> {
    for (const statement of agentSettingsSchemaStatements('"public"')) await this.database.query(statement)
  }

  async load(executor: HotStateSqlExecutor = this.database): Promise<AgentRuntimeSettings> {
    const result = await executor.query<{ settings: unknown }>(
      'SELECT settings FROM public.tenant_agent_prompt_settings WHERE tenant_id = $1',
      [this.organizationId],
    )
    const row = result.rows[0]
    if (!row) return defaultAgentRuntimeSettings()
    const settings = parseAgentRuntimeSettings(row.settings)
    if (!settings) throw new Error('Invalid persisted organization agent prompt settings')
    return settings
  }

  async configuration(): Promise<{ revision: string; value: AgentRuntimeSettings }> {
    return this.database.transaction(async (transaction) => {
      const revision = await new PostgresSettingsRevisions(this.organizationId).lock(transaction, { kind: 'agent', id: 'runtime' })
      if (!revision) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
      return { revision, value: await this.load(transaction) }
    })
  }

  async revision(): Promise<string | undefined> {
    return this.database.transaction(transaction =>
      new PostgresSettingsRevisions(this.organizationId).lock(transaction, { kind: 'agent', id: 'runtime' }))
  }

  async subscribe(listener: () => Promise<void>, onState: (state: PostgresSubscriptionState) => void): Promise<() => Promise<void>> {
    if (!this.database.listen) throw new Error('Agent settings require PostgreSQL notification support')
    let tail = Promise.resolve(), pending = 0, connection: PostgresSubscriptionState = 'synchronizing'
    const report = () => onState(connection === 'ready' && pending ? 'synchronizing' : connection)
    const stop = await this.database.listen(agentSettingsChannel, async payload => {
      if (payload !== undefined && payload !== this.organizationId) return
      pending++; report()
      const task = tail.catch(() => undefined).then(listener)
      tail = task
      try { await task } finally { pending--; report() }
    }, { onState: state => { connection = state; report() } })
    return async () => { await stop(); await tail.catch(() => undefined) }
  }

  async save(input: AgentRuntimeSettings, options: SettingsWriteOptions = {}): Promise<void> {
    const settings = parseAgentRuntimeSettings(input)
    if (!settings) throw new Error('invalid agent prompt settings')
    await this.update(() => settings, options)
  }

  async update(change: (current: AgentRuntimeSettings) => AgentRuntimeSettings, options: SettingsWriteOptions = {}): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [this.organizationId, 'agent/runtime'])
      await new PostgresSettingsRevisions(this.organizationId).mutate(transaction, { kind: 'agent', id: 'runtime' }, options, async () => {
        const settings = parseAgentRuntimeSettings(change(await this.load(transaction)))
        if (!settings) throw new Error('invalid agent prompt settings')
        await transaction.query(`INSERT INTO public.tenant_agent_prompt_settings (tenant_id, settings, updated_at)
      VALUES ($1, $2::jsonb, clock_timestamp())
      ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = clock_timestamp()`,
        [this.organizationId, JSON.stringify(settings)])
      })
      await transaction.query('SELECT pg_notify($1,$2)', [agentSettingsChannel, this.organizationId])
    })
  }
}
