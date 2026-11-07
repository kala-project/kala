/**
 * Zod schemas for @agent-kernel/kernel core types.
 *
 * types-first: TypeScript definitions in `@agent-kernel/kernel/src/types.ts`
 * remain authoritative. Each schema below is typed as `z.ZodType<TheType>`
 * so any drift between the schema and the TS type surfaces as a compile
 * error, not a runtime surprise.
 *
 * These schemas are consumed by wire-boundary validators
 * (see `dashboard-inbound.ts`, `executor.ts`) — do NOT call `.parse()` on
 * them inside pure internal functions.
 */

import { z } from 'zod'

import type {
  AgentConfig,
  AgentModuleMetadata,
  AgentEvent,
  AgentState,
  AgentStatus,
  ApprovalMode,
  Effect,
  ImageContent,
  ImageSource,
  FileContent,
  Message,
  MessageContent,
  PendingToolCall,
  ReasoningContent,
  Role,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  ToolSchema,
  UsageDelta,
  UsageTotal,
} from '@agent-kernel/kernel'

// ============================================================================
// Enums / scalars
// ============================================================================

export const RoleSchema: z.ZodType<Role> = z.enum(['system', 'user', 'assistant', 'tool'])

export const AgentStatusSchema: z.ZodType<AgentStatus> = z.enum([
  'idle',
  'thinking',
  'awaiting_approval',
  'executing_tools',
  'done',
  'error',
])

export const ApprovalModeSchema: z.ZodType<ApprovalMode> = z.enum([
  'auto',
  'ask',
  'deny',
  'allow_all',
])

const ImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// ============================================================================
// MessageContent variants + union
// ============================================================================

export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ToolCallContentSchema = z.object({
  type: z.literal('tool_call'),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
})

const ToolFailureSchema = z.object({ code: z.string(), category: z.enum(['input','precondition','execution','infrastructure','cancelled']), outcome: z.enum(['blocked','failed','cancelled','timeout','indeterminate']), retryable: z.boolean(), responsibility: z.enum(['model','workspace','provider','user','system']), timeoutStage: z.enum(['queue','acknowledgement','execution','idle_output']).optional() })

export const ToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  callId: z.string(),
  ok: z.boolean(),
  content: z.string(),
  failure: ToolFailureSchema.optional(),
})

export const ImageSourceSchema: z.ZodType<ImageSource> = z.union([
  z.object({
    kind: z.literal('base64'),
    mediaType: ImageMediaTypeSchema,
    data: z.string(),
  }),
  z.object({
    kind: z.literal('file_ref'),
    path: z.string(),
    mediaType: ImageMediaTypeSchema.optional(),
  }),
])

export const ImageContentSchema = z.object({
  type: z.literal('image'),
  source: ImageSourceSchema,
})

export const LegacyInlineFileContentSchema = z.object({
  type: z.literal('file'),
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(255),
  data: z.string(),
})

export const HostAttachmentReferenceSchema = z.object({
  kind: z.literal('host_ref'),
  attachmentId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
}).strict()

export const ReferencedFileContentSchema = z.object({
  type: z.literal('file'),
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(255),
  source: HostAttachmentReferenceSchema,
}).strict()

export const FileContentSchema: z.ZodType<FileContent> = z.union([
  LegacyInlineFileContentSchema,
  ReferencedFileContentSchema,
])

export const ReasoningContentSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
  signature: z.string().optional(),
  provider: z.string().optional(),
})

export const MessageContentSchema = z.union([
  TextContentSchema,
  ToolCallContentSchema,
  ToolResultContentSchema,
  ImageContentSchema,
  FileContentSchema,
  ReasoningContentSchema,
]) satisfies z.ZodType<MessageContent>

export const MessageSchema: z.ZodType<Message> = z.object({
  role: RoleSchema,
  content: z.array(MessageContentSchema),
  metadata: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('model_changed'),
      from: z.string().optional(),
      to: z.string(),
    }),
    z.object({
      kind: z.literal('context_compaction'),
      attemptId: z.string().min(1),
      phase: z.enum(['running', 'done', 'error']),
      trigger: z.enum(['manual', 'auto', 'preflight', 'tool_result']),
      tokensBefore: z.number().int().nonnegative(),
      tokensAfter: z.number().int().nonnegative().optional(),
      replacedCount: z.number().int().nonnegative().optional(),
      summary: z.string().optional(),
      startedAt: z.string(),
      endedAt: z.string().optional(),
      error: z.string().optional(),
    }),
    z.object({
      kind: z.literal('temporal'),
      messageId: z.string().min(1),
      turnId: z.string().min(1),
      createdAt: z.string(),
      turnStartedAt: z.string(),
      turnCompletedAt: z.string().optional(),
      turnDurationMs: z.number().int().nonnegative().optional(),
      turnStatus: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
    }),
  ]).optional(),
})

// ============================================================================
// ToolSchema
// ============================================================================

export const ToolSchemaSchema: z.ZodType<ToolSchema> = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  requiresApproval: z.boolean(),
  version: z.string().optional(),
  schemaHash: z.string().optional(),
  toolsetId: z.string().optional(),
  toolsetVersion: z.string().optional(),
  risk: z.enum(['read', 'write', 'shell', 'network', 'memory', 'agent']).optional(),
  executionKind: z.enum(['host', 'executor']).optional(),
  executionHandler: z.string().optional(),
})

export const AgentModuleMetadataSchema: z.ZodType<AgentModuleMetadata> = z.object({
  id: z.string(),
  version: z.string(),
  label: z.string(),
  systemPromptHash: z.string(),
  toolRegistryHash: z.string(),
  toolsets: z.array(z.object({
    id: z.string(),
    version: z.string(),
    label: z.string(),
    toolCount: z.number().int().nonnegative(),
  })),
})

// ============================================================================
// AgentConfig
// ============================================================================

export const AgentConfigSchema: z.ZodType<AgentConfig> = z.object({
  tools: z.array(ToolSchemaSchema),
  toolDisclosureMode: z.enum(['legacy_full', 'progressive']).optional(),
  systemPrompt: z.string().optional(),
  agentModule: AgentModuleMetadataSchema.optional(),
  contextLimit: z.number().int().nonnegative().optional(),
  softThreshold: z.number().min(0).max(1).optional(),
  hardThreshold: z.number().min(0).max(1).optional(),
  maxAgentDepth: z.number().int().nonnegative().optional(),
  maxAgentFanOut: z.number().int().nonnegative().optional(),
  thinkingBudget: z.number().int().nonnegative().optional(),
})

// ============================================================================
// PendingToolCall / UsageTotal / AgentState
// ============================================================================

export const PendingToolCallSchema: z.ZodType<PendingToolCall> = z.object({
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
  status: z.enum(['awaiting_approval', 'approved', 'rejected', 'dispatched']),
})

export const UsageTotalSchema: z.ZodType<UsageTotal> = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
})

export const UsageDeltaSchema: z.ZodType<UsageDelta> = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
})

const AgentStateCommonSchema = z.object({
  sessionId: z.string(),
  messages: z.array(MessageSchema),
  usage: UsageTotalSchema,
  cursor: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  approvalMode: ApprovalModeSchema,
}).strict()

const EmptyPendingCallsSchema = z.custom<readonly[]>(
  (value) => Array.isArray(value) && value.length === 0,
  'pendingCalls must be empty in this phase',
)

export const AgentStateSchema: z.ZodType<AgentState> = z.discriminatedUnion('status', [
  AgentStateCommonSchema.extend({ status: z.literal('idle'), pendingCalls: EmptyPendingCallsSchema }),
  AgentStateCommonSchema.extend({ status: z.literal('thinking'), pendingCalls: EmptyPendingCallsSchema }),
  AgentStateCommonSchema.extend({ status: z.literal('done'), pendingCalls: EmptyPendingCallsSchema }),
  AgentStateCommonSchema.extend({
    status: z.literal('awaiting_approval'),
    pendingCalls: z.array(PendingToolCallSchema),
  }),
  AgentStateCommonSchema.extend({
    status: z.literal('executing_tools'),
    pendingCalls: z.array(PendingToolCallSchema),
  }),
  AgentStateCommonSchema.extend({
    status: z.literal('error'),
    pendingCalls: EmptyPendingCallsSchema,
    error: z.string().trim().min(1),
  }),
])

// ============================================================================
// AgentEvent — every kind
// ============================================================================

const UserMessageEventSchema = z.object({
  kind: z.literal('user_message'),
  operationId: z.string().min(1).optional(),
  queuedAt: z.string().optional(),
  text: z.string().optional(),
  content: z.array(MessageContentSchema).optional(),
})

const LlmResponseEventSchema = z.object({
  kind: z.literal('llm_response'),
  message: MessageSchema,
  usage: UsageDeltaSchema.optional(),
  finishReason: z.string().optional(),
})

const LlmErrorEventSchema = z.object({
  kind: z.literal('llm_error'),
  error: z.string(),
})

const UserApproveEventSchema = z.object({
  kind: z.literal('user_approve'),
  callId: z.string(),
})

const UserRejectEventSchema = z.object({
  kind: z.literal('user_reject'),
  callId: z.string(),
  reason: z.string().optional(),
})

const ToolResultEventSchema = z.object({
  kind: z.literal('tool_result'),
  callId: z.string(),
  ok: z.boolean(),
  content: z.string(),
  failure: ToolFailureSchema.optional(),
})

const CancelEventSchema = z.object({ kind: z.literal('cancel') })

const ClearEventSchema = z.object({ kind: z.literal('clear') })

const EventArtifactRefSchema = z.object({
  kind: z.string().optional(),
  uri: z.string().optional(),
  path: z.string().optional(),
  sha256: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  mediaType: z.string().optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
})

const MessagesReplacedEventSchema = z.object({
  kind: z.literal('messages_replaced'),
  reason: z.enum(['compaction', 'manual_rewrite', 'recovery']),
  replaceRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  replacementMessages: z.array(MessageSchema),
  resume: z.boolean().optional(),
  artifactRef: EventArtifactRefSchema.optional(),
})

const ApprovalModeChangedEventSchema = z.object({
  kind: z.literal('approval_mode_changed'),
  mode: ApprovalModeSchema,
})

const CwdChangedEventSchema = z.object({
  kind: z.literal('cwd_changed'),
  cwd: z.string(),
})

export const AgentEventSchema = z.discriminatedUnion('kind', [
  UserMessageEventSchema,
  LlmResponseEventSchema,
  LlmErrorEventSchema,
  UserApproveEventSchema,
  UserRejectEventSchema,
  ToolResultEventSchema,
  CancelEventSchema,
  ClearEventSchema,
  MessagesReplacedEventSchema,
  ApprovalModeChangedEventSchema,
  CwdChangedEventSchema,
]) satisfies z.ZodType<AgentEvent>

// ============================================================================
// Effect — every kind
// ============================================================================

const CallLlmEffectSchema = z.object({
  kind: z.literal('call_llm'),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchemaSchema),
})

const CallToolEffectSchema = z.object({
  kind: z.literal('call_tool'),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
  cwd: z.string().optional(),
})

const RequestApprovalEffectSchema = z.object({
  kind: z.literal('request_approval'),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
})

const FinishEffectSchema = z.object({ kind: z.literal('finish') })

const EmitErrorEffectSchema = z.object({
  kind: z.literal('emit_error'),
  error: z.string(),
})

export const EffectSchema = z.discriminatedUnion('kind', [
  CallLlmEffectSchema,
  CallToolEffectSchema,
  RequestApprovalEffectSchema,
  FinishEffectSchema,
  EmitErrorEffectSchema,
]) satisfies z.ZodType<Effect>
