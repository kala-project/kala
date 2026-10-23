/**
 * Client-side git status, diff, and read-only commit history on workspace:exec.
 *
 * Domain-of-one-package rule (see docs/planning/roadmap-notes/workspace-
 * exec-refactor.md): the executor no longer parses porcelain v1; that
 * lives here next to the panel that renders it. The wire types
 * (GitFileChange / GitStatusResult / GitDiffResult) stay in shared so
 * the component layer doesn't have to change.
 *
 * Behaviour matches the executor implementation this replaces:
 *
 * - `git rev-parse --show-toplevel` locates the repo root before running
 *   `git status --porcelain=v1 -z --branch` in that root.
 * - Diff reads three sides via `git show` (`HEAD:path`, `:path`) and one
 *   workspace read for the worktree file. `:path` for untracked files is
 *   the empty side.
 * - Same caps: 1000 files, 512KB per diff side, 5s status timeout,
 *   8s diff timeout.
 * - History reads 30 commits per page from a pinned HEAD, with 2MB command
 *   output caps and 8s timeouts. Commit patches are capped at 512KB/10,000 lines and
 *   never shown partially. Roots compare with the empty tree; merges
 *   compare with their first parent. No shell, pager, external diff, or
 *   text conversion is used by the history queries.
 */

import type {
  ClientGitDiff,
  ClientGitStatus,
  GitDiffResult,
  GitFileChange,
  GitFileStatus,
  GitStatusResult,
} from '@agent-kernel/shared'

import { workspaceExec, workspaceReadBinary, type WorkspaceSocket } from './workspace-exec.js'

const STATUS_TIMEOUT_MS = 5_000
const DIFF_TIMEOUT_MS = 8_000
const STATUS_MAX_BYTES = 2 * 1024 * 1024
const DIFF_MAX_BYTES = 512 * 1024
const MAX_STATUS_FILES = 1_000

export type GitReadError = {
  code: 'not_git_repo' | 'git_unavailable' | 'executor_unavailable' | 'timeout' | 'too_large' | 'invalid_request' | 'internal_error'
  message: string
}
export type GitReadResult<T> = { ok: true; value: T } | { ok: false; error: GitReadError }
export type GitCommit = {
  hash: string
  parents: string[]
  authorName: string
  authorEmail: string
  authoredAt: string
  committerName: string
  committerEmail: string
  committedAt: string
  message: string
}
export type GitHistoryPage = { commits: GitCommit[]; anchor?: string; nextOffset?: number }
export type GitCommitFile = { path: string; oldPath?: string; status: string }
export type GitCommitDetails = { commit: GitCommit; files: GitCommitFile[]; filesTruncated: boolean }
export type GitCommitPatch = { text: string; binary: boolean; truncated: boolean }
type GitReadOptions = { workspaceId: string; cwd?: string }
const HISTORY_PAGE_SIZE = 30
const MAX_PATCH_LINES = 10_000
const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B'
const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
// Never invoke a configured pager, external diff helper, or text conversion.
const READ_GIT = ['git', '--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.quotePath=true', '-c', 'i18n.logOutputEncoding=UTF-8']

async function gitReadCommand(socket: WorkspaceSocket, options: GitReadOptions, args: string[], maxOutputBytes = STATUS_MAX_BYTES, exitErrorCode: GitReadError['code'] = 'internal_error'): Promise<GitReadResult<string>> {
  if (socket.connected === false) return { ok: false, error: { code: 'executor_unavailable', message: 'Workspace connection is offline.' } }
  try {
    const result = await workspaceExec(socket, options.workspaceId, [...READ_GIT, ...args], {
      cwd: options.cwd, timeoutMs: DIFF_TIMEOUT_MS, maxOutputBytes,
    })
    if (result.error) {
      const code = result.error.code === 'ETIMEDOUT' ? 'timeout'
        : result.error.code === 'ENOENT' ? 'git_unavailable'
          : result.error.code === 'EACCES' ? 'executor_unavailable' : 'internal_error'
      return { ok: false, error: { code, message: result.error.message.slice(0, 500) } }
    }
    if (result.truncated) return { ok: false, error: { code: 'too_large', message: 'Git output exceeds the display limit.' } }
    if (result.exitCode !== 0) return { ok: false, error: { code: exitErrorCode, message: result.stderr.trim().slice(0, 500) || 'Git read failed.' } }
    return { ok: true, value: result.stdout }
  } catch (error) {
    return { ok: false, error: { code: 'executor_unavailable', message: error instanceof Error ? error.message.slice(0, 500) : 'Workspace Executor is unavailable.' } }
  }
}

async function gitReadRoot(socket: WorkspaceSocket, options: GitReadOptions): Promise<GitReadResult<string>> {
  const root = await gitReadCommand(socket, options, ['rev-parse', '--show-toplevel'], STATUS_MAX_BYTES, 'not_git_repo')
  return root.ok ? { ok: true, value: root.value.replace(/\r?\n$/u, '') } : root
}

function invalidGitRequest(): GitReadResult<never> {
  return { ok: false, error: { code: 'invalid_request', message: 'Invalid commit, pagination, or file selection.' } }
}

export function parseGitCommits(raw: string): GitCommit[] {
  const fields = raw.split('\0')
  const commits: GitCommit[] = []
  for (let i = 0; i + 8 < fields.length; i += 9) {
    const hash = fields[i]!.trim()
    if (!HASH_PATTERN.test(hash)) continue
    commits.push({
      hash, parents: fields[i + 1]!.split(' ').filter(Boolean),
      authorName: fields[i + 2]!, authorEmail: fields[i + 3]!, authoredAt: fields[i + 4]!,
      committerName: fields[i + 5]!, committerEmail: fields[i + 6]!, committedAt: fields[i + 7]!,
      message: fields[i + 8]!,
    })
  }
  return commits
}

export async function gitHistory(socket: WorkspaceSocket, options: GitReadOptions & { anchor?: string; offset?: number }): Promise<GitReadResult<GitHistoryPage>> {
  const offset = options.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || (options.anchor && !HASH_PATTERN.test(options.anchor))) return invalidGitRequest()
  const root = await gitReadRoot(socket, options)
  if (!root.ok) return root
  const rooted = { ...options, cwd: root.value }
  let anchor = options.anchor
  if (!anchor) {
    const head = await gitReadCommand(socket, rooted, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!head.ok) {
      // --quiet emits no stderr only when HEAD does not yet name a commit.
      if (head.error.code === 'internal_error' && head.error.message === 'Git read failed.') return { ok: true, value: { commits: [] } }
      return head
    }
    anchor = head.value.trim()
    if (!HASH_PATTERN.test(anchor)) return invalidGitRequest()
  }
  const log = await gitReadCommand(socket, rooted, ['log', '--no-show-signature', '-z', `--format=${COMMIT_FORMAT}`, `--max-count=${HISTORY_PAGE_SIZE + 1}`, `--skip=${offset}`, anchor, '--'])
  if (!log.ok) return log
  const commits = parseGitCommits(log.value)
  return { ok: true, value: { commits: commits.slice(0, HISTORY_PAGE_SIZE), anchor, ...(commits.length > HISTORY_PAGE_SIZE ? { nextOffset: offset + HISTORY_PAGE_SIZE } : {}) } }
}

export function parseGitCommitFiles(raw: string): GitCommitFile[] {
  const fields = raw.split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!.trim()
    if (!status) continue
    const firstPath = fields[i++]
    if (firstPath === undefined) break
    if (/^[RC]/u.test(status)) {
      const path = fields[i++]
      if (path === undefined) break
      files.push({ status, oldPath: firstPath, path })
    } else files.push({ status, path: firstPath })
  }
  return files
}

export async function gitCommitDetails(socket: WorkspaceSocket, options: GitReadOptions & { hash: string }): Promise<GitReadResult<GitCommitDetails>> {
  if (!HASH_PATTERN.test(options.hash)) return invalidGitRequest()
  const root = await gitReadRoot(socket, options)
  if (!root.ok) return root
  const rooted = { ...options, cwd: root.value }
  const metadata = await gitReadCommand(socket, rooted, ['log', '-1', '--no-show-signature', '-z', `--format=${COMMIT_FORMAT}`, options.hash, '--'])
  if (!metadata.ok) return metadata
  const commit = parseGitCommits(metadata.value)[0]
  if (!commit) return invalidGitRequest()
  // A merge is compared with its first parent; a root is compared with the empty tree.
  const revisions = commit.parents[0] ? [commit.parents[0], commit.hash] : [commit.hash]
  const changed = await gitReadCommand(socket, rooted, ['diff-tree', '--root', '--no-commit-id', '-r', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', ...revisions, '--'])
  if (!changed.ok) return changed
  const files = parseGitCommitFiles(changed.value)
  return { ok: true, value: { commit, files: files.slice(0, MAX_STATUS_FILES), filesTruncated: files.length > MAX_STATUS_FILES } }
}

export async function gitCommitDiff(socket: WorkspaceSocket, options: GitReadOptions & { hash: string; file: GitCommitFile }): Promise<GitReadResult<GitCommitPatch>> {
  const details = await gitCommitDetails(socket, options)
  if (!details.ok) return details
  const file = details.value.files.find((entry) => entry.path === options.file.path && entry.oldPath === options.file.oldPath)
  if (!file) return invalidGitRequest()
  const root = await gitReadRoot(socket, options)
  if (!root.ok) return root
  const commit = details.value.commit
  const revisions = commit.parents[0] ? [commit.parents[0], commit.hash] : [commit.hash]
  const patch = await gitReadCommand(socket, { ...options, cwd: root.value }, [
    'diff-tree', '--root', '--no-commit-id', '-r', '-p', '-M', '--no-ext-diff', '--no-textconv', '--no-color',
    '--unified=3', ...revisions, '--', ...(file.oldPath ? [file.oldPath] : []), file.path,
  ], DIFF_MAX_BYTES)
  // An incomplete patch is not presented as a complete diff.
  if (!patch.ok) {
    if (patch.error.code === 'too_large') return { ok: true, value: { text: '', binary: false, truncated: true } }
    return patch
  }
  if (patch.value.split('\n', MAX_PATCH_LINES + 1).length > MAX_PATCH_LINES) return { ok: true, value: { text: '', binary: false, truncated: true } }
  return { ok: true, value: { text: patch.value, binary: /^Binary files .* differ$/mu.test(patch.value) || /^GIT binary patch$/mu.test(patch.value), truncated: false } }
}

export async function gitStatus(socket: WorkspaceSocket, payload: ClientGitStatus): Promise<GitStatusResult> {
  const base = { requestId: payload.requestId, workspaceId: payload.workspaceId }
  const top = await workspaceExec(socket, payload.workspaceId, ['git', 'rev-parse', '--show-toplevel'], {
    cwd: payload.cwd,
    timeoutMs: STATUS_TIMEOUT_MS,
    maxOutputBytes: STATUS_MAX_BYTES,
  })
  if (top.error?.code === 'ETIMEDOUT') return { ...base, files: [], error: { code: 'timeout', message: 'git rev-parse timed out' } }
  if (top.error?.code === 'ENOENT') return { ...base, files: [], error: { code: 'git_unavailable', message: 'git is not installed on the executor' } }
  if (top.error?.code === 'EACCES') return { ...base, files: [], error: { code: 'executor_unavailable', message: top.error.message } }
  if (top.error) return { ...base, files: [], error: { code: 'internal_error', message: top.error.message } }
  if (top.exitCode !== 0) return { ...base, files: [], error: { code: 'not_git_repo', message: top.stderr.trim().slice(0, 500) || 'workspace is not a git repository' } }
  const repoRoot = top.stdout.trim()

  const status = await workspaceExec(socket, payload.workspaceId, ['git', 'status', '--porcelain=v1', '-z', '--branch'], {
    cwd: repoRoot,
    timeoutMs: STATUS_TIMEOUT_MS,
    maxOutputBytes: STATUS_MAX_BYTES,
  })
  if (status.error?.code === 'ETIMEDOUT') return { ...base, files: [], error: { code: 'timeout', message: 'git status timed out' } }
  if (status.error) return { ...base, files: [], error: { code: 'internal_error', message: status.error.message } }
  if (status.truncated) return { ...base, files: [], truncated: { reason: 'too_large', limit: STATUS_MAX_BYTES }, error: { code: 'internal_error', message: 'git status output is too large' } }
  if (status.exitCode !== 0) return { ...base, files: [], error: { code: 'internal_error', message: status.stderr.trim().slice(0, 500) || 'git status failed' } }

  const parsed = parsePorcelainStatus(status.stdout)
  return {
    ...base,
    repo: {
      root: repoRoot,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      ...(parsed.head ? { head: parsed.head } : {}),
    },
    files: parsed.files.slice(0, MAX_STATUS_FILES),
    ...(parsed.files.length > MAX_STATUS_FILES ? { truncated: { reason: 'too_many_files' as const, limit: MAX_STATUS_FILES } } : {}),
  }
}

export async function gitDiff(socket: WorkspaceSocket, payload: ClientGitDiff): Promise<GitDiffResult> {
  const base = { requestId: payload.requestId, workspaceId: payload.workspaceId }
  const status = await gitStatus(socket, { requestId: payload.requestId, workspaceId: payload.workspaceId, cwd: payload.cwd, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}) })
  if (status.error) {
    const errorCode: NonNullable<GitDiffResult['error']>['code'] =
      status.error.code === 'not_git_repo' || status.error.code === 'executor_unavailable' || status.error.code === 'git_unavailable' || status.error.code === 'timeout' || status.error.code === 'workspace_not_found'
        ? status.error.code
        : 'internal_error'
    return { ...base, error: { code: errorCode, message: status.error.message } }
  }
  const repoRoot = status.repo?.root
  if (!repoRoot) return { ...base, error: { code: 'not_git_repo', message: 'no repo root reported' } }
  const file = status.files.find((change) => change.path === payload.path || change.oldPath === payload.path)
  if (!file) return { ...base, error: { code: 'file_not_found', message: 'file is not changed in git status' } }

  const staged = payload.staged === true
  const oldSource = staged ? headSource(file) : indexSource(file)
  const newSource = staged ? indexSource(file) : worktreeSource(file)
  const oldPath = oldSource === 'head' && file.oldPath ? file.oldPath : payload.path

  const oldBuf = await readGitSide(socket, payload.workspaceId, repoRoot, oldPath, oldSource)
  const newBuf = await readGitSide(socket, payload.workspaceId, repoRoot, payload.path, newSource)
  if (!oldBuf.ok) return { ...base, file, error: oldBuf.error }
  if (!newBuf.ok) return { ...base, file, error: newBuf.error }

  const oldText = decodeText(oldBuf.buffer)
  const newText = decodeText(newBuf.buffer)
  if (!oldText.ok || !newText.ok) return { ...base, file, error: { code: 'binary_file', message: 'binary file cannot be diffed as text' } }
  const truncated = truncation(oldBuf.truncated, newBuf.truncated)
  return {
    ...base,
    file,
    oldText: oldText.text,
    newText: newText.text,
    language: languageForPath(payload.path),
    ...(truncated ? { truncated } : {}),
  }
}

// -----------------------------------------------------------------------
// Pure helpers (unit-testable). Moved verbatim from
// packages/executor/src/git-handlers.ts.
// -----------------------------------------------------------------------

export function parsePorcelainStatus(raw: string): { branch?: string; head?: string; files: GitFileChange[] } {
  const parts = raw.split('\0').filter((part) => part.length > 0)
  let branch: string | undefined
  let head: string | undefined
  const files: GitFileChange[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!
    if (entry.startsWith('## ')) {
      const value = entry.slice(3)
      branch = value.split('...')[0]?.trim() || undefined
      if (branch === 'HEAD (no branch)') branch = undefined
      continue
    }
    if (entry.length < 4) continue
    const x = entry[0]!
    const y = entry[1]!
    const path = entry.slice(3)
    let oldPath: string | undefined
    if (x === 'R' || x === 'C') {
      oldPath = parts[i + 1]
      i += 1
    }
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status: statusFor(x, y),
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
    })
  }
  return { ...(branch ? { branch } : {}), ...(head ? { head } : {}), files }
}

function statusFor(x: string, y: string): GitFileStatus {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted'
  const code = x !== ' ' ? x : y
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === 'C') return 'copied'
  if (code === 'T') return 'typechanged'
  return 'modified'
}

type GitSide = 'empty' | 'head' | 'index' | 'worktree'

function headSource(file: GitFileChange): GitSide {
  return file.status === 'added' || file.status === 'untracked' ? 'empty' : 'head'
}

function indexSource(file: GitFileChange): GitSide {
  if (file.status === 'untracked') return 'empty'
  if (file.status === 'deleted' && file.staged) return 'empty'
  return 'index'
}

function worktreeSource(file: GitFileChange): GitSide {
  return file.status === 'deleted' ? 'empty' : 'worktree'
}

async function readGitSide(
  socket: WorkspaceSocket,
  workspaceId: string,
  repoRoot: string,
  path: string,
  source: GitSide,
): Promise<{ ok: true; buffer: Uint8Array; truncated?: boolean } | { ok: false; error: NonNullable<GitDiffResult['error']> }> {
  if (source === 'empty') return { ok: true, buffer: new Uint8Array(0) }
  if (source === 'worktree') {
    const abs = joinPath(repoRoot, path)
    const res = await workspaceReadBinary(socket, workspaceId, abs, { maxBytes: DIFF_MAX_BYTES + 1 })
    if (res.error) {
      if (res.error.code === 'ENOENT') return { ok: true, buffer: new Uint8Array(0) }
      return { ok: false, error: { code: 'file_not_found', message: res.error.message } }
    }
    const buffer = base64ToBytes(res.base64)
    if (buffer.length > DIFF_MAX_BYTES) return { ok: true, buffer: buffer.subarray(0, DIFF_MAX_BYTES), truncated: true }
    return { ok: true, buffer }
  }
  const rev = source === 'head' ? `HEAD:${path}` : `:${path}`
  const result = await workspaceExec(socket, workspaceId, ['git', 'show', rev], {
    cwd: repoRoot,
    timeoutMs: DIFF_TIMEOUT_MS,
    maxOutputBytes: DIFF_MAX_BYTES + 1,
  })
  if (result.error?.code === 'ETIMEDOUT') return { ok: false, error: { code: 'timeout', message: 'git show timed out' } }
  if (result.error) return { ok: false, error: { code: 'file_not_found', message: result.error.message } }
  if (result.truncated) {
    const bytes = new TextEncoder().encode(result.stdout)
    return { ok: true, buffer: bytes.subarray(0, DIFF_MAX_BYTES), truncated: true }
  }
  if (result.exitCode !== 0) {
    if (source === 'head') return { ok: true, buffer: new Uint8Array(0) }
    return { ok: false, error: { code: 'file_not_found', message: result.stderr.trim().slice(0, 500) || 'file not found in git index' } }
  }
  return { ok: true, buffer: new TextEncoder().encode(result.stdout) }
}

function decodeText(buffer: Uint8Array): { ok: true; text: string } | { ok: false } {
  if (buffer.includes(0)) return { ok: false }
  return { ok: true, text: new TextDecoder('utf-8', { fatal: false }).decode(buffer) }
}

function truncation(oldTruncated: boolean | undefined, newTruncated: boolean | undefined): GitDiffResult['truncated'] | undefined {
  if (oldTruncated && newTruncated) return { side: 'both', maxBytes: DIFF_MAX_BYTES }
  if (oldTruncated) return { side: 'old', maxBytes: DIFF_MAX_BYTES }
  if (newTruncated) return { side: 'new', maxBytes: DIFF_MAX_BYTES }
  return undefined
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  if (a.endsWith('/')) return `${a}${b}`
  return `${a}/${b}`
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'json') return 'json'
  if (ext === 'css') return 'css'
  if (ext === 'html') return 'html'
  if (ext === 'md') return 'markdown'
  if (ext === 'py') return 'python'
  if (ext === 'rs') return 'rust'
  if (ext === 'go') return 'go'
  if (ext === 'java') return 'java'
  if (ext === 'sh' || ext === 'bash') return 'shell'
  return 'plaintext'
}
