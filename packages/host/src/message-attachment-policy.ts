import type { IncomingHttpHeaders } from 'node:http'

import { DEFAULT_FILE_DECODED_BYTES, MAX_FILE_DECODED_BYTES } from '@agent-kernel/shared'

export function effectiveAttachmentLimit(headers: IncomingHttpHeaders, ingress: boolean): number {
  if (!ingress) return DEFAULT_FILE_DECODED_BYTES
  const value = headers['x-agent-runlab-attachment-max-bytes']
  if (value === undefined) return DEFAULT_FILE_DECODED_BYTES
  if (typeof value !== 'string' || ![DEFAULT_FILE_DECODED_BYTES, 4 * 1024 * 1024, 8 * 1024 * 1024, MAX_FILE_DECODED_BYTES].includes(Number(value))) {
    throw new Error('invalid organization attachment limit')
  }
  return Number(value)
}
