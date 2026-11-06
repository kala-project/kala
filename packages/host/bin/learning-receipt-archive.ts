import { lstat, readFile, readlink, realpath } from 'node:fs/promises'

import { createPostgresRuntimeResourceOwnershipStore } from '../src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'

const executorModule = (path: string) => new URL(import.meta.url.endsWith('.js')
  ? `../../../executor/dist/src/${path}.js` : `../../executor/src/${path}.ts`, import.meta.url).href
const { ExecutionReceiptStore } = await import(executorModule('execution-receipts'))
const { assertArenaKeeper } = await import(executorModule('arena-keeper'))
const { assertExecutorStopped, assertGroupStopped } = await import(executorModule('tools/arena-process-groups'))

const [action, ...args] = process.argv.slice(2)
if (process.platform !== 'linux') throw new Error('Learning receipt archive operations require Linux')
if (action === 'status' && args.length === 1) {
  const receipts = new ExecutionReceiptStore(args[0]!)
  await receipts.load()
  console.log(JSON.stringify(receipts.archiveHealth()))
} else if (action === 'verify' && args.length === 4) {
  const [journalPath, coldDirectory, sessionId, effectId] = args as [string, string, string, string]
  const receipts = new ExecutionReceiptStore(journalPath)
  await receipts.load()
  await receipts.verifyOfflineRetirement(`${sessionId}:${effectId}`, coldDirectory)
  console.log(JSON.stringify({ verified: effectId }))
} else if (action === 'retire' && args.length === 9) {
  const [organizationId, rawUnitId, sessionId, effectId, journalPath,
    keeperPath, coldDirectory, incidentId, confirmation] = args as [
    string, string, string, string, string, string, string, string, string]
  if (!/^(?:skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u.test(effectId)
    || !incidentId || confirmation !== `verify-finalized:${effectId}`) {
    throw new Error('Invalid offline learning receipt retirement identity')
  }
  const secretPath = process.env.KALA_ARENA_RECONCILE_OPERATOR_URL_FILE
  if (!secretPath) throw new Error('Dedicated tenant operator credential is required')
  const ownerFile = async (path: string) => {
    const info = await lstat(path)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error('Operator credential and original journal must be owner-only regular files')
    }
  }
  await ownerFile(secretPath)
  await ownerFile(journalPath)
  if (await realpath(coldDirectory) !== coldDirectory) throw new Error('Offline directory must be canonical')
  const cold = await lstat(coldDirectory)
  const local = await lstat(journalPath)
  if (!cold.isDirectory() || (cold.mode & 0o077) !== 0 || cold.uid !== process.getuid?.()
    || cold.dev === local.dev) {
    throw new Error('Offline directory must be owner-only on a distinct mounted filesystem')
  }
  if (process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE
    && await readlink('/proc/self/ns/pid') !== process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE) {
    throw new Error('Operator is not in the original Executor PID namespace')
  }
  const connectionString = (await readFile(secretPath, 'utf8')).trim()
  if (!connectionString || new URL(connectionString).pathname === '/runlab_control') {
    throw new Error('Dedicated scoped operator credential is required')
  }
  const receipts = new ExecutionReceiptStore(journalPath)
  await receipts.load()
  const key = `${sessionId}:${effectId}`
  const receipt = receipts.inspectArena(key)
  const retirement = receipts.inspectRetirement(key)
  const store = createPostgresRuntimeResourceOwnershipStore({ connectionString })
  try {
    const identity = await store.database.query<{ operator_id: string }>('SELECT session_user AS operator_id')
    if (!identity.rows[0]?.operator_id || identity.rows[0].operator_id !== process.env.KALA_ARENA_OPERATOR_ID) {
      throw new Error('Authenticated PostgreSQL LOGIN must match the incident operator identity')
    }
    const scope = {
      organizationId, unitId: parseTenantRuntimeUnitId(rawUnitId), resourceType: 'session' as const, resourceId: sessionId,
    }
    const finalized = await store.inspectOperatorLearningFinalization(scope, effectId)
    if (!finalized || await store.inspectOperatorArenaDispatch(scope, effectId)
      || (retirement?.ownerGeneration ?? receipt.ownerGeneration) !== String(finalized.generation)
      || (retirement?.requestDigest ?? receipt.requestDigest) !== finalized.requestDigest
      || !finalized.workspaceId) {
      throw new Error('Exact PostgreSQL learning effect finalization is not proven')
    }
    if (retirement) {
      // The durable tombstone was written only after the original cold copy
      // and exact finalization were verified. Retry removes an orphaned online
      // copy without opening a new execution identity.
    } else if (receipt.state === 'completed') {
      if (!receipt.executorProcess || receipt.target?.implementation !== 'builtin-v2') {
        throw new Error('Legacy or custom learning completion cannot be retired')
      }
      const keeper = await assertArenaKeeper(keeperPath)
      if (keeper.bootId !== receipt.executorProcess.bootId
        || keeper.pidNamespace !== receipt.executorProcess.pidNamespace) {
        throw new Error('Independent keeper does not match the original Executor')
      }
      await assertExecutorStopped(receipt.executorProcess)
      for (const group of receipt.processGroups ?? []) await assertGroupStopped(group)
    } else if (receipt.state !== 'denied' || receipt.result?.failure?.code !== 'learning_not_admitted') {
      throw new Error('Started, missing or uncertain learning effect cannot be retired')
    }
    await receipts.retireFinalizedLearning(key, finalized.requestDigest,
      String(finalized.generation), coldDirectory, incidentId)
    console.log(JSON.stringify({ retired: effectId, incidentId,
      activeBytes: receipts.archiveHealth().activeBytes }))
  } finally { await store.close() }
} else {
  throw new Error('Usage: learning-receipt-archive status <journal> | verify <journal> <offline-directory> <session> <effect> | retire <org> <unit> <session> <effect> <journal> <keeper> <distinct-offline-mounted-directory> <incident> verify-finalized:<effect>')
}
