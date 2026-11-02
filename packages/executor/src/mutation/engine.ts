import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

import type { Sandbox } from '../sandbox.js'
import { SandboxError } from '../sandbox.js'
import { throwIfAborted, ToolError, type ToolContext } from '../tools/registry.js'
import { createUnifiedDiff } from './diff.js'
import { applyExactReplacements, type ExactReplacement } from './exact-replace.js'
import { withFileLock } from './locks.js'
import { parseFilePatch, type ParsedPatchOperation } from './patch-parser.js'
import { stringifyMutationResult, type FileChangeResult } from './result.js'
import { loadTextFile, normalizeLineEndings, serializeTextFile, MAX_TEXT_FILE_BYTES } from './text.js'

export type ResolvedMutationContext = Pick<ToolContext, 'sandbox' | 'cwd' | 'signal'>

export async function resolvePath(sandbox: Sandbox, path: string, cwd?: string): Promise<string> {
  try {
    return await sandbox.resolve(path, { cwd })
  } catch (err) {
    if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
    throw err
  }
}

export async function writeFileMutation(input: { path: string; content: string }, ctx: ResolvedMutationContext): Promise<string> {
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > MAX_TEXT_FILE_BYTES) throw new ToolError('E2BIG', `content exceeds size limit (${bytes} bytes)`)
  throwIfAborted(ctx as ToolContext)
  const resolved = await resolvePath(ctx.sandbox, input.path, ctx.cwd)
  return await withFileLock(resolved, async () => {
    const before = await maybeLoadExistingText(resolved)
    if (before?.isDirectory) throw new ToolError('EISDIR', `path is a directory: ${input.path}`)
    throwIfAborted(ctx as ToolContext)
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, input.content, 'utf8')
    const beforeText = before?.text ?? ''
    const stats = createUnifiedDiff(resolved, normalizeLineEndings(beforeText), normalizeLineEndings(input.content))
    return stringifyMutationResult({
      ok: true,
      summary: before ? `Modified ${resolved}` : `Created ${resolved}`,
      files: [{
        path: resolved,
        operation: before ? 'modified' : 'created',
        additions: stats.additions,
        deletions: stats.deletions,
        diff: stats.diff,
        ...(before ? { bytes_before: before.bytes } : {}),
        bytes_after: bytes,
      }],
    })
  })
}

export async function replaceInFileMutation(
  input: { path: string; edits: readonly ExactReplacement[]; expectedRevision?: string; noOpMode?: 'strict' | 'skip_noop' },
  ctx: ResolvedMutationContext,
): Promise<string> {
  throwIfAborted(ctx as ToolContext)
  const resolved = await resolvePath(ctx.sandbox, input.path, ctx.cwd)
  return await withFileLock(resolved, async () => {
    const source = await loadTextFile(resolved).catch((err) => mapLoadError(err, input.path))
    if (input.expectedRevision && input.expectedRevision !== revisionOf(source.bytes)) throw new ToolError('ESTALE', `revision mismatch for ${input.path}; expected ${input.expectedRevision}, current ${revisionOf(source.bytes)}; read it again and retry`)
    const bodyLf = normalizeLineEndings(source.body)
    const normalizedEdits = input.edits.map((edit) => ({
      ...edit,
      oldString: normalizeLineEndings(edit.oldString),
      newString: normalizeLineEndings(edit.newString),
    }))
    const effectiveEdits = input.noOpMode === 'skip_noop' ? normalizedEdits.filter((edit) => edit.oldString !== edit.newString) : normalizedEdits
    if (effectiveEdits.length === 0) return stringifyMutationResult({ ok: true, summary: `No changes needed in ${resolved}`, files: [] })
    const { text: nextBodyLf, counts } = applyExactReplacements(bodyLf, effectiveEdits)
    const nextText = serializeTextFile(nextBodyLf, source)
    throwIfAborted(ctx as ToolContext)
    const latest = await loadTextFile(resolved)
    if (!sameBytes(latest.bytes, source.bytes)) {
      throw new ToolError('ESTALE', `file changed while editing: ${input.path}; read it again and retry`)
    }
    await writeFile(resolved, nextText, 'utf8')
    const stats = createUnifiedDiff(resolved, bodyLf, nextBodyLf)
    return stringifyMutationResult({
      ok: true,
      summary: `Applied ${counts.reduce((sum, count) => sum + count, 0)} replacement(s) in ${resolved}`,
      files: [{
        path: resolved,
        operation: 'modified',
        additions: stats.additions,
        deletions: stats.deletions,
        diff: stats.diff,
        bytes_before: source.bytes.length,
        bytes_after: Buffer.byteLength(nextText, 'utf8'),
        replacements: counts.map((count, index) => ({ index, count })),
      }],
      ...(source.lineEnding === 'mixed' ? { warnings: [`${resolved} has mixed line endings; output preserves normalized LF for edited content`] } : {}),
    })
  })
}

export async function applyFilePatchMutation(input: { patch: string }, ctx: ResolvedMutationContext): Promise<string> {
  const operations = parseFilePatch(input.patch)
  if (operations.length === 0) throw new ToolError('EPATCHPARSE', 'patch contains no operations')
  const changes: FileChangeResult[] = []
  for (const operation of operations) {
    try {
      throwIfAborted(ctx as ToolContext)
      changes.push(await applyPatchOperation(operation, ctx))
    } catch (error) {
      if (changes.length === 0) throw error
      const fileIoError = error instanceof Error && 'errno' in error && typeof error.errno === 'number'
        && 'code' in error && typeof error.code === 'string'
      if (!(error instanceof ToolError) && !fileIoError) throw error
      throw new ToolError(error instanceof ToolError && error.code === 'ECANCELED' ? 'ECANCELED' : 'EPARTIAL',
        `${changes.length}/${operations.length} file operations applied; earlier changes remain applied (no cross-file rollback). Inspect the receipt and retry only remaining work.\nFailed operation: ${operation.kind} ${operation.path}\n${error.message}\n\n${stringifyMutationResult({ ok: true, summary: 'Already-applied file operations, not whole-patch success', files: changes })}`)
    }
  }
  return stringifyMutationResult({
    ok: true,
    summary: `Applied file patch to ${changes.length} file operation(s)`,
    files: changes,
  })
}

async function applyPatchOperation(operation: ParsedPatchOperation, ctx: ResolvedMutationContext): Promise<FileChangeResult> {
  const resolved = await resolvePath(ctx.sandbox, operation.path, ctx.cwd)
  return await withFileLock(resolved, async () => {
    if (operation.kind === 'add') {
      const exists = await stat(resolved).then(() => true, () => false)
      if (exists) throw new ToolError('EEXIST', `file already exists: ${operation.path}`)
      await mkdir(dirname(resolved), { recursive: true })
      throwIfAborted(ctx as ToolContext)
      await writeFile(resolved, operation.content, 'utf8')
      const stats = createUnifiedDiff(resolved, '', normalizeLineEndings(operation.content))
      return { path: resolved, operation: 'created', additions: stats.additions, deletions: stats.deletions, diff: stats.diff, bytes_after: Buffer.byteLength(operation.content, 'utf8') }
    }
    if (operation.kind === 'delete') {
      const source = await loadTextFile(resolved).catch((err) => mapLoadError(err, operation.path))
      throwIfAborted(ctx as ToolContext)
      await rm(resolved)
      const before = normalizeLineEndings(source.body)
      const stats = createUnifiedDiff(resolved, before, '')
      return { path: resolved, operation: 'deleted', additions: stats.additions, deletions: stats.deletions, diff: stats.diff, bytes_before: source.bytes.length, bytes_after: 0 }
    }
    if (operation.kind === 'move') {
      const target = await resolvePath(ctx.sandbox, operation.newPath, ctx.cwd)
      const exists = await stat(target).then(() => true, () => false)
      if (exists) throw new ToolError('EEXIST', `move target already exists: ${operation.newPath}`)
      await mkdir(dirname(target), { recursive: true })
      throwIfAborted(ctx as ToolContext)
      await rename(resolved, target)
      return { path: target, old_path: resolved, operation: 'moved', additions: 0, deletions: 0, diff: `rename ${resolved} => ${target}` }
    }
    const source = await loadTextFile(resolved).catch((err) => mapLoadError(err, operation.path))
    const bodyLf = normalizeLineEndings(source.body)
    const { text: nextBodyLf } = applyExactReplacements(bodyLf, operation.hunks.map((hunk) => ({
      oldString: normalizeLineEndings(hunk.oldText),
      newString: normalizeLineEndings(hunk.newText),
      replaceAll: false,
    })))
    const nextText = serializeTextFile(nextBodyLf, source)
    const latest = await loadTextFile(resolved)
    if (!sameBytes(latest.bytes, source.bytes)) {
      throw new ToolError('ESTALE', `file changed while applying patch: ${operation.path}; read it again and retry`)
    }
    throwIfAborted(ctx as ToolContext)
    await writeFile(resolved, nextText, 'utf8')
    const stats = createUnifiedDiff(resolved, bodyLf, nextBodyLf)
    return { path: resolved, operation: 'modified', additions: stats.additions, deletions: stats.deletions, diff: stats.diff, bytes_before: source.bytes.length, bytes_after: Buffer.byteLength(nextText, 'utf8') }
  })
}

async function maybeLoadExistingText(path: string): Promise<{ text: string; bytes: number; isDirectory: false } | { isDirectory: true } | null> {
  try {
    const s = await stat(path)
    if (s.isDirectory()) return { isDirectory: true }
    const loaded = await loadTextFile(path)
    return { text: loaded.body, bytes: loaded.bytes.length, isDirectory: false }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (err instanceof ToolError && err.code === 'ENOENT') return null
    throw err
  }
}

function mapLoadError(err: unknown, userPath: string): never {
  if (err instanceof ToolError) throw err
  const code = (err as NodeJS.ErrnoException).code ?? 'EIO'
  if (code === 'ENOENT') throw new ToolError('ENOENT', `file does not exist: ${userPath}`)
  if (code === 'EACCES') throw new ToolError('EACCES', `permission denied: ${userPath}`)
  throw new ToolError(code, `failed to read ${userPath}: ${(err as Error).message}`)
}

function revisionOf(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}
