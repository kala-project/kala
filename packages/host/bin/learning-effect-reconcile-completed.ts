import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { createPostgresRuntimeResourceOwnershipStore } from '../src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'

const executorModule = (path: string) => new URL(import.meta.url.endsWith('.js')
  ? `../../../executor/dist/src/${path}.js` : `../../executor/src/${path}.ts`, import.meta.url).href
const { ExecutionReceiptStore, learningReceiptArchivePath } = await import(executorModule('execution-receipts'))
const { assertExecutorStopped, assertGroupStopped } = await import(executorModule('tools/arena-process-groups'))
const { assertArenaKeeper } = await import(executorModule('arena-keeper'))
const { createSandbox } = await import(executorModule('sandbox'))

const [organizationId, rawUnitId, sessionId, effectId, workspaceRoot, targetPath,
  journalPath, keeperPath, incidentId, confirmation] = process.argv.slice(2)
const secretPath = process.env.KALA_ARENA_RECONCILE_OPERATOR_URL_FILE
const effectPattern = /^(?:skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u
if (process.platform !== 'linux' || !secretPath || !organizationId || !rawUnitId || !sessionId
  || !effectId || !effectPattern.test(effectId) || !workspaceRoot || !targetPath
  || !journalPath || !keeperPath || !incidentId || process.argv.length !== 12
  || ![`verify-stopped:${effectId}`, `verify-never-admitted:${effectId}`].includes(confirmation ?? '')) {
  throw new Error('Linux-only operator usage: KALA_ARENA_RECONCILE_OPERATOR_URL_FILE=<0600-file> KALA_ARENA_OPERATOR_ID=<login> node dist/bin/learning-effect-reconcile-completed.js <org> <unit> <session> <effect> <canonical-workspace-root> <target-path> <original-journal> <original-keeper-file> <incident> verify-stopped:<effect>|verify-never-admitted:<effect>')
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const privateFile = async (path: string) => {
  const info = await lstat(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Original journal and operator credential must be owner-only regular files')
  }
}
await privateFile(secretPath)
await privateFile(journalPath)
const connectionString = (await readFile(secretPath, 'utf8')).trim()
if (!connectionString || new URL(connectionString).pathname === '/runlab_control') {
  throw new Error('Dedicated scoped operator credential is required')
}
if (await realpath(workspaceRoot) !== workspaceRoot) throw new Error('Noncanonical workspace root')
if (process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE
  && await readlink('/proc/self/ns/pid') !== process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE) {
  throw new Error('Operator is not in the original Executor PID namespace')
}
const store = createPostgresRuntimeResourceOwnershipStore({ connectionString })
try {
  const identity = await store.database.query<{ operator_id: string }>('SELECT session_user AS operator_id')
  const operatorId = identity.rows[0]?.operator_id
  if (!operatorId || process.env.KALA_ARENA_OPERATOR_ID !== operatorId) {
    throw new Error('Authenticated PostgreSQL LOGIN must match the incident operator identity')
  }
  const scope = {
    organizationId, unitId: parseTenantRuntimeUnitId(rawUnitId), resourceType: 'session' as const, resourceId: sessionId,
  }
  const effect = (await store.inspectOperatorArenaEffects(scope, 100)).find((row) => row.effectId === effectId)
  const dispatch = await store.inspectOperatorArenaDispatch(scope, effectId)
  if (!effect?.workspaceId || dispatch?.started !== true || !dispatch.digest) {
    throw new Error('No matching dispatched learning effect; UNKNOWN remains fenced')
  }
  const journalText = await readFile(journalPath, 'utf8')
  const receipts = new ExecutionReceiptStore(journalPath)
  await receipts.load()
  const receiptKey = `${sessionId}:${effectId}`
  const receipt = receipts.inspectArena(receiptKey)
  const archivePath = learningReceiptArchivePath(journalPath, receiptKey)
  let archiveText: string | undefined
  try {
    await privateFile(archivePath)
    archiveText = await readFile(archivePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const original = JSON.parse(journalText) as Record<string, unknown>
  const pointer = original[receiptKey] as { archiveDigest?: unknown } | undefined
  if (pointer?.archiveDigest !== undefined
    && (!archiveText || pointer.archiveDigest !== sha256(archiveText))) {
    throw new Error('Original archive pointer is missing or changed')
  }
  const verifyJournalUnchanged = async () => {
    if (await readFile(journalPath, 'utf8') !== journalText
      || (archiveText !== undefined && await readFile(archivePath, 'utf8') !== archiveText)) {
      throw new Error('Original journal or archive changed')
    }
  }
  if (confirmation === `verify-never-admitted:${effectId}`) {
    if (receipt.state !== 'denied' || receipt.result?.ok !== false
      || receipt.result.callId !== effectId || receipt.result.failure?.code !== 'learning_not_admitted'
      || receipt.result.content !== 'ERROR: EACCES: learning mutation was not admitted; no tool ran'
      || receipt.ownerGeneration !== String(effect.generation) || receipt.requestDigest !== dispatch.digest
      || receipt.executorProcess || receipt.target || receipt.processGroups?.length) {
      throw new Error('Original journal lacks an exact durable never-admitted learning receipt')
    }
    await verifyJournalUnchanged()
    await store.reconcileLearningDenied({
      scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId, operatorId, incidentId,
      evidence: {
        receiptState: 'denied', neverAdmitted: true, failureCode: 'learning_not_admitted',
        receiptGeneration: receipt.ownerGeneration, requestDigest: receipt.requestDigest,
        journalSha256: sha256(journalText), ...(archiveText ? { archiveSha256: sha256(archiveText) } : {}),
      },
    })
    console.log(JSON.stringify({ reconciled: effectId, proof: 'durable_never_admitted_receipt',
      auditIncident: incidentId }))
  } else {
  if (receipt.state !== 'completed' || receipt.result?.ok !== true
    || receipt.result.callId !== effectId || receipt.ownerGeneration !== String(effect.generation)
    || receipt.requestDigest !== dispatch.digest || !receipt.executorProcess
    || !receipt.target || receipt.target.implementation !== 'builtin-v2'
    || receipt.target.tool !== (effectId.startsWith('skill-file-') ? 'skill_file' : 'memory')) {
    throw new Error('Original journal lacks an exact completed built-in receipt or process/target evidence')
  }
  const keeper = await assertArenaKeeper(keeperPath)
  if (keeper.bootId !== receipt.executorProcess.bootId
    || keeper.pidNamespace !== receipt.executorProcess.pidNamespace) {
    throw new Error('Original Executor and independent keeper do not share Linux process identity')
  }
  await assertExecutorStopped(receipt.executorProcess)
  for (const group of receipt.processGroups ?? []) await assertGroupStopped(group)
  const resolved = await createSandbox({ roots: [workspaceRoot] }).resolve(targetPath)
  if (resolved !== targetPath || sha256(resolved) !== receipt.target.pathDigest) {
    throw new Error('Target is not the exact canonical workspace path bound to the original journal')
  }
  const target = receipt.target
  const result = receipt.result.content
  let observedDigest: string | null = null
  const readBounded = async (path: string, maximum: number) => {
    const info = await stat(path)
    if (!info.isFile() || info.size > maximum) throw new Error('Original target is not a bounded regular file')
    return await readFile(path)
  }
  const assertAbsent = async () => {
    try { await lstat(resolved) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    throw new Error('Deleted target is present; final workspace state is unproven')
  }
  if (target.tool === 'skill_file') {
    const expected = target.action === 'create' ? 'created'
      : target.action === 'replace' ? 'replaced' : target.action === 'delete' ? 'deleted' : undefined
    if (!expected || result !== JSON.stringify({ status: expected })
      || basename(resolved) !== 'SKILL.md'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(basename(dirname(resolved)))) {
      throw new Error('Skill receipt action or canonical target is inconsistent')
    }
    if (expected === 'deleted') await assertAbsent()
    else {
      observedDigest = sha256(await readBounded(resolved, 256 * 1024))
      if (observedDigest !== target.contentDigest) throw new Error('Skill final content revision differs from original request')
    }
  } else {
    const key = basename(resolved).replace(/\.md$/u, '')
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(key) || basename(resolved) !== `${key}.md`
      || target.expectedRevision !== undefined) throw new Error('Invalid memory target')
    if (target.action === 'write') {
      const match = /^(created|updated) scope=workspace key=([a-zA-Z0-9_-]{1,64}) \((\d{1,6}) bytes\)$/u.exec(result)
      if (!match || match[2] !== key) throw new Error('Memory write receipt is inconsistent')
      const bytes = await readBounded(resolved, 128 * 1024)
      if (Number(match[3]) !== bytes.length) throw new Error('Memory write size differs from final target')
      observedDigest = sha256(bytes)
      if (observedDigest !== target.contentDigest) throw new Error('Memory final content differs from original request')
    } else if (target.action === 'delete') {
      await assertAbsent()
      if (result !== `no-op: scope=workspace key=${key} did not exist`) {
        const prefix = `deleted scope=workspace key=${key} (tombstone=.tombstones/`
        if (!result.startsWith(prefix) || !result.endsWith('.json)')) {
          throw new Error('Memory delete receipt is inconsistent')
        }
        const manifestName = result.slice(prefix.length, -1)
        if (!/^[a-zA-Z0-9_-]{1,64}\.[0-9TZ-]+\.md\.json$/u.test(manifestName)
          || !manifestName.startsWith(`${key}.`)) throw new Error('Invalid memory tombstone identity')
        const tombstoneDir = join(dirname(resolved), '.tombstones')
        const manifestPath = join(tombstoneDir, manifestName)
        const archivedPath = join(tombstoneDir, manifestName.slice(0, -5))
        const manifest = JSON.parse((await readBounded(manifestPath, 4_096)).toString('utf8')) as Record<string, unknown>
        if (manifest.schemaVersion !== 1 || manifest.scope !== 'workspace' || manifest.key !== key
          || manifest.originalPath !== resolved || manifest.archivedPath !== archivedPath
          || manifest.archivedFile !== basename(archivedPath)) {
          throw new Error('Original memory tombstone manifest does not match target and receipt')
        }
        observedDigest = sha256(await readBounded(archivedPath, 128 * 1024))
      }
    } else throw new Error('Unsupported original memory action')
  }
  await verifyJournalUnchanged()
  const evidence = {
    receiptState: 'completed', receiptGeneration: receipt.ownerGeneration,
    requestDigest: receipt.requestDigest, resultOk: true, resultDigest: sha256(result),
    tool: target.tool, toolImplementation: target.implementation, action: target.action,
    targetPathDigest: target.pathDigest, ...(target.contentDigest ? { contentDigest: target.contentDigest } : {}),
    ...(target.expectedRevision ? { expectedRevision: target.expectedRevision } : {}),
    observedDigest, finalStateVerified: true, executorStopped: true, processGroupsStopped: true,
    keeperVerified: true, executorProcess: receipt.executorProcess, keeperProcess: keeper,
    processGroups: receipt.processGroups ?? [], journalSha256: sha256(journalText),
    ...(archiveText ? { archiveSha256: sha256(archiveText) } : {}),
  }
  await store.reconcileLearningCompleted({
    scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId, operatorId, incidentId, evidence,
  })
  console.log(JSON.stringify({ reconciled: effectId, proof: 'durable_completed_receipt_and_final_state',
    auditIncident: incidentId }))
  }
} finally {
  await store.close()
}
