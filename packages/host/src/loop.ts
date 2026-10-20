/**
 * The host loop.
 *
 * The kernel is a pure function. The host loop is the impure driver: it
 *   1. calls `step(state, event, config)` for every incoming event,
 *   2. persists the event to the JSONL log,
 *   3. broadcasts state/event changes to Socket.IO subscribers,
 *   4. inspects the returned effects and *performs* them (LLM call, tool
 *      dispatch, approval request, finish, error), which may produce new
 *      events that feed back into (1).
 *
 * `dispatchOne` is exported so sibling modules (`compaction.ts`,
 * `agent-tool.ts`) can dispatch synthesised events back through the same
 * loop without needing a public wrapper — everything downstream sees a
 * uniform record → step → persist → broadcast → effect fan-out cycle.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  CallLlmEffect,
  CallToolEffect,
  EmitErrorEffect,
  FinishEffect,
  RequestApprovalEffect,
  Effect,
  Message,
} from '@agent-kernel/kernel'
import { step } from '@agent-kernel/kernel'

import { TOOL_INTENTION_SYSTEM_INSTRUCTION } from './builtin-tools.js'
import { activeToolsFor } from './extensions/tool-catalog.js'
import { intentActivatedTools, toolCatalogRevision, visibleTools } from './tool-disclosure.js'
import { TurnTimingTracker, timedSpan } from './turn-timing.js'
import type { LLMAdapter } from './llm/adapter.js'
import { redactLlmTrace, type LLMTrace } from '@agent-kernel/shared'
import { estimateMessageTokens, estimateStringTokens, estimateToolSchemaTokens } from '@agent-kernel/shared/token-estimation'
import {
  createArtifactStore,
  createMessageAssemblyArtifact,
  createRouterDecisionArtifact,
  createToolCatalogArtifact,
  type MessageAssemblyStage,
} from '@agent-kernel/shared/enhancement'
import type { SessionRecord } from './store/session.js'
import { maybeAutoCompact } from './extensions/compaction.js'
import { isCancelledSubAgentChild, type SubAgentRuntimeController } from './extensions/agent-tool.js'
import { createBuiltinExtensionRegistry } from './extensions/builtin-registry.js'
import { todoGraphContinuationState } from './extensions/todo-graph.js'
import { dispatchConfiguredTool, type ToolExecutionResult } from './agent-modules/execution.js'
import { resolveKernelMessageAttachments } from './message-attachment-resolver.js'
import type {
  HostLoopDeps,
  EventBroadcastExtras,
  LoopDrainMode,
  LoopDrainSessionSnapshot,
  LoopHandle,
  LoopRuntime,
  PostCompactionLoopGuard,
} from './loop-types.js'

// Re-export the loop's type surface so existing consumers that import these
// from `./loop.js` keep resolving. The definitions live in the leaf module
// `loop-types.ts` (see the note there) to keep extensions off `loop.ts`.
export type {
  DispatchOptions,
  HostLoopDeps,
  LlmQuotaEnforcer,
  LoopBroadcast,
  TenantModelPolicyEnforcer,
  EventBroadcastExtras,
  LoopHandle,
  LoopRuntime,
  ModelResolver,
  PostCompactionLoopGuard,
  SubAgentFinishedPayload,
  SubAgentStartedPayload,
  ToolDispatcher,
} from './loop-types.js'

export async function dispatchRuntimeTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  turnId?: string,
  loop?: LoopHandle,
  plannedContinuation = false,
  runtimeController?: SubAgentRuntimeController,
): Promise<ToolExecutionResult> {
  const extensions = deps.extensions ?? createBuiltinExtensionRegistry()
  const context = {
    deps,
    sessionId,
    effect,
    aborts,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(loop !== undefined ? { loop } : {}),
    plannedContinuation,
    ...(runtimeController !== undefined ? { runtimeController } : {}),
  }
  const memoryPolicyBlock = guardMemoryPolicy(deps, sessionId, effect)
  if (memoryPolicyBlock) return { ok: false, content: memoryPolicyBlock }

  await deps.assertSessionEffectOwner?.(sessionId)
  const blocked = await extensions.beforeToolDispatch(context)
  if (blocked) return blocked
  // Extension hooks may await network work while another replica takes over.
  await deps.assertSessionEffectOwner?.(sessionId)

  const result = await dispatchConfiguredTool(
    deps,
    sessionId,
    effect,
    aborts,
    turnId,
    loop,
    plannedContinuation,
    runtimeController,
  )
  await extensions.afterToolDispatch(context, result)
  return result
}

export function runHostLoop(deps: HostLoopDeps): LoopHandle {
  // Per-session guard so an auto-compact triggered by a hard-tier state
  // change can't fire again while the summarizer LLM call is still in flight.
  // Also blocks user-triggered `/compact` from stacking on top of an
  // in-flight compaction.
  const compactionInFlight = new Set<string>()

  // Per-session AbortController for the currently in-flight LLM call.
  // `cancelStream` aborts it; `performCallLlm` installs a fresh one at the
  // start of every call and clears it on completion.
  const inFlightAborts = new Map<string, AbortController>()
  const inFlightTools = new Map<string, Set<string>>()
  const sessionTails = new Map<string, Promise<void>>()
  const recoveries = new Map<string, Promise<boolean>>()
  // Cancellation must abort I/O immediately, but its state transition still has
  // to join the per-session serialized tail. Dispatching cancel directly used
  // to race concurrent cancel clicks/reconnects: every reducer read the same
  // cursor and persisted duplicate sequence numbers.
  const pendingCancels = new Map<string, Promise<void>>()
  // Explicit Stop fences every continuation/effect already produced by the
  // cancelled turn until a later user_message intentionally starts new work.
  const explicitStopSessions = new Set<string>()
  const loopGuard = new Map<string, PostCompactionLoopGuard>()
  // At most one recovery continuation per durable todo_graph revision. The
  // graph must advance before another terminal reply can be auto-resumed,
  // preventing a broken model from hot-looping forever.
  const graphContinuationRevision = new Map<string, number>()
  let effectsStopped = false
  let drainMode: LoopDrainMode = 'none'
  // Per-session "stop at next safe boundary" flags (steer's polite interrupt).
  // A flagged session lets its in-flight LLM response + tools finish, then the
  // loop stops before the next autonomous think and settles to rest, at which
  // point the flag self-clears and the front-queued steer message dispatches.
  const steerStopSessions = new Set<string>()
  const checkpointWaiters = new Map<string, Set<(snapshot: LoopDrainSessionSnapshot) => void>>()

  const notifyCheckpoint = (sessionId: string): void => {
    const waiters = checkpointWaiters.get(sessionId)
    const snapshot = drainSnapshotFor(deps, sessionId, inFlightAborts, inFlightTools, compactionInFlight, sessionTails, drainMode)
    // A steer stop self-clears once the session has settled to a safe boundary
    // (no in-flight LLM/tools), so the next turn — the front-queued steer
    // message — runs normally.
    if (snapshot.safe) steerStopSessions.delete(sessionId)
    if (!waiters || waiters.size === 0) return
    if (!snapshot.safe) return
    checkpointWaiters.delete(sessionId)
    for (const resolve of waiters) resolve(snapshot)
  }

  const maybeResumeDurableGraphWork = async (sessionId: string, cause: AgentEvent): Promise<void> => {
    if (cause.kind === 'cancel' || cause.kind === 'clear' || explicitStopSessions.has(sessionId)) return
    // A durable graph means the user explicitly requested autonomous progress.
    // A plain assistant `stop` while work remains is therefore a recoverable
    // premature terminal boundary, including the boundary produced immediately
    // after automatic compaction.
    for (let attempts = 0; attempts < 32; attempts += 1) {
      const record = deps.store.get(sessionId)
      if (!record || (record.state.status !== 'done' && record.state.status !== 'idle')) return
      const graph = await todoGraphContinuationState(deps, sessionId)
      if (!graph.needsContinuation) return
      if (graphContinuationRevision.get(sessionId) === graph.revision) return
      graphContinuationRevision.set(sessionId, graph.revision)
      await dispatchOne(deps, sessionId, {
        kind: 'messages_replaced',
        reason: 'recovery',
        replaceRange: { start: 0, end: 0 },
        replacementMessages: [],
        resume: true,
      }, inFlightAborts, undefined, undefined, {
        handle,
        loopGuard,
        drain: () => drainMode,
        steerStop: () => steerStopSessions.has(sessionId),
        stopRequested: () => effectsStopped || explicitStopSessions.has(sessionId),
        toolStarted: markToolStarted,
        toolSettled: markToolSettled,
      }, notifyCheckpoint)
    }
  }

  const handle: LoopHandle = {
    abortActiveEffects() {
      // Cancel immediately before shutdown waits on queues. A destination that
      // ignores cancellation must independently deduplicate external effects.
      if (effectsStopped) return
      effectsStopped = true
      for (const controller of inFlightAborts.values()) controller.abort()
      for (const sessionId of inFlightTools.keys()) {
        try { void Promise.resolve(deps.tools.cancelPending(sessionId)).catch(() => undefined) } catch { /* closing */ }
      }
    },
    async dispatch(sessionId, event, options) {
      if (effectsStopped && event.kind !== 'cancel') throw new Error('Unit is closing; effects are stopped')
      if (event.kind === 'user_message' || event.kind === 'clear') explicitStopSessions.delete(sessionId)
      if (event.kind === 'cancel' && !options?.internalBoundaryCancel) explicitStopSessions.add(sessionId)
      if (drainMode !== 'none' && event.kind !== 'cancel') {
        if (event.kind === 'user_message') {
          throw new Error('host restart is draining; new user messages are paused')
        }
      }
      if (event.kind === 'cancel') {
        // An explicit Stop supersedes any pending polite steer boundary. Leaving
        // this flag set lets the cancelled turn's cleanup schedule another cancel
        // and can immediately restart a front-queued steer.
        steerStopSessions.delete(sessionId)
        // Cancel cannot wait behind the active turn: that turn may itself be
        // blocked on the tool/LLM we need to abort. Coalesce concurrent clicks,
        // and ignore stale repeats once the reducer has already reached rest.
        const existing = pendingCancels.get(sessionId)
        if (existing) return await existing
        const status = deps.store.get(sessionId)?.state.status
        if (status === 'idle' || status === 'done' || status === 'error') {
          // Preserve the public cancellation contract without polluting the
          // event log/cursor with a reducer no-op.
          await deps.tools.cancelPending(sessionId)
          return
        }
        const cancel = dispatchOne(deps, sessionId, event, inFlightAborts, undefined, undefined, undefined, notifyCheckpoint)
          .finally(() => {
            if (pendingCancels.get(sessionId) === cancel) pendingCancels.delete(sessionId)
            notifyCheckpoint(sessionId)
          })
        pendingCancels.set(sessionId, cancel)
        await cancel
        return
      }
      const prior = sessionTails.get(sessionId) ?? Promise.resolve()
      const next = prior
        .catch(() => {})
        .then(async () => {
          const lifecycleContext = {
            deps,
            sessionId,
            event,
            loop: handle,
            autoCompact: async () => {
              if (drainMode === 'none') await maybeAutoCompact(deps, sessionId, compactionInFlight, handle)
            },
            resumeDurableWork: async () => {
              if (drainMode === 'none') await maybeResumeDurableGraphWork(sessionId, event)
            },
          }
          await (deps.extensions ?? createBuiltinExtensionRegistry()).beforeTurn(lifecycleContext)
          await dispatchOne(deps, sessionId, event, inFlightAborts, undefined, undefined, {
            handle,
            loopGuard,
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.onCommitted ? { onCommitted: options.onCommitted } : {}),
            drain: () => drainMode,
            steerStop: () => steerStopSessions.has(sessionId),
            stopRequested: () => effectsStopped || explicitStopSessions.has(sessionId),
            toolStarted: markToolStarted,
            toolSettled: markToolSettled,
          }, notifyCheckpoint)
          await (deps.extensions ?? createBuiltinExtensionRegistry()).afterTurn(lifecycleContext)
        })
        .finally(() => {
          if (sessionTails.get(sessionId) === next) sessionTails.delete(sessionId)
          notifyCheckpoint(sessionId)
        })
      sessionTails.set(sessionId, next)
      await next
    },
    async compact(sessionId, request) {
      if (drainMode !== 'none') return false
      const replaced = await (deps.extensions ?? createBuiltinExtensionRegistry())
        .compact(deps, sessionId, request, compactionInFlight, inFlightAborts)
      notifyCheckpoint(sessionId)
      if (replaced && request.trigger !== 'tool_result') {
        loopGuard.set(sessionId, {
          remainingCalls: POST_COMPACTION_GUARD_CALLS,
          seen: new Map(),
        })
      }
      return replaced
    },
    cancelStream(sessionId) {
      const ctrl = inFlightAborts.get(sessionId)
      if (ctrl) ctrl.abort()
    },
    requestStopAtBoundary(sessionId) {
      const snapshot = drainSnapshotFor(deps, sessionId, inFlightAborts, inFlightTools, compactionInFlight, sessionTails, 'checkpoint')
      if (snapshot.safe) return
      steerStopSessions.add(sessionId)
    },
    hasActiveLlmCall(sessionId) {
      return inFlightAborts.has(sessionId)
    },
    hasActiveTurn(sessionId) {
      return sessionTails.has(sessionId)
    },
    async waitForActiveTurn(sessionId) {
      await (sessionTails.get(sessionId) ?? Promise.resolve()).catch(() => {})
    },
    async waitForQuiescence() {
      while (sessionTails.size > 0) await Promise.allSettled([...sessionTails.values()])
    },
    async recoverInterruptedLlm(sessionId) {
      return await handle.ensureSessionResumed(sessionId)
    },
    async ensureSessionResumed(sessionId) {
      const existing = recoveries.get(sessionId)
      if (existing) return await existing
      const recovery = (async (): Promise<boolean> => {
        if (explicitStopSessions.has(sessionId) || drainMode !== 'none' || sessionTails.has(sessionId) || inFlightAborts.has(sessionId)) return false
        const record = deps.store.get(sessionId) ?? await deps.store.load(sessionId, { recoverDangling: false }).catch(() => undefined)
        if (!record) return false
        if (record.state.status === 'thinking' && record.state.pendingCalls.length === 0) {
          await dispatchOne(deps, sessionId, interruptedLlmRecoveryEvent(), inFlightAborts, undefined, undefined, {
            handle,
            loopGuard,
            drain: () => drainMode,
            steerStop: () => steerStopSessions.has(sessionId),
            stopRequested: () => effectsStopped || explicitStopSessions.has(sessionId),
            toolStarted: markToolStarted,
            toolSettled: markToolSettled,
          }, notifyCheckpoint)
          return true
        }
        if (record.state.status !== 'executing_tools' || record.state.pendingCalls.length === 0) {
          return await (deps.extensions ?? createBuiltinExtensionRegistry()).recoverSession({ deps, sessionId, loop: handle })
        }
        // An owner takeover cannot distinguish an accepted external tool from
        // one that merely lost its result. Never replay either on another node;
        // the user/operator must reconcile and explicitly cancel or retry.
        if (deps.assertSessionEffectOwner) return false
        const effects = record.state.pendingCalls
          .filter((call) => call.status === 'approved' || call.status === 'dispatched')
          .map((call) => ({
            kind: 'call_tool' as const,
            callId: call.callId,
            name: call.name,
            input: call.input,
            ...(record.state.cwd !== undefined ? { cwd: record.state.cwd } : {}),
          }))
        if (effects.length === 0) {
          return await (deps.extensions ?? createBuiltinExtensionRegistry()).recoverSession({ deps, sessionId, loop: handle })
        }
        const resultQueue = createSerialQueue()
        await Promise.all(effects.map((eff) => performCallTool(
          deps, sessionId, eff, inFlightAborts,
          { handle, loopGuard, toolStarted: markToolStarted, toolSettled: markToolSettled },
          resultQueue,
        )))
        return true
      })().finally(() => {
        if (recoveries.get(sessionId) === recovery) recoveries.delete(sessionId)
      })
      recoveries.set(sessionId, recovery)
      return await recovery
    },
    beginDrain(mode) {
      drainMode = mode
      for (const record of deps.store.recordsSnapshot()) notifyCheckpoint(record.sessionId)
    },
    isDraining() {
      return drainMode !== 'none'
    },
    endDrain() {
      drainMode = 'none'
      for (const [sessionId, waiters] of checkpointWaiters) {
        const snapshot = drainSnapshotFor(deps, sessionId, inFlightAborts, inFlightTools, compactionInFlight, sessionTails, drainMode)
        for (const resolve of waiters) resolve(snapshot)
      }
      checkpointWaiters.clear()
    },
    drainSnapshot(sessionId) {
      return drainSnapshotFor(deps, sessionId, inFlightAborts, inFlightTools, compactionInFlight, sessionTails, drainMode)
    },
    async waitForCheckpoint(sessionId) {
      const current = drainSnapshotFor(deps, sessionId, inFlightAborts, inFlightTools, compactionInFlight, sessionTails, drainMode)
      if (current.safe) return current
      return await new Promise<LoopDrainSessionSnapshot>((resolve) => {
        const waiters = checkpointWaiters.get(sessionId) ?? new Set()
        waiters.add(resolve)
        checkpointWaiters.set(sessionId, waiters)
      })
    },
    async resumeSession(sessionId, options) {
      // Local checkpoint resume is safe only for exclusive process ownership.
      // Another node may have already issued a model call or external tool.
      if (deps.assertSessionEffectOwner) return await handle.ensureSessionResumed(sessionId)
      const existing = recoveries.get(sessionId)
      if (existing) return await existing
      const recovery = (async (): Promise<boolean> => {
        if (explicitStopSessions.has(sessionId) || drainMode !== 'none' || sessionTails.has(sessionId) || inFlightAborts.has(sessionId)) return false
        const record = deps.store.get(sessionId) ?? await deps.store.load(sessionId, { recoverDangling: false }).catch(() => undefined)
        if (!record) return false
        const runtime: LoopRuntime = {
          handle,
          loopGuard,
          plannedContinuation: true,
          drain: () => drainMode,
          steerStop: () => steerStopSessions.has(sessionId),
          stopRequested: () => effectsStopped || explicitStopSessions.has(sessionId),
          toolStarted: markToolStarted,
          toolSettled: markToolSettled,
        }
        if (record.state.status === 'thinking' && record.state.pendingCalls.length === 0) {
          await options?.onStarted?.()
          await performCallLlm(deps, sessionId, record.config, {
            kind: 'call_llm',
            messages: record.state.messages,
            tools: record.config.tools,
          }, inFlightAborts, runtime)
          return true
        }
        if (record.state.status !== 'executing_tools' || record.state.pendingCalls.length === 0) return false
        const effects = record.state.pendingCalls
          .filter((call) => call.status === 'approved' || call.status === 'dispatched')
          .map((call) => ({
            kind: 'call_tool' as const,
            callId: call.callId,
            name: call.name,
            input: call.input,
            ...(record.state.cwd !== undefined ? { cwd: record.state.cwd } : {}),
          }))
        if (effects.length === 0) return false
        await options?.onStarted?.()
        const resultQueue = createSerialQueue()
        await Promise.all(effects.map((effect) => performCallTool(deps, sessionId, effect, inFlightAborts, runtime, resultQueue)))
        return true
      })().finally(() => {
        if (recoveries.get(sessionId) === recovery) recoveries.delete(sessionId)
      })
      recoveries.set(sessionId, recovery)
      return await recovery
    },
  }

  function markToolStarted(sessionId: string, callId: string): void {
    const calls = inFlightTools.get(sessionId) ?? new Set<string>()
    calls.add(callId)
    inFlightTools.set(sessionId, calls)
  }

  function markToolSettled(sessionId: string, callId: string): void {
    const calls = inFlightTools.get(sessionId)
    if (!calls) return
    calls.delete(callId)
    if (calls.size === 0) inFlightTools.delete(sessionId)
    notifyCheckpoint(sessionId)
  }
  return handle
}

function drainSnapshotFor(
  deps: HostLoopDeps,
  sessionId: string,
  aborts: Map<string, AbortController>,
  tools: Map<string, Set<string>>,
  compactions: Set<string>,
  tails: Map<string, Promise<void>>,
  mode: LoopDrainMode,
): LoopDrainSessionSnapshot {
  const record = deps.store.get(sessionId)
  if (!record) return { sessionId, status: 'missing', safe: true, waiting: 'none', pendingCalls: [] }
  const state = record.state
  if (mode === 'idle') {
    const safe = state.status === 'idle' || state.status === 'done' || state.status === 'error'
    return { sessionId, status: state.status, safe, waiting: safe ? 'none' : 'idle', pendingCalls: state.pendingCalls, cursor: state.cursor }
  }
  if (aborts.has(sessionId)) return { sessionId, status: state.status, safe: false, waiting: 'llm', pendingCalls: state.pendingCalls, cursor: state.cursor }
  if ((tools.get(sessionId)?.size ?? 0) > 0) {
    return { sessionId, status: state.status, safe: false, waiting: 'tool', pendingCalls: state.pendingCalls, cursor: state.cursor }
  }
  if (compactions.has(sessionId)) return { sessionId, status: state.status, safe: false, waiting: 'compaction', pendingCalls: state.pendingCalls, cursor: state.cursor }
  if (tails.has(sessionId)) return { sessionId, status: state.status, safe: false, waiting: 'turn', pendingCalls: state.pendingCalls, cursor: state.cursor }
  const checkpointKind = state.status === 'thinking'
    ? 'before_llm'
    : state.status === 'executing_tools'
      ? 'before_tool_dispatch'
      : state.status === 'awaiting_approval'
        ? 'waiting_for_approval'
        : 'resting'
  return { sessionId, status: state.status, safe: true, waiting: 'none', checkpointKind, pendingCalls: state.pendingCalls, cursor: state.cursor }
}

function interruptedLlmRecoveryEvent(): AgentEvent {
  return {
    kind: 'llm_response',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '[interrupted]' }],
    },
  }
}

type CommittedTransition = {
  record: SessionRecord
  next: AgentState
  effects: readonly Effect[]
}

// Every synthesized event eventually calls dispatchOne. Serialize the short
// read → step → durable append → broadcast section here; effects execute after
// releasing this lock so recursive Tool/LLM events cannot deadlock.
const commitTails = new WeakMap<HostLoopDeps['store'], Map<string, Promise<void>>>()
const timingTrackers = new WeakMap<HostLoopDeps['store'], TurnTimingTracker>()

async function commitTransition(
  deps: HostLoopDeps,
  sessionId: string,
  event: AgentEvent,
  llmTrace?: LLMTrace,
  model?: string,
  extras?: EventBroadcastExtras,
): Promise<CommittedTransition> {
  let tails = commitTails.get(deps.store)
  if (!tails) {
    tails = new Map()
    commitTails.set(deps.store, tails)
  }
  const previous = tails.get(sessionId) ?? Promise.resolve()
  let committed!: CommittedTransition
  const current = previous.catch(() => undefined).then(async () => {
    const record = deps.store.get(sessionId)
    if (!record) throw new Error(`Unknown session: ${sessionId}`)
    if (record.agentRuntime !== 'kernel') {
      throw new Error(`Kernel Loop cannot mutate ${record.agentRuntime} session: ${sessionId}`)
    }
    await (deps.extensions ?? createBuiltinExtensionRegistry()).beforeStateTransition({ deps, record, event })
    const prior = record.state
    const preparedEvent: AgentEvent = event.kind === 'llm_response' && deps.publishLocalImages
      ? { ...event, message: await deps.publishLocalImages(sessionId, record, event.message) }
      : event
    const { next, effects } = step(prior, preparedEvent, record.config)
    const committedEvent: AgentEvent = preparedEvent.kind === 'llm_response'
      ? { ...preparedEvent, message: next.messages.at(-1) ?? preparedEvent.message }
      : preparedEvent
    const safeLlmTrace = llmTrace ? redactLlmTrace(llmTrace) : undefined
    let timingTracker = timingTrackers.get(deps.store)
    if (!timingTracker) { timingTracker = new TurnTimingTracker(); timingTrackers.set(deps.store, timingTracker) }
    if (!timingTracker.has(sessionId) && event.kind !== 'user_message' && (prior.status === 'thinking' || prior.status === 'executing_tools' || prior.status === 'awaiting_approval')) {
      const events = await deps.store.readEventEntries(sessionId).catch(() => undefined)
      if (events) timingTracker.recover(sessionId, events)
    }
    const timing = extras?.timing ?? timingTracker.observe({ sessionId, event: committedEvent, prior, next, effects, ...(extras?.timingSpan ? { span: extras.timingSpan } : {}) })
    const usageChanged =
      next.usage.inputTokens !== prior.usage.inputTokens ||
      next.usage.outputTokens !== prior.usage.outputTokens ||
      next.usage.cacheCreationTokens !== prior.usage.cacheCreationTokens ||
      next.usage.cacheReadTokens !== prior.usage.cacheReadTokens
    await deps.store.record(
      sessionId, committedEvent, effects, next, usageChanged ? next.usage : undefined,
      safeLlmTrace, model, timing,
    )
    safeBroadcast(() =>
      deps.broadcast.onEvent(sessionId, next.cursor, committedEvent, effects, next, safeLlmTrace, model, { ...extras, ...(timing ? { timing } : {}) }),
    )
    committed = { record, next, effects }
  })
  tails.set(sessionId, current)
  try {
    await current
    return committed
  } finally {
    if (tails.get(sessionId) === current) tails.delete(sessionId)
  }
}

export async function dispatchOne(
  deps: HostLoopDeps,
  sessionId: string,
  event: AgentEvent,
  aborts: Map<string, AbortController>,
  llmTrace?: LLMTrace,
  model?: string,
  runtime?: LoopRuntime,
  onCheckpoint?: (sessionId: string) => void,
  extras?: EventBroadcastExtras,
): Promise<void> {
  const { record, next, effects } = await commitTransition(
    deps, sessionId, event, llmTrace, model, extras,
  )
  await runtime?.onCommitted?.(event)

  // Cancellation of in-flight IO is the host's job (SPEC §Non-goals:
  // "Cancellation of in-flight tools — Only handles state — Host cancels
  // IO"). The kernel already dropped pendingCalls; here we tell the
  // executor to stop chewing on the corresponding subprocesses so
  // `tool:cancel` reaches it per wire-protocol §5.2. This runs
  // regardless of whether pending was empty — cancelPending is a no-op
  // in that case, and being unconditional matches the spec's "cancel
  // means stop everything now" contract. Runs before effect fan-out so
  // even if a stray call_llm/call_tool effect appeared it wouldn't race
  // against a still-live executor.
  if (event.kind === 'cancel') {
    await (deps.extensions ?? createBuiltinExtensionRegistry()).cancel({ deps, aborts, sessionId })
    deps.askUserChoice?.cancelSession(sessionId)
    await deps.tools.cancelPending(sessionId)
    const inFlight = aborts.get(sessionId)
    if (inFlight) inFlight.abort()
  }

  // Preserve a concurrently committed response/result as history, but do not
  // fan out any new LLM or Tool effect after the user explicitly stopped.
  if (event.kind !== 'cancel' && runtime?.stopRequested?.()) {
    onCheckpoint?.(sessionId)
    return
  }

  if (shouldStopForDrain(event, effects, runtime)) {
    onCheckpoint?.(sessionId)
    // Steer's polite stop reaches this boundary with the in-flight response +
    // tools already finished and a fresh continuation `call_llm` suppressed, so
    // the kernel status is a dangling `thinking`. Settle it to a resting status
    // (via the same terminal `cancel` primitive, which here has nothing in
    // flight to abort) so the front-queued steer message drains as the next
    // turn. The restart checkpoint drain does NOT do this — it relies on respawn
    // + resumeSession to continue, so it must leave the state intact.
    if (runtime?.steerStop?.() && event.kind !== 'cancel') {
      void runtime.handle.dispatch(sessionId, { kind: 'cancel' }, { internalBoundaryCancel: true })
    }
    return
  }

  if (effects.length > 1 && effects.every(isCallToolEffect)) {
    const resultQueue = createSerialQueue()
    await Promise.all(
      effects.map((eff) => performCallTool(deps, record.sessionId, eff, aborts, runtime, resultQueue)),
    )
    return
  }

  for (const eff of effects) {
    await performEffect(deps, record, eff, aborts, runtime)
  }
}

function shouldStopForDrain(event: AgentEvent, effects: readonly Effect[], runtime?: LoopRuntime): boolean {
  // Steer's polite stop: let the in-flight LLM response and any tools it spawned
  // finish, and stop only when the loop is about to begin a FRESH autonomous
  // think — i.e. tool results have settled and produced a continuation call_llm.
  // Unlike the restart checkpoint drain below, it must NOT stop on an
  // `llm_response` that carries tool calls (that would strand the session in
  // `executing_tools` with unrun tools, since steer has no respawn to resume
  // them). Approvals still stop — the user has to act regardless.
  if (runtime?.steerStop?.()) {
    if (effects.some((effect) => effect.kind === 'request_approval')) return true
    if (effects.some((effect) => effect.kind === 'call_llm')) return true
    return false
  }
  const mode = runtime?.drain?.() ?? 'none'
  if (mode === 'none') return false
  if (mode === 'idle') return false
  if (effects.some((effect) => effect.kind === 'call_llm' || effect.kind === 'call_tool' || effect.kind === 'request_approval')) return true
  if (event.kind === 'llm_response' || event.kind === 'llm_error') return true
  return false
}

function isCallToolEffect(effect: Effect): effect is CallToolEffect {
  return effect.kind === 'call_tool'
}

type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>

function createSerialQueue(): SerialQueue {
  let tail = Promise.resolve()
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => undefined).then(task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

async function performEffect(
  deps: HostLoopDeps,
  record: SessionRecord,
  effect: Effect,
  aborts: Map<string, AbortController>,
  runtime?: LoopRuntime,
): Promise<void> {
  switch (effect.kind) {
    case 'call_llm':
      return performCallLlm(deps, record.sessionId, record.config, effect, aborts, runtime)
    case 'call_tool':
      return performCallTool(deps, record.sessionId, effect, aborts, runtime)
    case 'request_approval':
      safeBroadcast(() => deps.broadcast.onApprovalRequired(record.sessionId, effect))
      return
    case 'finish':
      performFinish(effect)
      return
    case 'emit_error':
      performEmitError(deps, record.sessionId, effect)
      return
  }
}

async function performCallLlm(
  deps: HostLoopDeps,
  sessionId: string,
  config: AgentConfig,
  effect: CallLlmEffect,
  aborts: Map<string, AbortController>,
  runtime?: LoopRuntime,
): Promise<void> {
  if (runtime?.stopRequested?.()) return
  const model = runtime?.model ?? deps.models?.get(sessionId)
  const controller = new AbortController()
  const llmStartedAt = new Date().toISOString()
  const llmStartedMono = performance.now()
  aborts.set(sessionId, controller)
  const assembledMessages = await messagesForLlmCall(deps, sessionId, config, effect, runtime)
  const persistedMessages = withCurrentToolIntentionInstruction(assembledMessages)
  await maybeWriteMessageAssemblyArtifact(deps, sessionId, model, persistedMessages, effect)
  const live = deps.store.get(sessionId)
  if (!live || live.state.status !== 'thinking' || controller.signal.aborted || isCancelledSubAgentChild(sessionId)) {
    if (aborts.get(sessionId) === controller) aborts.delete(sessionId)
    return
  }
  // Only ask for token deltas when the broadcast wants them. If no consumer
  // is wired up, we skip streaming entirely — the adapter falls through to
  // the plain buffered path and no partial-message accounting is needed.
  let streamedText = ''
  const wantStream = typeof deps.broadcast.onTokenDelta === 'function'
  const onTextDelta = wantStream
    ? (t: string) => {
        streamedText += t
        safeBroadcast(() => deps.broadcast.onTokenDelta!(sessionId, t))
      }
    : undefined
  try {
    const messages = await resolveKernelMessageAttachments(deps.messageAttachments, sessionId, persistedMessages)
    const activeTools = config.toolDisclosureMode === 'progressive' ? await activeToolsFor(live, deps.store) : new Set<string>()
    for (const name of intentActivatedTools(effect.tools, messages)) activeTools.add(name)
    const disclosedTools = visibleTools(effect.tools, config.toolDisclosureMode ?? 'legacy_full', activeTools)
    await maybeRecordToolDisclosure(deps, live, effect.tools, disclosedTools)
    const callInput = {
      deps,
      tools: disclosedTools,
      signal: controller.signal,
      config,
      model,
      onTextDelta,
    }
    let res
    try {
      res = await callLlmWithQuota(callInput, messages, sessionId, model)
    } catch (err) {
      // Token estimators are approximate. If a provider rejects a suddenly
      // huge user/tool item, recover this SAME turn once instead of persisting
      // llm_error and stranding the autonomous run.
      if (!runtime || controller.signal.aborted || !isContextOverflowError(err)) throw err
      await runtime.handle.compact(sessionId, { trigger: 'preflight', continuation: 'current_turn' })
      const current = deps.store.get(sessionId)?.state.messages ?? persistedMessages
      const retryMessages = await resolveKernelMessageAttachments(
        deps.messageAttachments,
        sessionId,
        emergencyTruncate(current, config, contextLimitForSession(deps, sessionId)),
      )
      res = await callLlmWithQuota(callInput, retryMessages, sessionId, model)
    }
    assertOnlyDisclosedTools(res.message, disclosedTools)
    await maybeRecordTokenUsageObservation(deps, sessionId, res, messages, disclosedTools)
    if (shouldRecoverFromMaxTokens(res) && runtime && !controller.signal.aborted) {
      try {
        await runtime.handle.compact(sessionId, { trigger: 'preflight', continuation: 'current_turn' })
        const retryMessages = await resolveKernelMessageAttachments(
          deps.messageAttachments,
          sessionId,
          deps.store.get(sessionId)?.state.messages ?? persistedMessages,
        )
        res = await callLlmWithQuota({
          deps,
          tools: disclosedTools,
          signal: controller.signal,
          config,
          model,
          onTextDelta,
        }, retryMessages, sessionId, model)
        assertOnlyDisclosedTools(res.message, disclosedTools)
        await maybeRecordTokenUsageObservation(deps, sessionId, res, retryMessages, disclosedTools, 'max_tokens_retry')
      } catch {
        // If recovery compaction or retry fails, persist the original provider
        // response. The finishReason still records that it was truncated.
      }
    }
    await (deps.extensions ?? createBuiltinExtensionRegistry()).afterModelCall({
      deps,
      sessionId,
      config,
      effect,
      ...(model !== undefined ? { model } : {}),
      messages: persistedMessages,
      requiresCompaction: false,
      compact: async () => await runtime?.handle.compact(sessionId, { trigger: 'preflight', continuation: 'current_turn' }) ?? false,
      messagesAfterCompaction: () => deps.store.get(sessionId)?.state.messages ?? persistedMessages,
    }, res)
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'llm_response',
        message: res.message,
        ...(res.usage ? { usage: res.usage } : {}),
        ...(res.finishReason ? { finishReason: res.finishReason } : {}),
      },
      aborts,
      res.trace,
      res.trace?.model ?? model,
      runtime,
      undefined,
      { timingSpan: timedSpan('llm', `llm-${sessionId}-${deps.store.get(sessionId)?.state.cursor ?? 0}`, llmStartedAt, llmStartedMono, 'succeeded', { firstTokenMs: res.trace?.response?.metrics?.timeToFirstChunkMs }) },
    )
  } catch (err) {
    // AbortError from the fetch call means the user cancelled mid-stream.
    // Turn whatever was collected into a normal llm_response so the log
    // stays exact and the FSM leaves the `thinking` state.
    if (isAbortError(err)) {
      const suffix = streamedText.length > 0 ? '\n\n[cancelled]' : '[cancelled]'
      await dispatchOne(
        deps,
        sessionId,
        {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: streamedText + suffix }],
          },
        },
        aborts,
        undefined,
        model,
        runtime,
        undefined,
        { timingSpan: timedSpan('llm', `llm-${sessionId}-${deps.store.get(sessionId)?.state.cursor ?? 0}`, llmStartedAt, llmStartedMono, 'cancelled') },
      )
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    await dispatchOne(deps, sessionId, { kind: 'llm_error', error: message }, aborts, undefined, model, runtime, undefined, { timingSpan: timedSpan('llm', `llm-${sessionId}-${deps.store.get(sessionId)?.state.cursor ?? 0}`, llmStartedAt, llmStartedMono, 'failed') })
  } finally {
    if (aborts.get(sessionId) === controller) aborts.delete(sessionId)
  }
}

function isContextOverflowError(err: unknown): boolean {
  const input = err && typeof err === 'object' && 'input' in err
    ? (err as { input?: { status?: number; bodyText?: string } }).input
    : undefined
  const status = input?.status
  const text = `${err instanceof Error ? err.message : String(err)} ${input?.bodyText ?? ''}`.toLowerCase()
  if (status !== undefined && ![400, 413, 422].includes(status)) return false
  return /context(?:_|\s|-)*(?:length|window)|too many tokens|prompt is too long|maximum.*tokens|request too large/u.test(text)
}

function shouldRecoverFromMaxTokens(res: Awaited<ReturnType<typeof callLlmOnce>>): boolean {
  if (res.finishReason !== 'max_tokens' && res.finishReason !== 'length') return false
  const text = res.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const toolCalls = res.message.content.some((c) => c.type === 'tool_call')
  return !toolCalls && text.length < 512
}

async function callLlmWithQuota(
  input: Parameters<typeof callLlmOnce>[0],
  messages: readonly Message[],
  sessionId: string,
  model: string | undefined,
): Promise<Awaited<ReturnType<typeof callLlmOnce>>> {
  await input.deps.assertSessionEffectOwner?.(sessionId)
  const quota = input.deps.llmQuota
  const modelPolicy = input.deps.modelPolicy
  const record = input.deps.store.get(sessionId)
  if (modelPolicy && model) {
    if (!record?.organizationId) throw new Error('missing organization attribution for model policy enforcement')
    await modelPolicy.assertCanUseModel({
      organizationId: record.organizationId,
      sessionId,
      model,
      ...(record.principal ? { principal: record.principal } : {}),
    })
  }
  if (quota) {
    if (!record?.organizationId) throw new Error('missing organization attribution for quota enforcement')
    await quota.assertMonthlyTokenQuota({
      organizationId: record.organizationId,
      sessionId,
      ...(model ? { model } : {}),
      requestedTokens: estimateMessageTokens(messages) + estimateToolSchemaTokens(input.tools),
    })
  }
  // Policy and quota checks may suspend while the Session moves to another Runtime.
  await input.deps.assertSessionEffectOwner?.(sessionId)
  if (input.signal.aborted) throw new DOMException('Unit effects stopped', 'AbortError')
  const res = await callLlmOnce(input, messages)
  if (quota?.recordUsage && res.usage) {
    if (!record?.organizationId) throw new Error('missing organization attribution for usage recording')
    await quota.recordUsage({
      organizationId: record.organizationId,
      sessionId,
      ...(res.trace?.model ?? model ? { model: res.trace?.model ?? model } : {}),
      usage: res.usage,
    })
  }
  return res
}

function assertOnlyDisclosedTools(message: Message, tools: readonly import('@agent-kernel/kernel').ToolSchema[]): void {
  const visible = new Set(tools.map((tool) => tool.name))
  for (const content of message.content) {
    if (content.type === 'tool_call' && !visible.has(content.name)) throw new Error(`model called a Tool that was not disclosed in this request: ${content.name}`)
  }
}

async function maybeRecordToolDisclosure(
  deps: HostLoopDeps,
  record: SessionRecord,
  full: readonly import('@agent-kernel/kernel').ToolSchema[],
  visible: readonly import('@agent-kernel/kernel').ToolSchema[],
): Promise<void> {
  try {
    await deps.store.appendRuntimeMetadata(record.sessionId, {
      action: 'tool_disclosure_snapshot',
      payload: {
        mode: record.config.toolDisclosureMode ?? 'legacy_full',
        catalogRevision: toolCatalogRevision(full),
        totalCount: full.length,
        visibleCount: visible.length,
        visibleNames: visible.map((tool) => tool.name),
        fullSchemaTokens: estimateToolSchemaTokens(full),
        visibleSchemaTokens: estimateToolSchemaTokens(visible),
      },
    })
  } catch {
    // Observability only; activation durability is handled separately.
  }
}

async function maybeRecordTokenUsageObservation(
  deps: HostLoopDeps,
  sessionId: string,
  res: Awaited<ReturnType<typeof callLlmOnce>>,
  messages: readonly Message[],
  tools: CallLlmEffect['tools'],
  trigger = 'initial',
): Promise<void> {
  if (!res.usage) return
  try {
    const estimatedInputTokens = estimateMessageTokens(messages) + estimateToolSchemaTokens(tools)
    const traceBody = res.trace?.request.body
    const requestBodyEstimatedTokens = traceBody === undefined ? undefined : estimateStringTokens(JSON.stringify(traceBody))
    const record = deps.store.get(sessionId)
    if (!record) return
    await deps.store.appendRuntimeMetadata(sessionId, {
      action: 'token_usage_observed',
      payload: {
        trigger,
        provider: res.trace?.provider ?? deps.llm.name,
        model: res.trace?.model,
        estimatedInputTokens,
        ...(requestBodyEstimatedTokens !== undefined ? { requestBodyEstimatedTokens } : {}),
        actualInputTokens: res.usage.inputTokens,
        actualOutputTokens: res.usage.outputTokens,
        ratio: estimatedInputTokens > 0 ? res.usage.inputTokens / estimatedInputTokens : null,
        ...(res.finishReason ? { finishReason: res.finishReason } : {}),
      },
    })
  } catch {
    // Observability only.
  }
}

export function withCurrentToolIntentionInstruction(messages: readonly Message[]): readonly Message[] {
  const instruction = TOOL_INTENTION_SYSTEM_INSTRUCTION
  const alreadyCurrent = messages.some((message) => message.role === 'system' && message.content.some(
    (content) => content.type === 'text' && content.text.includes(instruction),
  ))
  if (alreadyCurrent) return messages
  const firstSystemIndex = messages.findIndex((message) => message.role === 'system')
  if (firstSystemIndex < 0) return [{ role: 'system', content: [{ type: 'text', text: instruction }] }, ...messages]
  const current = messages[firstSystemIndex]!
  return messages.map((message, index) => index === firstSystemIndex
    ? { ...current, content: [...current.content, { type: 'text', text: instruction }] }
    : message)
}

function callLlmOnce(input: {
  deps: HostLoopDeps
  tools: CallLlmEffect['tools']
  signal: AbortSignal
  config: AgentConfig
  model?: string
  onTextDelta?: (delta: string) => void
}, messages: readonly Message[]) {
  return input.deps.llm.call({
    messages,
    tools: input.tools,
    signal: input.signal,
    ...(input.config.systemPrompt ? { systemPrompt: input.config.systemPrompt } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.config.thinkingBudget !== undefined
      ? { thinkingBudget: input.config.thinkingBudget }
      : {}),
    ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
  })
}

async function maybeWriteMessageAssemblyArtifact(
  deps: HostLoopDeps,
  sessionId: string,
  model: string | undefined,
  messages: readonly import('@agent-kernel/kernel').Message[],
  effect: CallLlmEffect,
): Promise<void> {
  if (!deps.artifactRootDir) return
  try {
    const record = deps.store.get(sessionId)
    const contextLimit = contextLimitForSession(deps, sessionId, record)
    const store = createArtifactStore(deps.artifactRootDir, {
      ...(record?.state.cwd ? { workspaceRoot: record.state.cwd } : {}),
    })
    const artifact = createMessageAssemblyArtifact({
      sessionId,
      eventSeq: record?.state.cursor,
      model,
      messages,
      tools: effect.tools,
      stages: messageAssemblyStages(deps.llm.name, effect.messages, messages, effect.tools),
      ...(contextLimit ? { budget: { contextLimit } } : {}),
    })
    await store.writeJson(
      'message_assembly',
      `message-assembly/${sessionId}/${record?.state.cursor ?? 'unknown'}.json`,
      artifact,
    )
    await store.writeJson(
      'router_decision',
      `router-decisions/${sessionId}/${record?.state.cursor ?? 'unknown'}.json`,
      createRouterDecisionArtifact({
        requestedModel: model,
        adapterName: deps.llm.name,
        maxInputTokens: contextLimit,
        tools: effect.tools,
        hasImageInput: messagesHaveImage(messages),
        reasoningBudgetRequested: messagesHaveReasoning(messages),
      }),
    )
    await store.writeJson(
      'tool_catalog',
      `tool-catalog/${sessionId}/${record?.state.cursor ?? 'unknown'}.json`,
      createToolCatalogArtifact(effect.tools),
    )
  } catch {
    // Assembly artifacts are observability data. Failure to write them must not
    // affect the reducer, LLM call, or replay ledger.
  }
}

function messagesHaveImage(messages: readonly import('@agent-kernel/kernel').Message[]): boolean {
  return messages.some((m) => m.content.some((c) => c.type === 'image'))
}

function messagesHaveReasoning(messages: readonly import('@agent-kernel/kernel').Message[]): boolean {
  return messages.some((m) => m.content.some((c) => c.type === 'thinking'))
}

function messageAssemblyStages(
  adapterName: string,
  inputMessages: readonly import('@agent-kernel/kernel').Message[],
  outputMessages: readonly import('@agent-kernel/kernel').Message[],
  tools: readonly import('@agent-kernel/kernel').ToolSchema[],
): readonly MessageAssemblyStage[] {
  const inputTokens = estimateMessageTokens(inputMessages)
  const outputTokens = estimateMessageTokens(outputMessages)
  const toolTokens = estimateToolSchemaTokens(tools)
  return [
    {
      name: 'kernel.messages',
      inputMessages: inputMessages.length,
      outputMessages: inputMessages.length,
      estimatedTokens: inputTokens,
      droppedItems: 0,
      reasonCodes: ['canonical_reducer_messages'],
      artifactRefs: [],
    },
    {
      name: 'tool.registry',
      inputMessages: outputMessages.length,
      outputMessages: outputMessages.length,
      estimatedTokens: toolTokens,
      droppedItems: 0,
      reasonCodes: tools.length > 0 ? ['tool_schemas_available'] : ['tool_registry_empty'],
      artifactRefs: [],
    },
    memoryContributionStage(inputMessages, outputMessages),
    {
      name: 'host.preflight',
      inputMessages: inputMessages.length,
      outputMessages: outputMessages.length,
      estimatedTokens: outputTokens,
      droppedItems: Math.max(0, inputMessages.length - outputMessages.length),
      reasonCodes: outputMessages === inputMessages ? ['no_preflight_compaction'] : ['preflight_compaction_applied'],
      artifactRefs: [],
    },
    {
      name: 'provider.adapter',
      inputMessages: outputMessages.length,
      outputMessages: outputMessages.length,
      estimatedTokens: outputTokens + toolTokens,
      droppedItems: 0,
      reasonCodes: [`adapter:${adapterName}`],
      artifactRefs: [],
    },
  ]
}

function memoryContributionStage(
  inputMessages: readonly import('@agent-kernel/kernel').Message[],
  outputMessages: readonly import('@agent-kernel/kernel').Message[],
): MessageAssemblyStage {
  const inputMemory = countMemoryToolPairs(inputMessages)
  const outputMemory = countMemoryToolPairs(outputMessages)
  return {
    name: 'memory.contribution',
    inputMessages: inputMessages.length,
    outputMessages: outputMessages.length,
    estimatedTokens: estimateMemoryTokens(outputMessages),
    droppedItems: Math.max(0, inputMemory - outputMemory),
    reasonCodes: outputMemory > 0 ? ['memory_tool_context_present'] : ['memory_tool_context_absent'],
    artifactRefs: [],
  }
}

function countMemoryToolPairs(messages: readonly import('@agent-kernel/kernel').Message[]): number {
  const callIds = new Set<string>()
  let results = 0
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call' && content.name === 'memory') callIds.add(content.callId)
      if (content.type === 'tool_result' && callIds.has(content.callId)) results += 1
    }
  }
  return callIds.size + results
}

function estimateMemoryTokens(messages: readonly import('@agent-kernel/kernel').Message[]): number {
  const callIds = new Set<string>()
  let tokens = 0
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call' && content.name === 'memory') {
        callIds.add(content.callId)
        tokens += estimateStringTokens(content.name) + estimateStringTokens(content.callId) + estimateStringTokens(JSON.stringify(content.input)) + 16
      }
      if (content.type === 'tool_result' && callIds.has(content.callId)) {
        tokens += estimateStringTokens(content.content) + estimateStringTokens(content.callId) + 16
      }
    }
  }
  return tokens
}

async function performCallTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  runtime?: LoopRuntime,
  resultQueue?: SerialQueue,
): Promise<void> {
  const toolStartedAt = new Date().toISOString()
  const toolStartedMono = performance.now()
  if (runtime?.stopRequested?.()) return
  runtime?.toolStarted?.(sessionId, effect.callId)
  try {
    const blockedByLoop = guardPostCompactionLoop(sessionId, effect, runtime?.loopGuard)
    if (blockedByLoop) {
      await dispatchToolResult(
        deps,
        sessionId,
        effect.callId,
        false,
        blockedByLoop,
        aborts,
        runtime,
        resultQueue,
        undefined,
        timedSpan('tool', `tool-${effect.callId}`, toolStartedAt, toolStartedMono, 'failed', { callId: effect.callId }),
      )
      return
    }
    const tracker = timingTrackers.get(deps.store)
    const res = await dispatchRuntimeTool(
      deps,
      sessionId,
      effect,
      aborts,
      tracker?.currentTurnId(sessionId),
      runtime?.handle,
      runtime?.plannedContinuation === true,
    )
    await dispatchToolResult(
      deps,
      sessionId,
      effect.callId,
      res.ok,
      res.content,
      aborts,
      runtime,
      resultQueue,
      res.failure,
      timedSpan('tool', `tool-${effect.callId}`, toolStartedAt, toolStartedMono, res.ok ? 'succeeded' : 'failed', { callId: effect.callId, ...(res.durationMs !== undefined ? { executorDurationMs: res.durationMs } : {}) }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await dispatchToolResult(
      deps,
      sessionId,
      effect.callId,
      false,
      message,
      aborts,
      runtime,
      resultQueue,
      undefined,
      timedSpan('tool', `tool-${effect.callId}`, toolStartedAt, toolStartedMono, 'failed', { callId: effect.callId }),
    )
  } finally {
    runtime?.toolSettled?.(sessionId, effect.callId)
  }
}

async function dispatchToolResult(
  deps: HostLoopDeps,
  sessionId: string,
  callId: string,
  ok: boolean,
  content: string,
  aborts: Map<string, AbortController>,
  runtime?: LoopRuntime,
  resultQueue?: SerialQueue,
  failure?: import('@agent-kernel/kernel').ToolFailure,
  timingSpan?: import('./turn-timing.js').SpanObservation,
): Promise<void> {
  const write = async (): Promise<void> => {
    const record = deps.store.get(sessionId)
    const capped = capToolResultForContext(content, contextLimitForSession(deps, sessionId, record))
    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'tool_result',
        callId,
        ok,
        content: capped,
        ...(failure ? { failure } : {}),
      },
      aborts,
      undefined,
      undefined,
      runtime,
      undefined,
      timingSpan ? { timingSpan } : undefined,
    )
  }
  if (resultQueue) await resultQueue(write)
  else await write()
}

const PREFLIGHT_RESERVE_FLOOR_TOKENS = 8_000
const PREFLIGHT_RESERVE_RATIO = 0.12
const TOOL_RESULT_INLINE_CONTEXT_RATIO = 0.10
const TOOL_RESULT_INLINE_MIN_TOKENS = 2_000
const TOOL_RESULT_INLINE_MAX_TOKENS = 16_000
const POST_COMPACTION_GUARD_CALLS = 6
const POST_COMPACTION_REPEAT_LIMIT = 2

async function messagesForLlmCall(
  deps: HostLoopDeps,
  sessionId: string,
  config: AgentConfig,
  effect: CallLlmEffect,
  runtime?: LoopRuntime,
): Promise<readonly import('@agent-kernel/kernel').Message[]> {
  const messages = effect.messages
  const contextLimit = contextLimitForSession(deps, sessionId)
  const requiresCompaction = Boolean(runtime && shouldPreflightCompact(config, messages, contextLimit))
  const after = await (deps.extensions ?? createBuiltinExtensionRegistry()).beforeModelCall({
    deps,
    sessionId,
    config,
    effect,
    ...(runtime?.model !== undefined ? { model: runtime.model } : {}),
    messages,
    requiresCompaction,
    compact: async () => await runtime?.handle.compact(sessionId, { trigger: 'preflight', continuation: 'current_turn' }) ?? false,
    messagesAfterCompaction: () => deps.store.get(sessionId)?.state.messages ?? messages,
  })
  if (!requiresCompaction) return after
  if (!shouldPreflightCompact(config, after, contextLimit)) return after
  // Skipped, circuit-open, failed, or no-progress compaction must still make
  // progress. Enforce a hard request budget, including one-message cases.
  return emergencyTruncate(after, config, contextLimit)
}

function emergencyTruncate(
  messages: readonly import('@agent-kernel/kernel').Message[],
  config: AgentConfig,
  contextLimitOverride?: number,
): readonly import('@agent-kernel/kernel').Message[] {
  const leadingSystem = messages[0]?.role === 'system' ? [messages[0]] : []
  const rest = messages.slice(leadingSystem.length)
  const groups: (typeof messages[number])[][] = []
  for (const m of rest) {
    if (m.role === 'assistant' || groups.length === 0) groups.push([m])
    else groups[groups.length - 1]!.push(m)
  }
  let dropped = 0
  while (groups.length > 1) {
    const candidate = [...leadingSystem, ...groups.flat()]
    if (!shouldPreflightCompact(config, candidate, contextLimitOverride)) return candidate
    groups.shift()
    dropped += 1
    if (dropped > 100) break
  }
  const remaining = [...leadingSystem, ...groups.flat()]
  if (!shouldPreflightCompact(config, remaining, contextLimitOverride)) return remaining
  return truncateOversizedMessageContent(remaining, preflightTokenLimit(config, contextLimitOverride))
}

/**
 * Last-resort liveness fallback for one irreducibly huge message/group. Keep
 * message roles and tool call/result pairing, but shrink the largest text item
 * head+tail until the actual estimated request fits. This is deterministic and
 * always makes progress; without it a single huge user paste could survive all
 * whole-group dropping and strand the turn after provider overflow.
 */
function truncateOversizedMessageContent(
  messages: readonly import('@agent-kernel/kernel').Message[],
  tokenLimit: number,
): readonly import('@agent-kernel/kernel').Message[] {
  let current = messages.map((message) => ({ ...message, content: message.content.map((item) => ({ ...item })) }))
  for (let pass = 0; pass < 32 && estimateMessageTokens(current) >= tokenLimit; pass += 1) {
    let target: { message: number; content: number; text: string } | undefined
    current.forEach((message, messageIndex) => message.content.forEach((item, contentIndex) => {
      if (item.type !== 'text' && item.type !== 'tool_result') return
      const text = item.type === 'text' ? item.text : item.content
      if (!target || text.length > target.text.length) target = { message: messageIndex, content: contentIndex, text }
    }))
    if (!target || target.text.length <= 256) break
    const excessTokens = Math.max(1, estimateMessageTokens(current) - tokenLimit + 64)
    const keepChars = Math.max(256, target.text.length - excessTokens * 4)
    const head = Math.floor(keepChars * 0.6)
    const tail = Math.max(0, keepChars - head)
    const nextText = `${target.text.slice(0, head).trimEnd()}\n[... ${target.text.length - keepChars} chars omitted by emergency context recovery ...]\n${target.text.slice(-tail).trimStart()}`
    const message = current[target.message]!
    const item = message.content[target.content]!
    if (item.type === 'text') message.content[target.content] = { ...item, text: nextText }
    else if (item.type === 'tool_result') message.content[target.content] = { ...item, content: nextText }
  }
  return current
}

function shouldPreflightCompact(
  config: AgentConfig,
  messages: readonly import('@agent-kernel/kernel').Message[],
  contextLimitOverride?: number,
): boolean {
  const contextLimit = contextLimitOverride ?? config.contextLimit
  if (!contextLimit || contextLimit <= 0) return false
  if (!messages.some((m) => m.role !== 'system')) return false
  return estimateMessageTokens(messages) >= preflightTokenLimit(config, contextLimit)
}

function preflightTokenLimit(config: AgentConfig, contextLimitOverride?: number): number {
  const contextLimit = contextLimitOverride ?? config.contextLimit
  if (!contextLimit || contextLimit <= 0) return Number.MAX_SAFE_INTEGER
  const baseReserve = Math.min(
    Math.max(PREFLIGHT_RESERVE_FLOOR_TOKENS, Math.round(contextLimit * PREFLIGHT_RESERVE_RATIO)),
    Math.floor(contextLimit * 0.25),
  )
  const thinking = config.thinkingBudget && config.thinkingBudget > 0 ? config.thinkingBudget : 0
  const reserve = Math.min(baseReserve + thinking, Math.floor(contextLimit * 0.5))
  return Math.max(0, contextLimit - reserve)
}

function contextLimitForSession(
  deps: HostLoopDeps,
  sessionId: string,
  record = deps.store.get(sessionId),
): number | undefined {
  return deps.models?.contextWindow?.(sessionId) ?? record?.config.contextLimit
}

function capToolResultForContext(content: string, contextLimit: number | undefined): string {
  const maxTokens = toolResultInlineTokenBudget(contextLimit)
  const maxChars = maxTokens * 4
  if (content.length <= maxChars) return content
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.max(0, maxChars - headChars)
  const omitted = content.length - headChars - tailChars
  if (omitted <= 0) return content
  return [
    content.slice(0, headChars).trimEnd(),
    `[... ${omitted} chars omitted from tool result before entering LLM context; kept ${maxChars} of ${content.length} chars ...]`,
    content.slice(-tailChars).trimStart(),
  ].join('\n')
}

function toolResultInlineTokenBudget(contextLimit: number | undefined): number {
  if (!contextLimit || contextLimit <= 0) return TOOL_RESULT_INLINE_MAX_TOKENS
  return Math.min(
    TOOL_RESULT_INLINE_MAX_TOKENS,
    Math.max(TOOL_RESULT_INLINE_MIN_TOKENS, Math.floor(contextLimit * TOOL_RESULT_INLINE_CONTEXT_RATIO)),
  )
}

function guardPostCompactionLoop(
  sessionId: string,
  effect: CallToolEffect,
  guards: Map<string, PostCompactionLoopGuard> | undefined,
): string | undefined {
  const guard = guards?.get(sessionId)
  if (!guard) return undefined
  guard.remainingCalls -= 1
  if (guard.remainingCalls < 0) {
    guards?.delete(sessionId)
    return undefined
  }
  const key = `${effect.name}:${stableStringify(effect.input)}`
  const count = (guard.seen.get(key) ?? 0) + 1
  guard.seen.set(key, count)
  if (count <= POST_COMPACTION_REPEAT_LIMIT) return undefined
  guards?.delete(sessionId)
  return `blocked: repeated identical tool call after context compaction (${effect.name}). Re-read compacted context and choose a different next step.`
}

/**
 * Reject `memory` tool calls that would reach across-task disk state when the
 * session's memoryPolicy is `disabled`. Isolated Sessions set `mode: disabled`
 * so they cannot inadvertently read workspace/global memory notes written
 * during unrelated Sessions. Session-scope memory is
 * kernel-managed and stays available regardless of policy.
 */
function guardMemoryPolicy(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
): string | undefined {
  if (effect.name !== 'memory') return undefined
  const record = deps.store.get(sessionId)
  const policy = record?.memoryPolicy
  if (!policy) return undefined
  if (policy.mode !== 'disabled') return undefined
  const input = (effect.input ?? {}) as Record<string, unknown>
  const scope = input['scope']
  if (scope !== 'workspace' && scope !== 'global') return undefined
  return `ERROR: EMEMDISABLED: memory disabled in this session by memoryPolicy (scope=${scope}). Session-scope memory is still available.`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  )
}

function performFinish(_effect: FinishEffect): void {
  // Turn ended. Nothing to do — the state.status='done' broadcast already
  // told subscribers. Kept as a switch case for exhaustiveness.
}

function performEmitError(
  deps: HostLoopDeps,
  sessionId: string,
  effect: EmitErrorEffect,
): void {
  safeBroadcast(() => deps.broadcast.onError(sessionId, effect.error))
}

function safeBroadcast(fn: () => void): void {
  try {
    fn()
  } catch {
    // Broadcast failures are delivery failures, not state-machine failures.
    // The event has already been persisted, so clients can recover by
    // resubscribing and replaying from the JSONL log.
  }
}
