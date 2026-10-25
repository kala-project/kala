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
import type { HostLoopDeps, LoopHandle, ModelResolver } from '../loop-types.js'
import { dispatchOne } from '../loop.js'

const DEFAULT_MAX_AGENT_DEPTH = 1
const DEFAULT_MAX_AGENT_FANOUT = 8
export const AGENT_TOOL_NAME = 'agent'

type ActiveSubAgent = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  agentType?: string
  startedAt: Date
  cancelled: boolean
  cancelReason?: string
  runtimeCancellation?: Promise<{ ok: true; childSessionId: string }>
  cancelRuntime?: () => Promise<void>
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
): Promise<{ ok: boolean; childSessionId?: string; error?: string }> {
  const marked = markSubAgentInterrupted(parentSessionId, parentCallId, childSessionId, reason)
  if (!marked.ok) return marked
  const active = activeSubAgentFor(parentSessionId, parentCallId)
  if (active?.cancelRuntime) {
    const cancellation = (async () => {
      await interruptSubAgentsForParent(deps, aborts, marked.childSessionId, reason)
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
    await dispatchOne(deps, marked.childSessionId, { kind: 'cancel' }, aborts)
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
): Promise<void> {
  for (const active of activeSubAgentsForParent(parentSessionId)) {
    await interruptSubAgent(deps, aborts, active.parentSessionId, active.parentCallId, active.childSessionId, reason)
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
      parentSessionId,
      parentCallId: effect.callId,
      childSessionId: child.sessionId,
      ...(agentType !== undefined ? { agentType } : {}),
      startedAt,
      cancelled: false,
      ...(parent.agentRuntime !== 'kernel' && runtimeController
        ? { cancelRuntime: async () => await runtimeController.cancel(child) }
        : {}),
    }
    activeSubAgents.set(activeKey(parentSessionId, effect.callId), active)
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

  const priorModel = model ? deps.models?.get(child.sessionId) : undefined
  if (model && isSettableModelResolver(deps.models)) {
    deps.models.set(child.sessionId, model)
  }
  let timedOut = false
  let timeoutReason: TimeoutReason | undefined
  const startedAtMs = startedAt.getTime()
  const initialState = deps.store.get(child.sessionId)?.state ?? child.state
  let timeoutMonitor: TimeoutMonitor = {
    last: { cursor: initialState.cursor, status: initialState.status },
    lastActivityAt: startedAtMs,
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const scheduleTimeoutMonitor = (): void => {
    timeoutHandle = setTimeout(monitorTimeout, 1_000)
    timeoutHandle.unref?.()
  }
  const monitorTimeout = (): void => {
    const state = deps.store.get(child.sessionId)?.state
    if (active.cancelled || state?.status === 'done' || state?.status === 'error') return
    if (!state) {
      scheduleTimeoutMonitor()
      return
    }
    const evaluated = evaluateSubAgentTimeout({
      now: Date.now(),
      startedAt: startedAtMs,
      observation: {
        cursor: state.cursor,
        status: state.status,
        ...(state.status === 'executing_tools' ? { requestedToolTimeoutMs: requestedToolTimeoutMs(state) } : {}),
      },
      monitor: timeoutMonitor,
      idleTimeoutMs: policy.idleTimeoutMs!,
      toolIdleTimeoutMs: policy.toolIdleTimeoutMs!,
      absoluteTimeoutMs: policy.timeoutMs!,
      gracePeriodMs: policy.gracePeriodMs!,
      turnCount: assistantTurnCount(state),
      maxTurns: policy.maxTurns,
    })
    timeoutMonitor = evaluated.monitor
    if (evaluated.action !== 'cancel' || timedOut) {
      scheduleTimeoutMonitor()
      return
    }
    timedOut = true
    timeoutReason = evaluated.reason
    void interruptSubAgent(
      deps,
      aborts,
      parentSessionId,
      effect.callId,
      child.sessionId,
      `sub-agent ${timeoutReason ?? 'timeout'} exceeded; absoluteTimeoutMs=${policy.timeoutMs}; idleTimeoutMs=${policy.idleTimeoutMs}; toolIdleTimeoutMs=${policy.toolIdleTimeoutMs}; gracePeriodMs=${policy.gracePeriodMs}`,
    )
  }
  scheduleTimeoutMonitor()
  let dispatchError: string | undefined
  try {
    try {
      if (!active.cancelled) {
        if (child.agentRuntime !== 'kernel') {
          if (!runtimeController) throw new Error(`${child.agentRuntime} sub-agent runtime is unavailable`)
          await runtimeController.send(child, prompt, model)
          await waitForExternalSubAgent(deps.store, child.sessionId, active)
        } else {
          // Join the child to the same Loop actor when available. This preserves
          // per-Session serialization and lets an idle restart drain observe the
          // child's terminal transition. Direct dispatchOne() bypassed the Loop's
          // checkpoint notification channel and could deadlock a deployment.
          if (loop) await loop.dispatch(child.sessionId, { kind: 'user_message', text: prompt })
          else await dispatchOne(deps, child.sessionId, { kind: 'user_message', text: prompt }, aborts)
        }
      }
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err)
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (model && isSettableModelResolver(deps.models)) {
        if (priorModel) deps.models.set(child.sessionId, priorModel)
        else deps.models.delete(child.sessionId)
      }
    }
  } finally {
    activeSubAgents.delete(activeKey(parentSessionId, effect.callId))
  }
  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const final = deps.store.get(child.sessionId)?.state
  const turns = final ? assistantTurnCount(final) : 0

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
    return timedOut && partial
      ? partialTimeoutEnvelope(child.sessionId, agentType, partial, timeoutReason ?? 'absolute-deadline', turns, durationMs, intention)
      : timedOut
        ? failEnvelope(child.sessionId, agentType, `timeout: ${error}`, turns, durationMs, intention)
        : cancelEnvelope(child.sessionId, agentType, error, turns, durationMs, intention)
  }

  if (dispatchError || !final || final.status !== 'done') {
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
    return failEnvelope(child.sessionId, agentType, error, turns, durationMs, intention)
  }

  deps.broadcast.onSubAgentFinished?.({
    parentSessionId,
    parentCallId: effect.callId,
    childSessionId: child.sessionId,
    status: 'completed',
    turns,
    durationMs,
    finishedAt: finishedAt.toISOString(),
  })
  return okEnvelope(child.sessionId, agentType, finalAssistantText(final), turns, durationMs, intention)
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

function envelopeHeader(
  childSessionId: string,
  agentType: string | undefined,
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out_with_partial_result',
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
  return {
    ...config,
    maxAgentDepth: Math.min(config.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH, DEFAULT_MAX_AGENT_DEPTH),
    tools: config.tools.filter((t) => t.name !== AGENT_TOOL_NAME && (!allowed || allowed.has(t.name))),
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
