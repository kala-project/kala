import { describe, expect, it } from 'vitest'

import { assertControlUpgradeSource, migrationIdentities, validateControlUpgradePlan } from './control-schema-upgrade.js'
import type { ControlPlaneMigration, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

const installationId = '00000000-0000-4000-8000-000000000001'
const checkpointId = '00000000-0000-4000-8000-000000000002'
const migrations: ControlPlaneMigration[] = Array.from({ length: 11 }, (_, i) => ({
  version: i + 1,
  name: `${String(i + 1).padStart(4, '0')}_migration.sql`,
  checksum: String(i + 1).padStart(64, '0'),
  sql: 'SELECT 1',
}))
const identities = migrationIdentities(migrations)
const plan = { fromVersion: 10, toVersion: 11, writerRole: 'kala_gateway', migrations: identities }

describe('reviewed control-schema upgrade', () => {
  it('accepts only the complete 10-to-11 release identity and matching transition', () => {
    expect(validateControlUpgradePlan(plan, migrations)).toEqual(plan)
    for (const invalid of [
      { ...plan, fromVersion: 9 },
      { ...plan, toVersion: 10 },
      { ...plan, writerRole: 'postgres' },
      { ...plan, migrations: identities.slice(0, 10) },
      { ...plan, migrations: identities.map((identity, i) => i === 10 ? { ...identity, checksum: 'tampered' } : identity) },
    ]) {
      expect(() => validateControlUpgradePlan(invalid, migrations)).toThrow()
    }
    expect(() => validateControlUpgradePlan({ ...plan, extra: true }, migrations)).toThrow()
    expect(() => validateControlUpgradePlan(plan, migrations.slice(0, 10))).toThrow()
  })

  it('keeps the original 7-to-9 lane limited to nine-migration images', () => {
    const old = migrations.slice(0, 9)
    const oldPlan = { ...plan, fromVersion: 7, toVersion: 9, migrations: migrationIdentities(old) }
    expect(validateControlUpgradePlan(oldPlan, old)).toEqual(oldPlan)
    expect(() => validateControlUpgradePlan(oldPlan, migrations)).toThrow()
  })

  it('rejects missing, mismatched and already-applied source migrations', async () => {
    const reviewed = validateControlUpgradePlan(plan, migrations)
    const source = identities.slice(0, 10)
    await expect(assertControlUpgradeSource(sourceTransaction(source), reviewed, installationId, 16, true)).resolves.toBeUndefined()
    for (const history of [
      source.slice(0, 9),
      [...source, identities[10]!],
      source.map((row, i) => i === 9 ? { ...row, checksum: 'tampered' } : row),
    ]) {
      await expect(assertControlUpgradeSource(sourceTransaction(history), reviewed, installationId, 16, false))
        .rejects.toThrow('Source migration history differs')
    }
    await expect(assertControlUpgradeSource(sourceTransaction(source, true), reviewed, installationId, 16, true))
      .rejects.toThrow('Other control clients remain')
  })
})

function sourceTransaction(history: typeof identities, peers = false): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<SqlQueryResult<Row>> {
      let rows: Record<string, unknown>[]
      if (sql.includes('pg_get_userbyid')) rows = [{ valid: true, major: 16 }]
      else if (sql.includes('kala_installation_claim.marker')) rows = [{ installation_id: installationId }]
      else if (sql.includes('kala_installation_claim.recovery_checkpoint')) {
        rows = [{ installation_id: installationId, checkpoint_id: checkpointId, key_sha256: 'a'.repeat(64) }]
      } else if (sql.includes('control_plane_schema_migrations')) rows = history
      else if (sql.includes('pg_stat_activity')) rows = peers ? [{ exists: true }] : []
      else throw new Error(`unexpected query: ${sql}`)
      return { rows: rows as Row[], rowCount: rows.length, command: '', oid: 0, fields: [] }
    },
  }
}
