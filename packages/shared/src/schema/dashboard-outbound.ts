/**
 * Zod schemas for Host→Dashboard push events + HTTP response bodies.
 *
 * types-first: `../protocol.ts` (+ `../log.ts` for LLMTrace) remains
 * authoritative; each schema is checked via `satisfies z.ZodType<T>`.
 *
 * Boundary usage: `.parse()` at HTTP response ingest / JSONL log ingest /
 * client-side event handlers when defense-in-depth is warranted. Never
 * inside internal reducers.
 */

import { z } from 'zod'

import type {
  AgentTypeSummary,
  AgentTypesResult,
  ApprovalRequiredEvent,
  AttachedExecutor,
  BgKillResult,
  BgListResult,
  BgOutputResult,
  ConsolidateMemoryResult,
  ContextUsageSnapshot,
  ControlUpdate,
  CompactionMetadata,
  CompactStatusEvent,
  CopyOverflowSessionResult,
  DeleteOverflowSessionResult,
  DirListEntry,
  DirListResult,
  EventAppendedEvent,
  ExecutorChange,
  ExecutorIdentitySummary,
  ExecutorInviteSummary,
  FileContentsResult,
  GitDiffResult,
  GitFileChange,
  GitStatusResult,
  FileListEntry,
  FileListResult,
  HostRestartAttempt,
  HostRestartEvent,
  HostRestartSessionPlan,
  HostRestartStatus,
  ManualModelInput,
  ModelInfo,
  ModelSource,
  OverflowContentsResult,
  QueuedMessagePreview,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
  ServerExecutorChangedPayload,
  ServerExecutorIdentitiesPayload,
  ServerExecutorIdentityRevokedPayload,
  ServerExecutorInvitePayload,
  ServerExecutorInviteRevokedPayload,
  ServerExecutorInvitesPayload,
  ServerExecutorsPayload,
  ServerDagRunEvent,
  ServerHistoryPayload,
  ServerLogArtifactPayload,
  ServerMessageQueueEvent,
  ServerModelsPayload,
  ServerSessionDeletedPayload,
  ServerSessionsPayload,
  ServerSettingsPayload,
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  ServerTokenDeltaEvent,
  SessionErrorEvent,
  SessionErrorScope,
  SessionMetaChanged,
  SessionReadyEvent,
  SessionSummary,
  SettingsHookSummary,
  SettingsAgentPrompt,
  SettingsProviderSummary,
  StateChangedEvent,
  SubAgentListResult,
  SubAgentSummary,
  ToolProgressPayload,
  WorkspaceMetaChanged,
} from '../protocol.js'
import type { DagDecision, DagEdge, DagEvent, DagNode, DagRun } from '../dag.js'
import { SESSION_ERROR_SCOPES } from '../protocol.js'
import type { EventEntry, HeaderEntry, LLMTrace, LogEntry, MetadataEntry, RuntimeMetadataEntry, SnapshotEntry } from '../log.js'
import {
  AgentConfigSchema,
  AgentModuleMetadataSchema,
  AgentEventSchema,
  AgentStateSchema,
  AgentStatusSchema,
  EffectSchema,
  UsageTotalSchema,
} from './kernel.js'
import {
  BuildMetadataSchema,
  ExecutorAnnounceSchema,
  ServerBgTaskEvictedSchema,
  ServerBgTaskUpdatedSchema,
  ToolProgressPayloadSchema,
} from './executor.js'
import { ManualModelInputSchema, SessionPreferencesSchema } from './dashboard-inbound.js'

// A null reading mode is only an inbound clear command; persisted summaries
// and control-plane updates expose the resulting preference, never the command.
const StoredSessionPreferencesSchema = SessionPreferencesSchema.extend({
  chapterReadingMode: z.enum(['chapters', 'continuous']).optional(),
})

void ToolProgressPayloadSchema
void ServerBgTaskEvictedSchema

// ============================================================================
// LLM trace
// ============================================================================

export const LLMTraceSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'unknown']),
  model: z.string(),
  request: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  response: z
    .object({
      status: z.number().int(),
      finishReason: z.string().optional(),
      body: z.unknown().optional(),
      streamEventTypes: z.array(z.string()).optional(),
      metrics: z
        .object({
          durationMs: z.number().optional(),
          timeToFirstChunkMs: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  gatewayRequestId: z.string().optional(),
  weightVersion: z.string().optional(),
}) satisfies z.ZodType<LLMTrace>

// ============================================================================
// Session lifecycle events
// ============================================================================

export const ContextUsageSnapshotSchema = z.object({
  model: z.object({
    ref: z.string(),
    provider: z.string().optional(),
    id: z.string().optional(),
  }),
  contextWindow: z.object({
    tokens: z.number().int().positive().nullable(),
    source: z.enum(['manual_config', 'model_registry', 'provider_default', 'api_reported', 'unknown']),
  }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
  }),
  breakdown: z.object({
    system: z.number().int().nonnegative(),
    transcript: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    memory: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
    pendingUserInput: z.number().int().nonnegative(),
    transcriptBreakdown: z.object({
      userMessages: z.number().int().nonnegative(),
      assistantMessages: z.number().int().nonnegative(),
      toolResults: z.number().int().nonnegative(),
    }).optional(),
  }),
  estimator: z.object({
    total: z.object({
      kind: z.enum(['provider_reported', 'tokenizer', 'heuristic']),
      confidence: z.enum(['exact', 'estimated', 'rough']),
    }),
    breakdown: z.object({
      kind: z.enum(['tokenizer', 'heuristic']),
      confidence: z.enum(['estimated', 'rough']),
    }),
    version: z.string(),
  }),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<ContextUsageSnapshot>

const RuntimeCompactionPolicySchema = z.object({
  authority: z.enum(['host', 'runtime']),
  automatic: z.object({
    enabled: z.boolean(),
    mode: z.enum(['safe_boundary', 'background']),
    warningThreshold: z.number().min(0).max(1),
    startThreshold: z.number().min(0).max(1),
    blockingThreshold: z.number().min(0).max(1).optional(),
    concurrentWorkAllowed: z.boolean(),
  }),
  manual: z.object({
    supported: z.boolean(),
    whileActive: z.enum(['reject', 'queue', 'runtime_managed']),
  }),
  summary: z.object({
    authority: z.enum(['host', 'runtime']),
    validation: z.enum(['host_gate', 'runtime_reported']),
  }),
})

const CompactScopeSchema = z.object({
  kind: z.enum(['root', 'subagent']),
  agentId: z.string().optional(),
})

const CompactStatusEventSchema = z.discriminatedUnion('kind', [
  z.object({
    sessionId: z.string(),
    kind: z.literal('running'),
    trigger: z.enum(['manual', 'auto', 'preflight', 'tool_result']),
    tokensBefore: z.number().nonnegative(),
    attemptId: z.string(),
    startedAt: z.string(),
    authority: z.enum(['host', 'runtime']).optional(),
    scope: CompactScopeSchema.optional(),
    startSnapshot: ContextUsageSnapshotSchema.optional(),
  }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('done'),
    attemptId: z.string(),
    tokensBefore: z.number().nonnegative(),
    tokensAfter: z.number().nonnegative(),
    trigger: z.enum(['manual', 'auto', 'preflight', 'tool_result']).optional(),
    replacedCount: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
    endedAt: z.string(),
    authority: z.enum(['host', 'runtime']).optional(),
    scope: CompactScopeSchema.optional(),
    startSnapshot: ContextUsageSnapshotSchema.optional(),
    completionSnapshot: ContextUsageSnapshotSchema.optional(),
    summaryValidation: z.enum(['host_gate', 'runtime_reported']).optional(),
  }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('skipped'),
    attemptId: z.string(),
    reason: z.string(),
    message: z.string().optional(),
    endedAt: z.string(),
    authority: z.enum(['host', 'runtime']).optional(),
    scope: CompactScopeSchema.optional(),
  }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('error'),
    attemptId: z.string(),
    message: z.string(),
    endedAt: z.string(),
    authority: z.enum(['host', 'runtime']).optional(),
    scope: CompactScopeSchema.optional(),
  }),
]) satisfies z.ZodType<CompactStatusEvent>

export const SessionReadyEventSchema = z.object({
  sessionId: z.string(),
  agentRuntime: z.enum(['kernel', 'copilot']),
  executionMode: z.enum(['chat', 'dag']),
  agentRuntimeCapabilities: z.object({
    queue: z.boolean(),
    fork: z.boolean(),
    compact: z.boolean(),
    clear: z.boolean(),
    approvalMode: z.boolean(),
    workspace: z.boolean(),
    cwdMutation: z.boolean(),
    modelSelection: z.boolean(),
    attachments: z.boolean(),
    memoryConsolidation: z.boolean(),
    customTools: z.boolean(),
    nativeReasoning: z.boolean(),
  }),
  runtimeCompactionPolicy: RuntimeCompactionPolicySchema.optional(),
  compactStatus: CompactStatusEventSchema.optional(),
  cursor: z.number().int().nonnegative(),
  state: AgentStateSchema,
  config: AgentConfigSchema,
  contextSnapshot: ContextUsageSnapshotSchema,
  turnStartedAt: z.iso.datetime({ offset: true }).optional(),
  streamingDraft: z.object({ text: z.string(), afterSeq: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative() }).optional(),
  reason: z.enum(['load', 'created', 'forked']).optional(),
  parentSessionId: z.string().optional(),
  parentCursor: z.number().int().nonnegative().optional(),
  parentCallId: z.string().optional(),
  agentType: z.string().optional(),
  subAgentStartedAt: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  selectedModel: z.string().optional(),
}) satisfies z.ZodType<SessionReadyEvent>

export const StateChangedEventSchema = z.object({
  sessionId: z.string(),
  cursor: z.number().int().nonnegative(),
  state: AgentStateSchema,
  contextSnapshot: ContextUsageSnapshotSchema,
  turnStartedAt: z.iso.datetime({ offset: true }).optional(),
}) satisfies z.ZodType<StateChangedEvent>

export const HostRestartSessionPlanSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.string().optional(),
  parentCallId: z.string().optional(),
  cursor: z.number().int().nonnegative(),
  initialStatus: AgentStatusSchema,
  checkpointStatus: z.enum(['already_safe', 'waiting_llm', 'waiting_tool', 'waiting_turn', 'waiting_idle', 'safe', 'failed']),
  checkpointKind: z.enum(['resting', 'before_llm', 'before_tool_dispatch', 'waiting_for_approval']).optional(),
  resumeAction: z.enum(['none', 'wait_for_approval', 'continue_turn', 'drain_queue']),
  continuationKey: z.string().optional(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<HostRestartSessionPlan>

export const HostRestartAttemptSchema = z.object({
  attemptId: z.string(),
  phase: z.enum(['idle', 'requested', 'draining', 'checkpoint_reached', 'restarting', 'recovering', 'completed', 'aborted', 'failed']),
  mode: z.enum(['checkpoint', 'when_idle', 'force']),
  reason: z.enum(['manual', 'deploy', 'settings_changed']),
  requestedAt: z.string(),
  updatedAt: z.string(),
  oldPid: z.number().int().nonnegative(),
  newPid: z.number().int().nonnegative().optional(),
  deployment: z.object({
    deploymentId: z.string(),
    targetReleaseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedRouteGeneration: z.number().int().positive(),
    fencingToken: z.string(),
  }).optional(),
  timeoutMs: z.number().int().positive().optional(),
  sessions: z.array(HostRestartSessionPlanSchema),
  recoveryReceipts: z.record(z.string(), z.object({
    continuationKey: z.string().min(1),
    baselineCursor: z.number().int().nonnegative(),
    state: z.enum(['pending', 'running', 'adopted', 'settled', 'failed']),
    observedCursor: z.number().int().nonnegative().optional(),
    startedAt: z.string().optional(),
    adoptedAt: z.string().optional(),
    settledAt: z.string().optional(),
    error: z.string().optional(),
  })).optional(),
  command: z.array(z.string()).optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<HostRestartAttempt>

export const HostRestartStatusSchema = z.object({
  pid: z.number().int().nonnegative(),
  startedAt: z.string(),
  current: HostRestartAttemptSchema.nullable(),
  last: HostRestartAttemptSchema.nullable(),
}) satisfies z.ZodType<HostRestartStatus>

export const HostRestartEventSchema: z.ZodType<HostRestartEvent> = HostRestartAttemptSchema

export const CompactionMetadataSchema = z.object({
  trigger: z.enum(['manual', 'auto', 'preflight', 'tool_result']),
  attemptId: z.string().optional(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
  replacedCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<CompactionMetadata>

const CompletedTimingSpanSchema = z.object({
  spanId: z.string(), turnId: z.string(), kind: z.enum(['llm','tool','approval','compaction','retry','recovery']),
  component: z.enum(['host','executor']), startedAt: z.string(), completedAt: z.string(), durationMs: z.number().int().nonnegative(),
  status: z.enum(['succeeded','failed','cancelled','interrupted']), callId: z.string().optional(), executorDurationMs: z.number().int().nonnegative().optional(), firstTokenMs: z.number().int().nonnegative().optional(),
})
const TurnTimingSummarySchema = z.object({
  turnId: z.string(), status: z.enum(['running','completed','failed','cancelled','interrupted']), startedAt: z.string(), completedAt: z.string().optional(), wallDurationMs: z.number().int().nonnegative(), estimated: z.boolean(),
  queueDurationMs: z.number().int().nonnegative(), activeDurationMs: z.number().int().nonnegative(), approvalWaitMs: z.number().int().nonnegative(),
  llm: z.object({ wallDurationMs: z.number().int().nonnegative(), requestCount: z.number().int().nonnegative(), firstTokenMs: z.number().int().nonnegative().optional() }),
  tools: z.object({ wallDurationMs: z.number().int().nonnegative(), aggregateDurationMs: z.number().int().nonnegative(), callCount: z.number().int().nonnegative(), peakConcurrency: z.number().int().nonnegative(), partial: z.boolean() }),
  compactionDurationMs: z.number().int().nonnegative(), retryDurationMs: z.number().int().nonnegative(), recoveryDurationMs: z.number().int().nonnegative(),
})
const EventTimingMetadataSchema = z.object({ turnId: z.string(), turnStartedAt: z.string().optional(), span: CompletedTimingSpanSchema.optional(), summary: TurnTimingSummarySchema.optional() })

export const EventAppendedEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  event: AgentEventSchema,
  effects: z.array(EffectSchema),
  hasEffectsArtifact: z.boolean().optional(),
  hasLlmTraceArtifact: z.boolean().optional(),
  llmTrace: LLMTraceSchema.optional(),
  model: z.string().optional(),
  timing: EventTimingMetadataSchema.optional(),
  compactionMetadata: CompactionMetadataSchema.optional(),
}) satisfies z.ZodType<EventAppendedEvent>

export const ServerLogArtifactPayloadSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  effects: z.array(EffectSchema).optional(),
  llmTrace: LLMTraceSchema.optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<ServerLogArtifactPayload>

const SessionErrorScopeSchema = z.enum(
  SESSION_ERROR_SCOPES as unknown as [SessionErrorScope, ...SessionErrorScope[]],
) satisfies z.ZodType<SessionErrorScope>

export const SessionErrorEventSchema = z.object({
  sessionId: z.string(),
  scope: SessionErrorScopeSchema,
  message: z.string(),
}) satisfies z.ZodType<SessionErrorEvent>

export const ApprovalRequiredEventSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
}) satisfies z.ZodType<ApprovalRequiredEvent>

export const ServerTokenDeltaEventSchema = z.object({
  sessionId: z.string(),
  text: z.string(),
}) satisfies z.ZodType<ServerTokenDeltaEvent>

// ============================================================================
// Control-plane push
// ============================================================================

export const SessionMetaChangedSchema = z.object({
  sessionId: z.string(),
  label: z.string().optional(),
  preferences: StoredSessionPreferencesSchema.optional(),
}) satisfies z.ZodType<SessionMetaChanged>

export const WorkspaceMetaChangedSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
}) satisfies z.ZodType<WorkspaceMetaChanged>

// ============================================================================
// Executor attach / detach
// ============================================================================

export const AttachedExecutorSchema = ExecutorAnnounceSchema.extend({
  attachedAt: z.string(),
  clientVersion: z.string().optional(),
}) satisfies z.ZodType<AttachedExecutor>

const _ExecutorChangeSchema = z.enum([
  'attached',
  'detached',
  'updated',
]) satisfies z.ZodType<ExecutorChange>
void _ExecutorChangeSchema

export const ServerExecutorChangedPayloadSchema = z.discriminatedUnion('change', [
  z.object({
    change: z.literal('detached'),
    executorId: z.string(),
  }),
  z.object({
    change: z.literal('attached'),
    executorId: z.string(),
    executor: AttachedExecutorSchema,
  }),
  z.object({
    change: z.literal('updated'),
    executorId: z.string(),
    executor: AttachedExecutorSchema,
  }),
]) satisfies z.ZodType<ServerExecutorChangedPayload>

export const ServerExecutorsPayloadSchema = z.object({
  executors: z.array(AttachedExecutorSchema),
}) satisfies z.ZodType<ServerExecutorsPayload>

// ============================================================================
// Sub-agent lifecycle
// ============================================================================

export const ServerSubAgentStartedEventSchema = z.object({
  parentSessionId: z.string(),
  parentCallId: z.string(),
  childSessionId: z.string(),
  agentType: z.string().optional(),
  intention: z.string().min(1).max(240).optional(),
  prompt: z.string(),
  model: z.string().optional(),
  startedAt: z.string(),
}) satisfies z.ZodType<ServerSubAgentStartedEvent>

export const ServerSubAgentFinishedEventSchema = z.object({
  parentSessionId: z.string(),
  parentCallId: z.string(),
  childSessionId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled', 'timed_out_with_partial_result']),
  turns: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  finishedAt: z.string(),
  error: z.string().optional(),
}) satisfies z.ZodType<ServerSubAgentFinishedEvent>

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  agentRuntime: z.enum(['kernel', 'copilot']),
  executionMode: z.enum(['chat', 'dag']),
  agentRuntimeVersion: z.string().optional(),
  createdAt: z.string(),
  lastEventAt: z.string().optional(),
  eventCount: z.number().int().nonnegative(),
  parentSessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  status: AgentStatusSchema.optional(),
  currentCwd: z.string().optional(),
  firstUserMessage: z.string().optional(),
  label: z.string().optional(),
  preferences: StoredSessionPreferencesSchema.optional(),
}) satisfies z.ZodType<SessionSummary>

// ============================================================================
// Unified control update
// ============================================================================

export const ControlUpdateSchema = z.union([
  z.object({ kind: z.literal('session_meta_changed') }).extend(SessionMetaChangedSchema.shape),
  z.object({ kind: z.literal('session_summary_changed'), session: SessionSummarySchema }),
  z.object({ kind: z.literal('workspace_meta_changed') }).extend(WorkspaceMetaChangedSchema.shape),
  z.object({ kind: z.literal('executor_changed'), executorId: z.string(), change: z.literal('detached') }),
  z.object({ kind: z.literal('executor_changed'), executorId: z.string(), change: z.literal('attached'), executor: AttachedExecutorSchema }),
  z.object({ kind: z.literal('executor_changed'), executorId: z.string(), change: z.literal('updated'), executor: AttachedExecutorSchema }),
  z.object({ kind: z.literal('bg_task_updated') }).extend(ServerBgTaskUpdatedSchema.shape),
  z.object({ kind: z.literal('bg_task_evicted') }).extend(ServerBgTaskEvictedSchema.shape),
  z.object({ kind: z.literal('sub_agent_started') }).extend(ServerSubAgentStartedEventSchema.shape),
  z.object({ kind: z.literal('sub_agent_finished') }).extend(ServerSubAgentFinishedEventSchema.shape),
  z.object({ kind: z.literal('tool_progress') }).extend(ToolProgressPayloadSchema.shape),
]) as unknown as z.ZodType<ControlUpdate>

// ============================================================================
// Message queue
// ============================================================================

export const QueuedMessagePreviewSchema = z.object({
  id: z.string(),
  text: z.string(),
  mode: z.enum(['steer', 'queue']),
  createdAt: z.string(),
}) satisfies z.ZodType<QueuedMessagePreview>

export const ServerMessageQueueEventSchema = z.object({
  sessionId: z.string(),
  pending: z.number().int().nonnegative(),
  items: z.array(QueuedMessagePreviewSchema),
}) satisfies z.ZodType<ServerMessageQueueEvent>

// ============================================================================
// Sessions & history
// ============================================================================

export const DagNodeSchema = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string(),
  instructions: z.string(),
  status: z.enum(['pending', 'ready', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled', 'replaced']),
  depth: z.number().int().nonnegative(),
  writeScopes: z.array(z.string()).readonly(),
  estimatedDurationMinutes: z.number().positive().optional(),
  attempt: z.number().int().nonnegative(),
  childSessionId: z.string().optional(),
  progress: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  replacedBy: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  toolActivity: z.array(z.object({
    callId: z.string(),
    name: z.string(),
    category: z.enum(['read', 'shell', 'write', 'network', 'install', 'system', 'other']),
    status: z.enum(['succeeded', 'failed', 'unknown']),
    summary: z.string(),
  })).readonly(),
}) satisfies z.ZodType<DagNode>

export const DagEdgeSchema = z.object({
  id: z.string(),
  runId: z.string(),
  source: z.string(),
  target: z.string(),
}) satisfies z.ZodType<DagEdge>

export const DagDecisionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  question: z.string(),
  context: z.string(),
  choices: z.array(z.string()).readonly(),
  allowFreeform: z.boolean(),
  recommendation: z.string().optional(),
  reason: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['pending', 'answered', 'cancelled']),
  answer: z.string().optional(),
  createdAt: z.string(),
  answeredAt: z.string().optional(),
}) satisfies z.ZodType<DagDecision>

export const DagEventSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.string(),
  type: z.enum(['run', 'node', 'decision', 'graph', 'lease']),
  message: z.string(),
  nodeId: z.string().optional(),
  createdAt: z.string(),
}) satisfies z.ZodType<DagEvent>

const DagNodeAttemptSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.string(),
  nodeId: z.string(),
  attempt: z.number().int().positive(),
  workerId: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'waiting_user', 'replaced']),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
})

const DagGraphVersionNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  depth: z.number().int().nonnegative(),
  writeScopes: z.array(z.string()).readonly(),
  estimatedDurationMinutes: z.number().positive().optional(),
})

const DagGraphVersionSchema = z.object({
  runId: z.string(),
  version: z.number().int().nonnegative(),
  resultNodeId: z.string(),
  nodes: z.array(DagGraphVersionNodeSchema).readonly(),
  edges: z.array(z.object({ source: z.string(), target: z.string() })).readonly(),
  createdAt: z.string(),
})

export const DagRunSchema = z.object({
  id: z.string(),
  parentSessionId: z.string(),
  objective: z.string(),
  status: z.enum(['planning', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  graphVersion: z.number().int().nonnegative(),
  resultNodeId: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nodes: z.array(DagNodeSchema).readonly(),
  edges: z.array(DagEdgeSchema).readonly(),
  decisions: z.array(DagDecisionSchema).readonly(),
  events: z.array(DagEventSchema).readonly(),
  attempts: z.array(DagNodeAttemptSchema).readonly().optional(),
  graphHistory: z.array(DagGraphVersionSchema).readonly().optional(),
}) satisfies z.ZodType<DagRun>

export const ServerDagRunEventSchema = z.object({
  sessionId: z.string(),
  run: DagRunSchema.nullable(),
}) satisfies z.ZodType<ServerDagRunEvent>

export const ServerSessionsPayloadSchema = z.object({
  sessions: z.array(SessionSummarySchema),
}) satisfies z.ZodType<ServerSessionsPayload>

export const ServerHistoryPayloadSchema = z.object({
  sessionId: z.string(),
  entries: z.array(EventAppendedEventSchema),
}) satisfies z.ZodType<ServerHistoryPayload>

export const ServerSessionDeletedPayloadSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ServerSessionDeletedPayload>

// ============================================================================
// Filesystem responses
// ============================================================================

export const DirListEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file']).optional(),
  size: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<DirListEntry>

export const DirListResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  roots: z.array(z.string()),
  entries: z.array(DirListEntrySchema),
  error: z.string().optional(),
}) satisfies z.ZodType<DirListResult>

export const FileListEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
}) satisfies z.ZodType<FileListEntry>

export const FileListResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  files: z.array(FileListEntrySchema),
  truncated: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<FileListResult>

export const FileContentsResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  content: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  kind: z.enum(['text', 'image', 'pdf', 'binary', 'too_large', 'not_found', 'error']).optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  mediaType: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<FileContentsResult>

export const OverflowContentsResultSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  callId: z.string(),
  content: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<OverflowContentsResult>

export const DeleteOverflowSessionResultSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  deleted: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<DeleteOverflowSessionResult>

export const CopyOverflowSessionResultSchema = z.object({
  requestId: z.string(),
  sourceSessionId: z.string(),
  targetSessionId: z.string(),
  copied: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<CopyOverflowSessionResult>

// ============================================================================
// Git read-only responses
// ============================================================================

export const GitFileChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted', 'typechanged']),
  staged: z.boolean(),
  unstaged: z.boolean(),
}) satisfies z.ZodType<GitFileChange>

const GitStatusErrorSchema = z.object({
  code: z.enum(['not_git_repo', 'executor_unavailable', 'git_unavailable', 'timeout', 'workspace_not_found', 'internal_error']),
  message: z.string(),
})

export const GitStatusResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  repo: z.object({
    root: z.string(),
    branch: z.string().optional(),
    head: z.string().optional(),
  }).optional(),
  files: z.array(GitFileChangeSchema),
  truncated: z.object({
    reason: z.enum(['too_many_files', 'timeout', 'too_large']),
    limit: z.number().int().nonnegative(),
  }).optional(),
  error: GitStatusErrorSchema.optional(),
}) satisfies z.ZodType<GitStatusResult>

const GitDiffErrorSchema = z.object({
  code: z.enum(['not_git_repo', 'executor_unavailable', 'git_unavailable', 'file_not_found', 'binary_file', 'too_large', 'timeout', 'workspace_not_found', 'internal_error']),
  message: z.string(),
})

export const GitDiffResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  file: GitFileChangeSchema.optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  language: z.string().optional(),
  truncated: z.object({
    side: z.enum(['old', 'new', 'both']),
    maxBytes: z.number().int().positive(),
  }).optional(),
  error: GitDiffErrorSchema.optional(),
}) satisfies z.ZodType<GitDiffResult>

// ============================================================================
// Background task results
// ============================================================================

const _BackgroundTaskSummaryFromExec = ServerBgTaskUpdatedSchema.shape.task

export const BgListResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  tasks: z.array(_BackgroundTaskSummaryFromExec),
  error: z.string().optional(),
}) satisfies z.ZodType<BgListResult>

export const BgOutputResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  content: z.string(),
  nextOffset: z.number().int().nonnegative(),
  done: z.boolean(),
  status: z.enum(['running', 'exited', 'killed', 'signaled']),
  bytesTruncated: z.number().int().nonnegative(),
  error: z.string().optional(),
}) satisfies z.ZodType<BgOutputResult>

export const BgKillResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  killed: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<BgKillResult>

// Re-export executor push shapes for outbound consumers
export type { ServerBgTaskUpdated, ServerBgTaskEvicted }

// ============================================================================
// Sub-agent + agent types responses
// ============================================================================

export const SubAgentSummarySchema = z.object({
  childSessionId: z.string(),
  parentCallId: z.string().optional(),
  agentType: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  turns: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<SubAgentSummary>

export const SubAgentListResultSchema = z.object({
  requestId: z.string(),
  parentSessionId: z.string(),
  children: z.array(SubAgentSummarySchema),
  error: z.string().optional(),
}) satisfies z.ZodType<SubAgentListResult>

export const AgentTypeSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPromptPreview: z.string().optional(),
}) satisfies z.ZodType<AgentTypeSummary>

export const AgentTypesResultSchema = z.object({
  requestId: z.string(),
  types: z.array(AgentTypeSummarySchema),
  error: z.string().optional(),
}) satisfies z.ZodType<AgentTypesResult>

export const ConsolidateMemoryResultSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  saved: z.array(z.string()),
  skipped: z.number().int().nonnegative(),
  reason: z.string().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<ConsolidateMemoryResult>

// ============================================================================
// Models / settings
// ============================================================================

const ModelSourceSchema = z.enum([
  'claude-settings',
  'codex-config',
  'env',
  'manual',
]) satisfies z.ZodType<ModelSource>

export const ModelInfoSchema = z.object({
  ref: z.string(),
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  providerId: z.string(),
  source: ModelSourceSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  limits: z.object({
    context: z.number().int().positive(),
    input: z.number().int().positive().optional(),
    output: z.number().int().positive().optional(),
  }).optional(),
  metadataSource: z.enum([
    'manual',
    'provider',
    'models.dev-live',
    'models.dev-cache',
    'models.dev-seed',
    'unknown',
  ]).optional(),
  metadataMatch: z.enum([
    'provider-model-exact',
    'canonical-model-exact',
    'model-id-consensus',
    'none',
  ]).optional(),
  catalogUpdatedAt: z.string().optional(),
}) satisfies z.ZodType<ModelInfo>

export const ServerModelsPayloadSchema = z.object({
  models: z.array(ModelInfoSchema),
  defaultModel: z.string(),
}) satisfies z.ZodType<ServerModelsPayload>

export const SettingsProviderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  wire: z.enum(['anthropic', 'openai']),
  source: ModelSourceSchema.optional(),
  baseUrl: z.string().optional(),
  models: z.array(ModelInfoSchema),
}) satisfies z.ZodType<SettingsProviderSummary>

export const SettingsHookSummarySchema = z.object({
  event: z.enum(['pre_tool_use', 'post_tool_use', 'session_start', 'session_end']),
  command: z.string(),
  match: z.string().optional(),
}) satisfies z.ZodType<SettingsHookSummary>

const SettingsSkillDiagnosticSchema = z.object({
  level: z.literal('warning'),
  path: z.string(),
  message: z.string(),
})

const SettingsSkillSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  roots: z.array(z.string()),
  diagnostics: z.array(SettingsSkillDiagnosticSchema),
})

const SettingsAgentPromptSchema = z.object({
  selectedSlotId: z.enum(['slot-1', 'slot-2', 'slot-3']),
  slots: z.tuple([
    z.object({ id: z.literal('slot-1'), name: z.string(), prompt: z.string() }),
    z.object({ id: z.literal('slot-2'), name: z.string(), prompt: z.string() }),
    z.object({ id: z.literal('slot-3'), name: z.string(), prompt: z.string() }),
  ]),
  configPath: z.string(),
}) satisfies z.ZodType<SettingsAgentPrompt>

export const ServerSettingsPayloadSchema = z.object({
  providers: z.array(SettingsProviderSummarySchema),
  defaultModel: z.string(),
  hooks: z.array(SettingsHookSummarySchema),
  versions: z
    .object({
      host: z.string(),
      protocol: z.string(),
      build: BuildMetadataSchema.optional(),
    })
    .optional(),
  runtime: HostRestartStatusSchema.optional(),
  socketConnections: z.object({
    total: z.number().int().nonnegative(),
    dashboard: z.number().int().nonnegative(),
    executor: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
    namespaces: z.array(z.object({
      namespace: z.string(),
      sockets: z.number().int().nonnegative(),
      dashboard: z.number().int().nonnegative(),
      executor: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
    })),
    updatedAt: z.string(),
  }).optional(),
  agentModule: AgentModuleMetadataSchema.optional(),
  agentPrompt: SettingsAgentPromptSchema.optional(),
  auth: z
    .object({
      dashboardAuthRequired: z.boolean(),
      githubOAuth: z.object({
        required: z.boolean(),
        configured: z.boolean(),
        usernameWhitelistEnabled: z.boolean(),
        usernameWhitelist: z.array(z.string()),
      }),
      executorIdentity: z.object({
        tokenScoped: z.boolean(),
        tokenCount: z.number().int().nonnegative(),
        inviteCount: z.number().int().nonnegative().optional(),
      }),
    })
    .optional(),
  socketAdmin: z
    .object({
      active: z.boolean(),
      initialized: z.boolean(),
      path: z.string(),
      username: z.string(),
      runtimeMode: z.enum(['production', 'development']),
      configuredMode: z.enum(['production', 'development']),
      configPath: z.string(),
      distSource: z.enum(['embedded', 'filesystem']).optional(),
      createdAt: z.string().optional(),
      restartRequired: z.boolean().optional(),
    })
    .optional(),
  paths: z.object({
    claudeSettings: z.string(),
    codexConfig: z.string(),
    manualModels: z.string(),
    hooksConfig: z.string(),
    sessionsDir: z.string(),
  }),
  mcp: z.object({
    supported: z.literal(false),
    note: z.string(),
  }),
  skills: SettingsSkillSummarySchema.optional(),
  release: z
    .object({
      bootstrapBaseUrl: z.string(),
      source: z.enum(['local', 'github']),
    })
    .optional(),
}) satisfies z.ZodType<ServerSettingsPayload>

// ============================================================================
// Executor identity admin surface
// ============================================================================

export const ExecutorIdentitySummarySchema = z.object({
  workspaceId: z.string(),
  label: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string().optional(),
}) satisfies z.ZodType<ExecutorIdentitySummary>

export const ServerExecutorIdentitiesPayloadSchema = z.object({
  identities: z.array(ExecutorIdentitySummarySchema),
}) satisfies z.ZodType<ServerExecutorIdentitiesPayload>

export const ServerExecutorIdentityRevokedPayloadSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string(),
  revoked: z.boolean(),
}) satisfies z.ZodType<ServerExecutorIdentityRevokedPayload>

export const ExecutorInviteSummarySchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().optional(),
  revoked: z.boolean(),
}) satisfies z.ZodType<ExecutorInviteSummary>

export const ServerExecutorInvitesPayloadSchema = z.object({
  invites: z.array(ExecutorInviteSummarySchema),
}) satisfies z.ZodType<ServerExecutorInvitesPayload>

export const ServerExecutorInvitePayloadSchema = z.object({
  id: z.string(),
  inviteToken: z.string(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().optional(),
  revoked: z.boolean().optional(),
}) satisfies z.ZodType<ServerExecutorInvitePayload>

export const ServerExecutorInviteRevokedPayloadSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  revoked: z.boolean(),
}) satisfies z.ZodType<ServerExecutorInviteRevokedPayload>

// Silence unused import warnings for types that are only used as annotations.
export type { ManualModelInput }
void ManualModelInputSchema

// ============================================================================
// JSONL log entries (used by the log ingester)
// ============================================================================

export const HeaderEntrySchema = z.object({
  kind: z.literal('header'),
  seq: z.literal(0),
  ts: z.string(),
  sessionId: z.string(),
  agentRuntime: z.enum(['kernel', 'copilot']).optional(),
  executionMode: z.enum(['chat', 'dag']).optional(),
  agentRuntimeVersion: z.string().optional(),
  externalSessionId: z.string().optional(),
  parentSessionId: z.string().optional(),
  parentCursor: z.number().int().nonnegative().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  initialCwd: z.string().optional(),
  formatVersion: z.literal(2),
  kernelVersion: z.string(),
  config: AgentConfigSchema,
  initialState: AgentStateSchema,
}) satisfies z.ZodType<HeaderEntry>

const LogArtifactRefSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  sha256: z.string(),
})

export const EventEntrySchema = z.object({
  kind: z.literal('event'),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  event: AgentEventSchema,
  effects: z.array(EffectSchema),
  usage: UsageTotalSchema.optional(),
  effectsArtifact: LogArtifactRefSchema.optional(),
  llmTrace: LLMTraceSchema.optional(),
  llmTraceArtifact: LogArtifactRefSchema.optional(),
  model: z.string().optional(),
  timing: EventTimingMetadataSchema.optional(),
}) satisfies z.ZodType<EventEntry>

export const SnapshotEntrySchema = z.object({
  kind: z.literal('snapshot'),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  state: AgentStateSchema,
}) satisfies z.ZodType<SnapshotEntry>

export const MetadataEntrySchema = z.object({
  kind: z.literal('metadata'),
  ts: z.string(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  selectedModel: z.string().optional(),
  toolCardMode: z.enum(['dots', 'standard']).optional(),
  transcriptViewStart: z.number().int().nonnegative().max(10_000_000).optional(),
  rightPanelTab: z.enum(['files', 'git', 'terminal', 'inspector', 'scheduledTasks', 'computer']).optional(),
  chapterReadingMode: z.enum(['chapters', 'continuous']).nullable().optional(),
}) satisfies z.ZodType<MetadataEntry>

export const RuntimeMetadataEntrySchema = z.object({
  kind: z.literal('runtime_metadata'),
  ts: z.string(),
  sessionId: z.string(),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()),
  artifactRef: LogArtifactRefSchema.optional(),
}) satisfies z.ZodType<RuntimeMetadataEntry>

export const LogEntrySchema = z.discriminatedUnion('kind', [
  HeaderEntrySchema,
  EventEntrySchema,
  SnapshotEntrySchema,
  MetadataEntrySchema,
  RuntimeMetadataEntrySchema,
]) satisfies z.ZodType<LogEntry>
