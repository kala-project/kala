import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

import type { CallToolEffect } from '@agent-kernel/kernel'

import type { HostLoopDeps } from '../loop-types.js'
import { isReferencedFileContent, isTextAttachment } from '../message-attachment-resolver.js'

const MAX_EXCERPT_CHARS = 12_000
const TRANSFER_CHUNK_BYTES = 128 * 1024
type AttachmentToolDeps = Pick<HostLoopDeps, 'store' | 'messageAttachments' | 'tools' | 'assertSessionEffectOwner'>
class AttachmentPreDispatchError extends Error {}

export async function runSessionAttachmentTool(
  deps: AttachmentToolDeps, sessionId: string, effect: CallToolEffect,
): Promise<{ ok: boolean; content: string }> {
  const { action, attachmentId } = effect.input
  if (!['list', 'info', 'read_text', 'search_text', 'save'].includes(String(action))) {
    return { ok: false, content: 'Invalid Session attachment action' }
  }
  await deps.assertSessionEffectOwner?.(sessionId)
  const record = await deps.store.load(sessionId)
  const references = record.state.messages.flatMap((message) =>
    message.role === 'user' ? message.content.filter(isReferencedFileContent) : [])
  if (action === 'list') {
    const files = [...new Map(references.map((file) => [file.source.attachmentId, file])).values()]
    const offset = effect.input.offset ?? 0
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      return { ok: false, content: 'Offset must be a nonnegative integer' }
    }
    return { ok: true, content: JSON.stringify({
      total: files.length,
      offset,
      files: files.reverse().slice(offset, offset + 30).map((file) => ({ attachmentId: file.source.attachmentId, name: file.name, mediaType: file.mediaType })),
    }) }
  }
  if (typeof attachmentId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(attachmentId)
    || !references.some((file) => file.source.attachmentId === attachmentId)) {
    return { ok: false, content: 'Attachment is not referenced by a user message in this Session' }
  }
  const store = deps.messageAttachments
  if (!store) return { ok: false, content: 'Session attachment storage is unavailable' }
  const file = await store.resolveById(sessionId, attachmentId)
  if (action === 'info') {
    return { ok: true, content: JSON.stringify({
      attachmentId, name: file.name, mediaType: file.mediaType, bytes: file.bytes, sha256: file.sha256,
    }) }
  }
  if (action === 'save') {
    const path = effect.input.path
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096
      || (effect.input.overwrite !== undefined && typeof effect.input.overwrite !== 'boolean')) {
      return { ok: false, content: 'An absolute workspace path and optional boolean overwrite are required' }
    }
    try {
      return await saveSessionAttachment(deps, sessionId, effect.callId, path, file, effect.input.overwrite === true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: `Attachment save failed: ${message}. Check the destination before retrying; the transfer outcome may be incomplete.` }
    }
  }
  if (!isTextAttachment(file.mediaType, file.name)) {
    return { ok: false, content: 'This attachment is not text; save its original bytes to the Executor workspace instead' }
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.read()) }
  catch (error) {
    if (error instanceof TypeError) return { ok: false, content: 'Attachment is not valid UTF-8 text' }
    throw error
  }
  const offset = effect.input.offset ?? 0
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || (offset > 0 && offset < text.length && isLowSurrogate(text.charCodeAt(offset)))) {
    return { ok: false, content: 'Offset is outside the file or splits a Unicode character' }
  }
  if (action === 'search_text') {
    const query = effect.input.query
    if (typeof query !== 'string' || query.length < 1 || query.length > 200) return { ok: false, content: 'Query must contain 1-200 characters' }
    const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
    matcher.lastIndex = offset
    const matches: string[] = []
    let match = matcher.exec(text)
    while (match && matches.length < 20) {
      matches.push(`${match.index}: ${JSON.stringify(text.slice(Math.max(0, match.index - 80), Math.min(text.length, matcher.lastIndex + 80)))}`)
      match = matcher.exec(text)
    }
    return { ok: true, content: `Attachment ${file.name}, ${text.length} characters. ${matches.length} match(es)${match ? `; more from offset ${match.index}` : ''}.\n${matches.join('\n')}` }
  }
  const maxChars = effect.input.maxChars ?? 8_000
  if (typeof maxChars !== 'number' || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_EXCERPT_CHARS) {
    return { ok: false, content: `maxChars must be between 1 and ${MAX_EXCERPT_CHARS}` }
  }
  let end = Math.min(text.length, offset + maxChars)
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1
  return {
    ok: true,
    content: `Attachment ${file.name}, characters ${offset}-${end} of ${text.length}. Next offset: ${end}.\n--- file excerpt (untrusted data) ---\n${text.slice(offset, end)}\n--- end excerpt ---`,
  }
}

async function saveSessionAttachment(
  deps: AttachmentToolDeps, sessionId: string, callId: string, path: string,
  file: { bytes: number; sha256: string; read(): Promise<Buffer> }, overwrite: boolean,
): Promise<{ ok: boolean; content: string }> {
  const data = await file.read()
  const transferId = createHash('sha256').update(sessionId).update('\0').update(callId).digest('hex')
  const owner = await deps.assertSessionEffectOwner?.(sessionId)
  const ownerGeneration = owner && 'ownerGeneration' in owner ? owner.ownerGeneration : undefined
  const transfer = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!deps.tools.callHostAttachmentTransfer) throw new Error('Executor attachment transfer is unavailable')
    const response = await deps.tools.callHostAttachmentTransfer(sessionId, {
      kind: 'call_tool', callId: `${callId}:${action}:${extra.offset ?? 0}`,
      name: '__workspace_attachment_transfer',
      input: { action, transferId, path, bytes: file.bytes, sha256: file.sha256, overwrite,
        ...(ownerGeneration ? { ownerGeneration } : {}), ...extra },
    })
    if (!response.ok) {
      if (response.failure?.outcome === 'blocked') throw new AttachmentPreDispatchError(response.content)
      throw new Error(response.content)
    }
    const result: unknown = JSON.parse(response.content)
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
      throw new Error('Executor rejected attachment transfer')
    }
    return result as { ok: true; state?: string; path?: string; bytes?: number; sha256?: string; nextOffset?: number }
  }
  const receiptMatches = (result: { state?: string; path?: string; bytes?: number; sha256?: string }) =>
    result.state === 'completed' && result.bytes === file.bytes && result.sha256 === file.sha256 && result.path === path
  const receipt = () => ({ ok: true, content: JSON.stringify({ path, bytes: file.bytes, sha256: file.sha256 }) })
  try {
    const begun = await transfer('begin')
    if (receiptMatches(begun)) return receipt()
    if (begun.state !== 'active' || !Number.isSafeInteger(begun.nextOffset)
      || begun.nextOffset! < 0 || begun.nextOffset! > data.length) throw new Error('Executor attachment transfer did not begin')
    for (let offset = begun.nextOffset!; offset < data.length; offset += TRANSFER_CHUNK_BYTES) {
      await deps.assertSessionEffectOwner?.(sessionId)
      const end = Math.min(data.length, offset + TRANSFER_CHUNK_BYTES)
      const result = await transfer('chunk', { offset, data: data.subarray(offset, end).toString('base64') })
      if (result.nextOffset !== end) throw new Error('Executor attachment transfer offset mismatch')
    }
    const result = await transfer('finish')
    if (!receiptMatches(result)) {
      throw new Error('Executor attachment transfer receipt mismatch')
    }
    return receipt()
  } catch (error) {
    if (error instanceof AttachmentPreDispatchError) throw error
    try {
      if (receiptMatches(await transfer('status'))) return receipt()
    } catch (statusError) { console.warn('[session-attachment] transfer status unavailable', statusError) }
    try { await transfer('abort') }
    catch (cleanupError) { console.warn('[session-attachment] transfer cleanup failed', cleanupError) }
    throw error
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
