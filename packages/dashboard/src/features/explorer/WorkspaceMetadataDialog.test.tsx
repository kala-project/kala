import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import { WorkspaceMetadataDialog } from './WorkspaceMetadataDialog.js'

const executor: AttachedExecutor = {
  executorId: 'ex-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  workingDir: '/tmp/not-a-workspace-property',
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const session: SessionSummary = {
  sessionId: 'sess-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  createdAt: '2026-07-05T10:00:00.000Z',
  eventCount: 0,
}

describe('WorkspaceMetadataDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits a workspace display-name rename', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ identities: [] }), { status: 200 })))
    const onRename = vi.fn()
    render(
      <WorkspaceMetadataDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-1"
        executor={executor}
        sessions={[session]}
        onRename={onRename}
      />,
    )

    const input = screen.getByTestId('workspace-metadata-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'primary dev box' } })
    fireEvent.click(screen.getByTestId('workspace-metadata-rename-button'))

    expect(onRename).toHaveBeenCalledWith('primary dev box')
  })

  it('does not present executor workingDir as a workspace property', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ identities: [] }), { status: 200 })))
    render(
      <WorkspaceMetadataDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-1"
        executor={executor}
        sessions={[session]}
      />,
    )

    expect(screen.queryByText('Working dir')).toBeNull()
    expect(screen.queryByText('/tmp/not-a-workspace-property')).toBeNull()
    expect(screen.getByTestId('workspace-metadata-dialog').className).toContain('grid-rows-[auto_minmax(0,1fr)]')
    expect(screen.getByTestId('workspace-metadata-body').querySelector('[data-radix-scroll-area-viewport]')).toBeTruthy()
    expect(screen.queryByTestId('workspace-technical-details')).toBeNull()
    fireEvent.click(screen.getByTestId('workspace-metadata-runtime-tab'))
    expect(screen.getByTestId('workspace-technical-details').tagName).toBe('SECTION')
  })

  it('shows and revokes a saved executor identity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/auth/executor-identities') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, workspaceId: 'ws-1', revoked: true }), { status: 200 })
      }
      return new Response(JSON.stringify({
        identities: [{ workspaceId: 'ws-1', createdAt: '2026-07-05T10:00:00.000Z', lastSeenAt: '2026-07-05T10:30:00.000Z' }],
      }), { status: 200 })
    })

    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkspaceMetadataDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-1"
        executor={executor}
        sessions={[session]}
      />,
    )

    await screen.findByText(/This workspace has a saved reconnect identity/i)
    fireEvent.click(screen.getByTestId('workspace-revoke-identity-button'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/auth/executor-identities?workspaceId=ws-1', { method: 'DELETE' })
    })
    await waitFor(() => {
      expect(screen.getByText(/No saved reconnect identity/i)).toBeTruthy()
    })
  })

  it('separates overview, session summary, and runtime technical content into tabs', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ identities: [] }), { status: 200 })))
    const onOpenSession = vi.fn()
    render(<WorkspaceMetadataDialog open onOpenChange={() => {}} workspaceId="ws-1" executor={{ ...executor, hostname: 'placeholder-host', defaultCwd: '/placeholder/workspace', executorVersion: '1.2.3', clientVersion: '4' }} sessions={[{ ...session, label: 'Placeholder session', status: 'thinking' }]} onOpenSession={onOpenSession} />)
    expect(screen.getByTestId('workspace-overview-details').textContent).toContain('/placeholder/workspace')
    expect(screen.queryByTestId('workspace-session-list')).toBeNull()
    fireEvent.click(screen.getByTestId('workspace-metadata-sessions-tab'))
    expect(screen.getByTestId('workspace-session-list').textContent).toContain('Placeholder session')
    expect(screen.getByTestId('workspace-session-list').textContent).toContain('1 active')
    fireEvent.click(screen.getByTestId('workspace-session-item'))
    expect(onOpenSession).toHaveBeenCalledWith('sess-1')
    fireEvent.click(screen.getByTestId('workspace-metadata-runtime-tab'))
    expect(screen.getByTestId('workspace-technical-details').textContent).toContain('1.2.3')
  })
})
