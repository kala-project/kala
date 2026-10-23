import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommitHistory } from './CommitHistory.js'
import { gitHistory, gitCommitDetails, gitCommitDiff, type GitCommit, type GitHistoryPage, type GitReadResult } from '../../lib/git-client.js'
import type { WorkspaceSocket } from '../../lib/workspace-exec.js'

vi.mock('../../lib/git-client.js', () => ({
  gitHistory: vi.fn(), gitCommitDetails: vi.fn(), gitCommitDiff: vi.fn(),
}))
const socket = {} as WorkspaceSocket
const commit: GitCommit = {
  hash: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)],
  authorName: 'Ada', authorEmail: 'ada@example.invalid', authoredAt: '2026-10-01T00:00:00Z',
  committerName: 'Lin', committerEmail: 'lin@example.invalid', committedAt: '2026-10-02T00:00:00Z',
  message: 'Merge change\n\nFull explanatory message.',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(gitHistory).mockResolvedValue({ ok: true, value: { commits: [commit], anchor: commit.hash, nextOffset: 30 } })
  vi.mocked(gitCommitDetails).mockResolvedValue({ ok: true, value: { commit, files: [{ status: 'R100', oldPath: 'old.ts', path: 'new.ts' }], filesTruncated: false } })
  vi.mocked(gitCommitDiff).mockResolvedValue({ ok: true, value: { text: '@@ -1 +1 @@\n-before\n+after', binary: false, truncated: false } })
})

describe('CommitHistory', () => {
  it('opens complete metadata and read-only file patches with explicit merge semantics', async () => {
    render(<CommitHistory socket={socket} workspaceId="ws-1" cwd="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Merge change/ }))
    expect(await screen.findByRole('dialog', { name: 'Commit details' })).toBeTruthy()
    expect(screen.getByText(commit.hash)).toBeTruthy()
    expect(screen.getByText(/ada@example.invalid/)).toBeTruthy()
    expect(screen.getByText(/lin@example.invalid/)).toBeTruthy()
    expect(screen.getByText(/Full explanatory message/)).toBeTruthy()
    expect(screen.getByText(/compared with the first parent/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'R100 old.ts → new.ts' })).toBeTruthy()
    expect(await screen.findByText('+after')).toBeTruthy()
    expect(screen.getByText('-before')).toBeTruthy()
    expect(gitCommitDiff).toHaveBeenCalledWith(socket, { workspaceId: 'ws-1', cwd: '/repo', hash: commit.hash, file: { status: 'R100', oldPath: 'old.ts', path: 'new.ts' } })
  })

  it('paginates using a fixed anchor without accumulating all commit bodies', async () => {
    render(<CommitHistory socket={socket} workspaceId="ws-1" />)
    await screen.findByRole('button', { name: /Merge change/ })
    vi.mocked(gitHistory).mockResolvedValueOnce({ ok: true, value: { commits: [{ ...commit, hash: 'd'.repeat(40), message: 'Older change' }], anchor: commit.hash } })
    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }))
    expect(await screen.findByRole('button', { name: /Older change/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Merge change/ })).toBeNull()
    expect(gitHistory).toHaveBeenLastCalledWith(socket, { workspaceId: 'ws-1', cwd: undefined, anchor: commit.hash, offset: 30 })
    fireEvent.click(screen.getByRole('button', { name: 'Newer commits' }))
    expect(await screen.findByRole('button', { name: /Merge change/ })).toBeTruthy()
    expect(gitHistory).toHaveBeenLastCalledWith(socket, { workspaceId: 'ws-1', cwd: undefined, anchor: commit.hash, offset: 0 })
  })

  it('discards stale workspace responses and displays empty, error, and offline states', async () => {
    let finish!: (result: GitReadResult<GitHistoryPage>) => void
    vi.mocked(gitHistory).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const view = render(<CommitHistory socket={socket} workspaceId="old" />)
    vi.mocked(gitHistory).mockResolvedValueOnce({ ok: true, value: { commits: [] } })
    view.rerender(<CommitHistory socket={socket} workspaceId="new" />)
    expect(await screen.findByText('No commits yet.')).toBeTruthy()
    await act(async () => { finish({ ok: true, value: { commits: [commit] } }) })
    expect(screen.queryByRole('button', { name: /Merge change/ })).toBeNull()
    vi.mocked(gitHistory).mockResolvedValueOnce({ ok: false, error: { code: 'not_git_repo', message: 'Not a repository.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'not_git_repo: Not a repository.')
    view.rerender(<CommitHistory socket={null} workspaceId="new" />)
    expect(screen.getByText('Workspace Executor is offline.')).toBeTruthy()
  })

  it('reports binary/oversized patches and empty root commits without inventing text', async () => {
    vi.mocked(gitCommitDetails).mockResolvedValueOnce({ ok: true, value: { commit: { ...commit, parents: [] }, files: [{ path: 'binary.bin', status: 'A' }, { path: 'large.txt', status: 'A' }], filesTruncated: false } })
    vi.mocked(gitCommitDiff).mockResolvedValueOnce({ ok: true, value: { text: 'Binary files /dev/null and b/binary.bin differ', binary: true, truncated: false } })
    render(<CommitHistory socket={socket} workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Merge change/ }))
    expect(await screen.findByText('Root commit: changes are compared with an empty tree.')).toBeTruthy()
    expect(await screen.findByText('Binary file: textual content is not displayed.')).toBeTruthy()
    vi.mocked(gitCommitDiff).mockResolvedValueOnce({ ok: true, value: { text: '', binary: false, truncated: true } })
    fireEvent.click(screen.getByRole('button', { name: 'A large.txt' }))
    expect(await screen.findByText(/exceeds the 512 KB/)).toBeTruthy()
    expect(screen.queryByText('Binary file: textual content is not displayed.')).toBeNull()
    expect(screen.queryByText('+after')).toBeNull()
    await waitFor(() => expect(gitCommitDiff).toHaveBeenCalledTimes(2))
  })
})
