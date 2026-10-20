/**
 * JSONL event log reader/writer.
 *
 * Append-only. Each session gets one file. Header first, events after, all
 * one JSON object per line. See `docs/protocol/event-log.md` for the spec.
 */

import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline/promises'
import { basename, dirname, join, relative } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import type {
  EventEntry,
  AgentRuntimeId,
  HeaderEntry,
  LLMTrace,
  LogArtifactRef,
  LogEntry,
  MetadataEntry,
  RuntimeMetadataEntry,
  SnapshotEntry,
} from '@agent-kernel/shared'
import type { SessionExecutionMode } from '@agent-kernel/shared'
import { LOG_FORMAT_VERSION, redactLlmTrace } from '@agent-kernel/shared'

const KERNEL_VERSION = '@agent-kernel/kernel@0.0.0'

export type WriteHeaderParams = {
  path: string
  sessionId: string
  agentRuntime?: AgentRuntimeId
  executionMode?: SessionExecutionMode
  agentRuntimeVersion?: string
  externalSessionId?: string
  config: AgentConfig
  initialState: AgentState
  parentSessionId?: string
  parentCursor?: number
  parentCallId?: string
  agentType?: string
  subAgentStartedAt?: string
  workspaceId?: string
  workspaceName?: string
  organizationId?: string
  principal?: string
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  initialCwd?: string
}

export async function writeHeader(params: WriteHeaderParams): Promise<HeaderEntry> {
  await mkdir(dirname(params.path), { recursive: true })
  const entry: HeaderEntry = {
    kind: 'header',
    seq: 0,
    ts: new Date().toISOString(),
    sessionId: params.sessionId,
    ...(params.agentRuntime ? { agentRuntime: params.agentRuntime } : {}),
    ...(params.executionMode ? { executionMode: params.executionMode } : {}),
    ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
    ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
    formatVersion: LOG_FORMAT_VERSION,
    kernelVersion: KERNEL_VERSION,
    config: params.config,
    initialState: params.initialState,
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
    ...(params.initialCwd !== undefined ? { initialCwd: params.initialCwd } : {}),
  }
  await writeFile(params.path, JSON.stringify(entry) + '\n', 'utf8')
  await maybeWriteAgentModuleArtifacts(params.path, entry)
  return entry
}

export async function readSessionHeader(path: string): Promise<HeaderEntry> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      const entry = JSON.parse(line) as LogEntry
      if (entry.kind !== 'header') throw new Error(`First log entry is not a header: ${path}`)
      return entry
    }
  } finally {
    rl.close()
    input.destroy()
    if (!input.closed) await once(input, 'close')
  }
  throw new Error(`Session log is empty: ${path}`)
}

async function maybeWriteAgentModuleArtifacts(logPath: string, header: HeaderEntry): Promise<void> {
  if (!header.config.agentModule) return
  const root = artifactRootForLog(logPath)
  const dir = join(root, 'agent-module')
  await mkdir(dir, { recursive: true })
  if (header.config.systemPrompt) {
    await writeFile(join(dir, 'system-prompt.txt'), header.config.systemPrompt, 'utf8')
  }
  await writeFile(
    join(dir, 'tool-registry.json'),
    JSON.stringify({
      module: header.config.agentModule,
      tools: header.config.tools,
    }, null, 2) + '\n',
    'utf8',
  )
}

export type AppendEventParams = {
  path: string
  seq: number
  event: AgentEvent
  effects: readonly Effect[]
  usage?: UsageTotal
  llmTrace?: LLMTrace
  model?: string
  timing?: import('@agent-kernel/shared').EventTimingMetadata
}

export async function appendEventEntry(
  params: AppendEventParams,
): Promise<EventEntry> {
  const artifactRoot = artifactRootForLog(params.path)
  const fullEffects = params.effects
  const slimEffects = params.effects.map(slimEffect)
  const safeLlmTrace = params.llmTrace ? redactLlmTrace(params.llmTrace) : undefined
  // A full LLM trace already carries the provider request/response payload.
  // Persisting the call_llm effect beside it duplicates the dominant message
  // history bytes. Keep effects as the fallback authority when no trace exists.
  const effectsArtifact = hasLargeEffectPayload(fullEffects) && !safeLlmTrace
    ? await writeJsonArtifact({
        logPath: params.path,
        artifactRoot,
        kind: 'effects',
        seq: params.seq,
        value: fullEffects,
      })
    : undefined
  const llmTraceArtifact = safeLlmTrace
    ? await writeJsonArtifact({
        logPath: params.path,
        artifactRoot,
        kind: 'llm-traces',
        seq: params.seq,
        value: safeLlmTrace,
      })
    : undefined
  const entry: EventEntry = {
    kind: 'event',
    seq: params.seq,
    ts: new Date().toISOString(),
    event: params.event,
    effects: slimEffects,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(effectsArtifact ? { effectsArtifact } : {}),
    ...(safeLlmTrace ? { llmTrace: summarizeLlmTrace(safeLlmTrace) } : {}),
    ...(llmTraceArtifact ? { llmTraceArtifact } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.timing ? { timing: params.timing } : {}),
  }
  // Event entries are the authority for Session state. `appendFile()` resolving
  // only means bytes reached the kernel page cache; a crash could otherwise
  // acknowledge and broadcast an event that is absent after restart.
  await appendDurableLine(params.path, JSON.stringify(entry) + '\n')
  return entry
}

async function appendDurableLine(path: string, line: string): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(line, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function summarizeLlmTrace(trace: LLMTrace): LLMTrace {
  return {
    provider: trace.provider,
    model: trace.model,
    request: {
      url: trace.request.url,
      headers: trace.request.headers,
      body: undefined,
    },
    ...(trace.response
      ? {
          response: {
            status: trace.response.status,
            ...(trace.response.streamEventTypes ? { streamEventTypes: trace.response.streamEventTypes } : {}),
            ...(trace.response.metrics ? { metrics: trace.response.metrics } : {}),
          },
        }
      : {}),
    ...(trace.gatewayRequestId ? { gatewayRequestId: trace.gatewayRequestId } : {}),
    ...(trace.weightVersion ? { weightVersion: trace.weightVersion } : {}),
  }
}

function artifactRootForLog(logPath: string): string {
  const sessionSlug = basename(logPath, '.jsonl')
  return join(dirname(logPath), 'artifacts', sessionSlug)
}

function hasLargeEffectPayload(effects: readonly Effect[]): boolean {
  return effects.some((effect) => effect.kind === 'call_llm')
}

export function slimEffect(effect: Effect): Effect {
  if (effect.kind === 'call_llm') return { kind: 'call_llm', messages: [], tools: [] }
  if (effect.kind === 'call_tool') {
    return {
      kind: 'call_tool',
      callId: effect.callId,
      name: effect.name,
      input: effect.input,
      ...(effect.cwd ? { cwd: effect.cwd } : {}),
    }
  }
  if (effect.kind === 'request_approval') {
    return {
      kind: 'request_approval',
      callId: effect.callId,
      name: effect.name,
      input: effect.input,
    }
  }
  return effect
}

async function writeJsonArtifact(params: {
  logPath: string
  artifactRoot: string
  kind: 'effects' | 'llm-traces'
  seq: number
  value: unknown
}): Promise<LogArtifactRef> {
  const dir = join(params.artifactRoot, params.kind)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${String(params.seq).padStart(8, '0')}.json`)
  const json = JSON.stringify(params.value)
  await writeFile(path, json + '\n', 'utf8')
  return {
    path: relative(dirname(params.logPath), path),
    bytes: Buffer.byteLength(json) + 1,
    sha256: createHash('sha256').update(json).update('\n').digest('hex'),
  }
}

export async function appendSnapshotEntry(
  path: string,
  seq: number,
  state: AgentState,
): Promise<SnapshotEntry> {
  const entry: SnapshotEntry = {
    kind: 'snapshot',
    seq,
    ts: new Date().toISOString(),
    state,
  }
  await writeSnapshotSidecar(path, entry)
  return entry
}

export function snapshotSidecarPath(logPath: string): string {
  return logPath.endsWith('.jsonl')
    ? `${logPath.slice(0, -'.jsonl'.length)}.snapshot.json`
    : `${logPath}.snapshot.json`
}

async function writeSnapshotSidecar(logPath: string, entry: SnapshotEntry): Promise<void> {
  const path = snapshotSidecarPath(logPath)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const logSize = (await stat(logPath)).size
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ ...entry, logSize })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    // Windows cannot fsync a directory handle. The file itself was flushed
    // before the atomic replace; retain the directory flush on POSIX only.
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function appendMetadataEntry(
  path: string,
  patch: Pick<MetadataEntry, 'label' | 'workspaceId' | 'workspaceName' | 'organizationId' | 'principal' | 'organizationRole' | 'selectedModel' | 'toolCardMode' | 'transcriptViewStart' | 'rightPanelTab' | 'chapterReadingMode'>,
): Promise<MetadataEntry> {
  const entry: MetadataEntry = {
    kind: 'metadata',
    ts: new Date().toISOString(),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
    ...(patch.workspaceName !== undefined ? { workspaceName: patch.workspaceName } : {}),
    ...(patch.organizationId !== undefined ? { organizationId: patch.organizationId } : {}),
    ...(patch.principal !== undefined ? { principal: patch.principal } : {}),
    ...(patch.organizationRole !== undefined ? { organizationRole: patch.organizationRole } : {}),
    ...(patch.selectedModel !== undefined ? { selectedModel: patch.selectedModel } : {}),
    ...(patch.toolCardMode !== undefined ? { toolCardMode: patch.toolCardMode } : {}),
    ...(patch.transcriptViewStart !== undefined ? { transcriptViewStart: patch.transcriptViewStart } : {}),
    ...(patch.rightPanelTab !== undefined ? { rightPanelTab: patch.rightPanelTab } : {}),
    ...('chapterReadingMode' in patch ? { chapterReadingMode: patch.chapterReadingMode ?? null } : {}),
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export async function appendRuntimeMetadataEntry(
  path: string,
  input: {
    sessionId: string
    action: string
    payload: Record<string, unknown>
    artifactRef?: LogArtifactRef
  },
): Promise<RuntimeMetadataEntry> {
  const entry: RuntimeMetadataEntry = {
    kind: 'runtime_metadata',
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    action: input.action,
    payload: input.payload,
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export type ParsedLog = {
  header: HeaderEntry
  events: EventEntry[]
  snapshots: SnapshotEntry[]
  metadata: MetadataEntry[]
  runtimeMetadata: RuntimeMetadataEntry[]
  /**
   * Non-fatal parse warnings. Populated when the last line of the file was
   * truncated (the process crashed mid-`appendFile`). The recovered log is
   * still usable — the caller can decide whether to surface the warning.
   */
  warnings: readonly string[]
}

export type ParsedHistory = {
  events: EventEntry[]
  runtimeMetadata: RuntimeMetadataEntry[]
}

export type FullSessionReadOptions = {
  allowExternalRuntime?: boolean
}

async function assertFullSessionReadAllowed(
  path: string,
  options: FullSessionReadOptions | undefined,
  api: string,
): Promise<void> {
  if (options?.allowExternalRuntime) return
  let header: HeaderEntry
  try {
    header = await readSessionHeader(path)
  } catch {
    return
  }
  if ((header.agentRuntime ?? 'kernel') === 'kernel') return
  throw new Error(`${api} refuses to fully read external Runtime session ${header.sessionId}; use header/snapshot/bounded metadata readers or explicitly opt in for offline export`)
}

export type SessionOperationMatch =
  | { kind: 'event'; cursor: number; event: Extract<AgentEvent, { kind: 'user_message' }> }
  | { kind: 'runtime_metadata'; action: string; text?: string; requestFingerprint?: string }

export async function findLatestEventEntry(
  path: string,
  options: { maxScanBytes?: number } = {},
): Promise<EventEntry | undefined> {
  const handle = await open(path, 'r')
  const needle = Buffer.from('"kind":"event"')
  const chunkSize = 4 * 1024 * 1024
  let carry = Buffer.alloc(0)
  try {
    const stat = await handle.stat()
    let end = stat.size
    const minimumOffset = options.maxScanBytes === undefined
      ? 0
      : Math.max(0, stat.size - options.maxScanBytes)
    while (end > minimumOffset) {
      const start = Math.max(minimumOffset, end - chunkSize)
      const chunk = Buffer.allocUnsafe(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let match = data.lastIndexOf(needle)
      while (match >= 0 && match < chunk.length) {
        const line = await readLineContaining(handle, start + match, stat.size)
        if (line.startsWith('{"kind":"event"')) {
          const entry = JSON.parse(line) as LogEntry
          if (entry.kind === 'event' && Number.isSafeInteger(entry.seq) && entry.seq > 0) return entry
        }
        match = data.lastIndexOf(needle, match - 1)
      }
      carry = chunk.subarray(0, Math.min(needle.length - 1, chunk.length))
      end = start
    }
  } finally {
    await handle.close()
  }
  return undefined
}

export async function findSessionOperation(
  path: string,
  operationId: string,
  options: { maxScanBytes?: number } = {},
): Promise<SessionOperationMatch | undefined> {
  const handle = await open(path, 'r')
  const needle = Buffer.from(operationId)
  const chunkSize = 4 * 1024 * 1024
  let carry = Buffer.alloc(0)
  try {
    const stat = await handle.stat()
    let end = stat.size
    const minimumOffset = options.maxScanBytes === undefined
      ? 0
      : Math.max(0, stat.size - options.maxScanBytes)
    while (end > minimumOffset) {
      const start = Math.max(minimumOffset, end - chunkSize)
      const chunk = Buffer.allocUnsafe(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let match = data.lastIndexOf(needle)
      while (match >= 0 && match < chunk.length) {
        const line = await readLineContaining(handle, start + match, stat.size)
        if (line.startsWith('{"kind":"event"') || line.startsWith('{"kind":"runtime_metadata"')) {
          const entry = JSON.parse(line) as LogEntry
          if (
            entry.kind === 'event'
            && Number.isSafeInteger(entry.seq)
            && entry.seq > 0
            && entry.event.kind === 'user_message'
            && entry.event.operationId === operationId
          ) {
            return { kind: 'event', cursor: entry.seq, event: entry.event }
          }
          if (entry.kind === 'runtime_metadata' && entry.payload.operationId === operationId) {
            return {
              kind: 'runtime_metadata',
              action: entry.action,
              ...(typeof entry.payload.text === 'string' ? { text: entry.payload.text } : {}),
              ...(typeof entry.payload.requestFingerprint === 'string' ? { requestFingerprint: entry.payload.requestFingerprint } : {}),
            }
          }
        }
        match = data.lastIndexOf(needle, match - 1)
      }
      carry = chunk.subarray(0, Math.min(needle.length - 1, chunk.length))
      end = start
    }
  } finally {
    await handle.close()
  }
  return undefined
}

/** Check the durable result in the event format owned by the selected Agent Runtime.
 * Scan backwards in bounded chunks instead of materializing a large Session log.
 */
export async function findPersistedToolResult(path: string, callId: string, runtime: AgentRuntimeId): Promise<boolean> {
  if (!callId) return false
  // Copilot commits snapshots to its sidecar. A post-commit receipt appends to
  // the JSONL afterwards, so the sidecar's logSize intentionally trails the log;
  // avoid readLastSessionSnapshot's legacy embedded-snapshot scan on large logs.
  const snapshot = runtime === 'copilot' ? (await readSnapshotSidecar(path))?.snapshot : undefined
  if (runtime === 'copilot' && !snapshot) return false
  // Older Copilot projections have no post-snapshot receipt. They count only
  // while the committed snapshot still contains their actual Tool result.
  const projectedResult = snapshot?.state.messages.some((message) => message.role === 'tool'
    && message.content.some((content) => content.type === 'tool_result' && content.callId === callId)) ?? false
  const handle = await open(path, 'r')
  const needle = Buffer.from(`"callId":${JSON.stringify(callId)}`)
  const chunkSize = 4 * 1024 * 1024
  // Deployment results are written immediately after the originating call.
  // Fail closed rather than repeatedly rereading an entire multi-GiB history.
  const maxScanBytes = 128 * 1024 * 1024
  let carry = Buffer.alloc(0)
  try {
    const size = (await handle.stat()).size
    const minimumOffset = Math.max(0, size - maxScanBytes)
    let end = size
    while (end > minimumOffset) {
      const start = Math.max(minimumOffset, end - chunkSize)
      const chunk = Buffer.allocUnsafe(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk
      let match = data.lastIndexOf(needle)
      while (match >= 0 && match < chunk.length) {
        const line = await readLineContaining(handle, start + match, size, 2 * 1024 * 1024)
        if (line.startsWith('{"kind":"event"') || line.startsWith('{"kind":"runtime_metadata"')) {
          let entry: LogEntry | undefined
          try { entry = JSON.parse(line) as LogEntry } catch { /* A concurrent append can leave an incomplete last line. */ }
          if (runtime === 'kernel' && entry?.kind === 'event') {
            if (entry.event.kind === 'tool_result' && entry.event.callId === callId) return true
            if (entry.event.kind === 'llm_response' && entry.event.message.content.some(
              (content) => content.type === 'tool_call' && content.callId === callId,
            )) return false // An older result cannot satisfy this newer invocation.
          }
          if (runtime === 'copilot' && entry?.kind === 'runtime_metadata') {
            if (entry.action === 'copilot.tool_call' && entry.payload.callId === callId) return false
            if ((entry.action === 'copilot.tool_result_committed' || (entry.action === 'copilot.tool_result' && projectedResult))
              && entry.payload.callId === callId && Number.isSafeInteger(entry.payload.projectionCursor)
              && (entry.payload.projectionCursor as number) <= snapshot!.seq) return true
          }
        }
        match = data.lastIndexOf(needle, match - 1)
      }
      carry = chunk.subarray(0, Math.min(needle.length - 1, chunk.length))
      end = start
    }
    return false
  } finally {
    await handle.close()
  }
}

async function readLineContaining(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  fileSize: number,
  maxLineBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const blockSize = 64 * 1024
  let lineStart = offset
  while (lineStart > 0) {
    const start = Math.max(0, lineStart - blockSize)
    const chunk = Buffer.allocUnsafe(lineStart - start)
    await handle.read(chunk, 0, chunk.length, start)
    const newline = chunk.lastIndexOf(10)
    if (newline >= 0) {
      lineStart = start + newline + 1
      break
    }
    lineStart = start
    if (offset - lineStart > maxLineBytes) return ''
  }

  let lineEnd = offset
  while (lineEnd < fileSize) {
    const length = Math.min(blockSize, fileSize - lineEnd)
    const chunk = Buffer.allocUnsafe(length)
    await handle.read(chunk, 0, length, lineEnd)
    const newline = chunk.indexOf(10)
    if (newline >= 0) {
      lineEnd += newline
      break
    }
    lineEnd += length
    if (lineEnd - lineStart > maxLineBytes) return ''
  }

  // Legacy embedded snapshots and large provider traces may be a single
  // enormous line. They are not valid barrier evidence; never allocate them.
  if (lineEnd - lineStart > maxLineBytes) return ''
  const line = Buffer.allocUnsafe(lineEnd - lineStart)
  await handle.read(line, 0, line.length, lineStart)
  return line.toString('utf8')
}

export async function findLatestRuntimeMetadata(
  path: string,
  action: string,
  options: {
    maxScanBytes?: number
    committedProjection?: { cursor: number; ts: string }
  } = {},
): Promise<RuntimeMetadataEntry | undefined> {
  if (!action) throw new Error('runtime metadata action is required')
  const handle = await open(path, 'r')
  const needle = Buffer.from(`"action":${JSON.stringify(action)}`)
  const chunkSize = 4 * 1024 * 1024
  let carry = Buffer.alloc(0)
  try {
    const stat = await handle.stat()
    let end = stat.size
    const minimumOffset = options.maxScanBytes === undefined
      ? 0
      : Math.max(0, stat.size - options.maxScanBytes)
    while (end > minimumOffset) {
      const start = Math.max(minimumOffset, end - chunkSize)
      const chunk = Buffer.allocUnsafe(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let match = data.lastIndexOf(needle)
      while (match >= 0 && match < chunk.length) {
        const line = await readLineContaining(handle, start + match, stat.size)
        if (line.startsWith('{"kind":"runtime_metadata"')) {
          const entry = JSON.parse(line) as LogEntry
          if (entry.kind === 'runtime_metadata' && entry.action === action) {
            const committed = options.committedProjection
            if (!committed) return entry
            const projectionCursor = entry.payload.projectionCursor
            if (
              (Number.isSafeInteger(projectionCursor) && (projectionCursor as number) <= committed.cursor)
              || (!Number.isSafeInteger(projectionCursor) && entry.ts <= committed.ts)
            ) return entry
          }
        }
        match = data.lastIndexOf(needle, match - 1)
      }
      carry = chunk.subarray(0, Math.min(needle.length - 1, chunk.length))
      end = start
    }
    return undefined
  } finally {
    await handle.close()
  }
}

export async function readRecentSessionMetadata(
  path: string,
  options: { maxScanBytes?: number } = {},
): Promise<MetadataEntry[]> {
  const handle = await open(path, 'r')
  try {
    const file = await handle.stat()
    const maxScanBytes = options.maxScanBytes ?? 64 * 1024 * 1024
    const start = Math.max(0, file.size - maxScanBytes)
    const data = Buffer.allocUnsafe(file.size - start)
    await handle.read(data, 0, data.length, start)
    let text = data.toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      if (firstNewline < 0) return []
      text = text.slice(firstNewline + 1)
    }
    const metadata: MetadataEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"kind":"metadata"')) continue
      const entry = JSON.parse(line) as LogEntry
      if (entry.kind === 'metadata') metadata.push(entry)
    }
    return metadata
  } finally {
    await handle.close()
  }
}

export async function readSessionHistory(path: string, options?: FullSessionReadOptions): Promise<ParsedHistory> {
  await assertFullSessionReadAllowed(path, options, 'readSessionHistory')
  const input = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
  let header: HeaderEntry | undefined
  const events: EventEntry[] = []
  const runtimeMetadata: RuntimeMetadataEntry[] = []
  let canonicalEventSeq = 0
  try {
    for await (const line of rl) {
      if (!header) {
        const entry = JSON.parse(line) as LogEntry
        if (entry.kind !== 'header') throw new Error(`Log ${path} missing header`)
        header = entry
        canonicalEventSeq = entry.initialState.cursor
        continue
      }
      if (line.startsWith('{"kind":"event"')) {
        const entry = JSON.parse(line) as EventEntry
        if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0) continue
        canonicalEventSeq += 1
        events.push(entry.seq === canonicalEventSeq ? entry : { ...entry, seq: canonicalEventSeq })
      } else if (line.startsWith('{"kind":"runtime_metadata"')) {
        runtimeMetadata.push(JSON.parse(line) as RuntimeMetadataEntry)
      }
    }
  } finally {
    rl.close()
    input.destroy()
    if (!input.closed) await once(input, 'close')
  }
  if (!header) throw new Error(`Empty log: ${path}`)
  return { events, runtimeMetadata }
}

export async function readSessionState(path: string, options?: FullSessionReadOptions): Promise<ParsedLog> {
  await assertFullSessionReadAllowed(path, options, 'readSessionState')
  const entries: LogEntry[] = []
  const warnings: string[] = []
  const endsWithNewline = await fileEndsWithNewline(path)
  const input = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
  let lineNo = 0
  let latestSnapshot: { line: string; lineNo: number } | undefined
  try {
    for await (const line of rl) {
      lineNo += 1
      if (line.startsWith('{"kind":"snapshot"')) {
        latestSnapshot = { line, lineNo }
        continue
      }
      try {
        parseLogLine(line, lineNo, entries)
      } catch (error) {
        if (!endsWithNewline && lineNo > 1) {
          warnings.push(`Dropped truncated final line ${lineNo} (${line.length} bytes): ${(error as Error).message}`)
          break
        }
        throw error
      }
    }
  } finally {
    rl.close()
    input.destroy()
    if (!input.closed) await once(input, 'close')
  }
  if (latestSnapshot) parseLogLine(latestSnapshot.line, latestSnapshot.lineNo, entries)
  const parsed = await includeSnapshotSidecar(path, categorizeLogEntries(path, entries, warnings))
  if (parsed.snapshots.length > 1) parsed.snapshots = [latestSnapshotBySeq(parsed.snapshots)!]
  return parsed
}

export async function readLastSessionSnapshot(path: string): Promise<SnapshotEntry | undefined> {
  const sidecar = await readSnapshotSidecar(path)
  const size = (await stat(path)).size
  if (sidecar?.logSize === size) return sidecar.snapshot
  // A sidecar records the log size at its commit. Later metadata need not force
  // a full historical scan: only a newer embedded snapshot in the appended tail
  // could supersede it.
  const embedded = await readLastEmbeddedSessionSnapshot(path, sidecar?.logSize !== undefined && sidecar.logSize <= size ? sidecar.logSize : 0)
  if (!embedded) return sidecar?.snapshot
  if (!sidecar) return embedded
  return sidecar.snapshot.seq >= embedded.seq ? sidecar.snapshot : embedded
}

async function readLastEmbeddedSessionSnapshot(path: string, minimumOffset = 0): Promise<SnapshotEntry | undefined> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    let position = stat.size
    let carry = Buffer.alloc(0)
    while (position > minimumOffset) {
      const length = Math.min(64 * 1024, position - minimumOffset)
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      await handle.read(chunk, 0, length, position)
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let end = data.length
      while (end > 0) {
        const newline = data.lastIndexOf(10, end - 1)
        if (newline < 0) break
        const line = data.subarray(newline + 1, end)
        if (line.length > 0 && line.subarray(0, 20).toString('utf8').startsWith('{"kind":"snapshot"')) {
          return JSON.parse(line.toString('utf8')) as SnapshotEntry
        }
        end = newline
      }
      carry = data.subarray(0, end)
    }
    if (carry.subarray(0, 20).toString('utf8').startsWith('{"kind":"snapshot"')) {
      return JSON.parse(carry.toString('utf8')) as SnapshotEntry
    }
    return undefined
  } finally {
    await handle.close()
  }
}

export async function readSessionLog(path: string, options?: FullSessionReadOptions): Promise<ParsedLog> {
  await assertFullSessionReadAllowed(path, options, 'readSessionLog')
  const entries: LogEntry[] = []
  const warnings: string[] = []
  const endsWithNewline = await fileEndsWithNewline(path)
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let lineNo = 0
  let pendingLine: string | undefined
  let pendingLineNo = 0
  for await (const line of rl) {
    lineNo += 1
    if (pendingLine !== undefined) {
      parseLogLine(pendingLine, pendingLineNo, entries)
      pendingLine = undefined
    }
    try {
      pendingLine = line
      pendingLineNo = lineNo
    } catch (err) {
      throw new Error(
        `Malformed JSON at line ${lineNo}: ${(err as Error).message}`,
      )
    }
  }
  if (pendingLine !== undefined) {
    try {
      parseLogLine(pendingLine, pendingLineNo, entries)
    } catch (err) {
      if (!endsWithNewline) {
        warnings.push(
          `Dropped truncated final line ${pendingLineNo} (${pendingLine.length} bytes): ${(err as Error).message}`,
        )
      } else {
        throw err
      }
    }
  }

  return includeSnapshotSidecar(path, categorizeLogEntries(path, entries, warnings))
}

type ReadSnapshotSidecar = {
  snapshot: SnapshotEntry
  logSize?: number
}

async function readSnapshotSidecar(logPath: string): Promise<ReadSnapshotSidecar | undefined> {
  try {
    const raw = JSON.parse(await readFile(snapshotSidecarPath(logPath), 'utf8')) as SnapshotEntry & { logSize?: unknown }
    if (raw.kind !== 'snapshot' || !Number.isSafeInteger(raw.seq) || raw.seq < 0) {
      throw new Error(`Invalid snapshot sidecar for ${logPath}`)
    }
    const { logSize, ...snapshot } = raw
    return {
      snapshot,
      ...(typeof logSize === 'number' && Number.isSafeInteger(logSize) && logSize >= 0 ? { logSize } : {}),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function includeSnapshotSidecar(logPath: string, parsed: ParsedLog): Promise<ParsedLog> {
  const sidecar = await readSnapshotSidecar(logPath)
  if (!sidecar) return parsed
  const snapshots = parsed.snapshots.filter((snapshot) => snapshot.seq !== sidecar.snapshot.seq)
  snapshots.push(sidecar.snapshot)
  snapshots.sort((left, right) => left.seq - right.seq)
  return { ...parsed, snapshots }
}

function latestSnapshotBySeq(snapshots: readonly SnapshotEntry[]): SnapshotEntry | undefined {
  return snapshots.reduce<SnapshotEntry | undefined>((latest, snapshot) =>
    !latest || snapshot.seq >= latest.seq ? snapshot : latest, undefined)
}

function categorizeLogEntries(path: string, entries: LogEntry[], warnings: string[]): ParsedLog {
  if (entries.length === 0) throw new Error(`Empty log: ${path}`)
  const header = entries[0]
  if (!header || header.kind !== 'header')
    throw new Error(`Log ${path} missing header`)

  const events: EventEntry[] = []
  let lastRawEventSeq = header.initialState.cursor
  let canonicalEventSeq = header.initialState.cursor
  const snapshots: SnapshotEntry[] = []
  const metadata: MetadataEntry[] = []
  const runtimeMetadata: RuntimeMetadataEntry[] = []
  for (const e of entries.slice(1)) {
    if (e.kind === 'event') {
      if (!Number.isSafeInteger(e.seq) || e.seq <= 0) {
        warnings.push(`Dropped event with invalid sequence ${String(e.seq)}`)
        continue
      }
      canonicalEventSeq += 1
      if (e.seq !== lastRawEventSeq + 1) {
        // A historical graceful-restart bug could start the replacement Host
        // before the previous process had fully stopped. The replacement loaded
        // an older cursor and then durably appended valid transitions with reused
        // sequence numbers. Dropping those entries loses real user messages on
        // every reload. JSONL append order is the final authority: preserve every
        // valid event and repair only its in-memory cursor for fold/history.
        warnings.push(`Repaired event sequence ${e.seq} to ${canonicalEventSeq} after ${lastRawEventSeq}`)
      }
      lastRawEventSeq = e.seq
      events.push(e.seq === canonicalEventSeq ? e : { ...e, seq: canonicalEventSeq })
    }
    else if (e.kind === 'snapshot') snapshots.push(e)
    else if (e.kind === 'metadata') metadata.push(e)
    else if (e.kind === 'runtime_metadata') runtimeMetadata.push(e)
  }
  return { header, events, snapshots, metadata, runtimeMetadata, warnings }
}

function parseLogLine(line: string, lineNo: number, entries: LogEntry[]): void {
  if (line.trim().length === 0) return
  try {
    entries.push(JSON.parse(line) as LogEntry)
  } catch (err) {
    throw new Error(`Malformed JSON at line ${lineNo}: ${(err as Error).message}`)
  }
}

async function fileEndsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size === 0) return true
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, stat.size - 1)
    return buf[0] === 10
  } finally {
    await handle.close()
  }
}
