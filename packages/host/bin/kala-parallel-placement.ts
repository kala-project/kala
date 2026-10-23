#!/usr/bin/env node
/** Operator-only, one-way per-Unit promotion. Never run with a Runtime writer credential. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { assertPostgresSchemaCurrent } from '../src/postgres-migrations.js'
import { createPostgresRuntimeUnitPlacementStore } from '../src/tenant-runtime/postgres-runtime-unit-placement-store.js'
import { parseTenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

const known = new Set(['--organization-id', '--unit-id', '--expected-generation', '--acknowledge-irreversible'])
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--') && !known.has(argument)) throw new Error(`unknown argument ${argument}`)
}
const organizationId = option('--organization-id')
const unitId = option('--unit-id')
const generation = option('--expected-generation')
if (!organizationId || !/^org_[A-Za-z0-9_-]+$/u.test(organizationId)
  || !unitId || !generation || !/^[1-9][0-9]*$/u.test(generation)
  || !process.argv.includes('--acknowledge-irreversible')) {
  throw new Error('Usage: kala-parallel-placement --organization-id org_... --unit-id UNIT --expected-generation N --acknowledge-irreversible (requires control and Runtime operator database URL files)')
}
const parsedUnitId = parseTenantRuntimeUnitId(unitId)
const controlFile = process.env.KALA_PARALLEL_CONTROL_DATABASE_URL_FILE
const runtimeFile = process.env.KALA_PARALLEL_RUNTIME_DATABASE_URL_FILE
if (!controlFile || !runtimeFile) throw new Error('both KALA_PARALLEL_CONTROL_DATABASE_URL_FILE and KALA_PARALLEL_RUNTIME_DATABASE_URL_FILE are required')
const controlUrl = (await readFile(controlFile, 'utf8')).trim()
const runtimeUrl = (await readFile(runtimeFile, 'utf8')).trim()
if (!controlUrl || !runtimeUrl) throw new Error('operator database credential file is empty')
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (config: Record<string, unknown>) => {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>
  end(): Promise<void>
} }
const control = new Pool({ connectionString: controlUrl, application_name: 'kala-parallel-placement-control', max: 1,
  connectionTimeoutMillis: 5_000, statement_timeout: 15_000 })
const runtime = createPostgresRuntimeUnitPlacementStore({ connectionString: runtimeUrl,
  applicationName: 'kala-parallel-placement-operator', maxConnections: 1 })
const checkBinding = async (): Promise<void> => {
  const result = await control.query<{ id: string; organization_id: string; runtime_unit_id: string }>(`SELECT o.id,p.organization_id,o.runtime_unit_id
    FROM organizations o JOIN runtime_unit_placements p ON p.runtime_unit_id=o.runtime_unit_id
    WHERE o.runtime_unit_id=$1`, [parsedUnitId])
  if (result.rows.length !== 1 || result.rows[0]?.id !== organizationId
    || result.rows[0]?.organization_id !== organizationId || result.rows[0]?.runtime_unit_id !== parsedUnitId) {
    throw new Error('control-plane Organization/Unit binding does not match the requested parallel placement')
  }
}
try {
  await checkBinding()
  await assertPostgresSchemaCurrent(runtime.database)
  const lease = await runtime.promoteToParallel({ organizationId, unitId: parsedUnitId }, BigInt(generation))
  try { await checkBinding() } catch {
    throw new Error('parallel placement was committed, but the control-plane Organization/Unit binding changed; keep Gateway stopped and investigate before routing traffic')
  }
  console.log(JSON.stringify({ organizationId, unitId: parsedUnitId, protocol: lease.protocol,
    generation: lease.generation.toString(), committed: true }))
} finally {
  await Promise.allSettled([runtime.close(), control.end()])
}
