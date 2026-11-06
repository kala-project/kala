import { lstat, readFile } from 'node:fs/promises'

import { createPostgresRuntimeResourceOwnershipStore } from '../src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'

const [organizationId, unitId, sessionId, effectId, incidentId, confirmation] = process.argv.slice(2)
const secretPath = process.env.KALA_ARENA_RECONCILE_OPERATOR_URL_FILE
if (process.platform !== 'linux' || !secretPath || !organizationId || !unitId || !sessionId
  || !effectId || !incidentId || confirmation !== `verify-never-dispatched:${effectId}`
  || process.argv.length !== 8) {
  throw new Error('Linux-only prepared effect usage: KALA_ARENA_RECONCILE_OPERATOR_URL_FILE=<0600-file> KALA_ARENA_OPERATOR_ID=<login> node dist/bin/learning-effect-reconcile.js <org> <unit> <session> <effect> <incident> verify-never-dispatched:<effect>')
}
const info = await lstat(secretPath)
if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
  throw new Error('Operator credential must be a regular, user-owned file without group/other access')
}
const connectionString = (await readFile(secretPath, 'utf8')).trim()
if (!connectionString || new URL(connectionString).pathname === '/runlab_control') {
  throw new Error('Dedicated scoped operator credential is required')
}
const store = createPostgresRuntimeResourceOwnershipStore({ connectionString })
try {
  const identity = await store.database.query<{ operator_id: string }>('SELECT session_user AS operator_id')
  const operatorId = identity.rows[0]?.operator_id
  if (!operatorId || process.env.KALA_ARENA_OPERATOR_ID !== operatorId) {
    throw new Error('Authenticated PostgreSQL LOGIN must match the incident operator identity')
  }
  const scope = {
    organizationId, unitId: parseTenantRuntimeUnitId(unitId), resourceType: 'session' as const, resourceId: sessionId,
  }
  const effect = (await store.inspectOperatorArenaEffects(scope, 100)).find((row) => row.effectId === effectId)
  if (!effect?.workspaceId || (await store.inspectOperatorArenaDispatch(scope, effectId))?.started !== false) {
    throw new Error('No matching persistent never-dispatched effect; dispatched UNKNOWN remains fenced')
  }
  await store.reconcileLearningPrepared({
    scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId, operatorId, incidentId,
  })
  console.log(JSON.stringify({ reconciled: effectId, proof: 'never_dispatched', auditIncident: incidentId }))
} finally {
  await store.close()
}
