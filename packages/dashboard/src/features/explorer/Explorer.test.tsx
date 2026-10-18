import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'
import { createConfig, createInitialState } from '@agent-kernel/kernel'

vi.mock('react-use-measure', () => ({
  default: () => [() => {}, { width: 240, height: 400 }, () => {}],
}))

import { Explorer } from './Explorer.js'
import { canDropWorkspacesAtRoot, reorderWorkspaceIds } from './tree-model.js'
import { createSessionViewCache } from '../../session-view-cache.js'
import { HIDDEN_WORKSPACES_STORAGE_KEY } from './hidden-workspaces.js'
import { PREF_AUTO_HIDE_OFFLINE_WORKSPACES, PREF_HIDDEN_SESSIONS, PREF_HIDE_SUB_AGENT_SESSIONS, PREF_WORKSPACE_ORDER } from '../../lib/prefs.js'
import type { CachedSessionView } from '../../session-view-cache.js'
import { SessionPreviewStore } from './session-preview-store.js'
import { i18n } from '../../i18n/index.js'

const executor: AttachedExecutor = {
  executorId: 'ex-1',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  tools: [],
  runtime: 'node',
  runtimeVersion: 'v22',
  os: 'darwin',
  ipAddresses: ['192.0.2.10'],
  attachedAt: '2026-07-05T10:00:00.000Z',
}

const sessionSummary: SessionSummary = {
  sessionId: '01JXXXXXXXXXXXXXXXXXXXXX',
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  createdAt: new Date(Date.now() - 30_000).toISOString(),
  lastEventAt: new Date(Date.now() - 30_000).toISOString(),
  eventCount: 4,
  firstUserMessage: 'please write hello.txt',
  status: 'done',
  currentCwd: '/tmp',
}

describe('Explorer', () => {
  it('starts an unscoped draft from the top-left New chat button', () => {
    const onNewSession = vi.fn()
    render(<Explorer executors={[executor]} sessions={[sessionSummary]} selectedSessionId={sessionSummary.sessionId}
      onSelect={() => {}} onNewSession={onNewSession} onConnectWorkspace={() => {}} onDelete={() => {}} onRename={() => {}} />)
    fireEvent.click(screen.getByTestId('explorer-new-chat'))
    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(onNewSession).toHaveBeenCalledWith()
  })

  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(hover: hover) and (pointer: fine)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it('uses a compositor-only loader without SVG spin or full-row sweep', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        loading
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const loading = screen.getByTestId('explorer-loading')
    const spinner = loading.querySelector('.ak-loading-spinner')
    expect(spinner).not.toBeNull()
    expect(loading.querySelector('svg.animate-spin')).toBeNull()
    expect(loading.querySelectorAll('.ak-explorer-loading-row')).toHaveLength(5)
  })

  it('shows empty state when there are no daemons and no sessions', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    expect(screen.getByText('Your conversations will appear here.')).toBeTruthy()
  })

  it('hides offline workspaces by default and reveals them when the preference is disabled', () => {
    const offline = { ...sessionSummary, workspaceId: 'ws-offline', workspaceName: 'offline box' }
    const props = {
      executors: [],
      sessions: [offline],
      selectedSessionId: null,
      onSelect: () => {},
      onNewSession: () => {},
      onConnectWorkspace: () => {},
      onDelete: () => {},
      onRename: () => {},
    }
    const { rerender } = render(<Explorer {...props} />)
    expect(screen.queryByTestId('workspace-row')).toBeNull()

    localStorage.setItem(PREF_AUTO_HIDE_OFFLINE_WORKSPACES, '0')
    fireEvent(window, new StorageEvent('storage', { key: PREF_AUTO_HIDE_OFFLINE_WORKSPACES, newValue: '0' }))
    rerender(<Explorer {...props} />)
    expect(screen.getByTestId('workspace-row').textContent).toContain('offline box')
    const status = screen.getByTestId('workspace-status-icon')
    expect(status.getAttribute('data-os')).toBe('unknown')
    expect(status.getAttribute('aria-label')).toBe('Unknown OS, offline')
    expect(status.getAttribute('title')).toBe('Unknown OS, offline')
    expect(screen.getByTestId('workspace-os-icon').classList.contains('lucide-monitor')).toBe(true)
  })

  it('shows old offline workspace sessions by default in Private Cloud, but respects an explicit hide setting', () => {
    const props = {
      executors: [{ ...executor, workspaceId: 'tenant_current-workspace', workspaceName: 'Workspace' }],
      sessions: [{ ...sessionSummary, workspaceId: 'previous-executor', workspaceName: 'old workspace' }],
      selectedSessionId: null,
      autoHideOfflineWorkspacesByDefault: false,
      onSelect: () => {}, onNewSession: () => {}, onConnectWorkspace: () => {}, onDelete: () => {}, onRename: () => {},
    }
    const { rerender } = render(<Explorer {...props} />)
    expect(screen.getAllByTestId('workspace-row')).toHaveLength(2)
    expect(screen.getByTestId('session-row').textContent).toContain(sessionSummary.firstUserMessage?.slice(0, 20))

    localStorage.setItem(PREF_AUTO_HIDE_OFFLINE_WORKSPACES, '1')
    fireEvent(window, new StorageEvent('storage', { key: PREF_AUTO_HIDE_OFFLINE_WORKSPACES, newValue: '1' }))
    rerender(<Explorer {...props} />)
    expect(screen.getAllByTestId('workspace-row')).toHaveLength(1)
    expect(screen.queryByTestId('session-row')).toBeNull()
  })

  it('hides sub-agent sessions by default while keeping the selected child reachable', () => {
    const child = { ...sessionSummary, sessionId: 'child-session', parentSessionId: sessionSummary.sessionId, firstUserMessage: 'child task' }
    const props = {
      executors: [executor],
      sessions: [sessionSummary, child],
      onSelect: () => {},
      onNewSession: () => {},
      onConnectWorkspace: () => {},
      onDelete: () => {},
      onRename: () => {},
    }
    const { rerender } = render(<Explorer {...props} selectedSessionId={null} />)
    expect(screen.getAllByTestId('session-row')).toHaveLength(1)
    expect(screen.queryByText('child task')).toBeNull()

    rerender(<Explorer {...props} selectedSessionId="child-session" />)
    expect(screen.getAllByTestId('session-row').some((row) => row.getAttribute('data-session-id') === 'child-session')).toBe(true)

    localStorage.setItem(PREF_HIDE_SUB_AGENT_SESSIONS, '0')
    fireEvent(window, new StorageEvent('storage', { key: PREF_HIDE_SUB_AGENT_SESSIONS, newValue: '0' }))
    rerender(<Explorer {...props} selectedSessionId={null} />)
    expect(screen.getAllByTestId('session-row')).toHaveLength(2)
  })

  it('opens workspace connection help from the header button', () => {
    const onConnectWorkspace = vi.fn()
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={onConnectWorkspace}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('connect-workspace-button'))
    expect(onConnectWorkspace).toHaveBeenCalled()
  })

  it('collapses from the explorer header when provided', () => {
    const onCollapse = vi.fn()
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onCollapse={onCollapse}
      />,
    )
    fireEvent.click(screen.getByTestId('explorer-collapse-button'))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('switches the default action row to a full-width focused search box', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onCollapse={() => {}}
      />,
    )

    const actions = screen.getByTestId('explorer-header-actions')
    expect(within(actions).getByTestId('explorer-new-chat').className).toContain('flex-1')
    expect(within(actions).getByTestId('explorer-search-button')).toBeTruthy()
    expect(within(actions).getByTestId('connect-workspace-button')).toBeTruthy()
    expect(within(actions).getByTestId('explorer-collapse-button')).toBeTruthy()
    expect(screen.queryByTestId('explorer-search')).toBeNull()

    fireEvent.click(screen.getByTestId('explorer-search-button'))

    const input = screen.getByTestId('explorer-search')
    expect(input).toBe(document.activeElement)
    expect(input.parentElement?.className).toContain('w-full')
    expect(screen.queryByTestId('explorer-header-actions')).toBeNull()
    expect(screen.queryByTestId('explorer-new-chat')).toBeNull()
    expect(screen.queryByTestId('connect-workspace-button')).toBeNull()
    expect(screen.queryByTestId('explorer-collapse-button')).toBeNull()
  })

  it('keeps the product selector and New Chat inside one non-wrapping primary control', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        embeddedHeader
        headerLeading={<button type="button" data-testid="test-product-selector">Products</button>}
      />,
    )

    const actions = screen.getByTestId('explorer-header-actions')
    const group = screen.getByTestId('explorer-primary-action-group')
    expect(group.parentElement).toBe(actions)
    expect(group.className).toContain('flex-nowrap')
    expect(within(group).getByTestId('test-product-selector')).toBeTruthy()
    expect(within(group).getByTestId('explorer-new-chat')).toBeTruthy()
  })

  it('clears and closes search with Escape or the close button', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('explorer-search-button'))
    fireEvent.change(screen.getByTestId('explorer-search'), { target: { value: 'missing' } })
    fireEvent.keyDown(screen.getByTestId('explorer-search'), { key: 'Escape' })
    expect(screen.queryByTestId('explorer-search')).toBeNull()
    expect(screen.getByTestId('explorer-header-actions')).toBeTruthy()
    expect(screen.queryByTestId('explorer-filter-empty')).toBeNull()

    fireEvent.click(screen.getByTestId('explorer-search-button'))
    fireEvent.change(screen.getByTestId('explorer-search'), { target: { value: 'missing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear explorer search' }))
    expect(screen.queryByTestId('explorer-search')).toBeNull()
    expect(screen.getByTestId('explorer-header-actions')).toBeTruthy()
    expect(screen.queryByTestId('explorer-filter-empty')).toBeNull()
  })

  it('uses the same non-overflowing compact action layout in an embedded mobile header', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onCollapse={() => {}}
        embeddedHeader
      />,
    )

    const actions = screen.getByTestId('explorer-header-actions')
    expect(actions.className).toContain('min-w-0')
    expect(actions.className).toContain('w-full')
    expect(screen.getByTestId('explorer-new-chat').className).toContain('min-w-0')
    for (const testId of ['explorer-search-button', 'connect-workspace-button', 'explorer-collapse-button']) {
      const button = screen.getByTestId(testId)
      expect(button.parentElement).toBe(actions)
      expect(button.className).toContain('h-9')
      expect(button.className).toContain('w-9')
      expect(button.className).toContain('flex-none')
    }

    fireEvent.click(screen.getByTestId('explorer-search-button'))
    const search = screen.getByTestId('explorer-search')
    expect(search.parentElement?.className).toContain('w-full')
    expect(search.parentElement?.className).toContain('min-w-0')
    expect(screen.queryByTestId('connect-workspace-button')).toBeNull()
  })

  it('starts a new session from a workspace row', () => {
    const onNewSession = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={onNewSession}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('workspace-new-session-ws-1'))
    expect(onNewSession).toHaveBeenCalledWith('ws-1')
  })

  it('opens a temporary terminal from the workspace hover actions', () => {
    const onOpenWorkspaceTerminal = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenWorkspaceTerminal={onOpenWorkspaceTerminal}
      />,
    )
    const button = screen.getByTestId('workspace-terminal-ws-1')
    expect(button.getAttribute('title')).toBe('Open workspace terminal')
    expect(button.parentElement?.className).toContain('ak-touch-reveal')
    expect(button.parentElement?.className).toContain('group-focus-within/ws:opacity-100')
    fireEvent.click(button)
    expect(onOpenWorkspaceTerminal).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', online: true }))
  })

  it('renders a workspace row for an attached executor', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const wsRow = screen.getByTestId('workspace-row')
    expect(wsRow.getAttribute('data-workspace-id')).toBe('ws-1')
    expect(wsRow.getAttribute('data-online')).toBe('true')
    expect(wsRow.className).toContain('grid-cols-[1.25rem_minmax(0,1fr)]')
    expect(wsRow.querySelector('[data-row-action]')?.className).toContain('absolute')
    expect(wsRow.className).toContain('relative')
    expect(wsRow.textContent).toContain('my-mbp')
    expect(screen.getByTestId('workspace-drag-handle')).toBeTruthy()
    expect(screen.getByTestId('workspace-drag-handle').className).toContain('absolute')
    expect(screen.getByTestId('workspace-drag-handle').className).toContain('w-1.5')
    expect(screen.getByTestId('workspace-drag-handle').querySelector('svg')?.className.baseVal).toContain('opacity-0')
    expect(screen.getByTestId('workspace-drag-handle').querySelector('svg')?.className.baseVal).toContain('group-hover/drag:opacity-100')
    expect(screen.queryByTestId('workspace-status-pill')).toBeNull()
    expect(screen.queryByTestId('workspace-status-indicator')).toBeNull()
    expect(screen.queryByTestId('workspace-status-ring')).toBeNull()
    const workspaceStatus = screen.getByTestId('workspace-status-icon')
    expect(workspaceStatus.className).not.toContain('rounded-full')
    expect(workspaceStatus.className).not.toContain('border')
    expect(workspaceStatus.className).toContain('text-emerald-600')
    expect(workspaceStatus.querySelector('img[src="/icons/macos.svg"]')).toBeTruthy()
    expect(workspaceStatus.getAttribute('aria-label')).toBe('macOS, online')
    expect(workspaceStatus.getAttribute('title')).toBe('macOS, online')
    expect(workspaceStatus.textContent).toBe('')
    expect(screen.queryByTestId('workspace-row-meta')).toBeNull()
    expect(wsRow.textContent).not.toContain('node')
    expect(wsRow.textContent).not.toContain('v22')
    expect(wsRow.textContent).not.toContain('192.0.2.10')
  })

  it.each([
    { label: 'Windows', os: 'win32', selectorOs: 'win32', icon: 'windows', accessibleName: 'Windows, online' },
    { label: 'macOS', os: 'darwin', selectorOs: 'darwin', icon: 'macos', accessibleName: 'macOS, online' },
    { label: 'Linux', os: 'linux', selectorOs: 'linux', icon: 'linux', accessibleName: 'Linux, online' },
    { label: 'other OS', os: 'other', selectorOs: 'other', icon: 'generic', accessibleName: 'Other OS, online' },
    { label: 'an undefined OS', os: undefined, selectorOs: 'unknown', icon: 'generic', accessibleName: 'Unknown OS, online' },
  ] as const)('renders the $label workspace icon with stable OS selectors and an accessible label', ({ os, selectorOs, icon, accessibleName }) => {
    render(
      <Explorer
        executors={[{ ...executor, os }]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const status = screen.getByTestId('workspace-status-icon')
    const osIcon = screen.getByTestId('workspace-os-icon')
    expect(status.getAttribute('data-os')).toBe(selectorOs)
    expect(status.getAttribute('title')).toBe(accessibleName)
    expect(status.getAttribute('aria-label')).toBe(accessibleName)
    expect(status.textContent).toBe('')
    expect(status.className).toContain('text-emerald-600')
    expect(osIcon.getAttribute('data-os-icon')).toBe(icon)
    expect(osIcon.classList.contains('lucide-monitor')).toBe(icon === 'generic')
    if (icon !== 'generic') {
      expect(osIcon.tagName.toLowerCase()).toBe('img')
      expect(osIcon.getAttribute('src')).toBe(`/icons/${icon}.svg`)
      expect(osIcon.getAttribute('alt')).toBe('')
    }
  })

  it('localizes the workspace OS and connection status accessible label', async () => {
    await act(async () => { await i18n.changeLanguage('zh') })
    try {
      render(
        <Explorer
          executors={[{ ...executor, os: 'linux' }]}
          sessions={[]}
          selectedSessionId={null}
          onSelect={() => {}}
          onNewSession={() => {}}
          onConnectWorkspace={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
        />,
      )
      expect(screen.getByTestId('workspace-status-icon').getAttribute('aria-label')).toBe('Linux，在线')
    } finally {
      cleanup()
      await act(async () => { await i18n.changeLanguage('en') })
    }
  })

  it('persists workspace ordering preference from local storage', () => {
    const secondExecutor: AttachedExecutor = {
      ...executor,
      executorId: 'ex-2',
      workspaceId: 'ws-2',
      workspaceName: 'z-workspace',
    }
    localStorage.setItem('agent-kernel:explorer:workspace-order:v1', JSON.stringify(['ws-2', 'ws-1']))

    render(
      <Explorer
        executors={[executor, secondExecutor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getAllByTestId('workspace-row').map((row) => row.getAttribute('data-workspace-id'))).toEqual(['ws-2', 'ws-1'])
  })

  it('hides a workspace and its sessions from the explorer tree', () => {
    const secondExecutor: AttachedExecutor = {
      ...executor,
      executorId: 'ex-2',
      workspaceId: 'ws-2',
      workspaceName: 'second-box',
    }
    const secondSession: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      workspaceId: 'ws-2',
      workspaceName: 'second-box',
      firstUserMessage: 'second session',
    }

    render(
      <Explorer
        executors={[executor, secondExecutor]}
        sessions={[sessionSummary, secondSession]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-hide-ws-1'))

    expect(screen.getAllByTestId('workspace-row').map((row) => row.getAttribute('data-workspace-id'))).toEqual(['ws-2'])
    expect(screen.queryByText('please write hello.txt')).toBeNull()
    expect(screen.getByText('second session')).toBeTruthy()
    expect(screen.getByTestId('hidden-items-bar').textContent).toContain('1 hidden item')
    expect(localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)).toContain('ws-1')
  })

  it('restores a hidden workspace from the hidden workspaces list', () => {
    localStorage.setItem(HIDDEN_WORKSPACES_STORAGE_KEY, JSON.stringify({ version: 1, ids: ['ws-1'] }))

    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.queryByTestId('workspace-row')).toBeNull()
    expect(screen.getByTestId('explorer-hidden-empty').textContent).toContain('All workspaces are hidden')

    fireEvent.click(screen.getByTestId('hidden-items-toggle'))
    expect(screen.getByTestId('hidden-workspaces-group').textContent).toContain('my-mbp')
    expect(screen.getByTestId('workspace-unhide-icon')).toBeTruthy()
    expect(screen.getByTestId('hidden-items-toggle').className).toContain('min-h-11')
    expect(screen.getByTestId('workspace-unhide-ws-1').textContent).toContain('Show workspace')
    expect(screen.getByTestId('workspace-unhide-ws-1').className).toContain('min-h-11')
    expect(screen.getByTestId('hidden-workspace-label').className).toContain('truncate')
    expect(screen.getByTestId('hidden-workspace-label').className).toContain('max-w-[14rem]')
    fireEvent.click(screen.getByTestId('workspace-unhide-ws-1'))

    expect(screen.getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe('ws-1')
    expect(screen.getByTestId('session-row').textContent).toContain('please write hello.txt')
    expect(localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)).toBeNull()
  })

  it('keeps the same ambient label DOM node when a running session changes phase', () => {
    const runningSummary = { ...sessionSummary, status: 'thinking' as const }
    // Stable callbacks so areExplorerPropsEqual isn't tripped by callback
    // identity (in the real app these are useCallback-stable); this isolates
    // the status flip as the only changing input.
    const noop = () => {}
    const props = {
      executors: [executor],
      selectedSessionId: runningSummary.sessionId,
      onSelect: noop,
      onNewSession: noop,
      onConnectWorkspace: noop,
      onDelete: noop,
      onRename: noop,
    }
    const { rerender } = render(<Explorer {...props} sessions={[runningSummary]} />)
    const before = screen.getByTestId('running-session-label')

    rerender(<Explorer {...props} sessions={[{ ...runningSummary, status: 'executing_tools' as const }]} />)
    const after = screen.getByTestId('running-session-label')
    expect(after).toBe(before)
    expect(after.className).toContain('ak-thinking-text')
    expect(after.className).toContain('font-semibold')
    expect(after.className).toContain('ak-session-running-label')
    expect(screen.queryByTestId('session-status-spinner')).toBeNull()
  })

  it('uses restrained medium typography for the selected non-running session', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const label = screen.getByTestId('session-row').querySelector('.ak-session-label')
    expect(label?.classList.contains('font-medium')).toBe(true)
    expect(label?.classList.contains('font-semibold')).toBe(false)
    expect(label?.classList.contains('font-extrabold')).toBe(false)
    expect(label?.classList.contains('ak-thinking-text')).toBe(false)
    expect(label?.classList.contains('ak-session-running-label')).toBe(false)
  })

  it('keeps each running session row ambient without rendering spinners', () => {
    const second = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'second task',
    }
    const noop = () => {}
    const props = {
      executors: [executor],
      sessions: [sessionSummary, second],
      selectedSessionId: sessionSummary.sessionId,
      onSelect: noop,
      onNewSession: noop,
      onConnectWorkspace: noop,
      onDelete: noop,
      onRename: noop,
    }
    render(
      <Explorer
        {...props}
        sessionStatuses={new Map([
          [sessionSummary.sessionId, 'thinking'],
          [second.sessionId, 'loading'],
        ])}
      />,
    )
    expect(screen.getAllByTestId('running-session-label')).toHaveLength(2)
    expect(screen.queryByTestId('session-status-spinner')).toBeNull()
  })

  it('does not offer hide for the unassigned workspace bucket', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[{ ...sessionSummary, workspaceId: undefined, workspaceName: undefined }]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe('unassigned')
    expect(screen.queryByTestId('workspace-hide-null')).toBeNull()
    expect(screen.queryByTestId('hidden-items-bar')).toBeNull()
  })

  it('uses one Hidden disclosure for sessions only and restores the session', () => {
    localStorage.setItem(PREF_HIDDEN_SESSIONS, JSON.stringify({ version: 1, ids: [sessionSummary.sessionId] }))
    render(<Explorer executors={[executor]} sessions={[sessionSummary]} selectedSessionId={null} onSelect={() => {}} onNewSession={() => {}} onConnectWorkspace={() => {}} onDelete={() => {}} onRename={() => {}} />)
    expect(screen.queryByTestId('session-row')).toBeNull()
    fireEvent.click(screen.getByTestId('hidden-items-toggle'))
    expect(screen.queryByTestId('hidden-workspaces-group')).toBeNull()
    expect(screen.getByTestId('hidden-sessions-group').textContent).toContain('please write hello.txt')
    expect(screen.getByTestId('session-unhide-icon')).toBeTruthy()
    expect(screen.getByTestId(`session-unhide-${sessionSummary.sessionId}`).textContent).toContain('Show session')
    expect(screen.getByTestId(`session-unhide-${sessionSummary.sessionId}`).className).toContain('min-h-11')
    expect(screen.getByTestId('hidden-session-label').className).toContain('truncate')
    fireEvent.click(screen.getByTestId(`session-unhide-${sessionSummary.sessionId}`))
    expect(screen.getByTestId('session-row')).toBeTruthy()
  })

  it('groups hidden workspaces and sessions under the same disclosure', () => {
    localStorage.setItem(HIDDEN_WORKSPACES_STORAGE_KEY, JSON.stringify({ version: 1, ids: ['ws-1'] }))
    localStorage.setItem(PREF_HIDDEN_SESSIONS, JSON.stringify({ version: 1, ids: [sessionSummary.sessionId] }))
    render(<Explorer executors={[executor]} sessions={[sessionSummary]} selectedSessionId={null} onSelect={() => {}} onNewSession={() => {}} onConnectWorkspace={() => {}} onDelete={() => {}} onRename={() => {}} />)
    expect(screen.getAllByTestId('hidden-items-bar')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('hidden-items-toggle'))
    expect(screen.getByTestId('hidden-workspaces-group')).toBeTruthy()
    expect(screen.getByTestId('hidden-sessions-group')).toBeTruthy()
  })

  it('allows workspace drops on the react-arborist root node', () => {
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: '__REACT_ARBORIST_INTERNAL_ROOT__', isRoot: true },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: 'ws-1' } }],
    })).toBe(true)
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: 'ws:ws-2', isRoot: false },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: 'ws-1' } }],
    })).toBe(false)
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: '__REACT_ARBORIST_INTERNAL_ROOT__', isRoot: true },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: null } }],
    })).toBe(false)
  })

  it('reorders workspace ids for root-level workspace drags', () => {
    expect(reorderWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], ['ws-1', 'ws-2', 'ws-3'], ['ws-3'], 0)).toEqual(['ws-3', 'ws-1', 'ws-2'])
    expect(reorderWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], ['ws-1', 'ws-2', 'ws-3'], ['ws-1'], 3)).toEqual(['ws-2', 'ws-3', 'ws-1'])
  })

  it('does not render a workspace drag handle for unassigned sessions', () => {
    render(
      <Explorer
        executors={[]}
        sessions={[{ ...sessionSummary, workspaceId: undefined, workspaceName: undefined }]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe('unassigned')
    expect(screen.queryByTestId('workspace-drag-handle')).toBeNull()
  })

  it('renames a workspace from the workspace row action', () => {
    const onRenameWorkspace = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onRenameWorkspace={onRenameWorkspace}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-rename-ws-1'))
    const input = screen.getByTestId('workspace-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed workspace' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameWorkspace).toHaveBeenCalledWith('ws-1', 'renamed workspace')
  })

  it('renders session rows grouped under their workspace', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const sessionRow = screen.getByTestId('session-row')
    expect(sessionRow.getAttribute('data-session-id')).toBe(
      sessionSummary.sessionId,
    )
    expect(sessionRow.className).toContain('ak-session-row')
    expect(sessionRow.className).toContain('items-center')
    expect(sessionRow.className).not.toContain('ml-4')
    expect(sessionRow.className).toContain('pl-2.5')
    expect(sessionRow.className).toContain('py-1')
    expect(sessionRow.querySelector('.ak-session-label')?.className).toContain('font-normal')
    expect((sessionRow.querySelector('.ak-session-title-cell') as HTMLElement).style.getPropertyValue('--ak-session-font-size')).toBe('13px')
    expect((screen.getByTestId('workspace-row').querySelector('.ak-workspace-title-cell') as HTMLElement).style.getPropertyValue('--ak-workspace-font-size')).toBe('12px')
    expect((sessionRow as HTMLElement).style.width).not.toContain('calc')
    expect(sessionRow.textContent).toContain('please write hello.txt')
    expect(sessionRow.textContent).not.toContain('done')
    expect(sessionRow.textContent).not.toContain('4 evt')
    expect(screen.queryByTestId('session-status-indicator')).toBeNull()
    expect(screen.getByTestId('session-drag-handle').querySelector('svg')?.className.baseVal).not.toContain('opacity-0')
    expect(screen.getByTestId('session-drag-handle').className).toContain('opacity-25')
    // The working directory is no longer a persistent second line — it is shown
    // on hover via the session name's title tooltip (keeps the card single-line).
    expect(sessionRow.querySelector('[title="/tmp"]')).not.toBeNull()
    expect(screen.queryByTestId('session-row-cwd')).toBeNull()
    const lastActivity = screen.getByTestId('session-last-activity')
    expect(lastActivity.parentElement?.className).toContain('ak-session-last-activity')
    expect(lastActivity.parentElement?.className).toContain('flex')
    expect(lastActivity.parentElement?.className.split(/\s+/)).not.toContain('hidden')
  })

  it('uses the phone row cadence only at phone widths', () => {
    const previousWidth = window.innerWidth
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
      render(<Explorer executors={[executor]} sessions={[sessionSummary]} selectedSessionId={null}
        onSelect={() => {}} onNewSession={() => {}} onConnectWorkspace={() => {}} onDelete={() => {}} onRename={() => {}} />)
      expect(screen.getByTestId('session-row').parentElement?.style.height).toBe('56px')
      expect(screen.getByTestId('workspace-row').parentElement?.style.height).toBe('54px')

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
      fireEvent(window, new Event('resize'))
      expect(screen.getByTestId('session-row').parentElement?.style.height).toBe('38px')
      expect(screen.getByTestId('workspace-row').parentElement?.style.height).toBe('36px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
    }
  })

  it('overrides the selected session row with the live working status', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[{ ...sessionSummary, status: 'done' }]}
        selectedSessionId={sessionSummary.sessionId}
        sessionStatuses={new Map([[sessionSummary.sessionId, 'loading']])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getByTestId('running-session-label').className).toContain('ak-thinking-text')
    expect(screen.getByText('Working').className).toContain('sr-only')
    expect(screen.queryByTestId('session-status-indicator')).toBeNull()
  })

  it('shows per-session working status independently of selection', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[{ ...sessionSummary, status: 'done' }]}
        selectedSessionId="different-session"
        sessionStatuses={new Map([[sessionSummary.sessionId, 'loading']])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    expect(screen.getByTestId('running-session-label').className).toContain('ak-thinking-text')
    expect(screen.getByText('Working').className).toContain('sr-only')
    expect(screen.queryByTestId('session-status-indicator')).toBeNull()
  })

  it('keeps ambient running labels scoped to each session row in the same workspace', () => {
    const second: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'second task',
      status: 'done',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, second]}
        selectedSessionId={sessionSummary.sessionId}
        sessionStatuses={new Map([
          [sessionSummary.sessionId, 'loading'],
          [second.sessionId, 'executing_tools'],
        ])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const rows = screen.getAllByTestId('session-row')
    const firstRow = rows.find((row) => row.getAttribute('data-session-id') === sessionSummary.sessionId)
    const secondRow = rows.find((row) => row.getAttribute('data-session-id') === second.sessionId)
    expect(firstRow?.querySelector('[data-testid="running-session-label"]')).not.toBeNull()
    expect(secondRow?.querySelector('[data-testid="running-session-label"]')).not.toBeNull()
    expect(firstRow?.querySelector('[data-testid="session-status-indicator"]')).toBeNull()
    expect(secondRow?.querySelector('[data-testid="session-status-indicator"]')).toBeNull()
  })

  it('presents sessions with no workspaceId as ordinary Chats', () => {
    const orphan: SessionSummary = {
      ...sessionSummary,
      sessionId: 'orphan-1',
      workspaceId: undefined,
      workspaceName: undefined,
      firstUserMessage: 'orphan chat',
    }
    render(
      <Explorer
        executors={[]}
        sessions={[orphan]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const wsRow = screen.getByTestId('workspace-row')
    expect(wsRow.getAttribute('data-workspace-id')).toBe('unassigned')
    expect(wsRow.textContent).toContain('Chats')
    expect(screen.getByTestId('chats-icon').classList.contains('lucide-sparkles')).toBe(true)
    expect(screen.queryByTestId('chat-session-icon')).toBeNull()
    expect(screen.queryByTestId('session-status-indicator')).toBeNull()
    expect(wsRow.textContent).toContain('personal conversations')
    expect(wsRow.textContent).not.toContain('no workspace')
    expect(screen.getByTestId('session-row').textContent).toContain(
      'orphan chat',
    )
  })

  it('pins Chats ahead of saved workspace order and preserves fork controls without idle status gaps', () => {
    localStorage.setItem(PREF_WORKSPACE_ORDER, JSON.stringify(['ws-2', 'ws-1']))
    localStorage.setItem(PREF_HIDE_SUB_AGENT_SESSIONS, 'false')
    const chat = { ...sessionSummary, sessionId: 'chat', workspaceId: undefined, workspaceName: undefined }
    render(<Explorer executors={[executor, { ...executor, executorId: 'ex-2', workspaceId: 'ws-2' }]}
      sessions={[chat, { ...chat, sessionId: 'fork', parentSessionId: 'chat' }]} selectedSessionId={null}
      onSelect={() => {}} onNewSession={() => {}} onConnectWorkspace={() => {}} onDelete={() => {}} onRename={() => {}} />)
    expect(screen.getAllByTestId('workspace-row').map((node) => node.getAttribute('data-workspace-id'))).toEqual(['unassigned', 'ws-2', 'ws-1'])
    expect(screen.getByTestId('chats-icon')).toBeTruthy()
    expect(screen.queryByTestId('chat-session-icon')).toBeNull()
    fireEvent.click(screen.getByTestId('session-children-toggle'))
    expect(screen.getByLabelText('forked session')).toBeTruthy()
    expect(screen.queryAllByTestId('session-status-indicator')).toHaveLength(0)
    const [parent, child] = screen.getAllByTestId('session-row')
    expect(parent?.children[0]?.className).toBe(child?.children[0]?.className)
    expect(parent?.children[1]?.className).toBe(child?.children[1]?.className)
  })

  it('reports the clicked sessionId to onSelect', () => {
    const onSelect = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('session-row'))
    expect(onSelect).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('commits a running-session switch on pointerdown before a click can be lost', () => {
    const onSelect = vi.fn()
    const running = { ...sessionSummary, status: 'executing_tools' as const }
    const target = { ...sessionSummary, sessionId: 'target-session', status: 'idle' as const }
    render(
      <Explorer
        executors={[executor]}
        sessions={[running, target]}
        selectedSessionId={running.sessionId}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const targetRow = screen.getAllByTestId('session-row').find((row) => row.getAttribute('data-session-id') === target.sessionId)!
    fireEvent.mouseDown(targetRow, { button: 0 })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(target.sessionId)
  })

  it('does not activate a session on mobile pointerdown before the tap target is known', () => {
    const onSelect = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const row = screen.getByTestId('session-row')
    fireEvent.pointerDown(row, { button: 0, pointerType: 'touch' })
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('does not activate a session when a pointer starts on its drag rail', () => {
    const onSelect = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const handle = screen.getByTestId('session-drag-handle')
    fireEvent.pointerDown(handle, { button: 0, pointerType: 'touch' })
    fireEvent.click(handle)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps click as a fallback when Tree activation is lost after pointerdown', () => {
    const onSelect = vi.fn()
    const target = { ...sessionSummary, sessionId: 'click-fallback-session', status: 'idle' as const }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, target]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const targetRow = screen.getAllByTestId('session-row').find((row) => row.getAttribute('data-session-id') === target.sessionId)!
    fireEvent.click(targetRow)
    expect(onSelect).toHaveBeenCalledWith(target.sessionId)
  })

  it('clears the focused session when clicking empty explorer space', () => {
    const onSelect = vi.fn()
    const onClearSelection = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={onSelect}
        onClearSelection={onClearSelection}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('explorer-column'))
    expect(onClearSelection).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('session-row'))
    expect(onSelect).toHaveBeenCalledWith(sessionSummary.sessionId)
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('opens a confirmation dialog and always requests tree deletion', () => {
    const onDelete = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
      />,
    )
    const deleteButton = screen.getByTestId('session-delete-button')
    expect(deleteButton.getAttribute('title')).toBe('Delete this session')
    fireEvent.click(deleteButton)
    expect(screen.getByText(/This cannot be undone/i)).toBeTruthy()
    fireEvent.click(screen.getByTestId('confirm-delete-button'))
    expect(onDelete).not.toHaveBeenCalled()
    const finalWarning = screen.getByText(/Confirm again to permanently delete this Session tree/i)
    expect(finalWarning.className).not.toContain('text-destructive')
    fireEvent.click(screen.getByTestId('confirm-delete-final-button'))
    expect(onDelete).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('warns about descendants and deletes the complete tree', () => {
    const onDelete = vi.fn()
    const child: SessionSummary = {
      ...sessionSummary,
      sessionId: 'child-session',
      parentSessionId: sessionSummary.sessionId,
      firstUserMessage: 'child task',
    }
    const grandchild: SessionSummary = {
      ...sessionSummary,
      sessionId: 'grandchild-session',
      parentSessionId: child.sessionId,
      firstUserMessage: 'grandchild task',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, child, grandchild]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
      />,
    )

    const parentRow = screen.getAllByTestId('session-row').find((row) => row.getAttribute('data-session-id') === sessionSummary.sessionId)
    expect(parentRow).toBeTruthy()
    fireEvent.click(parentRow!.querySelector('[data-testid="session-delete-button"]')!)
    expect(screen.getByText(/2 descendant sessions/i)).toBeTruthy()
    fireEvent.click(screen.getByTestId('confirm-delete-button'))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-delete-final-button'))
    expect(onDelete).toHaveBeenCalledWith(sessionSummary.sessionId)
  })

  it('double-clicking a session enters rename mode; Enter fires onRename', () => {
    const onRename = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
      />,
    )
    fireEvent.doubleClick(screen.getByTestId('session-row'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed thing' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith(
      sessionSummary.sessionId,
      'renamed thing',
    )
  })

  it('does not allow renaming sessions under an offline workspace', () => {
    const onRename = vi.fn()
    localStorage.setItem(PREF_AUTO_HIDE_OFFLINE_WORKSPACES, '0')
    render(
      <Explorer
        executors={[]}
        sessions={[{ ...sessionSummary, workspaceId: 'ws-offline', workspaceName: 'offline box' }]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
      />,
    )

    fireEvent.doubleClick(screen.getByTestId('session-row'))
    expect(screen.queryByTestId('session-rename-input')).toBeNull()
    const button = screen.getByTestId('session-rename-button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRename).not.toHaveBeenCalled()
  })

  it('submits session rename only once when Enter is followed by blur', () => {
    const onRename = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
      />,
    )
    fireEvent.doubleClick(screen.getByTestId('session-row'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed once' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith(sessionSummary.sessionId, 'renamed once')
  })

  it('keeps session editing stable across runtime-only summary refreshes', () => {
    const stableProps = {
      onSelect: () => {},
      onNewSession: () => {},
      onConnectWorkspace: () => {},
      onDelete: () => {},
      onRename: () => {},
    }
    const { rerender } = render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        {...stableProps}
      />,
    )
    fireEvent.doubleClick(screen.getByTestId('session-row'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'draft rename' } })

    rerender(
      <Explorer
        executors={[executor]}
        sessions={[{ ...sessionSummary, eventCount: sessionSummary.eventCount + 20, lastEventAt: new Date().toISOString() }]}
        selectedSessionId={sessionSummary.sessionId}
        {...stableProps}
      />,
    )

    expect(screen.getByTestId('session-rename-input')).toHaveProperty('value', 'draft rename')
  })

  it('shows explicit row actions for rename and session info', () => {
    const onRename = vi.fn()
    const onOpenSessionInfo = vi.fn()
    const onSelect = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={onRename}
        onOpenSessionInfo={onOpenSessionInfo}
      />,
    )

    fireEvent.click(screen.getByTestId('session-info-button'))
    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('session-rename-button'))
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renamed from button' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith(
      sessionSummary.sessionId,
      'renamed from button',
    )
  })

  it('offers all secondary session actions from the compact touch menu', () => {
    const onRename = vi.fn()
    const onOpenSessionInfo = vi.fn()
    const onHideSession = vi.fn()
    const onDelete = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={onRename}
        onOpenSessionInfo={onOpenSessionInfo}
        onHideSession={onHideSession}
      />,
    )

    fireEvent.click(screen.getByTestId('session-more-button'))
    const menu = screen.getByTestId('session-action-menu')
    expect(menu.textContent).toContain('Rename')
    expect(menu.textContent).toContain('Session info')
    expect(menu.textContent).toContain('Hide')
    expect(menu.textContent).toContain('Delete')
    fireEvent.click(within(menu).getByText('Session info'))
    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)
    expect(screen.queryByTestId('session-action-menu')).toBeNull()
  })

  it('never selects the session when clicking any row action button', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const onOpenSessionInfo = vi.fn()
    const onHideSession = vi.fn()
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={undefined}
        onSelect={onSelect}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
        onOpenSessionInfo={onOpenSessionInfo}
        onHideSession={onHideSession}
      />,
    )

    // Clicking action buttons must run their own handler only, never select.
    fireEvent.click(screen.getByTestId('session-info-button'))
    fireEvent.click(screen.getByTestId('session-rename-button'))

    expect(onOpenSessionInfo).toHaveBeenCalledWith(sessionSummary.sessionId)
    // The rename button entered edit mode rather than activating the row.
    expect(screen.getByTestId('session-rename-input')).toHaveProperty('tagName', 'INPUT')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not let the hidden date layer intercept clicks over the action buttons', () => {
    // Regression: the date layer and the action-button overlay share the same
    // grid cell. When the date layer stays clickable
    // while faded out on hover, it sits on top of the buttons and swallows the
    // click, so pressing rename/hide/delete only switched sessions. The hidden
    // layer must be pointer-events:none and the action overlay must re-enable
    // pointer events on hover.
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={undefined}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onOpenSessionInfo={() => {}}
        onHideSession={() => {}}
      />,
    )

    const actionOverlay = screen
      .getByTestId('session-rename-button')
      .closest('[data-row-action]') as HTMLElement
    expect(actionOverlay.className).toContain('pointer-events-none')
    expect(actionOverlay.className).toContain('group-hover:pointer-events-auto')
    expect(actionOverlay.className).toContain('ak-session-row-actions')
    expect(actionOverlay.className).toContain('z-10')
    expect(actionOverlay.className).not.toContain('col-start-2')
    expect(screen.getByTestId('session-more-button').className).not.toContain('hidden')
    expect(screen.getByTestId('session-info-button').className).toContain('hidden')

    const dateLayer = screen
      .getByTestId('session-row')
      .querySelector('.ak-touch-hide') as HTMLElement
    expect(dateLayer.className).toContain('pointer-events-none')
  })

  it('renders active running statuses as bold ambient session names', () => {
    const second: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'second task',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, second]}
        selectedSessionId={sessionSummary.sessionId}
        sessionStatuses={new Map([
          [sessionSummary.sessionId, 'thinking'],
          [second.sessionId, 'executing_tools'],
        ])}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    const labels = screen.getAllByTestId('running-session-label')
    expect(labels).toHaveLength(2)
    for (const label of labels) {
      expect(label.className).toContain('ak-thinking-text')
      expect(label.className).toContain('font-semibold')
      expect(label.className).toContain('ak-session-running-label')
    }
    expect(screen.queryByTestId('session-status-spinner')).toBeNull()
  })

  it('marks the selected session without shifting the row grid', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={sessionSummary.sessionId}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )
    const sessionRow = screen.getByTestId('session-row')
    expect(sessionRow.className).toContain('bg-muted/55')
    expect(sessionRow.querySelector('.ak-session-label')?.className).toContain('font-medium')
    expect(sessionRow.className).toContain('ak-session-row')
    expect(sessionRow.className).not.toMatch(/border-l-primary/)
    expect(sessionRow.className).not.toContain('shadow-[inset_0_0_0_1px')
    expect(screen.getByTestId('session-selected-marker').className).toContain('w-0.5')
  })

  it('filters sessions locally and highlights matched text', () => {
    const other: SessionSummary = {
      ...sessionSummary,
      sessionId: '02JXXXXXXXXXXXXXXXXXXXXX',
      firstUserMessage: 'review auth flow',
      currentCwd: '/repo/auth',
    }
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary, other]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('explorer-search-button'))
    fireEvent.change(screen.getByTestId('explorer-search'), { target: { value: 'auth' } })

    expect(screen.getByTestId('workspace-row').textContent).toContain('my-mbp')
    expect(screen.getAllByTestId('session-row')).toHaveLength(1)
    expect(screen.getByTestId('session-row').textContent).toContain('review auth flow')
    expect(screen.getAllByTestId('explorer-search-highlight').map((node) => node.textContent)).toContain('auth')
  })

  it('shows an empty filter state when nothing matches', () => {
    render(
      <Explorer
        executors={[executor]}
        sessions={[sessionSummary]}
        selectedSessionId={null}
        onSelect={() => {}}
        onNewSession={() => {}}
        onConnectWorkspace={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('explorer-search-button'))
    fireEvent.change(screen.getByTestId('explorer-search'), { target: { value: 'does-not-exist' } })
    expect(screen.getByTestId('explorer-filter-empty').textContent).toContain('does-not-exist')
  })

  describe('hover dismissal lifecycle', () => {
    const second = { ...sessionSummary, sessionId: 'second-hover', firstUserMessage: 'second request' }
    const props = {
      executors: [executor], sessions: [sessionSummary, second], selectedSessionId: null,
      onSelect: vi.fn(), onNewSession: vi.fn(), onConnectWorkspace: vi.fn(),
      onDelete: vi.fn(), onRename: vi.fn(), getCachedSessionView: cachedSessionView,
    }
    const row = (id = sessionSummary.sessionId) => screen.getAllByTestId('session-row').find((element) => element.dataset.sessionId === id)!
    const advance = async (ms = 100) => act(async () => { vi.advanceTimersByTime(ms) })
    const enter = async (id = sessionSummary.sessionId) => {
      fireEvent.pointerEnter(row(id), { pointerType: 'mouse' })
      await advance(50)
      expect(screen.getByTestId('session-hover-preview')).toBeTruthy()
    }
    const leave = () => fireEvent.pointerLeave(row(), { relatedTarget: document.body })
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => { cleanup(); vi.useRealTimers() })

    it('dismisses after leaving a row and cancels that close on quick reentry', async () => {
      render(<Explorer {...props} />)
      await enter()
      leave()
      await advance(40)
      fireEvent.pointerEnter(row(), { pointerType: 'mouse' })
      await advance()
      expect(screen.getByTestId('session-hover-preview')).toBeTruthy()
      leave()
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    })

    it('allows crossing into and interacting with the preview, then dismisses on leaving it', async () => {
      render(<Explorer {...props} />)
      await enter()
      leave()
      await advance(40)
      fireEvent.pointerEnter(screen.getByTestId('session-hover-preview'))
      await advance()
      fireEvent.scroll(screen.getByTestId('session-hover-preview-summary'))
      fireEvent.click(screen.getByTestId('session-hover-preview-summary'))
      expect(screen.getByTestId('session-hover-preview')).toBeTruthy()
      fireEvent.pointerLeave(screen.getByTestId('session-hover-preview'), { relatedTarget: document.body })
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    })

    it('does not inherit a portal hover flag or stale close when switching rows', async () => {
      render(<Explorer {...props} />)
      await enter()
      fireEvent.pointerEnter(screen.getByTestId('session-hover-preview'))
      // A removed/repositioned portal need not deliver a corresponding leave.
      await enter(second.sessionId)
      fireEvent.pointerLeave(row(), { relatedTarget: document.body })
      await advance()
      expect(screen.getByTestId('session-hover-preview')).toBeTruthy()
      fireEvent.pointerLeave(row(second.sessionId), { relatedTarget: document.body })
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    })

    it('recovers a missing native row leave from the document pointer target', async () => {
      render(<Explorer {...props} />)
      await enter()
      fireEvent.pointerMove(document.body)
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    })

    it('dismisses when the hovered session is removed from the tree without pointerleave', async () => {
      const result = render(<Explorer {...props} />)
      await enter()
      result.rerender(<Explorer {...props} sessions={[second]} />)
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    })

    it.each(['blur', 'resize', 'scroll', 'pointercancel', 'window-exit', 'hidden'])('cleans preview watches on %s', async (reason) => {
      const store = new SessionPreviewStore()
      store.set({ sessionId: sessionSummary.sessionId, view: cachedSessionView(sessionSummary.sessionId), freshness: 'cached', streamingText: '', updatedAt: 0 })
      const release = vi.fn()
      const watch = vi.spyOn(store, 'watch').mockReturnValue(release)
      render(<Explorer {...props} previewStore={store} />)
      await enter()
      expect(watch).toHaveBeenCalledTimes(1)
      fireEvent.pointerEnter(screen.getByTestId('session-hover-preview'))
      if (reason === 'hidden') {
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        fireEvent(document, new Event('visibilitychange'))
        visibility.mockRestore()
      } else if (reason === 'window-exit') {
        fireEvent(document.body, new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
      } else if (reason === 'pointercancel') {
        fireEvent.pointerCancel(document.body)
      } else {
        fireEvent(window, new Event(reason))
      }
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('releases watches and pending close timers on unmount', async () => {
      const store = new SessionPreviewStore()
      store.set({ sessionId: sessionSummary.sessionId, view: cachedSessionView(sessionSummary.sessionId), freshness: 'cached', streamingText: '', updatedAt: 0 })
      const release = vi.fn()
      vi.spyOn(store, 'watch').mockReturnValue(release)
      const result = render(<Explorer {...props} previewStore={store} />)
      await enter()
      leave()
      result.unmount()
      expect(release).toHaveBeenCalledTimes(1)
      await advance()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    })
  })

  it('shows a cached lightweight preview when hovering a loaded session on desktop', async () => {
    vi.useFakeTimers()
    try {
      render(
        <Explorer
          executors={[executor]}
          sessions={[sessionSummary]}
          selectedSessionId={null}
          onSelect={() => {}}
          onNewSession={() => {}}
          onConnectWorkspace={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          getCachedSessionView={() => cachedSessionView(sessionSummary.sessionId)}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      const preview = screen.getByTestId('session-hover-preview')
      expect(preview).toBeTruthy()
      expect(preview.style.height).toBe('')
      expect(screen.getByTestId('session-preview-activity').textContent).toContain('Idle')
      expect(screen.getByTestId('session-preview-goal').textContent).toContain('please write hello.txt')
      expect(screen.getByTestId('session-preview-response').textContent).toContain('Done.')
      expect(screen.queryByTestId('session-preview-row')).toBeNull()
      expect(screen.queryByTestId('virtual-transcript')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes an open hover preview when its cache entry changes', async () => {
    vi.useFakeTimers()
    try {
      const cache = createSessionViewCache({ maxBytes: 1024 * 1024 })
      cache.set(sessionSummary.sessionId, cachedSessionView(sessionSummary.sessionId))
      render(
        <Explorer
          executors={[executor]}
          sessions={[sessionSummary]}
          selectedSessionId={null}
          onSelect={() => {}}
          onNewSession={() => {}}
          onConnectWorkspace={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          getCachedSessionView={cache.peek}
          subscribeCachedSessionView={cache.subscribe}
        />,
      )
      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => vi.advanceTimersByTime(50))
      expect(screen.getByTestId('session-preview-response').textContent).toContain('Done.')
      const updated = cachedSessionView(sessionSummary.sessionId)
      act(() => {
        cache.set(sessionSummary.sessionId, {
          ...updated,
          timeline: [...updated.timeline, {
            seq: 3, ts: '2026-07-05T10:00:01.000Z',
            event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Latest realtime checkpoint.' }] } }, effects: [],
          }],
        })
      })
      expect(screen.getByTestId('session-preview-response').textContent).toContain('Latest realtime checkpoint.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only the latest human goal instead of a raw event window for long sessions', async () => {
    vi.useFakeTimers()
    try {
      const cached = cachedSessionView(sessionSummary.sessionId)
      const timeline = Array.from({ length: 16 }, (_, index) => ({
        seq: index + 1,
        ts: `2026-07-05T10:00:${String(index).padStart(2, '0')}.000Z`,
        event: { kind: 'user_message' as const, text: `history-message-${index + 1}` },
        effects: [],
      }))
      render(
        <Explorer
          executors={[executor]} sessions={[sessionSummary]} selectedSessionId={null}
          onSelect={() => {}} onNewSession={() => {}} onConnectWorkspace={() => {}}
          onDelete={() => {}} onRename={() => {}}
          getCachedSessionView={() => ({ ...cached, timeline })}
        />,
      )
      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => vi.advanceTimersByTime(50))
      expect(screen.getByTestId('session-hover-preview').style.height).toBe('')
      expect(screen.getByTestId('session-preview-goal').textContent).toContain('history-message-16')
      expect(screen.getByTestId('session-hover-preview-summary').textContent).not.toContain('history-message-15')
      expect(screen.queryByTestId('session-preview-row')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not load or select a session when hover preview has no cached view', async () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const getCachedSessionView = vi.fn(() => null)
    try {
      render(
        <Explorer
          executors={[executor]}
          sessions={[sessionSummary]}
          selectedSessionId={null}
          onSelect={onSelect}
          onNewSession={() => {}}
          onConnectWorkspace={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          getCachedSessionView={getCachedSessionView}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(getCachedSessionView).toHaveBeenCalledWith(sessionSummary.sessionId)
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show hover preview for the currently selected session', async () => {
    vi.useFakeTimers()
    const getCachedSessionView = vi.fn(() => cachedSessionView(sessionSummary.sessionId))
    try {
      render(
        <Explorer
          executors={[executor]}
          sessions={[sessionSummary]}
          selectedSessionId={sessionSummary.sessionId}
          onSelect={() => {}}
          onNewSession={() => {}}
          onConnectWorkspace={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          getCachedSessionView={getCachedSessionView}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(getCachedSessionView).not.toHaveBeenCalled()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show hover preview when the device has no fine hover pointer', async () => {
    vi.useFakeTimers()
    const getCachedSessionView = vi.fn(() => cachedSessionView(sessionSummary.sessionId))
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    try {
      render(
        <Explorer
          executors={[executor]}
          sessions={[sessionSummary]}
          selectedSessionId={null}
          onSelect={() => {}}
          onNewSession={() => {}}
          onConnectWorkspace={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          getCachedSessionView={getCachedSessionView}
        />,
      )

      fireEvent.pointerEnter(screen.getByTestId('session-row'), { pointerType: 'mouse' })
      await act(async () => {
        vi.advanceTimersByTime(50)
      })

      expect(getCachedSessionView).not.toHaveBeenCalled()
      expect(screen.queryByTestId('session-hover-preview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

function cachedSessionView(sessionId: string): CachedSessionView {
  const ts = '2026-07-05T10:00:00.000Z'
  return {
    sessionId,
    status: 'ready',
    state: createInitialState({ sessionId }),
    config: createConfig({ tools: [] }),
    contextSnapshot: null,
    timeline: [
      {
        seq: 1,
        ts,
        event: { kind: 'user_message', text: 'please write hello.txt' },
        effects: [],
      },
      {
        seq: 2,
        ts,
        event: {
          kind: 'llm_response',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        },
        effects: [],
      },
    ],
    queuedMessages: [],
    lastError: null,
    parentSessionId: null,
    parentCursor: null,
    selectedModel: 'anthropic/claude-opus-4.1',
    hydratedSessionId: sessionId,
    cachedAt: Date.now(),
    estimatedBytes: 1,
    estimateParts: { staticBytes: 1, stateBytes: 0, timelineBytes: 0 },
  }
}
