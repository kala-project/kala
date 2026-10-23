import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { gitHistory, gitCommitDetails, gitCommitDiff, languageForPath, parsePorcelainStatus } from './git-client.js'
import { workspaceExec, type WorkspaceSocket } from './workspace-exec.js'

vi.mock('./workspace-exec.js', () => ({ workspaceExec: vi.fn(), workspaceReadBinary: vi.fn() }))

describe('parsePorcelainStatus', () => {
  it('parses staged, unstaged, untracked, and renamed entries', () => {
    const parsed = parsePorcelainStatus('## main\0 M src/a.ts\0A  src/b.ts\0?? src/c.ts\0R  src/new.ts\0src/old.ts\0')

    expect(parsed.branch).toBe('main')
    expect(parsed.files).toEqual([
      { path: 'src/a.ts', status: 'modified', staged: false, unstaged: true },
      { path: 'src/b.ts', status: 'added', staged: true, unstaged: false },
      { path: 'src/c.ts', status: 'untracked', staged: false, unstaged: true },
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed', staged: true, unstaged: false },
    ])
  })

  it('marks conflicted entries', () => {
    const parsed = parsePorcelainStatus('## main\0UU src/x.ts\0AA src/y.ts\0DD src/z.ts\0')
    expect(parsed.files.map((f) => f.status)).toEqual(['conflicted', 'conflicted', 'conflicted'])
  })

  it('treats detached HEAD as unnamed branch', () => {
    const parsed = parsePorcelainStatus('## HEAD (no branch)\0')
    expect(parsed.branch).toBeUndefined()
  })

  it('skips malformed short lines', () => {
    const parsed = parsePorcelainStatus('## main\0X\0 M ok.ts\0')
    expect(parsed.files).toEqual([{ path: 'ok.ts', status: 'modified', staged: false, unstaged: true }])
  })
})

describe('languageForPath', () => {
  it('maps common extensions', () => {
    expect(languageForPath('a.ts')).toBe('typescript')
    expect(languageForPath('a.tsx')).toBe('typescript')
    expect(languageForPath('a.js')).toBe('javascript')
    expect(languageForPath('a.py')).toBe('python')
    expect(languageForPath('a.md')).toBe('markdown')
    expect(languageForPath('README')).toBe('plaintext')
  })

  describe('read-only commit queries against real Git', () => {
    let directory: string
    const socket = {} as WorkspaceSocket
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const options = () => ({ workspaceId: 'workspace-1', cwd: directory })
    const commit = (message: string) => {
      git('add', '--all')
      git('-c', 'user.name=Test Author', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', message)
      return git('rev-parse', 'HEAD').trim()
    }
    beforeEach(() => {
      directory = join(process.cwd(), `.git-client-test-${randomUUID()}`)
      mkdirSync(directory)
      git('init', '--quiet', '--initial-branch=main')
      vi.mocked(workspaceExec).mockImplementation(async (_socket, _workspaceId, argv, opts) => {
        try {
          const output = execFileSync(argv[0]!, argv.slice(1), { cwd: opts?.cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) } })
          const bytes = new TextEncoder().encode(output)
          const limit = opts?.maxOutputBytes ?? bytes.length
          return { requestId: 'r', stdout: new TextDecoder().decode(bytes.subarray(0, limit)), stderr: '', exitCode: 0, durationMs: 0, ...(bytes.length > limit ? { truncated: true } : {}) }
        } catch (error) {
          const failure = error as { status?: number; stderr?: string; message: string }
          return { requestId: 'r', stdout: '', stderr: String(failure.stderr ?? failure.message), exitCode: failure.status ?? 1, durationMs: 0 }
        }
      })
    })
    afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.resetAllMocks() })

    it('handles an unborn repository, full metadata/message, root additions and literal unusual paths', async () => {
      expect(await gitHistory(socket, options())).toEqual({ ok: true, value: { commits: [] } })
      const path = ':(glob)* [a];$(unsafe).txt'
      writeFileSync(join(directory, path), 'root content\n')
      const hash = commit('Root subject\n\nFull body with details\nAnother line')
      git('config', 'diff.external', 'kala-must-not-run-external-diff')
      git('config', 'diff.custom.textconv', 'kala-must-not-run-textconv')
      writeFileSync(join(directory, '.git', 'info', 'attributes'), '*.txt diff=custom\n')
      const history = await gitHistory(socket, options())
      expect(history).toMatchObject({ ok: true, value: { anchor: hash, commits: [{ hash, authorName: 'Test Author', authorEmail: 'test@example.invalid', parents: [], message: 'Root subject\n\nFull body with details\nAnother line\n' }] } })
      const details = await gitCommitDetails(socket, { ...options(), hash })
      expect(details).toMatchObject({ ok: true, value: { files: [{ status: 'A', path }], filesTruncated: false } })
      const patch = await gitCommitDiff(socket, { ...options(), hash, file: { status: 'A', path } })
      expect(patch).toMatchObject({ ok: true, value: { binary: false, truncated: false, text: expect.stringContaining('+root content') } })
      for (const [, , argv] of vi.mocked(workspaceExec).mock.calls) {
        expect(argv).toContain('--no-pager')
        expect(argv).toContain('--literal-pathspecs')
        expect(argv[0]).toBe('git')
      }
    })

    it('uses a stable history anchor across pages and new HEAD commits', async () => {
      for (let i = 0; i < 32; i++) commit(`Commit ${i}`)
      const first = await gitHistory(socket, options())
      if (!first.ok) throw new Error(first.error.message)
      expect(first.value.commits).toHaveLength(30)
      expect(first.value.nextOffset).toBe(30)
      commit('New HEAD')
      const second = await gitHistory(socket, { ...options(), anchor: first.value.anchor, offset: first.value.nextOffset })
      if (!second.ok) throw new Error(second.error.message)
      expect(second.value.commits).toHaveLength(2)
      expect(second.value.commits[0]!.message).toBe('Commit 1\n')
      expect(second.value.nextOffset).toBeUndefined()
    })

    it('preserves renamed paths, reports binary files and refuses oversized partial patches', async () => {
      writeFileSync(join(directory, 'old.txt'), 'original\n')
      commit('Initial')
      renameSync(join(directory, 'old.txt'), join(directory, 'new.txt'))
      writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
      writeFileSync(join(directory, 'large.txt'), 'a'.repeat(600_000))
      writeFileSync(join(directory, 'many-lines.txt'), 'short\n'.repeat(11_000))
      const hash = commit('Rename and binary')
      const details = await gitCommitDetails(socket, { ...options(), hash })
      expect(details).toMatchObject({ ok: true, value: { files: expect.arrayContaining([{ status: 'R100', path: 'new.txt', oldPath: 'old.txt' }]) } })
      expect(await gitCommitDiff(socket, { ...options(), hash, file: { status: 'R100', path: 'new.txt', oldPath: 'old.txt' } })).toMatchObject({ ok: true, value: { text: expect.stringContaining('rename from old.txt') } })
      expect(await gitCommitDiff(socket, { ...options(), hash, file: { status: 'A', path: 'binary.bin' } })).toMatchObject({ ok: true, value: { binary: true } })
      expect(await gitCommitDiff(socket, { ...options(), hash, file: { status: 'A', path: 'large.txt' } })).toEqual({ ok: true, value: { text: '', binary: false, truncated: true } })
      expect(await gitCommitDiff(socket, { ...options(), hash, file: { status: 'A', path: 'many-lines.txt' } })).toEqual({ ok: true, value: { text: '', binary: false, truncated: true } })
    })

    it('compares a merge against its first parent and handles empty commits', async () => {
      writeFileSync(join(directory, 'base.txt'), 'base\n')
      commit('Base')
      git('checkout', '--quiet', '-b', 'topic')
      writeFileSync(join(directory, 'topic.txt'), 'topic\n')
      commit('Topic')
      git('checkout', '--quiet', 'main')
      writeFileSync(join(directory, 'main.txt'), 'main\n')
      const firstParent = commit('Main')
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'merge', '--no-ff', '-m', 'Merge topic', 'topic')
      const hash = git('rev-parse', 'HEAD').trim()
      const details = await gitCommitDetails(socket, { ...options(), hash })
      expect(details).toMatchObject({ ok: true, value: { commit: { parents: [firstParent, expect.any(String)] }, files: [{ path: 'topic.txt', status: 'A' }] } })
      expect(await gitCommitDiff(socket, { ...options(), hash, file: { path: 'topic.txt', status: 'A' } })).toMatchObject({ ok: true, value: { text: expect.stringContaining('+topic') } })
      const empty = commit('Empty')
      expect(await gitCommitDetails(socket, { ...options(), hash: empty })).toMatchObject({ ok: true, value: { files: [] } })
    })

    it('rejects untrusted revisions and paths, maps nonrepos, timeout, missing git and disconnected executor errors', async () => {
      expect(await gitCommitDetails(socket, { ...options(), hash: '--output=/danger' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(workspaceExec).not.toHaveBeenCalled()
      expect(await gitHistory(socket, { ...options(), offset: -1 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      const hash = commit('Empty')
      expect(await gitCommitDiff(socket, { ...options(), hash, file: { status: 'M', path: '../../outside' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      rmSync(join(directory, '.git'), { recursive: true })
      expect(await gitHistory(socket, options())).toMatchObject({ ok: false, error: { code: 'not_git_repo' } })
      for (const [code, expected] of [['ETIMEDOUT', 'timeout'], ['ENOENT', 'git_unavailable'], ['EACCES', 'executor_unavailable']] as const) {
        vi.mocked(workspaceExec).mockResolvedValueOnce({ requestId: 'r', stdout: '', stderr: '', exitCode: null, durationMs: 0, error: { code, message: 'failure' } })
        expect(await gitHistory(socket, options())).toMatchObject({ ok: false, error: { code: expected } })
      }
      vi.mocked(workspaceExec).mockRejectedValueOnce(new Error('offline'))
      expect(await gitHistory(socket, options())).toMatchObject({ ok: false, error: { code: 'executor_unavailable' } })
    })

    it('caps changed-file lists and returns a typed error for oversized metadata', async () => {
      for (let i = 0; i < 1_001; i++) writeFileSync(join(directory, `file-${i}.txt`), '')
      const hash = commit('Many files')
      const details = await gitCommitDetails(socket, { ...options(), hash })
      if (!details.ok) throw new Error(details.error.message)
      expect(details.value.files).toHaveLength(1_000)
      expect(details.value.filesTruncated).toBe(true)
      vi.mocked(workspaceExec).mockResolvedValueOnce({ requestId: 'r', stdout: `${directory}\n`, stderr: '', exitCode: 0, durationMs: 0 })
        .mockResolvedValueOnce({ requestId: 'r', stdout: '', stderr: '', exitCode: 0, durationMs: 0, truncated: true })
      expect(await gitCommitDetails(socket, { ...options(), hash })).toMatchObject({ ok: false, error: { code: 'too_large' } })
    })
  })
})
