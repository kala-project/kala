import { realpath, stat } from 'node:fs/promises'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { arenaReadGit } from './arena-git-status.js'

/** Read-only canonical identity; the caller must claim this identity before any mutation. */
export const arenaGitProbeTool: Tool = {
  name: 'arena_git_probe',
  async run(_input, ctx) {
    if (ctx.origin !== 'host' || process.platform !== 'linux') throw new ToolError('EACCES', 'unsupported Arena probe')
    const cwd = await ctx.sandbox.resolve(ctx.cwd ?? ctx.sandbox.roots[0] ?? process.cwd())
    const root = await arenaReadGit(cwd, ['rev-parse', '--show-toplevel'], ctx.signal)
    if (await realpath(root) !== root || await ctx.sandbox.resolve(root) !== root) {
      throw new ToolError('EACCES', 'repository root must be canonical within the Executor sandbox')
    }
    const common = await arenaReadGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.signal)
    if (await realpath(common) !== common || await ctx.sandbox.resolve(common) !== common) {
      throw new ToolError('EACCES', 'Git common directory must be canonical within the Executor sandbox')
    }
    const identity = await stat(common, { bigint: true })
    if (!identity.isDirectory()) throw new ToolError('EACCES', 'invalid Git common directory')
    return JSON.stringify({
      finalEffectStopped: true, repoRoot: root, repositoryIdentity: `git-common-inode:${identity.dev}:${identity.ino}`,
    })
  },
}
