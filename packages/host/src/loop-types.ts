/**
 * Shared type surface for the host loop.
 *
 * These are the pure type definitions that the loop and its extensions
 * (`extensions/compaction.ts`, `extensions/agent-tool.ts`,
 * `extensions/hooks-runner.ts`, `extensions/memory-consolidation.ts`) all
 * need. They live here — a leaf module with no runtime logic — so that an
 * extension can depend on the loop's *contract* (`HostLoopDeps`, `LoopHandle`,
 * …) without importing `loop.ts` itself and forming an import cycle. The
 * runtime re-entry point `dispatchOne` stays in `loop.ts`; extensions import
 * that one value directly.
 *
 * `loop.ts` re-exports every type from here, so `import type { HostLoopDeps }
 * from './loop.js'` continues to resolve for existing consumers.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  CallToolEffect,
  Effect,
  PendingToolCall,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import type { CompactionMetadata, CompactStatusEvent, LLMTrace } from '@agent-kernel/shared'

import type { LLMAdapter } from './llm/adapter.js'
import type { HookConfig, HookRunner } from './extensions/hooks.js'
import type { SkillManager, SkillRegistry } from './extensions/skills.js'
import type { SessionStore } from './store/session.js'
import type { WebSearchCredentialStore } from './web-search/index.js'
import type { MessageAttachmentStorage } from './message-attachment-store.js'
import type { AskUserChoiceBroker } from './ask-user-choice.js'
import type { ExtensionRegistry } from './extensions/registry.js'
import type { DagStorage } from './dag/storage.js'

export type LoopBroadcast = {
  onEvent(
    sessionId: string,
    seq: number,
    event: AgentEvent,
    effects: readonly Effect[],
    state: AgentState,
    llmTrace?: LLMTrace,
    model?: string,
    extras?: EventBroadcastExtras,
  ): void
  onApprovalRequired(sessionId: string, eff: RequestApprovalEffect): void
  onError(sessionId: string, message: string): void
  /**
   * Streaming text token from the adapter, forwarded to dashboards.
   * Optional — non-streaming adapters never invoke it and the wire event
   * simply doesn't fire.
   */
  onTokenDelta?(sessionId: string, text: string): void
  /**
   * A sub-agent (via the `agent` builtin) has just been created. Fired into
   * the parent's dashboard room so the SubAgentCard can transition from
   * "spawning" to "running" and open a subscription to the child's own room
   * before the child starts streaming. Optional so hosts without a dashboard
   * can drop it.
   */
  onSubAgentStarted?(payload: SubAgentStartedPayload): void
  /**
   * The sub-agent's inner loop returned (success or failure). Fired into the
   * parent's dashboard room just before `runAgentTool()` returns the wrapped
   * envelope as the tool_result — arrives ahead of the parent's
   * `event:appended` for that tool_result, so the card can freeze its timer
   * without waiting for the parent turn to advance.
   */
  onSubAgentFinished?(payload: SubAgentFinishedPayload): void
  /**
   * Compaction lifecycle. Fired at three points around every attempt so
   * every attached dashboard sees the same state and can render the
   * "Compacting…" row / final result without originating the request.
   *
   * Payload contract: {@link CompactStatusEvent}.
   */
  onCompactStatus?(payload: CompactStatusEvent): void
}

export type CompactStatusPayload = CompactStatusEvent

export type CompactTrigger = 'manual' | 'auto' | 'preflight' | 'tool_result'

/**
 * The lifecycle context determines continuation. These are the only valid
 * combinations: a resting maintenance request cannot be turned into a new
 * Agent turn with an independent boolean flag.
 */
export type CompactRequest =
  | { trigger: 'manual' | 'auto'; continuation: 'stay_resting' }
  | { trigger: 'preflight' | 'tool_result'; continuation: 'current_turn' }

/**
 * Optional broadcast-time enrichments that don't belong on the kernel event
 * itself. `dispatchOne` accepts these and forwards them to
 * {@link LoopBroadcast.onEvent}, which then decorates the wire
 * `event:appended` payload. Today only the compaction extension supplies
 * this — surfacing `trigger`/token deltas that live in runtime metadata,
 * not in the kernel `messages_replaced` event.
 */
export type EventBroadcastExtras = {
  compactionMetadata?: CompactionMetadata
  timingSpan?: import('./turn-timing.js').SpanObservation
  timing?: import('@agent-kernel/shared').EventTimingMetadata
}

export type SubAgentStartedPayload = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  agentType?: string
  intention?: string
  prompt: string
  model?: string
  startedAt: string
}

export type SubAgentFinishedPayload = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out_with_partial_result'
  turns: number
  durationMs: number
  finishedAt: string
  error?: string
}

export type ToolDispatcher = {
  callTool(sessionId: string, eff: CallToolEffect, turnId?: string): Promise<{
    ok: boolean
    content: string
    failure?: import('@agent-kernel/kernel').ToolFailure
    durationMs?: number
  }>
  /**
   * Planned-continuation variant. It may wait and retry only when no Executor
   * accepted the call (`workspace_offline`); an indeterminate dispatched call
   * is never replayed here.
   */
  callToolWhenAvailable?(sessionId: string, eff: CallToolEffect, turnId?: string): Promise<{
    ok: boolean
    content: string
    failure?: import('@agent-kernel/kernel').ToolFailure
    durationMs?: number
  }>
  cancelPending(sessionId: string): void | Promise<void>
}

export type LlmQuotaUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type LlmQuotaEnforcer = {
  assertMonthlyTokenQuota(params: {
    organizationId: string
    sessionId: string
    model?: string
    requestedTokens: number
  }): Promise<void>
  recordUsage?(params: {
    organizationId: string
    sessionId: string
    model?: string
    usage: LlmQuotaUsage
  }): Promise<void>
}

export type TenantModelPolicyEnforcer = {
  assertCanUseModel(params: {
    organizationId: string
    sessionId: string
    model: string
    principal?: string
  }): Promise<void>
}

export type ModelResolver = {
  get(sessionId: string): string | undefined
  contextWindow?(sessionId: string): number | undefined
}

export type HostLoopDeps = {
  store: SessionStore
  llm: LLMAdapter
  tools: ToolDispatcher
  /** Optional fail-closed check immediately before each model or tool effect. */
  assertSessionEffectOwner?: (sessionId: string) => Promise<void>
  llmQuota?: LlmQuotaEnforcer
  modelPolicy?: TenantModelPolicyEnforcer
  broadcast: LoopBroadcast
  models?: ModelResolver
  hooks?: readonly HookConfig[]
  hookRunner?: HookRunner
  skills?: SkillRegistry | SkillManager
  webSearchCredentials?: WebSearchCredentialStore
  audit?: import('./audit-log.js').AuditLogger
  artifactRootDir?: string
  messageAttachments?: MessageAttachmentStorage
  publishLocalImages?: (sessionId: string, record: import('./store/session.js').SessionRecord, message: import('@agent-kernel/kernel').Message) => Promise<import('@agent-kernel/kernel').Message>
  askUserChoice?: AskUserChoiceBroker
  extensions?: ExtensionRegistry
  dagStore?: DagStorage
  dagWorkerConfig?: () => AgentConfig
  dagScheduler?: {
    schedule(parentSessionId: string): void
  }
  publishDagRun?(parentSessionId: string): void
}

export type LoopHandle = {
  dispatch(sessionId: string, event: AgentEvent, options?: DispatchOptions): Promise<void>
  compact(sessionId: string, request: CompactRequest): Promise<boolean>
  hasActiveLlmCall(sessionId: string): boolean
  /** True while any serialized turn work is still running, including the gaps between LLM and tool effects. */
  hasActiveTurn(sessionId: string): boolean
  waitForActiveTurn(sessionId: string): Promise<void>
  /** Stop new effects and abort active model calls and cancellable executor tools on Unit loss/close. */
  abortActiveEffects(): void
  /** Wait until every serialized Session turn has left the Loop. */
  waitForQuiescence(): Promise<void>
  recoverInterruptedLlm(sessionId: string): Promise<boolean>
  /** Resume a dangling Session once; coalesces reconnect/restart callers. */
  ensureSessionResumed(sessionId: string): Promise<boolean>
  beginDrain(mode: LoopDrainMode): void
  isDraining(): boolean
  endDrain(): void
  drainSnapshot(sessionId: string): LoopDrainSessionSnapshot
  waitForCheckpoint(sessionId: string): Promise<LoopDrainSessionSnapshot>
  resumeSession(sessionId: string, options?: ResumeSessionOptions): Promise<boolean>
  /**
   * Abort the in-flight LLM call for a session, if any. Any streamed text
   * so far becomes the final assistant message with a `[cancelled]` suffix,
   * so the event log always sees a complete `llm_response` — never a
   * dangling call. No-op when nothing is streaming.
   */
  cancelStream(sessionId: string): void
  /**
   * Politely stop a session's autonomous turn at the next safe boundary WITHOUT
   * aborting the in-flight LLM response or tool call. The current LLM step /
   * running tool finishes naturally; the loop then settles to a resting status
   * instead of continuing think→tool→think. Used by `steer`: the user's message
   * is queued at the front and dispatched once the session reaches rest, so a
   * steer never truncates an in-progress response or tool. The flag self-clears
   * when the session settles. No-op if the session is already resting.
   */
  requestStopAtBoundary(sessionId: string): void
}

export type LoopDrainMode = 'none' | 'checkpoint' | 'idle'

export type LoopDrainSessionSnapshot = {
  sessionId: string
  status: AgentState['status'] | 'missing'
  safe: boolean
  waiting: 'none' | 'llm' | 'tool' | 'compaction' | 'turn' | 'idle'
  checkpointKind?: 'resting' | 'before_llm' | 'before_tool_dispatch' | 'waiting_for_approval'
  pendingCalls: readonly PendingToolCall[]
  cursor?: number
}

export type DispatchOptions = {
  model?: string
  /** Internal steer boundary settlement; not an explicit operator Stop latch. */
  internalBoundaryCancel?: boolean
  /** Resolves at the durable event-commit boundary, before effect fan-out. */
  onCommitted?: (event: AgentEvent) => void | Promise<void>
}

export type ResumeSessionOptions = {
  /** Runs after durable state validation and before the first resumed IO effect. */
  onStarted?: () => void | Promise<void>
}

/**
 * Threaded through `dispatchOne` → `performEffect` so compaction-preflight and
 * the post-compaction loop guard can re-enter the loop and consult per-session
 * guard state. Internal to the loop machinery; extensions don't construct it.
 */
export type LoopRuntime = {
  handle: LoopHandle
  loopGuard: Map<string, PostCompactionLoopGuard>
  model?: string
  onCommitted?: (event: AgentEvent) => void | Promise<void>
  drain?: () => LoopDrainMode
  /** Per-session steer stop: halt the autonomous loop before the next think. */
  steerStop?: () => boolean
  /** Explicit user Stop latch. Blocks all remaining effects from the cancelled turn. */
  stopRequested?: () => boolean
  toolStarted?(sessionId: string, callId: string): void
  toolSettled?(sessionId: string, callId: string): void
  plannedContinuation?: boolean
}

export type PostCompactionLoopGuard = {
  remainingCalls: number
  seen: Map<string, number>
}
