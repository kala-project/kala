/**
 * Zod schemas for the executor↔host wire surface.
 *
 * types-first: TypeScript definitions in `../protocol.ts` remain authoritative.
 * Each exported schema is checked against its TS counterpart via
 * `satisfies z.ZodType<T>` so drift surfaces at compile time.
 *
 * Boundary usage: `.parse()` these at socket-handler edges only
 * (see `packages/host/src/executor-socket.ts`). Never inside pure internal
 * functions.
 */

import { z } from 'zod'

import type {
  ExecutorAnnounce,
  ExecutorOs,
  ExecutorRuntime,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
  ServerTerminalExit,
  ServerTerminalOutput,
  ToolCallMessage,
  ToolCancelMessage,
  ToolProgressPayload,
  ToolResultAck,
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  HandshakeAuth,
  ClientRole,
  ExecutorCapabilities,
  McpToolDescriptor,
} from '../protocol.js'

const NonEmptyStringSchema = z.string().trim().min(1)
const SessionIdSchema = NonEmptyStringSchema
const WorkspaceIdSchema = NonEmptyStringSchema
const WireIdSchema = NonEmptyStringSchema

// ============================================================================
// Handshake
// ============================================================================

export const ClientRoleSchema = z.enum(['dashboard', 'executor']) satisfies z.ZodType<ClientRole>

export const HandshakeAuthSchema = z.object({
  role: ClientRoleSchema,
  sessionId: SessionIdSchema.optional(),
  token: z.string().optional(),
  invite: z.string().optional(),
  installId: NonEmptyStringSchema.optional(),
  clientVersion: z.string(),
}) satisfies z.ZodType<HandshakeAuth>

// ============================================================================
// Executor → Host
// ============================================================================

const ExecutorRuntimeSchema = z.enum([
  'node',
  'browser-webcontainer',
  'other',
]) satisfies z.ZodType<ExecutorRuntime>

const ExecutorOsSchema = z.enum([
  'linux',
  'darwin',
  'win32',
  'other',
]) satisfies z.ZodType<ExecutorOs>

export const BuildMetadataSchema = z.object({
  releaseTag: z.string(),
  productVersion: z.string().optional(),
  gitCommit: z.string(),
  builtAt: z.string(),
  artifactKind: z.enum(['source', 'cjs', 'native']),
  dashboardMode: z.enum(['vite', 'static', 'embedded', 'none']),
  embeddedDashboardFiles: z.number().int().nonnegative().optional(),
  socketAdminMode: z.enum(['embedded', 'filesystem', 'missing']).optional(),
  embeddedSocketAdminFiles: z.number().int().nonnegative().optional(),
})

export const ExecutorCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  features: z.object({
    backgroundShell: z.boolean(),
    filePicker: z.boolean(),
    overflowFiles: z.boolean(),
    workspaceSandbox: z.boolean(),
  }),
}) satisfies z.ZodType<ExecutorCapabilities>

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]))

export const McpToolDescriptorSchema = z.object({
  name: z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*__[A-Za-z0-9_-]+$/u),
  description: z.string().max(4_096),
  inputSchema: z.record(z.string(), JsonValueSchema),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict() satisfies z.ZodType<McpToolDescriptor>

export const ExecutorAnnounceSchema = z.object({
  executorId: WireIdSchema,
  installId: WireIdSchema.optional(),
  executorVersion: z.string().optional(),
  build: BuildMetadataSchema.optional(),
  capabilities: ExecutorCapabilitiesSchema.optional(),
  workspaceId: WorkspaceIdSchema,
  workspaceName: z.string(),
  tools: z.array(z.string()),
  mcpTools: z.array(McpToolDescriptorSchema).max(512).optional(),
  toolImplementations: z.record(z.string(), z.object({ version: z.string() })).optional(),
  sandboxRoots: z.array(z.string()).optional(),
  defaultCwd: z.string().optional(),
  workingDir: z.string().optional(),
  runtime: ExecutorRuntimeSchema,
  runtimeVersion: z.string(),
  hostname: z.string().optional(),
  os: ExecutorOsSchema.optional(),
  ipAddresses: z.array(z.string()).optional(),
  pid: z.number().int().optional(),
  startedAt: z.string().optional(),
}) satisfies z.ZodType<ExecutorAnnounce>

export const ToolProgressPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
  chunk: z.string(),
}) satisfies z.ZodType<ToolProgressPayload>

const BackgroundTaskStatusSchema = z.enum([
  'running',
  'exited',
  'killed',
  'signaled',
]) satisfies z.ZodType<BackgroundTaskStatus>

export const BackgroundTaskSummarySchema = z.object({
  taskId: WireIdSchema,
  sessionId: SessionIdSchema,
  command: z.string(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: BackgroundTaskStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  bytesLogged: z.number().int().nonnegative(),
  bytesTruncated: z.number().int().nonnegative(),
}) satisfies z.ZodType<BackgroundTaskSummary>

export const ServerBgTaskUpdatedSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  task: BackgroundTaskSummarySchema,
  delta: z
    .object({
      fromOffset: z.number().int().nonnegative(),
      content: z.string(),
    })
    .optional(),
}) satisfies z.ZodType<ServerBgTaskUpdated>

export const ServerBgTaskEvictedSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  taskId: WireIdSchema,
}) satisfies z.ZodType<ServerBgTaskEvicted>

export const ServerTerminalOutputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  terminalId: WireIdSchema,
  data: z.string().max(1_048_576),
}) satisfies z.ZodType<ServerTerminalOutput>

export const ServerTerminalExitSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  terminalId: WireIdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
}) satisfies z.ZodType<ServerTerminalExit>

// ============================================================================
// Host → Executor
// ============================================================================

export const ToolCallMessageSchema = z.object({
  origin: z.literal('host').optional(),
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  cwd: z.string().optional(),
  ackTimeoutMs: z.number().int().nonnegative().optional(),
  turnId: WireIdSchema.optional(),
}) satisfies z.ZodType<ToolCallMessage>

export const ToolCancelMessageSchema = z.object({
  sessionId: SessionIdSchema,
  callId: WireIdSchema,
}) satisfies z.ZodType<ToolCancelMessage>

export const ToolResultAckSchema = z.object({
  callId: WireIdSchema,
  ok: z.boolean(),
  content: z.string(),
  failure: z.object({ code: z.string(), category: z.enum(['input','precondition','execution','infrastructure','cancelled']), outcome: z.enum(['blocked','failed','cancelled','timeout','indeterminate']), retryable: z.boolean(), responsibility: z.enum(['model','workspace','provider','user','system']), timeoutStage: z.enum(['queue','acknowledgement','execution','idle_output']).optional() }).optional(),
  durationMs: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<ToolResultAck>
