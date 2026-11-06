/**
 * The `agent` builtin — the only host-side tool.
 *
 * Everything else in the tool registry maps to an executor process; `agent`
 * lives inside the host loop because it needs to spawn a *child JSONL
 * session* using the same store, dispatch a `user_message` through the same
 * loop, and hand the child's final assistant text back as a tool_result.
 *
 * Sub-agents run headless (no dashboard is subscribed to the child) so we
 * force `allow_all` approval mode regardless of the parent's setting —
 * otherwise every RequestApprovalEffect deadlocks. See
 * [ADR 0014](../../../../docs/meta/adr/0014-subagent-approval-mode.md).
 */

import type {
  AgentConfig,
  AgentState,
  CallToolEffect,
} from '@agent-kernel/kernel'

import {
  createArtifactStore,
  isSubAgentRole,
  resolveSubAgentPolicy,
  type SubAgentPolicy,
  type SubAgentPolicyInput,
  type SubAgentRole,
} from '@agent-kernel/shared/enhancement'
import { ulid } from 'ulid'

import { effectiveDelegationDepth, type SessionRecord, type SessionStore } from '../store/session.js'
import type { ChildCommand } from '../store/child-command-state.js'
import type { HostLoopDeps, LoopHandle, ModelResolver } from '../loop-types.js'
import { dispatchOne } from '../loop.js'

const DEFAULT_MAX_AGENT_DEPTH = 1
const DEFAULT_MAX_AGENT_FANOUT = 8
export const AGENT_TOOL_NAME = 'agent'

type ActiveSubAgent = {
  store: SessionStore
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  agentType?: string
  intention?: string
  startedAt: Date
  cancelled: boolean
  cancelReason?: string
  runtimeCancellation?: Promise<{ ok: true; childSessionId: string }>
  cancelRuntime?: () => Promise<void>
  steeringQueue: string[]
  completionPromise?: Promise<{ ok: boolean; content: string }>
  latestOutcome?: { ok: boolean; content: string }
}

const childSubAgentBySessionId = new Map<string, ActiveSubAgent>()
const completedSubAgentOutcomes = new Map<string, {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  agentType?: string
  intention?: string
  outcome: { ok: boolean; content: string }
}>()

export function completedSubAgentOutcomeForChild(parentSessionId: string, childSessionId: string): string | undefined {
  const completed = completedSubAgentOutcomes.get(childSessionId)
  return completed?.parentSessionId === parentSessionId ? completed.outcome.content : undefined
}

export type SubAgentRuntimeController = {
  send(record: SessionRecord, text: string, model?: string): Promise<void>
  cancel(record: SessionRecord): Promise<void>
}

export type RunAgentToolOptions = {
  configOverride?: AgentConfig
  onChildCreated?: (child: SessionRecord) => void | Promise<void>
}

type TimeoutReason = 'ordinary-idle' | 'tool-idle' | 'absolute-deadline' | 'turn-limit'
type TimeoutObservation = { cursor: number; status: AgentState['status']; requestedToolTimeoutMs?: number }
type TimeoutMonitor = { last: TimeoutObservation; lastActivityAt: number; graceStartedAt?: number; reason?: TimeoutReason }

export function evaluateSubAgentTimeout(input: {
  now: number
  startedAt: number
  observation: TimeoutObservation
  monitor: TimeoutMonitor
  idleTimeoutMs: number
  toolIdleTimeoutMs: number
  absoluteTimeoutMs: number
  gracePeriodMs: number
  turnCount?: number
  maxTurns?: number
}): { monitor: TimeoutMonitor; action: 'continue' | 'cancel'; reason?: TimeoutReason } {
  const progressed = input.observation.cursor !== input.monitor.last.cursor || input.observation.status !== input.monitor.last.status
  let monitor: TimeoutMonitor = progressed
    ? { last: input.observation, lastActivityAt: input.now, ...(['absolute-deadline', 'turn-limit'].includes(input.monitor.reason ?? '') ? { graceStartedAt: input.monitor.graceStartedAt, reason: input.monitor.reason } : {}) }
    : input.monitor
  if (monitor.graceStartedAt !== undefined) {
    return input.now - monitor.graceStartedAt >= input.gracePeriodMs
      ? { monitor, action: 'cancel', reason: monitor.reason }
      : { monitor, action: 'continue', reason: monitor.reason }
  }
  const absoluteExpired = input.now - input.startedAt >= input.absoluteTimeoutMs
  const turnLimitReached = input.maxTurns !== undefined && (input.turnCount ?? 0) >= input.maxTurns
  const toolRunning = input.observation.status === 'executing_tools'
  const toolDeadlineWithGrace = (input.observation.requestedToolTimeoutMs ?? 0) + 2 * 60_000
  const idleLimit = toolRunning ? Math.max(input.toolIdleTimeoutMs, toolDeadlineWithGrace) : input.idleTimeoutMs
  const idleExpired = input.now - monitor.lastActivityAt >= idleLimit
  if (!absoluteExpired && !turnLimitReached && !idleExpired) return { monitor, action: 'continue' }
  const reason: TimeoutReason = absoluteExpired ? 'absolute-deadline' : turnLimitReached ? 'turn-limit' : toolRunning ? 'tool-idle' : 'ordinary-idle'
  monitor = { ...monitor, graceStartedAt: input.now, reason }
  return { monitor, action: input.gracePeriodMs === 0 ? 'cancel' : 'continue', reason }
}

function startSubAgentTimeoutMonitor(
  deps: HostLoopDeps,
  aborts: Map<string, AbortController>,
  active: ActiveSubAgent,
  policy: SubAgentPolicy,
  baselineTurns: number,
  loop?: LoopHandle,
): { stop: () => void; result: () => TimeoutReason | undefined } {
  const startedAtMs = active.startedAt.getTime()
  const initialState = deps.store.get(active.childSessionId)?.state
  let monitor: TimeoutMonitor = {
    last: { cursor: initialState?.cursor ?? 0, status: initialState?.status ?? 'idle' },
    lastActivityAt: startedAtMs,
  }
  let timeoutReason: TimeoutReason | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    const state = deps.store.get(active.childSessionId)?.state
    if (active.cancelled || timeoutReason) return
    if (state) {
      const evaluated = evaluateSubAgentTimeout({
        now: Date.now(),
        startedAt: startedAtMs,
        observation: {
          cursor: state.cursor,
          status: state.status,
          ...(state.status === 'executing_tools' ? { requestedToolTimeoutMs: requestedToolTimeoutMs(state) } : {}),
        },
        monitor,
        idleTimeoutMs: policy.idleTimeoutMs!,
        toolIdleTimeoutMs: policy.toolIdleTimeoutMs!,
        absoluteTimeoutMs: policy.timeoutMs!,
        gracePeriodMs: policy.gracePeriodMs!,
        turnCount: assistantTurnCount(state) - baselineTurns,
        maxTurns: policy.maxTurns,
      })
      monitor = evaluated.monitor
      if (evaluated.action === 'cancel') {
        timeoutReason = evaluated.reason
        void interruptSubAgent(
          deps, aborts, active.parentSessionId, active.parentCallId, active.childSessionId,
          `sub-agent ${timeoutReason ?? 'timeout'} exceeded; absoluteTimeoutMs=${policy.timeoutMs}; idleTimeoutMs=${policy.idleTimeoutMs}; toolIdleTimeoutMs=${policy.toolIdleTimeoutMs}; gracePeriodMs=${policy.gracePeriodMs}`,
          loop,
        ).catch(() => undefined)
        return
      }
    }
    timer = setTimeout(check, 1_000)
    timer.unref?.()
  }
  timer = setTimeout(check, 1_000)
  timer.unref?.()
  return {
    stop: () => { if (timer) clearTimeout(timer) },
    result: () => timeoutReason,
  }
}

const activeSubAgents = new Map<string, ActiveSubAgent>()
const reservedSubAgentSlots = new Map<string, Set<string>>()

function activeKey(parentSessionId: string, parentCallId: string): string {
  return `${parentSessionId}\u0000${parentCallId}`
}

export function activeSubAgentFor(
  parentSessionId: string,
  parentCallId: string,
): ActiveSubAgent | null {
  return activeSubAgents.get(activeKey(parentSessionId, parentCallId)) ?? null
}

export function activeSubAgentForChild(parentSessionId: string, childSessionId: string): ActiveSubAgent | null {
  const active = childSubAgentBySessionId.get(childSessionId)
  return active?.parentSessionId === parentSessionId ? active : null
}

export function activeSubAgentsForParent(parentSessionId: string): readonly ActiveSubAgent[] {
  return [...activeSubAgents.values()].filter((entry) => entry.parentSessionId === parentSessionId)
}

function reservedSubAgentCount(parentSessionId: string): number {
  return reservedSubAgentSlots.get(parentSessionId)?.size ?? 0
}

function reserveSubAgentSlot(
  parentSessionId: string,
  parentCallId: string,
  maxFanOut: number,
): { admitted: boolean; concurrentSiblingCount: number } {
  const concurrentSiblingCount =
    activeSubAgentsForParent(parentSessionId).length + reservedSubAgentCount(parentSessionId)
  if (concurrentSiblingCount >= maxFanOut) return { admitted: false, concurrentSiblingCount }

  const reserved = reservedSubAgentSlots.get(parentSessionId) ?? new Set<string>()
  reserved.add(parentCallId)
  reservedSubAgentSlots.set(parentSessionId, reserved)
  return { admitted: true, concurrentSiblingCount }
}

function releaseSubAgentSlot(parentSessionId: string, parentCallId: string): void {
  const reserved = reservedSubAgentSlots.get(parentSessionId)
  if (!reserved) return
  reserved.delete(parentCallId)
  if (reserved.size === 0) reservedSubAgentSlots.delete(parentSessionId)
}

export function isCancelledSubAgentChild(childSessionId: string): boolean {
  return [...activeSubAgents.values()].some((entry) => entry.childSessionId === childSessionId && entry.cancelled)
}

export async function interruptSubAgent(
  deps: HostLoopDeps,
  aborts: Map<string, AbortController>,
  parentSessionId: string,
  parentCallId: string,
  childSessionId?: string,
  reason = 'sub-agent interrupted by user',
  loop?: LoopHandle,
): Promise<{ ok: boolean; childSessionId?: string; error?: string }> {
  const owned = activeSubAgentFor(parentSessionId, parentCallId)
  if (!owned || owned.store !== deps.store || deps.store.get(owned.childSessionId)?.parentSessionId !== parentSessionId) {
    return { ok: false, error: 'sub-agent is not an active child of this parent in this store' }
  }
  await deps.assertSessionEffectOwner?.(owned.childSessionId)
  const marked = markSubAgentInterrupted(parentSessionId, parentCallId, childSessionId, reason)
  if (!marked.ok) return marked
  const active = activeSubAgentFor(parentSessionId, parentCallId)
  if (active?.cancelRuntime) {
    const cancellation = (async () => {
      await interruptSubAgentsForParent(deps, aborts, marked.childSessionId, reason, loop)
      await active.cancelRuntime!()
      return { ok: true as const, childSessionId: marked.childSessionId }
    })()
    active.runtimeCancellation = cancellation
    try {
      await cancellation
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      active.cancelReason = `${reason}; runtime cancellation failed: ${detail}`
      throw error
    } finally {
      if (active.runtimeCancellation === cancellation) active.runtimeCancellation = undefined
    }
  } else {
    if (loop) await loop.dispatch(marked.childSessionId, { kind: 'cancel' })
    else await dispatchOne(deps, marked.childSessionId, { kind: 'cancel' }, aborts)
  }
  return { ok: true, childSessionId: marked.childSessionId }
}

export function markSubAgentInterrupted(
  parentSessionId: string,
  parentCallId: string,
  childSessionId?: string,
  reason = 'sub-agent interrupted by user',
): { ok: true; childSessionId: string } | { ok: false; error: string } {
  const active = activeSubAgentFor(parentSessionId, parentCallId)
  if (!active) return { ok: false, error: 'sub-agent is not running' }
  if (childSessionId && active.childSessionId !== childSessionId) {
    return { ok: false, error: 'sub-agent child session mismatch' }
  }
  active.cancelled = true
  active.cancelReason = reason
  return { ok: true, childSessionId: active.childSessionId }
}

/**
 * Cancel an external-runtime child before publishing the wrapper's cancelled
 * state. Concurrent Stop requests share the same runtime cancellation so the
 * operation remains idempotent while cancellation is in flight.
 */
export async function interruptSubAgentAfterRuntimeCancel(
  parentSessionId: string,
  parentCallId: string,
  childSessionId: string | undefined,
  cancelRuntime: (childSessionId: string) => Promise<void>,
  reason = 'sub-agent interrupted by user',
): Promise<{ ok: true; childSessionId: string } | { ok: false; error: string }> {
  const active = activeSubAgentFor(parentSessionId, parentCallId)
  if (!active) return { ok: false, error: 'sub-agent is not running' }
  if (childSessionId && active.childSessionId !== childSessionId) {
    return { ok: false, error: 'sub-agent child session mismatch' }
  }
  if (active.cancelled) return { ok: true, childSessionId: active.childSessionId }
  if (active.runtimeCancellation) return await active.runtimeCancellation

  const cancellation = (async () => {
    await cancelRuntime(active.childSessionId)
    active.cancelled = true
    active.cancelReason = reason
    return { ok: true as const, childSessionId: active.childSessionId }
  })()
  active.runtimeCancellation = cancellation
  try {
    return await cancellation
  } finally {
    if (active.runtimeCancellation === cancellation) active.runtimeCancellation = undefined
  }
}

export async function interruptSubAgentsForParent(
  deps: HostLoopDeps,
  aborts: Map<string, AbortController>,
  parentSessionId: string,
  reason = 'parent session cancelled',
  loop?: LoopHandle,
): Promise<void> {
  for (const active of activeSubAgentsForParent(parentSessionId)) {
    if (active.store !== deps.store || deps.store.get(active.childSessionId)?.parentSessionId !== parentSessionId) continue
    await interruptSubAgent(deps, aborts, active.parentSessionId, active.parentCallId, active.childSessionId, reason, loop)
  }
}

export async function runAgentTool(
  deps: HostLoopDeps,
  parentSessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  loop?: LoopHandle,
  runtimeController?: SubAgentRuntimeController,
  optionsOrOnChildCreated?: RunAgentToolOptions | ((child: SessionRecord) => void | Promise<void>),
): Promise<{ ok: boolean; content: string }> {
  const options: RunAgentToolOptions = typeof optionsOrOnChildCreated === 'function'
    ? { onChildCreated: optionsOrOnChildCreated }
    : optionsOrOnChildCreated ?? {}
  const parent = deps.store.get(parentSessionId)
  if (!parent) return { ok: false, content: 'parent session not found' }
  const prompt = effect.input.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { ok: false, content: 'agent prompt is required' }
  }
  if (deps.store.usesSharedSessionAuthority()) {
    return runSharedAgentTool(deps, parent, effect, prompt, options)
  }
  if (effect.input.mode === 'background' && (deps.assertSessionEffectOwner || deps.store.usesSharedSessionAuthority())) {
    return { ok: false, content: 'Background sub-agents are unavailable with shared Session ownership without durable child routing' }
  }
  const depth = effectiveDelegationDepth(parent)
  const maxDepth = Math.min(parent.config.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH, DEFAULT_MAX_AGENT_DEPTH)
  const maxFanOut = parent.config.maxAgentFanOut ?? DEFAULT_MAX_AGENT_FANOUT
  const admission = reserveSubAgentSlot(parentSessionId, effect.callId, maxFanOut)
  const concurrentSiblingCount = admission.concurrentSiblingCount

  const policyInput = readPolicyInput(effect, parent.config)
  const agentType = agentTypeOf(effect) ?? policyInput?.role
  const model = typeof effect.input.model === 'string' ? effect.input.model : undefined
  const policy = resolveSubAgentPolicy({
    input: policyInput,
    parentTools: (options.configOverride ?? parent.config).tools.map((tool) => tool.name),
    parentDepth: depth,
    maxDepth,
    concurrentSiblingCount,
    maxFanOut,
  })
  const intention = policy.intention

  if (policy.reasons.includes('policy_max_depth_exceeded')) {
    if (admission.admitted) releaseSubAgentSlot(parentSessionId, effect.callId)
    await persistSubAgentPolicyArtifact(deps, parent, undefined, effect.callId, policy)
    return failEnvelope(
      'depth-exceeded',
      agentType,
      `agent depth exceeded: parent depth ${depth} >= max ${maxDepth}`,
      0,
      0,
      intention,
    )
  }
  if (!admission.admitted || policy.reasons.includes('policy_max_fanout_exceeded')) {
    await persistSubAgentPolicyArtifact(deps, parent, undefined, effect.callId, policy)
    return failEnvelope(
      'fanout-exceeded',
      agentType,
      `agent fan-out exceeded: ${concurrentSiblingCount} live siblings >= max ${maxFanOut}`,
      0,
      0,
      intention,
    )
  }

  // Active tracking is process-local, while parentCallId is durable. Restart can
  // redispatch a pending `agent` call; reuse its completed child or explicitly
  // terminate an incomplete orphan instead of spawning a duplicate child.
  const startedAt = new Date()
  let child: SessionRecord
  let active: ActiveSubAgent
  try {
    const existingChild = (await deps.store.listChildren(parentSessionId))
      .find((candidate) => candidate.parentCallId === effect.callId)
    if (existingChild) {
      const final = existingChild.state
      const turns = assistantTurnCount(final)
      if (final.status === 'done') {
        return okEnvelope(existingChild.sessionId, agentType, finalAssistantText(final), turns, 0, intention)
      }
      if (final.status !== 'error') {
        await dispatchOne(deps, existingChild.sessionId, { kind: 'cancel' }, aborts)
      }
      return failEnvelope(
        existingChild.sessionId,
        agentType,
        `sub-agent recovery stopped incomplete child in status ${final.status}`,
        turns,
        0,
        intention,
      )
    }

    const effectiveTools = pickEffectiveTools(effect.input.tools, policy.allowedTools)
    const childSessionId = ulid()
    child = await deps.store.create({
      sessionId: childSessionId,
      config: filteredAgentConfig(options.configOverride ?? parent.config, effectiveTools),
      agentRuntime: parent.agentRuntime,
      ...(parent.agentRuntimeVersion ? { agentRuntimeVersion: parent.agentRuntimeVersion } : {}),
      ...(parent.agentRuntime !== 'kernel' ? { externalSessionId: childSessionId } : {}),
      parentSessionId,
      parentCursor: parent.state.cursor,
      delegationDepth: depth + 1,
      parentCallId: effect.callId,
      ...(agentType !== undefined ? { agentType } : {}),
      subAgentStartedAt: startedAt.toISOString(),
      ...(parent.workspaceId !== undefined ? { workspaceId: parent.workspaceId } : {}),
      ...(parent.workspaceName !== undefined ? { workspaceName: parent.workspaceName } : {}),
      ...(parent.state.cwd !== undefined ? { initialCwd: parent.state.cwd } : {}),
      // Sub-agents run headless: no dashboard is attached to the child session,
      // so any RequestApprovalEffect would deadlock. Force allow_all regardless
      // of the parent's mode. See docs/meta/adr/0014-subagent-approval-mode.md.
      initialApprovalMode: 'allow_all',
    })
    await options.onChildCreated?.(child)

    await persistSubAgentPolicyArtifact(deps, parent, child.sessionId, effect.callId, policy)

    active = {
      store: deps.store,
      parentSessionId,
      parentCallId: effect.callId,
      childSessionId: child.sessionId,
      ...(agentType !== undefined ? { agentType } : {}),
      ...(intention !== undefined ? { intention } : {}),
      startedAt,
      cancelled: false,
      steeringQueue: [],
      ...(parent.agentRuntime !== 'kernel' && runtimeController
        ? { cancelRuntime: async () => await runtimeController.cancel(child) }
        : {}),
    }
    activeSubAgents.set(activeKey(parentSessionId, effect.callId), active)
    childSubAgentBySessionId.set(child.sessionId, active)
  } finally {
    if (admission.admitted) releaseSubAgentSlot(parentSessionId, effect.callId)
  }
  deps.broadcast.onSubAgentStarted?.({
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    ...(agentType !== undefined ? { agentType } : {}),
    ...(intention !== undefined ? { intention } : {}),
    prompt,
    ...(model !== undefined ? { model } : {}),
    startedAt: startedAt.toISOString(),
  })

  const runLifecycle = async (): Promise<{ ok: boolean; content: string }> => {
    const priorModel = model ? deps.models?.get(child.sessionId) : undefined
    if (model && isSettableModelResolver(deps.models)) {
      deps.models.set(child.sessionId, model)
    }
    const timeoutMonitor = startSubAgentTimeoutMonitor(deps, aborts, active, policy, 0, loop)
    let dispatchError: string | undefined
    try {
      try {
        const dispatchPromptToChild = async (messageText: string): Promise<void> => {
          if (child.agentRuntime !== 'kernel') {
            if (!runtimeController) throw new Error(`${child.agentRuntime} sub-agent runtime is unavailable`)
            await runtimeController.send(child, messageText, model)
            await waitForExternalSubAgent(deps.store, child.sessionId, active)
          } else {
            // Join the child to the same Loop actor when available. This preserves
            // per-Session serialization and lets an idle restart drain observe the
            // child's terminal transition. Direct dispatchOne() bypassed the Loop's
            // checkpoint notification channel and could deadlock a deployment.
            if (loop) await loop.dispatch(child.sessionId, { kind: 'user_message', text: messageText })
            else await dispatchOne(deps, child.sessionId, { kind: 'user_message', text: messageText }, aborts)
          }
        }

        if (!active.cancelled) {
          await dispatchPromptToChild(prompt)
          while (!active.cancelled && active.steeringQueue.length > 0) {
            const nextSteering = active.steeringQueue.shift()!
            await dispatchPromptToChild(nextSteering)
          }
        }
      } catch (err) {
        dispatchError = err instanceof Error ? err.message : String(err)
      } finally {
        timeoutMonitor.stop()
        if (model && isSettableModelResolver(deps.models)) {
          if (priorModel) deps.models.set(child.sessionId, priorModel)
          else deps.models.delete(child.sessionId)
        }
      }
    } finally {
      activeSubAgents.delete(activeKey(parentSessionId, effect.callId))
      childSubAgentBySessionId.delete(child.sessionId)
    }
    const finishedAt = new Date()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const final = deps.store.get(child.sessionId)?.state
    const turns = final ? assistantTurnCount(final) : 0
    const timeoutReason = timeoutMonitor.result()
    const timedOut = timeoutReason !== undefined

    let outcome: { ok: boolean; content: string }
    if (active.cancelled) {
      const error = active.cancelReason ?? 'sub-agent interrupted'
      const partial = final ? finalAssistantText(final) : ''
      deps.broadcast.onSubAgentFinished?.({
        parentSessionId,
        parentCallId: effect.callId,
        childSessionId: child.sessionId,
        status: timedOut && partial ? 'timed_out_with_partial_result' : 'cancelled',
        turns,
        durationMs,
        finishedAt: finishedAt.toISOString(),
        error,
      })
      outcome = timedOut && partial
        ? partialTimeoutEnvelope(child.sessionId, agentType, partial, timeoutReason ?? 'absolute-deadline', turns, durationMs, intention)
        : timedOut
          ? failEnvelope(child.sessionId, agentType, `timeout: ${error}`, turns, durationMs, intention)
          : cancelEnvelope(child.sessionId, agentType, error, turns, durationMs, intention)
    } else if (dispatchError || !final || final.status !== 'done') {
      const error =
        dispatchError ??
        final?.error ??
        `agent ended with status ${final?.status ?? 'unknown'}`
      deps.broadcast.onSubAgentFinished?.({
        parentSessionId,
        parentCallId: effect.callId,
        childSessionId: child.sessionId,
        status: 'failed',
        turns,
        durationMs,
        finishedAt: finishedAt.toISOString(),
        error,
      })
      outcome = failEnvelope(child.sessionId, agentType, error, turns, durationMs, intention)
    } else {
      deps.broadcast.onSubAgentFinished?.({
        parentSessionId,
        parentCallId: effect.callId,
        childSessionId: child.sessionId,
        status: 'completed',
        turns,
        durationMs,
        finishedAt: finishedAt.toISOString(),
      })
      outcome = okEnvelope(child.sessionId, agentType, finalAssistantText(final), turns, durationMs, intention)
    }

    active.latestOutcome = outcome
    completedSubAgentOutcomes.set(child.sessionId, {
      parentSessionId,
      parentCallId: effect.callId,
      childSessionId: child.sessionId,
      ...(agentType !== undefined ? { agentType } : {}),
      ...(intention !== undefined ? { intention } : {}),
      outcome,
    })
    return outcome
  }

  const executionPromise = runLifecycle()
  active.completionPromise = executionPromise

  const mode = effect.input.mode === 'background' ? 'background' : 'sync'
  if (mode === 'background') {
    return runningEnvelope(
      child.sessionId,
      agentType,
      `Sub-agent started in background. Use read_agent { agent_id: "${child.sessionId}", wait: true } to await completion or write_agent { agent_id: "${child.sessionId}", message: "..." } to steer or follow up.`,
      0,
      0,
      intention,
    )
  }

  return await executionPromise
}

async function runSharedAgentTool(
  deps: HostLoopDeps,
  parent: SessionRecord,
  effect: CallToolEffect,
  prompt: string,
  options: RunAgentToolOptions,
): Promise<{ ok: boolean; content: string }> {
  const inbox = deps.store.childCommandInbox
  if (!inbox) return { ok: false, content: 'Shared child creation requires a durable inbox' }
  const requestedModel = typeof effect.input.model === 'string' ? effect.input.model.trim() : undefined
  const model = requestedModel ? deps.normalizeAgentModel?.(requestedModel) : undefined
  if (requestedModel && !model) return { ok: false, content: `unknown or ambiguous model: ${requestedModel}` }
  const depth = effectiveDelegationDepth(parent)
  const maxDepth = Math.min(parent.config.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH, DEFAULT_MAX_AGENT_DEPTH)
  const maxFanOut = parent.config.maxAgentFanOut ?? DEFAULT_MAX_AGENT_FANOUT
  const policyInput = readPolicyInput(effect, parent.config)
  const agentType = agentTypeOf(effect) ?? policyInput?.role
  const policy = resolveSubAgentPolicy({
    input: policyInput,
    parentTools: (options.configOverride ?? parent.config).tools.map((tool) => tool.name),
    parentDepth: depth, maxDepth, concurrentSiblingCount: 0, maxFanOut,
  })
  if (policy.reasons.includes('policy_max_depth_exceeded') || policy.reasons.includes('policy_max_fanout_exceeded')) {
    return failEnvelope('admission-rejected', agentType, policy.reasons.join(', '), 0, 0, policy.intention)
  }
  try {
    await deps.assertSessionEffectOwner?.(parent.sessionId)
    const existing = (await deps.store.listChildren(parent.sessionId))
      .find((candidate) => candidate.parentCallId === effect.callId)
    if (existing && model && existing.preferences.selectedModel !== model) {
      return { ok: false, content: 'Child call identity conflicts with a different model' }
    }
    const childSessionId = ulid()
    const preferredChildReplicaId = existing?.preferredChildReplicaId
      ?? await deps.chooseChildReplicaId?.(childSessionId)
    if (preferredChildReplicaId && !deps.handoffChildOwner) {
      throw new Error('Shared child placement requires a fenced child lease handoff')
    }
    if (!existing && model && deps.modelPolicy) {
      if (!parent.organizationId) throw new Error('Child model policy requires tenant attribution')
      await deps.modelPolicy.assertCanUseModel({
        organizationId: parent.organizationId, sessionId: childSessionId, model,
        ...(parent.principal ? { principal: parent.principal } : {}),
      })
    }
    const child = existing ?? await deps.store.createChildWithCommand({
      sessionId: childSessionId,
      config: filteredAgentConfig(options.configOverride ?? parent.config, pickEffectiveTools(effect.input.tools, policy.allowedTools)),
      ...(model ? { preferences: { selectedModel: model } } : {}),
      agentRuntime: parent.agentRuntime,
      ...(parent.agentRuntimeVersion ? { agentRuntimeVersion: parent.agentRuntimeVersion } : {}),
      parentSessionId: parent.sessionId,
      parentCursor: parent.state.cursor,
      delegationDepth: depth + 1,
      parentCallId: effect.callId,
      ...(agentType ? { agentType } : {}),
      subAgentStartedAt: new Date().toISOString(),
      ...(policy.timeoutMs !== undefined ? { subAgentTimeoutMs: policy.timeoutMs } : {}),
      ...(policy.maxTurns !== undefined ? { subAgentMaxTurns: policy.maxTurns } : {}),
      ...(parent.agentRuntime !== 'kernel' ? { externalSessionId: childSessionId } : {}),
      ...(parent.workspaceId ? { workspaceId: parent.workspaceId } : {}),
      ...(parent.workspaceName ? { workspaceName: parent.workspaceName } : {}),
      ...(parent.organizationId ? { organizationId: parent.organizationId } : {}),
      ...(parent.principal ? { principal: parent.principal } : {}),
      ...(parent.organizationRole ? { organizationRole: parent.organizationRole } : {}),
      ...(preferredChildReplicaId ? { preferredChildReplicaId } : {}),
      ...(parent.state.cwd ? { initialCwd: parent.state.cwd } : {}),
      initialApprovalMode: 'allow_all',
    }, effect.callId, prompt, maxFanOut)
    if (preferredChildReplicaId) {
      const firstCommand = (await inbox.readChildCommands(parent.sessionId, child.sessionId))
        .find((item) => item.commandId === effect.callId && item.kind === 'message')
      if (!firstCommand?.dispatchedAt) await deps.handoffChildOwner!(child.sessionId, preferredChildReplicaId)
    }
    if (!existing) {
      await options.onChildCreated?.(child)
      await persistSubAgentPolicyArtifact(deps, parent, child.sessionId, effect.callId, policy)
      deps.broadcast.onSubAgentStarted?.({
        parentSessionId: parent.sessionId, parentCallId: effect.callId, childSessionId: child.sessionId,
        ...(agentType ? { agentType } : {}), ...(policy.intention ? { intention: policy.intention } : {}),
        prompt, startedAt: child.subAgentStartedAt ?? new Date().toISOString(),
      })
    }
    const inspect = async (): Promise<{ ok: boolean; content: string } | undefined> => {
      const command = (await inbox.readChildCommands(parent.sessionId, child.sessionId))
        .find((item) => item.commandId === effect.callId && item.kind === 'message')
      if (!command) return { ok: false, content: 'UNKNOWN: child exists without its initial durable command; do not replay' }
      if (command.message !== prompt) return { ok: false, content: 'Child call identity conflicts with a different prompt' }
      if (command.status !== 'completed') return undefined
      if (!command.outcome?.ok) return command.outcome ?? { ok: false, content: 'UNKNOWN: child command has no durable outcome' }
      const final = await deps.store.load(child.sessionId, { recoverDangling: false })
      let answer: string | undefined
      if (final.agentRuntime === 'copilot') {
        const scoped = final.state.messages.filter((message) => message.role === 'assistant'
          && message.metadata?.kind === 'temporal' && message.metadata.turnId === command.commandId)
        const latestUser = final.state.messages.filter((message) => message.role === 'user').at(-1)
        answer = scoped.length ? finalAssistantText({ ...final.state, messages: scoped })
          : latestUser?.metadata?.kind === 'temporal' && latestUser.metadata.turnId === command.commandId
            ? finalAssistantText(final.state) : undefined
      } else {
        const events = await deps.store.readEventEntries(child.sessionId)
        const latestUser = events.filter((entry) => entry.event.kind === 'user_message').at(-1)
        answer = latestUser?.event.kind === 'user_message' && latestUser.event.operationId === command.commandId
          ? finalAssistantText(final.state) : undefined
      }
      if (answer === undefined) {
        return { ok: false, content: 'UNKNOWN: child turn completed but a later turn advanced the transcript; read_agent to inspect the exact result' }
      }
      return okEnvelope(child.sessionId, agentType, answer,
        await deps.store.countCompletedChildModelTurns(child.sessionId, command.commandId),
        Math.max(0, Date.now() - Date.parse(child.subAgentStartedAt ?? '')), policy.intention)
    }
    const completed = await inspect()
    if (completed) return completed
    if (effect.input.mode !== 'background') {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250))
        const outcome = await inspect()
        if (outcome) return outcome
      }
    }
    return runningEnvelope(child.sessionId, agentType,
      `Child command ${effect.callId} is durable but may be UNKNOWN until the child-owner reconciles its turn; read_agent to inspect.`, 0, 0, policy.intention)
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForExternalSubAgent(
  store: SessionStore,
  childSessionId: string,
  active: ActiveSubAgent,
): Promise<void> {
  while (true) {
    if (active.cancelled) {
      await active.runtimeCancellation?.catch(() => undefined)
      return
    }
    const status = store.get(childSessionId)?.state.status
    if (status === 'done' || status === 'error') return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function assistantTurnCount(state: AgentState): number {
  return state.messages.filter((message) => message.role === 'assistant').length
}

async function sharedModelTurnCount(store: SessionStore, childSessionId: string, commands: readonly ChildCommand[]): Promise<number> {
  const counts = await Promise.all(commands.filter((command) => command.kind === 'message' && command.dispatchedAt)
    .map((command) => store.countCompletedChildModelTurns(childSessionId, command.commandId)))
  return counts.reduce((total, count) => total + count, 0)
}

function requestedToolTimeoutMs(state: AgentState): number | undefined {
  if (state.status !== 'executing_tools') return undefined
  let longest = 0
  for (const call of state.pendingCalls) {
    const seconds = typeof call.input.timeout_seconds === 'number' ? call.input.timeout_seconds * 1_000 : 0
    const millis = typeof call.input.timeout_ms === 'number' ? call.input.timeout_ms : 0
    const camelMillis = typeof call.input.timeoutMs === 'number' ? call.input.timeoutMs : 0
    longest = Math.max(longest, seconds, millis, camelMillis)
  }
  return Number.isFinite(longest) && longest > 0 ? longest : undefined
}

function agentTypeOf(effect: CallToolEffect): string | undefined {
  const raw = (effect.input as Record<string, unknown>)['agent_type']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function okEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  resultText: string,
  turns: number,
  durationMs: number,
  intention?: string,
): { ok: true; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'completed', turns, durationMs, intention)
  return {
    ok: true,
    content: `${header}\n<result>\n${escapeEnvelopeBody(resultText)}\n</result>\n</sub_agent>`,
  }
}

function partialTimeoutEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  partial: string,
  reason: TimeoutReason,
  turns: number,
  durationMs: number,
  intention?: string,
): { ok: true; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'timed_out_with_partial_result', turns, durationMs, intention)
  return { ok: true, content: `${header}\n<warning>Sub-agent reached ${reason}; returning verified partial work.</warning>\n<result>\n${escapeEnvelopeBody(partial)}\n</result>\n</sub_agent>` }
}

function failEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  error: string,
  turns: number,
  durationMs: number,
  intention?: string,
): { ok: false; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'failed', turns, durationMs, intention)
  return {
    ok: false,
    content: `${header}\n<error>\n${escapeEnvelopeBody(error)}\n</error>\n</sub_agent>`,
  }
}

function cancelEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  reason: string,
  turns: number,
  durationMs: number,
  intention?: string,
): { ok: false; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'cancelled', turns, durationMs, intention)
  return {
    ok: false,
    content: `${header}\n<error>\n${escapeEnvelopeBody(reason)}\n</error>\n</sub_agent>`,
  }
}

function runningEnvelope(
  childSessionId: string,
  agentType: string | undefined,
  resultText: string,
  turns: number,
  durationMs: number,
  intention?: string,
): { ok: true; content: string } {
  const header = envelopeHeader(childSessionId, agentType, 'running', turns, durationMs, intention)
  return {
    ok: true,
    content: `${header}\n<result>\n${escapeEnvelopeBody(resultText)}\n</result>\n</sub_agent>`,
  }
}

function envelopeHeader(
  childSessionId: string,
  agentType: string | undefined,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out_with_partial_result',
  turns: number,
  durationMs: number,
  intention?: string,
): string {
  const attrs = [
    `session_id="${escapeAttr(childSessionId)}"`,
    ...(agentType ? [`agent_type="${escapeAttr(agentType)}"`] : []),
    ...(intention ? [`intention="${escapeAttr(intention)}"`] : []),
    `status="${status}"`,
    `turns="${turns}"`,
    `duration_ms="${durationMs}"`,
  ]
  return `<sub_agent\n  ${attrs.join('\n  ')}\n>`
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeEnvelopeBody(text: string): string {
  // Escape only `<` and `>` so a child that returns literal HTML/XML doesn't
  // confuse the envelope parser. `&` is preserved so entities the child wrote
  // still render normally when the dashboard unescapes.
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function filteredAgentConfig(
  config: AgentConfig,
  requestedTools: unknown,
): AgentConfig {
  const allowed = Array.isArray(requestedTools)
    ? new Set(requestedTools.filter((t): t is string => typeof t === 'string'))
    : undefined
  const parentOnlyAgentTools = new Set([AGENT_TOOL_NAME, 'write_agent', 'read_agent'])
  return {
    ...config,
    maxAgentDepth: Math.min(config.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH, DEFAULT_MAX_AGENT_DEPTH),
    tools: config.tools.filter((t) => !parentOnlyAgentTools.has(t.name) && (!allowed || allowed.has(t.name))),
  }
}

function finalAssistantText(state: AgentState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]!
    if (msg.role !== 'assistant') continue
    return msg.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim()
  }
  return ''
}

type SettableModelResolver = ModelResolver & {
  set(sessionId: string, model: string): void
  delete(sessionId: string): void
}

function isSettableModelResolver(
  models: ModelResolver | undefined,
): models is SettableModelResolver {
  return Boolean(
    models &&
      typeof (models as SettableModelResolver).set === 'function' &&
      typeof (models as SettableModelResolver).delete === 'function',
  )
}

function readPolicyInput(effect: CallToolEffect, _parentConfig: AgentConfig): SubAgentPolicyInput | undefined {
  const raw = effect.input as Record<string, unknown>
  const roleRaw = raw['role']
  const typeRaw = raw['agent_type']
  const role = isSubAgentRole(roleRaw) ? roleRaw : isSubAgentRole(typeRaw) ? typeRaw : undefined
  const intention = firstNonEmptyString(raw['intention'], raw['objective'], raw['_intent'])
  const explicitAllowed = Array.isArray(raw['tools']) ? (raw['tools'] as unknown[]).filter((tool): tool is string => typeof tool === 'string') : undefined
  const input: SubAgentPolicyInput = {
    ...(role ? { role } : {}),
    ...(intention ? { intention } : {}),
    ...(typeof raw['objective'] === 'string' && raw['objective'].length > 0 ? { objective: raw['objective'] as string } : {}),
    ...(explicitAllowed && explicitAllowed.length > 0 ? { allowedTools: explicitAllowed } : {}),
    ...(typeof raw['max_turns'] === 'number' && Number.isFinite(raw['max_turns']) ? { maxTurns: Math.floor(raw['max_turns'] as number) } : {}),
    ...(typeof raw['timeout_ms'] === 'number' && Number.isFinite(raw['timeout_ms']) ? { timeoutMs: Math.floor(raw['timeout_ms'] as number) } : {}),
    ...(typeof raw['expected_output'] === 'string' && raw['expected_output'].length > 0 ? { expectedOutput: raw['expected_output'] as string } : {}),
  }
  if (Object.keys(input).length === 0 && roleRaw === undefined && typeRaw === undefined) return undefined
  return input
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0 && trimmed.length <= 240 && !/[\r\n]/.test(trimmed)) return trimmed
  }
  return undefined
}

function pickEffectiveTools(
  requestedTools: unknown,
  policyAllowedTools: readonly string[] | undefined,
): readonly string[] | undefined {
  const requested = Array.isArray(requestedTools)
    ? (requestedTools as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined
  if (policyAllowedTools !== undefined) return policyAllowedTools
  return requested
}

async function persistSubAgentPolicyArtifact(
  deps: HostLoopDeps,
  parent: SessionRecord,
  childSessionId: string | undefined,
  parentCallId: string,
  policy: SubAgentPolicy,
): Promise<void> {
  if (!deps.artifactRootDir) return
  try {
    const store = createArtifactStore(deps.artifactRootDir, {
      ...(parent.state.cwd ? { workspaceRoot: parent.state.cwd } : {}),
    })
    const artifact = {
      schemaVersion: 1 as const,
      parentSessionId: parent.sessionId,
      parentCallId,
      ...(childSessionId ? { childSessionId } : {}),
      createdAt: new Date().toISOString(),
      policy,
    }
    await store.writeJson(
      'subagent_policy',
      `subagent-policies/${parent.sessionId}/${parentCallId}.json`,
      artifact,
    )
  } catch {
    // Persistence failures must not break the sub-agent run. The policy is a
    // derived artifact; if the disk is unavailable the sub-agent still runs
    // under the resolved policy in memory.
  }
}

/**
 * Read or await (`wait: true`, `timeout_ms`) a child sub-agent's current status
 * and latest assistant output (`read_agent` tool).
 */
export async function runReadAgentTool(
  deps: HostLoopDeps,
  parentSessionId: string,
  effect: CallToolEffect,
): Promise<{ ok: boolean; content: string }> {
  if (deps.assertSessionEffectOwner || deps.store.usesSharedSessionAuthority()) {
    const inbox = deps.store.childCommandInbox
    const agentId = typeof effect.input.agent_id === 'string' ? effect.input.agent_id.trim() : ''
    if (!inbox || !agentId) return { ok: false, content: 'read_agent requires a durable child inbox and a child agent_id' }
    const timeoutMs = effect.input.wait === true && typeof effect.input.timeout_ms === 'number' && Number.isFinite(effect.input.timeout_ms)
      ? Math.max(10, Math.min(600_000, Math.floor(effect.input.timeout_ms))) : effect.input.wait === true ? 30_000 : 0
    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        const commands = await inbox.readChildCommands(parentSessionId, agentId)
        const child = await deps.store.load(agentId, { recoverDangling: false })
        if (child.parentSessionId !== parentSessionId) return { ok: false, content: 'Child session parent mismatch' }
        const pending = commands.find((command) => command.status !== 'completed')
        const turns = await sharedModelTurnCount(deps.store, agentId, commands)
        const stop = commands.filter((command) => command.kind === 'stop').at(-1)
        const stopStatus = stop
          ? ` Stop ${stop.commandId}: ${stop.status === 'completed' ? stop.outcome?.content ?? 'UNKNOWN' : 'queued; outcome UNKNOWN until acknowledged'}.`
          : ''
        if (stop && !pending) return runningEnvelope(agentId, child.agentType,
          `Child has a durable Stop barrier; no follow-up will be dispatched.${stopStatus}`,
          turns, 0)
        if (!pending) {
          const startedAtMs = child.subAgentStartedAt ? Date.parse(child.subAgentStartedAt) : Date.now()
          if (child.state.status !== 'done' && child.state.status !== 'idle') {
            return runningEnvelope(agentId, child.agentType,
              `Child is ${child.state.status}; no durable terminal result is available.`,
              turns, 0)
          }
          return okEnvelope(agentId, child.agentType, finalAssistantText(child.state),
            turns, Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0)
        }
        if (Date.now() >= deadline) {
          return runningEnvelope(agentId, child.agentType,
            `Child command ${pending.commandId} is ${pending.dispatchedAt ? 'UNKNOWN until durable turn reconciliation' : 'queued'}; no later message may pass it.${stopStatus}`,
            turns, 0)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())))
      }
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) }
    }
  }
  const agentId = typeof effect.input.agent_id === 'string' ? effect.input.agent_id.trim() : ''
  if (!agentId) {
    return { ok: false, content: 'read_agent requires a non-empty `agent_id`' }
  }

  const child = deps.store.get(agentId)
  if (!child || child.parentSessionId !== parentSessionId) {
    return { ok: false, content: `Sub-agent "${agentId}" not found under parent session "${parentSessionId}"` }
  }

  const wait = effect.input.wait === true
  const timeoutMs = typeof effect.input.timeout_ms === 'number' && Number.isFinite(effect.input.timeout_ms)
    ? Math.max(10, Math.min(600_000, Math.floor(effect.input.timeout_ms)))
    : 30_000

  const active = childSubAgentBySessionId.get(agentId)
  if (active && wait && active.completionPromise) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timed = await Promise.race([
      active.completionPromise.then((res) => ({ done: true as const, res })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), timeoutMs)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })

    if (timed.done) {
      return timed.res
    }
  }

  const stillActive = childSubAgentBySessionId.get(agentId)
  const currentChild = deps.store.get(agentId) ?? child
  const state = currentChild.state
  const turns = assistantTurnCount(state)
  const latestText = finalAssistantText(state)

  if (stillActive) {
    const durationMs = Math.max(0, Date.now() - stillActive.startedAt.getTime())
    const progressSummary = latestText
      ? `Latest assistant progress (${turns} turns,queued_steering=${stillActive.steeringQueue.length}):\n${latestText}`
      : `Sub-agent is currently ${state.status} (${turns} turns completed, queued_steering=${stillActive.steeringQueue.length}).`
    return runningEnvelope(
      agentId,
      currentChild.agentType ?? stillActive.agentType,
      progressSummary,
      turns,
      durationMs,
      stillActive.intention,
    )
  }

  const cached = completedSubAgentOutcomes.get(agentId)
  if (cached) {
    return cached.outcome
  }

  const startedAtMs = currentChild.subAgentStartedAt ? Date.parse(currentChild.subAgentStartedAt) : Date.now()
  const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0
  if (state.status === 'done' || state.status === 'idle') {
    return okEnvelope(agentId, currentChild.agentType, latestText, turns, durationMs)
  }
  return failEnvelope(
    agentId,
    currentChild.agentType,
    state.error ?? `sub-agent is in status ${state.status}`,
    turns,
    durationMs,
  )
}

/**
 * Send a live steering message to a running child sub-agent or resume a
 * completed/idle child sub-agent in place with warm context reuse (`write_agent` tool).
 */
export async function runWriteAgentTool(
  deps: HostLoopDeps,
  parentSessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  loop?: LoopHandle,
  runtimeController?: SubAgentRuntimeController,
): Promise<{ ok: boolean; content: string }> {
  if (deps.assertSessionEffectOwner || deps.store.usesSharedSessionAuthority()) {
    const inbox = deps.store.childCommandInbox
    const agentId = typeof effect.input.agent_id === 'string' ? effect.input.agent_id.trim() : ''
    const message = typeof effect.input.message === 'string' ? effect.input.message.trim() : ''
    const child = agentId ? deps.store.get(agentId) ?? await deps.store.load(agentId, { recoverDangling: false }).catch(() => undefined) : undefined
    const parent = deps.store.get(parentSessionId) ?? await deps.store.load(parentSessionId, { recoverDangling: false }).catch(() => undefined)
    if (!inbox || !parent || !child || child.parentSessionId !== parentSessionId || !message) {
      return { ok: false, content: 'write_agent requires an owned parent, its child, and a non-empty message with a durable child inbox' }
    }
    try {
      const existingCommands = await inbox.readChildCommands(parentSessionId, child.sessionId)
      if (existingCommands.some((item) => item.kind === 'stop')) {
        return { ok: false, content: 'Child has a durable Stop barrier; no follow-up message will be dispatched.' }
      }
      if (child.state.status !== 'idle' && child.state.status !== 'done'
        && !existingCommands.some((item) => item.kind === 'message' && item.status !== 'completed')) {
        return { ok: false, content: 'UNKNOWN: running child has no ordered durable turn head; cannot inject live steering safely' }
      }
      const policy = resolveSubAgentPolicy({
        input: { ...readPolicyInput(effect, parent.config), ...(isSubAgentRole(child.agentType) ? { role: child.agentType } : {}) },
        parentTools: child.config.tools.map((tool) => tool.name),
      })
      const command = await inbox.enqueueChildCommand(parentSessionId, child.sessionId, effect.callId, 'message',
        message, parent.config.maxAgentFanOut ?? DEFAULT_MAX_AGENT_FANOUT, {
          ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
          ...(policy.maxTurns !== undefined ? { maxTurns: policy.maxTurns } : {}),
        })
      const outcome = command.status === 'completed' ? command.outcome : undefined
      if (outcome) return outcome
      if (effect.input.mode !== 'background') {
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250))
          const current = (await inbox.readChildCommands(parentSessionId, child.sessionId))
            .find((item) => item.commandId === command.commandId)
          if (current?.status === 'completed' && current.outcome) return current.outcome
        }
      }
      return runningEnvelope(child.sessionId, child.agentType,
        `Child command ${command.commandId} accepted by the durable inbox; delivery may still be unknown. Use read_agent to inspect the child.`,
        await sharedModelTurnCount(deps.store, child.sessionId, existingCommands), 0)
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) }
    }
  }
  const agentId = typeof effect.input.agent_id === 'string' ? effect.input.agent_id.trim() : ''
  if (!agentId) {
    return { ok: false, content: 'write_agent requires a non-empty `agent_id`' }
  }
  const message = typeof effect.input.message === 'string' ? effect.input.message.trim() : ''
  if (!message) {
    return { ok: false, content: 'write_agent requires a non-empty `message`' }
  }
  const mode = effect.input.mode === 'background' ? 'background' : 'sync'

  const child = deps.store.get(agentId)
  if (!child || child.parentSessionId !== parentSessionId) {
    return { ok: false, content: `Sub-agent "${agentId}" not found under parent session "${parentSessionId}"` }
  }

  // Case 1: Child sub-agent is currently running -> queue incremental steering message!
  const active = childSubAgentBySessionId.get(agentId)
  if (active) {
    active.steeringQueue.push(message)
    if (mode === 'background' || !active.completionPromise) {
      const state = child.state
      const turns = assistantTurnCount(state)
      const durationMs = Math.max(0, Date.now() - active.startedAt.getTime())
      return runningEnvelope(
        agentId,
        child.agentType ?? active.agentType,
        `Queued live steering message (#${active.steeringQueue.length}) for running sub-agent "${agentId}".`,
        turns,
        durationMs,
        active.intention,
      )
    }
    return await active.completionPromise
  }

  // Case 2: Child sub-agent is resting (done / idle / error) -> resume in place with warm context!
  const parent = deps.store.get(parentSessionId)
  if (!parent) return { ok: false, content: 'parent session not found' }
  const maxFanOut = parent.config.maxAgentFanOut ?? DEFAULT_MAX_AGENT_FANOUT
  const admission = reserveSubAgentSlot(parentSessionId, effect.callId, maxFanOut)
  if (!admission.admitted) {
    return failEnvelope(
      agentId,
      child.agentType,
      `agent fan-out exceeded: ${admission.concurrentSiblingCount} live siblings >= max ${maxFanOut}`,
      assistantTurnCount(child.state),
      0,
    )
  }

  const startedAt = new Date()
  const priorOutcome = completedSubAgentOutcomes.get(agentId)
  const intention = firstNonEmptyString(effect.input.intention, priorOutcome?.intention, effect.input._intent)
  const policy = resolveSubAgentPolicy({
    input: { ...readPolicyInput(effect, parent.config), ...(isSubAgentRole(child.agentType) ? { role: child.agentType } : {}) },
    parentTools: child.config.tools.map((tool) => tool.name),
  })
  const resumedActive: ActiveSubAgent = {
    store: deps.store,
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
    ...(intention !== undefined ? { intention } : {}),
    startedAt,
    cancelled: false,
    steeringQueue: [],
    ...(child.agentRuntime !== 'kernel' && runtimeController
      ? { cancelRuntime: async () => await runtimeController.cancel(child) }
      : {}),
  }
  activeSubAgents.set(activeKey(parentSessionId, effect.callId), resumedActive)
  childSubAgentBySessionId.set(child.sessionId, resumedActive)
  releaseSubAgentSlot(parentSessionId, effect.callId)

  deps.broadcast.onSubAgentStarted?.({
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
    ...(intention !== undefined ? { intention } : {}),
    prompt: message,
    startedAt: startedAt.toISOString(),
  })

  const runResumedLifecycle = async (): Promise<{ ok: boolean; content: string }> => {
    const baselineTurns = assistantTurnCount(child.state)
    const timeoutMonitor = startSubAgentTimeoutMonitor(
      deps, aborts, resumedActive, policy, baselineTurns, loop,
    )
    let dispatchError: string | undefined
    try {
      const dispatchPromptToChild = async (text: string): Promise<void> => {
        if (child.agentRuntime !== 'kernel') {
          if (!runtimeController) throw new Error(`${child.agentRuntime} sub-agent runtime is unavailable`)
          await runtimeController.send(child, text)
          await waitForExternalSubAgent(deps.store, child.sessionId, resumedActive)
        } else {
          if (loop) await loop.dispatch(child.sessionId, { kind: 'user_message', text })
          else await dispatchOne(deps, child.sessionId, { kind: 'user_message', text }, aborts)
        }
      }

      if (!resumedActive.cancelled) {
        await dispatchPromptToChild(message)
        while (!resumedActive.cancelled && resumedActive.steeringQueue.length > 0) {
          const nextSteering = resumedActive.steeringQueue.shift()!
          await dispatchPromptToChild(nextSteering)
        }
      }
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err)
    } finally {
      timeoutMonitor.stop()
    }

    const finishedAt = new Date()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const final = deps.store.get(child.sessionId)?.state
    const turns = final ? assistantTurnCount(final) : 0

    let outcome: { ok: boolean; content: string }
    if (resumedActive.cancelled) {
      const error = resumedActive.cancelReason ?? 'sub-agent interrupted'
      const timeoutReason = timeoutMonitor.result()
      const partial = final && turns > baselineTurns ? finalAssistantText(final) : ''
      deps.broadcast.onSubAgentFinished?.({
        parentSessionId,
        parentCallId: effect.callId,
        childSessionId: child.sessionId,
        status: timeoutReason ? (partial ? 'timed_out_with_partial_result' : 'failed') : 'cancelled',
        turns,
        durationMs,
        finishedAt: finishedAt.toISOString(),
        error,
      })
      outcome = timeoutReason && partial
        ? partialTimeoutEnvelope(child.sessionId, child.agentType, partial, timeoutReason, turns, durationMs, intention)
        : timeoutReason
          ? failEnvelope(child.sessionId, child.agentType, `timeout: ${error}`, turns, durationMs, intention)
          : cancelEnvelope(child.sessionId, child.agentType, error, turns, durationMs, intention)
    } else if (dispatchError || !final || final.status !== 'done') {
      const error = dispatchError ?? final?.error ?? `agent ended with status ${final?.status ?? 'unknown'}`
      deps.broadcast.onSubAgentFinished?.({
        parentSessionId,
        parentCallId: effect.callId,
        childSessionId: child.sessionId,
        status: 'failed',
        turns,
        durationMs,
        finishedAt: finishedAt.toISOString(),
        error,
      })
      outcome = failEnvelope(child.sessionId, child.agentType, error, turns, durationMs, intention)
    } else {
      deps.broadcast.onSubAgentFinished?.({
        parentSessionId,
        parentCallId: effect.callId,
        childSessionId: child.sessionId,
        status: 'completed',
        turns,
        durationMs,
        finishedAt: finishedAt.toISOString(),
      })
      outcome = okEnvelope(child.sessionId, child.agentType, finalAssistantText(final), turns, durationMs, intention)
    }

    resumedActive.latestOutcome = outcome
    completedSubAgentOutcomes.set(child.sessionId, {
      parentSessionId,
      parentCallId: effect.callId,
      childSessionId: child.sessionId,
      ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
      ...(intention !== undefined ? { intention } : {}),
      outcome,
    })
    activeSubAgents.delete(activeKey(parentSessionId, effect.callId))
    childSubAgentBySessionId.delete(child.sessionId)
    return outcome
  }

  const executionPromise = runResumedLifecycle()
  resumedActive.completionPromise = executionPromise

  if (mode === 'background') {
    return runningEnvelope(
      child.sessionId,
      child.agentType,
      `Sub-agent resumed in background. Use read_agent { agent_id: "${child.sessionId}", wait: true } to await completion.`,
      assistantTurnCount(child.state),
      0,
      intention,
    )
  }

  return await executionPromise
}
