/**
 * Memory consolidation. Single-step: one LLM call reads the session's
 * messages, emits up to N durable-signal candidates as JSON, and each
 * candidate is written to workspace memory through the existing
 * `memory` tool path (via the executor). No staging directory, no
 * auto-fire — only invoked from the `/consolidate-memory` slash command.
 *
 * Pattern reference: `references/claude-code-collection/memory/consolidator.py`.
 * Design: `docs/host/memory-consolidation.md`.
 */

import { ulid } from 'ulid'

import type { CallToolEffect, Message } from '@agent-kernel/kernel'

import type { HostLoopDeps } from '../loop-types.js'
import { runSkillManagerTool, validateSkillContent } from './skill-manager.js'

export type ConsolidationConfig = {
  enabled: boolean
  minMessages: number
  maxPerRun: number
  maxSkillsPerRun?: number
  defaultConfidence: number
  windowSize: number
  perMessageCharCap: number
  timeoutMs: number
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  enabled: true,
  minMessages: 8,
  maxPerRun: 3,
  maxSkillsPerRun: 2,
  defaultConfidence: 0.8,
  windowSize: 40,
  perMessageCharCap: 600,
  timeoutMs: 60_000,
}

export type ConsolidationOutcome = {
  saved: string[]
  savedSkills?: string[]
  skipped: number
  reason?: string
  error?: string
}

export type LearningNudgeMetrics = {
  toolCallsInTurn: number
  failedToolCallsInTurn: number
  recoveredFromFailure: boolean
  turnsSinceLastNudge: number
  alreadySavedInTurn: boolean
  nudgedInTurn: boolean
}

export type LearningNudgeDecision =
  | {
      shouldNudge: true
      reason: 'complex_turn_tool_budget' | 'error_recovery_sequence' | 'periodic_turn_cadence'
      instruction: string
    }
  | {
      shouldNudge: false
    }

const DEFAULT_COMPLEX_TURN_TOOL_CALLS = 8
const DEFAULT_RECOVERED_FAILURES_THRESHOLD = 2
const DEFAULT_PERIODIC_TURN_CADENCE = 10

export const LEARNING_NUDGE_INSTRUCTION = [
  '[Self-Learning Reminder]',
  'This session has completed a non-trivial sequence of tool executions or error recoveries.',
  '- If you learned a reusable procedure, consider `skill_manager` for a workspace skill.',
  '- If you learned a durable user preference or non-obvious project constraint, call `memory` (operation="write", scope="workspace").',
  '- If nothing new or reusable was learned, proceed normally without calling either tool.',
].join('\n')

const READ_ONLY_LEARNING_NUDGE_INSTRUCTION = [
  '[Self-Learning Reminder]',
  'Consider what reusable knowledge this turn revealed.',
  'This workspace cannot safely persist learned skills or consolidated memories from this reminder.',
  'Do not call `skill_manager` or `memory` to persist learning from this reminder; proceed normally.',
].join('\n')

export function evaluateLearningNudge(
  metrics: LearningNudgeMetrics,
  thresholds: {
    complexTurnToolCalls?: number
    recoveredFailures?: number
    periodicTurnCadence?: number
  } = {},
): LearningNudgeDecision {
  if (metrics.alreadySavedInTurn || metrics.nudgedInTurn) {
    return { shouldNudge: false }
  }
  const complexCap = thresholds.complexTurnToolCalls ?? DEFAULT_COMPLEX_TURN_TOOL_CALLS
  const failureCap = thresholds.recoveredFailures ?? DEFAULT_RECOVERED_FAILURES_THRESHOLD
  const turnCap = thresholds.periodicTurnCadence ?? DEFAULT_PERIODIC_TURN_CADENCE

  if (metrics.recoveredFromFailure && metrics.failedToolCallsInTurn >= failureCap) {
    return {
      shouldNudge: true,
      reason: 'error_recovery_sequence',
      instruction: LEARNING_NUDGE_INSTRUCTION,
    }
  }
  if (metrics.toolCallsInTurn >= complexCap) {
    return {
      shouldNudge: true,
      reason: 'complex_turn_tool_budget',
      instruction: LEARNING_NUDGE_INSTRUCTION,
    }
  }
  if (metrics.turnsSinceLastNudge >= turnCap && metrics.toolCallsInTurn > 0) {
    return {
      shouldNudge: true,
      reason: 'periodic_turn_cadence',
      instruction: LEARNING_NUDGE_INSTRUCTION,
    }
  }
  return { shouldNudge: false }
}

const sessionLearningMetrics = new Map<string, LearningNudgeMetrics>()

export function getOrCreateLearningMetrics(sessionId: string): LearningNudgeMetrics {
  let current = sessionLearningMetrics.get(sessionId)
  if (!current) {
    current = {
      toolCallsInTurn: 0,
      failedToolCallsInTurn: 0,
      recoveredFromFailure: false,
      turnsSinceLastNudge: 0,
      alreadySavedInTurn: false,
      nudgedInTurn: false,
    }
    sessionLearningMetrics.set(sessionId, current)
  }
  return current
}

export function recordToolDispatchForLearning(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  ok: boolean,
): void {
  const m = getOrCreateLearningMetrics(sessionId)
  m.toolCallsInTurn += 1
  if (ok && (
    toolName === 'skill_manager' ||
    (toolName === 'memory' && input.operation === 'write')
  )) {
    m.alreadySavedInTurn = true
    m.turnsSinceLastNudge = 0
    return
  }
  if (!ok) {
    m.failedToolCallsInTurn += 1
  } else if (m.failedToolCallsInTurn > 0) {
    m.recoveredFromFailure = true
  }
}

export function injectLearningNudgeIfEligible(
  sessionId: string,
  messages: readonly Message[],
  workspaceWritesAvailable = true,
): readonly Message[] {
  const m = getOrCreateLearningMetrics(sessionId)
  const decision = evaluateLearningNudge(m)
  if (!decision.shouldNudge) return messages
  m.nudgedInTurn = true
  m.turnsSinceLastNudge = 0
  return [
    ...messages,
    {
      role: 'system',
      content: [{ type: 'text', text: workspaceWritesAvailable
        ? decision.instruction : READ_ONLY_LEARNING_NUDGE_INSTRUCTION }],
    },
  ]
}

export function advanceTurnLearningMetrics(sessionId: string): void {
  const m = getOrCreateLearningMetrics(sessionId)
  if (!m.nudgedInTurn && !m.alreadySavedInTurn) {
    m.turnsSinceLastNudge += 1
  }
  m.toolCallsInTurn = 0
  m.failedToolCallsInTurn = 0
  m.recoveredFromFailure = false
  m.alreadySavedInTurn = false
  m.nudgedInTurn = false
}

export function resetLearningMetrics(sessionId?: string): void {
  if (sessionId) sessionLearningMetrics.delete(sessionId)
  else sessionLearningMetrics.clear()
}

const CONSOLIDATOR_SYSTEM_PROMPT = [
  'You are a memory consolidation assistant. Analyze the conversation below and',
  'extract insights worth storing as persistent memories or reusable procedural skills for future sessions.',
  '',
  'Focus ONLY on:',
  '1. New user preferences or working-style corrections revealed in this session',
  '2. Project decisions or facts made explicit (NOT derivable from code/git)',
  '3. Behavioral feedback given to the AI (what to do or avoid, and why)',
  '',
  'Return a JSON object with key "memories" containing a list of objects, each with:',
  '  "name":        short kebab-case slug, matches /^[a-z0-9-]{1,64}$/,',
  '                 e.g. "user-prefers-concise-responses"',
  '  "type":        "user" | "feedback" | "project" | "reference"',
  '  "description": one-line description (used for search relevance)',
  '  "content":     memory body; for feedback/project lead with the rule/fact then',
  '                 **Why:** and **How to apply:** lines',
  '  "confidence":  float 0.0–1.0 (use ~0.8 for inferred, ~0.9 for clearly stated)',
  '',
  'Also return a "skills" array of at most 2 reusable multi-step procedures discovered in this session.',
  'Each skill has "name" (kebab-case), "description" (one-line trigger), "body" (Markdown steps), and "confidence" (0.0–1.0).',
  'Only include genuinely reusable workflows; never include secrets, prompt overrides, or ephemeral task state.',
  'Return {"memories": [], "skills": []} if nothing new or worth saving.',
  '',
  'Do NOT extract:',
  '- Code patterns, architecture, file paths — derivable from the codebase',
  '- Git history or debugging fixes — already in commits',
  '- Anything already obvious from CLAUDE.md',
  '- Ephemeral task state or tool results',
  '',
  'Keep to AT MOST 3 memories. Quality over quantity.',
  'Reply with ONLY the JSON object. No prose, no markdown fences.',
].join('\n')

type ValidEntry = {
  name: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string
  content: string
  confidence: number
}

type ValidSkillEntry = {
  name: string
  description: string
  content: string
  confidence: number
}

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference'])
const NAME_PATTERN = /^[a-z0-9-]{1,64}$/

export async function consolidateMemory(
  deps: HostLoopDeps,
  sessionId: string,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
): Promise<ConsolidationOutcome> {
  if (!config.enabled) {
    return { saved: [], skipped: 0, reason: 'consolidation disabled in config' }
  }

  const record = deps.store.get(sessionId)
  if (!record) return { saved: [], skipped: 0, error: `unknown session: ${sessionId}` }
  // An owner callback alone cannot protect the Executor's final write.
  if (deps.assertSessionEffectOwner && (!deps.requireMemoryEffectBarrier || !record.workspaceId)) {
    return {
      saved: [],
      skipped: 0,
      error: 'shared-owner workspace consolidation is unavailable until owner final-effect fencing is implemented',
    }
  }
  if (record.workspaceId && !record.state.cwd) {
    return { saved: [], skipped: 0, error: 'Executor-bound workspace consolidation requires a session cwd' }
  }
  const owner = deps.captureSessionEffectOwner?.(sessionId)
  const assertOwner = async () => {
    if (owner && !owner()) throw new Error('session ownership changed during consolidation')
    await deps.assertSessionEffectOwner?.(sessionId)
    if (owner && !owner()) throw new Error('session ownership changed during consolidation')
  }
  try {
    await assertOwner()
  } catch (error) {
    return { saved: [], skipped: 0, error: error instanceof Error ? error.message : String(error) }
  }

  const status = record.state.status
  if (status !== 'idle' && status !== 'done' && status !== 'error') {
    return { saved: [], skipped: 0, error: 'session is running; wait for it to finish' }
  }

  const messages = record.state.messages
  if (messages.length < config.minMessages) {
    return {
      saved: [],
      skipped: 0,
      reason: `session too short (${messages.length} < ${config.minMessages} messages)`,
    }
  }

  const transcript = buildTranscript(messages, config.windowSize, config.perMessageCharCap)
  if (transcript.length === 0) {
    return { saved: [], skipped: 0, reason: 'no user/assistant content to consolidate' }
  }

  const raw = await callConsolidatorLlm(deps, sessionId, transcript, config).catch(
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  )
  if (raw instanceof Error) {
    return { saved: [], skipped: 0, error: raw.message }
  }

  const parsed = parseConsolidatorOutput(raw)
  if (!parsed.ok) {
    return { saved: [], skipped: 0, error: parsed.reason }
  }

  const entries = validateEntries(parsed.memories, config).slice(0, config.maxPerRun)
  const rawSkills = parsed.skills ?? []
  const skillEntries = validateSkillEntries(rawSkills, config).slice(
    0,
    config.maxSkillsPerRun ?? 2,
  )
  const invalid =
    parsed.memories.length - entries.length + (rawSkills.length - skillEntries.length)

  if (entries.length === 0 && skillEntries.length === 0) {
    return {
      saved: [],
      skipped: invalid,
      reason: invalid > 0 ? 'all candidates rejected on validation' : 'nothing worth saving',
    }
  }

  const saved: string[] = []
  const savedSkills: string[] = []
  let skipped = invalid
  for (const entry of entries) {
    try { await assertOwner() } catch (error) {
      return { saved, savedSkills, skipped, error: error instanceof Error ? error.message : String(error) }
    }
    let result: Awaited<ReturnType<HostLoopDeps['tools']['callTool']>>
    try {
      result = await writeConsolidatedMemory(deps, sessionId, entry)
    } catch (error) {
      return {
        saved,
        savedSkills,
        skipped,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (result.ok) saved.push(entry.name)
    else if (result.failure?.outcome === 'indeterminate') {
      return { saved, savedSkills, skipped, error: `memory write outcome unknown: ${result.content}` }
    }
    else if (deps.assertSessionEffectOwner) {
      return { saved, savedSkills, skipped, error: `shared-owner memory write refused: ${result.content}` }
    }
    else skipped += 1
  }
  for (const skill of skillEntries) {
    try { await assertOwner() } catch (error) {
      return { saved, savedSkills, skipped, error: error instanceof Error ? error.message : String(error) }
    }
    const result = await runSkillManagerTool(deps, sessionId, {
      kind: 'call_tool',
      callId: ulid(),
      name: 'skill_manager',
      input: {
        action: 'create',
        name: skill.name,
        scope: 'workspace',
        description: skill.description,
        content: skill.content,
      },
    })
    if (result.ok) savedSkills.push(skill.name)
    else if (result.indeterminate) {
      return { saved, savedSkills, skipped, error: `skill write outcome unknown: ${result.content}` }
    }
    else skipped += 1
  }
  return {
    saved,
    ...(savedSkills.length > 0 ? { savedSkills } : {}),
    skipped,
  }
}

function buildTranscript(
  messages: readonly Message[],
  windowSize: number,
  perMessageCharCap: number,
): string {
  const window = messages.slice(-windowSize)
  const lines: string[] = []
  for (const m of window) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = renderMessageContent(m).trim()
    if (text.length === 0) continue
    const clipped = text.length > perMessageCharCap ? `${text.slice(0, perMessageCharCap)}…` : text
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`)
  }
  return lines.join('\n\n')
}

function renderMessageContent(msg: Message): string {
  const parts: string[] = []
  for (const block of msg.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_call') parts.push(`[tool_call ${block.name}]`)
    else if (block.type === 'tool_result') parts.push(`[tool_result ${block.content.slice(0, 200)}]`)
  }
  return parts.join('\n')
}

async function callConsolidatorLlm(
  deps: HostLoopDeps,
  sessionId: string,
  transcript: string,
  config: ConsolidationConfig,
): Promise<string> {
  const model = deps.models?.get(sessionId)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  try {
    const res = await deps.llm.call({
      ...(model ? { model } : {}),
      systemPrompt: CONSOLIDATOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      tools: [],
      signal: ctrl.signal,
    })
    const text = res.message.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    return text.trim()
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error('consolidator LLM call timed out')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

type ParseResult =
  | { ok: true; memories: unknown[]; skills?: unknown[] }
  | { ok: false; reason: string }

export function parseConsolidatorOutput(raw: string): ParseResult {
  const stripped = stripFences(raw)
  if (stripped.length === 0) return { ok: false, reason: 'consolidator returned empty output' }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return { ok: false, reason: 'consolidator returned invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'consolidator output was not an object' }
  }
  const memories = (parsed as { memories?: unknown }).memories
  if (!Array.isArray(memories)) {
    return { ok: false, reason: 'consolidator output missing "memories" array' }
  }
  const skills = (parsed as { skills?: unknown }).skills
  return {
    ok: true,
    memories,
    ...(Array.isArray(skills) ? { skills } : {}),
  }
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, '')
  return withoutOpen.replace(/\n?```\s*$/, '').trim()
}

function validateEntries(memories: readonly unknown[], config: ConsolidationConfig): ValidEntry[] {
  const out: ValidEntry[] = []
  for (const raw of memories) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? sanitizeName(r.name) : undefined
    const type = typeof r.type === 'string' ? r.type : undefined
    const description = typeof r.description === 'string' ? r.description.trim() : undefined
    const content = typeof r.content === 'string' ? r.content.trim() : undefined
    if (!name || !NAME_PATTERN.test(name)) continue
    if (!type || !VALID_TYPES.has(type)) continue
    if (!description || description.length === 0) continue
    if (!content || content.length === 0) continue
    const confidence = clampConfidence(r.confidence, config.defaultConfidence)
    out.push({
      name,
      type: type as ValidEntry['type'],
      description,
      content,
      confidence,
    })
  }
  return out
}

function validateSkillEntries(
  skills: readonly unknown[],
  config: ConsolidationConfig,
): ValidSkillEntry[] {
  const out: ValidSkillEntry[] = []
  for (const raw of skills) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? sanitizeName(r.name) : undefined
    const description = typeof r.description === 'string' ? r.description.trim() : undefined
    const content =
      typeof r.content === 'string'
        ? r.content.trim()
        : typeof r.body === 'string'
          ? r.body.trim()
          : undefined
    if (!name || !description || !content) continue
    const check = validateSkillContent(name, content, description)
    if (!check.ok) continue
    const confidence = clampConfidence(r.confidence, config.defaultConfidence)
    out.push({
      name,
      description: check.description,
      content: check.normalizedContent,
      confidence,
    })
  }
  return out
}

function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function clampConfidence(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  if (raw < 0) return 0
  if (raw > 1) return 1
  return raw
}

async function writeConsolidatedMemory(
  deps: HostLoopDeps,
  sessionId: string,
  entry: ValidEntry,
): Promise<Awaited<ReturnType<HostLoopDeps['tools']['callTool']>>> {
  const body = renderMemoryFile(entry, sessionId)
  const cwd = deps.store.get(sessionId)?.state.cwd
  const effect: CallToolEffect = {
    kind: 'call_tool',
    callId: ulid(),
    name: 'memory',
    ...(cwd ? { cwd } : {}),
    input: {
      operation: 'write',
      scope: 'workspace',
      key: entry.name,
      content: body,
    },
  }
  return await deps.tools.callTool(sessionId, effect)
}

function renderMemoryFile(entry: ValidEntry, sessionId: string): string {
  const header = [
    '---',
    `name: ${entry.name}`,
    `description: ${escapeYaml(entry.description)}`,
    `type: ${entry.type}`,
    'source: consolidator',
    `confidence: ${entry.confidence}`,
    `generatedAt: ${new Date().toISOString()}`,
    `sessionId: ${sessionId}`,
    '---',
    '',
  ].join('\n')
  return `${header}${entry.content.trim()}\n`
}

function escapeYaml(value: string): string {
  if (/[:#\n"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}
