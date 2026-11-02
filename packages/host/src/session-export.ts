/**
 * Export OpenInference trace + LLM request/response artifacts for a session.
 * Consumes a persisted JSONL log and writes deterministic, redacted JSON files
 * into the artifact store.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath, sep } from 'node:path'

import {
  createArtifactStore,
  exportSessionSpans,
  type ArtifactRef,
  type ArtifactStore,
} from '@agent-kernel/shared/enhancement'

import { readSessionLog } from './store/log.js'
import type { EventEntry, HeaderEntry, LLMTrace } from '@agent-kernel/shared'

export type ExportSessionTraceInput = {
  rootDir: string
  sessionLogPath: string
  runId?: string
  evalInstanceId?: string
  workspaceRoot?: string
}

export type ExportSessionTraceResult = {
  traceArtifact: ArtifactRef
  llmArtifacts: readonly ArtifactRef[]
  sessionId: string
}

export async function exportSessionTraceArtifacts(
  input: ExportSessionTraceInput,
): Promise<ExportSessionTraceResult> {
  const parsed = await readSessionLog(input.sessionLogPath, { allowExternalRuntime: true })
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  return writeSessionTraceArtifacts({
    ...parsed,
    store,
    runId: input.runId,
    evalInstanceId: input.evalInstanceId,
    loadTrace: (entry) => loadEntryTrace(input.sessionLogPath, entry),
  })
}

export async function writeSessionTraceArtifacts(input: {
  header: HeaderEntry
  events: readonly EventEntry[]
  store: Pick<ArtifactStore, 'writeJson'>
  runId?: string
  evalInstanceId?: string
  loadTrace?: (entry: EventEntry) => Promise<LLMTrace | undefined>
}): Promise<ExportSessionTraceResult> {
  const { header, events, store } = input
  const traces: Array<{ seq: number; trace: LLMTrace }> = []
  for (const entry of events) {
    if (entry.llmTraceArtifact && !input.loadTrace) throw new Error('Session trace references require an authoritative artifact resolver')
    const trace = input.loadTrace ? await input.loadTrace(entry) : entry.llmTrace
    if (trace) traces.push({ seq: entry.seq, trace })
  }
  const spans = exportSessionSpans(input)
  const sessionId = header.sessionId
  const traceArtifact = await store.writeJson(
    'trace',
    `traces/${sessionId}.openinference.json`,
    { spans },
  )
  const llmArtifacts: ArtifactRef[] = []
  for (const { seq, trace } of traces) {
    llmArtifacts.push(await store.writeJson(
      'llm_request',
      `llm/${sessionId}/${seq}.request.json`,
      trace.request,
    ))
    if (trace.response) {
      llmArtifacts.push(await store.writeJson(
        'llm_response',
        `llm/${sessionId}/${seq}.response.json`,
        trace.response,
      ))
    }
  }
  return { traceArtifact, llmArtifacts, sessionId }
}

async function loadEntryTrace(
  logPath: string,
  entry: Awaited<ReturnType<typeof readSessionLog>>['events'][number],
): Promise<LLMTrace | undefined> {
  if (entry.llmTraceArtifact) {
    const base = dirname(logPath)
    const resolved = resolvePath(base, entry.llmTraceArtifact.path)
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new Error('trace artifact path escapes session directory')
    }
    return JSON.parse(await readFile(resolved, 'utf8')) as LLMTrace
  }
  return entry.llmTrace
}
