import { describe, expect, it } from 'vitest'

import { PostgresUsageAlertService } from './usage-alerts.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('PostgresUsageAlertService', () => {
  it('emits a deduplicated monthly token threshold alert', async () => {
    const database = new FakeUsageAlertDatabase({ tokens: '850', limit: '1000' })
    const service = new PostgresUsageAlertService(database)

    await expect(service.checkMonthlyTokenBudget('org_acme', 80)).resolves.toMatchObject({ emitted: true, percent: 85, tokens: 850, limit: 1000 })
    await expect(service.checkMonthlyTokenBudget('org_acme', 80)).resolves.toMatchObject({ emitted: false, percent: 85, tokens: 850, limit: 1000 })
    expect(database.outboxInserts).toBe(1)
  })

  it('does not alert below threshold and fails closed without entitlements', async () => {
    await expect(new PostgresUsageAlertService(new FakeUsageAlertDatabase({ tokens: '10', limit: '1000' })).checkMonthlyTokenBudget('org_acme', 80))
      .resolves.toMatchObject({ emitted: false, percent: 1 })
    await expect(new PostgresUsageAlertService(new FakeUsageAlertDatabase({ rows: [] })).checkMonthlyTokenBudget('org_missing', 80))
      .rejects.toThrow('contract entitlement not found')
  })
  it('does not round a large decimal budget just below 80 percent into a false alert', async () => {
    const database = new FakeUsageAlertDatabase({ tokens: '80000000000000000000', limit: '100000000000000000001' })
    await expect(new PostgresUsageAlertService(database).checkMonthlyTokenBudget('org_acme', 80))
      .resolves.toMatchObject({ emitted: false, percent: 79, tokens: '80000000000000000000', limit: '100000000000000000001' })
    expect(database.outboxInserts).toBe(0)
  })
})

class FakeUsageAlertDatabase implements SqlExecutor {
  outboxInserts = 0
  private readonly inserted = new Set<string>()
  constructor(private readonly options: { rows?: Array<{ tokens: string; monthly_token_limit: string | null }>; tokens?: string; limit?: string | null }) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim()
    if (sql.startsWith('SELECT COALESCE')) return result((this.options.rows ?? [{ tokens: this.options.tokens ?? '0', monthly_token_limit: this.options.limit ?? '1000' }]) as unknown as Row[])
    if (sql.startsWith('INSERT INTO outbox_events')) {
      const id = String(values[0])
      if (this.inserted.has(id)) return result([], 0)
      this.inserted.add(id); this.outboxInserts += 1; return result([], 1)
    }
    return result([])
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}
