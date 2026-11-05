/**
 * Tool-output overflow: cap in-history bytes, spill full content to disk.
 *
 * The kernel/executor loop wraps every tool run in `runOne`. That wrapper
 * calls `maybeOverflow` between the tool's completion and the tool-result
 * ack. If the tool produced more than `inlineBytes`
 * of output, the full text is written to
 * `<overflowDir>/<sessionId>/<callId>.txt` and the on-wire content is
 * replaced with a head+tail preview plus a truncation marker naming the spill
 * file. See docs/host/tool-output-overflow.md for the design.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type OverflowConfig = {
  /** Byte threshold above which output is spilled to disk. */
  inlineBytes: number
  /** Preview head+tail size for spilled outputs (line count). */
  previewLines: number
  /**
   * Base overflow directory. Files land at
   * `<overflowDir>/<sessionId>/<callId>.txt`.
   */
  overflowDir: string
}

export type OverflowContext = {
  sessionId: string
  callId: string
  config: OverflowConfig
}

export type OverflowResult = {
  /** What goes on the wire. Identical to input when no overflow occurred. */
  content: string
  overflowed: boolean
  /** Original UTF-8 byte length (before any truncation). Useful for telemetry. */
  fullBytes: number
  /** Full-file path when overflowed; undefined otherwise. */
  filePath?: string
}

export const DEFAULT_INLINE_BYTES = 32 * 1024
export const DEFAULT_PREVIEW_LINES = 400

export function overflowConfigFromEnv(overflowDir: string): OverflowConfig {
  const envInline = process.env.KALA_OVERFLOW_INLINE_BYTES
  const envPreview = process.env.KALA_OVERFLOW_PREVIEW_LINES
  const inlineBytes = envInline ? Number(envInline) : DEFAULT_INLINE_BYTES
  const previewLines = envPreview ? Number(envPreview) : DEFAULT_PREVIEW_LINES
  return {
    inlineBytes: Number.isFinite(inlineBytes) && inlineBytes >= 0 ? inlineBytes : DEFAULT_INLINE_BYTES,
    previewLines: Number.isFinite(previewLines) && previewLines > 0 ? previewLines : DEFAULT_PREVIEW_LINES,
    overflowDir,
  }
}

/**
 * Byte length of a UTF-8 string. Matches the host-side context estimator's
 * rough input sizing.
 */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000
}

function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0b1000_0000) === 0) return 1
  if ((leadByte & 0b1110_0000) === 0b1100_0000) return 2
  if ((leadByte & 0b1111_0000) === 0b1110_0000) return 3
  if ((leadByte & 0b1111_1000) === 0b1111_0000) return 4
  return 1
}

/**
 * Find the largest byte index <= `maxEnd` that ends on a complete UTF-8
 * codepoint boundary.
 */
export function safeUtf8HeadEnd(buf: Buffer, maxEnd: number): number {
  const end = Math.max(0, Math.min(buf.length, maxEnd))
  if (end === 0 || end === buf.length) return end
  if (!isContinuationByte(buf[end]!)) return end
  let lead = end - 1
  while (lead > 0 && isContinuationByte(buf[lead]!)) {
    lead -= 1
  }
  const seqLen = utf8SequenceLength(buf[lead]!)
  return lead + seqLen <= end ? end : lead
}

/**
 * Find the smallest byte index >= `minStart` that begins on a valid UTF-8
 * leading byte.
 */
export function safeUtf8TailStart(buf: Buffer, minStart: number): number {
  let start = Math.max(0, Math.min(buf.length, minStart))
  while (start < buf.length && isContinuationByte(buf[start]!)) {
    start += 1
  }
  return start
}

/**
 * Slice a UTF-8 string to fit within `maxBytes` while preserving BOTH the
 * head and the tail on valid UTF-8 codepoint boundaries.
 */
export function sliceHeadTailUtf8(full: string, maxBytes: number): string {
  const buf = Buffer.from(full, 'utf8')
  if (buf.length <= maxBytes) return full
  if (maxBytes <= 0) return ''

  // Reserve room for the inline byte-omission marker when budget allows.
  const markerReserve = Math.min(96, Math.floor(maxBytes * 0.35))
  const contentBudget = Math.max(2, maxBytes - markerReserve)
  const rawHeadBudget = Math.max(1, Math.ceil(contentBudget / 2))
  const rawTailBudget = Math.max(1, contentBudget - rawHeadBudget)

  const headEnd = safeUtf8HeadEnd(buf, rawHeadBudget)
  const tailStart = Math.max(headEnd, safeUtf8TailStart(buf, buf.length - rawTailBudget))
  const omittedBytes = Math.max(0, tailStart - headEnd)
  if (omittedBytes === 0) return full

  const headStr = buf.subarray(0, headEnd).toString('utf8')
  const tailStr = buf.subarray(tailStart).toString('utf8')
  const marker = `\n[... ${omittedBytes} bytes omitted ...]\n`
  const combined = `${headStr}${marker}${tailStr}`
  if (byteLength(combined) <= maxBytes) return combined

  // Extremely small inlineBytes fallback: keep head+tail without multi-line marker if needed.
  const compactMarker = `[...${omittedBytes}B...]`
  const compactBudget = Math.max(0, maxBytes - byteLength(compactMarker))
  const compactHead = safeUtf8HeadEnd(buf, Math.ceil(compactBudget / 2))
  const compactTail = Math.max(compactHead, safeUtf8TailStart(buf, buf.length - Math.floor(compactBudget / 2)))
  if (compactHead === 0 && compactTail === buf.length) {
    return buf.subarray(0, safeUtf8HeadEnd(buf, maxBytes)).toString('utf8')
  }
  return `${buf.subarray(0, compactHead).toString('utf8')}${compactMarker}${buf.subarray(compactTail).toString('utf8')}`
}

type PreviewSelection = {
  text: string
  previewLines: number
  omittedStartLine?: number
  omittedLineCount?: number
}

/**
 * Truncate to at most `lines` preview lines AND `inlineBytes` UTF-8 bytes,
 * preserving both the beginning and the end. Command output usually explains
 * setup at the top and the decisive error or summary at the bottom.
 */
function buildPreview(full: string, lines: number, inlineBytes: number): PreviewSelection {
  const parts = full.split('\n')
  const totalLines = parts.length
  let candidate = full
  let omittedStartLine: number | undefined
  let omittedLineCount: number | undefined
  let keptLines = totalLines

  if (lines > 0 && totalLines > lines) {
    const headLines = Math.max(1, Math.ceil(lines / 2))
    const tailLines = Math.max(1, lines - headLines)
    const omitted = Math.max(0, totalLines - headLines - tailLines)
    omittedStartLine = headLines
    omittedLineCount = omitted
    keptLines = headLines + tailLines
    candidate = [
      ...parts.slice(0, headLines),
      `[... ${omitted} lines omitted (lines ${headLines + 1}-${totalLines - tailLines}) ...]`,
      ...parts.slice(-tailLines),
    ].join('\n')
  }

  // Edge: a single "line" (e.g. one huge JSON blob) or long lines cause the
  // line-truncated preview to still exceed `inlineBytes`. Slice Head+Tail by
  // UTF-8 byte budget so the tail (decisive error/summary) is never lost.
  if (byteLength(candidate) > inlineBytes && inlineBytes > 0) {
    const byteSliced = sliceHeadTailUtf8(full, inlineBytes)
    return {
      text: byteSliced,
      previewLines: 0,
      omittedStartLine: 0,
      omittedLineCount: totalLines,
    }
  }

  return {
    text: candidate,
    previewLines: keptLines,
    ...(omittedStartLine !== undefined ? { omittedStartLine } : {}),
    ...(omittedLineCount !== undefined ? { omittedLineCount } : {}),
  }
}

/**
 * The dashboard scans the final 512 characters for the sentinel, so the
 * unbounded path-bearing hint must precede it.
 */
export function overflowMarker(
  filePath: string,
  callId: string,
  previewLines: number,
  totalLines: number,
  previewBytes: number,
  totalBytes: number,
  omittedStartLine?: number,
  omittedLineCount?: number,
): string {
  const nextOffset = omittedStartLine ?? Math.max(0, Math.floor(previewLines / 2))
  const nextLimit = omittedLineCount !== undefined ? Math.min(200, Math.max(1, omittedLineCount)) : 200
  return [
    `--- use \`read_file { path: '${filePath}', offset: ${nextOffset}, limit: ${nextLimit} }\` or \`multi_grep { searches: [{ pattern: '<pattern>', path: '${filePath}' }] }\` to read more`,
    `--- output truncated: ${previewLines} / ${totalLines} lines, ${previewBytes} / ${totalBytes} bytes stored at overflow://${callId}`,
  ].join('\n')
}

export async function maybeOverflow(
  full: string,
  ctx: OverflowContext,
): Promise<OverflowResult> {
  const { inlineBytes, previewLines, overflowDir } = ctx.config
  const fullBytes = byteLength(full)
  if (inlineBytes === 0 || fullBytes <= inlineBytes) {
    return { content: full, overflowed: false, fullBytes }
  }

  const filePath = join(overflowDir, ctx.sessionId, `${ctx.callId}.txt`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, full, 'utf8')

  const selection = buildPreview(full, previewLines, inlineBytes)
  const totalLines = full.split('\n').length
  const previewByteCount = byteLength(selection.text)
  const marker = overflowMarker(
    filePath,
    ctx.callId,
    selection.previewLines,
    totalLines,
    previewByteCount,
    fullBytes,
    selection.omittedStartLine,
    selection.omittedLineCount,
  )
  return {
    content: `${selection.text}\n\n${marker}`,
    overflowed: true,
    fullBytes,
    filePath,
  }
}
