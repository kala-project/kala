import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { createPostgresRuntimeResourceOwnershipStore } from '../src/tenant-runtime/postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from '../src/tenant-runtime/unit.js'

const executorModule = (path: string) => new URL(import.meta.url.endsWith('.js')
  ? `../../../executor/dist/src/${path}.js` : `../../executor/src/${path}.ts`, import.meta.url).href
const { ExecutionReceiptStore } = await import(executorModule('execution-receipts'))
const { assertExecutorStopped, assertGroupStopped } = await import(executorModule('tools/arena-process-groups'))
const { arenaReadGit, hasArenaGitFilterDrivers } = await import(executorModule('tools/arena-git-status'))

const [organizationId, rawUnitId, resourceId, effectId, repoRoot, journalPath,
  incidentId, confirmation, mode] = process.argv.slice(2)
const repairInit = mode === '--repair-init'
const prepared = mode === '--prepared'
const probe = mode === '--probe'
const secretPath = process.env.KALA_ARENA_RECONCILE_OPERATOR_URL_FILE
if (!secretPath) throw new Error('Dedicated operator credential file is required')
if (process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE
  && (process.platform !== 'linux'
    || await readlink('/proc/self/ns/pid') !== process.env.KALA_ARENA_EXPECTED_PID_NAMESPACE)) {
  throw new Error('Operator is not in the original Executor PID namespace')
}
const secretInfo = await lstat(secretPath)
if (!secretInfo.isFile() || (secretInfo.mode & 0o077) !== 0 || secretInfo.uid !== process.getuid?.()) {
  throw new Error('Operator credential must be a regular, user-owned file without group/other access')
}
const connectionString = (await readFile(secretPath, 'utf8')).trim()
if (process.platform !== 'linux' || !connectionString || !organizationId || !rawUnitId || !resourceId || !effectId
  || !/^arena-(probe|init|apply|cleanup|status|diff)-[A-Z0-9]+$/u.test(effectId)
  || !repoRoot || !journalPath || !incidentId
  || process.argv.length !== (repairInit || prepared || probe ? 11 : 10)
  || (prepared && (repoRoot !== '-' || journalPath !== '-'))
  || (probe && !effectId.startsWith('arena-probe-'))
  || new URL(connectionString).pathname === '/runlab_control'
  || confirmation !== `verify-stopped:${effectId}`) {
  throw new Error('Linux-only operator usage: KALA_ARENA_RECONCILE_OPERATOR_URL_FILE=<dedicated-role-secret> node dist/bin/arena-effect-reconcile.js <org> <unit> <session> <effect> <canonical-root|-> <original-journal|-> <incident> verify-stopped:<effect> [--prepared|--probe|--repair-init]')
}

const store = createPostgresRuntimeResourceOwnershipStore({ connectionString })
try {
  const identity = await store.database.query<{ operator_id: string }>('SELECT session_user AS operator_id')
  const operatorId = identity.rows[0]?.operator_id
  if (!operatorId || process.env.KALA_ARENA_OPERATOR_ID !== operatorId) {
    throw new Error('Authenticated PostgreSQL LOGIN must match the incident operator identity')
  }
  const scope = {
    organizationId, unitId: parseTenantRuntimeUnitId(rawUnitId), resourceType: 'session' as const, resourceId,
  }
  const effect = (await store.inspectOperatorArenaEffects(scope, 100)).find((row) => row.effectId === effectId)
  if (!effect || !effect.workspaceId) throw new Error('Exact Arena effect not found; no reconciliation')
  const dispatch = await store.inspectOperatorArenaDispatch(scope, effectId)
  if (prepared) {
    if (dispatch?.started !== false) throw new Error('No persistent never-dispatched proof; UNKNOWN remains fenced')
    const arenaState = await store.readArenaAuthorityState(scope)
    const evidence = { action: 'prepared', dispatchStarted: false,
      proof: 'locked_pg_dispatch_intent_before_any_executor_frame', operatorId, incidentId }
    const input = {
      scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId, operatorId, incidentId,
      evidence, arenaState,
    }
    if (effectId.startsWith('arena-init-') && effect.repositoryIdentity) {
      await store.reconcileArenaPreparedInit(input)
    } else {
      await store.reconcileArenaOffline({ ...input, mode: 'prepared' })
    }
    console.log(JSON.stringify({ reconciled: effectId, proof: 'never_dispatched', auditIncident: incidentId }))
  } else {
  if (probe ? dispatch?.started !== true || !dispatch.digest
    : !effect.repositoryIdentity) throw new Error('Exact dispatched Arena effect not found; UNKNOWN remains fenced')
  const receiptText = await readFile(journalPath, 'utf8')
  const receiptStore = new ExecutionReceiptStore(journalPath)
  await receiptStore.load()
  const receipt = receiptStore.inspectArena(`${resourceId}:${effectId}`)
  if ((receipt.state !== 'started' && receipt.state !== 'completed')
    || receipt.ownerGeneration !== String(effect.generation)
    || !receipt.requestDigest || !receipt.executorProcess || !receipt.processGroups?.length) {
    throw new Error('Journal does not prove exact generation, request or process-group identities')
  }
  if (probe && (receipt.state !== 'completed' || receipt.requestDigest !== dispatch?.digest
    || !receipt.result?.ok || receipt.result.callId !== effectId)) {
    throw new Error('Probe has no exact durable final receipt; started UNKNOWN cannot be released')
  }
  await assertExecutorStopped(receipt.executorProcess)
  for (const group of receipt.processGroups) await assertGroupStopped(group)
  if (await realpath(repoRoot) !== repoRoot) throw new Error('Noncanonical repository root')
  const signal = new AbortController().signal
  const common = await arenaReadGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  const commonStat = await stat(common, { bigint: true })
  const observedIdentity = `git-common-inode:${commonStat.dev}:${commonStat.ino}`
  if (await realpath(common) !== common
    || (!probe && observedIdentity !== effect.repositoryIdentity)
    || await hasArenaGitFilterDrivers(repoRoot, signal)) {
    throw new Error('Repository identity or static Git helper configuration is unsafe')
  }
  if (probe) {
    const result = JSON.parse(receipt.result!.content) as Record<string, unknown>
    if (result.finalEffectStopped !== true || result.repoRoot !== repoRoot
      || result.repositoryIdentity !== observedIdentity) {
      throw new Error('Probe receipt does not prove stopped final effect on this repository')
    }
    const arenaState = await store.readArenaAuthorityState(scope)
    if (arenaState && typeof arenaState === 'object' && 'repoRoot' in arenaState
      && (arenaState.repoRoot !== '' && arenaState.repoRoot !== repoRoot)) {
      throw new Error('Current authoritative Arena state identifies another repository')
    }
    if (await readFile(journalPath, 'utf8') !== receiptText) throw new Error('Original journal changed')
    await store.reconcileArenaOffline({
      scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId, operatorId, incidentId,
      arenaState, mode: 'probe',
      evidence: { action: 'probe', receiptState: 'completed', receiptGeneration: receipt.ownerGeneration,
        finalEffectStopped: true, executorStopped: true, gitGroupsStopped: true,
        requestDigest: receipt.requestDigest, journalSha256: createHash('sha256').update(receiptText).digest('hex'),
        repoRoot, repositoryIdentity: observedIdentity, operatorId, incidentId,
        processGroups: receipt.processGroups },
    })
    console.log(JSON.stringify({ reconciled: effectId, proof: 'durable_probe_receipt', auditIncident: incidentId }))
  } else {
  if (!effect.repositoryIdentity) throw new Error('Claimed Arena repository identity is missing')
  const stateText = JSON.stringify(await store.readArenaAuthorityState(scope))
  if (!stateText) throw new Error('No authoritative durable Arena state for a live Session in PostgreSQL')
  let state = JSON.parse(stateText) as {
    repoRoot?: string; repositoryIdentity?: string; arenaId?: string; baseRef?: string; baseSha?: string; updatedAt?: string
    status?: string; selectedWinner?: string
    candidates?: Array<{ id: string; branch: string; worktreePath: string; status: string }>
  }
  const action = effectId.split('-')[1]!
  const git = async (path: string, args: string[]) => await arenaReadGit(path, args, signal)
  if (repairInit) {
    if (action !== 'init' || receipt.state !== 'started' || state.status !== 'initializing'
      || state.repoRoot !== '' || state.baseSha !== '' || !state.arenaId
      || !/^[A-Za-z0-9_-]{1,48}$/u.test(state.arenaId)
      || !state.baseRef || typeof state.baseRef !== 'string' || state.baseRef.length > 200
      || !Array.isArray(state.candidates) || state.candidates.length < 1 || state.candidates.length > 6
      || state.candidates.some((candidate) => candidate.status !== 'pending'
        || candidate.worktreePath !== '' || !/^[A-Za-z0-9_-]{1,48}$/u.test(candidate.id)
        || candidate.branch !== `kala-arena/${state.arenaId}/${candidate.id}`)
      || new Set(state.candidates.map((candidate) => candidate.id)).size !== state.candidates.length) {
      throw new Error('Only an intact persisted init intent and original UNKNOWN receipt can be repaired')
    }
    const baseSha = await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${state.baseRef}^{commit}`])
    if (!/^[a-f0-9]{40,64}$/u.test(baseSha)) throw new Error('Arena base ref cannot be verified')
    const discovered = (await readdir(join(repoRoot, '.kala-arena', state.arenaId))).sort()
    if (JSON.stringify(discovered) !== JSON.stringify(state.candidates.map((candidate) => candidate.id).sort())) {
      throw new Error('Unexpected or incomplete Arena worktree directory')
    }
    const branches = (await git(repoRoot, ['for-each-ref', '--format=%(refname:short)',
      `refs/heads/kala-arena/${state.arenaId}/`])).split('\n').filter(Boolean).sort()
    if (JSON.stringify(branches) !== JSON.stringify(state.candidates.map((candidate) => candidate.branch).sort())) {
      throw new Error('Unexpected or incomplete Arena candidate branches')
    }
    state = { ...state, repoRoot, repositoryIdentity: effect.repositoryIdentity, baseSha,
      updatedAt: new Date().toISOString(), status: 'active',
      candidates: state.candidates.map((candidate) => ({ ...candidate,
        worktreePath: join(repoRoot, '.kala-arena', state.arenaId!, candidate.id), status: 'active' })) }
  }
  if (state.repoRoot !== repoRoot || state.repositoryIdentity !== effect.repositoryIdentity
    || !state.arenaId || !/^[A-Za-z0-9_-]{1,48}$/u.test(state.arenaId)
    || !/^[a-f0-9]{40,64}$/u.test(state.baseSha ?? '')
    || !Array.isArray(state.candidates) || state.candidates.length > 6) {
    throw new Error('Authoritative Session state export does not identify this repository and Arena')
  }
  const present = async (path: string) => await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const noWorktree = async (candidate: NonNullable<typeof state.candidates>[number]) => {
    if (await present(candidate.worktreePath) || await git(repoRoot, ['branch', '--list', candidate.branch])) {
      throw new Error(`Candidate ${candidate.id} still has a worktree or branch`)
    }
  }
  for (const candidate of state.candidates) {
    if (!/^[A-Za-z0-9_-]{1,48}$/u.test(candidate.id)
      || candidate.branch !== `kala-arena/${state.arenaId}/${candidate.id}`
      || candidate.worktreePath !== join(repoRoot, '.kala-arena', state.arenaId, candidate.id)) {
      throw new Error('Candidate path/branch does not match canonical Arena identity')
    }
    if (candidate.status === 'cleaned') { await noWorktree(candidate); continue }
    if (await realpath(candidate.worktreePath) !== candidate.worktreePath
      || await git(candidate.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== common
      || await git(candidate.worktreePath, ['branch', '--show-current']) !== candidate.branch
      || await hasArenaGitFilterDrivers(candidate.worktreePath, signal)) {
      throw new Error(`Candidate ${candidate.id} has an unsafe Git identity or helper`)
    }
  }
  let releaseClaimArenaId: string | undefined
  if (action === 'init') {
    if (state.status !== 'active' || state.candidates.some((candidate) => candidate.status !== 'active')
      || (await Promise.all(state.candidates.map(async (candidate) =>
        await git(candidate.worktreePath, ['rev-parse', 'HEAD'])))).some((head) => head !== state.baseSha)) {
      throw new Error('Init is not completely reflected in durable Arena state and Git worktrees')
    }
  } else if (action === 'apply') {
    const winner = state.candidates.find((candidate) => candidate.id === state.selectedWinner)
    if (state.status !== 'applied' || !winner || winner.status !== 'applied') {
      throw new Error('Apply is not reflected in durable Arena state')
    }
    const rootHead = await git(repoRoot, ['rev-parse', 'HEAD'])
    const candidateHead = await git(winner.worktreePath, ['rev-parse', 'HEAD'])
    const rootPatch = await git(repoRoot, ['diff', '--cached', '--binary', state.baseSha!])
    const rootStaged = await git(repoRoot, ['diff', '--cached', '--binary'])
    const candidatePatch = await git(winner.worktreePath, ['diff', '--cached', '--binary', state.baseSha!])
    if (!(rootHead === candidateHead && rootHead !== state.baseSha && !rootStaged
      && !await git(repoRoot, ['status', '--porcelain', '--untracked-files=normal']))
      && !(rootHead === state.baseSha && rootPatch && rootPatch === candidatePatch)) {
      throw new Error('Primary HEAD/index do not prove the selected merge or patch effect')
    }
  } else if (action === 'cleanup') {
    if (state.status !== 'cleaned' || state.candidates.some((candidate) => candidate.status !== 'cleaned')
      || await present(join(repoRoot, '.kala-arena', state.arenaId))
      || (await git(repoRoot, ['worktree', 'list', '--porcelain'])).includes(`/.kala-arena/${state.arenaId}/`)) {
      throw new Error('Cleanup has not removed all worktrees and branches')
    }
    releaseClaimArenaId = state.arenaId
  } else if (state.status === 'initializing' || state.status === 'applying') {
    throw new Error('Read action has unresolved durable state')
  }
  const claimArenaId = action === 'cleanup'
    ? await store.inspectOperatorArenaClaim(scope, effect.repositoryIdentity) : undefined
  if (claimArenaId !== undefined && claimArenaId !== null && claimArenaId !== state.arenaId) {
    throw new Error('Original Arena claim belongs to another Arena')
  }
  const evidence = {
    action, operatorId, incidentId, processGroups: receipt.processGroups,
    ...(action === 'cleanup' && claimArenaId === null ? { claimMissing: true } : {}),
    journalSha256: createHash('sha256').update(receiptText).digest('hex'),
    stateSha256: createHash('sha256').update(stateText).digest('hex'),
    stateSource: 'kala_arena_operator_state:worktree_arena.state',
    repositoryIdentity: effect.repositoryIdentity, repoRoot,
    rootHead: await git(repoRoot, ['rev-parse', 'HEAD']),
    receiptState: receipt.state, requestDigest: receipt.requestDigest,
  }
  if (await readFile(journalPath, 'utf8') !== receiptText
    || JSON.stringify(await store.readArenaAuthorityState(scope)) !== stateText) {
    throw new Error('Journal or authoritative state changed during reconciliation')
  }
  if (repairInit) {
    await store.repairArenaInit({
      scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId,
      repositoryIdentity: effect.repositoryIdentity, operatorId, incidentId,
      oldState: JSON.parse(stateText) as Record<string, unknown>, newState: state,
      evidence: { ...evidence, repair: 'observed-init-worktrees', oldStateSha256:
        createHash('sha256').update(stateText).digest('hex') },
    })
    console.log(JSON.stringify({ repaired: effectId, effectStillUnknown: true, auditIncident: incidentId }))
  } else {
    await store.reconcileArenaEffect({
      scope, effectId, generation: effect.generation, workspaceId: effect.workspaceId,
      repositoryIdentity: effect.repositoryIdentity, operatorId, incidentId, evidence, arenaState: state,
      ...(releaseClaimArenaId ? { releaseClaimArenaId } : {}),
    })
    console.log(JSON.stringify({ reconciled: effectId, auditIncident: incidentId }))
  }
  }
  }
} finally { await store.close() }
