/**
 * Session store. In-memory map of live sessions + append-only JSONL log per
 * session on disk. The log is the source of truth; the in-memory record is
 * a cache for hot access.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { open, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  Message,
  MessageContent,
  UsageTotal,
} from '@agent-kernel/kernel'
import type {
  AgentRuntimeId,
  ContextUsageSnapshot,
  EventEntry,
  LLMTrace,
  MetadataEntry,
  RuntimeMetadataEntry,
  SessionMemoryPolicy,
  SessionExecutionMode,
  SessionPreferences,
  SessionPreferencesPatch,
  SnapshotEntry,
} from '@agent-kernel/shared'
import { createInitialState, fold } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'
import { ulid } from 'ulid'

import {
  appendEventEntry,
  appendMetadataEntry,
  appendRuntimeMetadataEntry,
  appendSnapshotEntry,
  findLatestEventEntry,
  findLatestRuntimeMetadata,
  findPersistedToolResult,
  findSessionOperation,
  readLastSessionSnapshot,
  readRecentSessionMetadata,
  readSessionHeader,
  readSessionHistory,
  readSessionLog,
  readSessionState,
  snapshotSidecarPath,
  writeHeader,
  type SessionOperationMatch,
} from './log.js'
import { step } from '@agent-kernel/kernel'
import { toolLockFor } from '../tool-version.js'
import { writeJsonFile } from '../tenant-runtime/atomic-json-file.js'
import type { PersistedSessionDocument, PostgresSessionAuthority } from './postgres-session-authority.js'

export type SessionRecord = {
  readonly sessionId: string
  readonly agentRuntime: AgentRuntimeId
  readonly executionMode: SessionExecutionMode
  readonly agentRuntimeVersion?: string
  readonly externalSessionId?: string
  readonly logPath: string
  readonly createdAt: string
  readonly config: AgentConfig
  readonly toolLock: Readonly<Record<string, { version: string; schemaHash: string | null }>>
  readonly parentSessionId?: string
  readonly parentCursor?: number
  readonly parentCallId?: string
  readonly agentType?: string
  readonly subAgentStartedAt?: string
  readonly workspaceId?: string
  readonly workspaceName?: string
  readonly organizationId?: string
  readonly principal?: string
  readonly organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  lastEventAt?: string
  /** Durable timestamp of the latest committed user turn; projected by the Host. */
  turnStartedAt?: string
  state: AgentState
  /** Stable default title captured from the first persisted user_message event. */
  firstUserMessage?: string
  /**
   * Operator-set display label from the most recent `client:rename_session`.
   * Loaded from the last MetadataEntry in the JSONL and updated in place
   * whenever the host writes a new metadata line.
   */
  label?: string
  preferences: SessionPreferences
  /** Last provider-reported context usage for external runtimes. */
  runtimeContextSnapshot?: ContextUsageSnapshot
  /**
   * Host-side memory policy for this session. When `mode: 'disabled'`, the
   * loop rejects `memory` tool calls to workspace/global scope so an isolated
   * session cannot inadvertently pull cross-task state from disk. Not part of
   * kernel state — the reducer never sees it and it is never persisted into
   * the JSONL ledger. Callers attach it via
   * `CreateSessionParams.memoryPolicy`.
   */
  memoryPolicy?: SessionMemoryPolicy
}

const EXTERNAL_RUNTIME_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
// Leave room for the SnapshotEntry envelope (`kind`, `seq`, `ts`, and `state`).
const EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES = EXTERNAL_RUNTIME_SNAPSHOT_MAX_BYTES - 1024
const EXTERNAL_RUNTIME_CONTENT_MAX_BYTES = 32 * 1024
const EXTERNAL_RUNTIME_TEXT_MAX_BYTES = 128 * 1024
const EXTERNAL_RUNTIME_INPUT_MAX_BYTES = 32 * 1024

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

function truncateUtf8(value: string, maxBytes: number, suffix: string): string {
  if (utf8Bytes(value) <= maxBytes) return value
  const suffixBytes = utf8Bytes(suffix)
  const headBytes = Math.max(0, maxBytes - suffixBytes)
  return Buffer.from(value, 'utf8').subarray(0, headBytes).toString('utf8') + suffix
}

function compactLargeString(value: string, maxBytes: number, label: string): string {
  const bytes = utf8Bytes(value)
  if (bytes <= maxBytes) return value
  const overflowIndex = value.lastIndexOf('--- output truncated:')
  const overflowMarker = overflowIndex >= 0 ? value.slice(overflowIndex) : undefined
  const suffix = overflowMarker && utf8Bytes(overflowMarker) < 4096
    ? `\n\n${overflowMarker}`
    : `\n\n--- ${label} compacted in projection snapshot: original ${bytes} bytes ---`
  const body = overflowMarker ? value.slice(0, overflowIndex).trimEnd() : value
  return truncateUtf8(body, maxBytes, suffix)
}

function compactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const bytes = jsonBytes(input)
  if (bytes <= EXTERNAL_RUNTIME_INPUT_MAX_BYTES) return input
  return {
    __snapshotCompacted: true,
    originalBytes: bytes,
    preview: truncateUtf8(
      JSON.stringify(input),
      EXTERNAL_RUNTIME_INPUT_MAX_BYTES,
      `\n--- tool input compacted in projection snapshot: original ${bytes} bytes ---`,
    ),
  }
}

function compactSnapshotContent(content: MessageContent, aggressive: boolean): MessageContent {
  if (content.type === 'tool_result') {
    const maxBytes = aggressive ? 4096 : EXTERNAL_RUNTIME_CONTENT_MAX_BYTES
    return {
      ...content,
      content: compactLargeString(content.content, maxBytes, 'tool result'),
    }
  }
  if (content.type === 'tool_call') {
    return {
      ...content,
      input: compactToolInput(content.input),
    }
  }
  if (content.type === 'text') {
    const maxBytes = aggressive ? 8192 : EXTERNAL_RUNTIME_TEXT_MAX_BYTES
    return {
      ...content,
      text: compactLargeString(content.text, maxBytes, 'text content'),
    }
  }
  if (content.type === 'thinking') {
    const maxBytes = aggressive ? 4096 : EXTERNAL_RUNTIME_TEXT_MAX_BYTES
    return {
      ...content,
      text: compactLargeString(content.text, maxBytes, 'reasoning content'),
    }
  }
  if (content.type === 'file' && 'data' in content && utf8Bytes(content.data) > EXTERNAL_RUNTIME_CONTENT_MAX_BYTES) {
    return {
      ...content,
      data: '',
      mediaType: 'text/plain',
      name: `${content.name}.snapshot-compacted`,
    }
  }
  if (content.type === 'image' && content.source.kind === 'base64' && utf8Bytes(content.source.data) > EXTERNAL_RUNTIME_CONTENT_MAX_BYTES) {
    return {
      ...content,
      source: {
        ...content.source,
        data: '',
      },
    }
  }
  return content
}

function compactSnapshotMessage(message: Message, aggressive: boolean): Message {
  // The active system prompt is an execution input, not disposable transcript
  // history. Truncating it would silently change behavior after a restart.
  if (message.role === 'system') return message
  return {
    ...message,
    content: message.content.map((content) => compactSnapshotContent(content, aggressive)),
  }
}

const SNAPSHOT_PLACEHOLDER = 'compacted in projection snapshot'

function isRealUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false
  return message.content.some((content) =>
    content.type !== 'text'
    || (content.text.trim().length > 0 && !content.text.includes(SNAPSHOT_PLACEHOLDER)),
  )
}

function normalizeToolPairs(messages: readonly Message[], pendingCallIds: ReadonlySet<string>): Message[] {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call') callIds.add(content.callId)
      else if (content.type === 'tool_result') resultIds.add(content.callId)
    }
  }
  const pairedCallIds = new Set([...callIds].filter((callId) => resultIds.has(callId)))
  return messages.flatMap((message) => {
    const content = message.content.filter((item) => {
      if (item.type === 'tool_result') return pairedCallIds.has(item.callId)
      if (item.type === 'tool_call') return pairedCallIds.has(item.callId) || pendingCallIds.has(item.callId)
      return true
    })
    return content.length > 0 ? [{ ...message, content }] : []
  })
}

function relatedMessageIndices(messages: readonly Message[]): Map<number, ReadonlySet<number>> {
  const indicesByCallId = new Map<string, Set<number>>()
  for (const [index, message] of messages.entries()) {
    for (const content of message.content) {
      if (content.type !== 'tool_call' && content.type !== 'tool_result') continue
      const indices = indicesByCallId.get(content.callId) ?? new Set<number>()
      indices.add(index)
      indicesByCallId.set(content.callId, indices)
    }
  }
  const related = new Map<number, Set<number>>()
  for (const indices of indicesByCallId.values()) {
    for (const index of indices) {
      const set = related.get(index) ?? new Set<number>([index])
      for (const relatedIndex of indices) set.add(relatedIndex)
      related.set(index, set)
    }
  }
  return related
}

function compactPendingCalls(state: AgentState, aggressive: boolean): AgentState {
  if (state.pendingCalls.length === 0) return state
  return {
    ...state,
    pendingCalls: state.pendingCalls.map((call) => ({
      ...call,
      input: aggressive ? { __snapshotCompacted: true } : compactToolInput(call.input),
    })),
  } as AgentState
}

export function compactExternalRuntimeSnapshotState(state: AgentState): AgentState {
  const pendingCallIds = new Set(state.pendingCalls.map((call) => call.callId))
  let messages = normalizeToolPairs(
    state.messages.map((message) => compactSnapshotMessage(message, false)),
    pendingCallIds,
  )
  let base = compactPendingCalls(state, false)
  let candidate = { ...base, messages } as AgentState
  if (jsonBytes(candidate) <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) return candidate

  messages = normalizeToolPairs(
    state.messages.map((message) => compactSnapshotMessage(message, true)),
    pendingCallIds,
  )
  base = compactPendingCalls(state, true)
  candidate = { ...base, messages } as AgentState
  if (jsonBytes(candidate) <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) return candidate

  const firstUserIndex = messages.findIndex(isRealUserMessage)
  const related = relatedMessageIndices(messages)
  const selected = new Set<number>()
  const rejected = new Set<number>()
  const messageBytes = messages.map(jsonBytes)
  const emptyStateBytes = jsonBytes({ ...base, messages: [] })
  let selectedMessageBytes = 0
  const relatedClosure = (index: number): Set<number> => {
    const closure = new Set<number>()
    const pending = [index]
    while (pending.length > 0) {
      const next = pending.pop()!
      if (closure.has(next)) continue
      closure.add(next)
      for (const relatedIndex of related.get(next) ?? []) pending.push(relatedIndex)
    }
    return closure
  }
  const trySelect = (index: number, required: boolean): void => {
    const closure = relatedClosure(index)
    const added = [...closure].filter((relatedIndex) => !selected.has(relatedIndex))
    const nextMessageBytes = selectedMessageBytes
      + added.reduce((total, relatedIndex) => total + messageBytes[relatedIndex]!, 0)
    const nextCount = selected.size + added.length
    const estimatedBytes = emptyStateBytes + nextMessageBytes + Math.max(0, nextCount - 1)
    if (required || estimatedBytes <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) {
      for (const relatedIndex of added) selected.add(relatedIndex)
      selectedMessageBytes = nextMessageBytes
    } else {
      for (const relatedIndex of closure) rejected.add(relatedIndex)
    }
  }
  const leadingSystemIndex = messages[0]?.role === 'system' ? 0 : -1
  if (leadingSystemIndex >= 0) trySelect(leadingSystemIndex, true)
  if (firstUserIndex >= 0) trySelect(firstUserIndex, true)

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.has(index) || rejected.has(index)) continue
    trySelect(index, false)
  }

  candidate = {
    ...base,
    messages: messages.filter((_, index) => selected.has(index)),
  } as AgentState
  if (jsonBytes(candidate) <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) return candidate

  throw new Error('External runtime snapshot cannot be compacted below 2 MiB without losing live state')
}

async function optionalSnapshot(path: string): Promise<SnapshotEntry[]> {
  const snapshot = await readLastSessionSnapshot(path)
  return snapshot ? [snapshot] : []
}

function configWithPersistedSystemPrompt(config: AgentConfig, state: AgentState): AgentConfig {
  const override = state.systemPromptOverride
  return override ? { ...config, systemPrompt: override.prompt } : config
}

function leadingSystemPrompt(state: AgentState): string {
  const first = state.messages[0]
  if (first?.role !== 'system') return ''
  return first.content
    .filter((content): content is Extract<MessageContent, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('')
}

export type CreateSessionParams = {
  systemPrompt?: string
  config: AgentConfig
  agentRuntime?: AgentRuntimeId
  executionMode?: SessionExecutionMode
  agentRuntimeVersion?: string
  externalSessionId?: string
  parentSessionId?: string
  parentCursor?: number
  parentCallId?: string
  agentType?: string
  subAgentStartedAt?: string
  initialState?: AgentState
  sessionId?: string
  workspaceId?: string
  workspaceName?: string
  organizationId?: string
  principal?: string
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  initialCwd?: string
  initialApprovalMode?: import('@agent-kernel/kernel').ApprovalMode
  memoryPolicy?: SessionMemoryPolicy
  preferences?: SessionPreferences
}

export type SessionStoreOptions = {
  runtimeConfig?: AgentConfig | ((context: { executionMode: SessionExecutionMode }) => AgentConfig)
  /** Root used by Host-side artifacts that partition data by Session ID. */
  artifactRootDir?: string | false
  /** Removes registry-backed Session artifacts that live outside artifactRootDir. */
  deleteRegisteredArtifacts?(sessionId: string): Promise<void>
  /** Marks lazily cached storage measurements stale without doing filesystem I/O. */
  onStorageChanged?(sessionId: string): void
  /** Private Cloud only. When present, Session state is authoritative in PostgreSQL and JSONL is never used. */
  authority?: PostgresSessionAuthority
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

const SESSION_ARTIFACT_KINDS = [
  'message-assembly',
  'router-decisions',
  'tool-catalog',
  'compaction-summaries',
  'subagent-policies',
] as const

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>()
  private readonly summaryCache = new Map<string, CachedSessionSummary>()
  private readonly summaryLoads = new Map<string, {
    mtimeMs: number
    size: number
    promise: Promise<SessionSummary>
  }>()
  /**
   * De-duplicates concurrent `ensure` / `load` requests for the same
   * sessionId. Two dashboard + executor sockets arriving for a fresh
   * session in the same tick previously raced through
   * `get → load(fail) → create` and produced two log files on disk. The
   * in-flight map guarantees only one `create()` per sessionId.
   */
  private readonly inFlight = new Map<string, Promise<SessionRecord>>()
  private readonly runtimeRecoveries = new Map<string, Promise<void>>()
  private readonly sessionLoadTails = new Map<string, Promise<SessionRecord>>()
  private readonly storageTombstones = new Set<string>()
  private readonly locallyProjectedExternalSessions = new Set<string>()
  /**
   * Last-resort per-Session commit lock. HostLoop normally serializes turns, but
   * cancellation, recovery and administrative paths have historically reached
   * `record()` concurrently. The store is the final authority and must reject
   * stale caller-computed states rather than append duplicate cursor values.
   */
  private readonly recordTails = new Map<string, Promise<void>>()
  /** Serializes the sidecar write because onState intentionally does not await it. */
  private readonly runtimeContextSnapshotTails = new Map<string, Promise<void>>()
  private readonly auxiliaryStorageWriteTails = new Map<string, Promise<unknown>>()
  private readonly storageCleanupLeases = new Set<string>()
  private readonly pendingStorageMutations = new Map<string, Set<Promise<void>>>()
  private readonly authorityReady: Promise<void> | undefined

  constructor(private readonly sessionsDir: string, private readonly options: SessionStoreOptions = {}) {
    if (options.authority) {
      this.authorityReady = options.authority.initialize().then(async () => {
        for (const document of await options.authority!.listDeleting()) {
          try {
            await this.finishPostgresDeletion(document.sessionId)
          } catch (error) {
            process.emitWarning(
              `Session deletion recovery remains pending for ${document.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
              { code: 'KALA_SESSION_DELETION_RECOVERY' },
            )
          }
        }
      })
    } else mkdirSync(this.sessionsDir, { recursive: true })
  }

  /** Finish authority initialization and pending deletion recovery before closing its pool. */
  async initialize(): Promise<void> {
    await this.authorityReady
  }

  get dir(): string {
    return this.sessionsDir
  }

  /** Backend-independent idempotency lookup used by HTTP and ingress paths. */
  async findOperation(
    sessionId: string,
    operationId: string,
    options: { maxScanBytes?: number } = {},
  ): Promise<SessionOperationMatch | undefined> {
    const record = this.get(sessionId) ?? await this.load(sessionId, { recoverDangling: false })
    if (this.options.authority) {
      await this.authorityReady
      return this.options.authority.findOperation(sessionId, operationId)
    }
    return findSessionOperation(record.logPath, operationId, options)
  }

  /** Append Host-owned metadata to the selected authority and return its durable envelope. */
  async appendRuntimeMetadata(
    sessionId: string,
    input: { action: string; payload: Record<string, unknown> },
    options: { durable?: boolean } = {},
  ): Promise<RuntimeMetadataEntry> {
    this.assertStorageWritable(sessionId)
    const record = this.get(sessionId) ?? await this.load(sessionId, { recoverDangling: false })
    const entry: RuntimeMetadataEntry = {
      kind: 'runtime_metadata',
      ts: new Date().toISOString(),
      sessionId,
      action: input.action,
      payload: input.payload,
    }
    if (this.options.authority) {
      await this.authorityReady
      const persisted = await this.options.authority.mutate(sessionId, {
        mutationId: `runtime.metadata:${input.action}:${randomMutationId()}`,
        eventType: `runtime.metadata.${input.action}`,
        entry,
        apply(current) {
          if (!current) throw new SessionNotFoundError(sessionId)
          return current
        },
      })
      if (!persisted) throw new SessionNotFoundError(sessionId)
      return entry
    }
    const appended = await appendRuntimeMetadataEntry(record.logPath, {
      sessionId,
      action: input.action,
      payload: input.payload,
    })
    if (options.durable) {
      const handle = await open(record.logPath, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    return appended
  }

  /** Read the latest Host metadata without exposing a JSONL path to callers. */
  async findLatestRuntimeMetadata(
    sessionId: string,
    action: string,
    options: { maxScanBytes?: number; committedProjection?: { cursor: number; ts: string } } = {},
  ): Promise<RuntimeMetadataEntry | undefined> {
    const record = this.get(sessionId) ?? await this.load(sessionId, { recoverDangling: false })
    if (this.options.authority) {
      await this.authorityReady
      return this.options.authority.findLatestRuntimeMetadata(sessionId, action)
    }
    return findLatestRuntimeMetadata(record.logPath, action, options)
  }

  /** Event timing history used to rebuild TurnTimingTracker after restart. */
  async readEventEntries(sessionId: string): Promise<readonly EventEntry[]> {
    const record = this.get(sessionId) ?? await this.load(sessionId, { recoverDangling: false })
    if (this.options.authority) {
      await this.authorityReady
      return this.options.authority.readEventEntries(sessionId)
    }
    return (await readSessionLog(record.logPath)).events
  }

  get usesPostgresAuthority(): boolean { return this.options.authority !== undefined }

  /** Full event history and Host metadata from the selected durable authority. */
  async readHistory(sessionId: string): ReturnType<typeof readSessionHistory> {
    const record = this.get(sessionId) ?? await this.load(sessionId, { recoverDangling: false })
    if (this.options.authority) {
      await this.authorityReady
      return this.options.authority.readHistory(sessionId)
    }
    return readSessionHistory(record.logPath)
  }

  /** Check a kernel Tool result in the selected durable authority without requiring a local JSONL projection. */
  async findPersistedKernelToolResult(sessionId: string, callId: string): Promise<boolean> {
    if (!callId) return false
    const record = this.get(sessionId) ?? await this.load(sessionId, { recoverDangling: false })
    if (!this.options.authority) return findPersistedToolResult(record.logPath, callId, 'kernel')
    const entries = await this.readEventEntries(sessionId)
    for (let index = entries.length - 1; index >= 0; index--) {
      const event = entries[index]!.event
      if (event.kind === 'tool_result' && event.callId === callId) return true
      if (event.kind === 'llm_response' && event.message.content.some(
        (content) => content.type === 'tool_call' && content.callId === callId,
      )) return false
    }
    return false
  }

  assertStorageWritable(sessionId: string): void {
    if (this.storageTombstones.has(sessionId)) {
      throw new Error(`Session ${sessionId} details were quarantined`)
    }
    if (this.storageCleanupLeases.has(sessionId)) {
      throw new Error(`Session ${sessionId} is locked for storage cleanup`)
    }
  }

  async withStorageMutationLease<T>(
    sessionIds: readonly string[],
    action: () => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(sessionIds)].sort()
    for (const sessionId of ids) this.assertStorageWritable(sessionId)
    for (const sessionId of ids) this.storageCleanupLeases.add(sessionId)
    try {
      await Promise.all(ids.flatMap((sessionId) => [
        this.recordTails.get(sessionId) ?? Promise.resolve(),
        this.runtimeContextSnapshotTails.get(sessionId) ?? Promise.resolve(),
        this.auxiliaryStorageWriteTails.get(sessionId) ?? Promise.resolve(),
        this.sessionLoadTails.get(sessionId) ?? Promise.resolve(),
        this.inFlight.get(sessionId) ?? Promise.resolve(),
        ...(this.pendingStorageMutations.get(sessionId) ?? []),
      ]))
      return await action()
    } finally {
      for (const sessionId of ids) this.storageCleanupLeases.delete(sessionId)
    }
  }

  installStorageTombstones(sessionIds: readonly string[]): void {
    this.evictQuarantinedSessions(sessionIds)
  }

  evictQuarantinedSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.storageTombstones.add(sessionId)
      const record = this.records.get(sessionId)
      if (record) {
        this.summaryCache.delete(record.logPath)
        this.summaryLoads.delete(record.logPath)
      }
      this.records.delete(sessionId)
      this.inFlight.delete(sessionId)
      this.runtimeRecoveries.delete(sessionId)
      this.locallyProjectedExternalSessions.delete(sessionId)
      this.recordTails.delete(sessionId)
      this.runtimeContextSnapshotTails.delete(sessionId)
      this.auxiliaryStorageWriteTails.delete(sessionId)
    }
  }

  async create(params: CreateSessionParams): Promise<SessionRecord> {
    const sessionId = params.sessionId ?? ulid()
    const mutationIds = [
      sessionId,
      ...(params.parentSessionId ? [params.parentSessionId] : []),
    ]
    const releaseMutation = this.beginStorageMutation(mutationIds)
    try {
      return await this.createRecord(params, sessionId)
    } finally {
      releaseMutation()
    }
  }

  private async createRecord(params: CreateSessionParams, sessionId: string): Promise<SessionRecord> {
    const initialState =
      params.initialState ??
      createInitialState({
        sessionId,
        systemPrompt: params.systemPrompt ?? params.config.systemPrompt,
      })
    const stateForSession: AgentState =
      initialState.sessionId === sessionId
        ? initialState
        : { ...initialState, sessionId }
    const stateWithCwd: AgentState = params.initialCwd
      ? { ...stateForSession, cwd: params.initialCwd }
      : stateForSession
    const stateWithApproval: AgentState = params.initialApprovalMode
      ? { ...stateWithCwd, approvalMode: params.initialApprovalMode }
      : stateWithCwd
    const logPath = this.pathFor(sessionId)
    if (this.options.authority) {
      await this.authorityReady
      const createdAt = new Date().toISOString()
      const candidate = recordForCreate(params, sessionId, logPath, createdAt, stateWithApproval)
      const persisted = await this.options.authority.create(persistSessionRecord(candidate))
      const record = restoreSessionRecord(persisted, logPath, params.memoryPolicy)
      this.records.set(sessionId, record)
      this.notifyStorageChanged(sessionId)
      return record
    }
    const header = await writeHeader({
      path: logPath,
      sessionId,
      agentRuntime: params.agentRuntime ?? 'kernel',
      executionMode: params.executionMode ?? 'chat',
      ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
      ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
      config: params.config,
      initialState: stateWithApproval,
      ...(params.parentSessionId
        ? { parentSessionId: params.parentSessionId }
        : {}),
      ...(params.parentCursor !== undefined
        ? { parentCursor: params.parentCursor }
        : {}),
      ...(params.parentCallId !== undefined
        ? { parentCallId: params.parentCallId }
        : {}),
      ...(params.agentType !== undefined
        ? { agentType: params.agentType }
        : {}),
      ...(params.subAgentStartedAt !== undefined
        ? { subAgentStartedAt: params.subAgentStartedAt }
        : {}),
      ...(params.workspaceId !== undefined
        ? { workspaceId: params.workspaceId }
        : {}),
      ...(params.workspaceName !== undefined
        ? { workspaceName: params.workspaceName }
        : {}),
      ...(params.organizationId !== undefined
        ? { organizationId: params.organizationId }
        : {}),
      ...(params.principal !== undefined
        ? { principal: params.principal }
        : {}),
      ...(params.organizationRole !== undefined
        ? { organizationRole: params.organizationRole }
        : {}),
      ...(params.initialCwd !== undefined
        ? { initialCwd: params.initialCwd }
        : {}),
    })
    const record: SessionRecord = {
      sessionId,
      agentRuntime: params.agentRuntime ?? 'kernel',
      executionMode: params.executionMode ?? 'chat',
      ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
      ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
      logPath,
      createdAt: header.ts,
      config: params.config,
      toolLock: toolLockFor(params.config),
      state: stateWithApproval,
      preferences: normalizedPreferences(params.preferences),
      ...(params.parentSessionId
        ? { parentSessionId: params.parentSessionId }
        : {}),
      ...(params.parentCursor !== undefined
        ? { parentCursor: params.parentCursor }
        : {}),
      ...(params.parentCallId !== undefined
        ? { parentCallId: params.parentCallId }
        : {}),
      ...(params.agentType !== undefined
        ? { agentType: params.agentType }
        : {}),
      ...(params.subAgentStartedAt !== undefined
        ? { subAgentStartedAt: params.subAgentStartedAt }
        : {}),
      ...(params.workspaceId !== undefined
        ? { workspaceId: params.workspaceId }
        : {}),
      ...(params.workspaceName !== undefined
        ? { workspaceName: params.workspaceName }
        : {}),
      ...(params.organizationId !== undefined
        ? { organizationId: params.organizationId }
        : {}),
      ...(params.principal !== undefined
        ? { principal: params.principal }
        : {}),
      ...(params.organizationRole !== undefined
        ? { organizationRole: params.organizationRole }
        : {}),
      ...(params.memoryPolicy !== undefined
        ? { memoryPolicy: params.memoryPolicy }
        : {}),
    }
    if (record.preferences.selectedModel) {
      await appendMetadataEntry(record.logPath, { selectedModel: record.preferences.selectedModel })
    }
    if (record.preferences.toolCardMode) {
      await appendMetadataEntry(record.logPath, { toolCardMode: record.preferences.toolCardMode })
    }
    if (record.preferences.transcriptViewStart !== undefined) {
      await appendMetadataEntry(record.logPath, { transcriptViewStart: record.preferences.transcriptViewStart })
    }
    if (record.preferences.rightPanelTab) {
      await appendMetadataEntry(record.logPath, { rightPanelTab: record.preferences.rightPanelTab })
    }
    if (record.preferences.chapterReadingMode) {
      await appendMetadataEntry(record.logPath, { chapterReadingMode: record.preferences.chapterReadingMode })
    }
    this.records.set(sessionId, record)
    this.summaryCache.delete(logPath)
    this.notifyStorageChanged(sessionId)
    return record
  }

  private beginStorageMutation(sessionIds: readonly string[]): () => void {
    const ids = [...new Set(sessionIds)].sort()
    for (const sessionId of ids) this.assertStorageWritable(sessionId)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    for (const sessionId of ids) {
      const mutations = this.pendingStorageMutations.get(sessionId) ?? new Set<Promise<void>>()
      mutations.add(pending)
      this.pendingStorageMutations.set(sessionId, mutations)
    }
    return () => {
      for (const sessionId of ids) {
        const mutations = this.pendingStorageMutations.get(sessionId)
        mutations?.delete(pending)
        if (mutations?.size === 0) this.pendingStorageMutations.delete(sessionId)
      }
      release()
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId)
  }

  recordsSnapshot(): readonly SessionRecord[] {
    return [...this.records.values()]
  }

  updateConfig(sessionId: string, update: (config: AgentConfig) => AgentConfig): void {
    const rec = this.records.get(sessionId)
    if (!rec) return
    ;(rec as { config: AgentConfig }).config = update(rec.config)
  }

  async updatePreferences(sessionId: string, patch: SessionPreferencesPatch): Promise<SessionPreferences> {
    const rec = this.records.get(sessionId) ?? (await this.load(sessionId))
    this.assertStorageWritable(sessionId)
    if (!hasPreferencePatch(patch)) return rec.preferences

    let next = applyPreferencePatch(rec.preferences, patch)
    await this.runAuxiliaryStorageWrite(sessionId, async () => {
      if (this.options.authority) {
        await this.authorityReady
        const persisted = await this.options.authority.mutate(sessionId, {
          mutationId: `preferences:${randomMutationId()}`,
          eventType: 'session.preferences_updated',
          // Each named preference is last-write-wins, while omitted fields are
          // merged from the transaction's latest authoritative document.
          apply(current) {
            if (!current) return undefined
            next = applyPreferencePatch(normalizedPreferences(current.preferences as SessionPreferences | undefined), patch)
            return { ...current, preferences: next }
          },
        })
        if (!persisted) throw new SessionNotFoundError(sessionId)
        next = normalizedPreferences(persisted.preferences as SessionPreferences | undefined)
        rec.preferences = next
        return
      }
      rec.preferences = next
      await appendMetadataEntry(rec.logPath, {
        ...('selectedModel' in patch ? { selectedModel: next.selectedModel ?? '' } : {}),
        ...('toolCardMode' in patch && next.toolCardMode ? { toolCardMode: next.toolCardMode } : {}),
        ...('transcriptViewStart' in patch && next.transcriptViewStart !== undefined ? { transcriptViewStart: next.transcriptViewStart } : {}),
        ...('rightPanelTab' in patch && next.rightPanelTab ? { rightPanelTab: next.rightPanelTab } : {}),
        ...('chapterReadingMode' in patch ? { chapterReadingMode: next.chapterReadingMode ?? null } : {}),
      })
    })
    this.summaryCache.delete(rec.logPath)
    this.notifyStorageChanged(sessionId)
    return next
  }

  async load(sessionId: string, options: { recoverDangling?: boolean; runtimeConfig?: AgentConfig } = {}): Promise<SessionRecord> {
    this.assertStorageWritable(sessionId)
    const previous = this.sessionLoadTails.get(sessionId) ?? Promise.resolve()
    const load = previous.catch(() => undefined).then(async () => await this.loadUnlocked(sessionId, options))
    this.sessionLoadTails.set(sessionId, load)
    try {
      return await load
    } finally {
      if (this.sessionLoadTails.get(sessionId) === load) this.sessionLoadTails.delete(sessionId)
    }
  }

  private async loadUnlocked(sessionId: string, options: { recoverDangling?: boolean; runtimeConfig?: AgentConfig }): Promise<SessionRecord> {
    const recoverDangling = options.recoverDangling !== false
    const cached = this.records.get(sessionId)
    if (cached) {
      if (recoverDangling) await this.recoverCachedExternalRuntime(cached)
      this.applyRuntimeConfig(cached, this.resolveRuntimeConfig(options.runtimeConfig, cached.executionMode))
      return cached
    }
    const inflight = recoverDangling ? this.inFlight.get(sessionId) : undefined
    if (inflight) {
      const record = await inflight
      this.applyRuntimeConfig(record, this.resolveRuntimeConfig(options.runtimeConfig, record.executionMode))
      return record
    }
    const promise = this.loadInner(sessionId, { recoverDangling, runtimeConfig: options.runtimeConfig }).finally(() => {
      this.inFlight.delete(sessionId)
    })
    if (recoverDangling) this.inFlight.set(sessionId, promise)
    return promise
  }

  private async recoverCachedExternalRuntime(record: SessionRecord): Promise<void> {
    if (this.locallyProjectedExternalSessions.has(record.sessionId)) return
    if (this.options.authority) {
      const next = interruptedExternalRuntimeState(record.agentRuntime, record.state)
      if (next) await this.recordRuntimeProjection(record.sessionId, next, 'copilot.recovered_interrupted_turn', {
        pendingCallCount: record.state.pendingCalls.length,
      })
      return
    }
    const existing = this.runtimeRecoveries.get(record.sessionId)
    if (existing) {
      await existing
      return
    }
    if (record.agentRuntime === 'kernel') return

    const recovery = (async () => {
      const latest = this.records.get(record.sessionId) ?? record
      const persistedSummary = await readPersistedSummary(latest.logPath)
      const latestQuarantine = await findLatestRuntimeMetadata(latest.logPath, 'runtime.quarantined_kernel_events', { maxScanBytes: 64 * 1024 * 1024 })
      const latestForeignEvent = latestQuarantine ? undefined : await findLatestEventEntry(latest.logPath, { maxScanBytes: 64 * 1024 * 1024 })
      const alreadyQuarantined = persistedSummary?.externalRuntimeAlreadyQuarantined === true || latestQuarantine !== undefined
      const contaminatedEventCount = alreadyQuarantined ? 0 : latestForeignEvent ? 1 : 0
      const next = contaminatedEventCount > 0
        ? quarantinedExternalRuntimeState(latest.state)
        : interruptedExternalRuntimeState(latest.agentRuntime, latest.state)
      if (!next) return
      await this.recordRuntimeProjection(
        latest.sessionId,
        next,
        contaminatedEventCount > 0
          ? 'runtime.quarantined_kernel_events'
          : 'copilot.recovered_interrupted_turn',
        contaminatedEventCount > 0
          ? { eventCount: contaminatedEventCount }
          : { pendingCallCount: latest.state.pendingCalls.length },
      )
    })()
    this.runtimeRecoveries.set(record.sessionId, recovery)
    try {
      await recovery
    } finally {
      if (this.runtimeRecoveries.get(record.sessionId) === recovery) {
        this.runtimeRecoveries.delete(record.sessionId)
      }
    }
  }

  private async loadInner(sessionId: string, options: { recoverDangling: boolean; runtimeConfig?: AgentConfig }): Promise<SessionRecord> {
    const path = this.pathFor(sessionId)
    if (this.options.authority) {
      await this.authorityReady
      const persisted = await this.options.authority.load(sessionId)
      if (!persisted) throw new SessionNotFoundError(sessionId)
      const record = restoreSessionRecord(persisted, path)
      this.applyRuntimeConfig(record, this.resolveRuntimeConfig(options.runtimeConfig, record.executionMode))
      this.records.set(sessionId, record)
      if (options.recoverDangling && record.agentRuntime !== 'kernel') {
        const recovered = interruptedExternalRuntimeState(record.agentRuntime, record.state)
        if (recovered) await this.recordRuntimeProjection(record.sessionId, recovered, 'copilot.recovered_interrupted_turn', {
          pendingCallCount: record.state.pendingCalls.length,
        })
      }
      return record
    }
    if (!existsSync(path)) {
      const found = this.findLogByPrefix(sessionId)
      if (!found) throw new SessionNotFoundError(sessionId)
      return this.loadFromFile(sessionId, found, options)
    }
    return this.loadFromFile(sessionId, path, options)
  }

  async recoverInterruptedLlm(sessionId: string): Promise<{
    record: SessionRecord
    event: AgentEvent
    effects: readonly Effect[]
  } | null> {
    const record = this.records.get(sessionId) ?? (await this.load(sessionId))
    if (record.state.status !== 'thinking' || record.state.pendingCalls.length > 0) {
      return null
    }
    const recovered = await this.appendInterruptedLlmRecovery(record)
    return recovered ? { record, ...recovered } : null
  }

  /**
   * Get an existing session (from cache or disk), or create it if unknown.
   * All work for a given sessionId is serialised so N concurrent callers
   * see exactly one create + one record installation. This is the primary
   * entrypoint for connection handlers; `create` / `load` are lower-level
   * building blocks retained for tests and explicit fork flows.
   *
   * Returns `created: true` iff `ensure` had to synthesize a new record
   * (no in-memory cache hit and no log on disk). The caller uses this to
   * fan out a `server:sessions` refresh to connected dashboards without
   * every store hit spamming a broadcast.
   */
  async ensure(params: {
    sessionId: string
    agentRuntime?: AgentRuntimeId
    executionMode?: SessionExecutionMode
    agentRuntimeVersion?: string
    externalSessionId?: string
    defaultConfig: AgentConfig
    workspaceId?: string
    workspaceName?: string
    organizationId?: string
    principal?: string
    organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
    initialCwd?: string
    preferences?: SessionPreferences
    runtimeConfig?: AgentConfig
  }): Promise<{ record: SessionRecord; created: boolean }> {
    this.assertStorageWritable(params.sessionId)
    const cached = this.records.get(params.sessionId)
    if (cached) {
      this.applyRuntimeConfig(cached, this.resolveRuntimeConfig(params.runtimeConfig ?? params.defaultConfig, cached.executionMode))
      await this.applyMissingCreateMetadata(cached, params)
      return { record: cached, created: false }
    }
    const inflight = this.inFlight.get(params.sessionId)
    if (inflight) {
      const record = await inflight
      this.applyRuntimeConfig(record, this.resolveRuntimeConfig(params.runtimeConfig ?? params.defaultConfig, record.executionMode))
      await this.applyMissingCreateMetadata(record, params)
      return { record, created: false }
    }
    let created = false
    const promise = this.ensureInner(
      params.sessionId,
      params.defaultConfig,
      params.workspaceId,
      params.workspaceName,
      params.organizationId,
      params.principal,
      params.organizationRole,
      params.initialCwd,
      params.preferences,
      params.agentRuntime,
      params.executionMode,
      params.agentRuntimeVersion,
      params.externalSessionId,
      this.resolveRuntimeConfig(params.runtimeConfig, params.executionMode ?? 'chat') ?? params.defaultConfig,
      () => { created = true },
    ).finally(() => {
      this.inFlight.delete(params.sessionId)
    })
    this.inFlight.set(params.sessionId, promise)
    const record = await promise
    return { record, created }
  }

  private async ensureInner(
    sessionId: string,
    defaultConfig: AgentConfig,
    workspaceId: string | undefined,
    workspaceName: string | undefined,
    organizationId: string | undefined,
    principal: string | undefined,
    organizationRole: 'owner' | 'admin' | 'member' | 'viewer' | undefined,
    initialCwd: string | undefined,
    preferences: SessionPreferences | undefined,
    agentRuntime: AgentRuntimeId | undefined,
    executionMode: SessionExecutionMode | undefined,
    agentRuntimeVersion: string | undefined,
    externalSessionId: string | undefined,
    runtimeConfig: AgentConfig,
    markCreated: () => void,
  ): Promise<SessionRecord> {
    try {
      const record = await this.loadInner(sessionId, { recoverDangling: true, runtimeConfig })
      await this.applyMissingCreateMetadata(record, {
        sessionId,
        defaultConfig,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(organizationId !== undefined ? { organizationId } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(organizationRole !== undefined ? { organizationRole } : {}),
        ...(initialCwd !== undefined ? { initialCwd } : {}),
        ...(preferences !== undefined ? { preferences } : {}),
      })
      return record
    } catch {
      // No existing log — create a fresh one. `create` itself performs a
      // single writeHeader() which is the atomic commit point; if it
      // throws the sessionId stays uninstalled and the next caller can
      // retry.
      markCreated()
      return await this.create({
        sessionId,
        config: defaultConfig,
        ...(agentRuntime ? { agentRuntime } : {}),
        executionMode: executionMode ?? 'chat',
        ...(agentRuntimeVersion ? { agentRuntimeVersion } : {}),
        ...(externalSessionId ? { externalSessionId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(organizationId !== undefined ? { organizationId } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(organizationRole !== undefined ? { organizationRole } : {}),
        ...(initialCwd !== undefined ? { initialCwd } : {}),
        ...(preferences !== undefined ? { preferences } : {}),
      })
    }
  }

  private applyRuntimeConfig(record: SessionRecord, runtimeConfig: AgentConfig | undefined): void {
    if (!runtimeConfig) return
    ;(record as { config: AgentConfig }).config = configWithPersistedSystemPrompt(runtimeConfig, record.state)
  }

  private resolveRuntimeConfig(
    override: AgentConfig | undefined,
    executionMode: SessionExecutionMode,
  ): AgentConfig | undefined {
    if (override) return override
    const configured = this.options.runtimeConfig
    if (!configured) return undefined
    return typeof configured === 'function' ? configured({ executionMode }) : configured
  }

  private async applyMissingCreateMetadata(
    record: SessionRecord,
    params: {
      sessionId: string
      defaultConfig: AgentConfig
      workspaceId?: string
      workspaceName?: string
      organizationId?: string
      principal?: string
      organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
      initialCwd?: string
    },
  ): Promise<void> {
    if (record.sessionId !== params.sessionId) return
    this.assertStorageWritable(record.sessionId)
    let metadataChanged = false
    if (record.workspaceId === undefined && params.workspaceId !== undefined) {
      ;(record as { workspaceId?: string }).workspaceId = params.workspaceId
      metadataChanged = true
    }
    if (record.workspaceName === undefined && params.workspaceName !== undefined) {
      ;(record as { workspaceName?: string }).workspaceName = params.workspaceName
      metadataChanged = true
    }
    if (record.organizationId === undefined && params.organizationId !== undefined) {
      ;(record as { organizationId?: string }).organizationId = params.organizationId
      metadataChanged = true
    }
    if (record.principal === undefined && params.principal !== undefined) {
      ;(record as { principal?: string }).principal = params.principal
      metadataChanged = true
    }
    if (record.organizationRole === undefined && params.organizationRole !== undefined) {
      ;(record as { organizationRole?: 'owner' | 'admin' | 'member' | 'viewer' }).organizationRole = params.organizationRole
      metadataChanged = true
    }
    if (metadataChanged) {
      await this.runAuxiliaryStorageWrite(record.sessionId, async () => {
        if (this.options.authority) {
          await this.authorityReady
          const persisted = await this.options.authority.mutate(record.sessionId, {
            mutationId: `create-metadata:${randomMutationId()}`,
            eventType: 'session.metadata_backfilled',
            // Backfill is fill-if-absent per field. Values already committed by
            // another Store win; unrelated metadata is never copied from cache.
            apply: (current) => current ? {
              ...current,
              ...(current.workspaceId === undefined && record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
              ...(current.workspaceName === undefined && record.workspaceName !== undefined ? { workspaceName: record.workspaceName } : {}),
              ...(current.organizationId === undefined && record.organizationId !== undefined ? { organizationId: record.organizationId } : {}),
              ...(current.principal === undefined && record.principal !== undefined ? { principal: record.principal } : {}),
              ...(current.organizationRole === undefined && record.organizationRole !== undefined ? { organizationRole: record.organizationRole } : {}),
            } : undefined,
          })
          if (!persisted) throw new SessionNotFoundError(record.sessionId)
          syncBackfilledMetadata(record, persisted)
          return
        }
        await appendMetadataEntry(record.logPath, {
          ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
          ...(record.workspaceName !== undefined ? { workspaceName: record.workspaceName } : {}),
          ...(record.organizationId !== undefined ? { organizationId: record.organizationId } : {}),
          ...(record.principal !== undefined ? { principal: record.principal } : {}),
          ...(record.organizationRole !== undefined ? { organizationRole: record.organizationRole } : {}),
        })
      })
      this.summaryCache.delete(record.logPath)
    }
    if (record.state.cwd === undefined && params.initialCwd !== undefined) {
      const event: AgentEvent = { kind: 'cwd_changed', cwd: params.initialCwd }
      const { next, effects } = step(record.state, event, record.config)
      if (this.options.authority) {
        await this.record(record.sessionId, event, effects, next)
      } else {
        const entry = await appendEventEntry({
          path: record.logPath,
          seq: next.cursor,
          event,
          effects,
        })
        record.state = next
        record.lastEventAt = entry.ts
      }
      this.summaryCache.delete(record.logPath)
    }
  }

  async record(
    sessionId: string,
    event: AgentEvent,
    effects: readonly Effect[],
    nextState: AgentState,
    usageDelta?: UsageTotal,
    llmTrace?: LLMTrace,
    model?: string,
    timing?: import('@agent-kernel/shared').EventTimingMetadata,
  ): Promise<void> {
    this.assertStorageWritable(sessionId)
    const previous = this.recordTails.get(sessionId) ?? Promise.resolve()
    const commit = previous.catch(() => undefined).then(async () => {
      const rec = this.records.get(sessionId)
      if (!rec) throw new Error(`Cannot record on unknown session: ${sessionId}`)
      const expectedCursor = rec.state.cursor + 1
      if (nextState.cursor !== expectedCursor) {
        throw new Error(
          `stale Session transition for ${sessionId}: expected cursor ${expectedCursor}, received ${nextState.cursor}`,
        )
      }

      let committedAt: string
      if (this.options.authority) {
        await this.authorityReady
        const now = new Date().toISOString()
        const persisted = await this.options.authority.mutate(sessionId, {
          mutationId: `kernel.event:${nextState.cursor}`,
          eventType: `session.event.${event.kind}`,
          entry: {
            kind: 'event',
            seq: nextState.cursor,
            ts: now,
            event,
            effects,
            ...(usageDelta ? { usage: usageDelta } : {}),
            ...(llmTrace ? { llmTrace } : {}),
            ...(model ? { model } : {}),
            ...(timing ? { timing } : {}),
          },
          apply(current) {
            if (!current) throw new SessionNotFoundError(sessionId)
            if (current.state.cursor + 1 !== nextState.cursor) {
              throw new Error(`stale Session transition for ${sessionId}: persisted cursor ${current.state.cursor}, received ${nextState.cursor}`)
            }
            return {
              ...current,
              state: nextState,
              lastEventAt: now,
              ...(event.kind === 'user_message' ? { turnStartedAt: validTimestamp(timing?.turnStartedAt) ?? now } : {}),
              ...(event.kind === 'user_message' && event.text?.trim() && current.firstUserMessage === undefined
                ? { firstUserMessage: event.text }
                : {}),
            }
          },
        })
        if (!persisted) throw new SessionNotFoundError(sessionId)
        committedAt = String(persisted.lastEventAt)
      } else {
        const entry = await appendEventEntry({
          path: rec.logPath,
          seq: nextState.cursor,
          event,
          effects,
          ...(usageDelta ? { usage: usageDelta } : {}),
          ...(llmTrace ? { llmTrace } : {}),
          ...(model ? { model } : {}),
          ...(timing ? { timing } : {}),
        })
        committedAt = entry.ts
      }
      // Publish in-memory state only after the authoritative commit succeeds.
      rec.state = nextState
      rec.lastEventAt = committedAt
      if (event.kind === 'user_message') {
        rec.turnStartedAt = validTimestamp(timing?.turnStartedAt) ?? committedAt
      }
      if (event.kind === 'user_message' && event.text?.trim() && !rec.firstUserMessage) {
        rec.firstUserMessage = event.text
      }
      this.summaryCache.delete(rec.logPath)
      this.notifyStorageChanged(sessionId)
    })
    this.recordTails.set(sessionId, commit)
    try {
      await commit
    } finally {
      if (this.recordTails.get(sessionId) === commit) this.recordTails.delete(sessionId)
    }
  }

  async recordRuntimeProjection(
    sessionId: string,
    nextState: AgentState,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.assertStorageWritable(sessionId)
    const previous = this.recordTails.get(sessionId) ?? Promise.resolve()
    const commit = previous.catch(() => undefined).then(async () => {
      const rec = this.records.get(sessionId)
      if (!rec) throw new Error(`Cannot record projection on unknown session: ${sessionId}`)
      if (rec.agentRuntime === 'kernel') {
        throw new Error(`Kernel session ${sessionId} cannot record an external runtime projection`)
      }
      const expectedCursor = rec.state.cursor + 1
      if (nextState.cursor !== expectedCursor) {
        throw new Error(
          `stale runtime projection for ${sessionId}: expected cursor ${expectedCursor}, received ${nextState.cursor}`,
        )
      }
      let committedAt: string
      if (this.options.authority) {
        await this.authorityReady
        committedAt = new Date().toISOString()
        const persisted = await this.options.authority.mutate(sessionId, {
          mutationId: `runtime.projection:${nextState.cursor}`,
          eventType: action,
          entry: {
            kind: 'runtime_metadata',
            ts: committedAt,
            sessionId,
            action,
            payload: { ...payload, projectionCursor: nextState.cursor },
          },
          apply(current) {
            if (!current) throw new SessionNotFoundError(sessionId)
            if (current.state.cursor + 1 !== nextState.cursor) {
              throw new Error(`stale runtime projection for ${sessionId}: persisted cursor ${current.state.cursor}, received ${nextState.cursor}`)
            }
            return {
              ...current,
              state: nextState,
              lastEventAt: committedAt,
              ...(action === 'copilot.user_message' ? { turnStartedAt: committedAt } : {}),
              ...(current.firstUserMessage === undefined ? { firstUserMessage: firstUserMessageFromState(nextState) } : {}),
            }
          },
        })
        if (!persisted) throw new SessionNotFoundError(sessionId)
      } else {
        const metadataEntry = await appendRuntimeMetadataEntry(rec.logPath, {
          sessionId,
          action,
          payload: { ...payload, projectionCursor: nextState.cursor },
        })
        const entry = await appendSnapshotEntry(rec.logPath, nextState.cursor, compactExternalRuntimeSnapshotState(nextState))
        committedAt = entry.ts
        if (action === 'copilot.user_message') rec.turnStartedAt = metadataEntry.ts
      }
      rec.state = nextState
      rec.lastEventAt = committedAt
      this.locallyProjectedExternalSessions.add(sessionId)
      if (!rec.firstUserMessage) rec.firstUserMessage = firstUserMessageFromState(nextState)
      this.summaryCache.delete(rec.logPath)
      this.notifyStorageChanged(sessionId)
      // The projection metadata is written before the durable snapshot. A separate
      // receipt after it prevents deployment from mistaking an uncommitted tool
      // result for a successfully projected Copilot Tool call.
      if (!this.options.authority && action === 'copilot.tool_result' && typeof payload.callId === 'string') {
        await appendRuntimeMetadataEntry(rec.logPath, {
          sessionId, action: 'copilot.tool_result_committed',
          payload: { callId: payload.callId, projectionCursor: nextState.cursor },
        })
      }
    })
    this.recordTails.set(sessionId, commit)
    try {
      await commit
    } finally {
      if (this.recordTails.get(sessionId) === commit) this.recordTails.delete(sessionId)
    }
  }

  /**
   * Durably replace one Session's effective system prompt.
   *
   * Kernel Sessions append a replayable reducer event. External Runtime
   * Sessions commit the same projected state to their snapshot sidecar and
   * only append Runtime metadata, so their JSONL never receives Kernel events.
   * All paths share recordTails and publish config/state only after the durable
   * state write succeeds.
   */
  async applySystemPrompt(
    sessionId: string,
    prompt: string,
    version?: string | number,
  ): Promise<boolean> {
    this.assertStorageWritable(sessionId)
    if (!this.records.has(sessionId)) await this.load(sessionId)
    // load() can yield; re-check admission before installing the commit tail.
    this.assertStorageWritable(sessionId)
    const previous = this.recordTails.get(sessionId) ?? Promise.resolve()
    let changed = false
    const commit = previous.catch(() => undefined).then(async () => {
      const rec = this.records.get(sessionId)
      if (!rec) throw new Error(`Cannot update system prompt on unknown session: ${sessionId}`)

      const persisted = rec.state.systemPromptOverride
      const sameVersion = version === undefined || persisted?.version === version
      const samePrompt = persisted
        ? persisted.prompt === prompt
        : rec.config.systemPrompt === prompt && leadingSystemPrompt(rec.state) === prompt
      if (samePrompt && sameVersion) return

      const event: AgentEvent = {
        kind: 'system_prompt_changed',
        prompt,
        ...(version !== undefined ? { version } : {}),
      }
      const transition = step(rec.state, event, rec.config)
      if (transition.transition.outcome !== 'applied') {
        throw new Error(`System prompt update was not applied for ${sessionId}`)
      }

      let committedAt: string
      if (this.options.authority) {
        await this.authorityReady
        committedAt = new Date().toISOString()
        const persisted = await this.options.authority.mutate(sessionId, {
          mutationId: `system-prompt:${transition.next.cursor}`,
          eventType: 'session.system_prompt_changed',
          apply(current) {
            if (!current) throw new SessionNotFoundError(sessionId)
            if (current.state.cursor + 1 !== transition.next.cursor) {
              throw new Error(`stale system prompt update for ${sessionId}`)
            }
            return {
              ...current,
              state: transition.next,
              config: { ...(current.config as AgentConfig), systemPrompt: prompt },
              lastEventAt: committedAt,
            }
          },
        })
        if (!persisted) throw new SessionNotFoundError(sessionId)
      } else if (rec.agentRuntime === 'kernel') {
        const entry = await appendEventEntry({
          path: rec.logPath,
          seq: transition.next.cursor,
          event,
          effects: transition.effects,
        })
        committedAt = entry.ts
      } else {
        const compacted = compactExternalRuntimeSnapshotState(transition.next)
        await appendRuntimeMetadataEntry(rec.logPath, {
          sessionId,
          action: 'runtime.system_prompt_changed',
          payload: {
            projectionCursor: transition.next.cursor,
            ...(version !== undefined ? { version } : {}),
          },
        })
        const snapshot = await appendSnapshotEntry(rec.logPath, transition.next.cursor, compacted)
        committedAt = snapshot.ts
        this.locallyProjectedExternalSessions.add(sessionId)
      }

      // The event/snapshot is now durable. Only now expose either projection.
      rec.state = transition.next
      ;(rec as { config: AgentConfig }).config = {
        ...rec.config,
        systemPrompt: prompt,
      }
      rec.lastEventAt = committedAt
      this.summaryCache.delete(rec.logPath)
      this.notifyStorageChanged(sessionId)
      changed = true
    })
    this.recordTails.set(sessionId, commit)
    try {
      await commit
      return changed
    } finally {
      if (this.recordTails.get(sessionId) === commit) this.recordTails.delete(sessionId)
    }
  }

  list(): SessionRecord[] {
    return [...this.records.values()]
  }

  async listChildren(parentSessionId: string): Promise<SessionRecord[]> {
    if (this.options.authority) {
      await this.authorityReady
      const children = (await this.options.authority.list()).filter((document) => document.parentSessionId === parentSessionId)
      return await Promise.all(children.map(async (document) =>
        this.records.get(document.sessionId) ?? await this.load(document.sessionId, { recoverDangling: false })))
    }
    const loaded = new Map<string, SessionRecord>()
    for (const record of this.records.values()) {
      if (record.parentSessionId === parentSessionId) loaded.set(record.sessionId, record)
    }
    if (!existsSync(this.sessionsDir)) return [...loaded.values()]
    const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl'))
    for (const file of files) {
      const path = join(this.sessionsDir, file)
      if (loadedRecordForPath(this.records, path)) continue
      try {
        const header = await readSessionHeader(path)
        if (header.parentSessionId !== parentSessionId) continue
        const record = await this.loadFromFile(header.sessionId, path)
        loaded.set(record.sessionId, record)
      } catch {
        // Skip malformed or partially-written logs; session listing should be
        // best-effort and never block the dashboard from rendering.
      }
    }
    return [...loaded.values()]
  }

  /**
   * Attach or clear a memory policy on a live session record. Called by eval
   * runners after `ensure`/`create` when the session is a benchmark trial and
   * cross-task memory must be disabled. Pass `undefined` to clear.
   */
  setMemoryPolicy(sessionId: string, policy: SessionMemoryPolicy | undefined): void {
    const rec = this.records.get(sessionId)
    if (!rec) return
    if (policy === undefined) delete rec.memoryPolicy
    else rec.memoryPolicy = policy
  }

  /**
   * Persist a rename. Empty/whitespace label clears the override so summaries
   * fall back to firstUserMessage. Returns the applied value so the caller can
   * broadcast it without re-reading the record.
   */
  async rename(sessionId: string, label: string): Promise<string> {
    this.assertStorageWritable(sessionId)
    const rec = this.records.get(sessionId) ?? (await this.load(sessionId))
    const trimmed = label.trim()
    await this.runAuxiliaryStorageWrite(sessionId, async () => {
      if (this.options.authority) {
        await this.authorityReady
        const persisted = await this.options.authority.mutate(sessionId, {
          mutationId: `rename:${randomMutationId()}`,
          eventType: 'session.renamed',
          apply(current) {
            if (!current) return undefined
            if (trimmed.length === 0) {
              const { label: _label, ...withoutLabel } = current
              return withoutLabel as PersistedSessionDocument
            }
            return { ...current, label: trimmed }
          },
        })
        if (!persisted) throw new SessionNotFoundError(sessionId)
      } else {
        await appendMetadataEntry(rec.logPath, { label: trimmed })
      }
      if (trimmed.length === 0) delete rec.label
      else rec.label = trimmed
    })
    this.summaryCache.delete(rec.logPath)
    this.notifyStorageChanged(sessionId)
    return trimmed
  }

  async renameWorkspace(workspaceId: string, workspaceName: string): Promise<number> {
    const trimmed = workspaceName.trim()
    if (workspaceId.trim().length === 0) throw new Error('workspaceId is required')
    if (trimmed.length === 0) throw new Error('workspace name is required')
    const summaries = await this.listSummaries()
    let count = 0
    for (const summary of summaries) {
      if (summary.workspaceId !== workspaceId) continue
      const rec = this.records.get(summary.sessionId) ?? (await this.load(summary.sessionId))
      await this.runAuxiliaryStorageWrite(rec.sessionId, async () => {
        if (this.options.authority) {
          await this.authorityReady
          const persisted = await this.options.authority.mutate(rec.sessionId, {
            mutationId: `workspace-name:${randomMutationId()}`,
            eventType: 'session.workspace_renamed',
            apply: (current) => current ? { ...current, workspaceName: trimmed } : undefined,
          })
          if (!persisted) throw new SessionNotFoundError(rec.sessionId)
        } else {
          await appendMetadataEntry(rec.logPath, { workspaceName: trimmed })
        }
        ;(rec as { workspaceName?: string }).workspaceName = trimmed
      })
      this.summaryCache.delete(rec.logPath)
      this.notifyStorageChanged(rec.sessionId)
      count += 1
    }
    return count
  }

  async delete(sessionId: string): Promise<void> {
    await this.withStorageMutationLease([sessionId], async () => await this.deleteUnlocked(sessionId))
  }

  private async deleteUnlocked(sessionId: string): Promise<void> {
    if (this.options.authority) {
      await this.authorityReady
      const exists = await this.options.authority.requestDeletion(sessionId)
      if (!exists) return
      // The durable authority tombstone is visible to every Runtime before any
      // object bytes are removed. Evict this process immediately as well.
      this.evictSessionCaches(sessionId)
      this.notifyStorageChanged(sessionId)
      await this.finishPostgresDeletion(sessionId)
      return
    }
    const paths = this.findLogsBySessionId(sessionId)
    const artifactSlugs = new Set(paths.map((path) => basename(path, '.jsonl')))
    const logArtifactRoot = join(this.sessionsDir, 'artifacts')
    if (existsSync(logArtifactRoot)) {
      for (const entry of readdirSync(logArtifactRoot)) {
        if (entry.endsWith(`_${sessionId}`)) artifactSlugs.add(entry)
      }
    }
    for (const path of paths) {
      this.summaryCache.delete(path)
      this.summaryLoads.delete(path)
      await rm(snapshotSidecarPath(path), { force: true })
      await rm(summaryCachePath(path), { force: true })
      await rm(runtimeContextCachePath(path), { force: true })
    }

    for (const slug of artifactSlugs) {
      await rm(safeDirectChild(logArtifactRoot, slug), { recursive: true, force: true })
    }
    if (this.options.artifactRootDir) {
      for (const kind of SESSION_ARTIFACT_KINDS) {
        await rm(safeDirectChild(join(this.options.artifactRootDir, kind), sessionId), { recursive: true, force: true })
      }
    }
    await this.options.deleteRegisteredArtifacts?.(sessionId)
    // Keep the discoverable JSONL source of truth until every auxiliary and
    // registered artifact has been removed. A failure before this point can
    // then be retried after a process restart instead of leaving an orphan
    // that no subsequent retention scan can attribute to a Session.
    for (const path of paths) await rm(path, { force: true })
    this.records.delete(sessionId)
    this.inFlight.delete(sessionId)
    this.runtimeRecoveries.delete(sessionId)
    this.locallyProjectedExternalSessions.delete(sessionId)
    this.recordTails.delete(sessionId)
    this.notifyStorageChanged(sessionId)
  }

  private async finishPostgresDeletion(sessionId: string): Promise<void> {
    await this.options.deleteRegisteredArtifacts?.(sessionId)
    await this.options.authority!.delete(sessionId)
    this.evictSessionCaches(sessionId)
    this.notifyStorageChanged(sessionId)
  }

  private evictSessionCaches(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (record) {
      this.summaryCache.delete(record.logPath)
      this.summaryLoads.delete(record.logPath)
    }
    this.records.delete(sessionId)
    this.inFlight.delete(sessionId)
    this.runtimeRecoveries.delete(sessionId)
    this.locallyProjectedExternalSessions.delete(sessionId)
    this.recordTails.delete(sessionId)
    this.runtimeContextSnapshotTails.delete(sessionId)
    this.auxiliaryStorageWriteTails.delete(sessionId)
  }

  private notifyStorageChanged(sessionId: string): void {
    try {
      this.options.onStorageChanged?.(sessionId)
    } catch (error) {
      process.emitWarning(
        `Session storage inventory invalidation failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'KALA_STORAGE_INVENTORY_INVALIDATION' },
      )
    }
  }

  private async runAuxiliaryStorageWrite<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    this.assertStorageWritable(sessionId)
    const previous = this.auxiliaryStorageWriteTails.get(sessionId) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      this.assertStorageWritable(sessionId)
      return await action()
    })
    this.auxiliaryStorageWriteTails.set(sessionId, write)
    try {
      return await write
    } finally {
      if (this.auxiliaryStorageWriteTails.get(sessionId) === write) {
        this.auxiliaryStorageWriteTails.delete(sessionId)
      }
    }
  }

  async purgeOrganizationSessions(params: {
    organizationId: string
    /**
     * Optional cutoff for retention jobs. The session is purged only when its
     * latest activity (`lastEventAt` or `createdAt`) is before this instant.
     * Omit for irreversible tenant-root deletion after the grace period.
     */
    before?: Date
  }): Promise<{ sessions: number; sessionIds: string[] }> {
    const organizationId = params.organizationId.trim()
    if (organizationId.length === 0) throw new Error('organizationId is required')
    const cutoffMs = params.before?.getTime()
    if (cutoffMs !== undefined && !Number.isFinite(cutoffMs)) throw new Error('invalid retention cutoff')
    const candidates = new Map<string, SessionRecord>()
    if (this.options.authority) {
      await this.authorityReady
      for (const document of await this.options.authority.list()) {
        const record = this.records.get(document.sessionId) ?? restoreSessionRecord(document, this.pathFor(document.sessionId))
        if (record.organizationId === organizationId && sessionEligibleForRetention(record, cutoffMs)) candidates.set(record.sessionId, record)
      }
    } else for (const record of this.records.values()) {
      if (record.organizationId === organizationId && sessionEligibleForRetention(record, cutoffMs)) candidates.set(record.sessionId, record)
    }
    if (!this.options.authority && existsSync(this.sessionsDir)) {
      for (const file of readdirSync(this.sessionsDir)) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(this.sessionsDir, file)
        if (loadedRecordForPath(this.records, path)) continue
        try {
          const header = await readSessionHeader(path)
          const record = await this.loadFromFile(header.sessionId, path, { recoverDangling: false })
          if (record.organizationId === organizationId && sessionEligibleForRetention(record, cutoffMs)) candidates.set(record.sessionId, record)
        } catch {
          // Malformed logs are quarantined from tenant purge rather than being
          // guessed into another tenant's deletion set.
        }
      }
    }
    const sessionIds: string[] = []
    for (const [sessionId, candidate] of [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const deleted = await this.withStorageMutationLease([sessionId], async () => {
        // The lease blocks new writes and waits for every already-enqueued
        // mutation. Rechecking inside it closes the scan/delete TOCTOU window.
        const current = this.records.get(sessionId) ?? candidate
        if (current.organizationId !== organizationId || !sessionEligibleForRetention(current, cutoffMs)) return false
        await this.deleteUnlocked(sessionId)
        return true
      })
      if (deleted) sessionIds.push(sessionId)
    }
    return { sessions: sessionIds.length, sessionIds }
  }

  async updateRuntimeContextSnapshot(
    record: SessionRecord,
    contextSnapshot: ContextUsageSnapshot,
  ): Promise<void> {
    this.assertStorageWritable(record.sessionId)
    const previous = this.runtimeContextSnapshotTails.get(record.sessionId) ?? Promise.resolve()
    const update = previous.catch(() => undefined).then(async () => {
      const latest = record.runtimeContextSnapshot
      // Provider totals may legitimately fall after compaction, so timestamp —
      // not token count — is the ordering authority.
      if (latest && contextSnapshot.updatedAt < latest.updatedAt) return
      if (this.options.authority) {
        await this.authorityReady
        const persisted = await this.options.authority.mutate(record.sessionId, {
          mutationId: `runtime-context:${contextSnapshot.updatedAt}`,
          eventType: 'session.runtime_context_updated',
          apply: (current) => current ? { ...current, runtimeContextSnapshot: contextSnapshot } : undefined,
        })
        if (!persisted) throw new SessionNotFoundError(record.sessionId)
      } else {
        await writeJsonFile(runtimeContextCachePath(record.logPath), {
          schemaVersion: 1,
          sessionId: record.sessionId,
          contextSnapshot,
        })
      }
      this.notifyStorageChanged(record.sessionId)
      record.runtimeContextSnapshot = contextSnapshot
    })
    this.runtimeContextSnapshotTails.set(record.sessionId, update)
    try {
      await update
    } finally {
      if (this.runtimeContextSnapshotTails.get(record.sessionId) === update) {
        this.runtimeContextSnapshotTails.delete(record.sessionId)
      }
    }
  }

  async listSummaries(): Promise<SessionSummary[]> {
    if (this.options.authority) {
      await this.authorityReady
      const records = (await this.options.authority.list()).map((document) => restoreSessionRecord(document, this.pathFor(document.sessionId)))
      return records.map(summarizeRecord).sort((a, b) =>
        (b.lastEventAt ?? b.createdAt).localeCompare(a.lastEventAt ?? a.createdAt))
    }
    if (!existsSync(this.sessionsDir)) return []
    const files = readdirSync(this.sessionsDir).filter((f) =>
      f.endsWith('.jsonl'),
    )
    const out: SessionSummary[] = []
    for (const file of files) {
      const path = join(this.sessionsDir, file)
      try {
        const loaded = loadedRecordForPath(this.records, path)
        const summary = loaded
          ? summarizeRecord(loaded)
          : await this.cachedSummaryFor(path)
        out.push(summary)
      } catch {
        // Skip malformed files — a first-line-missing-header log means the
        // process crashed before it wrote anything usable. Don't fail the
        // whole listing because of one bad file.
      }
    }
    out.sort((a, b) =>
      (b.lastEventAt ?? b.createdAt).localeCompare(a.lastEventAt ?? a.createdAt),
    )
    return out
  }

  /** Enumerate one tenant without loading or mutating records from any other tenant. */
  async listSessionIdsForOrganization(organizationId: string | undefined): Promise<string[]> {
    if (this.options.authority) {
      await this.authorityReady
      return (await this.options.authority.list())
        .filter((document) => document.organizationId === organizationId)
        .map((document) => document.sessionId)
    }
    if (!existsSync(this.sessionsDir)) return []
    const ids: string[] = []
    const failures: Error[] = []
    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(this.sessionsDir, file)
      try {
        const loaded = loadedRecordForPath(this.records, path)
        if (loaded) {
          if (loaded.organizationId === organizationId) ids.push(loaded.sessionId)
          continue
        }
        const header = await readSessionHeader(path)
        const metadata = header.organizationId === undefined
          ? await readRecentSessionMetadata(path)
          : []
        let attributedOrganizationId = header.organizationId
        for (let index = metadata.length - 1; attributedOrganizationId === undefined && index >= 0; index -= 1) {
          attributedOrganizationId = metadata[index]?.organizationId
        }
        if (attributedOrganizationId === organizationId) ids.push(header.sessionId)
      } catch (error) {
        // An unreadable log might belong to this organization. Never report
        // synchronization as complete until every persisted Session is checked.
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (failures.length) throw new AggregateError(failures, `Could not determine ownership for ${failures.length} Session log(s)`)
    return ids
  }

  /** Enumerate every valid persisted Session without loading it into memory. */
  async listSessionIds(): Promise<string[]> {
    if (this.options.authority) {
      await this.authorityReady
      return (await this.options.authority.list()).map((document) => document.sessionId)
    }
    if (!existsSync(this.sessionsDir)) return []
    const ids: string[] = []
    const failures: Error[] = []
    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(this.sessionsDir, file)
      try {
        const loaded = loadedRecordForPath(this.records, path)
        ids.push(loaded?.sessionId ?? (await readSessionHeader(path)).sessionId)
      } catch (error) {
        // Keep discovery pending; silently skipping a log would permanently
        // leave its Session under the old prompt after the storage recovers.
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (failures.length) throw new AggregateError(failures, `Could not discover ${failures.length} Session log(s)`)
    return ids
  }

  private async cachedSummaryFor(path: string): Promise<SessionSummary> {
    const stat = statSync(path)
    const cached = this.summaryCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.summary
    }
    const persisted = await readPersistedSummary(path)
    if (persisted && persisted.mtimeMs === stat.mtimeMs && persisted.size === stat.size) {
      this.summaryCache.set(path, persisted)
      return persisted.summary
    }
    const header = await readSessionHeader(path)
    if ((header.agentRuntime ?? 'kernel') !== 'kernel') {
      const snapshots = [...await optionalSnapshot(path)]
      const metadata = await readRecentSessionMetadata(path)
      const current = summarizeLog({
        header,
        events: [],
        snapshots,
        metadata,
        runtimeMetadata: [],
        warnings: [],
      })
      const summary: SessionSummary = {
        ...persisted?.summary,
        ...current,
        ...(persisted?.summary.agentRuntimeVersion
          ? { agentRuntimeVersion: persisted.summary.agentRuntimeVersion }
          : {}),
        eventCount: current.eventCount,
        ...(current.lastEventAt ? { lastEventAt: current.lastEventAt } : {}),
        ...(current.status ? { status: current.status } : {}),
        ...(current.currentCwd ? { currentCwd: current.currentCwd } : {}),
        ...(current.firstUserMessage ? { firstUserMessage: current.firstUserMessage } : {}),
      }
      const labelPatch = latestStringMetadataPatch(metadata, 'label')
      if (labelPatch.found) {
        if (labelPatch.value) summary.label = labelPatch.value
        else delete summary.label
      }
      const latest = statSync(path)
      if (latest.mtimeMs === stat.mtimeMs && latest.size === stat.size) {
        const cachedSummary = { mtimeMs: stat.mtimeMs, size: stat.size, summary }
        this.summaryCache.set(path, cachedSummary)
        await this.runAuxiliaryStorageWrite(header.sessionId, async () => {
          await writeJsonFile(summaryCachePath(path), {
            schemaVersion: 2,
            ...cachedSummary,
            hasEvents: false,
            externalRuntimeAlreadyQuarantined: persisted?.externalRuntimeAlreadyQuarantined ?? false,
          })
        })
        this.notifyStorageChanged(header.sessionId)
      }
      return summary
    }
    const active = this.summaryLoads.get(path)
    if (active && active.mtimeMs === stat.mtimeMs && active.size === stat.size) {
      return active.promise
    }
    const load = readSessionState(path).then(async (parsed) => {
      const summary = summarizeLog(parsed)
      const latest = statSync(path)
      if (latest.mtimeMs === stat.mtimeMs && latest.size === stat.size) {
        const cachedSummary = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          summary,
        }
        this.summaryCache.set(path, cachedSummary)
        await this.runAuxiliaryStorageWrite(parsed.header.sessionId, async () => {
          await writeJsonFile(summaryCachePath(path), {
            schemaVersion: 2,
            ...cachedSummary,
            hasEvents: parsed.events.length > 0,
            externalRuntimeAlreadyQuarantined: parsed.runtimeMetadata.some((entry) =>
              entry.action === 'runtime.quarantined_kernel_events'
            ),
          })
        })
        this.notifyStorageChanged(parsed.header.sessionId)
      }
      return summary
    })
    this.summaryLoads.set(path, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      promise: load,
    })
    try {
      return await load
    } finally {
      if (this.summaryLoads.get(path)?.promise === load) this.summaryLoads.delete(path)
    }
  }

  private pathFor(sessionId: string): string {
    const ts = new Date().toISOString().replace(/:/g, '-')
    return join(this.sessionsDir, `${ts}_${sessionId}.jsonl`)
  }

  private findLogByPrefix(sessionId: string): string | undefined {
    return this.findLogsBySessionId(sessionId)[0]
  }

  private findLogsBySessionId(sessionId: string): string[] {
    if (!existsSync(this.sessionsDir)) return []
    return readdirSync(this.sessionsDir)
      .filter((file) => file.endsWith(`_${sessionId}.jsonl`))
      .map((file) => join(this.sessionsDir, file))
  }

  private async loadFromFile(
    sessionId: string,
    path: string,
    options: { recoverDangling: boolean; runtimeConfig?: AgentConfig } = { recoverDangling: true },
  ): Promise<SessionRecord> {
    const header = await readSessionHeader(path)
    const persistedSummary = await readPersistedSummary(path)
    const runtimeContextSnapshot = await readPersistedRuntimeContext(path, sessionId)
    const fastExternalLoad = (header.agentRuntime ?? 'kernel') !== 'kernel'
    const externalRuntimeAlreadyQuarantined = fastExternalLoad
      ? persistedSummary?.externalRuntimeAlreadyQuarantined === true
        || await findLatestRuntimeMetadata(path, 'runtime.quarantined_kernel_events', { maxScanBytes: 64 * 1024 * 1024 }) !== undefined
      : false
    const latestExternalKernelEvent = fastExternalLoad && !externalRuntimeAlreadyQuarantined
      ? await findLatestEventEntry(path, { maxScanBytes: 64 * 1024 * 1024 })
      : undefined
    const recentExternalMetadata = fastExternalLoad
      ? await readRecentSessionMetadata(path)
      : []
    const externalSnapshots = fastExternalLoad ? await optionalSnapshot(path) : []
    const committedExternalProjection = externalSnapshots.at(-1)
    const latestCopilotUserMessage = fastExternalLoad && committedExternalProjection
      ? await findLatestRuntimeMetadata(path, 'copilot.user_message', {
          committedProjection: {
            cursor: committedExternalProjection.seq,
            ts: committedExternalProjection.ts,
          },
        })
      : undefined
    const parsed = fastExternalLoad
      ? {
          header,
          events: latestExternalKernelEvent ? [latestExternalKernelEvent] : [],
          snapshots: [...externalSnapshots],
          metadata: recentExternalMetadata,
          runtimeMetadata: externalRuntimeAlreadyQuarantined
            ? [{
                kind: 'runtime_metadata' as const,
                ts: header.ts,
                sessionId,
                action: 'runtime.quarantined_kernel_events',
                payload: {},
              }]
            : [],
          warnings: [],
        }
      : await readSessionState(path)
    const agentRuntime = parsed.header.agentRuntime ?? 'kernel'
    const events = parsed.events.map((e) => e.event)
    const lastSnapshot = parsed.snapshots.at(-1)
    let finalState = agentRuntime === 'kernel'
      ? fold(parsed.header.initialState, events, parsed.header.config)
      : lastSnapshot?.state ?? parsed.header.initialState
    let cursor = finalState.cursor

    const parsedExternalRuntimeAlreadyQuarantined = parsed.runtimeMetadata.some((entry) =>
      entry.action === 'runtime.quarantined_kernel_events',
    )
    if (
      options.recoverDangling
      && agentRuntime !== 'kernel'
      && parsed.events.length > 0
      && !parsedExternalRuntimeAlreadyQuarantined
    ) {
      const foreignEventCursor = parsed.events.at(-1)?.seq ?? finalState.cursor
      finalState = quarantinedExternalRuntimeState(finalState, foreignEventCursor)
      cursor = finalState.cursor
      await appendRuntimeMetadataEntry(path, {
        sessionId,
        action: 'runtime.quarantined_kernel_events',
        payload: { eventCount: parsed.events.length },
      })
      const quarantineSnapshot = await appendSnapshotEntry(path, cursor, finalState)
      parsed.snapshots.push(quarantineSnapshot)
    } else if (options.recoverDangling && needsExternalRuntimeRecovery(agentRuntime, finalState)) {
      const interruptedCalls = finalState.pendingCalls
      finalState = interruptedExternalRuntimeState(agentRuntime, finalState)!
      cursor = finalState.cursor
      await appendRuntimeMetadataEntry(path, {
        sessionId,
        action: 'copilot.recovered_interrupted_turn',
        payload: { pendingCallCount: interruptedCalls.length },
      })
      const recoverySnapshot = await appendSnapshotEntry(path, cursor, finalState)
      parsed.snapshots.push(recoverySnapshot)
    }

    // Crash recovery: a session that was mid-tool-call when the host died
    // has status='awaiting_approval' or 'executing_tools' with non-empty
    // pendingCalls. The promise that would have resolved is gone, so the
    // session hangs. Synthesize a failed tool_result for each pending call
    // and append it to the log so replay stays exact.
    let recoveredPending = false
    if (
      options.recoverDangling &&
      agentRuntime === 'kernel' &&
      (finalState.status === 'awaiting_approval' ||
        finalState.status === 'executing_tools') &&
      finalState.pendingCalls.length > 0
    ) {
      recoveredPending = true
      for (const pending of finalState.pendingCalls) {
        const recoveryEvent: AgentEvent = {
          kind: 'tool_result',
          callId: pending.callId,
          ok: false,
          content: 'host restarted while call was pending',
        }
        // `awaiting_approval` calls never got a `dispatched` status, so the
        // reducer would refuse a `tool_result` for them. Approve first to
        // move the call into `dispatched`, then feed the failure — the
        // reducer will accept it and settle the pending list.
        if (pending.status === 'awaiting_approval') {
          const approveEvent: AgentEvent = {
            kind: 'user_approve',
            callId: pending.callId,
          }
          const { next, effects } = step(
            finalState,
            approveEvent,
            parsed.header.config,
          )
          finalState = next
          cursor = next.cursor
          const entry = await appendEventEntry({
            path,
            seq: cursor,
            event: approveEvent,
            effects,
          })
          parsed.events.push(entry)
        }
        const { next, effects } = step(finalState, recoveryEvent, parsed.header.config)
        finalState = next
        cursor = next.cursor
        const entry = await appendEventEntry({
          path,
          seq: cursor,
          event: recoveryEvent,
          effects,
        })
        parsed.events.push(entry)
      }
    }

    // Mid-stream recovery: status='thinking' with no pendingCalls means the
    // last effect was `call_llm` and the reply never came back before the
    // host died. Without a synthetic response the session would sit in
    // `thinking` forever — no client notification, no way to send a new
    // user message (reducer only accepts `user_message` from idle/done/error).
    // Synthesize a minimal assistant message so the reducer transitions to
    // `done` and dashboards see the closure via the normal event broadcast.
    //
    // Guard: skip if we just recovered pending tool calls above. In that
    // case `thinking` is a transient state produced by our synthetic events
    // asking the LLM to react to the failures — that's a legitimate next
    // turn, not a stuck stream.
    if (
      options.recoverDangling &&
      agentRuntime === 'kernel' &&
      !recoveredPending &&
      finalState.status === 'thinking' &&
      finalState.pendingCalls.length === 0
    ) {
      const recoveryEvent: AgentEvent = {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '[interrupted]' }],
        },
      }
      const { next, effects } = step(finalState, recoveryEvent, parsed.header.config)
      finalState = next
      cursor = next.cursor
      const entry = await appendEventEntry({
        path,
        seq: cursor,
        event: recoveryEvent,
        effects,
      })
      parsed.events.push(entry)
    }

    const latestWorkspaceId =
      latestStringFromMetadata(parsed.metadata, 'workspaceId') ??
      persistedSummary?.summary.workspaceId ??
      parsed.header.workspaceId
    const latestWorkspaceName =
      latestStringFromMetadata(parsed.metadata, 'workspaceName') ??
      persistedSummary?.summary.workspaceName ??
      parsed.header.workspaceName
    const latestOrganizationId =
      latestStringFromMetadata(parsed.metadata, 'organizationId') ??
      parsed.header.organizationId
    const latestPrincipal =
      latestStringFromMetadata(parsed.metadata, 'principal') ??
      parsed.header.principal
    const latestOrganizationRole =
      latestOrganizationRoleFromMetadata(parsed.metadata) ??
      parsed.header.organizationRole
    const labelPatch = latestStringMetadataPatch(parsed.metadata, 'label')
    const label = labelPatch.found
      ? labelPatch.value
      : persistedSummary?.summary.label
    const firstUserMessage = agentRuntime === 'kernel'
      ? firstUserMessageFromEvents(parsed.events)
      : firstUserMessageFromState(finalState)
    const turnStartedAt = agentRuntime === 'kernel'
      ? latestKernelTurnStartedAt(parsed.events)
      : validTimestamp(latestCopilotUserMessage?.ts)
    const selectedModel = latestStringFromMetadata(parsed.metadata, 'selectedModel') ??
      persistedSummary?.summary.preferences?.selectedModel
    const toolCardMode = latestToolCardModeFromMetadata(parsed.metadata) ??
      persistedSummary?.summary.preferences?.toolCardMode
    const transcriptViewStart = latestTranscriptViewStartFromMetadata(parsed.metadata) ??
      persistedSummary?.summary.preferences?.transcriptViewStart
    const rightPanelTab = latestRightPanelTabFromMetadata(parsed.metadata) ??
      persistedSummary?.summary.preferences?.rightPanelTab
    const chapterReadingModePatch = latestChapterReadingModePatchFromMetadata(parsed.metadata)
    const chapterReadingMode = chapterReadingModePatch.found
      ? chapterReadingModePatch.value
      : persistedSummary?.summary.preferences?.chapterReadingMode
    const preferences: SessionPreferences = {
      ...(selectedModel
        ? { selectedModel }
        : {}),
      ...(toolCardMode ? { toolCardMode } : {}),
      ...(transcriptViewStart !== undefined ? { transcriptViewStart } : {}),
      ...(rightPanelTab ? { rightPanelTab } : {}),
      ...(chapterReadingMode ? { chapterReadingMode } : {}),
    }

    const record: SessionRecord = {
      sessionId,
      agentRuntime,
      executionMode: parsed.header.executionMode ?? 'chat',
      ...(parsed.header.agentRuntimeVersion ? { agentRuntimeVersion: parsed.header.agentRuntimeVersion } : {}),
      ...(parsed.header.externalSessionId ? { externalSessionId: parsed.header.externalSessionId } : {}),
      logPath: path,
      createdAt: parsed.header.ts,
      config: configWithPersistedSystemPrompt(
        options.runtimeConfig
          ?? this.resolveRuntimeConfig(undefined, parsed.header.executionMode ?? 'chat')
          ?? parsed.header.config,
        finalState,
      ),
      toolLock: toolLockFor(parsed.header.config),
      preferences,
      ...(runtimeContextSnapshot ? { runtimeContextSnapshot } : {}),
      ...(persistedSummary?.summary.lastEventAt || parsed.events.length > 0
        ? { lastEventAt: persistedSummary?.summary.lastEventAt ?? parsed.events[parsed.events.length - 1]!.ts }
        : {}),
      state: finalState,
      ...(turnStartedAt ? { turnStartedAt } : {}),
      ...(firstUserMessage ? { firstUserMessage } : {}),
      ...(parsed.header.parentSessionId
        ? { parentSessionId: parsed.header.parentSessionId }
        : {}),
      ...(parsed.header.parentCursor !== undefined
        ? { parentCursor: parsed.header.parentCursor }
        : {}),
      ...(parsed.header.parentCallId !== undefined
        ? { parentCallId: parsed.header.parentCallId }
        : {}),
      ...(parsed.header.agentType !== undefined
        ? { agentType: parsed.header.agentType }
        : {}),
      ...(parsed.header.subAgentStartedAt !== undefined
        ? { subAgentStartedAt: parsed.header.subAgentStartedAt }
        : {}),
      ...(latestWorkspaceId !== undefined
        ? { workspaceId: latestWorkspaceId }
        : {}),
      ...(latestWorkspaceName !== undefined
        ? { workspaceName: latestWorkspaceName }
        : {}),
      ...(latestOrganizationId !== undefined
        ? { organizationId: latestOrganizationId }
        : {}),
      ...(latestPrincipal !== undefined
        ? { principal: latestPrincipal }
        : {}),
      ...(latestOrganizationRole !== undefined
        ? { organizationRole: latestOrganizationRole }
        : {}),
      ...(label
        ? { label }
        : {}),
    }
    this.records.set(sessionId, record)
    this.summaryCache.delete(path)
    return record
  }

  private async appendInterruptedLlmRecovery(record: SessionRecord): Promise<{
    event: AgentEvent
    effects: readonly Effect[]
  } | null> {
    if (record.state.status !== 'thinking' || record.state.pendingCalls.length > 0) {
      return null
    }
    const event: AgentEvent = interruptedLlmRecoveryEvent()
    const { next, effects } = step(record.state, event, record.config)
    if (this.options.authority) {
      await this.record(record.sessionId, event, effects, next)
    } else {
      const entry = await appendEventEntry({
        path: record.logPath,
        seq: next.cursor,
        event,
        effects,
      })
      record.state = next
      record.lastEventAt = entry.ts
      this.summaryCache.delete(record.logPath)
    }
    return { event, effects }
  }
}

function safeDirectChild(parent: string, child: string): string {
  const root = resolve(parent)
  const target = resolve(root, child)
  if (dirname(target) !== root) throw new Error('refusing to delete an unsafe Session artifact path')
  return target
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

type CachedSessionSummary = {
  mtimeMs: number
  size: number
  summary: SessionSummary
  hasEvents?: boolean
  externalRuntimeAlreadyQuarantined?: boolean
}

type PersistedSessionSummary = CachedSessionSummary & {
  schemaVersion: 2
  hasEvents: boolean
  externalRuntimeAlreadyQuarantined: boolean
}

function summaryCachePath(logPath: string): string {
  return `${logPath}.summary.json`
}

function runtimeContextCachePath(logPath: string): string {
  return `${logPath}.context.json`
}

async function readPersistedRuntimeContext(
  logPath: string,
  sessionId: string,
): Promise<ContextUsageSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runtimeContextCachePath(logPath), 'utf8')) as {
      schemaVersion?: unknown
      sessionId?: unknown
      contextSnapshot?: unknown
    }
    if (
      parsed.schemaVersion !== 1
      || parsed.sessionId !== sessionId
      || !isContextUsageSnapshot(parsed.contextSnapshot)
    ) return undefined
    return parsed.contextSnapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<ContextUsageSnapshot>
  return typeof snapshot.model?.ref === 'string'
    && (snapshot.contextWindow?.tokens === null || typeof snapshot.contextWindow?.tokens === 'number')
    && typeof snapshot.contextWindow?.source === 'string'
    && typeof snapshot.usage?.inputTokens === 'number'
    && typeof snapshot.usage?.totalTokens === 'number'
    && typeof snapshot.updatedAt === 'number'
}

async function readPersistedSummary(logPath: string): Promise<CachedSessionSummary | undefined> {
  try {
    const parsed = JSON.parse(await readFile(summaryCachePath(logPath), 'utf8')) as Partial<PersistedSessionSummary>
    if (
      parsed.schemaVersion !== 2
      || typeof parsed.mtimeMs !== 'number'
      || typeof parsed.size !== 'number'
      || typeof parsed.hasEvents !== 'boolean'
      || typeof parsed.externalRuntimeAlreadyQuarantined !== 'boolean'
      || !parsed.summary
      || typeof parsed.summary.sessionId !== 'string'
    ) return undefined
    return {
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      summary: parsed.summary,
      hasEvents: parsed.hasEvents,
      externalRuntimeAlreadyQuarantined: parsed.externalRuntimeAlreadyQuarantined,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function loadedRecordForPath(
  records: ReadonlyMap<string, SessionRecord>,
  path: string,
): SessionRecord | undefined {
  for (const record of records.values()) {
    if (record.logPath === path) return record
  }
  return undefined
}

function recordForCreate(
  params: CreateSessionParams,
  sessionId: string,
  logPath: string,
  createdAt: string,
  state: AgentState,
): SessionRecord {
  return {
    sessionId,
    agentRuntime: params.agentRuntime ?? 'kernel',
    executionMode: params.executionMode ?? 'chat',
    ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
    ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
    logPath,
    createdAt,
    config: params.config,
    toolLock: toolLockFor(params.config),
    state,
    preferences: normalizedPreferences(params.preferences),
    ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
    ...(params.parentCursor !== undefined ? { parentCursor: params.parentCursor } : {}),
    ...(params.parentCallId !== undefined ? { parentCallId: params.parentCallId } : {}),
    ...(params.agentType !== undefined ? { agentType: params.agentType } : {}),
    ...(params.subAgentStartedAt !== undefined ? { subAgentStartedAt: params.subAgentStartedAt } : {}),
    ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
    ...(params.workspaceName !== undefined ? { workspaceName: params.workspaceName } : {}),
    ...(params.organizationId !== undefined ? { organizationId: params.organizationId } : {}),
    ...(params.principal !== undefined ? { principal: params.principal } : {}),
    ...(params.organizationRole !== undefined ? { organizationRole: params.organizationRole } : {}),
    ...(params.memoryPolicy !== undefined ? { memoryPolicy: params.memoryPolicy } : {}),
  }
}

function persistSessionRecord(record: SessionRecord): PersistedSessionDocument {
  const { logPath: _logPath, memoryPolicy: _memoryPolicy, ...document } = record
  return document as PersistedSessionDocument
}

function syncBackfilledMetadata(record: SessionRecord, document: PersistedSessionDocument): void {
  const mutable = record as {
    workspaceId?: string
    workspaceName?: string
    organizationId?: string
    principal?: string
    organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  }
  for (const field of ['workspaceId', 'workspaceName', 'organizationId', 'principal'] as const) {
    const value = document[field]
    if (typeof value === 'string') mutable[field] = value
  }
  const role = document.organizationRole
  if (role === 'owner' || role === 'admin' || role === 'member' || role === 'viewer') mutable.organizationRole = role
}

function restoreSessionRecord(
  document: PersistedSessionDocument,
  logPath: string,
  memoryPolicy?: SessionMemoryPolicy,
): SessionRecord {
  if (!document.sessionId || !document.state || !Number.isSafeInteger(document.state.cursor)) {
    throw new Error('Invalid Session document in PostgreSQL authority')
  }
  return {
    ...document,
    logPath,
    ...(memoryPolicy !== undefined ? { memoryPolicy } : {}),
  } as SessionRecord
}

function randomMutationId(): string {
  return ulid()
}

function summarizeRecord(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.sessionId,
    agentRuntime: record.agentRuntime,
    executionMode: record.executionMode,
    ...(record.agentRuntimeVersion ? { agentRuntimeVersion: record.agentRuntimeVersion } : {}),
    createdAt: record.createdAt,
    eventCount: record.state.cursor,
    ...(record.lastEventAt ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
    ...(record.workspaceName !== undefined ? { workspaceName: record.workspaceName } : {}),
    status: record.state.status,
    ...(record.state.cwd ? { currentCwd: record.state.cwd } : {}),
    ...(record.firstUserMessage ? { firstUserMessage: record.firstUserMessage.slice(0, 120) } : {}),
    ...(record.label ? { label: record.label } : {}),
    ...(Object.keys(record.preferences).length > 0 ? { preferences: record.preferences } : {}),
  }
}

function sessionEligibleForRetention(record: SessionRecord, cutoffMs: number | undefined): boolean {
  // These states can own live model/tool work or a pending human decision.
  // A stale activity timestamp is not permission to interrupt that work.
  if (record.state.status === 'thinking' || record.state.status === 'awaiting_approval' || record.state.status === 'executing_tools') return false
  if (cutoffMs === undefined) return true
  const activity = Date.parse(record.lastEventAt ?? record.createdAt)
  return Number.isFinite(activity) && activity < cutoffMs
}

function needsExternalRuntimeRecovery(
  agentRuntime: AgentRuntimeId,
  state: AgentState,
): boolean {
  return agentRuntime !== 'kernel' && (
    state.status === 'thinking'
    || state.status === 'awaiting_approval'
    || state.status === 'executing_tools'
  )
}

function interruptedExternalRuntimeState(
  agentRuntime: AgentRuntimeId,
  state: AgentState,
): AgentState | undefined {
  if (!needsExternalRuntimeRecovery(agentRuntime, state)) return undefined
  return {
    ...state,
    cursor: state.cursor + 1,
    status: 'error',
    pendingCalls: [],
    messages: [
      ...state.messages,
      ...state.pendingCalls.map((call) => ({
        role: 'tool' as const,
        content: [{
          type: 'tool_result' as const,
          callId: call.callId,
          ok: false,
          content: 'host restarted while call was pending',
        }],
      })),
    ],
    error: 'Copilot turn was interrupted by a host restart',
  }
}

function quarantinedExternalRuntimeState(state: AgentState, minimumCursor = state.cursor): AgentState {
  const message = 'Non-Kernel Session contained Kernel events and was quarantined'
  return {
    ...state,
    cursor: Math.max(state.cursor + 1, minimumCursor),
    status: 'error',
    pendingCalls: [],
    messages: [...state.messages, {
      role: 'assistant',
      content: [{ type: 'text', text: message }],
    }],
    error: message,
  }
}

function firstUserMessageFromEvents(
  events: readonly { event: AgentEvent }[],
): string | undefined {
  for (const entry of events) {
    if (entry.event.kind !== 'user_message') continue
    if (entry.event.text?.trim()) return entry.event.text
  }
  return undefined
}

function latestKernelTurnStartedAt(events: readonly EventEntry[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]
    if (entry?.event.kind !== 'user_message') continue
    return validTimestamp(entry.timing?.turnStartedAt) ?? validTimestamp(entry.ts)
  }
  return undefined
}

function validTimestamp(value: string | undefined): string | undefined {
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined
}

function summarizeLog(
  parsed: Awaited<ReturnType<typeof readSessionLog>>,
): SessionSummary {
  const header = parsed.header
  const agentRuntime = header.agentRuntime ?? 'kernel'
  const events = parsed.events
  const lastEvent = events.length > 0 ? events[events.length - 1]! : undefined
  const lastSnapshot =
    parsed.snapshots.length > 0
      ? parsed.snapshots[parsed.snapshots.length - 1]!
      : undefined
  const firstUserText = agentRuntime === 'kernel'
    ? firstUserMessageFromEvents(events)
    : firstUserMessageFromState(lastSnapshot?.state ?? header.initialState)
  const label = latestStringFromMetadata(parsed.metadata, 'label')
  const selectedModel = latestStringFromMetadata(parsed.metadata, 'selectedModel')
  const toolCardMode = latestToolCardModeFromMetadata(parsed.metadata)
  const transcriptViewStart = latestTranscriptViewStartFromMetadata(parsed.metadata)
  const rightPanelTab = latestRightPanelTabFromMetadata(parsed.metadata)
  const chapterReadingMode = latestChapterReadingModePatchFromMetadata(parsed.metadata).value
  const workspaceId =
    latestStringFromMetadata(parsed.metadata, 'workspaceId') ?? header.workspaceId
  const workspaceName =
    latestStringFromMetadata(parsed.metadata, 'workspaceName') ?? header.workspaceName
  // executorId is deliberately not inferred from the log — the JSONL doesn't
  // record which executor produced each tool_result, so any inference here
  // would be a guess. Host can layer it on later by tracking attach history.
  const status =
    lastSnapshot?.state.status ?? statusFromEffects(events)
  const foldedState = lastSnapshot?.state ?? fold(
    header.initialState,
    events.map((e) => e.event),
    header.config,
  )
  return {
    sessionId: header.sessionId,
    agentRuntime,
    executionMode: header.executionMode ?? 'chat',
    createdAt: header.ts,
    eventCount: agentRuntime === 'kernel' ? events.length : (lastSnapshot?.seq ?? 0),
    ...((lastSnapshot?.ts ?? lastEvent?.ts) ? { lastEventAt: lastSnapshot?.ts ?? lastEvent?.ts } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(workspaceId !== undefined
      ? { workspaceId }
      : {}),
    ...(workspaceName !== undefined
      ? { workspaceName }
      : {}),
    ...(status ? { status } : {}),
    ...(foldedState.cwd
      ? { currentCwd: foldedState.cwd }
      : {}),
    ...(firstUserText
      ? { firstUserMessage: firstUserText.slice(0, 120) }
      : {}),
    ...(label ? { label } : {}),
    ...(selectedModel || toolCardMode || transcriptViewStart !== undefined || rightPanelTab || chapterReadingMode
      ? { preferences: {
          ...(selectedModel ? { selectedModel } : {}),
          ...(toolCardMode ? { toolCardMode } : {}),
          ...(transcriptViewStart !== undefined ? { transcriptViewStart } : {}),
          ...(rightPanelTab ? { rightPanelTab } : {}),
          ...(chapterReadingMode ? { chapterReadingMode } : {}),
        } }
      : {}),
  }

}

function firstUserMessageFromState(state: AgentState): string | undefined {
  for (const message of state.messages) {
    if (!isRealUserMessage(message)) continue
    const text = message.content.find((content) => content.type === 'text')
    if (text?.type === 'text' && text.text.trim()) return text.text
  }
  return undefined
}

/** Walk metadata entries in reverse to find the most recent string value. */
function latestStringMetadataPatch(
  metadata: readonly MetadataEntry[],
  key: 'label' | 'workspaceId' | 'workspaceName' | 'selectedModel' | 'organizationId' | 'principal',
): { found: false } | { found: true; value: string | undefined } {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i]!
    const value = entry[key]
    if (value === undefined) continue
    const trimmed = value.trim()
    return { found: true, value: trimmed.length === 0 ? undefined : trimmed }
  }
  return { found: false }
}

function latestStringFromMetadata(
  metadata: readonly MetadataEntry[],
  key: 'label' | 'workspaceId' | 'workspaceName' | 'selectedModel' | 'organizationId' | 'principal',
): string | undefined {
  const patch = latestStringMetadataPatch(metadata, key)
  return patch.found ? patch.value : undefined
}

function latestOrganizationRoleFromMetadata(
  metadata: readonly MetadataEntry[],
): 'owner' | 'admin' | 'member' | 'viewer' | undefined {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const value = metadata[i]!.organizationRole
    if (value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer') return value
  }
  return undefined
}

function latestToolCardModeFromMetadata(
  metadata: readonly MetadataEntry[],
): 'dots' | 'standard' | undefined {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const value = metadata[i]!.toolCardMode
    if (value === 'dots' || value === 'standard') return value
  }
  return undefined
}

function latestTranscriptViewStartFromMetadata(
  metadata: readonly MetadataEntry[],
): number | undefined {
  for (let i = metadata.length - 1; i >= 0; i -= 1) {
    const value = metadata[i]!.transcriptViewStart
    if (Number.isSafeInteger(value) && value !== undefined && value >= 0) return value
  }
  return undefined
}

function latestRightPanelTabFromMetadata(
  metadata: readonly MetadataEntry[],
): SessionPreferences['rightPanelTab'] {
  for (let i = metadata.length - 1; i >= 0; i -= 1) {
    const value = metadata[i]!.rightPanelTab
    if (value === 'files' || value === 'git' || value === 'terminal' || value === 'inspector' || value === 'scheduledTasks') return value
  }
  return undefined
}

function latestChapterReadingModePatchFromMetadata(
  metadata: readonly MetadataEntry[],
): { found: boolean; value: SessionPreferences['chapterReadingMode'] } {
  for (let i = metadata.length - 1; i >= 0; i -= 1) {
    const entry = metadata[i]!
    if (!('chapterReadingMode' in entry)) continue
    const value = entry.chapterReadingMode
    if (value === null) return { found: true, value: undefined }
    if (value === 'chapters' || value === 'continuous') return { found: true, value }
  }
  return { found: false, value: undefined }
}

function normalizedPreferences(preferences: SessionPreferences | undefined): SessionPreferences {
  const selectedModel = normalizePreferenceString(preferences?.selectedModel)
  const transcriptViewStart = preferences?.transcriptViewStart
  return {
    ...(selectedModel ? { selectedModel } : {}),
    ...(preferences?.toolCardMode ? { toolCardMode: preferences.toolCardMode } : {}),
    ...(transcriptViewStart !== undefined && Number.isSafeInteger(transcriptViewStart) && transcriptViewStart >= 0
      ? { transcriptViewStart }
      : {}),
    ...(preferences?.rightPanelTab ? { rightPanelTab: preferences.rightPanelTab } : {}),
    ...(preferences?.chapterReadingMode ? { chapterReadingMode: preferences.chapterReadingMode } : {}),
  }
}

function hasPreferencePatch(patch: SessionPreferencesPatch): boolean {
  return 'selectedModel' in patch
    || 'toolCardMode' in patch
    || 'transcriptViewStart' in patch
    || 'rightPanelTab' in patch
    || 'chapterReadingMode' in patch
}

function applyPreferencePatch(current: SessionPreferences, patch: SessionPreferencesPatch): SessionPreferences {
  const next = { ...current }
  if ('selectedModel' in patch) {
    const value = normalizePreferenceString(patch.selectedModel)
    if (value === undefined) delete next.selectedModel
    else next.selectedModel = value
  }
  if ('toolCardMode' in patch) {
    if (patch.toolCardMode === undefined) delete next.toolCardMode
    else next.toolCardMode = patch.toolCardMode
  }
  if ('transcriptViewStart' in patch) {
    if (patch.transcriptViewStart === undefined) delete next.transcriptViewStart
    else next.transcriptViewStart = patch.transcriptViewStart
  }
  if ('rightPanelTab' in patch) {
    if (patch.rightPanelTab === undefined) delete next.rightPanelTab
    else next.rightPanelTab = patch.rightPanelTab
  }
  if ('chapterReadingMode' in patch) {
    if (patch.chapterReadingMode == null) delete next.chapterReadingMode
    else next.chapterReadingMode = patch.chapterReadingMode
  }
  return next
}

function normalizePreferenceString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

// Older logs (pre-snapshot-writer) have no snapshot lines. Recover an
// approximate status from the effects the reducer emitted on each event —
// finish → done, emit_error → error, request_approval → awaiting_approval.
function statusFromEffects(
  events: Awaited<ReturnType<typeof readSessionLog>>['events'],
): SessionSummary['status'] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const effects = events[i]!.effects
    for (const eff of effects) {
      if (eff.kind === 'finish') return 'done'
      if (eff.kind === 'emit_error') return 'error'
      if (eff.kind === 'request_approval') return 'awaiting_approval'
    }
  }
  return undefined
}
