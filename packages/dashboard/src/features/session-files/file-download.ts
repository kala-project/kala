import { downloadBlob } from '../../lib/save-file.js'

type DownloadableFileResult =
  | { kind: 'text'; content: string; size?: number; truncated?: boolean }
  | { kind: 'image' | 'pdf' | 'video'; content: string; mediaType: string; size?: number; truncated?: boolean }
  | { kind: 'binary'; content?: string; mediaType?: string; size?: number; truncated?: boolean }

export function fileResultDownloadBlob(result: DownloadableFileResult): { blob: Blob } | undefined {
  if (result.truncated) return undefined
  const blob = result.kind === 'text'
    ? new Blob([result.content], { type: 'text/plain;charset=utf-8' })
    : result.kind === 'binary'
      ? result.content ? base64Blob(result.content, result.mediaType ?? 'application/octet-stream') : undefined
      : base64Blob(result.content, result.mediaType)
  if (!blob || (result.size !== undefined && blob.size !== result.size)) return undefined
  return { blob }
}

export function saveBlob(blob: Blob, filename: string): void {
  downloadBlob(blob, filename)
}

export function downloadFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? 'download'
}

function base64Blob(content: string, mediaType: string): Blob {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}
