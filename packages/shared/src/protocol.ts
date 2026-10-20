/**
 * Wire protocol types. Shared verbatim between host, executor, and dashboard.
 *
 * Every message that crosses process boundaries is typed here. If a client
 * matches this file, it interoperates with the host. Any change here MUST
 * also update `docs/protocol/wire-protocol.md` in the same PR.
 */

import type {
  AgentConfig,
  AgentModuleMetadata,
  AgentEvent,
  AgentState,
  ApprovalMode,
  Effect,
  MessageContent,
  UsageTotal,
} from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from './context-usage/types.js'
import type { LLMTrace } from './log.js'
import type { DagGraphPatch, DagRun } from './dag.js'

export type AgentRuntimeId = 'kernel' | 'copilot'
export type SessionExecutionMode = 'chat' | 'dag'

export type AgentRuntimeCapabilities = {
  readonly queue: boolean
  readonly fork: boolean
  readonly compact: boolean
  readonly clear: boolean
  readonly approvalMode: boolean
  readonly workspace: boolean
  readonly cwdMutation: boolean
  readonly modelSelection: boolean
  readonly attachments: boolean
  readonly memoryConsolidation: boolean
  readonly customTools: boolean
  readonly nativeReasoning: boolean
}

export type RuntimeCompactionPolicy = {
  readonly authority: 'host' | 'runtime'
  readonly automatic: {
    readonly enabled: boolean
    readonly mode: 'safe_boundary' | 'background'
    readonly warningThreshold: number
    readonly startThreshold: number
    readonly blockingThreshold?: number
    readonly concurrentWorkAllowed: boolean
  }
  readonly manual: {
    readonly supported: boolean
    readonly whileActive: 'reject' | 'queue' | 'runtime_managed'
  }
  readonly summary: {
    readonly authority: 'host' | 'runtime'
    readonly validation: 'host_gate' | 'runtime_reported'
  }
}

export function kernelRuntimeCompactionPolicy(
  softThreshold = 0.75,
  hardThreshold = 0.92,
): RuntimeCompactionPolicy {
  return {
    authority: 'host',
    automatic: {
      enabled: true,
      mode: 'safe_boundary',
      warningThreshold: softThreshold,
      startThreshold: hardThreshold,
      concurrentWorkAllowed: false,
    },
    manual: {
      supported: true,
      whileActive: 'reject',
    },
    summary: {
      authority: 'host',
      validation: 'host_gate',
    },
  }
}

export function copilotRuntimeCompactionPolicy(
  backgroundCompactionThreshold = 0.8,
  bufferExhaustionThreshold = 0.95,
): RuntimeCompactionPolicy {
  return {
    authority: 'runtime',
    automatic: {
      enabled: true,
      mode: 'background',
      warningThreshold: backgroundCompactionThreshold,
      startThreshold: backgroundCompactionThreshold,
      blockingThreshold: bufferExhaustionThreshold,
      concurrentWorkAllowed: true,
    },
    manual: {
      supported: true,
      whileActive: 'reject',
    },
    summary: {
      authority: 'runtime',
      validation: 'runtime_reported',
    },
  }
}

export const COPILOT_RUNTIME_COMPACTION_POLICY = copilotRuntimeCompactionPolicy()

export type AgentRuntimeDescriptor = {
  readonly id: AgentRuntimeId
  readonly label: string
  readonly description: string
  readonly available: boolean
  readonly status: 'ready' | 'disabled' | 'unavailable'
  readonly reason?: string
  readonly version?: string
  readonly capabilities: AgentRuntimeCapabilities
  readonly compactionPolicy?: RuntimeCompactionPolicy
  readonly models?: readonly ModelInfo[]
}

export const KERNEL_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  queue: true,
  fork: true,
  compact: true,
  clear: true,
  approvalMode: true,
  workspace: true,
  cwdMutation: true,
  modelSelection: true,
  attachments: true,
  memoryConsolidation: true,
  customTools: true,
  nativeReasoning: false,
}

export const COPILOT_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  queue: true,
  fork: false,
  compact: true,
  clear: false,
  approvalMode: true,
  workspace: true,
  cwdMutation: false,
  modelSelection: true,
  attachments: true,
  memoryConsolidation: false,
  customTools: true,
  nativeReasoning: true,
}

// ============================================================================
// Handshake
// ============================================================================

export type ClientRole = 'dashboard' | 'executor'

/**
 * Dashboard connections carry a `sessionId` (the session they subscribe to).
 * Executor connections do NOT — an executor daemon serves all sessions the
 * host routes to it. `sessionId` on individual `tool:call` / `tool:cancel`
 * messages is the per-call routing key.
 */
export type HandshakeAuth = {
  role: ClientRole
  sessionId?: string
  clientId?: string
  resumeToken?: string
  token?: string
  invite?: string
  installId?: string
  clientVersion: string
}

// ============================================================================
// Common events — Host broadcasts to all clients in a session room
// ============================================================================

export type SessionReadyEvent = {
  sessionId: string
  agentRuntime: AgentRuntimeId
  executionMode: SessionExecutionMode
  agentRuntimeCapabilities: AgentRuntimeCapabilities
  /** Added in protocol 1.1; older same-major Hosts may omit it. */
  runtimeCompactionPolicy?: RuntimeCompactionPolicy
  /** Latest root compaction lifecycle state, when an attempt is active during hydration. */
  compactStatus?: CompactStatusEvent
  cursor: number
  state: AgentState
  config: AgentConfig
  contextSnapshot: ContextUsageSnapshot
  /** Host-owned, durable start of the current/latest committed user turn. */
  turnStartedAt?: string
  /** Current uncommitted assistant text; restored on a mid-stream subscription. */
  streamingDraft?: { text: string; afterSeq: number; messageCount: number }
  /**
   * Why this event fired. `'load'` (default) — a dashboard subscribed to an
   * existing or ephemeral session. `'created'` — the session was just
   * materialised via `client:create_session`. `'forked'` — the session was
   * just spawned via `client:fork`; `parentSessionId` + `parentCursor` are
   * guaranteed to be populated in this case. Consumers use `reason` to
   * decide UI behaviour (e.g. jump to the new session on fork) but the
   * envelope shape is identical across all three.
   */
  reason?: 'load' | 'created' | 'forked'
  parentSessionId?: string
  parentCursor?: number
  /** Parent `agent` tool_call id when this ready event is for a child session. */
  parentCallId?: string
  /** Display/type label requested for the sub-agent, when provided. */
  agentType?: string
  /** Spawn timestamp for child sessions created by the `agent` tool. */
  subAgentStartedAt?: string
  /**
   * Routing key: the workspaceId this session is bound to. Undefined for
   * legacy sessions predating the field.
   */
  workspaceId?: string
  /** Display label captured at session-create time. */
  workspaceName?: string
  selectedModel?: string
}

/**
 * Per-session runtime preferences. Not part of `AgentConfig` (which is
 * immutable at session creation) and not part of `AgentState` (which is
 * kernel-owned and model-agnostic). Lives in a fourth category: UI-owned,
 * mutable, per-session settings that the operator adjusts and the host
 * persists.
 *
 * Every field is optional so this envelope is stable when new preferences
 * arrive — a v(N+1) dashboard can send extra fields to a v(N) host without
 * a version bump as long as the host ignores unknown fields (it does).
 *
 * v1 fields:
 *   - selectedModel: which LLM to route this session's `call_llm` effects to.
 *
 * Future candidates: preferred approval mode default, context pressure
 * threshold overrides, editor language, UI density, etc.
 */
export type ToolCardMode = 'dots' | 'standard'
export type RightPanelTab = 'files' | 'git' | 'terminal' | 'inspector' | 'scheduledTasks'
export type ChapterReadingMode = 'chapters' | 'continuous'

export type SessionPreferences = {
  selectedModel?: string
  toolCardMode?: ToolCardMode
  transcriptViewStart?: number
  rightPanelTab?: RightPanelTab
  chapterReadingMode?: ChapterReadingMode
}

/** Null clears the Session override; omitted keys stay unchanged. */
export type SessionPreferencesPatch = Omit<SessionPreferences, 'chapterReadingMode'> & {
  chapterReadingMode?: ChapterReadingMode | null
}

export type ClientUpdatePreferences = {
  operationId?: string
  sessionId: string
  preferences: SessionPreferencesPatch
}

// ============================================================================
// Unified control-plane push channel
// ============================================================================

/**
 * A single wire event — `server:control_update` — carries every "something
 * outside the kernel changed" push. This replaces the ~8 individual
 * push-event names that previously fanned out for renames, preferences,
 * executor attaches/detaches, background-task lifecycle, sub-agent
 * lifecycle, and tool-progress deltas.
 *
 * The `kind` field is the discriminator. Dashboard code should `switch`
 * on it (with an exhaustive default that logs an unknown kind rather
 * than throws — so a v(N+1) host can push a new kind to a v(N)
 * dashboard without crashing it).
 *
 * Dashboard code should subscribe to `server:control_update` and read from the
 * payload instead of wiring one listener per metadata subsystem.
 */
export type ControlUpdate =
  | ({ kind: 'session_meta_changed' } & SessionMetaChanged)
  | { kind: 'session_summary_changed'; session: SessionSummary }
  | ({ kind: 'workspace_meta_changed' } & WorkspaceMetaChanged)
  | ({ kind: 'executor_changed' } & ServerExecutorChangedPayload)
  | ({ kind: 'host_restart' } & HostRestartEvent)
  | ({ kind: 'bg_task_updated' } & ServerBgTaskUpdated)
  | ({ kind: 'bg_task_evicted' } & ServerBgTaskEvicted)
  | ({ kind: 'sub_agent_started' } & ServerSubAgentStartedEvent)
  | ({ kind: 'sub_agent_finished' } & ServerSubAgentFinishedEvent)
  | ({ kind: 'tool_progress' } & ToolProgressPayload)

/**
 * "Something about the session's metadata changed." Groups rename +
 * preferences + any future per-session UI-owned mutation. Any field left
 * `undefined` means "unchanged since last snapshot"; the dashboard merges
 * with its current view.
 */
export type SessionMetaChanged = {
  sessionId: string
  label?: string
  preferences?: SessionPreferences
}

export type WorkspaceMetaChanged = {
  workspaceId: string
  workspaceName: string
}

/**
 * Streaming progress for long-running tools. `chunk` is arbitrary text
 * the executor wants surfaced (e.g. lines from a long-running build).
 * Ordering per (sessionId, callId) is preserved; interleaving across
 * callIds is best-effort.
 */
export type ToolProgressPayload = {
  sessionId: string
  callId: string
  chunk: string
}

export type StateChangedEvent = {
  sessionId: string
  cursor: number
  state: AgentState
  contextSnapshot: ContextUsageSnapshot
  /** Host-owned, durable start of the current/latest committed user turn. */
  turnStartedAt?: string
}

export type HostRestartMode = 'checkpoint' | 'when_idle' | 'force'

export type HostRestartReason = 'manual' | 'deploy' | 'settings_changed'

export type HostRestartPhase =
  | 'idle'
  | 'requested'
  | 'draining'
  | 'checkpoint_reached'
  | 'restarting'
  | 'recovering'
  | 'completed'
  | 'aborted'
  | 'failed'

export type HostRestartSessionCheckpointStatus =
  | 'already_safe'
  | 'waiting_llm'
  | 'waiting_tool'
  | 'waiting_turn'
  | 'waiting_idle'
  | 'safe'
  | 'failed'

export type HostRestartResumeAction =
  | 'none'
  | 'wait_for_approval'
  | 'continue_turn'
  | 'drain_queue'

export type HostRestartSessionPlan = {
  sessionId: string
  parentSessionId?: string
  parentCallId?: string
  cursor: number
  initialStatus: AgentState['status']
  checkpointStatus: HostRestartSessionCheckpointStatus
  checkpointKind?: 'resting' | 'before_llm' | 'before_tool_dispatch' | 'waiting_for_approval'
  resumeAction: HostRestartResumeAction
  continuationKey?: string
  label?: string
  workspaceId?: string
  workspaceName?: string
  error?: string
}

export type HostRestartRecoveryReceipt = {
  continuationKey: string
  baselineCursor: number
  state: 'pending' | 'running' | 'adopted' | 'settled' | 'failed'
  observedCursor?: number
  startedAt?: string
  adoptedAt?: string
  settledAt?: string
  error?: string
}

export type HostRestartAttempt = {
  attemptId: string
  phase: HostRestartPhase
  mode: HostRestartMode
  reason: HostRestartReason
  requestedAt: string
  updatedAt: string
  oldPid: number
  newPid?: number
  /** Slot-deployment ownership. A replacement must match every supplied fence. */
  deployment?: {
    deploymentId: string
    targetReleaseDigest: string
    expectedRouteGeneration: number
    fencingToken: string
  }
  timeoutMs?: number
  sessions: readonly HostRestartSessionPlan[]
  /** Durable per-Session continuation state. `adopted` fences ownership before effects run. */
  recoveryReceipts?: Readonly<Record<string, HostRestartRecoveryReceipt>>
  command?: readonly string[]
  error?: string
}

export type HostRestartStatus = {
  pid: number
  startedAt: string
  current: HostRestartAttempt | null
  last: HostRestartAttempt | null
}

export type HostRestartEvent = HostRestartAttempt

export type { ContextUsageSnapshot }

export type EventAppendedEvent = {
  sessionId: string
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly Effect[]
  hasEffectsArtifact?: boolean
  hasLlmTraceArtifact?: boolean
  llmTrace?: LLMTrace
  model?: string
  timing?: import('./turn-timing.js').EventTimingMetadata
  /**
   * Rich metadata for `messages_replaced (reason='compaction')` events.
   * The kernel event itself only carries `replaceRange` +
   * `replacementMessages`; the actual token deltas and what triggered the
   * compaction live in the host's runtime-metadata ledger. We surface them
   * here so both live streams (`event:appended`) and history replay
   * (`server:history`) render the CompactBoundary honestly instead of
   * defaulting to `0 -> 0 tokens · unknown trigger`.
   *
   * Absent for any event kind other than `messages_replaced (compaction)`
   * and, for older sessions predating the metadata plumbing, also absent
   * on their compaction events.
   */
  compactionMetadata?: CompactionMetadata
}

/**
 * Wire form of the `runtime_metadata` `compaction_applied` record, kept in
 * lock-step with what {@link CompactStatusEvent} `kind:'done'` and the host
 * JSONL runtime-metadata ledger already carry. Values are estimates from
 * the same tokeniser the context-usage snapshots use.
 */
export type CompactionMetadata = {
  trigger: 'manual' | 'auto' | 'preflight' | 'tool_result'
  attemptId?: string
  tokensBefore: number
  tokensAfter: number
  /** Number of transcript messages replaced by the summarised prefix. */
  replacedCount: number
}

export type ClientLoadLogArtifact = {
  sessionId: string
  seq: number
}

export type ServerLogArtifactPayload = {
  sessionId: string
  seq: number
  effects?: readonly Effect[]
  llmTrace?: LLMTrace
  error?: string
}

export const SESSION_ERROR_SCOPES = ['kernel', 'llm', 'executor', 'host'] as const
export type SessionErrorScope = (typeof SESSION_ERROR_SCOPES)[number]

export type SessionErrorEvent = {
  sessionId: string
  scope: SessionErrorScope
  message: string
}

/**
 * Compaction lifecycle broadcast — sent on every attempt so every attached
 * dashboard sees the same "Compacting…" indicator, not just the one that
 * fired the request.
 */
export type CompactStatusEvent =
  | {
      sessionId: string
      kind: 'running'
      trigger: 'manual' | 'auto' | 'preflight' | 'tool_result'
      /** Estimated tokens in context BEFORE the compaction attempt. */
      tokensBefore: number
      attemptId: string
      startedAt: string
      authority?: RuntimeCompactionPolicy['authority']
      scope?: { kind: 'root' | 'subagent'; agentId?: string }
      startSnapshot?: ContextUsageSnapshot
    }
  | {
      sessionId: string
      kind: 'done'
      attemptId: string
      tokensBefore: number
      tokensAfter: number
      trigger?: 'manual' | 'auto' | 'preflight' | 'tool_result'
      replacedCount?: number
      /** LLM-generated compacted context, when the Runtime exposes it. */
      summary?: string
      endedAt: string
      authority?: RuntimeCompactionPolicy['authority']
      scope?: { kind: 'root' | 'subagent'; agentId?: string }
      startSnapshot?: ContextUsageSnapshot
      completionSnapshot?: ContextUsageSnapshot
      summaryValidation?: RuntimeCompactionPolicy['summary']['validation']
    }
  | {
      sessionId: string
      kind: 'skipped'
      attemptId: string
      /** Matches the runtime-metadata reason code. */
      reason: string
      message?: string
      endedAt: string
      authority?: RuntimeCompactionPolicy['authority']
      scope?: { kind: 'root' | 'subagent'; agentId?: string }
    }
  | {
      sessionId: string
      kind: 'error'
      attemptId: string
      message: string
      endedAt: string
      authority?: RuntimeCompactionPolicy['authority']
      scope?: { kind: 'root' | 'subagent'; agentId?: string }
    }

// ============================================================================
// Dashboard → Host
// ============================================================================

export type ClientUserMessage = {
  operationId?: string
  sessionId: string
  text: string
  /** Explicit operator intent. A leading `!` is never executable without `shell`. */
  intent: 'text' | 'shell'
  mode?: 'steer' | 'queue'
  /**
   * Structured content blocks. When present, kernel uses these verbatim
   * (mixing text + image blocks from pasted screenshots); `text` is kept as
   * a plain-text mirror for logs and non-image adapters.
   */
  content?: readonly MessageContent[]
}

export type ClientUserApprove = {
  operationId?: string
  sessionId: string
  callId: string
}

export type ClientUserReject = {
  operationId?: string
  sessionId: string
  callId: string
  reason?: string
}

export type AskUserChoiceOption = {
  value: string
  label?: string
  description?: string
}

export type AskUserChoiceRequest = {
  sessionId: string
  callId: string
  message: string
  choices: readonly AskUserChoiceOption[]
  defaultValue?: string
  defaultValues?: readonly string[]
  multiple?: boolean
  intent?: string
}

export type ClientAskUserChoice = {
  operationId?: string
  sessionId: string
  callId: string
  value?: string
  values?: readonly string[]
  customText?: string
}

export type ClientCancel = {
  operationId?: string
  sessionId: string
}

export type ClientClear = {
  sessionId: string
}

export type ClientCompact = {
  sessionId: string
}

/**
 * Abort the in-flight LLM call for a session. The host tears down the
 * network request (via AbortController) and lets the loop synthesize a
 * normal `llm_response` from whatever partial text was already streamed —
 * append `[cancelled]` so operators can spot it. Idempotent: emitting it
 * for a session that isn't streaming is a no-op.
 */
export type ClientCancelStream = {
  sessionId: string
}

export type ClientInterruptSubAgent = {
  parentSessionId: string
  parentCallId: string
  childSessionId?: string
}

export type ServerTokenDeltaEvent = {
  sessionId: string
  /** UTF-8 text delta appended to the current assistant message. */
  text: string
}

export type ClientSetApprovalMode = {
  operationId?: string
  sessionId: string
  mode: ApprovalMode
}

export type ClientFork = {
  sourceSessionId: string
  cursor: number
  newSessionId?: string
  /**
   * Optional first user message to dispatch on the freshly-forked session in
   * the same operation. Used by "edit and rerun" — dashboard forks at the
   * cursor *before* the message the user edited, then seeds the edited text
   * so the child session runs to completion without a second roundtrip.
   */
  seedMessage?: string
}

/**
 * Ask the host to materialise a session on disk with a workspace binding.
 * Dashboard emits this when the user clicks "New" so the Explorer row shows
 * up immediately (instead of waiting until the first user_message triggers
 * lazy-create) and the session's workspaceId is set from the start.
 * Idempotent — a second emit for the same id is a no-op on the store side.
 */
export type ClientCreateSession = {
  operationId?: string
  sessionId: string
  agentRuntime?: AgentRuntimeId
  /** Session-level execution semantics. Missing means Standard Chat for legacy clients. */
  executionMode?: SessionExecutionMode
  /**
   * Bind the session to a workspace. Optional — when omitted, the session
   * is unbound and any online executor may run its tools (legacy fallback).
   * Simple-chat sessions (no fs/shell tools, temp cwd) omit this.
   */
  workspaceId?: string
  workspaceName?: string
  /** Initial tool cwd for the session. When workspaceId is set, validated against the workspace sandbox. */
  cwd?: string
  /**
   * Optional allowlist of tool names. When set, the host derives the
   * session's tool set by filtering `defaultConfig.tools` to only these
   * names. Undefined = use `defaultConfig.tools` unchanged.
   */
  tools?: readonly string[]
  selectedModel?: string
}

export type ClientGetDagRun = {
  operationId?: string
  sessionId: string
}

export type ClientListDagRuns = {
  operationId?: string
  sessionId: string
}

export type ClientInitializeDag = {
  sessionId: string
  operationId: string
  objective: string
  graph: DagGraphPatch
}

export type ClientAnswerDagDecision = {
  operationId: string
  sessionId: string
  runId: string
  decisionId: string
  answer: string
}

export type ServerDagRunEvent = {
  sessionId: string
  run: DagRun | null
}

export type ClientListDirs = {
  requestId: string
  workspaceId: string
  sessionId?: string
  path?: string
}

export type ClientCreateDirectory = {
  requestId: string
  workspaceId: string
  sessionId?: string
  parentPath: string
  name: string
}

export type ClientSubscribe = {
  sessionId: string
}

export type ClientUnsubscribe = {
  sessionId: string
}

export type DashboardChannel = 'global' | `workspace:${string}` | `session:${string}`
export type ClientSubscribeChannels = { requestId: string; generation: number; channels: DashboardChannel[]; cursors?: Record<string, number> }
export type ClientUnsubscribeChannels = { requestId: string; generation: number; channels: DashboardChannel[] }
export type ChannelSubscriptionResult = { requestId: string; generation: number; accepted: DashboardChannel[]; rejected: Array<{ channel: DashboardChannel; code: string }>; cursors: Record<string, number> }

export type ClientSetCwd = {
  operationId?: string
  sessionId: string
  cwd: string
}

export type ClientReorderQueuedMessage = {
  operationId?: string
  sessionId: string
  id: string
  beforeId?: string | null
}

export type ClientUpdateQueuedMessage = {
  operationId?: string
  sessionId: string
  id: string
  text: string
  content?: readonly MessageContent[]
}

export type ClientDeleteQueuedMessage = {
  operationId?: string
  sessionId: string
  id: string
}

/**
 * Rename a session. Empty/whitespace label clears the override, causing the
 * dashboard to fall back to `firstUserMessage`. Host writes a metadata log
 * entry so summaries survive host restarts.
 */
export type ClientRenameSession = {
  operationId?: string
  sessionId: string
  label: string
}

/**
 * Rename a workspace display label. The stable `workspaceId` used for tool
 * routing is unchanged; this only changes the operator-facing name shown in
 * dashboards and persisted session summaries.
 */
export type ClientRenameWorkspace = {
  operationId?: string
  workspaceId: string
  workspaceName: string
}

// ============================================================================
// Host → Dashboard only
// ============================================================================

export type ApprovalRequiredEvent = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  intent?: string
}

// ============================================================================
// Executor → Host
// ============================================================================

export type ExecutorRuntime = 'node' | 'browser-webcontainer' | 'other'

export type ExecutorOs = 'linux' | 'darwin' | 'win32' | 'other'

export type BuildMetadata = {
  releaseTag: string
  /** Semantic product version, independent from channel-like release tags. */
  productVersion?: string
  gitCommit: string
  builtAt: string
  artifactKind: 'source' | 'cjs' | 'native'
  dashboardMode: 'vite' | 'static' | 'embedded' | 'none'
  embeddedDashboardFiles?: number
  socketAdminMode?: 'embedded' | 'filesystem' | 'missing'
  embeddedSocketAdminFiles?: number
}

export type ExecutorCapabilities = {
  schemaVersion: 1
  features: {
    backgroundShell: boolean
    filePicker: boolean
    overflowFiles: boolean
    workspaceSandbox: boolean
  }
}

/** A model-visible third-party tool discovered by the workspace Executor. */
export type McpToolDescriptor = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** SHA-256 of the descriptor's recursively key-sorted inputSchema JSON. */
  schemaHash: string
}

/** Privileged Dashboard-managed stdio MCP configuration; args may contain secrets. Never log or echo it to the browser. */
export type ManagedMcpServer = {
  name: string
  command: string
  args: string[]
}

export type ExecutorMcpConfigureRequest = {
  requestId: string
  servers: ManagedMcpServer[]
}

export type ExecutorMcpConfigureAck = {
  ok: boolean
  error?: string
}

export type ExecutorMcpConfigStatusRequest = {
  requestId: string
}

export type ExecutorMcpConfigStatusAck = {
  ok: boolean
  /** Names only; do not send command or arguments back to the Host. */
  servers?: Array<{ name: string }>
  error?: string
}

export type ExecutorAnnounce = {
  executorId: string
  installId?: string
  /** agent-kernel executor package version. */
  executorVersion?: string
  build?: BuildMetadata
  capabilities?: ExecutorCapabilities
  /**
   * Stable machine identity. A ULID minted on the executor's first launch
   * and persisted (see packages/executor/src/workspace-id.ts). Sessions
   * bind to this in their JSONL header; Host routes tool calls by matching
   * `session.workspaceId` against a live executor. Never renamed — a lost
   * or regenerated id detaches the machine's existing sessions, which is
   * why the executor refuses to boot with a corrupted id file.
   */
  workspaceId: string
  /**
   * Human-readable workspace label. Display only — the operator can
   * change it freely via `--name` without affecting routing. Falls back
   * to `os.hostname()` when the operator doesn't pass a name.
   */
  workspaceName: string
  tools: string[]
  /** Optional for compatibility with Executors predating MCP discovery. */
  mcpTools?: McpToolDescriptor[]
  toolImplementations?: Record<string, { version: string }>
  /** Optional filesystem jail. Empty/missing = executor trusts whole machine. */
  sandboxRoots?: string[]
  /** Executor startup/default cwd used as a filesystem-picker fallback. */
  defaultCwd?: string
  /** @deprecated Use `defaultCwd`; accepted for older executor bundles. */
  workingDir?: string
  runtime: ExecutorRuntime
  runtimeVersion: string
  hostname?: string
  os?: ExecutorOs
  ipAddresses?: string[]
  pid?: number
  startedAt?: string
}

export type DirListEntry = {
  name: string
  path: string
  type?: 'directory' | 'file'
  size?: number
}

export type DirListResult = {
  requestId: string
  workspaceId: string
  path: string
  roots: readonly string[]
  entries: readonly DirListEntry[]
  error?: string
}

export type CreateDirectoryResult = {
  requestId: string
  workspaceId: string
  path: string
  parentPath: string
  roots: readonly string[]
  created: boolean
  error?: string
}

/**
 * Dashboard-driven fuzzy file search for the composer's `@file` mention picker.
 * Executor walks the workspace root(s), skipping node_modules/.git/dist, and
 * returns up to `limit` file paths (workspace-relative) that match `query`.
 */
export type ClientListFiles = {
  requestId: string
  workspaceId: string
  sessionId?: string
  query?: string
  limit?: number
}

export type FileListEntry = {
  path: string
  size: number
}

export type FileListResult = {
  requestId: string
  workspaceId: string
  files: readonly FileListEntry[]
  truncated: boolean
  error?: string
}

/**
 * Dashboard-driven read of a single workspace file for `@file` inline expansion.
 * Executor refuses paths outside the workspace or files above `maxBytes`
 * (default 64 KiB) so the composer can render an inline toast.
 */
export type ClientReadFile = {
  requestId: string
  workspaceId: string
  sessionId?: string
  path: string
  maxBytes?: number
  download?: boolean
}

export type FileContentsResult = {
  requestId: string
  workspaceId: string
  path: string
  content?: string
  size?: number
  fileVersion?: string
  kind?: 'text' | 'image' | 'pdf' | 'binary' | 'too_large' | 'not_found' | 'error'
  encoding?: 'utf8' | 'base64'
  mediaType?: string
  truncated?: boolean
  error?: string
}

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechanged'

export type GitFileChange = {
  path: string
  oldPath?: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

export type ClientGitStatus = {
  requestId: string
  workspaceId: string
  sessionId?: string
  cwd?: string
}

export type GitStatusResult = {
  requestId: string
  workspaceId: string
  repo?: {
    root: string
    branch?: string
    head?: string
  }
  files: readonly GitFileChange[]
  truncated?: {
    reason: 'too_many_files' | 'timeout' | 'too_large'
    limit: number
  }
  error?: {
    code:
      | 'not_git_repo'
      | 'executor_unavailable'
      | 'git_unavailable'
      | 'timeout'
      | 'workspace_not_found'
      | 'internal_error'
    message: string
  }
}

export type ClientGitDiff = {
  requestId: string
  workspaceId: string
  sessionId?: string
  path: string
  cwd?: string
  staged?: boolean
}

export type GitDiffResult = {
  requestId: string
  workspaceId: string
  file?: GitFileChange
  oldText?: string
  newText?: string
  language?: string
  truncated?: {
    side: 'old' | 'new' | 'both'
    maxBytes: number
  }
  error?: {
    code:
      | 'not_git_repo'
      | 'executor_unavailable'
      | 'git_unavailable'
      | 'file_not_found'
      | 'binary_file'
      | 'too_large'
      | 'timeout'
      | 'workspace_not_found'
      | 'internal_error'
    message: string
  }
}

/**
 * Fetch the full contents of an overflowed tool result. When a tool's output
 * exceeds the executor's inline byte cap, the executor spills the full text
 * to `<workspaceRoot>/.kala/overflow/<sessionId>/<callId>.txt` and
 * emits only a preview + marker inline. The dashboard's "View full output"
 * button issues this request to fetch the spill file.
 */
export type ClientReadOverflow = {
  requestId: string
  sessionId: string
  callId: string
}

export type OverflowContentsResult = {
  requestId: string
  sessionId: string
  callId: string
  content?: string
  size?: number
  error?: string
}

export type DeleteOverflowSession = {
  requestId: string
  sessionId: string
}

export type DeleteOverflowSessionResult = {
  requestId: string
  sessionId: string
  deleted: boolean
  error?: string
}

export type CopyOverflowSession = {
  requestId: string
  sourceSessionId: string
  targetSessionId: string
}

export type CopyOverflowSessionResult = {
  requestId: string
  sourceSessionId: string
  targetSessionId: string
  copied: boolean
  error?: string
}

/**
 * Background-shell control plane. Runs *alongside* the three built-in tools
 * (`bash{run_in_background}`, `bash_output`, `kill_shell`) — the tools remain
 * the way the agent starts/reads/kills tasks; these RPCs are the way the
 * dashboard operator directly observes and controls them without going
 * through the LLM. See docs/host/background-shell-design.md.
 *
 * Routed by `workspaceId` and owned by `sessionId`: a background task lives
 * in the executor, but only the session that spawned it can list, read, or
 * kill it by default.
 */
export type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'signaled'

export type BackgroundTaskSummary = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  /** Child process id while known. Optional for old executors / replayed data. */
  pid?: number
  /** ISO timestamp. */
  startedAt: string
  /** ISO timestamp; present iff status ≠ 'running'. */
  endedAt?: string
  status: BackgroundTaskStatus
  /** null while running or when terminated by signal. */
  exitCode: number | null
  signal: string | null
  /** Total stdout+stderr bytes observed (including bytes lost to ring-buffer wrap). */
  bytesLogged: number
  /** Bytes dropped because the on-disk log ring buffer wrapped. */
  bytesTruncated: number
}

export type ClientListBgTasks = {
  requestId: string
  workspaceId: string
  sessionId: string
}

export type BgListResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  tasks: readonly BackgroundTaskSummary[]
  error?: string
}

export type ClientReadBgOutput = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  /** Byte offset into `bytesLogged`. Missing → return the whole current buffer. */
  offset?: number
  /** Cap on returned slice size. Default 64 KiB, hard cap 1 MiB. */
  maxBytes?: number
}

export type BgOutputResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  content: string
  /** Offset the client should pass next time to continue tailing. */
  nextOffset: number
  /** True iff the task has ended (exit/kill/signal). */
  done: boolean
  status: BackgroundTaskStatus
  bytesTruncated: number
  error?: string
}

export type ClientTerminalCreate = {
  requestId: string
  workspaceId: string
  sessionId: string
  cwd?: string
  cols?: number
  rows?: number
}

export type TerminalCreateResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  terminalId?: string
  cwd?: string
  /** True when create returned the Session's already-running terminal. */
  reused?: boolean
  /** Buffered terminal output captured before a reused create request. */
  replay?: string
  error?: string
}

export type ClientTerminalInput = {
  workspaceId: string
  sessionId: string
  terminalId: string
  data: string
}

export type ClientTerminalResize = {
  workspaceId: string
  sessionId: string
  terminalId: string
  cols: number
  rows: number
}

export type ClientTerminalKill = {
  requestId: string
  workspaceId: string
  sessionId: string
  terminalId: string
}

export type ClientTerminalCloseSession = {
  workspaceId: string
  sessionId: string
}

export type TerminalKillResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  terminalId: string
  killed: boolean
  error?: string
}

export type ServerTerminalOutput = {
  workspaceId: string
  sessionId: string
  terminalId: string
  data: string
}

export type ServerTerminalExit = {
  workspaceId: string
  sessionId: string
  terminalId: string
  exitCode: number | null
  signal: string | null
}

export type ClientKillBgTask = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
}

export type BgKillResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  /** False iff the task was already exited/killed at the time of the request. */
  killed: boolean
  error?: string
}

/**
 * Executor-originated push. Emitted on spawn, on every ~400 ms while output
 * is streaming (throttled), and on task end (exit/kill/signal). The optional
 * `delta` carries the new bytes appended since the previous push so the
 * dashboard's live tail doesn't need to poll for each chunk.
 */
export type ServerBgTaskUpdated = {
  workspaceId: string
  sessionId: string
  task: BackgroundTaskSummary
  delta?: {
    /** Offset within `task.bytesLogged` where this delta begins. */
    fromOffset: number
    content: string
  }
}

export type ServerBgTaskEvicted = {
  workspaceId: string
  sessionId: string
  taskId: string
}

/**
 * Sub-agent control plane. Runs alongside the `agent` builtin tool
 * (`packages/host/src/extensions/agent-tool.ts`): the tool remains the way the parent
 * LLM starts a child session, receives its final assistant text back as a
 * wrapped `<sub_agent>` envelope in `tool_result.content`, and moves on. The
 * events + RPCs here are how the *dashboard* observes the child inline
 * before the tool_result arrives — otherwise operators stare at a spinner
 * for the duration of the child's inner loop.
 *
 * Both events are fanned into the parent's `session:<parentSessionId>` room.
 * Dashboards use `sub_agent_started.childSessionId` to open a subscription
 * to the child's own room, then render its `event:appended` stream inline
 * via a nested read-only ChatPanel. See docs/host/sub-agent-design.md §5.
 */
export type ServerSubAgentStartedEvent = {
  parentSessionId: string
  /** The parent's `agent` tool_call callId. Ties the child to the row that spawned it. */
  parentCallId: string
  childSessionId: string
  /** Named agent type from the registry (e.g. 'general-purpose'). Undefined for anonymous spawns. */
  agentType?: string
  /** Short user-facing reason for delegating this child. Optional for historical calls. */
  intention?: string
  prompt: string
  /** Per-call model override, if the parent passed one. */
  model?: string
  /** ISO 8601 timestamp — the moment the host created the child session. */
  startedAt: string
}

export type ServerSubAgentFinishedEvent = {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out_with_partial_result'
  /** Turn count taken from the child's `state.cursor` on finish (approximate). */
  turns: number
  durationMs: number
  finishedAt: string
  /** Failure/cancellation reason. Present iff status !== 'completed'. */
  error?: string
}

/**
 * List children of a parent session. Backs the dashboard's log-replay path:
 * when a session is reopened from disk, the timeline's `<sub_agent>` envelopes
 * are self-describing, but the dashboard still needs the childSessionIds to
 * fetch on-demand. Read from `SessionStore` by scanning records with
 * `parentSessionId === X`.
 */
export type ClientListSubAgents = {
  requestId: string
  parentSessionId: string
}

export type SubAgentSummary = {
  childSessionId: string
  /**
   * The parent's `agent` tool_call callId. Present when the host can
   * correlate the child back to a specific parent tool call (usually via
   * an index maintained at spawn time). Undefined when the correlation is
   * unavailable — e.g. the RPC only inspected the SessionStore records
   * without walking the parent's transcript.
   */
  parentCallId?: string
  agentType?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** ISO 8601. Optional because pre-lifecycle-events records don't carry it. */
  startedAt?: string
  finishedAt?: string
  turns?: number
  durationMs?: number
  error?: string
}

export type SubAgentListResult = {
  requestId: string
  parentSessionId: string
  children: readonly SubAgentSummary[]
  error?: string
}

/**
 * List loaded agent-type definitions from the host's registry (built-ins +
 * workspace `.kala/agents/` + user `~/.config/kala/agents/`).
 * Used by the Composer's `@agent-name` mention affordance.
 */
export type ClientListAgentTypes = {
  requestId: string
}

export type AgentTypeSummary = {
  name: string
  description: string
  model?: string
  tools?: readonly string[]
  /** First ~200 chars of the system prompt for hover preview. */
  systemPromptPreview?: string
}

export type AgentTypesResult = {
  requestId: string
  types: readonly AgentTypeSummary[]
  error?: string
}

/**
 * User-initiated `/consolidate-memory` slash command. Host reads the
 * session's messages, runs a single LLM call to extract durable signal,
 * and writes the results into the workspace memory root via the executor's
 * `memory` tool. See docs/host/memory-consolidation.md.
 */
export type ClientConsolidateMemory = {
  requestId: string
  sessionId: string
}

export type ConsolidateMemoryResult = {
  requestId: string
  sessionId: string
  saved: readonly string[]
  skipped: number
  reason?: string
  error?: string
}

// ============================================================================
// Host → Executor
// ============================================================================

export type ToolCallMessage = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
  ackTimeoutMs?: number
  turnId?: string
}

export type ToolCancelMessage = {
  sessionId: string
  callId: string
}

export type ToolResultAck = {
  callId: string
  ok: boolean
  content: string
  failure?: import('@agent-kernel/kernel').ToolFailure
  durationMs?: number
}

// ============================================================================
// Socket.IO event maps
// ============================================================================

// ============================================================================
// Control-plane events (Dashboard ⇄ Host)
// ============================================================================

export type AttachedExecutor = ExecutorAnnounce & {
  attachedAt: string
  /**
   * The `clientVersion` from the executor's handshake auth. Recorded so the
   * dashboard can distinguish "os field is undefined because this executor
   * predates the field" from "executor connected but never got announced".
   */
  clientVersion?: string
}

export type ClientListExecutors = Record<string, never>

export type ServerExecutorsPayload = {
  executors: readonly AttachedExecutor[]
}

export type ExecutorChange = 'attached' | 'detached' | 'updated'

export type ServerExecutorChangedPayload =
  | { change: 'detached'; executorId: string }
  | {
      change: 'attached' | 'updated'
      executorId: string
      executor: AttachedExecutor
    }

export type ClientListSessions = Record<string, never>

export type SessionSummary = {
  sessionId: string
  agentRuntime: AgentRuntimeId
  executionMode: SessionExecutionMode
  agentRuntimeVersion?: string
  createdAt: string
  lastEventAt?: string
  eventCount: number
  parentSessionId?: string
  /**
   * The workspace this session is bound to (see ADR 0014). Routing key —
   * matches an executor's announced `workspaceId`. Written to the JSONL
   * header at create time; never rewritten. Sessions predating the field
   * have this undefined and render under a synthetic "unassigned" root
   * in the dashboard tree.
   */
  workspaceId?: string
  /**
   * Display label for the workspace, captured at session-create time.
   * Not authoritative — the current display name comes from the live
   * executor's announce when one is attached. Held here so the dashboard
   * can render offline workspaces without needing every executor online.
   */
  workspaceName?: string
  status?: AgentState['status']
  /**
   * Number of user messages queued for this session that have not yet been
   * dispatched. When >0, a transient `done`/`idle` status is NOT a real turn end
   * — a queued message will re-drive the session — so notifications must not
   * treat it as "finished / ready for you". Absent/0 means the queue is empty.
   */
  queuedCount?: number
  currentCwd?: string
  firstUserMessage?: string
  /**
   * Operator-provided display label from the most recent `client:rename_session`.
   * When unset the dashboard uses `firstUserMessage` as before.
   */
  label?: string
  preferences?: SessionPreferences
}

export type ServerSessionsPayload = {
  sessions: readonly SessionSummary[]
}

export type ClientLoadHistory = {
  sessionId: string
  sinceCursor?: number
}

export type ClientPrepareSessionRoute = { sessionId: string }

export type ClientDeleteSession = {
  operationId?: string
  sessionId: string
}

export const STORAGE_CATEGORIES = [
  'jsonl',
  'snapshot',
  'summary',
  'context',
  'session-artifacts',
  'orphan-artifacts',
  'backup',
  'corrupt',
  'other',
] as const

export type StorageCategory = typeof STORAGE_CATEGORIES[number]

export type StorageCategoryStats = {
  bytes: number
  files: number
}

export type StorageInventoryState = {
  measuredAt: string | null
  generation: number
  stale: boolean
  scan:
    | { status: 'idle' }
    | { status: 'scanning'; startedAt: string }
    | { status: 'failed'; startedAt: string; failedAt: string; error: string }
}

export type SessionStorageEntry = {
  sessionId: string
  parentSessionId?: string
  runtime?: string
  sessionLabel?: string
  workspaceId?: string
  workspaceName?: string
  directBytes: number
  treeBytes: number
  descendantCount: number
  categories: Partial<Record<StorageCategory, StorageCategoryStats>>
  treeCategories: Partial<Record<StorageCategory, StorageCategoryStats>>
}

export type SessionTokenUsage = {
  currentContextTokens: number
  cumulativeInputTokens: number
  cumulativeOutputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  sessionCount: number
}

export type SessionStorageSnapshot = {
  session: SessionStorageEntry
  descendants: readonly SessionStorageEntry[]
  tokenUsage?: {
    direct: SessionTokenUsage
    tree: SessionTokenUsage
  }
  state: StorageInventoryState
}

export type GlobalStorageSnapshot = {
  totalBytes: number
  totalFiles: number
  categories: Record<StorageCategory, StorageCategoryStats>
  largestSessionTrees: readonly SessionStorageEntry[]
  orphanCandidates: readonly {
    id: string
    category: 'orphan-artifacts' | 'snapshot' | 'summary' | 'context' | 'corrupt'
    bytes: number
    files: number
  }[]
  state: StorageInventoryState
}

export type ClientGetSessionStorage = {
  sessionId: string
  refresh?: boolean
}

export type ClientGetGlobalStorage = {
  refresh?: boolean
}

export type StorageCleanupOperation =
  | 'subagent-details'
  | 'session-tree'
  | 'orphan-artifacts'
  | 'derived-artifacts'

export type StorageCleanupPlanPreview = {
  planId: string
  operation: StorageCleanupOperation
  targetId: string
  sessionIds: readonly string[]
  estimatedBytes: number
  itemCount: number
  expiresAt: string
}

export type StorageCleanupResult = {
  planId: string
  operation: StorageCleanupOperation
  targetId: string
  logicalDeletion: true
  bytesQuarantined: number
  completedAt: string
}

export type ClientPrepareStorageCleanup = {
  operation: StorageCleanupOperation
  targetId: string
}

export type ClientExecuteStorageCleanup = {
  planId: string
}

export type ServerSessionDeletedPayload = {
  sessionId: string
}

export type ServerHistoryPayload = {
  sessionId: string
  entries: readonly EventAppendedEvent[]
}

/**
 * Advertised model. Returned by `GET /models` on the host. The dashboard uses
 * this to populate the model picker instead of hardcoding a list.
 */
export type ModelInfo = {
  /** Stable provider-qualified selection key. This is the only value session preferences persist. */
  ref: string
  id: string
  label: string
  provider: string
  providerId: string
  source?: ModelSource
  /** Model context window in tokens, when known by the host. */
  contextWindow?: number
  /** Structured limits supplied by provider metadata or the external model catalog. */
  limits?: ModelLimits
  metadataSource?: ModelMetadataSource
  metadataMatch?: ModelMetadataMatch
  /** Timestamp attached to the catalog snapshot used for this metadata. */
  catalogUpdatedAt?: string
}

export type ModelLimits = {
  context: number
  input?: number
  output?: number
}

export type ModelMetadataSource =
  | 'manual'
  | 'provider'
  | 'models.dev-live'
  | 'models.dev-cache'
  | 'models.dev-seed'
  | 'unknown'

export type ModelMetadataMatch =
  | 'provider-model-exact'
  | 'canonical-model-exact'
  | 'model-id-consensus'
  | 'none'

export type ModelSource = 'claude-settings' | 'codex-config' | 'env' | 'manual'
export type ProviderWire = 'anthropic' | 'openai'

export type ManualModelInput = {
  providerId: string
  id: string
  label?: string
  contextWindow?: number
}

export type ServerModelsPayload = {
  models: readonly ModelInfo[]
  defaultModel: string
}

/**
 * Host's advertised settings snapshot. Returned by `GET /settings`.
 *
 * The host reads provider credentials from operator-owned files, but the
 * dashboard may add/delete manual model ids bound to those existing provider
 * endpoints. Manual entries live in `paths.manualModels`; credentials remain
 * outside dashboard writes.
 *
 * Never contains API keys, hook payloads, or command args that could leak
 * env — the endpoint is served over the same socket the dashboard uses and
 * anyone with dashboard access could already fetch these, but we still
 * scrub secrets before serializing.
 */
export type SettingsProviderSummary = {
  id: string
  label: string
  wire: ProviderWire
  source?: ModelSource
  baseUrl?: string
  models: readonly ModelInfo[]
}

export type ManualProviderInput = {
  id: string
  label?: string
  wire: ProviderWire
  baseUrl: string
  apiKey: string
}

export type ClientAddManualProvider = ManualProviderInput

export type ClientDeleteManualProvider = {
  providerId: string
}

export type ClientAddManualModel = ManualModelInput

export type ClientDeleteManualModel = {
  providerId: string
  id: string
}

export type ClientSetDefaultModel = {
  model: string
}

export type AgentPromptSlotId = 'slot-1' | 'slot-2' | 'slot-3'

export type SettingsAgentPromptSlot = {
  id: AgentPromptSlotId
  name: string
  prompt: string
}

export type SettingsAgentPrompt = {
  selectedSlotId: AgentPromptSlotId
  slots: readonly SettingsAgentPromptSlot[]
  configPath: string
}

export type ClientUpdateAgentPromptSettings = Pick<SettingsAgentPrompt, 'selectedSlotId' | 'slots'>

export type SettingsHookSummary = {
  event: 'pre_tool_use' | 'post_tool_use' | 'session_start' | 'session_end'
  command: string
  match?: string
}

export type SettingsSkillDiagnostic = {
  level: 'warning'
  path: string
  message: string
}

export type SettingsSkillSummary = {
  count: number
  roots: readonly string[]
  diagnostics: readonly SettingsSkillDiagnostic[]
}

export type SocketConnectionAuditSnapshot = {
  total: number
  dashboard: number
  executor: number
  other: number
  namespaces: readonly {
    namespace: string
    sockets: number
    dashboard: number
    executor: number
    other: number
  }[]
  updatedAt: string
}

export type RuntimeCapabilities = {
  agent: boolean
  workspace: boolean
  operations: boolean
  artifacts: boolean
  pipeline: boolean
}

export const FULL_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  agent: true,
  workspace: true,
  operations: true,
  artifacts: true,
  pipeline: true,
}

export const AGENT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  agent: true,
  workspace: true,
  operations: false,
  artifacts: true,
  pipeline: false,
}

export type RuntimeCapabilitiesPayload = {
  product: import('./deployment.js').ProductVariant
  deployment: import('./deployment.js').ProductDeploymentConfig
  capabilities: RuntimeCapabilities
  integrations?: {
    evaluation?: { url: string }
  }
}

export type DedicatedDeploymentStatus = {
  schemaVersion: 1
  generatedAt: string
  topology: 'dedicated-slots'
  services?: { supervisor: { pid: number } }
  route: { generation: number; activeSlot: 'blue' | 'green'; activeReleaseId: string }
  slots: {
    blue: { pid: number; active: boolean; releaseId: string; releaseDigest?: string }
    green: { pid: number; active: boolean; releaseId: string; releaseDigest?: string }
  }
  writeLeaseOwnerPid?: number
  admission: { pending: number; leased: number; committed: number; failed: number; expired: number; oldestAgeMs: number; capacity: number }
  dashboard?: { schemaVersion: 1; generation: number; releaseId: string; releaseDigest: string; assetDigest: string; version: string; protocol: { min: string; max: string }; activatedAt: string }
  deployment: null | {
    deploymentId: string
    operationId: string
    phase: string
    requestedAt: string
    updatedAt: string
    releaseDigest: string
    sourceReleaseDigest: string
    previousSlot?: 'blue' | 'green'
    candidateSlot: 'blue' | 'green'
    processReadyAt?: string
    runtimeReadyAt?: string
    controlPlane?: { previousSupervisorPid: number; previousIngressPid: number; ingressPid: number; supervisorPid?: number; activatedAt: string; readyAt?: string }
    routeGeneration?: number
    blockers?: readonly string[]
    plannedRestart?: { attemptId: string; participants: number; checkpointed: number }
    continuation?: { participants: number; completed: number; failed: number; sessions?: readonly { sessionId: string; cursor: number; checkpointKind?: string; resumeAction: string; outcome: 'pending' | 'running' | 'adopted' | 'settled' | 'failed' }[] }
    rollback?: { predecessorReleaseId: string; outcome: 'pending' | 'completed' | 'failed'; pid?: number }
    error?: { code: string; message: string; at: string }
  }
}

export type ServerSettingsPayload = {
  deployment?: RuntimeCapabilitiesPayload
  providers: readonly SettingsProviderSummary[]
  defaultModel: string
  hooks: readonly SettingsHookSummary[]
  versions?: {
    host: string
    protocol: string
    build?: BuildMetadata
  }
  runtime?: HostRestartStatus
  socketConnections?: SocketConnectionAuditSnapshot
  agentModule?: AgentModuleMetadata
  agentPrompt?: SettingsAgentPrompt
  auth?: {
    dashboardAuthRequired: boolean
    githubOAuth: {
      required: boolean
      configured: boolean
      usernameWhitelistEnabled: boolean
      usernameWhitelist: readonly string[]
    }
    executorIdentity: {
      tokenScoped: boolean
      tokenCount: number
      inviteCount?: number
    }
  }
  socketAdmin?: {
    active: boolean
    initialized: boolean
    path: string
    username: string
    runtimeMode: 'production' | 'development'
    configuredMode: 'production' | 'development'
    configPath: string
    distSource?: 'embedded' | 'filesystem'
    createdAt?: string
    restartRequired?: boolean
  }
  paths: {
    claudeSettings: string
    codexConfig: string
    manualModels: string
    hooksConfig: string
    sessionsDir: string
  }
  mcp: {
    supported: boolean
    note: string
  }
  skills?: SettingsSkillSummary
  release?: {
    bootstrapBaseUrl: string
    source: 'local' | 'github'
  }
}

export type ExecutorIdentitySummary = {
  workspaceId: string
  label?: string
  createdAt: string
  lastSeenAt?: string
}

export type ServerExecutorIdentitiesPayload = {
  identities: readonly ExecutorIdentitySummary[]
}

export type ServerExecutorIdentityRevokedPayload = {
  ok: true
  workspaceId: string
  revoked: boolean
}

export type ExecutorInviteSummary = {
  id: string
  label?: string
  workspaceId?: string
  createdAt: string
  expiresAt: string
  lastUsedAt?: string
  revoked: boolean
}

export type ServerExecutorInvitesPayload = {
  invites: readonly ExecutorInviteSummary[]
}

export type ServerExecutorInvitePayload = Omit<ExecutorInviteSummary, 'revoked'> & {
  inviteToken: string
  revoked?: boolean
}

export type ServerExecutorInviteRevokedPayload = {
  ok: true
  id: string
  revoked: boolean
}

// ============================================================================
// Socket.IO event maps
// ============================================================================

export type RpcAck<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string }

export type DashboardClientToServerEvents = {
  'client:connection_ping': (sentAt: number, ack: (serverAt: number) => void) => void
  'client:executor_ping': (workspaceId: string, ack: (result: { rttMs?: number; error?: string }) => void) => void
  'client:user_message': (payload: ClientUserMessage, ack?: (result: RpcAck) => void) => void
  'client:user_approve': (payload: ClientUserApprove, ack?: (result: RpcAck) => void) => void
  'client:user_reject': (payload: ClientUserReject, ack?: (result: RpcAck) => void) => void
  'client:ask_user_choice': (payload: ClientAskUserChoice, ack?: (result: RpcAck) => void) => void
  'client:cancel': (payload: ClientCancel, ack?: (result: RpcAck) => void) => void
  'client:interrupt_sub_agent': (payload: ClientInterruptSubAgent) => void
  'client:clear': (payload: ClientClear) => void
  'client:compact': (payload: ClientCompact) => void
  'client:cancel_stream': (payload: ClientCancelStream) => void
  'client:set_approval_mode': (payload: ClientSetApprovalMode, ack?: (result: RpcAck) => void) => void
  'client:fork': (payload: ClientFork) => void
  'client:create_session': (payload: ClientCreateSession, ack?: (result: RpcAck) => void) => void
  'client:get_dag_run': (payload: ClientGetDagRun, ack: (result: RpcAck<DagRun | null>) => void) => void
  'client:list_dag_runs': (payload: ClientListDagRuns, ack: (result: RpcAck<readonly DagRun[]>) => void) => void
  'client:initialize_dag': (payload: ClientInitializeDag, ack: (result: RpcAck<DagRun>) => void) => void
  'client:answer_dag_decision': (payload: ClientAnswerDagDecision, ack: (result: RpcAck<DagRun>) => void) => void
  'client:list_dirs': (payload: ClientListDirs, ack?: (result: DirListResult) => void) => void
  'client:create_directory': (payload: ClientCreateDirectory, ack?: (result: CreateDirectoryResult) => void) => void
  'client:list_files': (payload: ClientListFiles) => void
  'client:read_overflow': (payload: ClientReadOverflow) => void
  'client:list_executors': (payload: ClientListExecutors) => void
  'client:list_sessions': (payload: ClientListSessions) => void
  'client:load_history': (payload: ClientLoadHistory) => void
  'client:prepare_session_route': (payload: ClientPrepareSessionRoute, ack: (result: RpcAck) => void) => void
  'client:load_log_artifact': (payload: ClientLoadLogArtifact) => void
  'client:get_session_storage': (payload: ClientGetSessionStorage, ack: (result: RpcAck<SessionStorageSnapshot>) => void) => void
  'client:get_global_storage': (payload: ClientGetGlobalStorage, ack: (result: RpcAck<GlobalStorageSnapshot>) => void) => void
  'client:prepare_storage_cleanup': (payload: ClientPrepareStorageCleanup, ack: (result: RpcAck<StorageCleanupPlanPreview>) => void) => void
  'client:execute_storage_cleanup': (payload: ClientExecuteStorageCleanup, ack: (result: RpcAck<StorageCleanupResult>) => void) => void
  'client:delete_session': (payload: ClientDeleteSession, ack?: (result: RpcAck) => void) => void
  'client:update_preferences': (payload: ClientUpdatePreferences, ack?: (result: RpcAck) => void) => void
  'client:set_cwd': (payload: ClientSetCwd, ack?: (result: RpcAck) => void) => void
  'client:reorder_queued_message': (payload: ClientReorderQueuedMessage, ack?: (result: RpcAck) => void) => void
  'client:update_queued_message': (payload: ClientUpdateQueuedMessage, ack?: (result: RpcAck) => void) => void
  'client:delete_queued_message': (payload: ClientDeleteQueuedMessage, ack?: (result: RpcAck) => void) => void
  'client:rename_session': (payload: ClientRenameSession, ack?: (result: RpcAck<string>) => void) => void
  'client:rename_workspace': (payload: ClientRenameWorkspace, ack?: (result: RpcAck<string>) => void) => void
  'client:consolidate_memory': (payload: ClientConsolidateMemory) => void
  'bg:list': (
    payload: ClientListBgTasks,
    ack: (result: BgListResult) => void,
  ) => void
  'bg:output': (
    payload: ClientReadBgOutput,
    ack: (result: BgOutputResult) => void,
  ) => void
  'bg:kill': (
    payload: ClientKillBgTask,
    ack: (result: BgKillResult) => void,
  ) => void
  'terminal:create': (
    payload: ClientTerminalCreate,
    ack: (result: TerminalCreateResult) => void,
  ) => void
  'terminal:input': (payload: ClientTerminalInput) => void
  'terminal:resize': (payload: ClientTerminalResize) => void
  'terminal:kill': (
    payload: ClientTerminalKill,
    ack: (result: TerminalKillResult) => void,
  ) => void
  'terminal:close_session': (payload: ClientTerminalCloseSession) => void
  'workspace:exec': (
    payload: import('./workspace-exec.js').WorkspaceExecRequest,
    ack: (result: import('./workspace-exec.js').WorkspaceExecResponse) => void,
  ) => void
  'workspace:read_binary': (
    payload: import('./workspace-exec.js').WorkspaceReadBinaryRequest,
    ack: (result: import('./workspace-exec.js').WorkspaceReadBinaryResponse) => void,
  ) => void
  'sub_agent:list': (
    payload: ClientListSubAgents,
    ack: (result: SubAgentListResult) => void,
  ) => void
  'agent_types:list': (
    payload: ClientListAgentTypes,
    ack: (result: AgentTypesResult) => void,
  ) => void
  subscribe: (payload: ClientSubscribe) => void
  unsubscribe: (payload: ClientUnsubscribe) => void
  'client:subscribe_channels': (payload: ClientSubscribeChannels, ack: (result: ChannelSubscriptionResult) => void) => void
  /** Re-emit authoritative baselines for rooms this socket already owns. */
  'client:refresh_channels': (payload: ClientSubscribeChannels, ack: (result: ChannelSubscriptionResult) => void) => void
  'client:unsubscribe_channels': (payload: ClientUnsubscribeChannels, ack: (result: ChannelSubscriptionResult) => void) => void
  'client:restore_subscriptions': (payload: ClientSubscribeChannels, ack: (result: ChannelSubscriptionResult) => void) => void
}

export type DashboardServerToClientEvents = {
  'session:ready': (payload: SessionReadyEvent) => void
  'state:changed': (payload: StateChangedEvent) => void
  'event:appended': (payload: EventAppendedEvent) => void
  'session:error': (payload: SessionErrorEvent) => void
  'approval:required': (payload: ApprovalRequiredEvent) => void
  'session:token_delta': (payload: ServerTokenDeltaEvent) => void
  'server:message_queue': (payload: ServerMessageQueueEvent) => void
  'server:executors': (payload: ServerExecutorsPayload) => void
  'server:sessions': (payload: ServerSessionsPayload) => void
  'server:dir_list': (payload: DirListResult) => void
  'server:file_list': (payload: FileListResult) => void
  'server:overflow_contents': (payload: OverflowContentsResult) => void
  'server:memory_consolidated': (payload: ConsolidateMemoryResult) => void
  'server:history': (payload: ServerHistoryPayload) => void
  'server:log_artifact': (payload: ServerLogArtifactPayload) => void
  'server:session_deleted': (payload: ServerSessionDeletedPayload) => void
  'server:terminal_output': (payload: ServerTerminalOutput) => void
  'server:terminal_exit': (payload: ServerTerminalExit) => void
  /**
   * Unified control-plane push for metadata and runtime lifecycle changes
   * outside the kernel event stream. See {@link ControlUpdate} for the
   * discriminated payload.
   */
  'server:control_update': (payload: ControlUpdate) => void
  'server:agent_runtimes': (payload: { runtimes: readonly AgentRuntimeDescriptor[] }) => void
  'server:compact_status': (payload: CompactStatusEvent) => void
  'server:dag_run': (payload: ServerDagRunEvent) => void
}

export type ServerMessageQueueEvent = {
  sessionId: string
  pending: number
  items: readonly QueuedMessagePreview[]
}

export type QueuedMessagePreview = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
  /** Structured attachments are included so the compact queue dock can render
   * stable placeholders such as [Image #1] without embedding full previews. */
  content?: readonly MessageContent[]
  /** Host-owned shell lifecycle, keyed by this item's original operation id. */
  shell?: {
    command: string
    state: 'queued' | 'running' | 'completed' | 'nonzero' | 'failed' | 'unknown'
    result?: string
    error?: string
  }
}

export type ExecutorClientToServerEvents = {
  'executor:announce': (payload: ExecutorAnnounce) => void
  'executor:tool_progress': (payload: ToolProgressPayload) => void
  'executor:bg_task_updated': (payload: ServerBgTaskUpdated) => void
  'executor:bg_task_evicted': (payload: ServerBgTaskEvicted) => void
  'executor:terminal_output': (payload: ServerTerminalOutput) => void
  'executor:terminal_exit': (payload: ServerTerminalExit) => void
  'executor:network_audit': (payload: import('./network-audit.js').NetworkAuditEvent, ack: (result: { accepted: boolean }) => void) => void
}

/**
 * Executor's inbound wire surface. Kept intentionally small so an executor
 * deployed in the field only has to speak two message shapes: "run this
 * tool" and "cancel that one". Everything the host previously exposed as
 * a bespoke RPC (fs inspection, background-task inspection, overflow
 * spill management) now travels through `tool:call` using internal tool names
 * conventionally prefixed `__`. The executor runs the named tool; only the
 * host decides whether the result is a kernel tool result or an internal RPC
 * response.
 *
 * The kernel-echo events (`session:ready`, `state:changed`, `event:appended`,
 * `session:error`) that used to be declared here were never actually
 * subscribed by any executor; they were pure type noise. Gone.
 */
export type ExecutorServerToClientEvents = {
  'executor:health_ping': (sentAt: number, ack: (executorAt: number) => void) => void
  'executor:mcp_configure': (payload: ExecutorMcpConfigureRequest, ack: (result: ExecutorMcpConfigureAck) => void) => void
  'executor:mcp_config_status': (payload: ExecutorMcpConfigStatusRequest, ack: (result: ExecutorMcpConfigStatusAck) => void) => void
  'tool:call': (
    payload: ToolCallMessage,
    ack: (result: ToolResultAck) => void,
  ) => void
  'tool:cancel': (payload: ToolCancelMessage) => void
  'terminal:create': (
    payload: ClientTerminalCreate,
    ack: (result: TerminalCreateResult) => void,
  ) => void
  'terminal:input': (payload: ClientTerminalInput) => void
  'terminal:resize': (payload: ClientTerminalResize) => void
  'terminal:kill': (
    payload: ClientTerminalKill,
    ack: (result: TerminalKillResult) => void,
  ) => void
  'terminal:close_session': (payload: ClientTerminalCloseSession) => void
  /**
   * Permanent-failure signal. Sent immediately before a server-initiated
   * `socket.disconnect(true)` when the executor must not retry (workspaceId
   * conflict, auth failure, protocol-version incompatibility). Executors
   * should log `payload.message` and exit their process — the socket.io
   * client will fire `disconnect('io server disconnect')` right after this
   * event and, per the client's own retry policy, must not reconnect.
   *
   * The `code` field is machine-readable so the executor's exit path can
   * pick a distinct exit code per class of failure.
   */
  'executor:host_reject': (payload: {
    code: 'workspace_id_conflict' | 'workspace_identity_mismatch' | 'version_incompatible' | 'auth_failed'
    message: string
  }) => void
  'executor:welcome': (payload: {
    token: string
    workspaceId: string
  }) => void
}

export type ExecutorInviteCreated = {
  id: string
  inviteToken: string
  label?: string
  workspaceId?: string
  createdAt: string
}

// ============================================================================
// Protocol version
// ============================================================================

/**
 * Semver-like protocol version. The host compares the major component of an
 * incoming `HandshakeAuth.clientVersion` against `PROTOCOL_VERSION`; a
 * mismatch on major → the handshake middleware rejects with
 * `'version_incompatible'`. Minor / patch differences are always accepted —
 * they are reserved for additive (backwards-compatible) changes to event
 * payloads. Producers use the string form directly; consumers use
 * `parseMajor()` to extract just the compatibility digit.
 *
 * Bump the major whenever a wire event changes shape in a
 * backwards-incompatible way. Bump minor for additive changes (new events,
 * new optional fields). Bump patch for doc-only corrections.
 */
export const PROTOCOL_VERSION = '1.1.0' as const

export function parseMajor(version: string): number | null {
  const first = version.split('.')[0]
  if (first === undefined) return null
  const n = Number.parseInt(first, 10)
  return Number.isFinite(n) ? n : null
}

export function isCompatibleVersion(clientVersion: string): boolean {
  const client = parseMajor(clientVersion)
  const server = parseMajor(PROTOCOL_VERSION)
  return client !== null && server !== null && client === server
}
