import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSandbox } from '../sandbox.js'
import { arenaGitStatusTool } from './arena-git-status.js'
import { arenaGitDiffTool } from './arena-git-diff.js'

describe('arena_git_status', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('inspects one exact worktree without Bash and rejects path substitution', async () => {
    const root = mkdtempSync(join(process.cwd(), 'arena-git-status-'))
    dirs.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    writeFileSync(join(root, 'app.txt'), 'original\n')
    writeFileSync(join(root, '.gitattributes'), 'app.txt diff=escape filter=escape\n')
    git('add', 'app.txt', '.gitattributes')
    git('commit', '-m', 'base')
    const baseSha = git('rev-parse', 'HEAD')
    const path = join(root, '.kala-arena', 'sample', 'one')
    git('worktree', 'add', '-b', 'kala-arena/sample/one', path)
    writeFileSync(join(path, 'app.txt'), 'updated\n')
    const ctx = {
      origin: 'host' as const, sandbox: createSandbox({ roots: [root] }),
      sessionId: 'session', callId: 'arena-status-test', signal: new AbortController().signal,
    }
    const input = {
      repoRoot: root, arenaId: 'sample', baseSha,
      candidates: [{ id: 'one', label: 'One', status: 'active', branch: 'kala-arena/sample/one', worktreePath: path }],
    }
    const result = JSON.parse(await arenaGitStatusTool.run(input, ctx))
    expect(result).toMatchObject({
      finalEffectStopped: true,
      candidates: [{ id: 'one', dirtyFileCount: 1, changedFiles: ['app.txt'], headSha: baseSha }],
    })
    await expect(arenaGitStatusTool.run({
      ...input, candidates: [{ ...input.candidates[0], worktreePath: root }],
    }, ctx)).rejects.toThrow('candidate identity mismatch')
    await expect(arenaGitStatusTool.run(input, { ...ctx, origin: undefined }))
      .rejects.toThrow('supported Host admission')
    const marker = join(root, 'helper-escaped')
    git('config', 'core.fsmonitor', `touch ${marker}`)
    git('config', 'alias.diff', `!touch ${marker}`)
    git('config', 'diff.escape.textconv', `touch ${marker}`)
    const included = join(root, 'included-git-config')
    writeFileSync(included, `[core]\n\tfsmonitor = touch ${marker}\n[diff "escape"]\n\ttextconv = touch ${marker}\n[filter "escape"]\n\tclean = touch ${marker}\n\tsmudge = touch ${marker}\n`)
    git('config', 'include.path', included)
    expect(JSON.parse(await arenaGitStatusTool.run(input, ctx))).toMatchObject({
      finalEffectStopped: true, error: expect.stringContaining('executable helpers'),
    })
    expect(JSON.parse(await arenaGitDiffTool.run({ ...input, statOnly: true, maxChars: 500 }, ctx)))
      .toMatchObject({ finalEffectStopped: true, error: expect.stringContaining('executable helpers') })
    expect(existsSync(marker)).toBe(false)
    writeFileSync(included, `[core]\n\tfsmonitor = touch ${marker}\n[diff "escape"]\n\ttextconv = touch ${marker}\n`)
    git('config', '--unset', 'core.fsmonitor')
    git('config', '--unset', 'alias.diff')
    git('config', '--unset', 'diff.escape.textconv')
    writeFileSync(included, '')
    git('config', 'extensions.worktreeConfig', 'true')
    git('-C', path, 'config', '--worktree', 'filter.escape.clean', `touch ${marker}`)
    expect(JSON.parse(await arenaGitStatusTool.run(input, ctx))).toMatchObject({
      finalEffectStopped: true, error: expect.stringContaining('worktree Git configuration'),
    })
    expect(JSON.parse(await arenaGitDiffTool.run({ ...input, statOnly: true, maxChars: 500 }, ctx)))
      .toMatchObject({ finalEffectStopped: true, error: expect.stringContaining('worktree Git configuration') })
    expect(existsSync(marker)).toBe(false)
    git('-C', path, 'config', '--worktree', '--unset', 'filter.escape.clean')
    expect(JSON.parse(await arenaGitStatusTool.run(input, ctx))).toMatchObject({ finalEffectStopped: true })
    expect(existsSync(marker)).toBe(false)
    const changed = JSON.parse(await arenaGitDiffTool.run({
      ...input, statOnly: false, maxChars: 16_000,
    }, ctx))
    expect(changed).toMatchObject({
      finalEffectStopped: true, candidates: [{ id: 'one', truncated: false, diff: expect.stringContaining('+updated') }],
    })
    expect(existsSync(marker)).toBe(false)
    writeFileSync(join(path, 'untracked.txt'), 'not staged\n')
    const noIndexChange = git('-c', 'core.fsmonitor=false', '-C', path, 'status', '--porcelain')
    const withUntracked = JSON.parse(await arenaGitDiffTool.run({ ...input, statOnly: false, maxChars: 16_000 }, ctx))
    expect(withUntracked).toMatchObject({
      finalEffectStopped: true, candidates: [{ diff: expect.stringContaining('+not staged'), stat: expect.stringContaining('untracked.txt') }],
    })
    expect(git('-c', 'core.fsmonitor=false', '-C', path, 'status', '--porcelain')).toBe(noIndexChange)
    expect(existsSync(marker)).toBe(false)
    symlinkSync(root, join(path, 'external-link'))
    const unsupported = JSON.parse(await arenaGitDiffTool.run({ ...input, statOnly: true, maxChars: 500 }, ctx))
    expect(unsupported).toMatchObject({ finalEffectStopped: true, error: expect.stringContaining('cannot safely read') })
    git('-c', 'core.fsmonitor=false', 'worktree', 'remove', '--force', path)
    symlinkSync(root, path)
    await expect(arenaGitDiffTool.run({ ...input, statOnly: true, maxChars: 500 }, ctx))
      .rejects.toThrow()
    expect(existsSync(marker)).toBe(false)
  })
})
