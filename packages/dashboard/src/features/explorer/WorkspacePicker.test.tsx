import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KERNEL_AGENT_RUNTIME_CAPABILITIES, type AttachedExecutor, type DirListResult } from '@agent-kernel/shared'

import { i18n } from '../../i18n/index.js'
import { NewSessionDialog } from './WorkspacePicker.js'

const wsA: AttachedExecutor = {
  executorId: 'ex-a',
  workspaceId: 'ws-a',
  workspaceName: 'mbp',
  tools: [],
  sandboxRoots: ['/tmp/root'],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  ipAddresses: ['192.0.2.1'],
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const wsB: AttachedExecutor = {
  ...wsA,
  executorId: 'ex-b',
  workspaceId: 'ws-b',
  workspaceName: 'linux-box',
  sandboxRoots: ['/work/project'],
  os: 'linux',
}

type Handler = (payload: DirListResult) => void

function makeSocket(): {
  socket: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> }
  emitDirList(payload: DirListResult): void
  ackDirList(payload: DirListResult): void
  lastDirRequest(): { requestId: string; workspaceId: string; path?: string }
} {
  let handler: Handler | null = null
  let ack: Handler | null = null
  const emit = vi.fn((event: string, _payload: unknown, callback?: Handler) => {
    if (event === 'client:list_dirs') ack = callback ?? null
  })
  return {
    socket: {
      on: vi.fn((event: string, cb: Handler) => {
        if (event === 'server:dir_list') handler = cb
      }),
      off: vi.fn((event: string, cb: Handler) => {
        if (event === 'server:dir_list' && handler === cb) handler = null
      }),
      emit,
    },
    emitDirList(payload) {
      handler?.(payload)
    },
    ackDirList(payload) {
      ack?.(payload)
    },
    lastDirRequest() {
      const calls = emit.mock.calls.filter(([event]) => event === 'client:list_dirs')
      return calls.at(-1)?.[1] as { requestId: string; workspaceId: string; path?: string }
    },
  }
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <NewSessionDialog
        open={false}
        workspaces={[wsA]}
        socket={makeSocket().socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('uses one visible Finder column on mobile while preserving desktop column history', async () => {
    const harness = makeSocket()
    render(<NewSessionDialog open workspaces={[wsA]} socket={harness.socket as never} onCreate={() => {}} onCreateSimpleChat={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(harness.lastDirRequest()).toBeTruthy())
    act(() => harness.emitDirList({ requestId: harness.lastDirRequest().requestId, workspaceId: 'ws-a', path: '/tmp/root', roots: ['/tmp/root'], entries: [{ name: 'project', path: '/tmp/root/project', type: 'directory' }] }))
    fireEvent.click(screen.getByText('project'))
    act(() => harness.emitDirList({ requestId: harness.lastDirRequest().requestId, workspaceId: 'ws-a', path: '/tmp/root/project', roots: ['/tmp/root'], entries: [] }))
    const columns = screen.getAllByTestId('finder-column')
    expect(columns).toHaveLength(2)
    expect(columns[0]!.className).toContain('hidden md:flex')
    expect(columns[1]!.className).not.toContain('hidden md:flex')
    expect(screen.getByTestId('directory-picker-finder').querySelector('.w-64')).toBeNull()
  })

  it('keeps session options readable and gives each Finder column independent vertical scrolling', async () => {
    const harness = makeSocket()
    render(<NewSessionDialog open workspaces={[wsA]} socket={harness.socket as never} onCreate={() => {}} onCreateSimpleChat={() => {}} onCancel={() => {}} />)

    const options = screen.getByTestId('new-session-options')
    expect(options.className).toContain('grid-cols-1')
    expect(screen.getByTestId('new-session-runtime-kernel').className).toContain('min-h-11')
    expect(screen.getByTestId('new-session-mode-chat').className).toContain('min-h-[3.25rem]')

    await waitFor(() => expect(harness.lastDirRequest()).toBeTruthy())
    act(() => harness.emitDirList({
      requestId: harness.lastDirRequest().requestId,
      workspaceId: 'ws-a',
      path: '/tmp/root',
      roots: ['/tmp/root'],
      entries: [{ name: 'project', path: '/tmp/root/project', type: 'directory' }],
    }))
    fireEvent.click(screen.getByText('project'))
    act(() => harness.emitDirList({
      requestId: harness.lastDirRequest().requestId,
      workspaceId: 'ws-a',
      path: '/tmp/root/project',
      roots: ['/tmp/root'],
      entries: [{ name: 'README.md', path: '/tmp/root/project/README.md', type: 'file' }],
    }))

    const columns = screen.getAllByTestId('finder-column')
    const scrollers = screen.getAllByTestId('finder-column-scroll')
    const finder = screen.getByTestId('directory-picker-finder')
    expect(columns).toHaveLength(2)
    expect(scrollers).toHaveLength(2)
    expect(screen.getAllByTestId('finder-column-header').map((header) => header.textContent)).toEqual(['root', 'project'])
    expect(screen.getAllByTestId('finder-column-header')[1]?.getAttribute('title')).toBe('/tmp/root/project')
    expect(finder.className).toContain('overflow-x-auto')
    expect(finder.className).toContain('overflow-y-hidden')
    expect(columns.every((column) => column.className.includes('h-full') && column.className.includes('overflow-hidden'))).toBe(true)
    expect(scrollers.every((scroller) => scroller.className.includes('overflow-y-auto'))).toBe(true)
    expect(screen.getByText('README.md')).toBeTruthy()
  })

  it('uses the shared mobile Sheet contract with a touch-sized close control', () => {
    render(
      <NewSessionDialog open workspaces={[wsA]} socket={makeSocket().socket as never} onCreate={() => {}} onCreateSimpleChat={() => {}} onCancel={() => {}} />,
    )
    const dialog = screen.getByTestId('new-session-dialog')
    expect(dialog.className).toContain('!top-[calc(var(--ak-viewport-offset-top,0px)+var(--ak-viewport-h,100dvh))]')
    expect(dialog.className).toContain('w-screen')
    expect(dialog.className).toContain('--ak-viewport-h')
    expect(dialog.className).toContain('grid-rows-[auto_auto_minmax(0,1fr)_auto]')
    expect(dialog.className).toContain('sm:max-w-4xl')
    expect(screen.getByTestId('new-session-options').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('new-session-options').className).toContain('grid-cols-1')
    expect(screen.getByTestId('new-session-mode-chat').className).not.toContain('truncate')
    expect(screen.getByTestId('new-session-mode-dag').className).toContain('min-h-[3.25rem]')
    expect(screen.getByTestId('new-session-mode-chat').textContent).toContain('Standard Chat')
    expect(screen.getByTestId('new-session-mode-chat').textContent).toContain('One turn at a time')
    expect(screen.getByTestId('new-session-mode-dag').textContent).toContain('DAG-First')
    expect(screen.getByTestId('new-session-mode-dag').textContent).toContain('Plan dependent tasks')
    expect(screen.getByTestId('dir-picker-actions').className).toContain('grid-cols-2')
    for (const id of ['up', 'root', 'refresh', 'new-folder']) {
      const button = screen.getByTestId(`dir-picker-${id}`)
      expect(button.className).toContain('h-11')
      expect(button.querySelector('span')?.textContent).toBeTruthy()
    }
    expect(screen.getByTestId('new-session-close').className).toContain('h-11 w-11')
  })

  it('shows complete Chinese mode and directory action labels', async () => {
    await i18n.changeLanguage('zh')
    try {
      render(<NewSessionDialog open workspaces={[wsA]} socket={makeSocket().socket as never} onCreate={() => {}} onCreateSimpleChat={() => {}} onCancel={() => {}} />)
      expect(screen.getByTestId('new-session-mode-chat').textContent).toContain('标准对话')
      expect(screen.getByTestId('new-session-mode-chat').textContent).toContain('逐轮交流')
      expect(screen.getByTestId('new-session-mode-dag').textContent).toContain('DAG-First')
      expect(screen.getByTestId('new-session-mode-dag').textContent).toContain('规划依赖任务')
      expect(screen.getByTestId('new-session-mode-chat').className).not.toContain('truncate')
      for (const [id, label] of [['up', '上一级'], ['root', '根目录'], ['refresh', '刷新'], ['new-folder', '新建文件夹']]) {
        expect(screen.getByTestId(`dir-picker-${id}`).textContent).toBe(label)
      }
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('presents chat and workspace sessions as explicit creation paths', () => {
    const onCreateSimpleChat = vi.fn()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={makeSocket().socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={onCreateSimpleChat}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByText('Start a conversation')).toBeTruthy()
    expect(screen.getByText('Workspace sessions')).toBeTruthy()
    expect(screen.getByTestId('new-session-create').textContent).toContain('Create workspace session')
    fireEvent.click(screen.getByTestId('new-session-simple-chat'))
    expect(onCreateSimpleChat).toHaveBeenCalledTimes(1)
  })

  it('requests directories, expands finder columns, and creates with selected cwd', async () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
        expect.any(Function),
      )
    })

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [{ name: 'project', path: '/tmp/root/project' }],
      })
    })

    fireEvent.click(await screen.findByText('project'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
      expect.any(Function),
    )

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project',
        roots: ['/tmp/root'],
        entries: [{ name: 'src', path: '/tmp/root/project/src' }],
      })
    })

    expect(screen.getAllByTestId('finder-column')).toHaveLength(2)
    expect(screen.getByDisplayValue('/tmp/root/project')).toBeTruthy()

    fireEvent.click(screen.getByTestId('new-session-create'))
    expect(onCreate).toHaveBeenCalledWith({
      agentRuntime: 'kernel',
      executionMode: 'chat',
      workspaceId: 'ws-a',
      workspaceName: 'mbp',
      cwd: '/tmp/root/project',
    })
  })

  it('uses distinct icons and navigation behavior for folders and files', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => expect(harness.lastDirRequest()).toBeTruthy())
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [
          { name: 'project', path: '/tmp/root/project', type: 'directory' },
          { name: 'README.md', path: '/tmp/root/README.md', type: 'file', size: 42 },
        ],
      })
    })

    expect(screen.getAllByTestId('finder-folder-icon')).toHaveLength(1)
    expect(screen.getAllByTestId('finder-file-icon')).toHaveLength(1)

    const callsBeforeFileClick = harness.socket.emit.mock.calls.length
    fireEvent.click(screen.getByText('README.md'))
    expect(harness.socket.emit).toHaveBeenCalledTimes(callsBeforeFileClick)

    fireEvent.click(screen.getByText('project'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
      expect.any(Function),
    )
  })

  it('allows manual cwd entry', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    fireEvent.change(screen.getByTestId('new-session-cwd-input'), {
      target: { value: '/tmp/root/manual' },
    })

    fireEvent.click(screen.getByTestId('new-session-create'))

    expect(onCreate).toHaveBeenCalledWith({
      agentRuntime: 'kernel',
      executionMode: 'chat',
      workspaceId: 'ws-a',
      workspaceName: 'mbp',
      cwd: '/tmp/root/manual',
    })
  })

  it('shows readable runtime choices and creates with the selected runtime', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        agentRuntimes={[
          {
            id: 'kernel',
            label: 'Kala',
            description: 'RunLab kernel',
            available: true,
            status: 'ready',
            capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
          },
          {
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'Official Copilot SDK',
            available: true,
            status: 'ready',
            capabilities: { ...KERNEL_AGENT_RUNTIME_CAPABILITIES, queue: false },
          },
        ]}
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    const copilot = screen.getByTestId('new-session-runtime-copilot')
    expect(copilot.getAttribute('role')).toBe('radio')
    expect(copilot.className).toContain('min-h-11')
    expect(copilot.querySelector('span')?.textContent).toBe('GitHub Copilot')
    expect(copilot.className).not.toContain('truncate')
    expect(screen.getByText('Kala Kernel')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.queryByText(/Requires your own LLM endpoint/u)).toBeNull()
    expect(screen.queryByText(/Uses your Copilot subscription/u)).toBeNull()
    expect(copilot.getAttribute('title')).toMatch(/Uses your Copilot subscription/u)
    expect(screen.getAllByLabelText('Choose agent runtime').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(copilot)
    expect(copilot.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('ak-agent-runtime')).toBe('copilot')

    fireEvent.click(screen.getByTestId('new-session-create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      agentRuntime: 'copilot',
    }))
  })

  it('creates a DAG-First Session when that execution mode is selected', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('DAG-First'))
    fireEvent.click(screen.getByTestId('new-session-create'))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      agentRuntime: 'kernel',
      executionMode: 'dag',
    }))
  })

  it('defaults to the last available runtime selected by the user', () => {
    localStorage.setItem('ak-agent-runtime', 'copilot')
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        agentRuntimes={[
          {
            id: 'kernel',
            label: 'Kala',
            description: 'RunLab kernel',
            available: true,
            status: 'ready',
            capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
          },
          {
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'Official Copilot SDK',
            available: true,
            status: 'ready',
            capabilities: { ...KERNEL_AGENT_RUNTIME_CAPABILITIES, queue: false },
          },
        ]}
        socket={makeSocket().socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByTestId('new-session-runtime-copilot').getAttribute('aria-checked')).toBe('true')
  })

  it('shows create errors and blocks duplicate submit while creating', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        error="cwd is not a readable directory"
        submitting
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByTestId('new-session-error').textContent).toContain(
      'cwd is not a readable directory',
    )
    const button = screen.getByTestId('new-session-create') as HTMLButtonElement
    const cancel = screen.getByTestId('workspace-picker-cancel') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    expect(button.textContent).toContain('Creating')
    fireEvent.click(button)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('preselects the requested workspace', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-b"
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-b', path: '/work/project' }),
        expect.any(Function),
      )
    })
    expect(screen.getByDisplayValue('/work/project')).toBeTruthy()
    expect(screen.queryByTestId('new-session-workspace-list')).toBeNull()
    expect(screen.getByTestId('new-session-scoped-workspace').textContent).toContain('linux-box')
  })

  it('creates workspace-free chat with the chosen runtime from the global dialog', () => {
    const onCreate = vi.fn()
    const onCreateSimpleChat = vi.fn()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        agentRuntimes={['kernel', 'copilot'].map((id) => ({
          id: id as 'kernel' | 'copilot',
          label: id,
          description: id,
          available: true,
          status: 'ready' as const,
          capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
        }))}
        socket={makeSocket().socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={onCreateSimpleChat}
        onCancel={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('new-session-runtime-copilot'))
    fireEvent.click(screen.getByTestId('new-session-simple-chat'))
    expect(onCreateSimpleChat).toHaveBeenCalledTimes(1)
    expect(onCreateSimpleChat).toHaveBeenCalledWith('copilot')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not offer workspace-free chat from a workspace-scoped dialog', () => {
    render(
      <NewSessionDialog open workspaces={[wsA, wsB]} initialWorkspaceId="ws-b"
        socket={makeSocket().socket as never} onCreate={() => {}}
        onCreateSimpleChat={() => {}} onCancel={() => {}} />,
    )
    expect(screen.queryByTestId('new-session-simple-chat')).toBeNull()
    expect(screen.queryByTestId('new-session-simple-chat-mobile')).toBeNull()
  })

  it('blocks duplicate simple chat creation while submitting', () => {
    const onCreateSimpleChat = vi.fn()
    render(
      <NewSessionDialog open workspaces={[wsA, wsB]}
        socket={makeSocket().socket as never} submitting onCreate={() => {}}
        onCreateSimpleChat={onCreateSimpleChat} onCancel={() => {}} />,
    )
    fireEvent.click(screen.getByTestId('new-session-simple-chat'))
    fireEvent.click(screen.getByTestId('new-session-simple-chat-mobile'))
    expect(onCreateSimpleChat).not.toHaveBeenCalled()
  })

  it('accepts a request-level directory acknowledgement without a broadcast event', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => expect(harness.lastDirRequest()).toBeTruthy())
    const request = harness.lastDirRequest()
    act(() => harness.ackDirList({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      path: '/tmp/root',
      roots: ['/tmp/root'],
      entries: [{ name: 'project', path: '/tmp/root/project', type: 'directory' }],
    }))

    expect(await screen.findByText('project')).toBeTruthy()
  })

  it('keeps a requested workspace missing instead of silently switching targets', () => {
    const onCreate = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        initialWorkspaceId="ws-deleted"
        socket={harness.socket as never}
        onCreate={onCreate}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByTestId('new-session-missing-workspace').textContent).toContain(
      'Selected workspace is offline',
    )
    expect(harness.socket.emit).not.toHaveBeenCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a' }),
    )
    const button = screen.getByTestId('new-session-create') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not reset a manual workspace choice when the initial missing workspace stays missing', () => {
    const harness = makeSocket()
    const { rerender } = render(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-deleted"
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-pick-ws-b'))
    expect(screen.getByDisplayValue('/work/project')).toBeTruthy()

    rerender(
      <NewSessionDialog
        open
        workspaces={[wsA, wsB]}
        initialWorkspaceId="ws-deleted"
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(screen.queryByTestId('new-session-missing-workspace')).toBeNull()
    expect(screen.getByDisplayValue('/work/project')).toBeTruthy()
  })

  it('ignores stale directory responses after a newer request is sent', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
        expect.any(Function),
      )
    })
    const initialRequest = harness.lastDirRequest()

    fireEvent.change(screen.getByTestId('new-session-cwd-input'), {
      target: { value: '/tmp/root/manual' },
    })
    act(() => {
      harness.emitDirList({
        requestId: 'stale-request',
        workspaceId: 'ws-a',
        path: '/tmp/root/stale',
        roots: ['/tmp/root'],
        entries: [],
      })
    })
    expect(screen.getByDisplayValue('/tmp/root/manual')).toBeTruthy()

    act(() => {
      harness.emitDirList({
        requestId: initialRequest.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [],
      })
    })
    expect(screen.getByDisplayValue('/tmp/root/manual')).toBeTruthy()
  })

  it('navigates one level up with the parent button', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
        expect.any(Function),
      )
    })

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [{ name: 'project', path: '/tmp/root/project' }],
      })
    })

    fireEvent.click(screen.getByText('project'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project',
        roots: ['/tmp/root'],
        entries: [{ name: 'src', path: '/tmp/root/project/src' }],
      })
    })

    fireEvent.click(screen.getByText('src'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project/src',
        roots: ['/tmp/root'],
        entries: [],
      })
    })

    expect(screen.getByDisplayValue('/tmp/root/project/src')).toBeTruthy()

    fireEvent.click(screen.getByTestId('dir-picker-up'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
      expect.any(Function),
    )
    expect(screen.getByDisplayValue('/tmp/root/project')).toBeTruthy()

    fireEvent.click(screen.getByTestId('dir-picker-up'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
      expect.any(Function),
    )
    // At the workspace root the up button should be disabled.
    expect((screen.getByTestId('dir-picker-up') as HTMLButtonElement).disabled).toBe(true)
  })

  it('debounces manual path edits and reloads the finder', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeSocket()
      render(
        <NewSessionDialog
          open
          workspaces={[wsA]}
          socket={harness.socket as never}
          onCreate={() => {}}
          onCreateSimpleChat={() => {}}
        onCancel={() => {}}
        />,
      )

      // Initial mount fires one list_dirs. Skip past it.
      act(() => {
        vi.advanceTimersByTime(0)
      })
      const initialCalls = harness.socket.emit.mock.calls.filter(
        ([event]: [string]) => event === 'client:list_dirs',
      ).length

      fireEvent.change(screen.getByTestId('new-session-cwd-input'), {
        target: { value: '/tmp/root/typed' },
      })
      // Before the debounce fires, no new request should have been sent.
      const midCalls = harness.socket.emit.mock.calls.filter(
        ([event]: [string]) => event === 'client:list_dirs',
      ).length
      expect(midCalls).toBe(initialCalls)

      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(harness.socket.emit).toHaveBeenLastCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/typed' }),
        expect.any(Function),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('jumps to a breadcrumb segment when clicked', async () => {
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={() => {}}
        onCancel={() => {}}
      />,
    )

    await waitFor(() => {
      expect(harness.socket.emit).toHaveBeenCalledWith(
        'client:list_dirs',
        expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root' }),
        expect.any(Function),
      )
    })

    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root',
        roots: ['/tmp/root'],
        entries: [{ name: 'project', path: '/tmp/root/project' }],
      })
    })

    fireEvent.click(screen.getByText('project'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project',
        roots: ['/tmp/root'],
        entries: [{ name: 'src', path: '/tmp/root/project/src' }],
      })
    })

    fireEvent.click(screen.getByText('src'))
    act(() => {
      const request = harness.lastDirRequest()
      harness.emitDirList({
        requestId: request.requestId,
        workspaceId: 'ws-a',
        path: '/tmp/root/project/src',
        roots: ['/tmp/root'],
        entries: [],
      })
    })

    // Breadcrumbs collapse everything above workspace root into a single
    // "root" chip: [root, project, src]. Clicking "project" jumps up one.
    fireEvent.click(screen.getByTestId('dir-picker-breadcrumb-1'))
    expect(harness.socket.emit).toHaveBeenLastCalledWith(
      'client:list_dirs',
      expect.objectContaining({ workspaceId: 'ws-a', path: '/tmp/root/project' }),
      expect.any(Function),
    )
  })

  it('invokes onCreateSimpleChat when the simple chat tile is clicked', () => {
    const onCreateSimpleChat = vi.fn()
    const harness = makeSocket()
    render(
      <NewSessionDialog
        open
        workspaces={[wsA]}
        socket={harness.socket as never}
        onCreate={() => {}}
        onCreateSimpleChat={onCreateSimpleChat}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('new-session-simple-chat'))
    expect(onCreateSimpleChat).toHaveBeenCalledTimes(1)
  })
})
