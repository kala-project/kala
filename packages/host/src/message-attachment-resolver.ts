import { TextDecoder } from 'node:util'

import type {
  Message,
  MessageContent,
  ReferencedFileContent,
} from '@agent-kernel/kernel'

import type { MessageAttachmentStorage } from './message-attachment-store.js'

export function isReferencedFileContent(content: MessageContent): content is ReferencedFileContent {
  return content.type === 'file' && 'source' in content && content.source.kind === 'host_ref'
}

export async function validateMessageAttachmentReferences(
  store: Pick<MessageAttachmentStorage, 'resolve'> | undefined,
  sessionId: string,
  content: readonly MessageContent[] | undefined,
): Promise<void> {
  for (const block of content ?? []) {
    if (!isReferencedFileContent(block)) continue
    if (!store) throw new Error(`Attachment "${block.name}" cannot be resolved because Host attachment storage is unavailable`)
    await store.resolve(sessionId, block)
  }
}

export async function resolveMessageAttachmentSdkFilePath(
  store: Pick<MessageAttachmentStorage, 'sdkFilePath'>,
  sessionId: string,
  file: ReferencedFileContent,
): Promise<string> {
  const path = await store.sdkFilePath(sessionId, file)
  if (!path) {
    throw new Error(`Attachment "${file.name}" cannot be exposed as a local SDK file; use byte-based attachment resolution`)
  }
  return path
}

export async function resolveKernelMessageAttachments(
  store: Pick<MessageAttachmentStorage, 'resolve'> | undefined,
  sessionId: string,
  messages: readonly Message[],
): Promise<readonly Message[]> {
  let changed = false
  const resolved: Message[] = []
  for (const message of messages) {
    const content: MessageContent[] = []
    for (const block of message.content) {
      if (!isReferencedFileContent(block)) {
        content.push(block)
        continue
      }
      if (!store) throw new Error(`Attachment "${block.name}" cannot be resolved because Host attachment storage is unavailable`)
      const data = await (await store.resolve(sessionId, block)).read()
      const imageType = supportedImageMediaType(block.mediaType)
      if (imageType) {
        content.push({ type: 'image', source: { kind: 'base64', mediaType: imageType, data: data.toString('base64') } })
      } else {
        const text = decodeTextAttachment(block, data)
        content.push({
          type: 'text',
          text: `--- attached file: ${block.name} (${block.mediaType}) ---\n${text}\n--- end attached file: ${block.name} ---`,
        })
      }
      changed = true
    }
    resolved.push(changed ? { ...message, content } : message)
  }
  return changed ? resolved : messages
}

export function assertKernelTextAttachment(file: Pick<ReferencedFileContent, 'name' | 'mediaType'>, data: Buffer): void {
  const imageType = supportedImageMediaType(file.mediaType)
  if (imageType) {
    assertImageAttachmentBytes(imageType, data)
    return
  }
  if (!isTextAttachment(file.mediaType, file.name) || containsBinaryBytes(data)) {
    throw new Error(`Kernel runtime cannot send binary attachment "${file.name}" (${file.mediaType}); use the Copilot runtime or attach a text-based file.`)
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Error(`Kernel runtime cannot decode attachment "${file.name}" as UTF-8 text; use the Copilot runtime or attach a UTF-8 text file.`)
  }
}

function decodeTextAttachment(file: ReferencedFileContent, data: Buffer): string {
  assertKernelTextAttachment(file, data)
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

export function supportedImageMediaType(mediaType: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif'
    ? mediaType
    : undefined
}

export function assertImageAttachmentBytes(mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: Buffer): void {
  const valid = mediaType === 'image/png'
    ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mediaType === 'image/jpeg'
      ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : mediaType === 'image/gif'
        ? data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')
        : data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!valid) throw new Error(`Attachment bytes do not match declared image type ${mediaType}`)
}

export function isTextAttachment(mediaType: string, name: string): boolean {
  if (mediaType.startsWith('text/')) return true
  if ([
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/typescript',
    'application/sql',
  ].includes(mediaType)) return true
  return /\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml)$/iu.test(name)
}

function containsBinaryBytes(data: Buffer): boolean {
  if (data.includes(0)) return true
  if (data.length === 0) return false
  let suspicious = 0
  for (const byte of data) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) suspicious += 1
  }
  return suspicious / data.length > 0.01
}
