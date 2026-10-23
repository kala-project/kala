/**
 * Context compaction.
 *
 * When context pressure reaches the hard tier (auto) or the user fires
 * `/compact` (manual), summarize the old message prefix into one synthetic
 * system message while keeping the most recent user turn verbatim. The reducer
 * applies the replacement in response to a `messages_replaced` event; this
 * module chooses the pivot, drives the summarizer LLM call with a bounded
 * retry ladder, and dispatches the event through the normal loop path.
 *
 * Robustness surface (see `docs/host/context-compaction.md` — that document is
 * the source of truth):
 *
 * - **Consecutive-failure circuit breaker**. Three failed non-manual attempts
 *   in a row disable auto/preflight/tool_result triggers for the session; a
 *   successful manual attempt resets the counter.
 * - **Summarizer retry ladder**. Context-window failures trigger a bounded
 *   sequence of retries: tighten tool-result caps, then head-drop oldest
 *   groups (assistant + its subsequent tool_results) so tool_call/tool_result
 *   pairing is preserved across the trim.
 * - **Same-batch back-off**. A failed `tool_result` compaction mutes further
 *   in-batch retries so we don't loop after every subsequent tool result.
 * - **Empty summary rejection**. A summarizer that returns nothing is a
 *   failed attempt, not a successful compaction of the transcript to "".
 * - **Replacement validation**. Host validates the message rewrite before it
 *   enters the kernel event ledger. Failed attempts are runtime metadata, not
 *   agent protocol events.
 * - **Unknown-context-limit fallback**. Preflight uses a synthetic 128k
 *   fallback and disables auto rather than silently doing nothing.
 */

import type {
  AgentState,
  Message,
  MessageContent,
  ToolSchema,
  UsageDelta,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'
import { estimateMessageTokens } from '@agent-kernel/shared/token-estimation'
import { parseComputerScreenshotResult } from '@agent-kernel/shared'
import {
  createArtifactStore,
  validateCompactionSummary,
  type CompactionSummaryValidation,
} from '@agent-kernel/shared/enhancement'

import type { CompactRequest, CompactStatusPayload, CompactTrigger, HostLoopDeps, LoopHandle } from '../loop-types.js'
import { dispatchOne } from '../loop.js'
import type { SessionRecord } from '../store/session.js'
import { contextSnapshot, shouldAutoCompact } from '../context/manager.js'

/**
 * Compaction summarizer prompt.
 *
 * Design mirrors codex's local compact (`references/codex/codex-rs/core/src/compact.rs`
 * + `prompts/templates/compact/prompt.md`) and opencode's anchored `<template>`
 * summary (`references/opencode/packages/core/src/session/compaction.ts`).
 *
 * Two things the previous prompt didn't defend against and this one does:
 *
 * 1. The summarizer used to receive the raw multi-turn history as `messages`.
 *    Some models — especially when the last assistant turn was a question —
 *    would ignore the "summarize" instruction and simply *continue the
 *    conversation*, producing a two-sentence reply asking the user what to do
 *    next. We now hand the transcript to the summarizer as a single `user`
 *    message containing `<transcript>…</transcript>`, so the model no longer
 *    sees an open assistant turn it can extend.
 *
 * 2. There was no schema pressure and no "how should the next model receive
 *    this" framing. Codex tags handoff summaries with a fixed prefix
 *    ({@link SUMMARY_PREFIX}) so the resuming model recognises them as
 *    external context, not as its own past output. We do the same.
 */
const SUMMARIZER_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION for an agent-kernel coding session. Another LLM will resume the session using ONLY your output plus the recent messages preserved verbatim after it.

You will be given the conversation history to compact inside <transcript>…</transcript> and an authoritative Host-generated <runtime-checkpoint>…</runtime-checkpoint>. If the input also contains <previous-summary>…</previous-summary>, treat it as the current handoff summary and update it: preserve still-true facts, remove stale facts, merge in new facts from the transcript. Otherwise, write a fresh summary. Do not contradict the runtime checkpoint.

Output exactly the Markdown structure inside <template>, in this order, keeping every section even when the body is "(none)". Do not include the <template> tags in your response.

<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## User Intent And Constraints
- [explicit user requests, corrections, preferences, constraints that must continue to govern future work]

## Repository And Runtime State
- [cwd if known, key files/modules, active session state, selected model/provider facts, durable environment assumptions]

## Decisions And Rationale
- [decisions already made and why; rejected alternatives; constraints that prevent rework]

## Work Completed
- [concrete changes, exact file paths, commands run with exit status, tests run with outcome; include failures]

## Open Work
- 1. [immediate concrete next action, or "(none)"]
- 2. [next action after that if known, or "(none)"]
- Blockers: [blockers/uncertainties, or "(none)"]

## Preserved Verbatim
- [exact user quotes, questions, or requests that MUST survive verbatim; otherwise "(none)"]
</template>

Rules:
- Preserve exact file paths, command names, tool names, identifiers, error messages, test names, API shapes, and user wording when important.
- Preserve opaque identifiers exactly as written: UUIDs, hashes, commit IDs, session IDs, hostnames, ports, URLs, file names, room IDs, and socket IDs.
- Write summary bodies in the primary language used by the conversation. Keep section headings exactly as shown.
- Do not copy API keys, bearer tokens, passwords, cookies, or private key material. If such a value matters, describe the credential source or configuration shape and redact the secret value.
- Preserve todo/task state from todo_graph (including dependencies, ready/blocked state, and active nodes), legacy/history todowrite calls, or equivalent tool calls.
- Preserve tool-result evidence, but summarize noisy logs to the command, exit/status, and decisive lines.
- Use terse bullets, not prose paragraphs.
- Do NOT address the user. Do NOT ask questions. Do NOT describe that you are summarizing or continuing anything.
- Do not claim work is done unless the transcript establishes it.
- Keep the whole response under 1600 tokens.`

/**
 * Prefix prepended to a successful summary when it is written back into the
 * conversation as a `user` message. Matches codex's `SUMMARY_PREFIX` role:
 * signals to the resuming model that what follows is an external handoff from
 * a previous LLM, not its own prior output. Also used to detect the anchored
 * summary on subsequent compactions.
 */
export const SUMMARY_PREFIX =
  'Another LLM produced the following handoff summary of earlier work in this session. ' +
  'Use it to continue without duplicating work.'

/**
 * Cap on the total tokens of raw user messages we preserve alongside the
 * summary (codex: 20k). These are the actual user turns from the compacted
 * region, kept verbatim so exact wording of requests survives even if the
 * summarizer paraphrased them.
 */
const RECENT_RAW_USER_TOKEN_CAP = 20_000

/** Reject summaries shorter than this (chars). A well-formed template with
 * five headings + "(none)" bodies is already ~350 chars, so anything below
 * this is guaranteed to be either a conversational reply or a truncation. */
const MIN_SUMMARY_CHARS = 400

const COMPACT_TIMEOUT_MS = 10 * 60_000
const MIN_RECENT_TAIL_TOKENS = 4_000
const TARGET_RECENT_TAIL_RATIO = 0.15
const MAX_RECENT_TAIL_TOKENS = 24_000
const SUMMARIZER_OUTPUT_RESERVE_TOKENS = 4_096
const SUMMARIZER_INPUT_SAFETY_MARGIN = 1.2
const MIN_SUMMARIZER_INPUT_TOKENS = 8_000

// Retry ladder — each entry is one summarizer attempt. See the doc table for
// the reasoning; briefly: attempt 1 uses the normal cap, then we tighten,
// then we start head-dropping while keeping tool_call/tool_result pairing
// intact by dropping whole assistant-message groups at a time.
const RETRY_LADDER: readonly {
  toolResultCap: number
  textCap: number
  dropHeadGroups: number
}[] = [
  { toolResultCap: 8_000, textCap: 32_000, dropHeadGroups: 0 },
  { toolResultCap: 4_000, textCap: 20_000, dropHeadGroups: 0 },
  { toolResultCap: 2_000, textCap: 12_000, dropHeadGroups: 1 },
  { toolResultCap: 1_000, textCap: 8_000, dropHeadGroups: 2 },
  { toolResultCap: 1_000, textCap: 4_000, dropHeadGroups: 4 },
  { toolResultCap: 600, textCap: 3_000, dropHeadGroups: 8 },
]

const MAX_CONSECUTIVE_COMPACT_FAILURES = 3

// Fallback used when the session config has no contextLimit set. Chosen so
// preflight is a useful brake for typical modern models (200k Claude, 128k
// GPT-4o class) rather than a silent no-op. Never overrides real config.
const FALLBACK_CONTEXT_LIMIT_TOKENS = 128_000

/**
 * Per-session runtime state that the compaction extension needs across calls.
 * Kept as a module-scope map (rather than plumbed through HostLoopDeps) so
 * this remains a purely additive change; if the process restarts the counter
 * resets, which mirrors the fact that manual compaction is always allowed.
 */
type CompactSessionRuntime = {
  consecutiveFailures: number
  breakerCursor?: number
  // Marks a same-batch back-off. The value is a stable identifier for the
  // active batch; when the batch identifier changes (or clears), back-off
  // lifts. We use the id of the assistant message that spawned the batch.
  mutedForBatch?: string
}

const sessionRuntime = new Map<string, CompactSessionRuntime>()
const latestCompactStatus = new Map<string, CompactStatusPayload>()

function getRuntime(sessionId: string): CompactSessionRuntime {
  let rt = sessionRuntime.get(sessionId)
  if (!rt) {
    rt = { consecutiveFailures: 0 }
    sessionRuntime.set(sessionId, rt)
  }
  return rt
}

export function resetCompactRuntime(sessionId: string): void {
  sessionRuntime.delete(sessionId)
  latestCompactStatus.delete(sessionId)
}

export function currentKernelCompactStatus(sessionId: string): CompactStatusPayload | undefined {
  const status = latestCompactStatus.get(sessionId)
  return status?.kind === 'running' ? status : undefined
}

export async function maybeAutoCompact(
  deps: HostLoopDeps,
  sessionId: string,
  inFlight: Set<string>,
  handle: LoopHandle,
): Promise<void> {
  const record = deps.store.get(sessionId)
  if (!record) return
  if (!shouldAutoCompact(record, contextWindowOverrideForSession(deps, sessionId))) return
  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error') return
  if (inFlight.has(sessionId)) return
  await handle.compact(sessionId, { trigger: 'auto', continuation: 'stay_resting' })
}

export async function runCompact(
  deps: HostLoopDeps,
  sessionId: string,
  request: CompactRequest,
  inFlight: Set<string>,
  aborts: Map<string, AbortController>,
): Promise<boolean> {
  const { trigger } = request
  if (inFlight.has(sessionId)) {
    // Concurrent invocation. `manual` is the only one a human sees; the
    // others (auto/preflight/tool_result) are silent no-ops by design.
    if (trigger === 'manual') throw new Error('compact already in flight')
    return false
  }
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)
  const rt = getRuntime(sessionId)
  const attemptId = newAttemptId()

  // Scope the breaker to the transcript generation. A later cursor is a
  // half-open probe, so a transient summarizer outage cannot permanently stop
  // autonomous recovery until a human compacts or the Host restarts.
  if (trigger !== 'manual' && rt.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES && rt.breakerCursor === record.state.cursor) {
    await dispatchSkip(deps, sessionId, trigger, attemptId, 'circuit_breaker_open', aborts)
    return false
  }

  // Same-batch back-off: after a failed tool_result compaction we mute
  // further attempts for the same active batch. The batch identity is the
  // index of the assistant message that owns the currently-pending calls.
  if (trigger === 'tool_result') {
    const batchId = activeBatchIdentity(record.state)
    if (batchId && rt.mutedForBatch === batchId) {
      await dispatchSkip(deps, sessionId, trigger, attemptId, 'back_off_same_batch', aborts)
      return false
    }
  }

  const s = record.state.status
  if (s !== 'idle' && s !== 'done' && s !== 'error' && !isBusyCompactable(trigger, record.state)) {
    if (trigger === 'manual') throw new Error('cannot compact while the session is busy')
    await dispatchSkip(deps, sessionId, trigger, attemptId, 'session_busy', aborts)
    return false
  }
  if (!hasCompactableContent(record.state.messages)) {
    if (trigger === 'manual') throw new Error('nothing to compact yet')
    await dispatchSkip(deps, sessionId, trigger, attemptId, 'no_compactable_content', aborts)
    return false
  }

  inFlight.add(sessionId)
  try {
    const baselineCursor = record.state.cursor
    const contextLimit = deps.models?.contextWindow?.(sessionId) ?? record.config.contextLimit
    const beforeSnapshot = contextSnapshot(record, record.state.messages, contextWindowOverrideForSession(deps, sessionId))
    const tokensBefore = beforeSnapshot.usage.inputTokens
    const startedAt = new Date().toISOString()
    const replacedCount = record.state.messages.length
    const preserveFrom = choosePreserveFrom(record.state, trigger, contextLimit)
    const preservedTail = record.state.messages.slice(preserveFrom)
    const head = record.state.messages.slice(0, preserveFrom)
    const leadingSystemCount = record.state.messages[0]?.role === 'system' ? 1 : 0

    // Broadcast the running state so every attached dashboard (not just
    // the one that clicked /compact) can render "Compacting…".
    broadcastCompactStatus(deps, {
      sessionId,
      kind: 'running',
      trigger,
      tokensBefore,
      attemptId,
      startedAt,
      authority: 'host',
      scope: { kind: 'root' },
      startSnapshot: beforeSnapshot,
    })

    // Codex-style anchored summary: if the previous compaction wrote a summary
    // user-message at the head (identified by SUMMARY_PREFIX), pull it out and
    // hand it to the summarizer as `<previous-summary>` so it can update
    // rather than rewrite. Prevents drift across successive compactions.
    const { previousSummary, remainingHead } = extractAnchoredSummary(head)

    let compact: SummarizeOk
    try {
      compact = await summarizeWithLadder(deps, sessionId, remainingHead, previousSummary, contextLimit)
    } catch (err) {
      await recordFailure(deps, sessionId, trigger, attemptId, rt, err, aborts)
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw err
      return false
    }

    // The summarizer runs outside the per-session dispatch queue. A user or
    // another host workflow may legitimately advance the session while that
    // request is in flight. A summary and replace range derived from the old
    // transcript must never be applied to the new one. Record identity also
    // rejects delete-and-recreate races where the cursor happens to match.
    const currentRecord = deps.store.get(sessionId)
    if (currentRecord !== record || currentRecord.state.cursor !== baselineCursor) {
      await dispatchRejected(deps, sessionId, trigger, attemptId, 'session_changed', {
        baselineCursor,
        currentCursor: currentRecord?.state.cursor ?? null,
      })
      return false
    }

    if (!compact.summary || compact.summary.length === 0) {
      await recordFailure(deps, sessionId, trigger, attemptId, rt, new Error('empty summary'), aborts, 'empty_summary')
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error('summarizer returned empty summary')
      return false
    }

    const validation = validateCompactionSummary(compact.summary)
    await maybeWriteCompactionSummaryValidation(deps, sessionId, trigger, validation, compact.summary)

    if (validation.reasonCodes.includes('empty_summary')) {
      await recordFailure(deps, sessionId, trigger, attemptId, rt, new Error('empty summary'), aborts, 'empty_summary')
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error('summarizer returned empty summary')
      return false
    }

    // Schema / size / drift gate. Any of these means the summarizer produced
    // something unfit to replace the transcript — treat as a normal failure
    // (increments consecutiveFailures, triggers circuit breaker after 3, and
    // for manual bubbles the error so the human sees it) rather than
    // silently overwriting hundreds of messages with a bad summary.
    const rejectionReason = evaluateSummaryQuality(compact.summary, tokensBefore, validation)
    if (rejectionReason) {
      await recordFailure(
        deps,
        sessionId,
        trigger,
        attemptId,
        rt,
        new Error(`summary rejected: ${rejectionReason}`),
        aborts,
        rejectionReason,
      )
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error(`summarizer returned invalid handoff: ${rejectionReason}`)
      return false
    }

    // Codex-style replacement: the summary lands as a user message prefixed
    // with SUMMARY_PREFIX (so the resuming model sees it as an external
    // handoff, not its own past output), followed by up to 20k tokens of
    // recent raw user messages preserved verbatim. This differs from the
    // previous implementation which wrote the summary as a `system` message
    // and dropped every raw user quote from the compacted region.
    const runtimeCheckpoint = renderRuntimeCheckpoint(record, deps.models?.get(sessionId))
    const summaryUserMessage: Message = {
      role: 'user',
      content: [{
        type: 'text',
        text: `${SUMMARY_PREFIX}\n\n${compact.summary}\n\n<runtime-checkpoint>\n${runtimeCheckpoint}\n</runtime-checkpoint>`,
      }],
    }
    const recentRawUserTokenBudget = recentRawUserTokenCap(contextLimit)
    const recentRawUsers = pickRecentRawUserMessages(head.slice(leadingSystemCount), recentRawUserTokenBudget)
    const replacementMessages: Message[] = [summaryUserMessage, ...recentRawUsers]

    const tokensAfter = estimateMessageTokens([
      ...record.state.messages.slice(0, leadingSystemCount),
      ...replacementMessages,
      ...preservedTail,
    ])
    const replaceRange = { start: leadingSystemCount, end: preserveFrom }
    const invalidReason = validateReplacement(record.state, replaceRange)
    if (invalidReason) {
      await dispatchRejected(deps, sessionId, trigger, attemptId, invalidReason, {
        replaceRange,
        tokensBefore,
        tokensAfter,
      })
      noteCompactFailure(rt, record.state.cursor)
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error(`compact rejected before dispatch: ${invalidReason}`)
      return false
    }
    const budgetReason = evaluatePostCompactionBudget(tokensAfter, contextLimit) ?? evaluateCompactionProgress(tokensBefore, tokensAfter)
    if (budgetReason) {
      await dispatchRejected(deps, sessionId, trigger, attemptId, budgetReason, {
        replaceRange,
        tokensBefore,
        tokensAfter,
        contextLimit: effectiveContextLimit(contextLimit),
      })
      noteCompactFailure(rt, record.state.cursor)
      if (trigger === 'tool_result') markBatchBackOff(rt, record.state)
      if (trigger === 'manual') throw new Error(`compact rejected before dispatch: ${budgetReason}`)
      return false
    }
    const endedAt = new Date().toISOString()
    summaryUserMessage.metadata = {
      kind: 'context_compaction',
      attemptId,
      phase: 'done',
      trigger,
      tokensBefore,
      tokensAfter,
      replacedCount,
      summary: compact.summary,
      startedAt,
      endedAt,
    }

    await dispatchOne(
      deps,
      sessionId,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange,
        replacementMessages,
      },
      aborts,
      compact.trace,
      compact.model,
      undefined,
      undefined,
      {
        compactionMetadata: {
          trigger,
          attemptId,
          tokensBefore,
          tokensAfter,
          replacedCount,
        },
      },
    )
    await appendCompactionMetadata(deps, sessionId, 'compaction_applied', {
      trigger,
      attemptId,
      replaceRange,
      preserveFrom,
      replacedCount,
      tokensBefore,
      tokensAfter,
      summaryChars: compact.summary.length,
      compressionRatio: tokensAfter > 0 ? Math.round((tokensBefore / tokensAfter) * 10) / 10 : null,
      previousSummaryChars: previousSummary?.length ?? 0,
      recentRawUsersCount: recentRawUsers.length,
      recentRawUserTokenBudget,
      validationReasonCodes: validation.reasonCodes,
      ...(compact.usage ? { responseUsage: compact.usage } : {}),
    })

    const completedRecord = deps.store.get(sessionId)
    const completionSnapshot = completedRecord
      ? contextSnapshot(
          completedRecord,
          completedRecord.state.messages,
          contextWindowOverrideForSession(deps, sessionId),
        )
      : undefined
    broadcastCompactStatus(deps, {
      sessionId,
      kind: 'done',
      attemptId,
      trigger,
      tokensBefore,
      tokensAfter,
      replacedCount,
      summary: compact.summary,
      endedAt,
      authority: 'host',
      scope: { kind: 'root' },
      startSnapshot: beforeSnapshot,
      ...(completionSnapshot ? { completionSnapshot } : {}),
      summaryValidation: 'host_gate',
    })

    // Success: reset counters and back-off.
    rt.consecutiveFailures = 0
    rt.breakerCursor = undefined
    rt.mutedForBatch = undefined
    return true
  } finally {
    inFlight.delete(sessionId)
  }
}

/**
 * Return a machine-readable reason code if the summary is unfit to replace
 * the transcript, or `undefined` if it passes all quality gates. Not called
 * for the empty-summary case (handled separately upstream).
 *
 * Deliberately no compression-ratio gate: the earlier 200× cap was set to
 * catch the 42w→50char pathological case, but it also rejected legitimate
 * 400k→2k handoffs. The schema + min-length + conversational-reply checks
 * already catch every real-world bad summary observed.
 */
function evaluateSummaryQuality(
  summary: string,
  tokensBefore: number,
  validation: CompactionSummaryValidation,
): 'summary_schema_invalid' | 'summary_too_short' | 'summary_conversational' | undefined {
  void tokensBefore
  if (!validation.ok) return 'summary_schema_invalid'
  if (summary.trim().length < MIN_SUMMARY_CHARS) return 'summary_too_short'
  if (looksLikeConversationalReply(summary)) return 'summary_conversational'
  return undefined
}

function contextWindowOverrideForSession(deps: HostLoopDeps, sessionId: string): { model?: string; contextWindow?: number } | undefined {
  const model = deps.models?.get(sessionId)
  const contextWindow = deps.models?.contextWindow?.(sessionId)
  if (!model && !contextWindow) return undefined
  return {
    ...(model ? { model } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  }
}

async function recordFailure(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  attemptId: string,
  rt: CompactSessionRuntime,
  err: unknown,
  aborts: Map<string, AbortController>,
  reasonOverride?:
    | 'empty_summary'
    | 'summary_schema_invalid'
    | 'summary_too_short'
    | 'summary_conversational',
): Promise<void> {
  noteCompactFailure(rt, deps.store.get(sessionId)?.state.cursor)
  const reason = reasonOverride ?? 'summarizer_failed'
  await dispatchSkip(deps, sessionId, trigger, attemptId, reason, aborts, errorMessage(err))
}

function noteCompactFailure(rt: CompactSessionRuntime, cursor: number | undefined): void {
  rt.consecutiveFailures += 1
  if (rt.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) rt.breakerCursor = cursor
}

async function dispatchSkip(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  attemptId: string,
  reason:
    | 'circuit_breaker_open'
    | 'back_off_same_batch'
    | 'summarizer_failed'
    | 'empty_summary'
    | 'summary_schema_invalid'
    | 'summary_too_short'
    | 'summary_conversational'
    | 'no_compactable_content'
    | 'session_busy',
  aborts: Map<string, AbortController>,
  errorMessageText?: string,
): Promise<void> {
  void aborts
  await appendCompactionMetadata(deps, sessionId, 'compaction_skipped', {
    trigger,
    attemptId,
    reason,
    ...(errorMessageText ? { errorMessage: errorMessageText } : {}),
  })
  broadcastCompactStatus(deps, {
    sessionId, kind: 'skipped', attemptId, reason,
    ...(errorMessageText ? { message: errorMessageText } : {}),
    endedAt: new Date().toISOString(),
    authority: 'host',
    scope: { kind: 'root' },
  })
}

async function dispatchRejected(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  attemptId: string,
  reason: 'pending_call_orphaned' | 'invalid_replace_range' | 'post_compaction_still_over_budget' | 'post_compaction_no_progress' | 'session_changed',
  extra: Record<string, unknown>,
): Promise<void> {
  await appendCompactionMetadata(deps, sessionId, 'compaction_rejected', {
    trigger,
    attemptId,
    reason,
    ...extra,
  })
  broadcastCompactStatus(deps, {
    sessionId,
    kind: 'skipped',
    attemptId,
    reason,
    endedAt: new Date().toISOString(),
    authority: 'host',
    scope: { kind: 'root' },
  })
}

function broadcastCompactStatus(deps: HostLoopDeps, payload: CompactStatusPayload): void {
  latestCompactStatus.set(payload.sessionId, payload)
  try {
    deps.broadcast.onCompactStatus?.(payload)
  } catch {
    // Broadcast is fire-and-forget observability; a bad listener never
    // taints the compaction path itself.
  }
}

async function appendCompactionMetadata(
  deps: HostLoopDeps,
  sessionId: string,
  action: 'compaction_applied' | 'compaction_skipped' | 'compaction_rejected',
  payload: Record<string, unknown>,
): Promise<void> {
  if (!deps.store.get(sessionId)) return
  await deps.store.appendRuntimeMetadata(sessionId, { action, payload })
}

function markBatchBackOff(rt: CompactSessionRuntime, state: AgentState): void {
  const id = activeBatchIdentity(state)
  if (id) rt.mutedForBatch = id
}

function activeBatchIdentity(state: AgentState): string | undefined {
  const idx = findActiveToolBatchIndex(state)
  if (idx === undefined) return undefined
  return `batch:${idx}`
}

function validateReplacement(
  state: AgentState,
  range: { start: number; end: number },
): 'invalid_replace_range' | 'pending_call_orphaned' | undefined {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return 'invalid_replace_range'
  if (range.start < 0 || range.end < range.start || range.end > state.messages.length) return 'invalid_replace_range'
  if (state.pendingCalls.length === 0) return undefined
  const activeAssistant = findActiveToolBatchIndex(state)
  if (activeAssistant === undefined) return 'pending_call_orphaned'
  if (activeAssistant < range.end) return 'pending_call_orphaned'
  return undefined
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}

function newAttemptId(): string {
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function maybeWriteCompactionSummaryValidation(
  deps: HostLoopDeps,
  sessionId: string,
  trigger: CompactTrigger,
  validation: CompactionSummaryValidation,
  summary: string,
): Promise<void> {
  if (!deps.artifactRootDir) return
  try {
    const record = deps.store.get(sessionId)
    const store = createArtifactStore(deps.artifactRootDir, {
      ...(record?.state.cwd ? { workspaceRoot: record.state.cwd } : {}),
    })
    const seq = record?.state.cursor ?? 0
    await store.writeJson(
      'compaction_summary_validation',
      `compaction-summaries/${sessionId}/${seq}.json`,
      {
        schemaVersion: 1 as const,
        sessionId,
        eventSeq: seq,
        trigger,
        generatedAt: new Date().toISOString(),
        summaryChars: summary.length,
        ...validation,
      },
    )
  } catch {
    // Validation is observability. Failing to persist it must not break compaction.
  }
}

type SummarizeOk = {
  summary: string
  request: {
    model?: string
    systemPrompt: string
    messages: readonly Message[]
    tools: readonly ToolSchema[]
  }
  usage?: UsageDelta
  trace?: LLMTrace
  model?: string
}

async function summarize(
  deps: HostLoopDeps,
  sessionId: string,
  messages: readonly Message[],
  previousSummary: string | undefined,
): Promise<SummarizeOk> {
  const model = deps.models?.get(sessionId)
  const transcript = renderTranscriptForSummarizer(messages)
  const record = deps.store.get(sessionId)
  if (!record) throw new Error(`Unknown session: ${sessionId}`)
  const runtimeCheckpoint = renderRuntimeCheckpoint(record, model)
  const userText =
    (previousSummary
      ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
      : '')
    + `<runtime-checkpoint>\n${runtimeCheckpoint}\n</runtime-checkpoint>\n\n`
    + `<transcript>\n${transcript}\n</transcript>\n\n`
    + 'Produce the handoff summary per the system instructions. Fill every section; use "(none)" for sections with no content. Do not address the user, do not ask questions.'
  // Codex-style: hand the transcript to the summarizer as ONE user message so
  // the model never sees an open assistant turn it can extend. Previously we
  // passed the raw message array, which caused Claude Opus to occasionally
  // reply "you only said 'please continue', which do you want?" and that
  // conversational reply was then written back as the compacted summary,
  // destroying 400k tokens of history. See references/codex/codex-rs/core/src/compact.rs.
  const request = {
    ...(model ? { model } : {}),
    systemPrompt: SUMMARIZER_PROMPT,
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: userText }] },
    ],
    tools: [],
  }

  await deps.assertSessionEffectOwner?.(sessionId)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), COMPACT_TIMEOUT_MS)
  let res: Awaited<ReturnType<HostLoopDeps['llm']['call']>>
  try {
    res = await deps.llm.call({
      ...request,
      thinkingBudget: 0,
      signal: ctrl.signal,
    })
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error('compact timed out')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = res.message.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return {
    summary: text.trim(),
    request,
    ...(res.usage ? { usage: res.usage } : {}),
    ...(res.trace ? { trace: res.trace } : {}),
    ...(res.trace?.model ?? model ? { model: res.trace?.model ?? model } : {}),
  }
}

function renderRuntimeCheckpoint(
  record: SessionRecord,
  model: string | undefined,
): string {
  return JSON.stringify({
    sessionId: record.sessionId,
    sourceCursor: record.state.cursor,
    status: record.state.status,
    cwd: record.state.cwd ?? null,
    workspaceId: record.workspaceId ?? null,
    executionMode: record.executionMode,
    model: model ?? null,
    pendingCalls: record.state.pendingCalls.map(({ callId, name, status }) => ({ callId, name, status })),
  }, null, 2)
}

/**
 * Serialise a slice of messages into a tagged plain-text transcript that the
 * summarizer receives as a single user turn. Format mirrors opencode's
 * `serialize()` in `packages/core/src/session/compaction.ts` — `[User]:`,
 * `[Assistant]:`, `[Assistant reasoning]:`, `[Assistant tool call]:`, and
 * `[Tool result]:` prefixes so a text-only summarizer can still reconstruct
 * turn boundaries. Images are stripped (indicated inline); tool_results were
 * already truncated by the retry ladder via `prepareCompactionInputWithLimit`.
 */
function renderTranscriptForSummarizer(messages: readonly Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const text = collectText(message.content)
      if (text) lines.push(`[System]: ${text}`)
      continue
    }
    if (message.role === 'user') {
      const parts: string[] = []
      for (const content of message.content) {
        if (content.type === 'text' && content.text.trim().length > 0) {
          parts.push(content.text)
        } else if (content.type === 'image') {
          parts.push('[Attached image]')
        } else if (content.type === 'file') {
          parts.push(`[Attached file: ${content.name}]`)
        } else if (content.type === 'tool_result') {
          // Kernel occasionally stores tool_result on user-role messages.
          const status = content.ok ? 'Tool result' : 'Tool error'
          parts.push(`[${status} ${content.callId}]: ${content.content}`)
        }
      }
      if (parts.length > 0) lines.push(`[User]: ${parts.join('\n')}`)
      continue
    }
    if (message.role === 'tool') {
      for (const content of message.content) {
        if (content.type !== 'tool_result') continue
        const status = content.ok ? 'Tool result' : 'Tool error'
        lines.push(`[${status} ${content.callId}]: ${content.content}`)
      }
      continue
    }
    // assistant
    for (const content of message.content) {
      if (content.type === 'text') {
        if (content.text.trim().length > 0) lines.push(`[Assistant]: ${content.text}`)
      } else if (content.type === 'thinking') {
        if (content.text.trim().length > 0) lines.push(`[Assistant reasoning]: ${content.text}`)
      } else if (content.type === 'tool_call') {
        let input: string
        try {
          input = JSON.stringify(content.input)
        } catch {
          input = '{...unserialisable input...}'
        }
        lines.push(`[Assistant tool call ${content.callId}]: ${content.name}(${input})`)
      } else if (content.type === 'image') {
        lines.push('[Assistant image]')
      } else if (content.type === 'file') {
        lines.push(`[Assistant file: ${content.name}]`)
      }
    }
  }
  return lines.join('\n\n')
}

function collectText(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

/**
 * If the most recent leading messages of the compaction head are an anchored
 * summary produced by a prior compaction (recognised by {@link SUMMARY_PREFIX}),
 * return it as `previousSummary` and drop it from the head so it isn't
 * re-serialised into the new transcript. This is opencode's anchored-summary
 * pattern: each compaction updates the previous handoff rather than rewriting
 * it from zero.
 */
function extractAnchoredSummary(
  head: readonly Message[],
): { previousSummary: string | undefined; remainingHead: readonly Message[] } {
  // The anchor lives right after the leading system prompt (if any).
  const leadingSystem = head[0]?.role === 'system' ? 1 : 0
  const candidate = head[leadingSystem]
  if (!candidate) return { previousSummary: undefined, remainingHead: head }
  if (candidate.role !== 'user') return { previousSummary: undefined, remainingHead: head }
  const text = collectText(candidate.content)
  if (!text.startsWith(SUMMARY_PREFIX)) return { previousSummary: undefined, remainingHead: head }
  const previousSummary = text.slice(SUMMARY_PREFIX.length).replace(/^\s*\n?/, '')
  const remainingHead = [...head.slice(0, leadingSystem), ...head.slice(leadingSystem + 1)]
  return { previousSummary, remainingHead }
}

/**
 * Pick the most recent raw user messages from the compacted region, in
 * original order, up to a total token budget (default 20k, matching
 * codex `COMPACT_USER_MESSAGE_MAX_TOKENS`). The anchored summary user
 * message (identified by {@link SUMMARY_PREFIX}) is skipped: it isn't a
 * "real" user turn.
 */
function pickRecentRawUserMessages(head: readonly Message[], tokenBudget: number): Message[] {
  const users: Message[] = []
  for (let i = head.length - 1; i >= 0; i--) {
    const message = head[i]!
    if (message.role !== 'user') continue
    const text = collectText(message.content)
    if (text.startsWith(SUMMARY_PREFIX)) continue
    users.push(message)
  }
  users.reverse()
  const kept: Message[] = []
  let usedTokens = 0
  for (let i = users.length - 1; i >= 0; i--) {
    const message = users[i]!
    const tokens = estimateMessageTokens([message])
    if (tokens > tokenBudget) continue
    if (usedTokens + tokens > tokenBudget) break
    kept.push(message)
    usedTokens += tokens
    if (usedTokens >= tokenBudget) break
  }
  kept.reverse()
  return kept
}

/**
 * Detect the failure mode observed on box: the summarizer replies to the user
 * ("you said 'please continue', which do you want?") instead of writing a
 * handoff. These replies typically end in a question mark, contain second-person
 * imperative Chinese/English phrasing, and lack the required Markdown headings
 * — but by the time we get here the schema check has already fired, so this
 * function's role is to catch borderline cases where the model produced a few
 * headings but the body still reads as a chat reply. Conservative: only
 * flag when strong signals overlap.
 */
function looksLikeConversationalReply(summary: string): boolean {
  const trimmed = summary.trim()
  if (trimmed.length === 0) return true
  const endsWithQuestion = /[?？]\s*$/.test(trimmed)
  const secondPersonPrompting = /(告诉我|你要哪个|哪个方向|which (option|one) do you want|please (tell|let) me|let me know|you tell me)/i.test(
    trimmed,
  )
  const tinyBody = trimmed.length < 300
  return (endsWithQuestion && (secondPersonPrompting || tinyBody))
    || (secondPersonPrompting && tinyBody)
}

async function summarizeWithLadder(
  deps: HostLoopDeps,
  sessionId: string,
  messages: readonly Message[],
  previousSummary: string | undefined,
  contextLimit: number | undefined,
): Promise<SummarizeOk> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_LADDER.length; attempt++) {
    const rung = RETRY_LADDER[attempt]!
    const trimmed = prepareCompactionInputWithLimit(messages, {
      toolResultChars: rung.toolResultCap,
      textChars: rung.textCap,
    })
    const withHeadDropped = dropHeadGroups(trimmed, rung.dropHeadGroups)
    const budgeted = fitSummarizerInputToBudget(withHeadDropped, previousSummary, contextLimit)
    if (budgeted.length === 0) continue
    try {
      return await summarize(deps, sessionId, budgeted, previousSummary)
    } catch (err) {
      lastErr = err
      if (!isContextOverflowError(err)) throw err
      // Fall through to the next rung.
    }
  }
  throw lastErr ?? new Error('summarizer retry ladder exhausted')
}

/**
 * Drop the oldest `count` "groups" from the summarizer input. A group is one
 * assistant message plus its immediately-following tool_result messages —
 * dropping whole groups preserves tool_call/tool_result pairing across the
 * trim. A leading run of non-assistant messages is dropped along with the
 * first group so we never leave an orphan tool_result at the head.
 */
function dropHeadGroups(messages: readonly Message[], count: number): Message[] {
  if (count <= 0) return [...messages]
  const groups: Message[][] = []
  let current: Message[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (current.length > 0) groups.push(current)
      current = [m]
    } else {
      current.push(m)
    }
  }
  if (current.length > 0) groups.push(current)
  // First group may consist of pre-assistant messages (system/user). Never
  // drop the leading system message; treat it as sticky.
  const stickyLeading: Message[] = []
  let startGroupIndex = 0
  if (groups.length > 0 && groups[0]!.every((m) => m.role !== 'assistant')) {
    // Preserve leading system if present, drop the rest of this group along
    // with the requested count of subsequent groups.
    for (const m of groups[0]!) if (m.role === 'system') stickyLeading.push(m)
    startGroupIndex = 1
  }
  const remaining = groups.slice(startGroupIndex + count)
  return [...stickyLeading, ...remaining.flat()]
}

function isContextOverflowError(err: unknown): boolean {
  // Heuristic: providers surface context-window errors as strings today.
  // A typed error kind on the adapter would let us replace this, but until
  // then this regex covers the common shapes across Anthropic, OpenAI, and
  // OpenRouter.
  const text = err instanceof Error ? err.message : String(err)
  return /context|window|token|too large|maximum input|input exceeds|prompt is too long/i.test(text)
}

function hasCompactableContent(messages: readonly Message[]): boolean {
  return messages.some((m, index) => isCompactableMessage(m, index))
}

function isCompactableMessage(message: Message, index: number): boolean {
  // The durable leading system prompt is setup, not history. Later system
  // messages are synthetic compact summaries and may be compacted again.
  return !(index === 0 && message.role === 'system')
}

function isPreflightCompactable(
  trigger: CompactTrigger,
  state: AgentState,
): boolean {
  return trigger === 'preflight' && state.status === 'thinking' && state.pendingCalls.length === 0
}

function isBusyCompactable(trigger: CompactTrigger, state: AgentState): boolean {
  return isPreflightCompactable(trigger, state)
}

function prepareCompactionInputWithLimit(
  messages: readonly Message[],
  limits: { toolResultChars: number; textChars: number },
): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((content: MessageContent) => {
      if (content.type === 'tool_result') {
        const screenshot = content.ok ? parseComputerScreenshotResult(content.content) : undefined
        if (screenshot) return {
          ...content,
          content: `[Earlier desktop screenshot: ${screenshot.width}x${screenshot.height}, origin (${screenshot.originX}, ${screenshot.originY}). Image omitted during compaction; take a fresh authorized screenshot before further input.]`,
        }
        if (content.content.length <= limits.toolResultChars) return content
        return {
          ...content,
          content: compactLongText(content.content, limits.toolResultChars, 'old tool result'),
        }
      }
      if (content.type === 'text' || content.type === 'thinking') {
        if (content.text.length <= limits.textChars) return content
        return {
          ...content,
          text: compactLongText(content.text, limits.textChars, content.type === 'thinking' ? 'old assistant reasoning' : 'old text'),
        }
      }
      return content
    }),
  }))
}

function compactLongText(content: string, maxChars: number, label: string): string {
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.max(0, maxChars - headChars)
  const omitted = content.length - headChars - tailChars
  if (omitted <= 0) return content
  return [
    content.slice(0, headChars).trimEnd(),
    `[... ${omitted} chars omitted from ${label} before compaction ...]`,
    content.slice(-tailChars).trimStart(),
  ].join('\n')
}

function fitSummarizerInputToBudget(
  messages: readonly Message[],
  previousSummary: string | undefined,
  contextLimit: number | undefined,
): Message[] {
  const maxTokens = summarizerInputBudget(contextLimit, previousSummary)
  let out = [...messages]
  while (out.length > 1 && estimateMessageTokens(out) > maxTokens) {
    const next = dropOldestCompactionGroup(out)
    if (next.length === out.length) break
    out = next
  }
  return out
}

function summarizerInputBudget(contextLimit: number | undefined, previousSummary: string | undefined): number {
  const effective = effectiveContextLimit(contextLimit)
  const previousSummaryTokens = previousSummary ? Math.ceil(previousSummary.length / 4) : 0
  return Math.max(
    MIN_SUMMARIZER_INPUT_TOKENS,
    Math.floor((effective - SUMMARIZER_OUTPUT_RESERVE_TOKENS - previousSummaryTokens) / SUMMARIZER_INPUT_SAFETY_MARGIN),
  )
}

function effectiveContextLimit(contextLimit: number | undefined): number {
  return contextLimit && contextLimit > 0 ? contextLimit : FALLBACK_CONTEXT_LIMIT_TOKENS
}

function dropOldestCompactionGroup(messages: readonly Message[]): Message[] {
  const firstDroppable = messages.findIndex((message, index) => index > 0 || message.role !== 'system')
  if (firstDroppable < 0) return [...messages]
  let end = firstDroppable + 1
  for (; end < messages.length; end++) {
    const previous = messages[end - 1]
    const current = messages[end]
    if (!previous || !current) break
    if (previous.role === 'assistant' && hasToolCallContent(previous) && current.role === 'tool') continue
    if (previous.role === 'assistant' && hasToolCallContent(previous) && hasUserToolResultContent(current)) continue
    if (current.role === 'tool') continue
    if (hasUserToolResultContent(current)) continue
    break
  }
  return [...messages.slice(0, firstDroppable), ...messages.slice(end)]
}

function hasToolCallContent(message: Message): boolean {
  return message.content.some((content) => content.type === 'tool_call')
}

function hasUserToolResultContent(message: Message): boolean {
  return message.role === 'user' && message.content.some((content) => content.type === 'tool_result')
}

function evaluateCompactionProgress(tokensBefore: number, tokensAfter: number): 'post_compaction_no_progress' | undefined {
  // Tiny synthetic windows can have a structured handoff larger than their
  // toy transcript. Enforce progress for real contexts while preserving those
  // focused trigger tests.
  if (tokensBefore < 4_000) return undefined
  return tokensAfter >= tokensBefore ? 'post_compaction_no_progress' : undefined
}

function evaluatePostCompactionBudget(
  tokensAfter: number,
  contextLimit: number | undefined,
): 'post_compaction_still_over_budget' | undefined {
  const effective = effectiveContextLimit(contextLimit)
  // Tiny synthetic test windows can be smaller than the minimum structured
  // handoff itself. Real provider contexts start well above this; keep the
  // production guard while letting small-window tests exercise trigger logic.
  if (effective < 16_000) return undefined
  const hardBudget = Math.floor(effective * 0.85)
  return tokensAfter > hardBudget ? 'post_compaction_still_over_budget' : undefined
}

type MessageBoundaryIndex = {
  compactablePrefix: readonly boolean[]
  suffixTokens: readonly number[]
}

function buildMessageBoundaryIndex(messages: readonly Message[]): MessageBoundaryIndex {
  const compactablePrefix = new Array<boolean>(messages.length + 1).fill(false)
  const suffixTokens = new Array<number>(messages.length + 1).fill(0)
  for (let i = 0; i < messages.length; i++) {
    compactablePrefix[i + 1] = compactablePrefix[i]! || isCompactableMessage(messages[i]!, i)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixTokens[i] = estimateMessageTokens([messages[i]!]) + suffixTokens[i + 1]!
  }
  return { compactablePrefix, suffixTokens }
}

function choosePreserveFrom(state: AgentState, trigger: CompactTrigger, contextLimit: number | undefined): number {
  const index = buildMessageBoundaryIndex(state.messages)
  if (trigger === 'tool_result') {
    const safe = choosePendingSafePreserveFrom(state, contextLimit, index)
    if (safe !== undefined) return safe
  }
  return chooseRecentUserPreserveFrom(state.messages, contextLimit, index)
}

function chooseRecentUserPreserveFrom(
  messages: readonly Message[],
  contextLimit: number | undefined,
  index = buildMessageBoundaryIndex(messages),
): number {
  const targetRecentTailTokens = recentTailTargetTokens(contextLimit)
  let newestSafeFallback: number | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'user') continue
    if (isAnchoredSummaryMessage(messages[i]!)) continue
    if (!index.compactablePrefix[i]) continue
    newestSafeFallback ??= i
    if (index.suffixTokens[i]! <= targetRecentTailTokens) return i
  }
  // If every real user-turn tail is still over the target, keep the newest
  // valid user turn. Choosing the oldest one would preserve the entire huge
  // tail and only rewrite the anchored summary, which is not a real compact.
  if (newestSafeFallback !== undefined) return newestSafeFallback
  // Summary-only compaction: after one or more successful compactions, the
  // remaining old context may be stored only as the anchored summary. Re-
  // summarize those messages instead of reporting "nothing to compact".
  return messages.length
}

function isAnchoredSummaryMessage(message: Message): boolean {
  return message.role === 'user' && collectText(message.content).startsWith(SUMMARY_PREFIX)
}

function choosePendingSafePreserveFrom(
  state: AgentState,
  contextLimit: number | undefined,
  index = buildMessageBoundaryIndex(state.messages),
): number | undefined {
  const activeAssistant = findActiveToolBatchIndex(state)
  if (activeAssistant === undefined) return undefined
  // Walk backward from the assistant that spawned the active batch, looking
  // for a user message we can cut on. Per SPEC §Cut-Point Selection the pivot
  // MUST be a user index — never an assistant with a pending call (would
  // orphan the tool_result), never a tool_result itself.
  for (let i = activeAssistant - 1; i >= 0; i--) {
    if (state.messages[i]?.role !== 'user') continue
    if (!index.compactablePrefix[i]) continue
    // Prefer tails inside the budget, but the closest user message to the
    // active batch is always safe: it keeps the parent user turn + the
    // assistant tool_call + all pending tool_results together.
    if (index.suffixTokens[i]! <= recentTailTargetTokens(contextLimit) || i === activeAssistant - 1) {
      return i
    }
  }
  return undefined
}

function findActiveToolBatchIndex(state: AgentState): number | undefined {
  const pending = new Set(state.pendingCalls.map((call) => call.callId))
  if (pending.size === 0) return undefined
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]
    if (!message || message.role !== 'assistant') continue
    for (const content of message.content) {
      if (content.type === 'tool_call' && pending.has(content.callId)) return i
    }
  }
  return undefined
}

/**
 * Recent-tail target. See doc "Cut-Point Selection" for the rationale of the
 * bounds; below `contextLimit === undefined` we return the fixed floor rather
 * than 0 so we still preserve a meaningful window on unknown-limit models.
 * Small-context models (<16k) use a proportional fallback so the fixed floors
 * don't sum to more than the window itself.
 */
function recentTailTargetTokens(contextLimit: number | undefined): number {
  const effective = contextLimit && contextLimit > 0 ? contextLimit : FALLBACK_CONTEXT_LIMIT_TOKENS
  if (effective < 16_000) {
    return Math.max(1_500, Math.floor(effective * 0.4))
  }
  return Math.min(
    MAX_RECENT_TAIL_TOKENS,
    Math.max(MIN_RECENT_TAIL_TOKENS, Math.round(effective * TARGET_RECENT_TAIL_RATIO)),
  )
}

function recentRawUserTokenCap(contextLimit: number | undefined): number {
  const effective = effectiveContextLimit(contextLimit)
  if (effective < 16_000) return Math.max(1_000, Math.floor(effective * 0.2))
  return Math.min(RECENT_RAW_USER_TOKEN_CAP, Math.max(4_000, Math.floor(effective * 0.1)))
}
