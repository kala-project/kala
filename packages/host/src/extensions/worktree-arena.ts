import { createHash } from 'node:crypto'
import type { CallToolEffect } from '@agent-kernel/kernel'
import { ulid } from 'ulid'
import type { HostLoopDeps } from '../loop-types.js'

export type ToolDispatchResult = {
  ok: boolean
  content: string
}

export const WORKTREE_ARENA_METADATA_ACTION = 'worktree_arena.state'

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/
const MAX_CANDIDATES = 6
const DEFAULT_MAX_DIFF_CHARS = 16_000
const MAX_DIFF_CHARS = 64_000

function arenaRequestDigest(sessionId: string, effect: CallToolEffect): string {
  const canonical = JSON.stringify([sessionId, effect.callId, effect.name, effect.input, effect.cwd ?? null, 'host'],
    (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)
  return createHash('sha256').update(canonical).digest('hex')
}

async function recoverReadOnlyArenaReceipt(
  deps: HostLoopDeps, sessionId: string, generation: string, workspaceId: string, effect: CallToolEffect,
  complete: () => Promise<void>,
  failure?: import('@agent-kernel/kernel').ToolFailure,
): Promise<{ ok: boolean; content: string; failure?: import('@agent-kernel/kernel').ToolFailure }> {
  if (failure?.code === 'arena_pre_dispatch_rejected' && deps.releaseNeverDispatchedArenaEffect) {
    await deps.releaseNeverDispatchedArenaEffect(sessionId, generation, effect.callId, workspaceId)
    throw new Error(`Arena call ${effect.callId} was rejected before durable dispatch intent; audited PG never-admitted proof released its barrier`)
  }
  const inspected = await deps.tools.inspectArenaReceipt?.(sessionId, effect.callId).catch(() => undefined)
  if (inspected?.ownerGeneration === generation && inspected.requestDigest === arenaRequestDigest(sessionId, effect)
    && inspected.result?.callId === effect.callId) {
    if (inspected.state === 'denied' && !inspected.result.ok
      && inspected.result.failure?.code === 'arena_not_admitted') {
      await complete()
      throw new Error(`Arena call ${effect.callId} was durably rejected before admission; effect barrier released`)
    }
    if (inspected.state === 'completed' && inspected.result.ok && !inspected.result.failure) {
      return inspected.result
    }
  }
  throw new Error(`Arena call ${effect.callId} has an unresolved final effect: no matching durable receipt; effect remains UNKNOWN`)
}

export type ArenaCandidateSpec = {
  id: string
  label?: string
  description?: string
}

export type ArenaCandidateRecord = {
  id: string
  label: string
  description?: string
  branch: string
  worktreePath: string
  status: 'pending' | 'active' | 'applied' | 'cleaned'
}

export type WorktreeArenaState = {
  arenaId: string
  repoRoot: string
  baseRef: string
  baseSha: string
  repositoryIdentity?: string
  createdAt: string
  updatedAt: string
  status: 'initializing' | 'active' | 'applying' | 'applied' | 'cleaned'
  selectedWinner?: string
  candidates: ArenaCandidateRecord[]
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type ExecResult = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

type OwnerFence = { ownerGeneration?: string; parentCallId?: string }

async function assertOwner(deps: HostLoopDeps, sessionId: string, fence: OwnerFence): Promise<void> {
  const owner = await deps.assertSessionEffectOwner?.(sessionId)
  if (fence.ownerGeneration !== undefined && owner?.ownerGeneration !== fence.ownerGeneration) {
    throw new Error('worktree arena owner generation changed during operation')
  }
}

async function execWorkspaceCommand(
  deps: HostLoopDeps,
  sessionId: string,
  command: string,
  fence: OwnerFence,
): Promise<ExecResult> {
  await assertOwner(deps, sessionId, fence)
  const effect: CallToolEffect = {
    kind: 'call_tool',
    callId: `arena-${ulid()}`,
    name: 'bash',
    input: {
      command,
      shell: 'bash',
      capture_separate_streams: true,
    },
  }
  if (!fence.parentCallId || !deps.tools.callArenaShell) {
    throw new Error('Arena Bash requires a verified, explicitly approved parent call')
  }
  const outcome = await deps.tools.callArenaShell(sessionId, fence.parentCallId, effect)
  await assertOwner(deps, sessionId, fence)
  if (!outcome.ok) {
    return {
      ok: false,
      stdout: '',
      stderr: outcome.content,
      exitCode: -1,
    }
  }
  const raw = outcome.content.trim()
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as {
        stdout?: string
        stderr?: string
        exitCode?: number | null
        stdoutTruncated?: boolean
        stderrTruncated?: boolean
        timedOut?: boolean
        aborted?: boolean
      }
      if (typeof parsed.stdout === 'string' || typeof parsed.stderr === 'string') {
        const exitCode = typeof parsed.exitCode === 'number' ? parsed.exitCode : -1
        return {
          ok: exitCode === 0 && !parsed.stdoutTruncated && !parsed.stderrTruncated && !parsed.timedOut && !parsed.aborted,
          stdout: parsed.stdout ?? '',
          stderr: parsed.stdoutTruncated || parsed.stderrTruncated ? 'Executor output truncated; operation outcome must be inspected' : parsed.stderr ?? '',
          exitCode,
        }
      }
    } catch {
      // Fall through to standard trailer parsing.
    }
  }

  const trailerMatch = /\n?--- exit code:\s*(-?\d+|signal:[A-Z0-9]+),\s*duration:\s*\d+ms[\s\S]*$/.exec(outcome.content)
  if (trailerMatch) {
    const codeStr = trailerMatch[1]!
    const exitCode = /^-?\d+$/.test(codeStr) ? Number.parseInt(codeStr, 10) : -1
    const stdout = outcome.content.slice(0, trailerMatch.index)
    return {
      ok: exitCode === 0,
      stdout,
      stderr: exitCode === 0 ? '' : stdout,
      exitCode,
    }
  }

  return { ok: false, stdout: '', stderr: 'Unrecognized Executor response; operation outcome is unknown', exitCode: -1 }
}

async function loadArenaState(
  deps: HostLoopDeps,
  sessionId: string,
): Promise<WorktreeArenaState | undefined> {
  const entry = await deps.store.findLatestRuntimeMetadata(sessionId, WORKTREE_ARENA_METADATA_ACTION)
  const state = entry?.payload?.arena as WorktreeArenaState | undefined
  if (!state || typeof state.arenaId !== 'string' || !Array.isArray(state.candidates)) {
    return undefined
  }
  return state
}

async function saveArenaState(
  deps: HostLoopDeps,
  sessionId: string,
  state: WorktreeArenaState,
  fence: OwnerFence,
): Promise<void> {
  await assertOwner(deps, sessionId, fence)
  await deps.store.appendRuntimeMetadata(
    sessionId,
    {
      action: WORKTREE_ARENA_METADATA_ACTION,
      payload: { arena: state },
    },
    { durable: true },
  )
  await assertOwner(deps, sessionId, fence)
}

function worktreeGuard(state: WorktreeArenaState, candidate: ArenaCandidateRecord): string {
  const arenaDir = `${state.repoRoot}/.kala-arena/${state.arenaId}`
  if (!SAFE_ID_RE.test(state.arenaId) || !SAFE_ID_RE.test(candidate.id) ||
    candidate.worktreePath !== `${arenaDir}/${candidate.id}` ||
    candidate.branch !== `kala-arena/${state.arenaId}/${candidate.id}`) {
    throw new Error('Invalid arena metadata: refusing to access an unverified path or branch')
  }
  return [
    `cd ${shellQuote(state.repoRoot)}`,
    `test ! -L .kala-arena && test ! -L ${shellQuote(arenaDir)} && test ! -L ${shellQuote(candidate.worktreePath)}`,
    `test "$(git -C ${shellQuote(candidate.worktreePath)} rev-parse --show-toplevel)" = ${shellQuote(candidate.worktreePath)}`,
    `test "$(git -C ${shellQuote(candidate.worktreePath)} rev-parse --path-format=absolute --git-common-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)"`,
    `test "$(git -C ${shellQuote(candidate.worktreePath)} branch --show-current)" = ${shellQuote(candidate.branch)}`,
  ].join(' && ')
}

function parseCandidateSpecs(raw: unknown): ArenaCandidateSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('candidates must be a non-empty array of 1..6 candidate specs')
  }
  if (raw.length > MAX_CANDIDATES) {
    throw new Error(`candidates cannot exceed ${MAX_CANDIDATES} items`)
  }
  const seen = new Set<string>()
  const specs: ArenaCandidateSpec[] = []
  for (const item of raw) {
    let id: string
    let label: string | undefined
    let description: string | undefined
    if (typeof item === 'string') {
      id = item.trim()
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      id = typeof obj.id === 'string' ? obj.id.trim() : ''
      label = typeof obj.label === 'string' ? obj.label.trim() : undefined
      description = typeof obj.description === 'string' ? obj.description.trim() : undefined
    } else {
      throw new Error('each candidate must be a string ID or { id, label?, description? }')
    }
    if (!SAFE_ID_RE.test(id)) {
      throw new Error(`invalid candidate id "${id}": must match ^[a-zA-Z0-9_-]{1,48}$`)
    }
    if (seen.has(id)) {
      throw new Error(`duplicate candidate id "${id}"`)
    }
    seen.add(id)
    specs.push({ id, label: label || id, ...(description ? { description } : {}) })
  }
  return specs
}

export async function runWorktreeArenaTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
): Promise<ToolDispatchResult> {
  const input = effect.input ?? {}
  const action = typeof input.action === 'string' ? input.action.trim() : ''
  if (!['init', 'status', 'diff', 'apply', 'cleanup'].includes(action)) {
    return {
      ok: false,
      content: `Invalid worktree_arena action "${action}". Expected one of: init, status, diff, apply, cleanup.`,
    }
  }

  try {
    const owner = await deps.assertSessionEffectOwner?.(sessionId)
    const fence: OwnerFence = { ownerGeneration: owner?.ownerGeneration }
    if (deps.requireArenaEffectBarrier) {
      if (!owner?.ownerGeneration || !deps.registerArenaEffect) {
        throw new Error('Arena action requires a PostgreSQL owner and active effect barrier. No command was dispatched.')
      }
      const parent = deps.store.get(sessionId)?.state.pendingCalls.find((call) =>
        call.callId === effect.callId && call.name === 'worktree_arena'
        && call.status === 'dispatched' && JSON.stringify(call.input) === JSON.stringify(effect.input))
      if (!parent) throw new Error('Arena action requires an approved parent tool call. No command was dispatched.')
      const pgFence = { ownerGeneration: owner.ownerGeneration }
      if (!deps.claimArenaRepository) throw new Error('Arena canonical repository claim authority is unavailable')
      if (action === 'init' && !deps.prepareArenaInitEffect) {
        throw new Error('Arena init requires atomic PostgreSQL claim and effect preparation')
      }
      const current = await loadArenaState(deps, sessionId)
      if (action !== 'init' && (!current?.repositoryIdentity || !current.repoRoot)) {
        throw new Error('Arena state lacks a canonical repository claim; migration requires manual reconciliation')
      }
      const probe = await probePostgresArenaRepository(deps, sessionId, pgFence, effect.callId, action,
        action === 'init' ? undefined : current!.repoRoot)
      if (action !== 'init' && (probe.repoRoot !== current!.repoRoot
        || probe.repositoryIdentity !== current!.repositoryIdentity)) {
        throw new Error('Arena canonical repository identity changed; no action was dispatched')
      }
      if (action !== 'init' && current!.status === 'cleaned') {
        return { ok: false, content: 'Arena already cleaned; initialize a new Arena first.' }
      }
      const arenaId = action === 'init'
        ? typeof input.arena_id === 'string' ? input.arena_id : undefined
        : current!.arenaId
      // Init generates a stable ID before claiming; no second ID may be
      // allocated after the claim or the durable intent would be orphaned.
      if (action !== 'init') await deps.claimArenaRepository(sessionId, pgFence.ownerGeneration,
        probe.repositoryIdentity, arenaId!)
      if (action === 'status' || action === 'diff') {
        return await handlePostgresArenaRead(deps, sessionId, pgFence, effect.callId, action, input,
          probe.repositoryIdentity)
      }
      return await handlePostgresArenaMutation(deps, sessionId, pgFence, effect.callId,
        action as 'init' | 'apply' | 'cleanup', input, probe)
    }
    const parent = deps.store.get(sessionId)?.state.pendingCalls.find((call) =>
      call.callId === effect.callId && call.name === 'worktree_arena'
      && call.status === 'dispatched' && call.explicitlyApproved === true
      && JSON.stringify(call.input) === JSON.stringify(effect.input))
    if (!parent || !deps.tools.callArenaShell) {
      throw new Error('Portable Arena Bash requires an explicitly approved parent and Host authorization channel')
    }
    fence.parentCallId = effect.callId
    if (action === 'init') {
      return await handleArenaInit(deps, sessionId, input, fence)
    }
    if (action === 'status') {
      return await handleArenaStatus(deps, sessionId, fence)
    }
    if (action === 'diff') {
      return await handleArenaDiff(deps, sessionId, input, fence)
    }
    if (action === 'apply') {
      return await handleArenaApply(deps, sessionId, input, fence)
    }
    return await handleArenaCleanup(deps, sessionId, input, fence)
  } catch (err) {
    return {
      ok: false,
      content: `worktree_arena(${action}) failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function probePostgresArenaRepository(
  deps: HostLoopDeps,
  sessionId: string,
  fence: OwnerFence & { ownerGeneration: string },
  parentCallId: string,
  parentAction: string,
  cwd?: string,
): Promise<{ repoRoot: string; repositoryIdentity: string }> {
  const workspaceId = deps.store.get(sessionId)?.workspaceId
  if (!workspaceId) throw new Error('Arena probe needs an Executor workspace')
  const callId = `arena-probe-${ulid()}`
  const complete = await deps.registerArenaEffect!(sessionId, fence.ownerGeneration, callId, workspaceId)
  const effect: CallToolEffect = {
    kind: 'call_tool', callId, name: 'arena_git_probe',
    input: { parentCallId, parentAction, ownerGeneration: fence.ownerGeneration },
    ...(cwd ? { cwd } : {}),
  }
  let result = await deps.tools.callTool(sessionId, effect)
  if (!result.ok || result.failure) {
    result = await recoverReadOnlyArenaReceipt(deps, sessionId, fence.ownerGeneration, workspaceId, effect, complete, result.failure)
  }
  let receipt: Record<string, unknown>
  try { receipt = JSON.parse(result.content) } catch {
    throw new Error(`Arena repository probe receipt invalid (${callId}); effect remains registered`)
  }
  if (receipt.finalEffectStopped !== true || typeof receipt.repoRoot !== 'string'
    || !receipt.repoRoot.startsWith('/') || typeof receipt.repositoryIdentity !== 'string'
    || !/^git-common-inode:\d+:\d+$/.test(receipt.repositoryIdentity)) {
    throw new Error(`Arena repository probe identity invalid (${callId}); effect remains registered`)
  }
  await complete()
  return { repoRoot: receipt.repoRoot, repositoryIdentity: receipt.repositoryIdentity }
}

async function handlePostgresArenaRead(
  deps: HostLoopDeps,
  sessionId: string,
  fence: OwnerFence & { ownerGeneration: string },
  parentCallId: string,
  action: 'status' | 'diff',
  input: Record<string, unknown>,
  repositoryIdentity: string,
): Promise<ToolDispatchResult> {
  const state = await loadArenaState(deps, sessionId)
  if (!state) return { ok: false, content: 'No worktree arena has been initialized for this session.' }
  const selected = action === 'status' ? state.candidates : input.candidate_id
    ? state.candidates.filter((candidate) => candidate.id === input.candidate_id)
    : state.candidates.filter((candidate) => candidate.status === 'active' || candidate.status === 'applied')
  if (action === 'diff' && (!selected.length
    || selected.some((candidate) => candidate.status !== 'active' && candidate.status !== 'applied'))) {
    return { ok: false, content: 'Arena diff requires an active candidate worktree.' }
  }
  const statOnly = input.stat_only === true
  const maxChars = typeof input.max_chars === 'number' && Number.isInteger(input.max_chars) && input.max_chars >= 500
    ? Math.min(input.max_chars, MAX_DIFF_CHARS) : DEFAULT_MAX_DIFF_CHARS
  const callId = `arena-${action}-${ulid()}`
  const workspaceId = deps.store.get(sessionId)?.workspaceId
  if (!workspaceId) throw new Error('Arena read requires an Executor workspace identity')
  const complete = await deps.registerArenaEffect!(sessionId, fence.ownerGeneration, callId, workspaceId,
    repositoryIdentity, state.arenaId)
  const effect: CallToolEffect = {
    kind: 'call_tool', callId, name: action === 'status' ? 'arena_git_status' : 'arena_git_diff',
    input: {
      parentCallId,
      ownerGeneration: fence.ownerGeneration,
      repoRoot: state.repoRoot, arenaId: state.arenaId, baseSha: state.baseSha,
      repositoryIdentity,
      candidates: selected.map(({ id, branch, worktreePath, status, label }) => ({
        id, branch, worktreePath, status, label,
      })),
      ...(action === 'diff' ? { statOnly, maxChars } : {}),
    },
  }
  let result = await deps.tools.callTool(sessionId, effect)
  if (!result.ok || result.failure) {
    result = await recoverReadOnlyArenaReceipt(deps, sessionId, fence.ownerGeneration, workspaceId, effect, complete, result.failure)
  }
  let final: { finalEffectStopped?: boolean; candidates?: Array<Record<string, unknown>>; error?: string }
  try { final = JSON.parse(result.content) } catch {
    throw new Error(`Arena ${action} has an unrecognized final receipt (${callId}); effect remains blocked`)
  }
  if (final?.finalEffectStopped !== true || !((typeof final.error === 'string' && final.error.length > 0)
    || (Array.isArray(final.candidates) && final.candidates.length === selected.length
      && final.candidates.every((candidate, index) => candidate.id === selected[index]?.id)))) {
    throw new Error(`Arena ${action} has an invalid final receipt (${callId}); effect remains blocked`)
  }
  await complete()
  await assertOwner(deps, sessionId, fence)
  if (final.error) return { ok: false, content: final.error }
  return {
    ok: true,
    content: JSON.stringify(action === 'status' ? {
      arenaId: state.arenaId, repoRoot: state.repoRoot, baseSha: state.baseSha,
      status: state.status, selectedWinner: state.selectedWinner ?? null,
      candidates: final.candidates,
    } : { arenaId: state.arenaId, baseSha: state.baseSha, candidates: final.candidates }),
  }
}

async function dispatchPostgresArenaMutation(
  deps: HostLoopDeps,
  sessionId: string,
  fence: OwnerFence & { ownerGeneration: string },
  parentCallId: string,
  action: 'init' | 'apply' | 'cleanup',
  input: Record<string, unknown>,
  repositoryIdentity: string,
  arenaId: string,
  validate: (receipt: Record<string, unknown>) => boolean,
  prepared?: { callId: string; complete: () => Promise<void> },
): Promise<{ receipt: Record<string, unknown>; complete: (releaseArenaId?: string) => Promise<void> }> {
  const workspaceId = deps.store.get(sessionId)?.workspaceId
  if (!workspaceId) throw new Error('Arena mutation requires an Executor workspace identity')
  const callId = prepared?.callId ?? `arena-${action}-${ulid()}`
  const complete = prepared?.complete ?? await deps.registerArenaEffect!(sessionId, fence.ownerGeneration, callId,
    workspaceId, repositoryIdentity, arenaId)
  const result = await deps.tools.callTool(sessionId, {
    kind: 'call_tool', callId, name: `arena_git_${action}`,
    input: { ...input, parentCallId, ownerGeneration: fence.ownerGeneration, repositoryIdentity },
  })
  if (!result.ok || result.failure) {
    throw new Error(`Arena ${action} outcome is unresolved (${callId}); effect remains registered for reconciliation`)
  }
  let receipt: Record<string, unknown>
  try { receipt = JSON.parse(result.content) } catch {
    throw new Error(`Arena ${action} receipt is not valid JSON (${callId}); effect remains registered`)
  }
  if (receipt.finalEffectStopped !== true || !validate(receipt)) {
    throw new Error(`Arena ${action} receipt does not prove its final effect (${callId}); effect remains registered`)
  }
  return { receipt, complete }
}

async function handlePostgresArenaMutation(
  deps: HostLoopDeps,
  sessionId: string,
  fence: OwnerFence & { ownerGeneration: string },
  parentCallId: string,
  action: 'init' | 'apply' | 'cleanup',
  input: Record<string, unknown>,
  probe: { repoRoot: string; repositoryIdentity: string },
): Promise<ToolDispatchResult> {
  const state = await loadArenaState(deps, sessionId)
  if (action === 'init') {
    const specs = parseCandidateSpecs(input.candidates)
    const arenaId = typeof input.arena_id === 'string' ? input.arena_id : ulid().slice(-8).toLowerCase()
    if (!SAFE_ID_RE.test(arenaId)) return { ok: false, content: 'Invalid arena_id' }
    if (state && state.status !== 'cleaned') return { ok: false, content: `Arena "${state.arenaId}" needs explicit cleanup before initialization.` }
    const baseRef = typeof input.base_ref === 'string' ? input.base_ref : 'HEAD'
    if (!baseRef || baseRef.length > 200) return { ok: false, content: 'Invalid base_ref' }
    const now = new Date().toISOString()
    const intent: WorktreeArenaState = {
      arenaId, repoRoot: '', baseRef, baseSha: '', createdAt: now, updatedAt: now,
      status: 'initializing', candidates: specs.map((spec) => ({
        id: spec.id, label: spec.label ?? spec.id, ...(spec.description ? { description: spec.description } : {}),
        branch: `kala-arena/${arenaId}/${spec.id}`, worktreePath: '', status: 'pending',
      })),
    }
    const workspaceId = deps.store.get(sessionId)?.workspaceId
    if (!workspaceId) throw new Error('Arena init requires an Executor workspace identity')
    const initCallId = `arena-init-${ulid()}`
    const completeInit = await deps.prepareArenaInitEffect!(sessionId, fence.ownerGeneration, initCallId,
      workspaceId, probe.repositoryIdentity, arenaId)
    await saveArenaState(deps, sessionId, intent, fence)
    const { receipt, complete } = await dispatchPostgresArenaMutation(deps, sessionId, fence, parentCallId, 'init', {
      arenaId, baseRef, candidates: specs.map((spec) => spec.id),
    }, probe.repositoryIdentity, arenaId, (value) => value.arenaId === arenaId && value.repoRoot === probe.repoRoot
      && typeof value.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(value.baseSha)
      && Array.isArray(value.candidates) && value.candidates.length === specs.length
      && value.candidates.every((candidate, i) => candidate && typeof candidate === 'object'
        && (candidate as Record<string, unknown>).id === specs[i]?.id
        && (candidate as Record<string, unknown>).branch === `kala-arena/${arenaId}/${specs[i]?.id}`
        && (candidate as Record<string, unknown>).worktreePath
          === `${value.repoRoot}/.kala-arena/${arenaId}/${specs[i]?.id}`),
    { callId: initCallId, complete: completeInit })
    const root = receipt.repoRoot as string
    const next: WorktreeArenaState = {
      ...intent, repoRoot: root, repositoryIdentity: probe.repositoryIdentity, baseSha: receipt.baseSha as string,
      updatedAt: new Date().toISOString(), status: 'active',
      candidates: intent.candidates.map((candidate) => ({
        ...candidate, worktreePath: `${root}/.kala-arena/${arenaId}/${candidate.id}`, status: 'active',
      })),
    }
    await saveArenaState(deps, sessionId, next, fence)
    await complete()
    return { ok: true, content: JSON.stringify({
      arenaId, repoRoot: root, baseRef, baseSha: next.baseSha, status: next.status,
      candidates: next.candidates.map((candidate) => ({
        ...candidate,
        delegationHint: `Instruct sub-agent for "${candidate.id}" to read/edit files exclusively under ${candidate.worktreePath} and run shell commands with cwd="${candidate.worktreePath}".`,
      })),
    }) }
  }
  if (!state || state.status === 'initializing' || state.status === 'applying') {
    return { ok: false, content: 'Arena state is absent or has an unresolved mutation; reconciliation is required.' }
  }
  if (action === 'apply') {
    const candidate = state.candidates.find((item) => item.id === input.candidate_id)
    if (!candidate || candidate.status !== 'active' || state.status !== 'active') {
      return { ok: false, content: 'Arena apply requires an active candidate.' }
    }
    if (input.cleanup_after === true) return { ok: false, content: 'Apply and cleanup must be separately authorized Arena calls.' }
    if (input.strategy !== undefined && input.strategy !== 'patch' && input.strategy !== 'merge') {
      return { ok: false, content: 'strategy must be "patch" or "merge"' }
    }
    const strategy = input.strategy === 'patch' ? 'patch' : 'merge'
    await saveArenaState(deps, sessionId, { ...state, status: 'applying', updatedAt: new Date().toISOString() }, fence)
    const { complete } = await dispatchPostgresArenaMutation(deps, sessionId, fence, parentCallId, action, {
      repoRoot: state.repoRoot, arenaId: state.arenaId, baseSha: state.baseSha, candidate, strategy,
    }, probe.repositoryIdentity, state.arenaId,
    (receipt) => receipt.candidateId === candidate.id && receipt.strategy === strategy)
    const next: WorktreeArenaState = {
      ...state, status: 'applied', selectedWinner: candidate.id, updatedAt: new Date().toISOString(),
      candidates: state.candidates.map((item) => item.id === candidate.id ? { ...item, status: 'applied' } : item),
    }
    await saveArenaState(deps, sessionId, next, fence)
    await complete()
    return { ok: true, content: JSON.stringify({
      arenaId: state.arenaId, appliedCandidate: candidate.id, branch: candidate.branch,
      strategy, cleanedUp: false, status: next.status,
    }) }
  }
  if (state.status === 'cleaned') return { ok: true, content: JSON.stringify({ arenaId: state.arenaId, status: 'cleaned', candidates: state.candidates }) }
  const id = typeof input.candidate_id === 'string' ? input.candidate_id : undefined
  if (id && !state.candidates.some((candidate) => candidate.id === id)) return { ok: false, content: 'Unknown candidate_id' }
  let next = state
  for (const candidate of state.candidates) {
    if (candidate.status === 'cleaned' || id && candidate.id !== id) continue
    const final = next.candidates.filter((item) => item.status !== 'cleaned' && (!id || item.id === id)).length === 1
      && next.candidates.every((item) => item.id === candidate.id || item.status === 'cleaned')
    const { complete } = await dispatchPostgresArenaMutation(deps, sessionId, fence, parentCallId, action, {
      repoRoot: state.repoRoot, arenaId: state.arenaId, baseSha: state.baseSha, candidate, final,
    }, probe.repositoryIdentity, state.arenaId, (receipt) => receipt.candidateId === candidate.id)
    next = {
      ...next, updatedAt: new Date().toISOString(),
      candidates: next.candidates.map((item) => item.id === candidate.id ? { ...item, status: 'cleaned' } : item),
    }
    next = { ...next, status: next.candidates.every((item) => item.status === 'cleaned') ? 'cleaned' : state.status }
    await saveArenaState(deps, sessionId, next, fence)
    await complete(next.status === 'cleaned' ? state.arenaId : undefined)
  }
  return { ok: true, content: JSON.stringify({
    arenaId: next.arenaId, status: next.status,
    candidates: next.candidates.map((candidate) => ({ id: candidate.id, status: candidate.status })),
  }) }
}

async function handleArenaInit(
  deps: HostLoopDeps,
  sessionId: string,
  input: Record<string, unknown>,
  fence: OwnerFence,
): Promise<ToolDispatchResult> {
  const specs = parseCandidateSpecs(input.candidates)
  const baseRef = typeof input.base_ref === 'string' && input.base_ref.trim().length > 0
    ? input.base_ref.trim()
    : 'HEAD'
  const customArenaId = typeof input.arena_id === 'string' && input.arena_id.trim().length > 0
    ? input.arena_id.trim()
    : undefined
  if (customArenaId !== undefined && !SAFE_ID_RE.test(customArenaId)) {
    return {
      ok: false,
      content: `Invalid arena_id "${customArenaId}": must match ^[a-zA-Z0-9_-]{1,48}$`,
    }
  }
  const arenaId = customArenaId ?? ulid().slice(-8).toLowerCase()

  const prior = await loadArenaState(deps, sessionId)
  if (prior && prior.status !== 'cleaned') {
    return { ok: false, content: `Arena "${prior.arenaId}" is not cleaned; explicitly clean it before initializing another.` }
  }

  const rootRes = await execWorkspaceCommand(
    deps,
    sessionId,
    `git rev-parse --show-toplevel && git rev-parse --verify --end-of-options ${shellQuote(`${baseRef}^{commit}`)}`,
    fence,
  )
  if (!rootRes.ok) {
    return {
      ok: false,
      content: `Failed to resolve git repository root or base_ref "${baseRef}": ${rootRes.stderr || rootRes.stdout}`,
    }
  }
  const lines = rootRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length !== 2 || !/^[0-9a-f]{40,64}$/.test(lines[1]!) || !lines[0]!.startsWith('/')) {
    return {
      ok: false,
      content: `Unexpected git rev-parse output: ${rootRes.stdout}`,
    }
  }
  const repoRoot = lines[0]!
  const baseSha = lines[1]!

  const arenaDir = `${repoRoot}/.kala-arena/${arenaId}`
  const candidates: ArenaCandidateRecord[] = specs.map((spec) => ({
    id: spec.id,
    label: spec.label ?? spec.id,
    ...(spec.description ? { description: spec.description } : {}),
    branch: `kala-arena/${arenaId}/${spec.id}`,
    worktreePath: `${arenaDir}/${spec.id}`,
    status: 'pending',
  }))

  // Never reuse a directory or branch (including one belonging to another session).
  const safetyCmd = [
    `cd ${shellQuote(repoRoot)}`,
    `test ! -L .kala-arena && test ! -e ${shellQuote(arenaDir)} && test ! -L ${shellQuote(arenaDir)}`,
    ...candidates.map((c) => `! git show-ref --verify --quiet ${shellQuote(`refs/heads/${c.branch}`)}`),
    `GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)`,
    `test ! -L "$GIT_COMMON_DIR" && test ! -L "$GIT_COMMON_DIR/info" && test ! -L "$GIT_COMMON_DIR/info/exclude"`,
  ].join(' && ')
  const safe = await execWorkspaceCommand(deps, sessionId, safetyCmd, fence)
  if (!safe.ok) {
    return { ok: false, content: 'Arena directory, branch, or Git exclude is already present or unsafe; choose a fresh arena_id.' }
  }

  const now = new Date().toISOString()
  let state: WorktreeArenaState = {
    arenaId, repoRoot, baseRef, baseSha, createdAt: now, updatedAt: now,
    status: 'initializing', candidates,
  }
  await saveArenaState(deps, sessionId, state, fence)

  const excludeCmd = [
    `cd ${shellQuote(repoRoot)}`,
    `GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)`,
    `test ! -L .kala-arena && test ! -e ${shellQuote(arenaDir)} && test ! -L "$GIT_COMMON_DIR/info" && test ! -L "$GIT_COMMON_DIR/info/exclude"`,
    `mkdir -p "$GIT_COMMON_DIR/info" ${shellQuote(arenaDir)}`,
    `grep -qxF '.kala-arena/' "$GIT_COMMON_DIR/info/exclude" 2>/dev/null || printf '\\n.kala-arena/\\n' >> "$GIT_COMMON_DIR/info/exclude"`,
  ].join(' && ')
  const excludeRes = await execWorkspaceCommand(deps, sessionId, excludeCmd, fence)
  if (!excludeRes.ok) {
    return {
      ok: false,
      content: `Failed to prepare .kala-arena directory: ${excludeRes.stderr || excludeRes.stdout}`,
    }
  }

  for (const candidate of candidates) {
    const addCmd = [
      `cd ${shellQuote(repoRoot)}`,
      `test ! -e ${shellQuote(candidate.worktreePath)} && test ! -L ${shellQuote(candidate.worktreePath)}`,
      `! git show-ref --verify --quiet ${shellQuote(`refs/heads/${candidate.branch}`)}`,
      `git worktree add -b ${shellQuote(candidate.branch)} ${shellQuote(candidate.worktreePath)} ${shellQuote(baseSha)}`,
    ].join(' && ')
    const addRes = await execWorkspaceCommand(deps, sessionId, addCmd, fence)
    if (!addRes.ok) {
      return {
        ok: false,
        content: `Failed to create worktree for candidate "${candidate.id}". Arena remains recorded for explicit cleanup: ${addRes.stderr || addRes.stdout}`,
      }
    }
    state = {
      ...state,
      updatedAt: new Date().toISOString(),
      candidates: state.candidates.map((c) => c.id === candidate.id ? { ...c, status: 'active' } : c),
    }
    await saveArenaState(deps, sessionId, state, fence)
  }

  state = {
    ...state,
    status: 'active',
  }
  await saveArenaState(deps, sessionId, state, fence)

  return {
    ok: true,
    content: JSON.stringify({
      arenaId: state.arenaId,
      repoRoot: state.repoRoot,
      baseRef: state.baseRef,
      baseSha: state.baseSha,
      status: state.status,
      candidates: state.candidates.map((c) => ({
        id: c.id,
        label: c.label,
        ...(c.description ? { description: c.description } : {}),
        branch: c.branch,
        worktreePath: c.worktreePath,
        delegationHint: `Instruct sub-agent for "${c.id}" to read/edit files exclusively under ${c.worktreePath} and run shell commands with cwd="${c.worktreePath}".`,
      })),
    }),
  }
}

async function handleArenaStatus(
  deps: HostLoopDeps,
  sessionId: string,
  fence: OwnerFence,
): Promise<ToolDispatchResult> {
  const state = await loadArenaState(deps, sessionId)
  if (!state) {
    return {
      ok: false,
      content: 'No worktree arena has been initialized for this session. Call worktree_arena with action="init" first.',
    }
  }

  const candidateStatuses: Array<Record<string, unknown>> = []
  for (const candidate of state.candidates) {
    if (candidate.status === 'cleaned' || candidate.status === 'pending') {
      candidateStatuses.push({
        id: candidate.id,
        label: candidate.label,
        branch: candidate.branch,
        worktreePath: candidate.worktreePath,
        status: candidate.status,
      })
      continue
    }
    const statusCmd = [
      worktreeGuard(state, candidate),
      `cd ${shellQuote(candidate.worktreePath)}`,
      `HEAD_SHA=$(git rev-parse HEAD)`,
      `printf 'HEAD=%s\\n' "$HEAD_SHA"`,
      `git status --porcelain`,
    ].join(' && ')
    const res = await execWorkspaceCommand(deps, sessionId, statusCmd, fence)
    if (!res.ok) {
      candidateStatuses.push({
        id: candidate.id,
        label: candidate.label,
        branch: candidate.branch,
        worktreePath: candidate.worktreePath,
        status: candidate.status,
        error: res.stderr || res.stdout,
      })
      continue
    }
    const rawLines = res.stdout.split(/\r?\n/).filter((l) => l.length > 0)
    const headLine = rawLines.find((l) => l.startsWith('HEAD='))
    const headSha = headLine ? headLine.slice('HEAD='.length).trim() : state.baseSha
    const porcelainLines = rawLines.filter((l) => !l.startsWith('HEAD='))
    const changedFiles = porcelainLines.map((l) => l.slice(3).trim()).filter(Boolean)

    const statRes = await execWorkspaceCommand(
      deps,
      sessionId,
      `${worktreeGuard(state, candidate)} && git -C ${shellQuote(candidate.worktreePath)} diff --shortstat ${shellQuote(state.baseSha)}`,
      fence,
    )
    candidateStatuses.push({
      id: candidate.id,
      label: candidate.label,
      branch: candidate.branch,
      worktreePath: candidate.worktreePath,
      status: candidate.status,
      headSha,
      commitsAhead: headSha !== state.baseSha,
      dirtyFileCount: changedFiles.length,
      changedFiles,
      shortStat: statRes.ok ? statRes.stdout.trim() : '',
    })
  }

  return {
    ok: true,
    content: JSON.stringify({
      arenaId: state.arenaId,
      repoRoot: state.repoRoot,
      baseSha: state.baseSha,
      status: state.status,
      selectedWinner: state.selectedWinner ?? null,
      candidates: candidateStatuses,
    }),
  }
}

async function handleArenaDiff(
  deps: HostLoopDeps,
  sessionId: string,
  input: Record<string, unknown>,
  fence: OwnerFence,
): Promise<ToolDispatchResult> {
  const state = await loadArenaState(deps, sessionId)
  if (!state) {
    return {
      ok: false,
      content: 'No worktree arena has been initialized for this session. Call worktree_arena with action="init" first.',
    }
  }

  const targetCandidateId = typeof input.candidate_id === 'string' && input.candidate_id.trim().length > 0
    ? input.candidate_id.trim()
    : undefined
  const statOnly = input.stat_only === true
  const maxChars = typeof input.max_chars === 'number' && Number.isInteger(input.max_chars) && input.max_chars >= 500
    ? Math.min(input.max_chars, MAX_DIFF_CHARS)
    : DEFAULT_MAX_DIFF_CHARS

  const selected = targetCandidateId
    ? state.candidates.filter((c) => c.id === targetCandidateId)
    : state.candidates.filter((c) => c.status === 'active' || c.status === 'applied')
  if (selected.length === 0) {
    return {
      ok: false,
      content: targetCandidateId
        ? `Unknown candidate_id "${targetCandidateId}". Available candidates: ${state.candidates.map((c) => c.id).join(', ')}`
        : 'No active candidates available to diff.',
    }
  }

  const diffs: Array<Record<string, unknown>> = []
  for (const candidate of selected) {
    if (candidate.status === 'cleaned' || candidate.status === 'pending') {
      return { ok: false, content: `Candidate "${candidate.id}" has no active worktree.` }
    }
    // Stage intent-to-add (`git add -N .`) so untracked files created by the candidate appear in `git diff` without committing them.
    const diffCmd = [
      worktreeGuard(state, candidate),
      `cd ${shellQuote(candidate.worktreePath)}`,
      `git add -N . >/dev/null 2>&1 || true`,
      `git diff --stat ${shellQuote(state.baseSha)}`,
    ].join(' && ')
    const statRes = await execWorkspaceCommand(deps, sessionId, diffCmd, fence)
    if (!statRes.ok) {
      return { ok: false, content: `Failed to diff "${candidate.id}": ${statRes.stderr || statRes.stdout}` }
    }
    let patch = ''
    let patchTruncated = false
    if (!statOnly) {
      const patchRes = await execWorkspaceCommand(
        deps,
        sessionId,
        `${worktreeGuard(state, candidate)} && git -C ${shellQuote(candidate.worktreePath)} diff ${shellQuote(state.baseSha)}`,
        fence,
      )
      if (!patchRes.ok) {
        return { ok: false, content: `Failed to diff "${candidate.id}": ${patchRes.stderr || patchRes.stdout}` }
      }
      {
        if (patchRes.stdout.length > maxChars) {
          patch = `${patchRes.stdout.slice(0, maxChars)}\n... [diff truncated at ${maxChars} chars]`
          patchTruncated = true
        } else {
          patch = patchRes.stdout
        }
      }
    }
    diffs.push({
      id: candidate.id,
      label: candidate.label,
      branch: candidate.branch,
      worktreePath: candidate.worktreePath,
      stat: statRes.ok ? statRes.stdout.trim() : statRes.stderr,
      ...(statOnly ? {} : { diff: patch, truncated: patchTruncated }),
    })
  }

  return {
    ok: true,
    content: JSON.stringify({
      arenaId: state.arenaId,
      baseSha: state.baseSha,
      candidates: diffs,
    }),
  }
}

async function handleArenaApply(
  deps: HostLoopDeps,
  sessionId: string,
  input: Record<string, unknown>,
  fence: OwnerFence,
): Promise<ToolDispatchResult> {
  const state = await loadArenaState(deps, sessionId)
  if (!state) {
    return {
      ok: false,
      content: 'No worktree arena has been initialized for this session. Call worktree_arena with action="init" first.',
    }
  }

  const candidateId = typeof input.candidate_id === 'string' ? input.candidate_id.trim() : ''
  const candidate = state.candidates.find((c) => c.id === candidateId)
  if (!candidate) {
    return {
      ok: false,
      content: `Unknown candidate_id "${candidateId}". Available candidates: ${state.candidates.map((c) => c.id).join(', ')}`,
    }
  }
  if (state.status !== 'active' || candidate.status !== 'active') {
    return {
      ok: false,
      content: `Arena or candidate "${candidateId}" is not active and cannot be applied again.`,
    }
  }

  if (input.strategy !== undefined && input.strategy !== 'patch' && input.strategy !== 'merge') {
    return { ok: false, content: 'strategy must be "patch" or "merge"' }
  }
  const strategy = input.strategy === 'patch' ? 'patch' : 'merge'
  const cleanupAfter = input.cleanup_after === true

  // Both operations are defined only against the original clean base, never a
  // caller's unrelated staged work or a partially merged main worktree.
  const preflight = await execWorkspaceCommand(deps, sessionId, [
    worktreeGuard(state, candidate),
    `cd ${shellQuote(state.repoRoot)}`,
    `test "$(git rev-parse HEAD)" = ${shellQuote(state.baseSha)}`,
    `test -z "$(git status --porcelain --untracked-files=normal)"`,
    `test "$(git -C ${shellQuote(candidate.worktreePath)} rev-parse --show-toplevel)" = ${shellQuote(candidate.worktreePath)}`,
    `test "$(git -C ${shellQuote(candidate.worktreePath)} branch --show-current)" = ${shellQuote(candidate.branch)}`,
    `git -C ${shellQuote(candidate.worktreePath)} merge-base --is-ancestor ${shellQuote(state.baseSha)} HEAD`,
  ].join(' && '), fence)
  if (!preflight.ok) {
    return { ok: false, content: `Primary workspace must be clean at base ${state.baseSha}, and candidate must still be on its arena branch derived from that base.` }
  }

  if (strategy === 'patch') {
    const applyPatchCmd = [
      `set -o pipefail`,
      worktreeGuard(state, candidate),
      `cd ${shellQuote(candidate.worktreePath)}`,
      `git add -A`,
      `git diff --cached --binary ${shellQuote(state.baseSha)} | git -C ${shellQuote(state.repoRoot)} apply --check --index -`,
      `git diff --cached --binary ${shellQuote(state.baseSha)} | git -C ${shellQuote(state.repoRoot)} apply --index -`,
    ].join(' && ')
    const patchRes = await execWorkspaceCommand(deps, sessionId, applyPatchCmd, fence)
    if (!patchRes.ok) {
      return {
        ok: false,
        content: `Failed to apply patch from candidate "${candidateId}" into primary workspace: ${patchRes.stderr || patchRes.stdout}`,
      }
    }
  } else {
    // A clean primary workspace at base and an ancestor-checked candidate
    // guarantee a fast-forward, without leaving a conflict/merge state.
    const mergeCmd = [
      worktreeGuard(state, candidate),
      `cd ${shellQuote(candidate.worktreePath)}`,
      `git add -A`,
      `if ! git diff --cached --quiet; then git -c user.name="Kala Arena" -c user.email="arena@example.com" commit -m ${shellQuote(`feat(arena): candidate ${candidate.id}`)}; fi`,
      `cd ${shellQuote(state.repoRoot)}`,
      `test "$(git rev-parse HEAD)" = ${shellQuote(state.baseSha)}`,
      `test -z "$(git status --porcelain --untracked-files=normal)"`,
      `git merge --ff-only ${shellQuote(candidate.branch)}`,
    ].join(' && ')
    const mergeRes = await execWorkspaceCommand(deps, sessionId, mergeCmd, fence)
    if (!mergeRes.ok) {
      return {
        ok: false,
        content: `Failed to merge candidate "${candidateId}" (${candidate.branch}) into primary workspace: ${mergeRes.stderr || mergeRes.stdout}`,
      }
    }
  }

  const nextCandidates = state.candidates.map((c) =>
    c.id === candidate.id ? { ...c, status: 'applied' as const } : c,
  )
  let nextState: WorktreeArenaState = {
    ...state,
    updatedAt: new Date().toISOString(),
    status: 'applied',
    selectedWinner: candidate.id,
    candidates: nextCandidates,
  }

  if (cleanupAfter) {
    await saveArenaState(deps, sessionId, nextState, fence)
    nextState = await cleanupArenaWorktrees(deps, sessionId, nextState, fence)
  } else {
    await saveArenaState(deps, sessionId, nextState, fence)
  }

  return {
    ok: true,
    content: JSON.stringify({
      arenaId: nextState.arenaId,
      appliedCandidate: candidate.id,
      branch: candidate.branch,
      strategy,
      cleanedUp: cleanupAfter,
      status: nextState.status,
    }),
  }
}

async function handleArenaCleanup(
  deps: HostLoopDeps,
  sessionId: string,
  input: Record<string, unknown>,
  fence: OwnerFence,
): Promise<ToolDispatchResult> {
  const state = await loadArenaState(deps, sessionId)
  if (!state) {
    return {
      ok: false,
      content: 'No worktree arena has been initialized for this session.',
    }
  }

  const targetCandidateId = typeof input.candidate_id === 'string' && input.candidate_id.trim().length > 0
    ? input.candidate_id.trim()
    : undefined

  if (targetCandidateId && !state.candidates.some((c) => c.id === targetCandidateId)) {
    return {
      ok: false,
      content: `Unknown candidate_id "${targetCandidateId}". Available candidates: ${state.candidates.map((c) => c.id).join(', ')}`,
    }
  }

  const nextState = await cleanupArenaWorktrees(deps, sessionId, state, fence, targetCandidateId)
  return {
    ok: true,
    content: JSON.stringify({
      arenaId: nextState.arenaId,
      status: nextState.status,
      candidates: nextState.candidates.map((c) => ({
        id: c.id,
        status: c.status,
      })),
    }),
  }
}

async function cleanupArenaWorktrees(
  deps: HostLoopDeps,
  sessionId: string,
  state: WorktreeArenaState,
  fence: OwnerFence,
  onlyCandidateId?: string,
): Promise<WorktreeArenaState> {
  if (state.status === 'cleaned') return state
  let nextState = state
  for (const candidate of state.candidates) {
    if (onlyCandidateId && candidate.id !== onlyCandidateId) {
      continue
    }
    if (candidate.status === 'cleaned') {
      continue
    }
    const arenaDir = `${state.repoRoot}/.kala-arena/${state.arenaId}`
    // Validate the persisted path/branch even when no worktree currently exists.
    if (!SAFE_ID_RE.test(state.arenaId) || !SAFE_ID_RE.test(candidate.id) ||
      candidate.worktreePath !== `${arenaDir}/${candidate.id}` ||
      candidate.branch !== `kala-arena/${state.arenaId}/${candidate.id}`) {
      throw new Error('Invalid arena metadata: refusing to remove an unverified path or branch')
    }
    const rmCmd = [
      `cd ${shellQuote(state.repoRoot)}`,
      `test ! -L .kala-arena && test ! -L ${shellQuote(arenaDir)} && test ! -L ${shellQuote(candidate.worktreePath)}`,
      `if [ -e ${shellQuote(candidate.worktreePath)} ]; then
         test "$(git -C ${shellQuote(candidate.worktreePath)} rev-parse --show-toplevel)" = ${shellQuote(candidate.worktreePath)} &&
         test "$(git -C ${shellQuote(candidate.worktreePath)} rev-parse --path-format=absolute --git-common-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" &&
         test "$(git -C ${shellQuote(candidate.worktreePath)} branch --show-current)" = ${shellQuote(candidate.branch)} &&
         git worktree remove --force ${shellQuote(candidate.worktreePath)};
       else
         ! git show-ref --verify --quiet ${shellQuote(`refs/heads/${candidate.branch}`)};
       fi`,
      `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${candidate.branch}`)}; then git branch -D ${shellQuote(candidate.branch)}; fi`,
    ].join(' && ')
    const result = await execWorkspaceCommand(deps, sessionId, rmCmd, fence)
    if (!result.ok) {
      throw new Error(`Failed to clean candidate "${candidate.id}"; arena remains recoverable: ${result.stderr || result.stdout}`)
    }
    nextState = {
      ...nextState,
      updatedAt: new Date().toISOString(),
      candidates: nextState.candidates.map((c) => c.id === candidate.id ? { ...c, status: 'cleaned' } : c),
    }
    await saveArenaState(deps, sessionId, nextState, fence)
  }

  const allCleaned = nextState.candidates.every((c) => c.status === 'cleaned')
  if (allCleaned) {
    const result = await execWorkspaceCommand(
      deps,
      sessionId,
      `cd ${shellQuote(state.repoRoot)} && test ! -L .kala-arena && test ! -L ${shellQuote(`${state.repoRoot}/.kala-arena/${state.arenaId}`)} && (if [ -d ${shellQuote(`${state.repoRoot}/.kala-arena/${state.arenaId}`)} ]; then rmdir ${shellQuote(`${state.repoRoot}/.kala-arena/${state.arenaId}`)}; fi) && (rmdir .kala-arena 2>/dev/null || true)`,
      fence,
    )
    if (!result.ok) {
      throw new Error(`Arena directory is not empty or cannot be removed: ${result.stderr || result.stdout}`)
    }
  }

  nextState = {
    ...nextState,
    updatedAt: new Date().toISOString(),
    status: allCleaned ? 'cleaned' : state.status,
  }
  await saveArenaState(deps, sessionId, nextState, fence)
  return nextState
}
