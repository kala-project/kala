/**
 * Zod schemas for Dashboard→Host RPC inputs (socket 'client:*' + 'bg:*'
 * + 'sub_agent:*' + 'agent_types:*' payloads, plus HTTP request bodies).
 *
 * types-first: `../protocol.ts` remains authoritative. Each schema is checked
 * against its TS counterpart via `satisfies z.ZodType<T>`.
 *
 * Boundary usage: `.parse()` these in socket + HTTP handlers only.
 */

import { z } from 'zod'

import type {
  ClientCancel,
  ClientCancelStream,
  ClientClear,
  ClientCompact,
  ClientConsolidateMemory,
  ClientCreateSession,
  ClientGetDagRun,
  ClientGetGlobalStorage,
  ClientGetSessionStorage,
  ClientPrepareStorageCleanup,
  ClientExecuteStorageCleanup,
  ClientListDagRuns,
  ClientInitializeDag,
  ClientCreateDirectory,
  ClientDeleteQueuedMessage,
  ClientDeleteSession,
  ClientFork,
  ClientGitDiff,
  ClientGitStatus,
  ClientInterruptSubAgent,
  ClientKillBgTask,
  ClientListAgentTypes,
  ClientListBgTasks,
  ClientListDirs,
  ClientListExecutors,
  ClientListFiles,
  ClientListSessions,
  ClientListSubAgents,
  ClientLoadLogArtifact,
  ClientLoadHistory,
  ClientPrepareSessionRoute,
  ClientReadBgOutput,
  ClientReadFile,
  ClientReadOverflow,
  ClientRenameSession,
  ClientRenameWorkspace,
  ClientReorderQueuedMessage,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientSetDefaultModel,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientTerminalCreate,
  ClientTerminalCloseSession,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  ClientUpdatePreferences,
  ClientUpdateQueuedMessage,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  ClientAddManualModel,
  ClientAddManualProvider,
  ClientAskUserChoice,
  ClientAnswerDagDecision,
  ClientUpdateAgentPromptSettings,
  ClientDeleteManualModel,
  ClientDeleteManualProvider,
  ClientSubscribeChannels,
  ClientUnsubscribeChannels,
  CopyOverflowSession,
  DeleteOverflowSession,
  ManualModelInput,
  ManualProviderInput,
  SessionPreferencesPatch,
} from '../protocol.js'
import { ApprovalModeSchema, MessageContentSchema } from './kernel.js'

const NonEmptyStringSchema = z.string().trim().min(1)
const SessionIdSchema = NonEmptyStringSchema
const WorkspaceIdSchema = NonEmptyStringSchema
const RequestIdSchema = NonEmptyStringSchema
const WireIdSchema = NonEmptyStringSchema
const UrlStringSchema = z.string().trim().url()
const RelativePathSchema = z.string().trim().min(1).refine(
  (value) => !value.startsWith('/') && !value.startsWith('\\\\') && !value.split(/[\\/]+/u).includes('..'),
  'path must be repo-relative',
)

// ============================================================================
// Per-session preferences
// ============================================================================

export const SessionPreferencesSchema = z.object({
  selectedModel: z.string().trim().optional(),
  toolCardMode: z.enum(['dots', 'standard']).optional(),
  transcriptViewStart: z.number().int().nonnegative().max(10_000_000).optional(),
  rightPanelTab: z.enum(['files', 'git', 'terminal', 'inspector', 'scheduledTasks']).optional(),
  chapterReadingMode: z.enum(['chapters', 'continuous']).nullable().optional(),
}) satisfies z.ZodType<SessionPreferencesPatch>

const OperationIdSchema = z.string().min(1).max(128).optional()

// ============================================================================
// Composer / turn-loop
// ============================================================================

export const ClientUserMessageSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  text: z.string(),
  intent: z.enum(['text', 'shell']),
  mode: z.enum(['steer', 'queue']).optional(),
  content: z.array(MessageContentSchema).optional(),
}) satisfies z.ZodType<ClientUserMessage>

export const ClientUserApproveSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
}) satisfies z.ZodType<ClientUserApprove>

export const ClientUserRejectSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
  reason: z.string().optional(),
}) satisfies z.ZodType<ClientUserReject>

export const ClientAskUserChoiceSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
  value: z.string().min(1).max(500).optional(),
  values: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
  customText: z.string().min(1).max(4000).optional(),
}).strict().refine(
  (payload) => [payload.value, payload.values, payload.customText].filter((value) => value !== undefined).length === 1,
  { message: 'Exactly one of value, values, or customText is required' },
) satisfies z.ZodType<ClientAskUserChoice>

export const ClientCancelSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientCancel>

export const ClientClearSchema = z.object({
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientClear>

export const ClientCompactSchema = z.object({
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientCompact>

export const ClientCancelStreamSchema = z.object({
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientCancelStream>

export const ClientInterruptSubAgentSchema = z.object({
  parentSessionId: SessionIdSchema,
  parentCallId: WireIdSchema,
  childSessionId: SessionIdSchema.optional(),
}) satisfies z.ZodType<ClientInterruptSubAgent>

export const ClientSetApprovalModeSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  mode: ApprovalModeSchema,
}) satisfies z.ZodType<ClientSetApprovalMode>

// ============================================================================
// Session lifecycle
// ============================================================================

export const ClientForkSchema = z.object({
  sourceSessionId: SessionIdSchema,
  cursor: z.number().int().nonnegative(),
  newSessionId: SessionIdSchema.optional(),
  seedMessage: z.string().optional(),
}) satisfies z.ZodType<ClientFork>

export const ClientCreateSessionSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  agentRuntime: z.enum(['kernel', 'copilot']).optional(),
  executionMode: z.enum(['chat', 'dag']).optional(),
  workspaceId: WorkspaceIdSchema.optional(),
  workspaceName: z.string().optional(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).readonly().optional(),
  selectedModel: z.string().optional(),
}) satisfies z.ZodType<ClientCreateSession>

const DagPlanNodeInputSchema = z.object({
  id: NonEmptyStringSchema.max(128),
  title: NonEmptyStringSchema.max(240),
  instructions: NonEmptyStringSchema.max(20_000),
  writeScopes: z.array(z.string().max(1024)).max(64).readonly().optional(),
  estimatedDurationMinutes: z.number().positive().max(100_000).optional(),
}).strict()

const DagPlanEdgeInputSchema = z.object({
  source: NonEmptyStringSchema.max(128),
  target: NonEmptyStringSchema.max(128),
}).strict()

export const ClientGetDagRunSchema = z.object({
  operationId: z.string().min(1).max(128).optional(),
  sessionId: SessionIdSchema,
}).strict() satisfies z.ZodType<ClientGetDagRun>

export const ClientListDagRunsSchema = z.object({
  operationId: z.string().min(1).max(128).optional(),
  sessionId: SessionIdSchema,
}).strict() satisfies z.ZodType<ClientListDagRuns>

export const ClientInitializeDagSchema = z.object({
  sessionId: SessionIdSchema,
  operationId: z.string().min(1).max(128),
  objective: NonEmptyStringSchema.max(20_000),
  graph: z.object({
    expectedGraphVersion: z.number().int().nonnegative(),
    resultNodeId: NonEmptyStringSchema.max(128),
    nodes: z.array(DagPlanNodeInputSchema).min(1).max(100).readonly(),
    edges: z.array(DagPlanEdgeInputSchema).max(500).readonly(),
  }).strict(),
}).strict() satisfies z.ZodType<ClientInitializeDag>

export const ClientAnswerDagDecisionSchema = z.object({
  operationId: z.string().min(1).max(128),
  sessionId: SessionIdSchema,
  runId: NonEmptyStringSchema,
  decisionId: NonEmptyStringSchema,
  answer: NonEmptyStringSchema.max(20_000),
}).strict() satisfies z.ZodType<ClientAnswerDagDecision>

export const ClientSubscribeSchema = z.object({
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientSubscribe>

export const ClientUnsubscribeSchema = z.object({
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientUnsubscribe>

export const DashboardChannelSchema = z.string().refine(
  (value): value is import('../protocol.js').DashboardChannel => value === 'global' || /^(?:workspace|session):[^:]+$/u.test(value),
  'invalid dashboard channel',
)
export const ClientSubscribeChannelsSchema = z.object({
  requestId: RequestIdSchema,
  generation: z.number().int().nonnegative(),
  channels: z.array(DashboardChannelSchema).max(128),
  cursors: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).strict() satisfies z.ZodType<ClientSubscribeChannels>
export const ClientUnsubscribeChannelsSchema = z.object({
  requestId: RequestIdSchema,
  generation: z.number().int().nonnegative(),
  channels: z.array(DashboardChannelSchema).max(128),
}).strict() satisfies z.ZodType<ClientUnsubscribeChannels>

export const ClientLoadHistorySchema = z.object({
  sessionId: SessionIdSchema,
  sinceCursor: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<ClientLoadHistory>

export const ClientPrepareSessionRouteSchema = z.object({
  sessionId: SessionIdSchema,
}).strict() satisfies z.ZodType<ClientPrepareSessionRoute>

export const ClientLoadLogArtifactSchema = z.object({
  sessionId: SessionIdSchema,
  seq: z.number().int().nonnegative(),
}) satisfies z.ZodType<ClientLoadLogArtifact>

export const ClientDeleteSessionSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
}).strict() satisfies z.ZodType<ClientDeleteSession>

export const ClientGetSessionStorageSchema = z.object({
  sessionId: SessionIdSchema,
  refresh: z.boolean().optional(),
}).strict() satisfies z.ZodType<ClientGetSessionStorage>

export const ClientGetGlobalStorageSchema = z.object({
  refresh: z.boolean().optional(),
}).strict() satisfies z.ZodType<ClientGetGlobalStorage>

export const ClientPrepareStorageCleanupSchema = z.object({
  operation: z.enum(['subagent-details', 'session-tree', 'orphan-artifacts', 'derived-artifacts']),
  targetId: SessionIdSchema,
}).strict() satisfies z.ZodType<ClientPrepareStorageCleanup>

export const ClientExecuteStorageCleanupSchema = z.object({
  planId: z.string().uuid(),
}).strict() satisfies z.ZodType<ClientExecuteStorageCleanup>

// The wire form of a `Record<string, never>` payload is `undefined` or `{}` —
// socket.io emits `undefined` when the client calls `socket.emit(evt)` with no
// arg, and `{}` when it passes an explicit empty object. Accept both, coerce
// to `{}` so downstream code has a stable shape.
const EmptyRecordSchema = z
  .union([z.undefined(), z.record(z.string(), z.never())])
  .transform(() => ({}) as Record<string, never>)

export const ClientListSessionsSchema = EmptyRecordSchema as unknown as z.ZodType<ClientListSessions>

export const ClientListExecutorsSchema = EmptyRecordSchema as unknown as z.ZodType<ClientListExecutors>

// ============================================================================
// Model / preferences / cwd
// ============================================================================

export const ClientUpdatePreferencesSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  preferences: SessionPreferencesSchema,
}) satisfies z.ZodType<ClientUpdatePreferences>

export const ClientSetCwdSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  cwd: z.string(),
}) satisfies z.ZodType<ClientSetCwd>

// ============================================================================
// Queued messages
// ============================================================================

export const ClientReorderQueuedMessageSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  id: WireIdSchema,
  beforeId: WireIdSchema.nullable().optional(),
}) satisfies z.ZodType<ClientReorderQueuedMessage>

export const ClientUpdateQueuedMessageSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  id: WireIdSchema,
  text: z.string(),
  content: z.array(MessageContentSchema).optional(),
}) satisfies z.ZodType<ClientUpdateQueuedMessage>

export const ClientDeleteQueuedMessageSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  id: WireIdSchema,
}) satisfies z.ZodType<ClientDeleteQueuedMessage>

// ============================================================================
// Rename
// ============================================================================

export const ClientRenameSessionSchema = z.object({
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
  label: z.string(),
}) satisfies z.ZodType<ClientRenameSession>

export const ClientRenameWorkspaceSchema = z.object({
  operationId: OperationIdSchema,
  workspaceId: WorkspaceIdSchema,
  workspaceName: z.string(),
}) satisfies z.ZodType<ClientRenameWorkspace>

// ============================================================================
// Filesystem RPCs
// ============================================================================

export const ClientListDirsSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  path: z.string().optional(),
}) satisfies z.ZodType<ClientListDirs>

export const ClientCreateDirectorySchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  parentPath: z.string().trim().min(1),
  name: z.string().trim().min(1),
}) satisfies z.ZodType<ClientCreateDirectory>

export const ClientListFilesSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<ClientListFiles>

export const ClientReadFileSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  path: z.string(),
  maxBytes: z.number().int().positive().optional(),
  download: z.boolean().optional(),
}) satisfies z.ZodType<ClientReadFile>

export const ClientGitStatusSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  cwd: z.string().min(1).optional(),
}) satisfies z.ZodType<ClientGitStatus>

export const ClientGitDiffSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  path: RelativePathSchema,
  cwd: z.string().min(1).optional(),
  staged: z.boolean().optional(),
}) satisfies z.ZodType<ClientGitDiff>

export const ClientReadOverflowSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
}) satisfies z.ZodType<ClientReadOverflow>

export const ClientTerminalCreateSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  cwd: z.string().min(1).max(4096).optional(),
  cols: z.number().int().positive().max(500).optional(),
  rows: z.number().int().positive().max(500).optional(),
}) satisfies z.ZodType<ClientTerminalCreate>

export const ClientTerminalInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  terminalId: WireIdSchema,
  data: z.string().max(65_536),
}) satisfies z.ZodType<ClientTerminalInput>

export const ClientTerminalResizeSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  terminalId: WireIdSchema,
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500),
}) satisfies z.ZodType<ClientTerminalResize>

export const ClientTerminalKillSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  terminalId: WireIdSchema,
}) satisfies z.ZodType<ClientTerminalKill>

export const ClientTerminalCloseSessionSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientTerminalCloseSession>

export const DeleteOverflowSessionSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<DeleteOverflowSession>

export const CopyOverflowSessionSchema = z.object({
  requestId: RequestIdSchema,
  sourceSessionId: SessionIdSchema,
  targetSessionId: SessionIdSchema,
}) satisfies z.ZodType<CopyOverflowSession>

// ============================================================================
// Background tasks
// ============================================================================

export const ClientListBgTasksSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientListBgTasks>

export const ClientReadBgOutputSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  taskId: WireIdSchema,
  offset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
}) satisfies z.ZodType<ClientReadBgOutput>

export const ClientKillBgTaskSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  taskId: WireIdSchema,
}) satisfies z.ZodType<ClientKillBgTask>

// ============================================================================
// Sub-agents
// ============================================================================

export const ClientListSubAgentsSchema = z.object({
  requestId: RequestIdSchema,
  parentSessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientListSubAgents>

export const ClientListAgentTypesSchema = z.object({
  requestId: RequestIdSchema,
}) satisfies z.ZodType<ClientListAgentTypes>

// ============================================================================
// Misc
// ============================================================================

export const ClientConsolidateMemorySchema = z.object({
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
}) satisfies z.ZodType<ClientConsolidateMemory>

// ============================================================================
// HTTP body: manual model add/delete
// ============================================================================

export const ManualModelInputSchema = z.object({
  providerId: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  label: z.string().trim().optional(),
  contextWindow: z.number().int().positive().optional(),
}) satisfies z.ZodType<ManualModelInput>

export const ManualProviderInputSchema = z.object({
  id: NonEmptyStringSchema,
  label: z.string().trim().optional(),
  wire: z.enum(['anthropic', 'openai']),
  baseUrl: UrlStringSchema,
  apiKey: NonEmptyStringSchema,
}) satisfies z.ZodType<ManualProviderInput>

export const ClientAddManualProviderSchema = ManualProviderInputSchema satisfies z.ZodType<ClientAddManualProvider>

export const ClientDeleteManualProviderSchema = z.object({
  providerId: NonEmptyStringSchema,
}) satisfies z.ZodType<ClientDeleteManualProvider>

export const ClientAddManualModelSchema = ManualModelInputSchema satisfies z.ZodType<ClientAddManualModel>

export const ClientDeleteManualModelSchema = z.object({
  providerId: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
}) satisfies z.ZodType<ClientDeleteManualModel>

export const ClientSetDefaultModelSchema = z.object({
  model: NonEmptyStringSchema,
}) satisfies z.ZodType<ClientSetDefaultModel>

export const ClientUpdateAgentPromptSettingsSchema = z.object({
  selectedSlotId: z.enum(['slot-1', 'slot-2', 'slot-3']),
  slots: z.tuple([
    z.object({ id: z.literal('slot-1'), name: z.string().trim().min(1).max(80), prompt: z.string().min(1).max(100_000).refine((prompt) => prompt.trim().length > 0) }),
    z.object({ id: z.literal('slot-2'), name: z.string().trim().min(1).max(80), prompt: z.string().min(1).max(100_000).refine((prompt) => prompt.trim().length > 0) }),
    z.object({ id: z.literal('slot-3'), name: z.string().trim().min(1).max(80), prompt: z.string().min(1).max(100_000).refine((prompt) => prompt.trim().length > 0) }),
  ]),
}) satisfies z.ZodType<ClientUpdateAgentPromptSettings>
