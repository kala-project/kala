import type { Message, ToolSchema } from '@agent-kernel/kernel'
import { parseComputerScreenshotResult } from './computer-use.js'

export type TokenEstimateBreakdown = {
  tokens: number
  rawChars: number
  adjustedChars: number
  reasonCodes: readonly string[]
}

const CHARS_PER_TOKEN = 4
const CJK_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/gu
const STRUCTURED_RE = /[{\[\]}`]|\|.*\||\b(?:SELECT|FROM|WHERE|JOIN|import|def|class|const|function|return)\b|\/[\w.-]+\//i

export function estimateStringTokens(text: string): number {
  return estimateStringTokenBreakdown(text).tokens
}

export function estimateStringTokenBreakdown(text: string): TokenEstimateBreakdown {
  if (text.length === 0) return { tokens: 0, rawChars: 0, adjustedChars: 0, reasonCodes: ['empty'] }
  const cjk = countMatches(text, CJK_RE)
  const rawChars = text.length
  const asciiLike = Math.max(0, rawChars - cjk)
  let adjustedChars = asciiLike + cjk * CHARS_PER_TOKEN
  const reasonCodes: string[] = []
  if (cjk > 0) reasonCodes.push('cjk_weighted')
  if (STRUCTURED_RE.test(text)) {
    adjustedChars = Math.ceil(adjustedChars * 1.2)
    reasonCodes.push('structured_text_margin')
  }
  return {
    tokens: Math.max(1, Math.ceil(adjustedChars / CHARS_PER_TOKEN)),
    rawChars,
    adjustedChars,
    reasonCodes,
  }
}

export function estimateMessageTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateOneMessageTokens(message), 0)
}

export function estimateToolSchemaTokens(tools: readonly ToolSchema[]): number {
  if (tools.length === 0) return 0
  return Math.ceil(estimateStringTokens(JSON.stringify(tools)) * 1.1)
}

export function estimateProviderRequestTokens(input: {
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  systemPrompt?: string
  provider?: string
}): number {
  const providerOverhead = input.provider === 'anthropic' ? 64 : input.provider === 'openai' ? 96 : 80
  return Math.ceil(
    estimateMessageTokens(input.messages) +
      estimateToolSchemaTokens(input.tools) +
      (input.systemPrompt ? estimateStringTokens(input.systemPrompt) : 0) +
      providerOverhead +
      input.messages.length * 8 +
      input.tools.length * 12,
  )
}

function estimateOneMessageTokens(message: Message): number {
  let tokens = 8 + estimateStringTokens(message.role)
  for (const content of message.content) tokens += estimateContentTokens(content)
  return tokens
}

function estimateContentTokens(content: Message['content'][number]): number {
  if (content.type === 'text' || content.type === 'thinking') return estimateStringTokens(content.text) + 4
  if (content.type === 'tool_call') {
    return estimateStringTokens(content.name) + estimateStringTokens(content.callId) + estimateStringTokens(JSON.stringify(content.input)) + 16
  }
  if (content.type === 'tool_result') {
    const image = content.ok ? parseComputerScreenshotResult(content.content) : undefined
    if (image) {
      const tiles = Math.ceil(image.width / 512) * Math.ceil(image.height / 512)
      return Math.max(85 + 170 * tiles, Math.ceil(image.width * image.height / 750)) + 128
    }
    return estimateStringTokens(content.callId) + estimateStringTokens(content.content) + 16
  }
  if (content.type === 'file') {
    return estimateStringTokens(content.name)
      + ('data' in content ? Math.ceil(content.data.length / 3) : Math.ceil(content.source.bytes / 4))
      + 32
  }
  if (content.source.kind === 'file_ref') return estimateStringTokens(content.source.path) + 32
  return Math.ceil(content.source.data.length / 3) + 32
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}
