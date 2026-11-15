import { randomUUID } from 'node:crypto'

import type { SqlExecutor } from '../persistence/postgres.js'
import { decimalForWire, nonnegativeDecimal } from './decimal.js'

export class PostgresUsageAlertService {
  constructor(private readonly database: SqlExecutor) {}

  async checkMonthlyTokenBudget(organizationId: string, thresholdPercent = 80): Promise<{ emitted: boolean; percent?: number | string; tokens?: number | string; limit?: number | string }> {
    if (!Number.isSafeInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) throw new Error('invalid usage alert threshold')
    const result = await this.database.query<{ tokens: string; monthly_token_limit: string | null }>(`SELECT COALESCE(SUM(u.input_tokens+u.output_tokens+u.cache_read_tokens+u.cache_creation_tokens),0)::text AS tokens,e.monthly_token_limit::text
      FROM contract_entitlements e LEFT JOIN usage_ledger u ON u.organization_id=e.organization_id AND u.occurred_at>=date_trunc('month',now()) WHERE e.organization_id=$1 GROUP BY e.monthly_token_limit`, [organizationId])
    if (!result.rows[0]) throw new Error('contract entitlement not found')
    const exactTokens = nonnegativeDecimal(result.rows[0].tokens)
    const exactLimit = result.rows[0].monthly_token_limit === null ? undefined : nonnegativeDecimal(result.rows[0].monthly_token_limit)
    const tokens = decimalForWire(exactTokens)
    const limit = exactLimit === undefined ? undefined : decimalForWire(exactLimit)
    if (exactLimit === undefined || exactLimit === 0n) return { emitted: false, tokens, limit }
    const exactPercent = exactTokens * 100n / exactLimit
    const percent = decimalForWire(exactPercent)
    if (exactPercent < BigInt(thresholdPercent)) return { emitted: false, percent, tokens, limit }
    const month = new Date().toISOString().slice(0, 7)
    const eventId = `usage-alert:${organizationId}:tokens:${month}:${thresholdPercent}`
    const inserted = await this.database.query(`INSERT INTO outbox_events(id,organization_id,topic,aggregate_type,aggregate_id,payload) VALUES($1,$2,'usage.monthly_token_threshold','organization',$2,$3) ON CONFLICT (id) DO NOTHING`, [
      eventId,
      organizationId,
      { eventId: randomUUID(), organizationId, tokens, limit, percent, thresholdPercent, month },
    ])
    return { emitted: inserted.rowCount === 1, percent, tokens, limit }
  }
}
