import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'
import { readOneFile } from './read-file.js'

const MAX_FILES = 20
const DEFAULT_MAX_BYTES = 200_000
const HARD_MAX_BYTES = 1_000_000

type ReadFileEntry = { path: string; offset?: number; limit?: number }

export const readFilesTool: Tool = {
  name: 'read_files',
  async run(input, ctx) {
    const files = parseFiles(input)
    const requestedMax = optionalPositiveInt(input, 'max_bytes', 1) ?? DEFAULT_MAX_BYTES
    const maxBytes = Math.min(requestedMax, HARD_MAX_BYTES)
    const chunks: string[] = []
    let totalBytes = 0
    let attempted = 0
    let failed = 0
    let truncated = false
    for (const file of files) {
      throwIfAborted(ctx)
      if (totalBytes >= maxBytes) { truncated = true; break }
      let content: string
      try {
        content = await readOneFile(file, ctx)
      } catch (error) {
        throwIfAborted(ctx)
        if (error instanceof ToolError) {
          if (error.code === 'ECANCELED') throw error
        } else if (!(error instanceof Error && 'code' in error && typeof error.code === 'string'
          && ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EIO', 'EBUSY'].includes(error.code))) {
          throw error
        }
        failed++
        content = `ERROR: ${error.message}`
      }
      throwIfAborted(ctx)
      attempted++
      const chunk = `===== ${file.path} =====\n${content}`
      const separator = chunks.length > 0 ? '\n\n' : ''
      const remaining = maxBytes - totalBytes - Buffer.byteLength(separator, 'utf8')
      if (Buffer.byteLength(chunk, 'utf8') > remaining) {
        chunks.push(truncateUtf8(chunk, Math.max(0, remaining)))
        truncated = true
        break
      }
      chunks.push(chunk)
      totalBytes += Buffer.byteLength(separator + chunk, 'utf8')
    }
    let output = chunks.join('\n\n')
    let footer = failed ? `${failed}/${attempted} attempted files failed; successful sections are preserved within max_bytes. Retry failed/omitted ranges only.` : ''
    if (truncated || Buffer.byteLength(output + (footer ? `\n\n${footer}` : ''), 'utf8') > maxBytes) {
      footer = `... read_files output truncated at ${maxBytes} bytes ...\n${attempted}/${files.length} files attempted; ${files.length - attempted} not attempted. Request omitted ranges separately.${footer ? `\n${footer}` : ''}`
    }
    if (footer) {
      footer = truncateUtf8(footer, maxBytes)
      const room = Math.max(0, maxBytes - Buffer.byteLength(footer, 'utf8') - 2)
      const body = truncateUtf8(output, room)
      output = body ? `${body}\n\n${footer}` : footer
    }
    if (failed) throw new ToolError('EPARTIAL', output)
    return output
  },
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  // UTF-8 continuation bytes cannot begin a decoded suffix. Back up to the
  // start of the final code point so truncation never emits U+FFFD.
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function parseFiles(input: Record<string, unknown>): ReadFileEntry[] {
  const raw = input['files']
  if (!Array.isArray(raw)) throw new ToolError('EINVAL', 'missing or non-array field "files"')
  if (raw.length === 0) throw new ToolError('EINVAL', 'files must not be empty')
  if (raw.length > MAX_FILES) throw new ToolError('E2BIG', `read_files supports at most ${MAX_FILES} files`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError('EINVAL', `files[${index}] must be an object`)
    const record = item as Record<string, unknown>
    const path = requireString(record, 'path')
    const offset = optionalPositiveInt(record, 'offset', 0)
    const limit = optionalPositiveInt(record, 'limit', 1)
    return { path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }
  })
}
