import type { FileContent, ImageContent, MessageContent } from '@agent-kernel/kernel'

export const SOCKET_MAX_HTTP_BUFFER_BYTES = 8 * 1024 * 1024
export const CLIENT_MESSAGE_SAFE_BYTES = 6 * 1024 * 1024
export const MAX_MESSAGE_IMAGES = 4
export const MAX_IMAGE_DECODED_BYTES = 2 * 1024 * 1024
export const MAX_MESSAGE_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_MESSAGE_FILES = 8
export const DEFAULT_FILE_DECODED_BYTES = 2 * 1024 * 1024
export const MAX_FILE_DECODED_BYTES = 16 * 1024 * 1024
export const MAX_MESSAGE_FILE_BYTES = 16 * 1024 * 1024
export const IMAGE_COMPRESSION_MAX_EDGE = 2048
export const IMAGE_COMPRESSION_QUALITY = 0.82

export type ImageMessagePolicyErrorCode =
  | 'IMAGE_COUNT_EXCEEDED'
  | 'IMAGE_INVALID_BASE64'
  | 'IMAGE_TOO_LARGE'
  | 'MESSAGE_IMAGES_TOO_LARGE'
  | 'FILE_COUNT_EXCEEDED'
  | 'FILE_INVALID_BASE64'
  | 'FILE_TOO_LARGE'
  | 'MESSAGE_FILES_TOO_LARGE'
  | 'MESSAGE_PAYLOAD_TOO_LARGE'

export type ImageMessagePolicyError = {
  code: ImageMessagePolicyErrorCode
  message: string
}

export type ImageMessagePolicyResult = {
  ok: true
  imageCount: number
  decodedImageBytes: number
} | {
  ok: false
  error: ImageMessagePolicyError
}

export type FileMessagePolicyResult = {
  ok: true
  fileCount: number
  decodedFileBytes: number
} | {
  ok: false
  error: ImageMessagePolicyError
}

export function decodedBase64Bytes(value: string): number | null {
  if (value.length === 0) return 0
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = (value.length / 4) * 3 - padding
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

export function validateInlineMessageImages(content: readonly MessageContent[] | undefined): ImageMessagePolicyResult {
  const images = (content ?? []).filter((block): block is ImageContent => block.type === 'image')
  if (images.length > MAX_MESSAGE_IMAGES) {
    return failure('IMAGE_COUNT_EXCEEDED', `A message can contain at most ${MAX_MESSAGE_IMAGES} images.`)
  }

  let total = 0
  for (const image of images) {
    if (image.source.kind !== 'base64') continue
    const bytes = decodedBase64Bytes(image.source.data)
    if (bytes === null) return failure('IMAGE_INVALID_BASE64', 'An attached image contains invalid base64 data.')
    if (bytes > MAX_IMAGE_DECODED_BYTES) {
      return failure('IMAGE_TOO_LARGE', `Each compressed image must be at most ${formatMiB(MAX_IMAGE_DECODED_BYTES)}.`)
    }
    if (detectBase64ImageMediaType(image.source.data) !== image.source.mediaType) {
      return failure('IMAGE_INVALID_BASE64', `An attached ${image.source.mediaType} image has invalid file content.`)
    }
    total += bytes
    if (total > MAX_MESSAGE_IMAGE_BYTES) {
      return failure('MESSAGE_IMAGES_TOO_LARGE', `Images in one message must total at most ${formatMiB(MAX_MESSAGE_IMAGE_BYTES)}.`)
    }
  }
  return { ok: true, imageCount: images.length, decodedImageBytes: total }
}

export function validateInlineMessageFiles(content: readonly MessageContent[] | undefined, maxFileBytes = DEFAULT_FILE_DECODED_BYTES): FileMessagePolicyResult {
  const files = (content ?? []).filter((block): block is FileContent => block.type === 'file')
  if (files.length > MAX_MESSAGE_FILES) {
    return failure('FILE_COUNT_EXCEEDED', `A message can contain at most ${MAX_MESSAGE_FILES} files.`)
  }
  let total = 0
  for (const file of files) {
    const bytes = 'source' in file ? file.source.bytes : decodedBase64Bytes(file.data)
    if (bytes === null) return failure('FILE_INVALID_BASE64', `Attached file "${file.name}" contains invalid base64 data.`)
    if (bytes > maxFileBytes) {
      return failure('FILE_TOO_LARGE', `Each attached file must be at most ${formatMiB(maxFileBytes)}.`)
    }
    total += bytes
    if (total > Math.max(4 * 1024 * 1024, maxFileBytes)) {
      return failure('MESSAGE_FILES_TOO_LARGE', `Files in one message must total at most ${formatMiB(Math.max(4 * 1024 * 1024, maxFileBytes))}.`)
    }
  }
  return { ok: true, fileCount: files.length, decodedFileBytes: total }
}

export function encodedJsonBytes(value: unknown): number {
  const json = JSON.stringify(value)
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).byteLength
  return json.length
}

export function validateClientMessagePayload(value: unknown): ImageMessagePolicyError | null {
  const bytes = encodedJsonBytes(value)
  if (bytes <= CLIENT_MESSAGE_SAFE_BYTES) return null
  return {
    code: 'MESSAGE_PAYLOAD_TOO_LARGE',
    message: `This message is ${formatMiB(bytes)} after encoding; the maximum is ${formatMiB(CLIENT_MESSAGE_SAFE_BYTES)}. Remove or compress an attachment and try again.`,
  }
}

export function detectBase64ImageMediaType(base64: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  const bytes = decodePrefix(base64, 12)
  if (bytes.length === 0) return null
  if (has(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (has(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(bytes, 6) === 'GIF87a' || ascii(bytes, 6) === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 4) === 'RIFF' && ascii(bytes.slice(8), 4) === 'WEBP') return 'image/webp'
  return null
}

function decodePrefix(base64: string, limit: number): Uint8Array {
  const prefix = base64.slice(0, Math.ceil(limit / 3) * 4)
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(prefix, 'base64').subarray(0, limit))
  try {
    return Uint8Array.from(atob(prefix).slice(0, limit), (char) => char.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

function has(actual: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => actual[index] === value)
}

function ascii(bytes: Uint8Array, length: number): string {
  return String.fromCharCode(...bytes.slice(0, length))
}

function failure(code: ImageMessagePolicyErrorCode, message: string): { ok: false; error: ImageMessagePolicyError } {
  return { ok: false, error: { code, message } }
}

function formatMiB(bytes: number): string {
  const value = bytes / (1024 * 1024)
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} MiB`
}
