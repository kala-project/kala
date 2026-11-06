import { spawn } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath, rmdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { Tool, ToolContext } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { arenaGroupRecorder, trackedArenaGit } from './arena-process-groups.js'
import {
  arenaReadGit, arenaText, assertArenaRepositoryIdentity, hasArenaGitFilterDrivers, verifiedArenaRoot, verifiedArenaWorktree,
  type ArenaReadCandidate,
} from './arena-git-status.js'

const ID = /^[A-Za-z0-9_-]{1,48}$/u
const SHA = /^[a-f0-9]{40,64}$/u

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function safeCommonDir(root: string, ctx: ToolContext): Promise<string> {
  const common = await arenaReadGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.signal)
  if (await ctx.sandbox.resolve(common, { cwd: root }) !== common || await realpath(common) !== common
    || (await lstat(common)).isSymbolicLink()) throw new ToolError('EACCES', 'Git common directory is outside the workspace or symlinked')
  const info = join(common, 'info')
  for (const path of [info, join(info, 'exclude')]) {
    if (await exists(path) && (await lstat(path)).isSymbolicLink()) throw new ToolError('EACCES', 'Git exclude is symlinked')
  }
  return common
}

async function noExternalHelpers(root: string, ctx: ToolContext, candidatePath?: string): Promise<void> {
  if (await hasArenaGitFilterDrivers(root, ctx.signal)
    || (candidatePath && await hasArenaGitFilterDrivers(candidatePath, ctx.signal))) {
    throw new ToolError('EACCES', 'repository Git configuration can execute an external helper')
  }
}

async function gitWithInput(cwd: string, args: string[], input: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ToolError('ECANCELED', 'Git mutation aborted')
  const gitArgs = [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'gc.auto=0', '-c', 'gc.autodetach=false', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false',
    '-c', 'commit.gpgsign=false', '--no-optional-locks', '-C', cwd, ...args,
  ]
  if (arenaGroupRecorder.getStore()) {
    const result = await trackedArenaGit(cwd, gitArgs, input, signal,
      { stdout: 64_000, stderr: 64_000, timeoutMs: 30_000 })
    if (result.code !== 0) throw new ToolError('EIO', 'Git mutation failed; inspect worktree and receipt before reconciliation')
    return
  }
  await new Promise<void>((done, fail) => {
    const child = spawn('/usr/bin/git', gitArgs, {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: {
        PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
      },
    })
    let bytes = 0, timedOut = false
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } } }
    const timeout = setTimeout(() => { timedOut = true; kill() }, 30_000)
    const onAbort = () => { kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 64_000) kill() })
    child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 64_000) kill() })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
    child.on('error', (error) => { clearTimeout(timeout); signal.removeEventListener('abort', onAbort); fail(error) })
    child.on('close', (code) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      if (code !== 0 || timedOut || signal.aborted || bytes > 64_000) {
        fail(new ToolError('EIO', 'Git mutation did not complete; inspect worktree and receipt before reconciliation'))
      } else done()
    })
  })
}

function candidateId(value: unknown): string {
  const id = arenaText(value)
  if (!ID.test(id)) throw new ToolError('EINVAL', 'invalid candidate id')
  return id
}

export const arenaGitInitTool: Tool = {
  name: 'arena_git_init',
  async run(input, ctx) {
    if (ctx.origin !== 'host' || process.platform !== 'linux') throw new ToolError('EACCES', 'unsupported Arena admission')
    const arenaId = candidateId(input.arenaId)
    const baseRef = arenaText(input.baseRef)
    if (baseRef.length > 200 || !Array.isArray(input.candidates)
      || input.candidates.length < 1 || input.candidates.length > 6) throw new ToolError('EINVAL', 'invalid init candidates or base')
    const ids = input.candidates.map(candidateId)
    if (new Set(ids).size !== ids.length) throw new ToolError('EINVAL', 'duplicate candidate id')
    const cwd = await ctx.sandbox.resolve(ctx.cwd ?? ctx.sandbox.roots[0] ?? '', { cwd: ctx.cwd })
    const root = await arenaReadGit(cwd, ['rev-parse', '--show-toplevel'], ctx.signal)
    if (await realpath(root) !== root || await ctx.sandbox.resolve(root) !== root) {
      throw new ToolError('EACCES', 'repository root is not an authorized canonical directory')
    }
    const baseSha = await arenaReadGit(root, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], ctx.signal)
    if (!SHA.test(baseSha)) throw new ToolError('EINVAL', 'invalid base commit')
    const common = await safeCommonDir(root, ctx)
    await assertArenaRepositoryIdentity(common, input.repositoryIdentity)
    await noExternalHelpers(root, ctx)
    const parent = join(root, '.kala-arena'), arenaDir = join(parent, arenaId)
    if (await exists(parent) && (await lstat(parent)).isSymbolicLink() || await exists(arenaDir)) {
      throw new ToolError('EEXIST', 'arena directory already exists or is symlinked')
    }
    const candidates = ids.map((id) => ({
      id, label: id, branch: `kala-arena/${arenaId}/${id}`,
      worktreePath: join(arenaDir, id), status: 'active' as const,
    }))
    for (const candidate of candidates) {
      if (await arenaReadGit(root, ['branch', '--list', candidate.branch], ctx.signal)) {
        throw new ToolError('EEXIST', 'arena branch already exists')
      }
    }
    throwIfAborted(ctx)
    await mkdir(parent, { recursive: true })
    await mkdir(arenaDir)
    const info = join(common, 'info')
    await mkdir(info, { recursive: true })
    const exclude = join(info, 'exclude')
    if (await exists(exclude) && (await lstat(exclude)).isSymbolicLink()) {
      throw new ToolError('EACCES', 'Git exclude changed to a symlink')
    }
    const previous = await readFile(exclude, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (!previous.split(/\r?\n/u).includes('.kala-arena/')) {
      const file = await open(exclude, 'a', 0o600)
      try { await file.writeFile('\n.kala-arena/\n'); await file.sync() } finally { await file.close() }
    }
    for (const candidate of candidates) {
      throwIfAborted(ctx)
      await arenaReadGit(root, ['worktree', 'add', '-b', candidate.branch, candidate.worktreePath, baseSha], ctx.signal)
    }
    return JSON.stringify({ finalEffectStopped: true, arenaId, repoRoot: root, baseSha, candidates })
  },
}

export const arenaGitApplyTool: Tool = {
  name: 'arena_git_apply',
  async run(input, ctx) {
    const { root, arenaId, baseSha, common, unsafeConfig } = await verifiedArenaRoot({
      ...input, candidates: [input.candidate],
    }, ctx)
    if (unsafeConfig) return JSON.stringify({ finalEffectStopped: true, error: 'repository Git configuration can execute an external helper' })
    const candidate = input.candidate as ArenaReadCandidate
    if (!candidate || candidate.status !== 'active') throw new ToolError('EINVAL', 'candidate is not active')
    const path = await verifiedArenaWorktree(root, arenaId, common, candidate, ctx)
    if (await hasArenaGitFilterDrivers(path, ctx.signal)) {
      return JSON.stringify({ finalEffectStopped: true, error: 'worktree Git configuration can execute an external helper' })
    }
    if (await arenaReadGit(root, ['rev-parse', 'HEAD'], ctx.signal) !== baseSha
      || await arenaReadGit(root, ['status', '--porcelain', '--untracked-files=normal'], ctx.signal)) {
      return JSON.stringify({ finalEffectStopped: true, error: 'primary workspace is not clean at the arena base' })
    }
    const strategy = input.strategy
    if (strategy !== 'merge' && strategy !== 'patch') throw new ToolError('EINVAL', 'unsupported apply strategy')
    const mergeBase = await arenaReadGit(path, ['merge-base', baseSha, 'HEAD'], ctx.signal)
    if (mergeBase !== baseSha) return JSON.stringify({ finalEffectStopped: true, error: 'candidate is not descended from arena base' })
    throwIfAborted(ctx)
    await arenaReadGit(path, ['add', '-A'], ctx.signal)
    if (strategy === 'merge') {
      const staged = await arenaReadGit(path, ['diff', '--cached', '--name-only'], ctx.signal)
      if (staged) await arenaReadGit(path, [
        '-c', 'user.name=Kala Arena', '-c', 'user.email=arena@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '-m', `feat(arena): candidate ${candidate.id}`,
      ], ctx.signal)
      await arenaReadGit(root, ['merge', '--ff-only', candidate.branch], ctx.signal)
    } else {
      const patch = await arenaReadGit(path, ['diff', '--cached', '--binary', baseSha], ctx.signal)
      if (!patch) return JSON.stringify({ finalEffectStopped: true, error: 'candidate has no changes to apply' })
      await gitWithInput(root, ['apply', '--check', '--index', '-'], `${patch}\n`, ctx.signal)
      await gitWithInput(root, ['apply', '--index', '-'], `${patch}\n`, ctx.signal)
    }
    return JSON.stringify({ finalEffectStopped: true, candidateId: candidate.id, strategy })
  },
}

export const arenaGitCleanupTool: Tool = {
  name: 'arena_git_cleanup',
  async run(input, ctx) {
    const { root, arenaId, common, unsafeConfig } = await verifiedArenaRoot({
      ...input, candidates: [input.candidate],
    }, ctx)
    if (unsafeConfig) return JSON.stringify({ finalEffectStopped: true, error: 'repository Git configuration can execute an external helper' })
    const candidate = input.candidate as ArenaReadCandidate
    const id = candidateId(candidate?.id)
    const path = join(root, '.kala-arena', arenaId, id)
    if (candidate.worktreePath !== path || candidate.branch !== `kala-arena/${arenaId}/${id}`) {
      throw new ToolError('EACCES', 'candidate path or branch identity mismatch')
    }
    const dir = join(root, '.kala-arena'), arenaDir = join(dir, arenaId)
    for (const entry of [dir, arenaDir, path]) {
      if (await exists(entry) && (await lstat(entry)).isSymbolicLink()) throw new ToolError('EACCES', 'arena path is symlinked')
    }
    if (await exists(path)) {
      await verifiedArenaWorktree(root, arenaId, common, candidate, ctx)
      if (await hasArenaGitFilterDrivers(path, ctx.signal)) {
        return JSON.stringify({ finalEffectStopped: true, error: 'worktree Git configuration can execute an external helper' })
      }
      await arenaReadGit(root, ['worktree', 'remove', '--force', path], ctx.signal)
    } else {
      const branch = await arenaReadGit(root, ['branch', '--list', candidate.branch], ctx.signal)
      if (branch) return JSON.stringify({ finalEffectStopped: true, error: 'candidate branch exists without its worktree; reconcile manually' })
    }
    if (await arenaReadGit(root, ['branch', '--list', candidate.branch], ctx.signal)) {
      await arenaReadGit(root, ['branch', '-D', candidate.branch], ctx.signal)
    }
    if (input.final === true) {
      if (await exists(arenaDir)) await rmdir(arenaDir)
      if (await exists(dir)) await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY') throw error
      })
    }
    return JSON.stringify({ finalEffectStopped: true, candidateId: id })
  },
}
