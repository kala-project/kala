import { ToolError } from '../tools/registry.js'

export type ParsedPatchOperation =
  | { readonly kind: 'add'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'move'; readonly path: string; readonly newPath: string }
  | { readonly kind: 'update'; readonly path: string; readonly hunks: readonly { oldText: string; newText: string }[] }

export function parseFilePatch(input: string): ParsedPatchOperation[] {
  const lines = input.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '*** Begin Patch') throw new ToolError('EPATCHPARSE', 'patch must start with *** Begin Patch')
  const ops: ParsedPatchOperation[] = []
  let i = 1
  while (i < lines.length) {
    const line = lines[i]
    if (line === '*** End Patch') return ops
    if (line?.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim()
      i++
      const body: string[] = []
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const item = lines[i]!
        if (!item.startsWith('+')) throw new ToolError('EPATCHPARSE', `add file lines must start with + for ${path}`)
        body.push(item.slice(1))
        i++
      }
      ops.push({ kind: 'add', path, content: body.join('\n') + (body.length > 0 ? '\n' : '') })
      continue
    }
    if (line?.startsWith('*** Delete File: ')) {
      ops.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() })
      i++
      continue
    }
    if (line?.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim()
      i++
      if (lines[i]?.startsWith('*** Move to: ')) {
        ops.push({ kind: 'move', path, newPath: lines[i]!.slice('*** Move to: '.length).trim() })
        i++
        continue
      }
      const hunks: { oldText: string; newText: string }[] = []
      let oldLines: string[] = []
      let newLines: string[] = []
      const flushHunk = (): void => {
        if (oldLines.length === 0 && newLines.length === 0) return
        hunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') })
        oldLines = []
        newLines = []
      }
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const item = lines[i]!
        if (item.startsWith('@@')) {
          flushHunk()
          i++
          continue
        }
        if (item.startsWith(' ')) {
          oldLines.push(item.slice(1))
          newLines.push(item.slice(1))
        } else if (item.startsWith('-')) {
          oldLines.push(item.slice(1))
        } else if (item.startsWith('+')) {
          newLines.push(item.slice(1))
        } else if (item.length === 0) {
          oldLines.push('')
          newLines.push('')
        } else {
          throw new ToolError('EPATCHPARSE', `invalid update line for ${path}: ${item}`)
        }
        i++
      }
      flushHunk()
      if (hunks.length === 0) throw new ToolError('EPATCHPARSE', `empty update hunk for ${path}`)
      ops.push({ kind: 'update', path, hunks })
      continue
    }
    if (line === '') {
      i++
      continue
    }
    throw new ToolError('EPATCHPARSE', `unexpected patch line: ${line}`)
  }
  throw new ToolError('EPATCHPARSE', 'patch must end with *** End Patch')
}
