import { spawn } from 'node:child_process'
import { realpath, lstat, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { arenaGroupRecorder, trackedArenaGit } from './arena-process-groups.js'

const ID = /^[A-Za-z0-9_-]{1,48}$/u
const SHA = /^[a-f0-9]{40,64}$/u

export type ArenaReadCandidate = { id: string; branch: string; worktreePath: string; status: string; label: string }

export function arenaText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ToolError('EINVAL', 'invalid arena status input')
  return value
}

export async function arenaReadGit(
  cwd: string, args: string[], signal: AbortSignal, allowDiffExitCode = false,
): Promise<string> {
  if (signal.aborted) throw new ToolError('ECANCELED', 'arena status aborted')
  const gitArgs = [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'gc.auto=0', '-c', 'gc.autodetach=false', '-c', 'maintenance.auto=false',
    '-c', 'submodule.recurse=false', '-c', 'commit.gpgsign=false',
    '--no-optional-locks', '-C', cwd, ...args,
  ]
  if (arenaGroupRecorder.getStore()) {
    const result = await trackedArenaGit(cwd, gitArgs, undefined, signal,
      { stdout: 64_000, stderr: 4_000, timeoutMs: 15_000 })
    if (result.code !== 0 && !(allowDiffExitCode && result.code === 1 && result.stdout.length > 0 && !result.stderr)) {
      throw new ToolError('EIO', 'Git status failed or was interrupted; outcome requires inspection')
    }
    return result.stdout.trimEnd()
  }
  return await new Promise<string>((done, fail) => {
    const child = spawn('/usr/bin/git', gitArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
    })
    let stdout = '', stderr = ''
    const kill = () => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
    }
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; kill() }, 15_000)
    signal.addEventListener('abort', kill, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 64_000) kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 4_000) kill()
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', kill)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', kill)
      if (signal.aborted || timedOut || (code !== 0 && !(allowDiffExitCode && code === 1 && stdout.length > 0 && !stderr))
        || stdout.length > 64_000 || stderr.length > 4_000) {
        fail(new ToolError('EIO', 'Git status failed or was interrupted; outcome requires inspection'))
      } else done(stdout.trimEnd())
    })
  })
}

export async function hasArenaGitFilterDrivers(path: string, signal: AbortSignal): Promise<boolean> {
  const config = await arenaReadGit(path, ['config', '--list', '--includes', '--show-origin', '--name-only', '-z'], signal)
  const entries = config.split('\0')
  for (let i = 0; i + 1 < entries.length; i += 2) {
    if (entries[i]?.startsWith('command line:')) continue
    if (/^filter\..+\.(clean|smudge|process)$|^alias\.|^diff\..+\.(command|textconv)$|^diff\.external$|^merge\..+\.driver$|^credential\.helper$|^core\.(fsmonitor|hooksPath|sshCommand|alternateRefsCommand|editor|pager)$|^sequence\.editor$|^pager\./iu.test(entries[i + 1]!)) return true
  }
  return false
}

export async function assertArenaRepositoryIdentity(common: string, value: unknown): Promise<void> {
  if (value === undefined) return
  const entry = await stat(common, { bigint: true })
  if (value !== `git-common-inode:${entry.dev}:${entry.ino}` || !entry.isDirectory()) {
    throw new ToolError('EACCES', 'Arena canonical Git repository identity changed')
  }
}

export async function verifiedArenaWorktree(
  root: string, arenaId: string, common: string, candidate: ArenaReadCandidate,
  ctx: Parameters<Tool['run']>[1],
): Promise<string> {
  if (!ID.test(arenaText(candidate.id)) || candidate.branch !== `kala-arena/${arenaId}/${candidate.id}`
    || candidate.worktreePath !== join(root, '.kala-arena', arenaId, candidate.id)) {
    throw new ToolError('EACCES', 'candidate identity mismatch')
  }
  const path = await ctx.sandbox.resolve(candidate.worktreePath, { cwd: ctx.cwd })
  if (await lstat(path).then((entry) => entry.isSymbolicLink()) || await realpath(path) !== candidate.worktreePath
    || !path.startsWith(`${root}${sep}`)) throw new ToolError('EACCES', 'candidate path is not a regular worktree')
  if (await arenaReadGit(path, ['rev-parse', '--show-toplevel'], ctx.signal) !== path
    || await arenaReadGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.signal) !== common
    || await arenaReadGit(path, ['branch', '--show-current'], ctx.signal) !== candidate.branch) {
    throw new ToolError('EACCES', 'candidate Git identity changed')
  }
  return path
}

export async function verifiedArenaRoot(
  input: Record<string, unknown>, ctx: Parameters<Tool['run']>[1],
): Promise<{ root: string; arenaId: string; baseSha: string; common: string; unsafeConfig: boolean }> {
  if (ctx.origin !== 'host' || process.platform !== 'linux') {
    throw new ToolError('EACCES', 'arena read requires a supported Host admission')
  }
  const repoRoot = arenaText(input.repoRoot)
  const arenaId = arenaText(input.arenaId)
  const baseSha = arenaText(input.baseSha)
  if (!ID.test(arenaId) || !SHA.test(baseSha) || !Array.isArray(input.candidates) || input.candidates.length > 6) {
    throw new ToolError('EINVAL', 'invalid arena read identity')
  }
  const root = await ctx.sandbox.resolve(repoRoot, { cwd: ctx.cwd })
  if (resolve(root) !== repoRoot || await realpath(root) !== repoRoot) throw new ToolError('EACCES', 'invalid repository root')
  const common = await arenaReadGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.signal)
  await assertArenaRepositoryIdentity(common, input.repositoryIdentity)
  const unsafeConfig = await hasArenaGitFilterDrivers(root, ctx.signal)
  return { root, arenaId, baseSha, common, unsafeConfig }
}

export const arenaGitStatusTool: Tool = {
  name: 'arena_git_status',
  async run(input, ctx) {
    const { root, arenaId, baseSha, common, unsafeConfig } = await verifiedArenaRoot(input, ctx)
    if (unsafeConfig) return JSON.stringify({
      finalEffectStopped: true, error: 'Arena read refuses repository Git configuration with executable helpers',
    })
    const statuses: Record<string, unknown>[] = []
    for (const raw of input.candidates as unknown[]) {
      if (!raw || typeof raw !== 'object') throw new ToolError('EINVAL', 'invalid candidate')
      const candidate = raw as ArenaReadCandidate
      if (!ID.test(arenaText(candidate.id)) || candidate.branch !== `kala-arena/${arenaId}/${candidate.id}`
        || candidate.worktreePath !== join(root, '.kala-arena', arenaId, candidate.id)) throw new ToolError('EACCES', 'candidate identity mismatch')
      const row: Record<string, unknown> = {
        id: candidate.id, label: arenaText(candidate.label), branch: candidate.branch,
        worktreePath: candidate.worktreePath, status: candidate.status,
      }
      if (candidate.status !== 'active' && candidate.status !== 'applied') {
        if (candidate.status !== 'pending' && candidate.status !== 'cleaned') throw new ToolError('EINVAL', 'invalid candidate status')
        statuses.push(row)
        continue
      }
      const path = await verifiedArenaWorktree(root, arenaId, common, candidate, ctx)
      if (await hasArenaGitFilterDrivers(path, ctx.signal)) return JSON.stringify({
        finalEffectStopped: true, error: 'Arena read refuses worktree Git configuration with executable helpers',
      })
      const headSha = await arenaReadGit(path, ['rev-parse', 'HEAD'], ctx.signal)
      const porcelain = await arenaReadGit(path, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], ctx.signal)
      const shortStat = await arenaReadGit(path, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--shortstat', baseSha], ctx.signal)
      const changedFiles = porcelain.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean)
      statuses.push({
        ...row, headSha, commitsAhead: headSha !== baseSha, dirtyFileCount: changedFiles.length,
        changedFiles, shortStat,
      })
      throwIfAborted(ctx)
    }
    const result = JSON.stringify({ candidates: statuses, finalEffectStopped: true })
    return Buffer.byteLength(result) <= 200_000 ? result : JSON.stringify({
      finalEffectStopped: true, error: 'Arena status output exceeds the bounded receipt size',
    })
  },
}
