import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import {
  arenaReadGit, arenaText, hasArenaGitFilterDrivers, verifiedArenaRoot, verifiedArenaWorktree,
  type ArenaReadCandidate,
} from './arena-git-status.js'

export const arenaGitDiffTool: Tool = {
  name: 'arena_git_diff',
  async run(input, ctx) {
    const { root, arenaId, baseSha, common, unsafeConfig } = await verifiedArenaRoot(input, ctx)
    if (unsafeConfig) return JSON.stringify({
      finalEffectStopped: true, error: 'Arena read refuses repository Git configuration with executable helpers',
    })
    if (typeof input.statOnly !== 'boolean'
      || typeof input.maxChars !== 'number' || !Number.isInteger(input.maxChars)
      || input.maxChars < 500 || input.maxChars > 64_000) {
      throw new ToolError('EINVAL', 'invalid diff bounds')
    }
    const diffs: Record<string, unknown>[] = []
    for (const raw of input.candidates as unknown[]) {
      if (!raw || typeof raw !== 'object') throw new ToolError('EINVAL', 'invalid candidate')
      const candidate = raw as ArenaReadCandidate
      if (candidate.status !== 'active' && candidate.status !== 'applied') {
        throw new ToolError('EINVAL', 'candidate has no active worktree')
      }
      const path = await verifiedArenaWorktree(root, arenaId, common, candidate, ctx)
      if (await hasArenaGitFilterDrivers(path, ctx.signal)) return JSON.stringify({
        finalEffectStopped: true, error: 'Arena read refuses worktree Git configuration with executable helpers',
      })
      const untracked = (await arenaReadGit(path, ['ls-files', '--others', '--exclude-standard', '-z'], ctx.signal))
        .split('\0').filter(Boolean)
      if (untracked.length > 12) {
        return JSON.stringify({
          finalEffectStopped: true, error: 'Arena diff exceeds the bounded untracked-file count; no index was modified',
        })
      }
      const stats = [await arenaReadGit(path, [
        'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat', baseSha,
      ], ctx.signal)]
      const additions: string[] = []
      for (const name of untracked) {
        if (!name || name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..')) {
          return JSON.stringify({
            finalEffectStopped: true, error: 'Arena diff cannot safely read this untracked file; no index was modified',
          })
        }
        const full = join(path, name)
        const file = await lstat(full).catch(() => undefined)
        if (!file?.isFile() || file.size > 16_000 || await realpath(full) !== full) {
          return JSON.stringify({
            finalEffectStopped: true, error: 'Arena diff cannot safely read this untracked file; no index was modified',
          })
        }
        const args = ['diff', '--no-index', '--no-ext-diff', '--no-textconv']
        const target = `./${name}`
        stats.push(await arenaReadGit(path, [...args, '--stat', '--', '/dev/null', target], ctx.signal, true))
        if (!input.statOnly) {
          additions.push(await arenaReadGit(path, [...args, '--', '/dev/null', target], ctx.signal, true))
        }
      }
      let patch = '', truncated = false
      if (!input.statOnly) {
        const complete = await arenaReadGit(path, [
          'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', baseSha,
        ], ctx.signal)
        const combined = [complete, ...additions].filter(Boolean).join('\n')
        truncated = combined.length > input.maxChars
        patch = truncated ? `${combined.slice(0, input.maxChars)}\n... [diff truncated at ${input.maxChars} chars]` : combined
      }
      diffs.push({
        id: candidate.id, label: arenaText(candidate.label), branch: candidate.branch,
        worktreePath: candidate.worktreePath, stat: stats.filter(Boolean).join('\n'),
        ...(input.statOnly ? {} : { diff: patch, truncated }),
      })
      throwIfAborted(ctx)
    }
    const result = JSON.stringify({ finalEffectStopped: true, candidates: diffs })
    return Buffer.byteLength(result) <= 200_000 ? result : JSON.stringify({
      finalEffectStopped: true, error: 'Arena diff output exceeds the bounded receipt size',
    })
  },
}
