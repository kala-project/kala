import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { gitContextTool, type GitPreflightWarning } from './git-context.js'
import { makeCtx } from './_test-helpers.js'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  writeFileSync(join(dir, 'index.ts'), 'export const a = 1\n', 'utf8')
  execFileSync('git', ['add', 'index.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'feat: initial commit'], { cwd: dir })
}

describe('git_context tool', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(process.cwd(), 'ak-git-context-')))
    initGitRepo(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('aggregates branch, staged/unstaged/untracked status, diff stats, patch, and recent commits in one call', async () => {
    // Stage a modification
    writeFileSync(join(root, 'index.ts'), 'export const a = 2\n', 'utf8')
    execFileSync('git', ['add', 'index.ts'], { cwd: root })

    // Make a second unstaged modification + an untracked file
    writeFileSync(join(root, 'index.ts'), 'export const a = 3\n', 'utf8')
    writeFileSync(join(root, 'notes.md'), '# Notes\n', 'utf8')

    const raw = await gitContextTool.run({}, makeCtx(root))
    const parsed = JSON.parse(raw) as {
      branch: { head: string; detached: boolean; oid: string | null }
      status: {
        clean: boolean
        staged: Array<{ path: string; status: string }>
        unstaged: Array<{ path: string; status: string }>
        untracked: string[]
      }
      diff: {
        stagedStat: string
        unstagedStat: string
        patch: string
        truncated: boolean
      }
      recentCommits: Array<{ subject: string; author: string }>
      preflightWarnings: GitPreflightWarning[]
    }

    expect(parsed.branch.head).toBe('main')
    expect(parsed.branch.detached).toBe(false)
    expect(parsed.branch.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(parsed.status.clean).toBe(false)
    expect(parsed.status.staged).toEqual([{ path: 'index.ts', status: 'M' }])
    expect(parsed.status.unstaged).toEqual([{ path: 'index.ts', status: 'M' }])
    expect(parsed.status.untracked).toEqual(['notes.md'])
    expect(parsed.diff.stagedStat).toContain('index.ts')
    expect(parsed.diff.unstagedStat).toContain('index.ts')
    expect(parsed.diff.patch).toContain('# Staged changes')
    expect(parsed.diff.patch).toContain('# Unstaged changes')
    expect(parsed.recentCommits).toHaveLength(1)
    expect(parsed.recentCommits[0]?.subject).toBe('feat: initial commit')
    expect(parsed.preflightWarnings).toEqual([])
  })

  it('supports scoped diffs (staged, unstaged, base_ref) and max_diff_chars truncation', async () => {
    writeFileSync(join(root, 'index.ts'), `${'export const line = "x"\n'.repeat(80)}`, 'utf8')
    execFileSync('git', ['add', 'index.ts'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'feat: large update'], { cwd: root })

    const raw = await gitContextTool.run(
      {
        scope: 'base',
        base_ref: 'HEAD~1',
        max_diff_chars: 500,
        log_limit: 2,
      },
      makeCtx(root),
    )
    const parsed = JSON.parse(raw) as {
      diff: { scope: string; baseRef: string; patch: string; truncated: boolean }
      recentCommits: Array<{ subject: string }>
    }

    expect(parsed.diff.scope).toBe('base')
    expect(parsed.diff.baseRef).toBe('HEAD~1')
    expect(parsed.diff.truncated).toBe(true)
    expect(parsed.diff.patch).toContain('[diff truncated at 500 chars')
    expect(parsed.recentCommits.map((c) => c.subject)).toEqual([
      'feat: large update',
      'feat: initial commit',
    ])
  })

  it('emits preflightWarnings for sensitive files, secret patterns, and conflict markers while allowing .env.example', async () => {
    // Safe template file (must NOT warn)
    writeFileSync(join(root, '.env.example'), 'PORT=3000\n', 'utf8')
    // Sensitive dotenv file (MUST warn)
    writeFileSync(join(root, '.env.production'), 'PORT=8080\n', 'utf8')

    // Construct marker strings dynamically so static repo scanners never flag this test file
    const pemHeader = ['-----BEGIN', ' RSA ', 'PRIVATE KEY-----'].join('')
    const conflictStart = `${'<'.repeat(7)} HEAD`
    writeFileSync(
      join(root, 'index.ts'),
      `export const a = 1\n${conflictStart}\nconst k = "${pemHeader}"\n`,
      'utf8',
    )

    const raw = await gitContextTool.run({}, makeCtx(root))
    const parsed = JSON.parse(raw) as {
      preflightWarnings: GitPreflightWarning[]
    }

    const kinds = parsed.preflightWarnings.map((w) => w.kind)
    expect(kinds).toContain('sensitive_file')
    expect(kinds).toContain('conflict_marker')
    expect(kinds).toContain('secret_pattern')
    expect(parsed.preflightWarnings.some((w) => w.path === '.env.example')).toBe(false)
    expect(parsed.preflightWarnings.some((w) => w.path === '.env.production')).toBe(true)
  })

  it('rejects cwd outside the workspace sandbox with EACCES', async () => {
    const outside = mkdtempSync(join(process.cwd(), 'ak-git-outside-'))
    try {
      await expect(
        gitContextTool.run({ cwd: outside }, makeCtx(root)),
      ).rejects.toThrow(/EACCES/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a repository whose root escapes the sandbox through a subdirectory', async () => {
    const nested = join(root, 'nested')
    mkdirSync(nested)
    const ctx = makeCtx(nested)
    await expect(gitContextTool.run({}, ctx)).rejects.toThrow(/EACCES/)
  })

  it('accepts a nested cwd when its repository and metadata remain inside the sandbox', async () => {
    const nested = join(root, 'nested')
    mkdirSync(nested)
    const parsed = JSON.parse(await gitContextTool.run({ cwd: nested }, makeCtx(root))) as {
      repoRoot: string
    }
    expect(parsed.repoRoot).toBe(root)
  })

  it('rejects linked worktree Git metadata outside the sandbox', async () => {
    const linked = mkdtempSync(join(process.cwd(), 'ak-git-linked-'))
    rmSync(linked, { recursive: true })
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'linked-test', linked], { cwd: root })
      await expect(gitContextTool.run({}, makeCtx(linked))).rejects.toThrow(/EACCES/)
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: root })
    }
  })

  it('parses renamed files and untracked filenames with whitespace and newlines', async () => {
    const renamed = 'new name\nwith newline.ts'
    const untracked = 'strange\nname.md'
    execFileSync('git', ['mv', 'index.ts', renamed], { cwd: root })
    writeFileSync(join(root, untracked), '# note\n')
    const parsed = JSON.parse(await gitContextTool.run({}, makeCtx(root))) as {
      status: { staged: Array<{ path: string; origPath?: string }>; untracked: string[] }
    }
    expect(parsed.status.staged).toEqual([{ path: renamed, origPath: 'index.ts', status: 'R' }])
    expect(parsed.status.untracked).toContain(untracked)
  })

  it('rejects option-like base refs without disclosing Git diagnostics', async () => {
    await expect(gitContextTool.run({ base_ref: '--output=/elsewhere' }, makeCtx(root)))
      .rejects.toThrow(/EINVAL: base_ref/)
  })

  it('ignores inherited Git repository overrides from the Executor process', async () => {
    const original = process.env.GIT_DIR
    process.env.GIT_DIR = join(process.cwd(), 'missing-other-repository')
    try {
      const parsed = JSON.parse(await gitContextTool.run({}, makeCtx(root))) as {
        repoRoot: string
      }
      expect(parsed.repoRoot).toBe(root)
    } finally {
      if (original === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = original
    }
  })

  it('redacts detected credentials in patches, commit metadata, and status paths while retaining warnings', async () => {
    const token = `ghp_${'A'.repeat(40)}`
    execFileSync('git', ['commit', '--allow-empty', '-m', `feat: ${token}`], { cwd: root })
    writeFileSync(join(root, `note-${token}.txt`), 'private\n')
    writeFileSync(join(root, 'index.ts'), `export const key = "${token}"\n`)
    execFileSync('git', ['add', 'index.ts'], { cwd: root })
    const parsed = await gitContextTool.run({ include_diff: true }, makeCtx(root))
    expect(parsed).not.toContain(token)
    expect(parsed).toContain('[REDACTED]')
    expect(JSON.parse(parsed).recentCommits[0].subject).toBe('feat: [REDACTED]')
    expect(JSON.parse(parsed).preflightWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'secret_pattern' }),
    ]))
    const withoutPatch = await gitContextTool.run({ include_diff: false, scope: 'base' }, makeCtx(root))
    expect(withoutPatch).not.toContain(token)
    expect(JSON.parse(withoutPatch).preflightWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'secret_pattern' }),
    ]))
  })

  it('fails closed instead of returning partial results for oversized binary or text diffs', async () => {
    writeFileSync(join(root, 'index.ts'), `export const data = "${'x'.repeat(1_100_000)}"\n`)
    await expect(gitContextTool.run({}, makeCtx(root))).rejects.toThrow(/EIO/)
  })

  it('does not run repository-configured external diff commands', async () => {
    execFileSync('git', ['config', 'diff.leak.command', 'false'], { cwd: root })
    writeFileSync(join(root, '.gitattributes'), 'index.ts diff=leak\n')
    writeFileSync(join(root, 'index.ts'), 'export const a = 42\n')
    const parsed = JSON.parse(await gitContextTool.run({}, makeCtx(root))) as {
      diff: { patch: string }
    }
    expect(parsed.diff.patch).toContain('+export const a = 42')
  })

  it('suppresses sensitive-file patches rather than returning unknown credential contents', async () => {
    writeFileSync(join(root, '.env.production'), 'APP_CREDENTIAL=unknown-secret-format\n')
    execFileSync('git', ['add', '.env.production'], { cwd: root })
    const parsed = JSON.parse(await gitContextTool.run({}, makeCtx(root))) as {
      diff: { patch: string; truncated: boolean }
      preflightWarnings: GitPreflightWarning[]
    }
    expect(parsed.diff.patch).toContain('[diff suppressed:')
    expect(parsed.diff.patch).not.toContain('unknown-secret-format')
    expect(parsed.diff.truncated).toBe(true)
    expect(parsed.preflightWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'sensitive_file', path: '.env.production' }),
    ]))
  })

  it('fails with ECANCELED when the caller has already canceled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(gitContextTool.run({}, makeCtx(root, controller.signal))).rejects.toThrow(/ECANCELED/)
  })

  it('reports binary changes and untracked paths without reading their contents', async () => {
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    execFileSync('git', ['add', 'image.bin'], { cwd: root })
    writeFileSync(join(root, 'untracked.txt'), 'untracked-only-credential\n')
    const raw = await gitContextTool.run({}, makeCtx(root))
    const parsed = JSON.parse(raw) as {
      status: { staged: Array<{ path: string }>; untracked: string[] }
      diff: { patch: string }
    }
    expect(parsed.status.staged).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'image.bin' })]))
    expect(parsed.status.untracked).toContain('untracked.txt')
    expect(parsed.diff.patch).toContain('Binary files')
    expect(raw).not.toContain('untracked-only-credential')
  })
})
