/**
 * RL rollout exports: token-segment indices, rollout sidecars, and per-framework
 * adapter files (slime / verl). All artifacts index the ledger and referenced
 * files rather than fabricating tensors — see docs/capabilities/04.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Message } from '@agent-kernel/kernel'
import { estimateStringTokens } from '@agent-kernel/shared/token-estimation'
import {
  createArtifactStore,
  createRolloutSidecar,
  type ArtifactRef,
  type RolloutSidecar,
} from '@agent-kernel/shared/enhancement'

import { exportSessionTraceArtifacts, type ExportSessionTraceInput } from './session-export.js'
import { readSessionLog } from './store/log.js'

export type RolloutSegment = {
  segmentId: string
  source: 'system' | 'user' | 'assistant' | 'tool' | 'effect' | 'compaction'
  eventSeq?: number
  role?: Message['role']
  lossMask: 0 | 1
  estimatedTokens: number
  tokenIdsCaptured: false
  summary: string
}

export type RolloutSegmentsArtifact = {
  schemaVersion: 1
  sessionId: string
  tokenIdsCaptured: false
  lossMaskPolicy: string
  topology: RolloutTopology
  segments: readonly RolloutSegment[]
  warnings: readonly string[]
}

export type RolloutTopology = {
  parentSessionId?: string
  parentCursor?: number
  eventCount: number
  llmResponseCount: number
  toolCallCount: number
  toolResultCount: number
  compactionCount: number
  subAgentCallCount: number
  subAgentResultCount: number
  compactions: readonly RolloutCompactionSummary[]
  subAgents: readonly RolloutSubAgentSummary[]
  warnings: readonly string[]
}

export type RolloutCompactionSummary = {
  eventSeq: number
  replaceRange: { start: number; end: number }
  replacementMessageCount: number
}

export type RolloutSubAgentSummary = {
  parentCallId: string
  eventSeq?: number
  requestedAgentType?: string
  childSessionId?: string
  status?: 'completed' | 'failed' | 'cancelled'
  turns?: number
  durationMs?: number
}

export type ExportRolloutAdapterInput = {
  rootDir: string
  sidecarPath: string
  frameworkTarget?: RolloutSidecar['framework_target']
}

export type RolloutAdapterExport =
  | {
      schemaVersion: 1
      status: 'ready'
      frameworkTarget: 'slime'
      rolloutId: string
      taskId: string
      eventLogRef: string
      traceRef?: string
      tokenSegmentsRef?: string
      rewardRef?: string
      model?: string
      weightVersion?: string
      entrypoint: 'custom_rollout_manifest'
      notes: readonly string[]
    }
  | {
      schemaVersion: 1
      status: 'ready'
      frameworkTarget: 'verl'
      rolloutId: string
      prompt_ids: readonly number[]
      response_ids: readonly number[]
      response_mask: readonly number[]
      metadata: Record<string, unknown>
    }
  | {
      schemaVersion: 1
      status: 'blocked'
      frameworkTarget: RolloutSidecar['framework_target']
      rolloutId: string
      reason: string
      requiredArtifacts: readonly string[]
      availableArtifacts: Record<string, unknown>
    }

export async function exportRolloutSegments(input: ExportSessionTraceInput): Promise<{
  artifact: ArtifactRef
  segments: RolloutSegmentsArtifact
  sessionId: string
}> {
  const parsed = await readSessionLog(input.sessionLogPath, { allowExternalRuntime: true })
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const segments = createRolloutSegmentsArtifact(parsed.header, parsed.header.initialState.messages, parsed.events)
  const artifact = await store.writeJson(
    'rl_token_segments',
    `rl-token-segments/${parsed.header.sessionId}.json`,
    segments,
  )
  return { artifact, segments, sessionId: parsed.header.sessionId }
}

export type ExportRolloutSidecarInput = ExportSessionTraceInput & {
  taskId: string
  frameworkTarget: RolloutSidecar['framework_target']
  model?: string
  weightVersion?: string
  rewardPath?: string
  tokenSegmentsPath?: string
  metadata?: Record<string, unknown>
}

export async function exportRolloutSidecar(
input: ExportRolloutSidecarInput,
): Promise<{ sidecar: RolloutSidecar; sidecarPath: string; traceArtifact: ArtifactRef }> {
  const trace = await exportSessionTraceArtifacts(input)
  const generatedSegments = input.tokenSegmentsPath ? undefined : await exportRolloutSegments(input)
  const sidecar = createRolloutSidecar({
    sessionId: trace.sessionId,
    taskId: input.taskId,
    frameworkTarget: input.frameworkTarget,
    eventLogRef: input.sessionLogPath,
    traceRef: trace.traceArtifact.uri,
    ...((input.tokenSegmentsPath ?? generatedSegments?.artifact.uri)
      ? { tokenSegmentsRef: input.tokenSegmentsPath ?? generatedSegments?.artifact.uri }
      : {}),
    ...(input.rewardPath ? { rewardRef: input.rewardPath } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.weightVersion ? { weightVersion: input.weightVersion } : {}),
    metadata: {
      sessionLogFile: basename(input.sessionLogPath),
      llmArtifactCount: trace.llmArtifacts.length,
      tokenIdsCaptured: input.tokenSegmentsPath ? 'external' : false,
      generatedSegmentCount: generatedSegments?.segments.segments.length ?? null,
      compactionCount: generatedSegments?.segments.topology.compactionCount ?? null,
      subAgentCallCount: generatedSegments?.segments.topology.subAgentCallCount ?? null,
      ...(generatedSegments?.segments.topology.parentSessionId
        ? { parentSessionId: generatedSegments.segments.topology.parentSessionId }
        : {}),
      ...(generatedSegments?.segments.topology.parentCursor !== undefined
        ? { parentCursor: generatedSegments.segments.topology.parentCursor }
        : {}),
      ...(input.metadata ?? {}),
    },
  })
  const sidecarPath = join(input.rootDir, 'rollouts', `${sidecar.rollout_id}.json`)
  await mkdir(join(input.rootDir, 'rollouts'), { recursive: true })
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
  return { sidecar, sidecarPath, traceArtifact: trace.traceArtifact }
}

export async function exportRolloutFrameworkAdapter(input: ExportRolloutAdapterInput): Promise<{
  adapter: RolloutAdapterExport
  adapterPath: string
}> {
  const sidecar = JSON.parse(await readFile(input.sidecarPath, 'utf8')) as RolloutSidecar
  const frameworkTarget = input.frameworkTarget ?? sidecar.framework_target
  const adapter = await createRolloutAdapterExport(input.rootDir, sidecar, frameworkTarget)
  const adapterPath = join(input.rootDir, 'rl-adapters', frameworkTarget, `${sidecar.rollout_id}.json`)
  await mkdir(join(input.rootDir, 'rl-adapters', frameworkTarget), { recursive: true })
  await writeFile(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf8')
  return { adapter, adapterPath }
}

async function createRolloutAdapterExport(
  rootDir: string,
  sidecar: RolloutSidecar,
  frameworkTarget: RolloutSidecar['framework_target'],
): Promise<RolloutAdapterExport> {
  if (frameworkTarget === 'slime') {
    return {
      schemaVersion: 1,
      status: 'ready',
      frameworkTarget,
      rolloutId: sidecar.rollout_id,
      taskId: sidecar.task_id,
      eventLogRef: sidecar.event_log_ref,
      ...(sidecar.trace_ref ? { traceRef: sidecar.trace_ref } : {}),
      ...(sidecar.token_segments_ref ? { tokenSegmentsRef: sidecar.token_segments_ref } : {}),
      ...(sidecar.reward_ref ? { rewardRef: sidecar.reward_ref } : {}),
      ...(sidecar.model ? { model: sidecar.model } : {}),
      ...(sidecar.weight_version ? { weightVersion: sidecar.weight_version } : {}),
      entrypoint: 'custom_rollout_manifest',
      notes: [
        'Use this as slime custom data-generation input; it indexes replay, trace, token segments, and reward artifacts.',
        'It is not a tensor dataset and does not synthesize token ids.',
      ],
    }
  }
  if (frameworkTarget === 'verl') {
    const tokenArtifact = sidecar.token_segments_ref ? await readTokenArtifact(rootDir, sidecar.token_segments_ref) : undefined
    const promptIds = numberArray(tokenArtifact, 'prompt_ids') ?? numberArray(tokenArtifact, 'promptIds')
    const responseIds = numberArray(tokenArtifact, 'response_ids') ?? numberArray(tokenArtifact, 'responseIds')
    const responseMask = numberArray(tokenArtifact, 'response_mask') ?? numberArray(tokenArtifact, 'responseMask')
    if (tokenArtifact && tokenArtifact.tokenIdsCaptured === true && promptIds && responseIds && responseMask) {
      return {
        schemaVersion: 1,
        status: 'ready',
        frameworkTarget,
        rolloutId: sidecar.rollout_id,
        prompt_ids: promptIds,
        response_ids: responseIds,
        response_mask: responseMask,
        metadata: {
          taskId: sidecar.task_id,
          sessionId: sidecar.session_id,
          eventLogRef: sidecar.event_log_ref,
          traceRef: sidecar.trace_ref ?? null,
          rewardRef: sidecar.reward_ref ?? null,
          model: sidecar.model ?? null,
          weightVersion: sidecar.weight_version ?? null,
        },
      }
    }
    return blockedAdapter(sidecar, frameworkTarget, 'verl AgentLoopOutput requires generation-time token ids and response masks', tokenArtifact)
  }
  return blockedAdapter(sidecar, frameworkTarget, `adapter target ${frameworkTarget} is not implemented`, undefined)
}

async function readTokenArtifact(rootDir: string, ref: string): Promise<Record<string, unknown> | undefined> {
  const path = ref.startsWith('/') ? ref : join(rootDir, ref)
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

function numberArray(record: Record<string, unknown> | undefined, key: string): readonly number[] | undefined {
  const value = record?.[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isInteger(item))) return undefined
  return value
}

function blockedAdapter(
  sidecar: RolloutSidecar,
  frameworkTarget: RolloutSidecar['framework_target'],
  reason: string,
  tokenArtifact: Record<string, unknown> | undefined,
): RolloutAdapterExport {
  return {
    schemaVersion: 1,
    status: 'blocked',
    frameworkTarget,
    rolloutId: sidecar.rollout_id,
    reason,
    requiredArtifacts: ['generation-time token ids', 'response mask', 'reward metadata'],
    availableArtifacts: {
      eventLogRef: sidecar.event_log_ref,
      traceRef: sidecar.trace_ref ?? null,
      tokenSegmentsRef: sidecar.token_segments_ref ?? null,
      tokenIdsCaptured: tokenArtifact?.tokenIdsCaptured ?? sidecar.metadata.tokenIdsCaptured ?? null,
      rewardRef: sidecar.reward_ref ?? null,
    },
  }
}

export function createRolloutSegmentsArtifact(
  header: Awaited<ReturnType<typeof readSessionLog>>['header'],
  initialMessages: readonly Message[],
  events: Awaited<ReturnType<typeof readSessionLog>>['events'],
): RolloutSegmentsArtifact {
  const segments: RolloutSegment[] = []
  let index = 0
  const pushMessage = (message: Message, eventSeq: number | undefined, sourceOverride?: RolloutSegment['source']): void => {
    const source = sourceOverride ?? message.role
    const summary = summarizeMessage(message)
    segments.push({
      segmentId: `seg_${String(++index).padStart(5, '0')}`,
      source,
      ...(eventSeq !== undefined ? { eventSeq } : {}),
      role: message.role,
      lossMask: source === 'assistant' ? 1 : 0,
      estimatedTokens: estimateTokens(summary),
      tokenIdsCaptured: false,
      summary,
    })
  }
  for (const message of initialMessages) pushMessage(message, undefined)
  for (const entry of events) {
    if (entry.event.kind === 'user_message') {
      pushMessage({ role: 'user', content: [...(entry.event.content ?? [{ type: 'text', text: entry.event.text ?? '' }])] }, entry.seq)
    } else if (entry.event.kind === 'llm_response') {
      pushMessage(entry.event.message, entry.seq)
    } else if (entry.event.kind === 'tool_result') {
      const summary = String(entry.event.content ?? '').slice(0, 240)
      segments.push({
        segmentId: `seg_${String(++index).padStart(5, '0')}`,
        source: 'tool',
        eventSeq: entry.seq,
        lossMask: 0,
        estimatedTokens: estimateTokens(summary),
        tokenIdsCaptured: false,
        summary: `${entry.event.ok ? 'ok' : 'error'} tool_result ${entry.event.callId}: ${summary}`,
      })
    } else if (entry.event.kind === 'messages_replaced' && entry.event.reason === 'compaction') {
      const summary = `compaction replaced messages ${entry.event.replaceRange.start}..${entry.event.replaceRange.end} with ${entry.event.replacementMessages.length} message(s)`
      segments.push({
        segmentId: `seg_${String(++index).padStart(5, '0')}`,
        source: 'compaction',
        eventSeq: entry.seq,
        lossMask: 0,
        estimatedTokens: estimateTokens(summary),
        tokenIdsCaptured: false,
        summary,
      })
    }
    for (const effect of entry.effects) {
      if (effect.kind !== 'call_tool') continue
      const summary = `call_tool ${effect.name} ${JSON.stringify(effect.input).slice(0, 200)}`
      segments.push({
        segmentId: `seg_${String(++index).padStart(5, '0')}`,
        source: 'effect',
        eventSeq: entry.seq,
        lossMask: 0,
        estimatedTokens: estimateTokens(summary),
        tokenIdsCaptured: false,
        summary,
      })
    }
  }
  const topology = buildRolloutTopology(header, events)
  return {
    schemaVersion: 1,
    sessionId: header.sessionId,
    tokenIdsCaptured: false,
    lossMaskPolicy: 'assistant message segments use lossMask=1; system/user/tool/effect/compaction segments use lossMask=0; token ids are not synthesized.',
    topology,
    segments,
    warnings: [
      'token ids were not captured at generation time; this artifact is a segment index, not a training tensor dataset',
      ...topology.warnings,
    ],
  }
}

function buildRolloutTopology(
  header: Awaited<ReturnType<typeof readSessionLog>>['header'],
  events: Awaited<ReturnType<typeof readSessionLog>>['events'],
): RolloutTopology {
  const compactions: RolloutCompactionSummary[] = []
  const subAgents = new Map<string, RolloutSubAgentSummary>()
  const seenToolCalls = new Set<string>()
  let llmResponseCount = 0
  let toolCallCount = 0
  let toolResultCount = 0

  const noteSubAgentRequest = (callId: string, eventSeq: number, requestedAgentType: string | undefined): void => {
    const prior = subAgents.get(callId)
    subAgents.set(callId, {
      parentCallId: callId,
      eventSeq,
      ...(requestedAgentType ? { requestedAgentType } : {}),
      ...(prior?.childSessionId ? { childSessionId: prior.childSessionId } : {}),
      ...(prior?.status ? { status: prior.status } : {}),
      ...(prior?.turns !== undefined ? { turns: prior.turns } : {}),
      ...(prior?.durationMs !== undefined ? { durationMs: prior.durationMs } : {}),
    })
  }

  for (const entry of events) {
    if (entry.event.kind === 'llm_response') {
      llmResponseCount++
      for (const content of entry.event.message.content) {
        if (content.type !== 'tool_call') continue
        if (!seenToolCalls.has(content.callId)) {
          seenToolCalls.add(content.callId)
          toolCallCount++
        }
        if (content.name === 'agent') noteSubAgentRequest(content.callId, entry.seq, stringValue(content.input.agent_type))
      }
    } else if (entry.event.kind === 'tool_result') {
      toolResultCount++
      const parsed = parseSubAgentEnvelope(entry.event.content)
      if (parsed) {
        const prior = subAgents.get(entry.event.callId)
        subAgents.set(entry.event.callId, {
          parentCallId: entry.event.callId,
          ...(prior?.eventSeq !== undefined ? { eventSeq: prior.eventSeq } : { eventSeq: entry.seq }),
          ...(prior?.requestedAgentType ? { requestedAgentType: prior.requestedAgentType } : parsed.agentType ? { requestedAgentType: parsed.agentType } : {}),
          childSessionId: parsed.sessionId,
          status: parsed.status,
          turns: parsed.turns,
          durationMs: parsed.durationMs,
        })
      }
    } else if (entry.event.kind === 'messages_replaced' && entry.event.reason === 'compaction') {
      compactions.push({
        eventSeq: entry.seq,
        replaceRange: entry.event.replaceRange,
        replacementMessageCount: entry.event.replacementMessages.length,
      })
    }

    for (const effect of entry.effects) {
      if (effect.kind !== 'call_tool') continue
      if (!seenToolCalls.has(effect.callId)) {
        seenToolCalls.add(effect.callId)
        toolCallCount++
      }
      if (effect.name === 'agent') noteSubAgentRequest(effect.callId, entry.seq, stringValue(effect.input.agent_type))
    }
  }

  const subAgentRows = [...subAgents.values()].sort((a, b) => (a.eventSeq ?? Number.MAX_SAFE_INTEGER) - (b.eventSeq ?? Number.MAX_SAFE_INTEGER))
  const warnings: string[] = []
  if (compactions.length > 0) warnings.push('rollout contains compaction; summary tokens remain loss-masked and should be handled explicitly by trainer adapters')
  if (subAgentRows.some((row) => !row.childSessionId)) warnings.push('one or more agent tool calls did not produce a parseable sub-agent result envelope')

  return {
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.parentCursor !== undefined ? { parentCursor: header.parentCursor } : {}),
    eventCount: events.length,
    llmResponseCount,
    toolCallCount,
    toolResultCount,
    compactionCount: compactions.length,
    subAgentCallCount: subAgentRows.length,
    subAgentResultCount: subAgentRows.filter((row) => row.childSessionId).length,
    compactions,
    subAgents: subAgentRows,
    warnings,
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseSubAgentEnvelope(content: string): {
  sessionId: string
  agentType?: string
  status: 'completed' | 'failed' | 'cancelled'
  turns: number
  durationMs: number
} | null {
  if (!content.includes('<sub_agent')) return null
  const openTag = content.match(/<sub_agent\b([\s\S]*?)>/)
  if (!openTag) return null
  const attrs = openTag[1] ?? ''
  const sessionId = readXmlAttr(attrs, 'session_id')
  const status = readXmlAttr(attrs, 'status')
  const agentType = readXmlAttr(attrs, 'agent_type')
  const turns = Number(readXmlAttr(attrs, 'turns'))
  const durationMs = Number(readXmlAttr(attrs, 'duration_ms'))
  if (!sessionId || !isSubAgentStatus(status) || !isNonNegativeInteger(turns) || !isNonNegativeInteger(durationMs)) return null
  return {
    sessionId,
    ...(agentType ? { agentType } : {}),
    status,
    turns,
    durationMs,
  }
}

function readXmlAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`))
  return match ? unescapeAttr(match[1]!) : undefined
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function isSubAgentStatus(value: string | undefined): value is 'completed' | 'failed' | 'cancelled' {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

function summarizeMessage(message: Message): string {
  return `${message.role}: ${message.content.map((content) => {
    if (content.type === 'text') return content.text
    if (content.type === 'tool_call') return `tool_call ${content.name} ${JSON.stringify(content.input)}`
    if (content.type === 'tool_result') return `tool_result ${content.callId} ${content.content}`
    return content.type
  }).join(' ')}`.slice(0, 500)
}

function estimateTokens(text: string): number {
  return estimateStringTokens(text)
}
