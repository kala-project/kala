import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceExecResponse } from '@agent-kernel/shared/workspace-exec'

import { SourceControlPanel } from './SourceControlPanel.js'

vi.mock('../../lib/monaco.js', () => ({
  DiffEditor: ({ original, modified, options }: { original?: string; modified?: string; options?: { renderSideBySide?: boolean } }) => (
    <div data-testid="mock-diff-editor" data-side-by-side={String(options?.renderSideBySide)}>{original}::{modified}</div>
  ),
}))

/**
 * Reference porcelain output for the mocked repo. Files are separated by
 * NUL to match `git status --porcelain=v1 -z --branch`.
 */
const PORCELAIN = '## main\0 M src/z.ts\0 M src/app.ts\0?? new.txt\0'
const REPO_ROOT = '/repo'

describe('SourceControlPanel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders grouped git changes and opens a read-only diff dialog', async () => {
    const socket = makeWorkspaceExecSocket({
      onExec: (argv) => {
        if (argv[0] === 'git' && argv[1] === 'rev-parse') {
          return { stdout: REPO_ROOT, stderr: '', exitCode: 0, durationMs: 1 }
        }
        if (argv[0] === 'git' && argv[1] === 'status') {
          return { stdout: PORCELAIN, stderr: '', exitCode: 0, durationMs: 1 }
        }
        if (argv[0] === 'git' && argv[1] === 'show' && argv[2] === ':src/app.ts') {
          return { stdout: 'old', stderr: '', exitCode: 0, durationMs: 1 }
        }
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
      onReadBinary: (path) => {
        if (path === `${REPO_ROOT}/src/app.ts`) {
          return { base64: btoa('new'), mime: 'text/plain', size: 3 }
        }
        return { base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'ENOENT' as const, message: 'not found' } }
      },
    })

    render(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="s-1" cwd="/repo/packages/app" />)

    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.getByText('Changes')).toBeTruthy()
    expect(screen.getByText('Untracked')).toBeTruthy()
    expect(screen.queryByTestId('source-control-order-by-path')).toBeNull()
    expect(screen.getByTestId('source-control-view-mode-toggle').getAttribute('data-view-mode')).toBe('tree')
    expect(screen.getAllByTestId('source-control-dir').map((node) => node.textContent)).toEqual(['src'])
    expect(screen.getAllByTestId('source-control-file').map((node) => node.textContent)).toEqual(['Mapp.ts', 'Mz.ts', '?new.txt'])
    fireEvent.click(screen.getByTestId('source-control-view-mode-toggle'))
    expect(screen.queryByTestId('source-control-dir')).toBeNull()
    expect(screen.getAllByTestId('source-control-file').map((node) => node.textContent)).toEqual(['Msrc/z.ts', 'Msrc/app.ts', '?new.txt'])
    expect(localStorage.getItem('ak-source-control-view-mode:session:s-1')).toBe('list')
    fireEvent.click(screen.getByTestId('source-control-view-mode-toggle'))
    fireEvent.click(screen.getByText('src'))
    expect(screen.getAllByTestId('source-control-file').map((node) => node.textContent)).toEqual(['?new.txt'])
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByText('app.ts'))

    await waitFor(() => expect(screen.getByTestId('mock-diff-editor').textContent).toContain('old::new'))
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-side-by-side')).toBe('true')
    fireEvent.click(screen.getByTestId('source-control-diff-inline'))
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-side-by-side')).toBe('false')
    // Both git status and git show reach the executor through workspace:exec.
    const execCalls = socket.emitMock.mock.calls.filter(([event]) => event === 'workspace:exec')
    expect(execCalls.length).toBeGreaterThanOrEqual(3)
    expect(execCalls.some(([, payload]) => JSON.stringify((payload as { argv: string[] }).argv).includes('status'))).toBe(true)
    expect(execCalls.some(([, payload]) => JSON.stringify((payload as { argv: string[] }).argv).includes('show'))).toBe(true)
  })

  it('loads after its socket connects and refreshes after reconnect without changing memoized props', async () => {
    const socket = makeWorkspaceExecSocket({ onExec: (argv) => ({ stdout: argv.includes('status') ? PORCELAIN : REPO_ROOT }) })
    socket.setConnected(false)
    const view = render(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="s-1" cwd="/repo" />)
    expect(socket.emitMock).not.toHaveBeenCalled()
    act(() => socket.setConnected(true))
    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.getAllByTestId('source-control-file')).toHaveLength(3)
    act(() => socket.setConnected(false))
    expect(screen.queryByTestId('source-control-file')).toBeNull()
    act(() => socket.setConnected(true))
    await waitFor(() => expect(socket.emitMock.mock.calls.filter(([event, payload]) => event === 'workspace:exec' && (payload.argv as string[]).includes('status'))).toHaveLength(2))
    expect(await screen.findByText('main')).toBeTruthy()
    view.unmount()
    expect(socket.listenerCount()).toBe(0)
  })

  it('persists list or tree view per session', async () => {
    const socket = makeWorkspaceExecSocket({
      onExec: (argv) => {
        if (argv[0] === 'git' && argv[1] === 'rev-parse') return { stdout: REPO_ROOT, stderr: '', exitCode: 0, durationMs: 1 }
        if (argv[0] === 'git' && argv[1] === 'status') return { stdout: PORCELAIN, stderr: '', exitCode: 0, durationMs: 1 }
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
    })

    const { rerender } = render(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="s-1" cwd="/repo" />)
    expect(await screen.findByText('main')).toBeTruthy()
    fireEvent.click(screen.getByTestId('source-control-view-mode-toggle'))
    expect(localStorage.getItem('ak-source-control-view-mode:session:s-1')).toBe('list')

    rerender(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="s-1" cwd="/repo" />)
    await waitFor(() => expect(screen.getByTestId('source-control-view-mode-toggle').getAttribute('data-view-mode')).toBe('list'))
    expect(screen.queryByTestId('source-control-dir')).toBeNull()

    rerender(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="s-2" cwd="/repo" />)
    await waitFor(() => expect(screen.getByTestId('source-control-view-mode-toggle').getAttribute('data-view-mode')).toBe('tree'))
    expect(screen.getByTestId('source-control-dir').textContent).toBe('src')
  })

  it('offers commit history even when the working tree has no changes', async () => {
    const hash = 'a'.repeat(40)
    const socket = makeWorkspaceExecSocket({
      onExec: (argv) => {
        if (argv.includes('--show-toplevel')) return { stdout: `${REPO_ROOT}\n` }
        if (argv.includes('--verify')) return { stdout: `${hash}\n` }
        if (argv.includes('status')) return { stdout: '## main\0' }
        if (argv.includes('log')) return { stdout: [hash, '', 'Ada', 'ada@example.invalid', '2026-10-01T00:00:00Z', 'Ada', 'ada@example.invalid', '2026-10-01T00:00:00Z', 'Initial commit\n', ''].join('\0') }
        return { stdout: '' }
      },
    })
    render(<SourceControlPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" />)
    expect(await screen.findByText('No changes.')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Commit history' }))
    expect(await screen.findByRole('button', { name: /Initial commit/ })).toBeTruthy()
    expect(screen.queryByText('No changes.')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Commit history' }).getAttribute('aria-selected')).toBe('true')
  })
})

type ExecStub = Partial<Omit<WorkspaceExecResponse, 'requestId'>>

function makeWorkspaceExecSocket(input: {
  onExec: (argv: readonly string[]) => ExecStub
  onReadBinary?: (path: string) => { base64: string; mime: string; size: number; error?: { code: 'ENOENT' | 'EACCES' | 'EINVAL' | 'EIO'; message: string } }
}) {
  const emitMock = vi.fn((event: string, payload: Record<string, unknown>, ack?: (payload: unknown) => void) => {
    if (event === 'workspace:exec') {
      const argv = (payload as { argv: readonly string[] }).argv
      const stub = input.onExec(argv)
      queueMicrotask(() => ack?.({
        requestId: (payload as { requestId: string }).requestId,
        stdout: stub.stdout ?? '',
        stderr: stub.stderr ?? '',
        exitCode: stub.exitCode ?? 0,
        durationMs: stub.durationMs ?? 0,
        ...(stub.error ? { error: stub.error } : {}),
      }))
    }
    if (event === 'workspace:read_binary') {
      const path = (payload as { path: string }).path
      const stub = input.onReadBinary?.(path) ?? { base64: '', mime: 'application/octet-stream', size: 0 }
      queueMicrotask(() => ack?.({
        requestId: (payload as { requestId: string }).requestId,
        base64: stub.base64,
        mime: stub.mime,
        size: stub.size,
        ...(stub.error ? { error: stub.error } : {}),
      }))
    }
    return undefined
  })
  const listeners = new Map<string, Set<() => void>>()
  const socket = {
    emit: emitMock,
    connected: true,
    on(event: string, listener: () => void) { const set = listeners.get(event) ?? new Set<() => void>(); set.add(listener); listeners.set(event, set); return socket },
    off(event: string, listener: () => void) { listeners.get(event)?.delete(listener); return socket },
  }
  return {
    emitMock,
    setConnected(connected: boolean) { socket.connected = connected; for (const listener of listeners.get(connected ? 'connect' : 'disconnect') ?? []) listener() },
    listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0) },
    asDashboardSocket() { return socket as never },
  }
}
