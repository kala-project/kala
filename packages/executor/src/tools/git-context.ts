import { execFile } from 'node:child_process'
import { basename, isAbsolute, resolve } from 'node:path'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { throwIfAborted, ToolError } from './registry.js'
import { optionalBoolean, optionalPositiveInt, optionalString } from './schema.js'

const DEFAULT_MAX_DIFF_CHARS = 12_000
const MAX_DIFF_CHARS = 64_000
const DEFAULT_LOG_LIMIT = 5
const MAX_LOG_LIMIT = 25
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 1024 * 1024
const MAX_RESULT_BYTES = 128 * 1024

export type GitBranchSummary = {
  head: string
  oid: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
}

export type GitFileStatusEntry = {
  path: string
  status: string
  origPath?: string
}

export type GitStatusSummary = {
  clean: boolean
  staged: GitFileStatusEntry[]
  unstaged: GitFileStatusEntry[]
  untracked: string[]
  conflicted: string[]
}

export type GitCommitSummary = {
  sha: string
  shortSha: string
  author: string
  date: string
  subject: string
}

export type GitPreflightWarning = {
  kind: 'sensitive_file' | 'secret_pattern' | 'conflict_marker' | 'detached_head' | 'unmerged_conflict'
  severity: 'high' | 'medium'
  path?: string
  message: string
}

const SAFE_ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|defaults|schema|test)$/i
const SENSITIVE_FILENAME_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /^\.env(\..+)?$/i, reason: 'dotenv environment file may contain secrets' },
  { re: /\.(pem|key|p12|pfx|keystore)$/i, reason: 'private key or certificate bundle' },
  { re: /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i, reason: 'SSH private key file' },
  { re: /(^|[_.-])(credentials|service[_-]?account|client[_-]?secret)([_.-]|$).*\.json$/i, reason: 'credentials JSON file' },
  { re: /^\.(npmrc|pypirc|netrc)$/i, reason: 'package registry or network auth config' },
]

const SECRET_LINE_DETECTORS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: 'PEM private key header' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key ID' },
  { re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, label: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, label: 'GitHub fine-grained PAT' },
  { re: /\bsk-[A-Za-z0-9_-]{24,}\b/, label: 'API secret key token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: 'Slack token' },
  { re: /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"',;]+/i, label: 'credential assignment' },
  { re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^@\s/]+@/i, label: 'URL credential' },
]

const REDACTIONS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /(\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?)[^\s"',;]+/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^@\s/]+@/gi,
]

function redact(value: string): string {
  return REDACTIONS.reduce((text, pattern, index) =>
    text.replace(pattern, index >= 6 ? '$1[REDACTED]' : '[REDACTED]'), value)
}

async function runGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve) => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('GIT_')) delete env[key]
    }
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        signal,
        env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, stdout, stderr, exitCode: 0 })
          return
        }
        const exitCode = typeof err.code === 'number' ? err.code : 1
        resolve({
          ok: false,
          stdout: stdout ?? '',
          stderr: stderr || err.message,
          exitCode,
        })
      },
    )
  })
}

export function parsePorcelainV2BranchAndStatus(raw: string): {
  branch: GitBranchSummary
  status: GitStatusSummary
} {
  const branch: GitBranchSummary = {
    head: 'HEAD',
    oid: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  }
  const staged: GitFileStatusEntry[] = []
  const unstaged: GitFileStatusEntry[] = []
  const untracked: string[] = []
  const conflicted: string[] = []

  const records = raw.split('\0')
  for (let i = 0; i < records.length; i++) {
    const line = records[i]!
    if (!line) continue
    if (line.startsWith('# ')) {
      if (line.startsWith('# branch.oid ')) {
        const oid = line.slice('# branch.oid '.length).trim()
        branch.oid = oid === '(initial)' ? null : oid
      } else if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim()
        if (head === '(detached)') {
          branch.head = 'HEAD'
          branch.detached = true
        } else {
          branch.head = head
          branch.detached = false
        }
      } else if (line.startsWith('# branch.upstream ')) {
        branch.upstream = line.slice('# branch.upstream '.length).trim() || null
      } else if (line.startsWith('# branch.ab ')) {
        const ab = line.slice('# branch.ab '.length).trim()
        const match = /^\+(\d+)\s+-(\d+)$/.exec(ab)
        if (match) {
          branch.ahead = Number.parseInt(match[1]!, 10)
          branch.behind = Number.parseInt(match[2]!, 10)
        }
      }
      continue
    }

    if (line.startsWith('? ')) {
      untracked.push(line.slice(2))
      continue
    }

    if (line.startsWith('u ')) {
      // Unmerged entry: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const path = line.split(' ').slice(10).join(' ')
      if (path) conflicted.push(path)
      continue
    }

    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const isRename = line.startsWith('2 ')
      const xy = line.slice(2, 4)
      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'

      let filePath = ''
      let origPath: string | undefined
      if (isRename) {
        origPath = records[++i]
        const fields = line.split(' ')
        filePath = fields.slice(9).join(' ')
      } else {
        const fields = line.split(' ')
        filePath = fields.slice(8).join(' ')
      }

      if (x !== '.') {
        staged.push({
          path: filePath,
          status: x,
          ...(origPath ? { origPath } : {}),
        })
      }
      if (y !== '.') {
        unstaged.push({
          path: filePath,
          status: y,
        })
      }
    }
  }

  return {
    branch,
    status: {
      clean:
        staged.length === 0 &&
        unstaged.length === 0 &&
        untracked.length === 0 &&
        conflicted.length === 0,
      staged,
      unstaged,
      untracked,
      conflicted,
    },
  }
}

export function detectPreflightWarnings(params: {
  branch: GitBranchSummary
  status: GitStatusSummary
  diffPatch: string
}): GitPreflightWarning[] {
  const warnings: GitPreflightWarning[] = []

  if (params.branch.detached) {
    warnings.push({
      kind: 'detached_head',
      severity: 'medium',
      message: 'Repository is currently in detached HEAD state.',
    })
  }

  for (const path of params.status.conflicted) {
    warnings.push({
      kind: 'unmerged_conflict',
      severity: 'high',
      path,
      message: `Unresolved merge conflict in "${path}".`,
    })
  }

  const candidatePaths = new Set<string>([
    ...params.status.staged.map((f) => f.path),
    ...params.status.staged.flatMap((f) => f.origPath ? [f.origPath] : []),
    ...params.status.unstaged.map((f) => f.path),
    ...params.status.untracked,
  ])

  for (const filePath of candidatePaths) {
    const base = basename(filePath)
    if (SAFE_ENV_TEMPLATE_RE.test(base)) continue
    for (const rule of SENSITIVE_FILENAME_PATTERNS) {
      if (rule.re.test(base)) {
        warnings.push({
          kind: 'sensitive_file',
          severity: 'high',
          path: filePath,
          message: `Modified or untracked sensitive file "${filePath}" (${rule.reason}). Avoid staging or committing secrets.`,
        })
        break
      }
    }
  }

  // Scan added lines in the unified diff for secret patterns or conflict markers.
  let currentDiffFile: string | undefined
  const reportedSecrets = new Set<string>()
  const reportedConflicts = new Set<string>()
  for (const line of params.diffPatch.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentDiffFile = line.slice('+++ b/'.length)
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const addedContent = line.slice(1)

    if (/^(<{7}\s|={7}$|>{7}\s)/.test(addedContent)) {
      const key = currentDiffFile ?? '<diff>'
      if (!reportedConflicts.has(key)) {
        reportedConflicts.add(key)
        warnings.push({
          kind: 'conflict_marker',
          severity: 'high',
          ...(currentDiffFile ? { path: currentDiffFile } : {}),
          message: `Added diff line contains leftover Git conflict marker in "${key}".`,
        })
      }
    }

    for (const detector of SECRET_LINE_DETECTORS) {
      if (detector.re.test(addedContent)) {
        const key = `${currentDiffFile ?? '<diff>'}:${detector.label}`
        if (!reportedSecrets.has(key)) {
          reportedSecrets.add(key)
          warnings.push({
            kind: 'secret_pattern',
            severity: 'high',
            ...(currentDiffFile ? { path: currentDiffFile } : {}),
            message: `Potential ${detector.label} detected in added diff lines${currentDiffFile ? ` of "${currentDiffFile}"` : ''}.`,
          })
        }
      }
    }
  }

  return warnings
}

export const gitContextTool: Tool = {
  name: 'git_context',
  async run(input, ctx) {
    throwIfAborted(ctx)
    const cwdInput = optionalString(input, 'cwd')
    const scope = optionalString(input, 'scope') ?? 'all'
    if (!['all', 'staged', 'unstaged', 'base'].includes(scope)) {
      throw new ToolError('EINVAL', `invalid scope "${scope}": expected all, staged, unstaged, or base`)
    }
    const baseRef = optionalString(input, 'base_ref') ?? optionalString(input, 'baseRef')
    const includeDiff = optionalBoolean(input, 'include_diff') ?? optionalBoolean(input, 'includeDiff') ?? true
    const maxDiffChars = Math.min(
      Math.max(
        optionalPositiveInt(input, 'max_diff_chars', 500) ??
          optionalPositiveInt(input, 'maxDiffChars', 500) ??
          DEFAULT_MAX_DIFF_CHARS,
        500,
      ),
      MAX_DIFF_CHARS,
    )
    const logLimit = Math.min(
      optionalPositiveInt(input, 'log_limit', 0) ??
        optionalPositiveInt(input, 'logLimit', 0) ??
        DEFAULT_LOG_LIMIT,
      MAX_LOG_LIMIT,
    )

    const targetDir = cwdInput ?? ctx.cwd ?? ctx.sandbox.roots[0] ?? process.cwd()
    let resolvedCwd: string
    try {
      resolvedCwd = await ctx.sandbox.resolve(targetDir, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('EACCES', 'cwd outside workspace')
      }
      throw err
    }

    const topLevelRes = await runGit(resolvedCwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], ctx.signal)
    throwIfAborted(ctx)
    if (!topLevelRes.ok) {
      throw new ToolError('EINVAL', 'not a git repository (or git unavailable)')
    }
    const [rootPath, gitDirPath, commonDirPath] = topLevelRes.stdout.trimEnd().split(/\r?\n/)
    if (!rootPath || !gitDirPath || !commonDirPath) {
      throw new ToolError('EINVAL', 'not a working-tree Git repository')
    }
    let repoRoot: string
    try {
      repoRoot = await ctx.sandbox.resolve(rootPath)
      for (const metadataPath of [gitDirPath, commonDirPath]) {
        await ctx.sandbox.resolve(isAbsolute(metadataPath) ? metadataPath : resolve(resolvedCwd, metadataPath))
      }
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError('EACCES', 'repository or Git metadata outside workspace')
      throw err
    }

    const [statusRes, stagedStatRes, unstagedStatRes, logRes] = await Promise.all([
      runGit(repoRoot, ['status', '--porcelain=v2', '--branch', '-z'], ctx.signal),
      runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--stat'], ctx.signal),
      runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--stat'], ctx.signal),
      logLimit > 0
        ? runGit(
            repoRoot,
            ['log', `-n`, String(logLimit), '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s'],
            ctx.signal,
          )
        : Promise.resolve({ ok: true, stdout: '', stderr: '', exitCode: 0 }),
    ])
    throwIfAborted(ctx)
    if (![statusRes, stagedStatRes, unstagedStatRes, logRes].every((r) => r.ok)) {
      throw new ToolError(ctx.signal.aborted ? 'ECANCELED' : 'EIO', 'Git metadata query failed or exceeded its output/time limit')
    }

    const { branch, status } = parsePorcelainV2BranchAndStatus(statusRes.stdout)

    const [stagedPatch, unstagedPatch] = await Promise.all([
      runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--cached'], ctx.signal),
      runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv'], ctx.signal),
    ])
    throwIfAborted(ctx)
    if (!stagedPatch.ok || !unstagedPatch.ok) {
      throw new ToolError(ctx.signal.aborted ? 'ECANCELED' : 'EIO', 'Git diff failed or exceeded its output/time limit')
    }

    // Preflight examines current changes regardless of which patch is requested for display.
    const workingPatch = [stagedPatch.stdout, unstagedPatch.stdout].filter(Boolean).join('\n')
    let fullPatch = ''
    if (scope === 'staged') {
      fullPatch = stagedPatch.stdout
    } else if (scope === 'unstaged') {
      fullPatch = unstagedPatch.stdout
    } else if (scope === 'base' || baseRef) {
      const ref = baseRef ?? 'HEAD'
      if (ref.startsWith('-') || ref.includes('\0') || ref.length > 256) {
        throw new ToolError('EINVAL', 'base_ref must be a Git revision, not an option')
      }
      const res = await runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', ref, '--'], ctx.signal)
      throwIfAborted(ctx)
      if (!res.ok) {
        throw new ToolError(ctx.signal.aborted ? 'ECANCELED' : 'EINVAL', 'failed to diff against base_ref')
      }
      fullPatch = res.stdout
    } else {
      // scope === 'all': combine staged and unstaged diffs
      const parts: string[] = []
      if (stagedPatch.stdout.trim().length > 0) {
        parts.push(`# Staged changes\n${stagedPatch.stdout.trimEnd()}`)
      }
      if (unstagedPatch.stdout.trim().length > 0) {
        parts.push(`# Unstaged changes\n${unstagedPatch.stdout.trimEnd()}`)
      }
      fullPatch = parts.join('\n\n')
    }

    const preflightWarnings = detectPreflightWarnings({
      branch,
      status,
      diffPatch: workingPatch,
    })

    const sensitivePatch = preflightWarnings.some((w) => w.kind === 'sensitive_file' || w.kind === 'secret_pattern') ||
      fullPatch.split(/\r?\n/).some((line) => {
        if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
          const base = basename(line.slice(6))
          return !SAFE_ENV_TEMPLATE_RE.test(base) && SENSITIVE_FILENAME_PATTERNS.some((rule) => rule.re.test(base))
        }
        return line.startsWith('+') && SECRET_LINE_DETECTORS.some((detector) => detector.re.test(line.slice(1)))
      })
    let patch = ''
    let patchTruncated = false
    if (includeDiff && fullPatch.length > 0) {
      const byteLimit = Math.min(maxDiffChars, MAX_DIFF_CHARS)
      if (sensitivePatch) {
        patch = '[diff suppressed: sensitive file or credential detected; inspect locally]'
        patchTruncated = true
      } else if (fullPatch.length > maxDiffChars || Buffer.byteLength(fullPatch) > byteLimit) {
        patch = `${Buffer.from(fullPatch.slice(0, maxDiffChars)).subarray(0, byteLimit).toString('utf8')}\n... [diff truncated at ${maxDiffChars} chars / ${byteLimit} bytes]`
        patchTruncated = true
      } else {
        patch = fullPatch
      }
    }

    const recentCommits: GitCommitSummary[] = []
    if (logRes.ok && logRes.stdout.trim().length > 0) {
      for (const line of logRes.stdout.trim().split(/\r?\n/)) {
        if (!line) continue
        const [sha = '', shortSha = '', author = '', date = '', subject = ''] = line.split('\x1f')
        if (sha) {
          recentCommits.push({ sha, shortSha, author, date, subject })
        }
      }
    }

    const result = JSON.stringify({
      repoRoot,
      branch,
      status,
      diff: {
        scope: baseRef && scope === 'all' ? 'base' : scope,
        ...(baseRef ? { baseRef } : {}),
        stagedStat: stagedStatRes.stdout.trim(),
        unstagedStat: unstagedStatRes.stdout.trim(),
        ...(includeDiff ? { patch, truncated: patchTruncated } : {}),
      },
      recentCommits,
      preflightWarnings,
    }, (_key, value: unknown) => typeof value === 'string' ? redact(value) : value)
    if (Buffer.byteLength(result) > MAX_RESULT_BYTES) {
      throw new ToolError('E2BIG', 'Git context metadata exceeds result byte budget')
    }
    throwIfAborted(ctx)
    return result
  },
}
