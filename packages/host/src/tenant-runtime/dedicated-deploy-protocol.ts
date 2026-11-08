import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { UnitQuiescence } from './quiescence.js'
import type { DedicatedSlot } from './dedicated-slot-state.js'

export const DEDICATED_DEPLOY_SCHEMA_VERSION = 1 as const
export const DEDICATED_DEPLOY_TOPOLOGY = 'dedicated-slots' as const

const releaseMetadataArchive = 'kala-release-metadata.tar.gz'
const releaseChecksumSignature = 'SHA256SUMS.sigstore.json'
const modernReleaseFileCount = 27
const localDevelopmentAssets = [
  'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs',
  'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
  'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz',
  'kala-release-metadata.tar.gz', 'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
] as const
const legacyLocalDevelopmentAssets = [
  ...localDevelopmentAssets, 'kala-copilot-runtime-linux-x64', 'kala-copilot-runtime-node-linux-x64.node',
]
const dedicatedSupportArchive = 'kala-dedicated-support.tar.gz'
const dedicatedSupportManifest = 'dedicated-support-manifest.json'
const dedicatedSupportAssets = [
  'cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs',
  'deploy-dashboard.mjs', 'deploy-dedicated.mjs', 'deployment.json', 'install-dedicated-systemd.mjs',
  'kala-dedicated-control-updater.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-ingress.service',
  'kala-dedicated-migration-finalizer.service', 'kala-dedicated-unit@.service', 'rollback-dedicated-systemd.mjs',
  'update-dedicated-control-plane.mjs',
] as const

export type DedicatedDeployAction = 'deploy' | 'restart' | 'abort' | 'rollback'

export type DedicatedDeployRequest = {
  schemaVersion: typeof DEDICATED_DEPLOY_SCHEMA_VERSION
  action: DedicatedDeployAction
  operationId: string
  deploymentId: string
  topology: typeof DEDICATED_DEPLOY_TOPOLOGY
  unitId: 'local'
  requestedAt: string
  expectedRouteGeneration: number
  fencingToken: string
  sourceReleaseDigest: string
  targetReleaseDigest: string
  predecessorReleaseId: string
  candidateSlot: DedicatedSlot
  releaseId?: string
  stagedReleaseDir?: string
  bundleSha256?: string
  targetDeploymentId?: string
  origin?: { sessionId: string; callId: string }
}

export type DeploymentPhase =
  | 'staged'
  | 'validating'
  | 'control_updating'
  | 'control_ready'
  | 'waiting_for_origin_result'
  | 'waiting_for_boundary'
  | 'reserved'
  | 'handed_off'
  | 'activating'
  | 'verifying'
  | 'route_committing'
  | 'completed'
  | 'abort_requested'
  | 'aborted'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_failed'
  | 'failed'

export type RedactedDeploymentError = { code: string; message: string; at: string }

export type DeploymentReceipt = {
  schemaVersion: typeof DEDICATED_DEPLOY_SCHEMA_VERSION
  receiptRevision: number
  deploymentId: string
  operationId: string
  operationIds: readonly string[]
  requestDigest: string
  operationRequestDigests: Readonly<Record<string, string>>
  action: DedicatedDeployAction
  topology: typeof DEDICATED_DEPLOY_TOPOLOGY
  unitId: 'local'
  phase: DeploymentPhase
  releaseId: string
  releaseDir: string
  bundleSha256: string
  releaseDigest: string
  sourceReleaseDigest: string
  requestedAt: string
  updatedAt: string
  expectedRouteGeneration: number
  observedRouteGeneration?: number
  routeGeneration?: number
  fencingToken: string
  predecessorReleaseId: string
  previousRelease?: string
  previousSlot?: DedicatedSlot
  candidateSlot: DedicatedSlot
  activatedPid?: number
  origin?: { sessionId: string; callId: string }
  originResultPersistedAt?: string
  targetDeploymentId?: string
  plannedRestart?: { attemptId: string; participants: number; checkpointed: number }
  processReadyAt?: string
  runtimeReadyAt?: string
  controlPlane?: {
    previousSupervisorPid: number
    previousIngressPid: number
    ingressPid: number
    supervisorPid?: number
    activatedAt: string
    readyAt?: string
  }
  quiescence?: UnitQuiescence
  blockers?: readonly string[]
  continuation?: {
    attemptId?: string
    participants: number
    completed: number
    failed: number
    sessions?: readonly {
      sessionId: string
      cursor: number
      checkpointKind?: string
      resumeAction: string
      outcome: 'pending' | 'running' | 'adopted' | 'settled' | 'completed' | 'failed'
    }[]
  }
  admission?: { pending: number; reconciled: number; oldestAgeMs: number }
  health?: { capabilities: boolean; digest: boolean; publicRoute: boolean }
  rollback?: {
    predecessorReleaseId: string
    outcome: 'pending' | 'completed' | 'failed'
    pid?: number
    deployment?: NonNullable<import('@agent-kernel/shared').HostRestartAttempt['deployment']>
    mode?: 'cancel' | 'replace'
    stage?: 'preparing' | 'waiting_for_boundary' | 'handed_off' | 'verifying_live' | 'activating_predecessor' | 'activating' | 'verifying' | 'reconciling_admission' | 'route_committing'
  }
  error?: RedactedDeploymentError
}

type ContinuationSession = NonNullable<DeploymentReceipt['continuation']>['sessions'] extends readonly (infer T)[] | undefined ? T : never

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u
const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const tokenPattern = /^[A-Za-z0-9_-]{16,128}$/u
const checkpointKinds = ['resting', 'before_llm', 'before_tool_dispatch', 'waiting_for_approval'] as const
const resumeActions = ['none', 'wait_for_approval', 'continue_turn', 'drain_queue'] as const
// `completed` was emitted by the original schema-v1 Supervisor receipts, while
// Runtime readiness uses the more precise `adopted`/`settled` terminal states.
// A schema-v1 reader must accept every terminal value written by a schema-v1
// writer so a Supervisor restart cannot be wedged by its own durable history.
const continuationOutcomes = ['pending', 'running', 'adopted', 'settled', 'completed', 'failed'] as const
const agentStatuses = ['missing', 'idle', 'thinking', 'awaiting_approval', 'executing_tools', 'done', 'error'] as const
const waitingKinds = ['none', 'llm', 'tool', 'compaction', 'turn', 'idle'] as const
const receiptFields = new Set([
  'schemaVersion', 'receiptRevision', 'deploymentId', 'operationId', 'operationIds', 'requestDigest',
  'operationRequestDigests', 'action', 'topology', 'unitId', 'phase', 'releaseId', 'releaseDir',
  'bundleSha256', 'releaseDigest', 'sourceReleaseDigest', 'requestedAt', 'updatedAt',
  'expectedRouteGeneration', 'observedRouteGeneration', 'routeGeneration', 'fencingToken',
  'predecessorReleaseId', 'previousRelease', 'previousSlot', 'candidateSlot', 'activatedPid',
  'origin', 'originResultPersistedAt', 'targetDeploymentId', 'plannedRestart', 'processReadyAt',
  'runtimeReadyAt', 'controlPlane', 'quiescence', 'blockers', 'continuation', 'admission', 'health', 'rollback', 'error',
])
const continuationFields = new Set(['attemptId', 'participants', 'completed', 'failed', 'sessions'])
const continuationSessionFields = new Set(['sessionId', 'cursor', 'checkpointKind', 'resumeAction', 'outcome'])
const rollbackFields = new Set(['predecessorReleaseId', 'outcome', 'pid', 'deployment', 'mode', 'stage'])
const deploymentFenceFields = new Set(['deploymentId', 'targetReleaseDigest', 'expectedRouteGeneration', 'fencingToken'])
const quiescenceFields = new Set(['safe', 'queueStable', 'activeLlmCalls', 'activeToolCalls', 'activeCompactions', 'unsafeSessions', 'observedAt'])
const quiescenceSessionFields = new Set(['sessionId', 'status', 'safe', 'waiting', 'checkpointKind', 'cursor'])

export function parseDedicatedDeployRequest(value: unknown): DedicatedDeployRequest {
  const input = record(value, 'deployment request')
  if (input.schemaVersion !== DEDICATED_DEPLOY_SCHEMA_VERSION) throw new Error('unsupported deployment request schema version')
  const action = oneOf(input.action, ['deploy', 'restart', 'abort', 'rollback'] as const, 'action')
  const request: DedicatedDeployRequest = {
    schemaVersion: DEDICATED_DEPLOY_SCHEMA_VERSION,
    action,
    operationId: identifier(input.operationId, 'operationId'),
    deploymentId: identifier(input.deploymentId, 'deploymentId'),
    topology: oneOf(input.topology, [DEDICATED_DEPLOY_TOPOLOGY] as const, 'topology'),
    unitId: oneOf(input.unitId, ['local'] as const, 'unitId'),
    requestedAt: timestamp(input.requestedAt, 'requestedAt'),
    expectedRouteGeneration: positiveInteger(input.expectedRouteGeneration, 'expectedRouteGeneration'),
    fencingToken: pattern(input.fencingToken, tokenPattern, 'fencingToken'),
    sourceReleaseDigest: pattern(input.sourceReleaseDigest, digestPattern, 'sourceReleaseDigest'),
    targetReleaseDigest: pattern(input.targetReleaseDigest, digestPattern, 'targetReleaseDigest'),
    predecessorReleaseId: pattern(input.predecessorReleaseId, releasePattern, 'predecessorReleaseId'),
    candidateSlot: oneOf(input.candidateSlot, ['blue', 'green'] as const, 'candidateSlot'),
  }
  if (action === 'deploy') {
    if (input.targetDeploymentId !== undefined) throw new Error('deploy request cannot include targetDeploymentId')
    request.releaseId = pattern(input.releaseId, releasePattern, 'releaseId')
    request.stagedReleaseDir = absolutePath(input.stagedReleaseDir, 'stagedReleaseDir')
    request.bundleSha256 = pattern(input.bundleSha256, digestPattern, 'bundleSha256')
  } else if (action === 'restart') {
    if (input.releaseId !== undefined || input.stagedReleaseDir !== undefined || input.bundleSha256 !== undefined || input.targetDeploymentId !== undefined) throw new Error('restart request cannot include staged or target deployment fields')
    if (request.sourceReleaseDigest !== request.targetReleaseDigest) throw new Error('restart must preserve the active immutable release')
  } else {
    if (input.releaseId !== undefined || input.stagedReleaseDir !== undefined || input.bundleSha256 !== undefined) throw new Error(`${action} request cannot include staged release fields`)
    request.targetDeploymentId = identifier(input.targetDeploymentId, 'targetDeploymentId')
  }
  if (input.origin !== undefined) {
    const origin = record(input.origin, 'origin')
    request.origin = { sessionId: identifier(origin.sessionId, 'origin.sessionId'), callId: identifier(origin.callId, 'origin.callId') }
    rejectUnknownFields(origin, new Set(['sessionId', 'callId']), 'origin')
  }
  const allowed = new Set([
    'schemaVersion', 'action', 'operationId', 'deploymentId', 'topology', 'unitId', 'requestedAt',
    'expectedRouteGeneration', 'fencingToken', 'sourceReleaseDigest', 'targetReleaseDigest',
    'predecessorReleaseId', 'candidateSlot', 'releaseId', 'stagedReleaseDir', 'bundleSha256',
    'targetDeploymentId', 'origin',
  ])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown deployment request field: ${key}`)
  return request
}

export function deploymentRequestDigest(request: DedicatedDeployRequest): string {
  return sha256(Buffer.from(stableJson(request)))
}

export function parseDeploymentReceipt(value: unknown): DeploymentReceipt {
  const input = record(value, 'deployment receipt')
  if (input.schemaVersion !== DEDICATED_DEPLOY_SCHEMA_VERSION) throw new Error('unsupported deployment receipt schema version')
  const phase = oneOf(input.phase, [
    'staged', 'validating', 'control_updating', 'control_ready', 'waiting_for_origin_result', 'waiting_for_boundary', 'reserved', 'handed_off',
    'activating', 'verifying', 'route_committing', 'completed', 'abort_requested', 'aborted',
    'rolling_back', 'rolled_back', 'rollback_failed', 'failed',
  ] as const, 'phase')
  const operationIds = stringArray(input.operationIds, 'operationIds').map((id) => identifier(id, 'operationIds item'))
  if (operationIds.length === 0 || new Set(operationIds).size !== operationIds.length) throw new Error('operationIds must be non-empty and unique')
  const operationId = identifier(input.operationId, 'operationId')
  if (!operationIds.includes(operationId)) throw new Error('operationIds must contain operationId')
  const operationRequestDigestsInput = record(input.operationRequestDigests, 'operationRequestDigests')
  const operationRequestDigests = Object.fromEntries(Object.entries(operationRequestDigestsInput).map(([id, digest]) => [identifier(id, 'operation request id'), pattern(digest, digestPattern, 'operation request digest')]))
  if (Object.keys(operationRequestDigests).length !== operationIds.length || operationIds.some((id) => !operationRequestDigests[id])) throw new Error('operationRequestDigests must exactly cover operationIds')
  const requestDigest = pattern(input.requestDigest, digestPattern, 'requestDigest')
  if (operationRequestDigests[operationId] !== requestDigest) throw new Error('requestDigest must match the current operationId digest')
  const receipt: DeploymentReceipt = {
    schemaVersion: DEDICATED_DEPLOY_SCHEMA_VERSION, receiptRevision: positiveInteger(input.receiptRevision, 'receiptRevision'),
    deploymentId: identifier(input.deploymentId, 'deploymentId'), operationId, operationIds,
    requestDigest, operationRequestDigests,
    action: oneOf(input.action, ['deploy', 'restart', 'abort', 'rollback'] as const, 'action'),
    topology: oneOf(input.topology, [DEDICATED_DEPLOY_TOPOLOGY] as const, 'topology'), unitId: oneOf(input.unitId, ['local'] as const, 'unitId'), phase,
    releaseId: pattern(input.releaseId, releasePattern, 'releaseId'), releaseDir: absolutePath(input.releaseDir, 'releaseDir'),
    bundleSha256: pattern(input.bundleSha256, digestPattern, 'bundleSha256'), releaseDigest: pattern(input.releaseDigest, digestPattern, 'releaseDigest'),
    sourceReleaseDigest: pattern(input.sourceReleaseDigest, digestPattern, 'sourceReleaseDigest'),
    requestedAt: timestamp(input.requestedAt, 'requestedAt'), updatedAt: timestamp(input.updatedAt, 'updatedAt'),
    expectedRouteGeneration: positiveInteger(input.expectedRouteGeneration, 'expectedRouteGeneration'),
    fencingToken: pattern(input.fencingToken, tokenPattern, 'fencingToken'),
    predecessorReleaseId: pattern(input.predecessorReleaseId, releasePattern, 'predecessorReleaseId'),
    candidateSlot: oneOf(input.candidateSlot, ['blue', 'green'] as const, 'candidateSlot'),
  }
  optionalInteger(input, receipt, 'observedRouteGeneration', 1)
  optionalInteger(input, receipt, 'routeGeneration', 1)
  optionalInteger(input, receipt, 'activatedPid', 1)
  optionalString(input, receipt, 'previousRelease', (item) => absolutePath(item, 'previousRelease'))
  optionalString(input, receipt, 'previousSlot', (item) => oneOf(item, ['blue', 'green'] as const, 'previousSlot'))
  optionalString(input, receipt, 'originResultPersistedAt', (item) => timestamp(item, 'originResultPersistedAt'))
  optionalString(input, receipt, 'targetDeploymentId', (item) => identifier(item, 'targetDeploymentId'))
  optionalString(input, receipt, 'processReadyAt', (item) => timestamp(item, 'processReadyAt'))
  optionalString(input, receipt, 'runtimeReadyAt', (item) => timestamp(item, 'runtimeReadyAt'))
  if (input.origin !== undefined) { const origin = record(input.origin, 'origin'); receipt.origin = { sessionId: identifier(origin.sessionId, 'origin.sessionId'), callId: identifier(origin.callId, 'origin.callId') }; rejectUnknownFields(origin, new Set(['sessionId', 'callId']), 'origin') }
  if (input.controlPlane !== undefined) {
    const control = record(input.controlPlane, 'controlPlane')
    receipt.controlPlane = {
      previousSupervisorPid: positiveInteger(control.previousSupervisorPid, 'controlPlane.previousSupervisorPid'),
      previousIngressPid: positiveInteger(control.previousIngressPid, 'controlPlane.previousIngressPid'),
      ingressPid: positiveInteger(control.ingressPid, 'controlPlane.ingressPid'),
      activatedAt: timestamp(control.activatedAt, 'controlPlane.activatedAt'),
      ...(control.supervisorPid === undefined ? {} : { supervisorPid: positiveInteger(control.supervisorPid, 'controlPlane.supervisorPid') }),
      ...(control.readyAt === undefined ? {} : { readyAt: timestamp(control.readyAt, 'controlPlane.readyAt') }),
    }
    rejectUnknownFields(control, new Set(['previousSupervisorPid', 'previousIngressPid', 'ingressPid', 'supervisorPid', 'activatedAt', 'readyAt']), 'controlPlane')
  }
  if (input.plannedRestart !== undefined) { const restart = record(input.plannedRestart, 'plannedRestart'); receipt.plannedRestart = { attemptId: identifier(restart.attemptId, 'plannedRestart.attemptId'), participants: nonNegativeInteger(restart.participants, 'plannedRestart.participants'), checkpointed: nonNegativeInteger(restart.checkpointed, 'plannedRestart.checkpointed') }; rejectUnknownFields(restart, new Set(['attemptId', 'participants', 'checkpointed']), 'plannedRestart'); if (receipt.plannedRestart.checkpointed > receipt.plannedRestart.participants) throw new Error('plannedRestart checkpoint count exceeds participants') }
  if (input.blockers !== undefined) { receipt.blockers = stringArray(input.blockers, 'blockers').map((item) => nonEmpty(item, 'blocker')); if (new Set(receipt.blockers).size !== receipt.blockers.length) throw new Error('blockers must be unique') }
  if (input.continuation !== undefined) receipt.continuation = parseContinuation(input.continuation)
  if (input.admission !== undefined) { const admission = record(input.admission, 'admission'); receipt.admission = { pending: nonNegativeInteger(admission.pending, 'admission.pending'), reconciled: nonNegativeInteger(admission.reconciled, 'admission.reconciled'), oldestAgeMs: nonNegativeInteger(admission.oldestAgeMs, 'admission.oldestAgeMs') }; rejectUnknownFields(admission, new Set(['pending', 'reconciled', 'oldestAgeMs']), 'admission') }
  if (input.health !== undefined) { const health = record(input.health, 'health'); receipt.health = { capabilities: boolean(health.capabilities, 'health.capabilities'), digest: boolean(health.digest, 'health.digest'), publicRoute: boolean(health.publicRoute, 'health.publicRoute') }; rejectUnknownFields(health, new Set(['capabilities', 'digest', 'publicRoute']), 'health') }
  if (input.rollback !== undefined) receipt.rollback = parseRollback(input.rollback)
  if (input.error !== undefined) { const error = record(input.error, 'error'); receipt.error = { code: nonEmpty(error.code, 'error.code'), message: nonEmpty(error.message, 'error.message').slice(0, 1000), at: timestamp(error.at, 'error.at') }; rejectUnknownFields(error, new Set(['code', 'message', 'at']), 'error') }
  if (input.quiescence !== undefined) receipt.quiescence = parseQuiescence(input.quiescence)
  rejectUnknownFields(input, receiptFields, 'deployment receipt')
  validateReceiptInvariants(receipt)
  return receipt
}

export async function verifyImmutableRelease(input: {
  deployRoot: string
  releaseDir: string
  releaseId: string
  releaseDigest: string
  bundleSha256: string
  allowLocalDevelopment?: boolean
}): Promise<void> {
  await verifyImmutableReleaseRuntime(input, 'kala-runtime.cjs')
}

export async function verifyImmutablePredecessorRelease(input: {
  deployRoot: string
  releaseDir: string
  releaseId: string
  releaseDigest: string
  allowLocalDevelopment?: boolean
}): Promise<string> {
  const releaseDir = resolve(input.releaseDir)
  if (releaseDir !== resolve(input.deployRoot, 'releases', input.releaseId) || basename(releaseDir) !== input.releaseId) throw new Error('release directory does not match releaseId under releases root')
  const manifest = record(JSON.parse(String(await readFile(join(releaseDir, 'manifest.json')))), 'release manifest')
  if (!Array.isArray(manifest.assets)) throw new Error('release manifest assets are required')
  const assets = manifest.assets.map((asset) => safeFileName(asset, 'manifest asset'))
  let runtimeAsset = 'kala-runtime.cjs'
  if (!assets.includes(runtimeAsset)) {
    const fallbackAssets = record(manifest.fallbackAssets, 'release manifest fallbackAssets')
    runtimeAsset = 'agent-runlab-runtime.cjs'
    if (fallbackAssets['agent-runlab-runtime'] !== runtimeAsset
      || !assets.includes(runtimeAsset)
      || !assets.includes('kala-dedicated-unit@.service')) {
      throw new Error('installed predecessor does not contain a supported Runtime asset')
    }
  }
  const bundleSha256 = sha256(await readFile(join(input.releaseDir, runtimeAsset)))
  await verifyImmutableReleaseRuntime({ ...input, bundleSha256, allowImplicitLocalDevelopment: true }, runtimeAsset)
  return bundleSha256
}

async function verifyImmutableReleaseRuntime(input: {
  deployRoot: string
  releaseDir: string
  releaseId: string
  releaseDigest: string
  bundleSha256: string
  allowLocalDevelopment?: boolean
  allowImplicitLocalDevelopment?: boolean
}, runtimeAsset: string): Promise<void> {
  const releasesRoot = resolve(input.deployRoot, 'releases')
  const releaseDir = resolve(input.releaseDir)
  if (releaseDir !== resolve(releasesRoot, input.releaseId) || basename(releaseDir) !== input.releaseId) throw new Error('release directory does not match releaseId under releases root')
  const dirStat = await lstat(releaseDir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('release directory must be a real immutable directory')
  if ((dirStat.mode & 0o222) !== 0) throw new Error('immutable release directory must not be writable')
  const manifestBytes = await readFile(join(releaseDir, 'manifest.json'))
  const sumsBytes = await readFile(join(releaseDir, 'SHA256SUMS'))
  if (sha256(sumsBytes) !== input.releaseDigest) throw new Error('immutable release digest mismatch')
  const manifest = record(JSON.parse(String(manifestBytes)), 'release manifest')
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('release manifest assets are required')
  const assets = manifest.assets.map((asset) => safeFileName(asset, 'manifest asset'))
  if (new Set(assets).size !== assets.length) throw new Error('release manifest contains duplicate assets')
  const layout = releaseLayout(manifest, assets, true, input.allowLocalDevelopment === true, input.allowImplicitLocalDevelopment === true)
  const expected = new Set(layout.files)
  const entries = await readdir(releaseDir, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) throw new Error('immutable release contains a non-file entry')
  const actual = new Set(entries.map((entry) => entry.name))
  const exact = expected.size === actual.size && [...expected].every((name) => actual.has(name))
  const expandedExpected = manifest.localDevelopment !== true && assets.includes(dedicatedSupportArchive) ? new Set([...expected, ...dedicatedSupportAssets]) : undefined
  const exactExpanded = expandedExpected !== undefined && expandedExpected.size === actual.size && [...expandedExpected].every((name) => actual.has(name))
  if (!exact && !exactExpanded) throw new Error('immutable release file set does not match manifest')
  const sums = parseSums(String(sumsBytes))
  const checksummed = new Set(layout.checksummed)
  if (sums.size !== checksummed.size || [...sums.keys()].some((name) => !checksummed.has(name))) throw new Error('immutable release checksum file set does not match manifest')
  for (const name of expected) {
    const path = join(releaseDir, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release asset must be a regular file: ${name}`)
    if ((stat.mode & 0o222) !== 0) throw new Error(`immutable release asset must not be writable: ${name}`)
    if (checksummed.has(name) && sha256(await readFile(path)) !== sums.get(name)) throw new Error(`release checksum mismatch for ${name}`)
  }
  if (exactExpanded) await verifyExpandedDedicatedSupport(releaseDir)
  if (sums.get(runtimeAsset) !== input.bundleSha256) throw new Error('bundle digest does not match release checksum manifest')
}

async function verifyExpandedDedicatedSupport(releaseDir: string): Promise<void> {
  const entries = readExactTarGz(await readFile(join(releaseDir, dedicatedSupportArchive)))
  const expected = [...dedicatedSupportAssets, dedicatedSupportManifest].sort()
  if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Dedicated support archive file set is invalid')
  let manifest: unknown
  try { manifest = JSON.parse(String(entries.get(dedicatedSupportManifest))) } catch { throw new Error('Dedicated support manifest is invalid') }
  const value = record(manifest, 'Dedicated support manifest')
  if (value.schemaVersion !== 1 || value.product !== 'kala-dedicated-support' || !Array.isArray(value.assets)) throw new Error('Dedicated support manifest is invalid')
  const manifestAssets = value.assets.map((entry) => record(entry, 'Dedicated support asset'))
  if (JSON.stringify(manifestAssets.map((entry) => entry.name)) !== JSON.stringify(dedicatedSupportAssets)) throw new Error('Dedicated support manifest asset set is invalid')
  for (const entry of manifestAssets) {
    if (typeof entry.name !== 'string' || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('Dedicated support manifest asset is invalid')
    const archived = entries.get(entry.name)
    const installed = await readFile(join(releaseDir, entry.name))
    if (!archived || archived.length !== entry.bytes || sha256(archived) !== entry.sha256 || !installed.equals(archived)) throw new Error(`expanded Dedicated support asset mismatch: ${entry.name}`)
    const stat = await lstat(join(releaseDir, entry.name))
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) throw new Error(`expanded Dedicated support asset is not immutable: ${entry.name}`)
  }
}

function readExactTarGz(compressed: Buffer): Map<string, Buffer> {
  let tar: Buffer
  try { tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }) } catch { throw new Error('Dedicated support archive is unreadable') }
  const entries = new Map<string, Buffer>(); let offset = 0; let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every((byte) => byte === 0)) { ended = true; break }
    const expectedChecksum = tarNumber(header.subarray(148, 156)); let actualChecksum = 0
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index]!
    if (actualChecksum !== expectedChecksum) throw new Error('Dedicated support archive header checksum is invalid')
    const name = tarText(header.subarray(0, 100)); const prefix = tarText(header.subarray(345, 500)); const path = prefix ? `${prefix}/${name}` : name
    if (!path || path.includes('\\') || path.startsWith('/') || path.endsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..') || ![0, 48].includes(header[156]!)) throw new Error('Dedicated support archive entry is unsafe')
    const size = tarNumber(header.subarray(124, 136))
    if (size > 512 * 1024 * 1024 || offset + size > tar.length || entries.has(path)) throw new Error('Dedicated support archive entry is invalid')
    entries.set(path, Buffer.from(tar.subarray(offset, offset + size))); offset += Math.ceil(size / 512) * 512
  }
  if (!ended || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error('Dedicated support archive terminator is invalid')
  return entries
}

function tarText(bytes: Buffer): string { const end = bytes.indexOf(0); return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end < 0 ? bytes.length : end)) }
function tarNumber(bytes: Buffer): number { if (bytes[0]! & 0x80) throw new Error('Dedicated support archive number is invalid'); const value = tarText(bytes).trim(); if (!/^[0-7]*$/u.test(value)) throw new Error('Dedicated support archive number is invalid'); const number = Number.parseInt(value || '0', 8); if (!Number.isSafeInteger(number) || number < 0) throw new Error('Dedicated support archive number is invalid'); return number }

export async function promoteStagedRelease(input: {
  deployRoot: string
  stagedReleaseDir: string
  operationId: string
  releaseId: string
  releaseDigest: string
  bundleSha256: string
  allowLocalDevelopment?: boolean
}): Promise<string> {
  const submissionsRoot = resolve(input.deployRoot, 'submissions')
  const staged = resolve(input.stagedReleaseDir)
  if (staged !== resolve(submissionsRoot, input.operationId)) throw new Error('staged release directory does not match operationId under submissions root')
  const target = resolve(input.deployRoot, 'releases', input.releaseId)
  try {
    await verifyImmutableRelease({ deployRoot: input.deployRoot, releaseDir: target, releaseId: input.releaseId, releaseDigest: input.releaseDigest, bundleSha256: input.bundleSha256, allowLocalDevelopment: input.allowLocalDevelopment })
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { await lstat(target) } catch (statError) { if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return await publishStagedRelease(input, staged, target); throw statError }
      throw new Error('immutable release destination already exists with different content')
    }
  }
  return await publishStagedRelease(input, staged, target)
}

async function publishStagedRelease(input: { deployRoot: string; releaseId: string; releaseDigest: string; bundleSha256: string; allowLocalDevelopment?: boolean }, staged: string, target: string): Promise<string> {
  const files = await verifyReleaseContents(staged, input.releaseDigest, input.bundleSha256, false, input.allowLocalDevelopment === true)
  await mkdir(resolve(input.deployRoot, 'releases'), { recursive: true, mode: 0o711 })
  const incoming = resolve(input.deployRoot, 'releases', `.incoming-${input.releaseId}-${randomBytes(12).toString('hex')}`)
  await mkdir(incoming, { mode: 0o700 })
  try {
    for (const name of files) await copyFile(join(staged, name), join(incoming, name))
    await verifyReleaseContents(incoming, input.releaseDigest, input.bundleSha256, false, input.allowLocalDevelopment === true)
    for (const name of files) {
      const path = join(incoming, name)
      const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() }
      const stat = await lstat(path)
      await chmod(path, 0o444 | (stat.mode & 0o111))
    }
    await chmod(incoming, 0o555)
    await verifyReleaseContents(incoming, input.releaseDigest, input.bundleSha256, true, input.allowLocalDevelopment === true)
    const directory = await open(incoming, 'r'); try { await directory.sync() } finally { await directory.close() }
    try { await rename(incoming, target) } catch (error) {
      await verifyImmutableRelease({ deployRoot: input.deployRoot, releaseDir: target, releaseId: input.releaseId, releaseDigest: input.releaseDigest, bundleSha256: input.bundleSha256, allowLocalDevelopment: input.allowLocalDevelopment }).catch(() => { throw error })
    }
    const parent = await open(resolve(input.deployRoot, 'releases'), 'r'); try { await parent.sync() } finally { await parent.close() }
    await verifyImmutableRelease({ deployRoot: input.deployRoot, releaseDir: target, releaseId: input.releaseId, releaseDigest: input.releaseDigest, bundleSha256: input.bundleSha256, allowLocalDevelopment: input.allowLocalDevelopment })
    return target
  } finally {
    await rm(incoming, { recursive: true, force: true })
  }
}

async function verifyReleaseContents(directory: string, releaseDigest: string, bundleSha256: string, immutable: boolean, allowLocalDevelopment: boolean): Promise<string[]> {
  const dirStat = await lstat(directory)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || immutable && (dirStat.mode & 0o222) !== 0) throw new Error('release directory is invalid')
  const manifestBytes = await readFile(join(directory, 'manifest.json'))
  const sumsBytes = await readFile(join(directory, 'SHA256SUMS'))
  if (sha256(sumsBytes) !== releaseDigest) throw new Error('release digest mismatch')
  const manifest = record(JSON.parse(String(manifestBytes)), 'release manifest')
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('release manifest assets are required')
  const assets = manifest.assets.map((asset) => safeFileName(asset, 'manifest asset'))
  if (new Set(assets).size !== assets.length) throw new Error('invalid release manifest asset set')
  const layout = releaseLayout(manifest, assets, false, allowLocalDevelopment)
  const expected = layout.files
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected)) throw new Error('release file set does not match manifest')
  const sums = parseSums(String(sumsBytes)); const checksummed = layout.checksummed
  if (sums.size !== checksummed.length || checksummed.some((name) => !sums.has(name))) throw new Error('release checksum file set does not match manifest')
  for (const name of checksummed) { const path = join(directory, name); const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || immutable && (stat.mode & 0o222) !== 0 || sha256(await readFile(path)) !== sums.get(name)) throw new Error(`invalid release asset: ${name}`) }
  if (sums.get('kala-runtime.cjs') !== bundleSha256) throw new Error('bundle digest does not match release checksum manifest')
  return expected
}

function releaseLayout(manifest: Record<string, unknown>, assets: string[], allowLegacyPredecessor: boolean, allowLocalDevelopment: boolean, allowImplicitLocalDevelopment = false): { files: string[]; checksummed: string[] } {
  const reserved = new Set(['manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS', releaseChecksumSignature])
  if (assets.some((name) => reserved.has(name))) throw new Error('invalid release manifest asset set')
  const sortedAssets = JSON.stringify([...assets].sort())
  const exactLocalDevelopmentAssets = [localDevelopmentAssets, legacyLocalDevelopmentAssets]
    .some((expected) => sortedAssets === JSON.stringify([...expected].sort()))
  if (manifest.localDevelopment === true || (allowLocalDevelopment && allowImplicitLocalDevelopment && exactLocalDevelopmentAssets)) {
    if (!allowLocalDevelopment) throw new Error('local development release is not enabled on this machine')
    if (!exactLocalDevelopmentAssets) {
      throw new Error('local development release must contain the exact current or legacy CJS asset set')
    }
    return { files: [...assets, 'manifest.json', 'SHA256SUMS'].sort(), checksummed: [...assets, 'manifest.json'].sort() }
  }
  if (manifest.localDevelopmentBridge !== undefined) {
    if (!allowLocalDevelopment) throw new Error('local development bridge is not enabled on this machine')
    const bridge = record(manifest.localDevelopmentBridge, 'local development bridge')
    if (bridge.schemaVersion !== 1 || typeof bridge.legacyReleaseDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(bridge.legacyReleaseDigest)
      || typeof bridge.localReleaseDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(bridge.localReleaseDigest)
      || assets.includes(releaseMetadataArchive) || !assets.includes('kala-runtime.cjs')
      || !assets.includes('agent-runlab-runtime.cjs') || !assets.includes('kala-dedicated-deploy-supervisor.cjs')
      || !assets.includes('kala-dedicated-deploy-supervisor.cjs') || !assets.includes(dedicatedSupportArchive)
      || record(manifest.fallbackAssets, 'bridge fallbackAssets')['agent-runlab-runtime'] !== 'agent-runlab-runtime.cjs') throw new Error('invalid local development bridge')
    return {
      files: [...assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS'].sort(),
      checksummed: [...assets, 'manifest.json', 'RELEASE_NOTES.md'].sort(),
    }
  }
  if (assets.includes(releaseMetadataArchive)) {
    const files = [...assets, 'manifest.json', 'SHA256SUMS', releaseChecksumSignature].sort()
    if (files.length !== modernReleaseFileCount && !(allowLegacyPredecessor && files.length === 33)) {
      throw new Error(`modern release must contain exactly ${modernReleaseFileCount} files`)
    }
    return { files, checksummed: [...assets, 'manifest.json'].sort() }
  }
  if (!allowLegacyPredecessor) throw new Error(`modern release manifest is missing ${releaseMetadataArchive}`)
  return {
    files: [...assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS'].sort(),
    checksummed: [...assets, 'manifest.json', 'RELEASE_NOTES.md'].sort(),
  }
}

export function redactedDeploymentError(error: unknown, code = 'deployment_failed'): RedactedDeploymentError {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>')
    .replaceAll(/(?:token|secret|password|credential|key)=[^\s;]+/giu, '$1=<redacted>')
    .slice(0, 1000)
  return { code, message, at: new Date().toISOString() }
}

function parseSums(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of text.trim().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u)
    if (!match) throw new Error('invalid SHA256SUMS entry')
    if (result.has(match[2]!)) throw new Error('duplicate SHA256SUMS entry')
    result.set(match[2]!, match[1]!)
  }
  return result
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function record(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown> }
function nonEmpty(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim() }
function pattern(value: unknown, expected: RegExp, name: string): string { const text = nonEmpty(value, name); if (!expected.test(text)) throw new Error(`invalid ${name}`); return text }
function identifier(value: unknown, name: string): string { return pattern(value, idPattern, name) }
function timestamp(value: unknown, name: string): string { const text = nonEmpty(value, name); if (!Number.isFinite(Date.parse(text))) throw new Error(`invalid ${name}`); return new Date(text).toISOString() }
function positiveInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`); return Number(value) }
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] { if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`invalid ${name}`); return value as T[number] }
function safeFileName(value: unknown, name: string): string { const text = nonEmpty(value, name); if (basename(text) !== text || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(text)) throw new Error(`invalid ${name}`); return text }
function absolutePath(value: unknown, name: string): string { const text = nonEmpty(value, name); if (!text.startsWith('/') || resolve(text) !== text) throw new Error(`${name} must be an absolute normalized path`); return text }
function nonNegativeInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`); return Number(value) }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be a string array`); return value as string[] }
function optionalInteger<K extends 'observedRouteGeneration' | 'routeGeneration' | 'activatedPid'>(input: Record<string, unknown>, output: DeploymentReceipt, key: K, minimum: number): void { if (input[key] === undefined) return; const value = Number(input[key]); if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${key}`); output[key] = value }
function optionalString<K extends 'previousRelease' | 'previousSlot' | 'originResultPersistedAt' | 'targetDeploymentId' | 'processReadyAt' | 'runtimeReadyAt'>(input: Record<string, unknown>, output: DeploymentReceipt, key: K, parse: (value: unknown) => DeploymentReceipt[K]): void { if (input[key] !== undefined) output[key] = parse(input[key]) }
function boolean(value: unknown, name: string): boolean { if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`); return value }
function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void { for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown ${name} field: ${key}`) }
function validateReceiptInvariants(receipt: DeploymentReceipt): void {
  if (receipt.action === 'rollback' && !receipt.targetDeploymentId) throw new Error('rollback receipt requires targetDeploymentId')
  if (receipt.action !== 'rollback' && receipt.targetDeploymentId) throw new Error('targetDeploymentId is valid only for rollback receipts')
  if (receipt.action === 'restart' && receipt.releaseDigest !== receipt.sourceReleaseDigest) throw new Error('restart receipt must preserve the immutable release')
  if (receipt.originResultPersistedAt && !receipt.origin) throw new Error('origin result timestamp requires origin identity')
  if (receipt.previousSlot && receipt.previousSlot === receipt.candidateSlot) throw new Error('previousSlot and candidateSlot must differ')
  if (receipt.observedRouteGeneration !== undefined && receipt.observedRouteGeneration < receipt.expectedRouteGeneration) throw new Error('observed route generation regressed')
  if (receipt.routeGeneration !== undefined && receipt.routeGeneration < receipt.expectedRouteGeneration) throw new Error('route generation regressed')
  if (receipt.health?.publicRoute && (!receipt.health.capabilities || !receipt.health.digest || receipt.routeGeneration === undefined)) throw new Error('public route health requires verified capabilities, digest, and route generation')
  if (receipt.rollback?.outcome === 'completed' && !receipt.rollback.pid) throw new Error('completed rollback requires predecessor pid')
  if (receipt.phase === 'rollback_failed' && receipt.rollback?.outcome !== 'failed') throw new Error('rollback_failed receipt requires failed rollback outcome')
  if (receipt.phase === 'rolled_back' && receipt.rollback?.outcome !== 'completed') throw new Error('rolled_back receipt requires completed rollback outcome')
  if (receipt.phase === 'completed' && (!receipt.activatedPid || !receipt.processReadyAt || !receipt.runtimeReadyAt || !receipt.routeGeneration || receipt.health?.publicRoute !== true)) throw new Error('completed receipt lacks committed runtime readiness')
  if (receipt.action !== 'restart' && ['control_ready', 'waiting_for_boundary', 'reserved', 'handed_off', 'activating', 'verifying', 'route_committing', 'completed'].includes(receipt.phase) && !receipt.controlPlane) throw new Error('post-control phase lacks activation evidence')
  if (receipt.controlPlane?.readyAt && !receipt.controlPlane.supervisorPid) throw new Error('control-plane readiness requires Supervisor pid')
}
function parseContinuation(value: unknown): NonNullable<DeploymentReceipt['continuation']> {
  const input = record(value, 'continuation')
  const sessions = input.sessions === undefined ? undefined : (Array.isArray(input.sessions) ? input.sessions.map((value) => {
    const session = record(value, 'continuation session')
    const parsed: ContinuationSession = {
      sessionId: identifier(session.sessionId, 'continuation.sessionId'),
      cursor: nonNegativeInteger(session.cursor, 'continuation.cursor'),
      ...(session.checkpointKind === undefined ? {} : { checkpointKind: oneOf(session.checkpointKind, checkpointKinds, 'continuation.checkpointKind') }),
      resumeAction: oneOf(session.resumeAction, resumeActions, 'continuation.resumeAction'),
      outcome: oneOf(session.outcome, continuationOutcomes, 'continuation.outcome'),
    }
    rejectUnknownFields(session, continuationSessionFields, 'continuation session')
    return parsed
  }) : (() => { throw new Error('continuation.sessions must be an array') })())
  const result: NonNullable<DeploymentReceipt['continuation']> = {
    ...(input.attemptId === undefined ? {} : { attemptId: identifier(input.attemptId, 'continuation.attemptId') }),
    participants: nonNegativeInteger(input.participants, 'continuation.participants'),
    completed: nonNegativeInteger(input.completed, 'continuation.completed'),
    failed: nonNegativeInteger(input.failed, 'continuation.failed'),
    ...(sessions ? { sessions } : {}),
  }
  rejectUnknownFields(input, continuationFields, 'continuation')
  if (result.completed + result.failed > result.participants || sessions && sessions.length !== result.participants) throw new Error('invalid continuation counts')
  if (sessions && (sessions.filter((item: ContinuationSession) => item.outcome === 'adopted' || item.outcome === 'settled' || item.outcome === 'completed').length !== result.completed || sessions.filter((item: ContinuationSession) => item.outcome === 'failed').length !== result.failed)) throw new Error('continuation summary does not match session outcomes')
  return result
}
function parseRollback(value: unknown): NonNullable<DeploymentReceipt['rollback']> {
  const input = record(value, 'rollback')
  const result: NonNullable<DeploymentReceipt['rollback']> = { predecessorReleaseId: pattern(input.predecessorReleaseId, releasePattern, 'rollback.predecessorReleaseId'), outcome: oneOf(input.outcome, ['pending', 'completed', 'failed'] as const, 'rollback.outcome') }
  if (input.pid !== undefined) result.pid = positiveInteger(input.pid, 'rollback.pid')
  if (input.mode !== undefined) result.mode = oneOf(input.mode, ['cancel', 'replace'] as const, 'rollback.mode')
  if (input.stage !== undefined) result.stage = oneOf(input.stage, ['preparing', 'waiting_for_boundary', 'handed_off', 'verifying_live', 'activating_predecessor', 'activating', 'verifying', 'reconciling_admission', 'route_committing'] as const, 'rollback.stage')
  if (input.deployment !== undefined) {
    const deployment = record(input.deployment, 'rollback.deployment')
    result.deployment = { deploymentId: identifier(deployment.deploymentId, 'rollback.deployment.deploymentId'), targetReleaseDigest: pattern(deployment.targetReleaseDigest, digestPattern, 'rollback.deployment.targetReleaseDigest'), expectedRouteGeneration: positiveInteger(deployment.expectedRouteGeneration, 'rollback.deployment.expectedRouteGeneration'), fencingToken: pattern(deployment.fencingToken, tokenPattern, 'rollback.deployment.fencingToken') }
    rejectUnknownFields(deployment, deploymentFenceFields, 'rollback deployment fence')
  }
  rejectUnknownFields(input, rollbackFields, 'rollback')
  return result
}
function parseQuiescence(value: unknown): UnitQuiescence {
  const input = record(value, 'quiescence')
  if (typeof input.safe !== 'boolean' || typeof input.queueStable !== 'boolean') throw new Error('invalid quiescence flags')
  if (!Array.isArray(input.unsafeSessions)) throw new Error('invalid quiescence sessions')
  const unsafeSessions = input.unsafeSessions.map((value) => {
    const session = record(value, 'quiescence session')
    const parsed: UnitQuiescence['unsafeSessions'][number] = {
      sessionId: identifier(session.sessionId, 'quiescence.sessionId'),
      status: oneOf(session.status, agentStatuses, 'quiescence.status'),
      safe: boolean(session.safe, 'quiescence.safe'),
      waiting: oneOf(session.waiting, waitingKinds, 'quiescence.waiting'),
      ...(session.checkpointKind === undefined ? {} : { checkpointKind: oneOf(session.checkpointKind, checkpointKinds, 'quiescence.checkpointKind') }),
      ...(session.cursor === undefined ? {} : { cursor: nonNegativeInteger(session.cursor, 'quiescence.cursor') }),
    }
    rejectUnknownFields(session, quiescenceSessionFields, 'quiescence session')
    return parsed
  })
  const result = { safe: input.safe, queueStable: input.queueStable, activeLlmCalls: nonNegativeInteger(input.activeLlmCalls, 'quiescence.activeLlmCalls'), activeToolCalls: nonNegativeInteger(input.activeToolCalls, 'quiescence.activeToolCalls'), activeCompactions: nonNegativeInteger(input.activeCompactions, 'quiescence.activeCompactions'), unsafeSessions, observedAt: timestamp(input.observedAt, 'quiescence.observedAt') }
  rejectUnknownFields(input, quiescenceFields, 'quiescence')
  if (new Set(result.unsafeSessions.map((session) => session.sessionId)).size !== result.unsafeSessions.length || result.unsafeSessions.some((session) => session.safe)) throw new Error('invalid unsafe quiescence Session set')
  if (result.activeLlmCalls !== result.unsafeSessions.filter((session) => session.waiting === 'llm').length || result.activeToolCalls !== result.unsafeSessions.filter((session) => session.waiting === 'tool').length || result.activeCompactions !== result.unsafeSessions.filter((session) => session.waiting === 'compaction').length) throw new Error('quiescence active counters do not match Session blockers')
  if (result.safe !== (result.queueStable && result.unsafeSessions.length === 0)) throw new Error('quiescence safe flag does not match blockers')
  return result
}
