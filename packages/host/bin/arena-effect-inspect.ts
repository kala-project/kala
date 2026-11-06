import { createPostgresRuntimeResourceOwnershipStore } from '../src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'

const [organizationId, rawUnitId, resourceId, rawLimit] = process.argv.slice(2)
const secretPath = process.env.KALA_ARENA_RECONCILE_OPERATOR_URL_FILE
if (!organizationId || !rawUnitId || !resourceId || !secretPath) {
  console.error('Usage: KALA_ARENA_RECONCILE_OPERATOR_URL_FILE=<0600-file> KALA_ARENA_OPERATOR_ID=<login> tsx bin/arena-effect-inspect.ts <organization-id> <unit-id> <session-id> [limit 1..100]')
  process.exitCode = 2
} else {
  if (process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE
    && (process.platform !== 'linux'
      || await readlink('/proc/self/ns/pid') !== process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE)) {
    throw new Error('Operator is not in the original Executor PID namespace')
  }
  const info = await lstat(secretPath)
  if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.()) {
    throw new Error('Operator credential must be a regular, user-owned file without group/other access')
  }
  const connectionString = (await readFile(secretPath, 'utf8')).trim()
  const store = createPostgresRuntimeResourceOwnershipStore({ connectionString })
  try {
    const identity = await store.database.query<{ operator_id: string }>('SELECT session_user AS operator_id')
    if (!identity.rows[0]?.operator_id || identity.rows[0].operator_id !== process.env.KALA_ARENA_OPERATOR_ID) {
      throw new Error('Authenticated PostgreSQL LOGIN must match the incident operator identity')
    }
    const effects = await store.inspectOperatorArenaEffects({
      organizationId, unitId: parseTenantRuntimeUnitId(rawUnitId), resourceType: 'session', resourceId,
    }, rawLimit === undefined ? 20 : Number(rawLimit))
    const inspection = await Promise.all(effects.map(async (effect) => ({
      ...effect, dispatch: await store.inspectOperatorArenaDispatch({
        organizationId, unitId: parseTenantRuntimeUnitId(rawUnitId), resourceType: 'session', resourceId,
      }, effect.effectId),
    })))
    console.log(JSON.stringify(inspection, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value, 2))
  } finally { await store.close() }
}
import { lstat, readFile, readlink } from 'node:fs/promises'
