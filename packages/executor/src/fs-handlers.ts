/**
 * Filesystem RPC handlers on the executor side.
 *
 * The dashboard drives three read-only inspection endpoints — directory
 * picker, workspace file search, single-file view. They intentionally
 * bypass the LLM / tool_call path so the browser can show file trees
 * without cluttering the transcript. Each returns a well-formed payload
 * regardless of failure so the dashboard doesn't crash on a partial
 * response.
 *
 * A fourth endpoint — overflow file read — mirrors the same shape and
 * serves spill files produced by `tools/overflow.ts` (executor caps
 * in-history tool output at 32 KB; the rest lands on disk under
 * `<workspaceRoot>/.kala/overflow/<sessionId>/<callId>.txt` and the
 * dashboard fetches it lazily via `client:read_overflow`).
 *
 * All handlers respect `sandbox.roots` if configured, falling back to
 * `process.cwd()` when the executor was started without a jail.
 */

import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ClientReadOverflow,
  CreateDirectoryResult,
  CopyOverflowSession,
  CopyOverflowSessionResult,
  DeleteOverflowSession,
  DeleteOverflowSessionResult,
  DirListResult,
  FileListResult,
  OverflowContentsResult,
} from '@agent-kernel/shared'

import type { Sandbox } from './sandbox.js'
import { discoverWorkspaceFiles } from './workspace/files.js'

// ============================================================================
// listDirs — directory picker one-level-at-a-time
// ============================================================================

export async function listDirs(
  requestId: string,
  workspaceId: string,
  inputPath: string | undefined,
  sandbox: Sandbox,
): Promise<DirListResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const requested = inputPath && inputPath.trim().length > 0 ? inputPath : roots[0]!
  try {
    const resolved = await sandbox.resolve(requested)
    const entries = await readdir(resolved, { withFileTypes: true })
    const items = await Promise.all(entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map(async (entry) => {
        const path = join(resolved, entry.name)
        if (entry.isDirectory()) return { name: entry.name, path, type: 'directory' as const }
        const info = await stat(path).catch(() => undefined)
        return { name: entry.name, path, type: 'file' as const, ...(info ? { size: info.size } : {}) }
      }))
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return {
      requestId,
      workspaceId,
      path: resolved,
      roots,
      unrestricted: sandbox.roots.length === 0,
      entries: items,
    }
  } catch (err) {
    return {
      requestId,
      workspaceId,
      path: requested,
      roots,
      unrestricted: sandbox.roots.length === 0,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function createDirectory(
  requestId: string,
  workspaceId: string,
  parentPath: string,
  name: string,
  sandbox: Sandbox,
): Promise<CreateDirectoryResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const cleanName = name.trim()
  try {
    if (cleanName.length === 0 || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '.' || cleanName === '..' || cleanName.includes('\0')) {
      throw new Error('invalid folder name')
    }
    const parent = await sandbox.resolve(parentPath)
    const target = await sandbox.resolve(join(parent, cleanName))
    await mkdir(target, { recursive: false })
    return {
      requestId,
      workspaceId,
      path: target,
      parentPath: parent,
      roots,
      created: true,
    }
  } catch (err) {
    return {
      requestId,
      workspaceId,
      path: join(parentPath, cleanName),
      parentPath,
      roots,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ============================================================================
// listFiles — workspace file search (used by the @-mention picker)
// ============================================================================

const FILE_LIST_DEFAULT_LIMIT = 500
const FILE_LIST_MAX_LIMIT = 2000
const FILE_LIST_WALK_CEILING = 20000

type ListFilesPayload = {
  requestId: string
  workspaceId: string
  query?: string
  limit?: number
}

export async function listFiles(
  payload: ListFilesPayload,
  sandbox: Sandbox,
): Promise<FileListResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const rawLimit = payload.limit ?? FILE_LIST_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(FILE_LIST_MAX_LIMIT, rawLimit))
  const query = (payload.query ?? '').trim().toLowerCase()

  try {
    const result = await discoverWorkspaceFiles({
      roots,
      query,
      limit,
      walkCeiling: FILE_LIST_WALK_CEILING,
    })
    return {
      requestId: payload.requestId,
      workspaceId: payload.workspaceId,
      files: result.files,
      truncated: result.truncated,
    }
  } catch (err) {
    return {
      requestId: payload.requestId,
      workspaceId: payload.workspaceId,
      files: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ============================================================================
// readOverflowFile — dashboard "View full output" for spilled tool results
// ============================================================================

const OVERFLOW_READ_MAX_BYTES = 4 * 1024 * 1024

const OVERFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export async function readOverflowFile(
  payload: ClientReadOverflow,
  sandbox: Sandbox,
): Promise<OverflowContentsResult> {
  const { requestId, sessionId, callId } = payload
  const base = { requestId, sessionId, callId }
  if (!OVERFLOW_ID_PATTERN.test(sessionId) || !OVERFLOW_ID_PATTERN.test(callId)) {
    return { ...base, error: 'EINVAL: invalid session or call id' }
  }
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const workspaceRoot = roots[0]!
  const target = join(workspaceRoot, '.kala', 'overflow', sessionId, `${callId}.txt`)
  try {
    const resolved = await sandbox.resolve(target)
    const info = await stat(resolved)
    if (!info.isFile()) {
      return { ...base, error: 'ENOTFILE: overflow entry is not a regular file' }
    }
    if (info.size > OVERFLOW_READ_MAX_BYTES) {
      return { ...base, size: info.size, error: `EFBIG: overflow file is ${info.size} bytes (limit ${OVERFLOW_READ_MAX_BYTES})` }
    }
    const content = await readFile(resolved, 'utf8')
    return { ...base, content, size: info.size }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteOverflowSession(
  payload: DeleteOverflowSession,
  sandbox: Sandbox,
): Promise<DeleteOverflowSessionResult> {
  const { requestId, sessionId } = payload
  const base = { requestId, sessionId }
  if (!OVERFLOW_ID_PATTERN.test(sessionId)) {
    return { ...base, deleted: false, error: 'EINVAL: invalid session id' }
  }
  try {
    const target = await resolveOverflowSessionDir(sandbox, sessionId)
    await rm(target, { recursive: true, force: true })
    return { ...base, deleted: true }
  } catch (err) {
    return { ...base, deleted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function copyOverflowSession(
  payload: CopyOverflowSession,
  sandbox: Sandbox,
): Promise<CopyOverflowSessionResult> {
  const { requestId, sourceSessionId, targetSessionId } = payload
  const base = { requestId, sourceSessionId, targetSessionId }
  if (!OVERFLOW_ID_PATTERN.test(sourceSessionId) || !OVERFLOW_ID_PATTERN.test(targetSessionId)) {
    return { ...base, copied: false, error: 'EINVAL: invalid session id' }
  }
  try {
    const source = await resolveOverflowSessionDir(sandbox, sourceSessionId)
    const target = await resolveOverflowSessionDir(sandbox, targetSessionId)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: false }).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return
      throw err
    })
    return { ...base, copied: true }
  } catch (err) {
    return { ...base, copied: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function resolveOverflowSessionDir(sandbox: Sandbox, sessionId: string): Promise<string> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const workspaceRoot = roots[0]!
  return await sandbox.resolve(join(workspaceRoot, '.kala', 'overflow', sessionId))
}
