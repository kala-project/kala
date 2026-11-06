import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSandbox } from '../sandbox.js'
import { arenaGitApplyTool, arenaGitCleanupTool, arenaGitInitTool } from './arena-git-mutation.js'
import { arenaGitProbeTool } from './arena-git-probe.js'

describe('named Arena Git mutations', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('initializes, applies merge and patch, then cleans exact worktrees without Bash', async () => {
    const root = mkdtempSync(join(process.cwd(), 'arena-mutation-'))
    dirs.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    writeFileSync(join(root, 'app.txt'), 'base\n')
    git('add', 'app.txt')
    git('commit', '-m', 'base')
    const hookMarker = join(root, 'git-hook-escaped')
    for (const hook of ['post-checkout', 'pre-commit', 'post-merge']) {
      const hookPath = join(root, '.git', 'hooks', hook)
      writeFileSync(hookPath, `#!/bin/sh\ntouch '${hookMarker}'\n`)
      chmodSync(hookPath, 0o755)
    }
    const ctx = {
      origin: 'host' as const, sandbox: createSandbox({ roots: [root] }),
      sessionId: 'session', callId: 'arena-init-test', signal: new AbortController().signal,
    }
    const repositoryIdentity = JSON.parse(await arenaGitProbeTool.run({}, ctx)).repositoryIdentity as string
    for (const strategy of ['merge', 'patch'] as const) {
      const state = JSON.parse(await arenaGitInitTool.run({
        arenaId: strategy, baseRef: 'HEAD', candidates: ['one'], repositoryIdentity,
      }, ctx))
      expect(state).toMatchObject({ finalEffectStopped: true, arenaId: strategy, repoRoot: root })
      const candidate = state.candidates[0]!
      writeFileSync(join(candidate.worktreePath, 'app.txt'), `${strategy}\n`)
      await expect(arenaGitApplyTool.run({
        repoRoot: root, arenaId: strategy, baseSha: state.baseSha, candidate, strategy,
        repositoryIdentity: 'git-common-inode:0:0',
      }, ctx)).rejects.toThrow('identity changed')
      expect(readFileSync(join(root, 'app.txt'), 'utf8')).not.toBe(`${strategy}\n`)
      const applied = JSON.parse(await arenaGitApplyTool.run({
        repoRoot: root, arenaId: strategy, baseSha: state.baseSha, candidate, strategy, repositoryIdentity,
      }, ctx))
      expect(applied).toMatchObject({ finalEffectStopped: true, candidateId: 'one', strategy })
      expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe(`${strategy}\n`)
      const cleaned = JSON.parse(await arenaGitCleanupTool.run({
        repoRoot: root, arenaId: strategy, baseSha: state.baseSha, candidate, final: true, repositoryIdentity,
      }, ctx))
      expect(cleaned).toMatchObject({ finalEffectStopped: true, candidateId: 'one' })
      expect(existsSync(candidate.worktreePath)).toBe(false)
      expect(git('branch', '--list', candidate.branch)).toBe('')
    }
    expect(existsSync(hookMarker)).toBe(false)
  })

  it('rejects configured clean filters before worktree creation or apply', async () => {
    const root = mkdtempSync(join(process.cwd(), 'arena-mutation-filter-'))
    dirs.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    writeFileSync(join(root, 'app.txt'), 'base\n')
    git('add', 'app.txt')
    git('commit', '-m', 'base')
    const marker = join(root, 'helper-escaped')
    const included = join(root, 'dangerous.conf')
    writeFileSync(included, `[filter "attack"]\n  clean = touch ${marker}\n`)
    git('config', 'include.path', included)
    const ctx = {
      origin: 'host' as const, sandbox: createSandbox({ roots: [root] }),
      sessionId: 'session', callId: 'arena-init-test', signal: new AbortController().signal,
    }
    await expect(arenaGitInitTool.run({ arenaId: 'blocked', baseRef: 'HEAD', candidates: ['one'] }, ctx))
      .rejects.toThrow('external helper')
    expect(existsSync(join(root, '.kala-arena'))).toBe(false)
    expect(existsSync(marker)).toBe(false)
    git('config', '--unset', 'include.path')
    git('config', 'core.hooksPath', join(root, 'dangerous-hooks'))
    await expect(arenaGitInitTool.run({ arenaId: 'blocked', baseRef: 'HEAD', candidates: ['one'] }, ctx))
      .rejects.toThrow('external helper')
    expect(existsSync(join(root, '.kala-arena'))).toBe(false)
  })
})
