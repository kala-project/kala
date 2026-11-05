export type SaveFileInput = {
  suggestedName: string
  blob: Blob
  mimeType?: string
  destination?: SaveFileDestination
}

export type SaveFileResult = 'saved' | 'downloaded' | 'cancelled'

export type SaveFileDestination =
  | { kind: 'file'; handle: FileSystemFileHandle }
  | { kind: 'browser' }
  | { kind: 'cancelled' }

type SavePickerWindow = Window & typeof globalThis & {
  showSaveFilePicker?: (options: { suggestedName: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>
}

export async function chooseSaveDestination(
  suggestedName: string,
  mimeType?: string,
  windowValue: SavePickerWindow = window as SavePickerWindow,
): Promise<SaveFileDestination> {
  const picker = windowValue.showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker({ suggestedName, types: filePickerTypes(suggestedName, mimeType ?? '') })
      return { kind: 'file', handle }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'cancelled' }
      return { kind: 'browser' }
    }
  }
  return { kind: 'browser' }
}

export async function saveFile(input: SaveFileInput, windowValue: SavePickerWindow = window as SavePickerWindow): Promise<SaveFileResult> {
  const destination = input.destination
    ?? (typeof windowValue.showSaveFilePicker === 'function'
      ? await chooseSaveDestination(input.suggestedName, input.mimeType ?? input.blob.type, windowValue)
      : { kind: 'browser' as const })
  if (destination.kind === 'cancelled') return 'cancelled'
  if (destination.kind === 'file') {
    const writable = await destination.handle.createWritable()
    await writable.write(input.blob)
    await writable.close()
    return 'saved'
  }
  downloadBlob(input.blob, input.suggestedName, windowValue)
  return 'downloaded'
}

export function downloadBlob(blob: Blob, filename: string, windowValue: Window = window): void {
  const url = URL.createObjectURL(blob)
  const anchor = windowValue.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  windowValue.document.body.append(anchor)
  anchor.click()
  windowValue.setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 60_000)
}

function filePickerTypes(filename: string, mimeType: string): Array<{ description: string; accept: Record<string, string[]> }> | undefined {
  const normalizedMimeType = mimeType.split(';', 1)[0]?.trim() ?? ''
  if (!normalizedMimeType) return undefined
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot) : ''
  return [{ description: normalizedMimeType, accept: { [normalizedMimeType]: extension ? [extension] : [] } }]
}
