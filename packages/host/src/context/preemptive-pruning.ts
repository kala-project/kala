/**
 * Preemptive Tool Result Pruning (Micro-Compaction).
 *
 * When context usage crosses the soft threshold (default 0.70 of the model
 * context window), or before full LLM compaction runs, this module deterministically
 * prunes oversized historical `tool_result` payloads older than the protected
 * recent assistant-turn window (`preserveRecentGroups`, default 6).
 *
 * See `docs/host/smart-output-truncation-and-pruning.md` (SoT).
 */

import type { AgentConfig, Message, MessageContent } from '@agent-kernel/kernel'
import { parseComputerScreenshotResult } from '@agent-kernel/shared'
import { estimateMessageTokens, estimateToolSchemaTokens } from '@agent-kernel/shared/token-estimation'

export const PRUNED_TOOL_RESULT_PREFIX = '[pruned tool_result:'

export type PreemptivePruningOptions = {
  /** Soft context ratio at which preemptive pruning activates (default: 0.70). */
  softRatio?: number
  /** Target context ratio after pruning (default: 0.55). */
  targetRatio?: number
  /** Number of most-recent assistant turn groups to keep untouched (default: 6). */
  preserveRecentGroups?: number
  /** Minimum character length of a historical tool_result to be eligible (default: 2000). */
  minPruneChars?: number
  /** Number of head characters preserved in the pruned stub (default: 280). */
  stubHeadChars?: number
  /** Number of tail characters preserved in the pruned stub (default: 280). */
  stubTailChars?: number
}

export type PrunedToolResultEntry = {
  messageIndex: number
  contentIndex: number
  callId: string
  toolName: string
  originalBytes: number
  prunedBytes: number
}

export type PreemptivePruningResult = {
  messages: readonly Message[]
  pruned: boolean
  prunedCount: number
  tokensBefore: number
  tokensAfter: number
  savedTokens: number
  entries: readonly PrunedToolResultEntry[]
}

const DEFAULT_SOFT_RATIO = 0.70
const DEFAULT_TARGET_RATIO = 0.55
const DEFAULT_PRESERVE_RECENT_GROUPS = 6
const DEFAULT_MIN_PRUNE_CHARS = 2_000
const DEFAULT_STUB_HEAD_CHARS = 280
const DEFAULT_STUB_TAIL_CHARS = 280
const DEFAULT_RESERVE_TOKENS = 16_384

export function isAlreadyPrunedToolResult(content: string): boolean {
  return content.startsWith(PRUNED_TOOL_RESULT_PREFIX)
}

function overflowFooterStart(content: string): number {
  const markerIndex = content.lastIndexOf('--- output truncated:')
  if (markerIndex < 0) return -1
  const previousLineStart = content.lastIndexOf('\n', markerIndex - 2) + 1
  return content.slice(previousLineStart, markerIndex).startsWith('--- use ')
    ? previousLineStart
    : markerIndex
}

function safeHeadIndex(content: string, index: number): number {
  return index > 0 && index < content.length
    && /[\uD800-\uDBFF]/.test(content[index - 1]!)
    && /[\uDC00-\uDFFF]/.test(content[index]!)
    ? index - 1 : index
}

function safeTailIndex(content: string, index: number): number {
  return index > 0 && index < content.length
    && /[\uD800-\uDBFF]/.test(content[index - 1]!)
    && /[\uDC00-\uDFFF]/.test(content[index]!)
    ? index + 1 : index
}

export function buildPrunedToolResultStub(
  content: string,
  meta: {
    callId: string
    toolName: string
    headChars?: number
    tailChars?: number
  },
): string {
  if (isAlreadyPrunedToolResult(content)) return content
  const headChars = meta.headChars ?? DEFAULT_STUB_HEAD_CHARS
  const tailChars = meta.tailChars ?? DEFAULT_STUB_TAIL_CHARS
  const originalBytes = Buffer.byteLength(content, 'utf8')
  const originalLines = content.split('\n').length
  const footerStart = overflowFooterStart(content)
  const overflowFooter = footerStart >= 0 ? content.slice(footerStart).trim() : undefined

  // Strip the trailing overflow footer from the body before taking the tail snippet
  // so we don't duplicate the footer in both the tail snippet and the preserved footer.
  const bodyWithoutFooter = overflowFooter
    ? content.slice(0, footerStart).trimEnd()
    : content

  const head = bodyWithoutFooter.slice(0, safeHeadIndex(bodyWithoutFooter, headChars)).trimEnd()
  const tail = tailChars > 0 && bodyWithoutFooter.length > headChars
    ? bodyWithoutFooter.slice(safeTailIndex(bodyWithoutFooter, bodyWithoutFooter.length - tailChars)).trimStart()
    : ''

  const lines: string[] = [
    `${PRUNED_TOOL_RESULT_PREFIX} tool=${meta.toolName} callId=${meta.callId} original=${originalLines} lines / ${originalBytes} bytes]`,
  ]
  if (head.length > 0) lines.push(head)
  lines.push('... [historical tool output pruned to save context budget] ...')
  if (tail.length > 0 && tail !== head) lines.push(tail)
  if (overflowFooter) lines.push(overflowFooter)

  return lines.join('\n')
}

/**
 * Compute all message indices that fall strictly before the last
 * `preserveRecentGroups` assistant messages.
 */
function findPrunableBoundaryIndex(
  messages: readonly Message[],
  preserveRecentGroups: number,
): number {
  if (preserveRecentGroups <= 0) return messages.length
  let assistantSeen = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      assistantSeen += 1
      if (assistantSeen >= preserveRecentGroups) {
        return i
      }
    }
  }
  return 0
}

function collectToolNameByCallId(messages: readonly Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    for (const item of message.content) {
      if (item.type === 'tool_call') {
        map.set(item.callId, item.name)
      }
    }
  }
  return map
}

function effectiveContextBudget(
  config: AgentConfig,
  contextLimitOverride?: number,
): {
  contextLimit: number | undefined
  overheadTokens: number
} {
  const rawLimit = contextLimitOverride ?? config.contextLimit
  const contextLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.floor(rawLimit)
    : undefined
  const toolTokens = estimateToolSchemaTokens(config.tools)
  const reserveTokens = contextLimit
    ? Math.min(DEFAULT_RESERVE_TOKENS, Math.floor(contextLimit * 0.1))
    : DEFAULT_RESERVE_TOKENS
  return {
    contextLimit,
    overheadTokens: toolTokens + reserveTokens,
  }
}

export function shouldPreemptivelyPrune(
  messages: readonly Message[],
  config: AgentConfig,
  contextLimitOverride?: number,
  options?: PreemptivePruningOptions,
): boolean {
  const { contextLimit, overheadTokens } = effectiveContextBudget(config, contextLimitOverride)
  if (!contextLimit) return false
  const softRatio = options?.softRatio ?? config.softThreshold ?? DEFAULT_SOFT_RATIO
  const preserveRecentGroups = options?.preserveRecentGroups ?? DEFAULT_PRESERVE_RECENT_GROUPS
  const minPruneChars = options?.minPruneChars ?? DEFAULT_MIN_PRUNE_CHARS
  const boundary = findPrunableBoundaryIndex(messages, preserveRecentGroups)
  if (boundary <= 0) return false

  const totalTokens = estimateMessageTokens(messages) + overheadTokens
  if (totalTokens < Math.floor(contextLimit * softRatio)) return false

  for (let i = 0; i < boundary; i += 1) {
    const msg = messages[i]!
    for (const item of msg.content) {
      if (
        item.type === 'tool_result' &&
        item.content.length >= minPruneChars &&
        !isAlreadyPrunedToolResult(item.content) &&
        !parseComputerScreenshotResult(item.content)
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Deterministically prune historical `tool_result` blocks older than the most
 * recent `preserveRecentGroups` assistant turns until estimated token usage drops
 * below `targetRatio * contextLimit` (or all eligible historical tool results
 * have been pruned).
 */
export function preemptivelyPruneToolResults(
  messages: readonly Message[],
  config: AgentConfig,
  contextLimitOverride?: number,
  options?: PreemptivePruningOptions,
): PreemptivePruningResult {
  const { contextLimit, overheadTokens } = effectiveContextBudget(config, contextLimitOverride)
  const tokensBefore = estimateMessageTokens(messages) + overheadTokens
  const softRatio = options?.softRatio ?? config.softThreshold ?? DEFAULT_SOFT_RATIO
  const targetRatio = options?.targetRatio ?? Math.min(softRatio, DEFAULT_TARGET_RATIO)
  const preserveRecentGroups = options?.preserveRecentGroups ?? DEFAULT_PRESERVE_RECENT_GROUPS
  const minPruneChars = options?.minPruneChars ?? DEFAULT_MIN_PRUNE_CHARS
  const stubHeadChars = options?.stubHeadChars ?? DEFAULT_STUB_HEAD_CHARS
  const stubTailChars = options?.stubTailChars ?? DEFAULT_STUB_TAIL_CHARS

  if (contextLimit && tokensBefore < Math.floor(contextLimit * softRatio)) {
    return {
      messages,
      pruned: false,
      prunedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      savedTokens: 0,
      entries: [],
    }
  }

  const boundary = findPrunableBoundaryIndex(messages, preserveRecentGroups)
  if (boundary <= 0) {
    return {
      messages,
      pruned: false,
      prunedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      savedTokens: 0,
      entries: [],
    }
  }

  const toolNames = collectToolNameByCallId(messages)
  const targetTokens = contextLimit ? Math.floor(contextLimit * targetRatio) : 0
  let runningTokens = tokensBefore
  let clonedMessages: Message[] | undefined
  const entries: PrunedToolResultEntry[] = []

  for (let i = 0; i < boundary; i += 1) {
    if (contextLimit && runningTokens <= targetTokens && entries.length > 0) {
      break
    }
    const msg = messages[i]!
    let clonedContent: MessageContent[] | undefined

    for (let j = 0; j < msg.content.length; j += 1) {
      if (contextLimit && runningTokens <= targetTokens && entries.length > 0) {
        break
      }
      const item = msg.content[j]!
      if (item.type !== 'tool_result') continue
      if (item.content.length < minPruneChars) continue
      if (isAlreadyPrunedToolResult(item.content)) continue
      if (parseComputerScreenshotResult(item.content)) continue

      const toolName = toolNames.get(item.callId) ?? 'unknown'
      const stub = buildPrunedToolResultStub(item.content, {
        callId: item.callId,
        toolName,
        headChars: stubHeadChars,
        tailChars: stubTailChars,
      })
      if (stub.length >= item.content.length) continue

      const originalBytes = Buffer.byteLength(item.content, 'utf8')
      const prunedBytes = Buffer.byteLength(stub, 'utf8')
      const charDelta = item.content.length - stub.length
      const estimatedSaved = Math.max(1, Math.floor(charDelta / 4))

      if (!clonedMessages) {
        clonedMessages = messages.slice()
      }
      if (!clonedContent) {
        clonedContent = msg.content.slice()
      }
      clonedContent[j] = {
        ...item,
        content: stub,
      }
      runningTokens = Math.max(overheadTokens, runningTokens - estimatedSaved)
      entries.push({
        messageIndex: i,
        contentIndex: j,
        callId: item.callId,
        toolName,
        originalBytes,
        prunedBytes,
      })
    }

    if (clonedContent && clonedMessages) {
      clonedMessages[i] = {
        ...msg,
        content: clonedContent,
      }
    }
  }

  if (!clonedMessages || entries.length === 0) {
    return {
      messages,
      pruned: false,
      prunedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      savedTokens: 0,
      entries: [],
    }
  }

  const tokensAfter = estimateMessageTokens(clonedMessages) + overheadTokens
  return {
    messages: clonedMessages,
    pruned: true,
    prunedCount: entries.length,
    tokensBefore,
    tokensAfter,
    savedTokens: Math.max(0, tokensBefore - tokensAfter),
    entries,
  }
}
