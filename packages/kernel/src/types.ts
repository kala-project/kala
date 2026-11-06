/**
 * Core type definitions for @agent-kernel/kernel.
 *
 * Everything is plain data. No classes, no methods, no IO.
 * The kernel is a pure function `step(state, event) -> (nextState, effects)`.
 * All types are structurally shared across core / executor / dashboard.
 */

// ============================================================================
// Messages (LLM-facing conversation)
// ============================================================================

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type TextContent = {
  type: 'text'
  text: string
}

export type ToolCallContent = {
  type: 'tool_call'
  callId: string
  name: string
  input: Record<string, unknown>
  intent?: string
}

export type ToolResultContent = {
  type: 'tool_result'
  callId: string
  ok: boolean
  content: string
  failure?: ToolFailure
}

export type ToolFailure = {
  code: string
  category: 'input' | 'precondition' | 'execution' | 'infrastructure' | 'cancelled'
  outcome: 'blocked' | 'failed' | 'cancelled' | 'timeout' | 'indeterminate'
  retryable: boolean
  responsibility: 'model' | 'workspace' | 'provider' | 'user' | 'system'
  timeoutStage?: 'queue' | 'acknowledgement' | 'execution' | 'idle_output'
}

/**
 * Image attached to a message. Two shapes are permitted so the JSONL log
 * can stay readable when large images flow through: `file_ref` records a
 * path (resolved at send time by the host), `base64` inlines the bytes
 * (used when there is no filesystem context, e.g. pasted screenshots).
 */
export type ImageSource =
  | {
      kind: 'base64'
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
    }
  | {
      kind: 'file_ref'
      path: string
      mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    }

export type ImageContent = {
  type: 'image'
  source: ImageSource
}

export type LegacyInlineFileContent = {
  type: 'file'
  name: string
  mediaType: string
  data: string
}

export type HostAttachmentReference = {
  kind: 'host_ref'
  attachmentId: string
  sha256: string
  bytes: number
}

export type ReferencedFileContent = {
  type: 'file'
  name: string
  mediaType: string
  source: HostAttachmentReference
}

/**
 * Generic file attachment. New browser submissions use the Host-owned
 * reference form; the inline base64 variant remains readable for historical
 * Session replay.
 */
export type FileContent = LegacyInlineFileContent | ReferencedFileContent

/**
 * Model reasoning block — the model's private chain-of-thought that
 * produced the visible answer. Every major provider now surfaces some
 * variant of this: Anthropic's extended thinking, OpenAI's o1 reasoning
 * traces, Gemini's thoughts. Adapters normalize their provider-specific
 * shape into this envelope so the kernel and dashboard stay agnostic.
 *
 * Preserved in the message log because some provider APIs (notably
 * Anthropic) require echoing it back on the next turn for tool-use flows;
 * the kernel treats it as opaque and simply round-trips whatever the
 * adapter attached.
 *
 * `signature` is a provider-generated opaque token some APIs demand on
 * the next turn to prove the block came from them. `provider` is a soft
 * hint for the dashboard's rendering (e.g. show an Anthropic badge); it
 * MUST NOT be interpreted by the kernel.
 *
 * The wire discriminator stays `type: 'thinking'` for JSONL-log backward
 * compatibility — every existing log line already carries that literal.
 */
export type ReasoningContent = {
  type: 'thinking'
  text: string
  signature?: string
  provider?: string
}

/**
 * @deprecated Use {@link ReasoningContent}. Kept as an alias so existing
 * imports keep working through the rename.
 */
export type ThinkingContent = ReasoningContent

export type MessageContent =
  | TextContent
  | ToolCallContent
  | ToolResultContent
  | ImageContent
  | FileContent
  | ReasoningContent

export type Message = {
  role: Role
  content: MessageContent[]
  metadata?:
    | {
        kind: 'model_changed'
        from?: string
        to: string
      }
    | {
        kind: 'context_compaction'
        attemptId: string
        phase: 'running' | 'done' | 'error'
        trigger: 'manual' | 'auto' | 'preflight' | 'tool_result'
        tokensBefore: number
        tokensAfter?: number
        replacedCount?: number
        summary?: string
        startedAt: string
        endedAt?: string
        error?: string
      }
    | {
        kind: 'temporal'
        messageId: string
        turnId: string
        createdAt: string
        turnStartedAt: string
        turnCompletedAt?: string
        turnDurationMs?: number
        turnStatus?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
      }
}

// ============================================================================
// Tool schema (provider-agnostic; adapter maps to Anthropic/OpenAI/... form)
// ============================================================================

export type ToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema draft-07 (opaque to kernel)
  requiresApproval: boolean
  version?: string
  schemaHash?: string
  toolsetId?: string
  toolsetVersion?: string
  risk?: 'read' | 'write' | 'shell' | 'network' | 'memory' | 'agent'
  executionKind?: 'host' | 'executor'
  executionHandler?: string
}

export type AgentModuleMetadata = {
  id: string
  version: string
  label: string
  systemPromptHash: string
  toolRegistryHash: string
  toolsets: readonly {
    id: string
    version: string
    label: string
    toolCount: number
  }[]
}

// ============================================================================
// Config (static, session-lifetime; separate from mutable state)
// ============================================================================

export type AgentConfig = {
  readonly tools: readonly ToolSchema[]
  /** Host policy for model-visible Tool schemas. Missing keeps historical full disclosure. */
  readonly toolDisclosureMode?: 'legacy_full' | 'progressive'
  readonly systemPrompt?: string
  readonly agentModule?: AgentModuleMetadata
  /** Model's total context window in tokens. Host context management owns pressure policy. */
  readonly contextLimit?: number
  /** Soft threshold ratio for host context management. */
  readonly softThreshold?: number
  /** Hard threshold ratio for host context management. */
  readonly hardThreshold?: number
  /** Maximum nested `agent` tool depth. Host hard-caps the default path to 1. */
  readonly maxAgentDepth?: number
  /**
   * Maximum concurrent sibling sub-agents under a single parent. Host default
   * is 8. Tool effects from one model response may execute concurrently, so
   * the Host atomically reserves fan-out capacity before creating each child.
   */
  readonly maxAgentFanOut?: number
  /**
   * Extended-thinking budget in tokens (Anthropic-only). When set to a
   * positive integer, the adapter requests the model's private reasoning
   * blocks up to this many tokens. Undefined = extended thinking off.
   * Ignored by non-Anthropic adapters.
   */
  readonly thinkingBudget?: number
}

// ============================================================================
// State
// ============================================================================

export type AgentStatus =
  | 'idle'              // waiting for user input
  | 'thinking'          // LLM call in flight
  | 'awaiting_approval' // one or more tool calls need user approval
  | 'executing_tools'   // tool calls dispatched, waiting for results
  | 'done'              // agent finished this turn
  | 'error'

export type PendingToolCall = {
  callId: string
  name: string
  input: Record<string, unknown>
  intent?: string
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'dispatched'
  /** Set only by a persisted user_approve transition, never by auto-dispatch. */
  explicitlyApproved?: boolean
}

export type UsageTotal = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
}

export const MEMORY_TOOL_NAME = 'memory'

/**
 * @deprecated Kernel no longer lifts memory entries into state. Kept for
 * consumers that still import the name; will be removed in a follow-up.
 * The `memory` tool executes entirely inside the executor; a session-scope
 * write echoes its (key, content) back through the normal tool_result and
 * dashboards derive their view from the timeline via a shadow-state
 * consumer on the host side.
 */
export type MemoryEntry = {
  readonly key: string
  readonly content: string
  readonly updatedAt: string
}

/**
 * Session-wide approval policy. Mid-turn changes take effect on the NEXT
 * tool call the LLM emits — pending calls that already went through the
 * approval branch keep their prior status until the user resolves them.
 *
 *   - 'auto' (default): honour `tool.requiresApproval`; safe tools dispatch,
 *     unsafe tools ask.
 *   - 'ask': every call needs approval, even `requiresApproval:false`.
 *   - 'deny': every approval-requiring call is auto-rejected; safe tools
 *     still dispatch. Useful for headless replays / demos.
 *   - 'allow_all': bypass approval for every call, even `requiresApproval:
 *     true`. Guard-railed at the host: config path only, never network.
 */
export type ApprovalMode = 'auto' | 'ask' | 'deny' | 'allow_all'

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto'

export type AgentStateCommon = {
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly usage: UsageTotal
  readonly cursor: number // monotonic event counter, for replay positioning
  readonly cwd?: string
  /**
   * Current approval policy. Defaults to `'auto'`; updated in place by
   * the `approval_mode_changed` event.
   */
  readonly approvalMode: ApprovalMode
  /** Durable override installed by a mid-session Settings update. */
  readonly systemPromptOverride?: {
    readonly prompt: string
    readonly version?: string | number
  }
}

export type AgentStatePhase =
  | { readonly status: 'idle'; readonly pendingCalls: readonly []; readonly error?: never }
  | { readonly status: 'thinking'; readonly pendingCalls: readonly []; readonly error?: never }
  | { readonly status: 'done'; readonly pendingCalls: readonly []; readonly error?: never }
  | { readonly status: 'awaiting_approval'; readonly pendingCalls: readonly PendingToolCall[]; readonly error?: never }
  | { readonly status: 'executing_tools'; readonly pendingCalls: readonly PendingToolCall[]; readonly error?: never }
  | { readonly status: 'error'; readonly pendingCalls: readonly []; readonly error: string }

export type AgentState = AgentStateCommon & AgentStatePhase

// ============================================================================
// Events (inputs to the reducer)
// ============================================================================

export type UserMessageEvent = {
  kind: 'user_message'
  /** Stable accepted-operation identity used for durable exactly-once Queue drain. */
  operationId?: string
  queuedAt?: string
  text?: string
  content?: readonly MessageContent[]
}

export type UsageDelta = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

export type LlmResponseEvent = {
  kind: 'llm_response'
  message: Message // must have role === 'assistant'
  usage?: UsageDelta
  /** Provider-native stop reason, e.g. Anthropic `stop_reason` or OpenAI `finish_reason`. */
  finishReason?: string
}

export type LlmErrorEvent = {
  kind: 'llm_error'
  error: string
}

export type UserApproveEvent = {
  kind: 'user_approve'
  callId: string
}

export type UserRejectEvent = {
  kind: 'user_reject'
  callId: string
  reason?: string
}

export type ToolResultEvent = {
  kind: 'tool_result'
  callId: string
  ok: boolean
  content: string
  failure?: ToolFailure
}

export type CancelEvent = {
  kind: 'cancel'
}

export type ClearEvent = {
  kind: 'clear'
}

export type EventArtifactRef = {
  kind?: string
  uri?: string
  path?: string
  sha256?: string
  bytes?: number
  mediaType?: string
  schemaVersion?: number
}

/**
 * Generic deterministic message rewrite. Runtime modules such as context
 * compaction own the policy and IO that produce this fact; the kernel only
 * validates the range against the current protocol state and applies the
 * replacement for replay/resume/fork determinism.
 */
export type MessagesReplacedEvent = {
  kind: 'messages_replaced'
  reason: 'compaction' | 'manual_rewrite' | 'recovery'
  replaceRange: {
    start: number
    end: number
  }
  replacementMessages: readonly Message[]
  /** Continue the autonomous turn from the compacted handoff. */
  resume?: boolean
  artifactRef?: EventArtifactRef
}

/**
 * Mid-session approval policy change. State-only; produces no effects.
 * Applies to any tool call emitted after this event.
 */
export type ApprovalModeChangedEvent = {
  kind: 'approval_mode_changed'
  mode: ApprovalMode
}

export type CwdChangedEvent = {
  kind: 'cwd_changed'
  cwd: string
}

/** Mid-session system prompt replacement. State-only; produces no effects. */
export type SystemPromptChangedEvent = {
  kind: 'system_prompt_changed'
  prompt: string
  version?: string | number
}

export type AgentEvent =
  | UserMessageEvent
  | LlmResponseEvent
  | LlmErrorEvent
  | UserApproveEvent
  | UserRejectEvent
  | ToolResultEvent
  | CancelEvent
  | ClearEvent
  | MessagesReplacedEvent
  | ApprovalModeChangedEvent
  | CwdChangedEvent
  | SystemPromptChangedEvent

// ============================================================================
// Effects (outputs from the reducer; host performs the actual IO)
// ============================================================================

export type CallLlmEffect = {
  kind: 'call_llm'
  messages: readonly Message[]
  tools: readonly ToolSchema[]
}

export type CallToolEffect = {
  kind: 'call_tool'
  callId: string
  name: string
  input: Record<string, unknown>
  intent?: string
  cwd?: string
}

export type RequestApprovalEffect = {
  kind: 'request_approval'
  callId: string
  name: string
  input: Record<string, unknown>
  intent?: string
}

export type FinishEffect = {
  kind: 'finish'
}

export type EmitErrorEffect = {
  kind: 'emit_error'
  error: string
}

export type Effect =
  | CallLlmEffect
  | CallToolEffect
  | RequestApprovalEffect
  | FinishEffect
  | EmitErrorEffect

// ============================================================================
// StepResult
// ============================================================================

export type StepResult = {
  next: AgentState
  effects: readonly Effect[]
  transition: TransitionDisposition
}

export type TransitionDisposition = {
  outcome: 'applied' | 'ignored' | 'rejected'
  from: AgentStatus
  to: AgentStatus
  event: AgentEvent['kind']
  reason?: 'event_not_legal_in_state' | 'invalid_event_payload' | 'invariant_violation'
}

/** Internal handler result before `step` attaches transition diagnostics. */
export type HandlerResult = Omit<StepResult, 'transition'> & {
  rejectionReason?: 'invalid_event_payload'
}
