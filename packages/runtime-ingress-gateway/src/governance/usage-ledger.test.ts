import { describe, expect, it } from 'vitest'

import { PostgresUsageLedger, type UsageEntry } from './usage-ledger.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('PostgresUsageLedger', () => {
  it('appends usage idempotently and rejects invalid token counts', async () => {
    const database = new FakeUsageDatabase()
    const ledger = new PostgresUsageLedger(database)
    const entry = usageEntry()

    await expect(ledger.append(entry)).resolves.toBe(true)
    database.nextAppendRowCount = 0
    await expect(ledger.append({ ...entry, id: 'use_duplicate' })).resolves.toBe(false)
    await expect(ledger.append({ ...entry, inputTokens: -1 })).rejects.toThrow('invalid usage token count')

    expect(database.executed.filter((item) => item.sql.startsWith('INSERT INTO usage_ledger'))).toHaveLength(2)
  })

  it('fails closed when an organization has no entitlement row', async () => {
    const ledger = new PostgresUsageLedger(new FakeUsageDatabase({ currentRows: [] }))

    await expect(ledger.currentMonth('org_missing')).rejects.toThrow('contract entitlement not found')
    await expect(ledger.assertMonthlyTokenQuota('org_missing')).rejects.toThrow('contract entitlement not found')
  })

  it('enforces monthly token quota before expensive work starts', async () => {
    const ledger = new PostgresUsageLedger(new FakeUsageDatabase({ currentRows: [{ tokens: '90', monthly_token_limit: '100' }] }))

    await expect(ledger.assertMonthlyTokenQuota('org_acme', 10)).resolves.toEqual({ tokens: 90, limit: 100 })
    await expect(ledger.assertMonthlyTokenQuota('org_acme', 11)).rejects.toThrow('organization token quota exceeded')
  })

  it('treats null token limits as explicitly unlimited', async () => {
    const ledger = new PostgresUsageLedger(new FakeUsageDatabase({ currentRows: [{ tokens: '9000', monthly_token_limit: null }] }))

    await expect(ledger.currentMonth('org_acme')).resolves.toEqual({ tokens: 9000, exhausted: false })
    await expect(ledger.assertMonthlyTokenQuota('org_acme', 1_000_000)).resolves.toEqual({ tokens: 9000 })
  })
  it('keeps decimal limits and admission comparisons exact beyond JavaScript integer precision', async () => {
    const ledger = new PostgresUsageLedger(new FakeUsageDatabase({ currentRows: [{
      tokens: '9007199254740993', monthly_token_limit: '9007199254740994',
    }] }))
    await expect(ledger.currentMonth('org_acme')).resolves.toEqual({
      tokens: '9007199254740993', limit: '9007199254740994', exhausted: false,
    })
    await expect(ledger.assertMonthlyTokenQuota('org_acme', 1)).resolves.toMatchObject({ tokens: '9007199254740993' })
    await expect(ledger.assertMonthlyTokenQuota('org_acme', 2)).rejects.toThrow('organization token quota exceeded')
  })
})

class FakeUsageDatabase implements SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []
  nextAppendRowCount = 1

  constructor(private readonly options: { currentRows?: Array<{ tokens: string; monthly_token_limit: string | null }> } = {}) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('INSERT INTO usage_ledger')) return result([], this.nextAppendRowCount)
    if (sql.startsWith('SELECT COALESCE(SUM')) return result((this.options.currentRows ?? [{ tokens: '0', monthly_token_limit: null }]) as unknown as Row[])
    return result([])
  }
}

function usageEntry(): UsageEntry {
  return {
    id: 'use_1',
    organizationId: 'org_acme',
    inputTokens: 1,
    outputTokens: 2,
    occurredAt: new Date('2026-09-07T05:00:00Z'),
    operationId: 'op_1',
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}
