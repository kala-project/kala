import { fireEvent, render, screen } from '@testing-library/react'
import type { SessionSummary } from '@agent-kernel/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { NarrowContextualRow, NoSessionArea, TopbarRestoreButton, WorkbenchToolbar, connectionStatusForTransport, readInitialConfig, sessionLocationSearch, resolveSessionDirectoryLoadingOwner, selectedSessionHistoryIsLoading, sessionDirectoryIsLoading, shouldRenderWorkbenchToolbar, workspaceTerminalCloseNeedsConfirmation, workspaceTerminalDialogSizeClass, workspaceTerminalSessionId } from './app.js'
import { DesktopSessionRail } from './app-shell/AppShellNav.js'
import { coarseStatusForIndicator, deriveSelectedSessionActivity } from './app-logic/session-activity.js'

function renderToolbar(overrides: Partial<Parameters<typeof WorkbenchToolbar>[0]> = {}): void {
  render(
    <WorkbenchToolbar
      sessionLabel="Loaded session"
      cwd="/workspace"
      onOpenTopbar={() => {}}
      topbarAvailable={false}
      onOpenExplorer={() => {}}
      explorerAvailable={false}
      onOpenSidebar={() => {}}
      sidebarAvailable={false}
      onChangeCwd={() => {}}
      sessionSelected={false}
      {...overrides}
    />,
  )
}

describe('bounded busy-indicator rendering', () => {
  it('expands the workspace terminal close to the application viewport', () => {
    expect(workspaceTerminalDialogSizeClass(false)).toContain('1100px')
    expect(workspaceTerminalDialogSizeClass(false)).toContain('720px')
    expect(workspaceTerminalDialogSizeClass(true)).toContain('sm:w-[calc(100vw-2rem)]')
    expect(workspaceTerminalDialogSizeClass(true)).toContain('sm:h-[calc(var(--ak-viewport-h,100dvh)-2rem)]')
  })

  it('uses a stable workspace terminal identity and confirms only destructive closes', () => {
    expect(workspaceTerminalSessionId('session-1')).toBe('workspace-terminal:session-1:primary')
    expect(workspaceTerminalCloseNeedsConfirmation(false, 'running')).toBe(true)
    expect(workspaceTerminalCloseNeedsConfirmation(true, 'running')).toBe(false)
    expect(workspaceTerminalCloseNeedsConfirmation(false, 'exited')).toBe(false)
  })

  it('stops the history spinner if a selected session subscription or replay fails', () => {
    const pending = { selectedSessionId: 'next', historyLoadedSessionId: 'previous', eventCount: 8, firstUserMessage: null }
    expect(selectedSessionHistoryIsLoading({ ...pending, status: 'connecting' })).toBe(true)
    expect(selectedSessionHistoryIsLoading({ ...pending, status: 'error' })).toBe(false)
    expect(selectedSessionHistoryIsLoading({ ...pending, status: 'ready', historyLoadedSessionId: 'next' })).toBe(false)
  })

  it('keeps smooth busy feedback, breathing and sheen with reduced-motion support', () => {
    const dashboardStyles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    expect(dashboardStyles).toContain('animation: ak-session-status-spin 900ms linear infinite;')
    const reducedMotion = dashboardStyles.slice(dashboardStyles.indexOf('@media (prefers-reduced-motion: reduce)', dashboardStyles.indexOf('.ak-session-status-spinner {')))
    expect(reducedMotion).toMatch(/\.ak-session-status-spinner,[\s\S]*?animation: none !important;/)
    expect(dashboardStyles).toContain('@keyframes ak-thinking-text')
    expect(dashboardStyles).toContain('background-repeat: no-repeat;')
    expect(dashboardStyles).toContain('background-size: 250% 100%;')
    expect(dashboardStyles).toContain('animation: ak-thinking-text 950ms linear infinite;')
    expect(dashboardStyles).toMatch(/@keyframes ak-thinking-text\s*\{\s*from \{ background-position: 100% 0; \}\s*to \{ background-position: 0 0; \}\s*\}/)
    expect(dashboardStyles).toMatch(/\.ak-session-label\s*\{[\s\S]*?font-size: calc\(1em \+ 1px\);[\s\S]*?font-weight: 800;/)
    expect(dashboardStyles).toMatch(/\.ak-session-running-label\s*\{[\s\S]*?animation-duration: 1\.3s;/)
    expect(dashboardStyles).not.toContain('55%, 100% { background-position: -120% 0; }')
  })
})

describe('App hook ordering', () => {
  it('keeps hooks before loading and access-error early returns', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app.tsx'), 'utf8')
    const loadingReturn = source.indexOf("if (!runtimeDeployment.loaded")
    const mainRender = source.indexOf('<PwaLifecycleHost>', loadingReturn)
    expect(loadingReturn).toBeGreaterThan(0)
    expect(mainRender).toBeGreaterThan(loadingReturn)
    expect(source.slice(loadingReturn, mainRender)).not.toMatch(/\buse[A-Z][A-Za-z0-9_]*\s*\(/)
  })
})

describe('workbench sidebar layout', () => {
  it('keeps stable, non-overcommitted panels when the right sidebar opens', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app.tsx'), 'utf8')
    const splitStart = source.indexOf('autoSaveId="ak-workbench-cols-v1"')
    const splitEnd = source.indexOf('</ResizablePanelGroup>', splitStart)
    const split = source.slice(splitStart, splitEnd)

    expect(splitStart).toBeGreaterThan(0)
    expect(split).toMatch(/id="workbench-main"\s+order=\{1\}[\s\S]*?defaultSize=\{wideLayout \? \(inspectorOpen \? 74 : 100\) : 100\}[\s\S]*?minSize=\{wideLayout \? 70 : 100\}/)
    expect(split).toMatch(/id="workbench-inspector" order=\{2\} defaultSize=\{26\} minSize=\{26\} maxSize=\{42\} className="min-w-0/)
    expect(74 + 26).toBe(100)
  })
})

describe('shared transport connection indicator', () => {
  it('does not jump when switching sessions while the physical socket stays connected', () => {
    const socket = { connected: true }
    expect(connectionStatusForTransport(socket, 'connecting', true)).toBe('ready')
    expect(connectionStatusForTransport(socket, 'disconnected', true)).toBe('ready')
    socket.connected = false
    expect(connectionStatusForTransport(socket, 'connecting', true)).toBe('disconnected')
    expect(connectionStatusForTransport(socket, 'connecting', false)).toBe('connecting')
  })
})

describe('session directory loading', () => {
  it('depends only on the Session snapshot', () => {
    expect(sessionDirectoryIsLoading(false)).toBe(true)
    expect(sessionDirectoryIsLoading(true)).toBe(false)
  })

  it('assigns cold loading to exactly one visible surface', () => {
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: true, explorerOpen: true, explorerDrawerOpen: false })).toBe('explorer')
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: true, explorerOpen: false, explorerDrawerOpen: false })).toBe('workbench')
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: false, explorerOpen: false, explorerDrawerOpen: true })).toBe('explorer')
    expect(resolveSessionDirectoryLoadingOwner({ loading: true, wideLayout: false, explorerOpen: false, explorerDrawerOpen: false })).toBe('workbench')
    expect(resolveSessionDirectoryLoadingOwner({ loading: false, wideLayout: true, explorerOpen: true, explorerDrawerOpen: false })).toBeNull()
  })
})

describe('desktop sidebar controls', () => {
  it('renders a fixed narrow rail with the essential actions', () => {
    const onExpand = vi.fn()
    const onNewSession = vi.fn()
    const onConnectWorkspace = vi.fn()
    const onSelectSection = vi.fn()
    render(
      <DesktopSessionRail
        section="agent"
        onSelectSection={onSelectSection}
        connectionStatus={<span data-testid="rail-status">status</span>}
        onExpand={onExpand}
        onNewSession={onNewSession}
        onConnectWorkspace={onConnectWorkspace}
        globalActions={<button data-testid="rail-global-actions">Settings</button>}
      />,
    )

    expect(screen.getByTestId('desktop-session-rail').className).toContain('w-16')
    expect(screen.getByTestId('rail-status')).toBeTruthy()
    fireEvent.click(screen.getByTestId('desktop-rail-expand'))
    fireEvent.click(screen.getByTestId('desktop-rail-new-session'))
    fireEvent.click(screen.getByTestId('desktop-rail-connect-workspace'))
    fireEvent.click(screen.getByTestId('product-switcher-artifacts'))
    expect(onExpand).toHaveBeenCalledOnce()
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(onConnectWorkspace).toHaveBeenCalledOnce()
    expect(onSelectSection).toHaveBeenCalledWith('artifacts')
    expect(screen.getByTestId('desktop-rail-footer').contains(screen.getByTestId('rail-global-actions'))).toBe(true)
  })

  it('expands when the collapsed rail blank surface is clicked without hijacking its controls', () => {
    const onExpand = vi.fn()
    const onNewSession = vi.fn()
    render(
      <DesktopSessionRail
        section="agent"
        onSelectSection={() => {}}
        onExpand={onExpand}
        onNewSession={onNewSession}
        globalActions={<button data-testid="rail-settings">Settings</button>}
      />,
    )

    fireEvent.click(screen.getByTestId('desktop-session-rail'))
    expect(onExpand).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('desktop-rail-new-session'))
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(onExpand).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('rail-settings'))
    expect(onExpand).toHaveBeenCalledOnce()
  })

  it('keeps the Inspector circle beside the session bar instead of inside it or overlaying content', () => {
    const onOpen = vi.fn()
    renderToolbar({ sessionSelected: true, sidebarAvailable: true, onOpenSidebar: onOpen })

    const surface = screen.getByTestId('workbench-toolbar')
    const button = screen.getByTestId('sidebar-toggle')
    expect(surface.contains(button)).toBe(false)
    expect(screen.getByTestId('workbench-toolbar-rail').contains(button)).toBe(true)
    expect(button.className).toContain('rounded-full')
    expect(button.className).not.toContain('absolute')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('uses a separate circular navigation opener on narrow product pages', () => {
    const onOpen = vi.fn()
    render(<NarrowContextualRow section="docs" onOpenNavigation={onOpen} />)
    const button = screen.getByTestId('narrow-navigation-opener')
    expect(button.className).toContain('rounded-full')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe('WorkbenchToolbar', () => {
  it('provides one in-row mount slot for native Desktop window controls in both placements', () => {
    Object.defineProperty(window, '__KALA_DESKTOP__', { value: true, configurable: true })
    try {
      renderToolbar({ sessionSelected: true })
      renderToolbar({ sessionSelected: true, placement: 'topbar' })
      const slots = screen.getAllByTestId('desktop-window-controls-slot')
      expect(slots).toHaveLength(2)
      for (const slot of slots) {
        expect(slot.getAttribute('data-kala-desktop-window-controls-slot')).toBe('true')
        expect(slot.className).toContain('w-[132px]')
      }
    } finally {
      delete (window as Window & { __KALA_DESKTOP__?: boolean }).__KALA_DESKTOP__
    }
  })

  it('hides the session bar while the full desktop Session sidebar is expanded', () => {
    expect(shouldRenderWorkbenchToolbar(true, true)).toBe(false)
    expect(shouldRenderWorkbenchToolbar(true, false)).toBe(true)
    expect(shouldRenderWorkbenchToolbar(true, false, false)).toBe(false)
    expect(shouldRenderWorkbenchToolbar(false, true)).toBe(true)
    expect(shouldRenderWorkbenchToolbar(false, true, false)).toBe(false)
    expect(shouldRenderWorkbenchToolbar(false, false)).toBe(true)
  })

  it('labels the unsaved draft without putting creation back in the workbench toolbar', () => {
    renderToolbar({ draft: true })
    expect(screen.getByTestId('session-label').textContent).toBe('New chat')
    expect(screen.queryByTestId('workbench-new-session')).toBeNull()
  })

  it('renders the title controls as one inset floating surface', () => {
    renderToolbar({ sessionSelected: true })

    const rail = screen.getByTestId('workbench-toolbar-rail')
    const surface = screen.getByTestId('workbench-toolbar')
    expect(rail.contains(surface)).toBe(true)
    expect(surface.className).toContain('ak-titlebar-surface')
    expect(rail.className).toContain('p-1.5')
    expect(rail.className).toContain('min-[1180px]:pl-0')
    expect(surface.className).toContain('min-h-9')
  })

  it('labels a workspace-free conversation as Chat without exposing a cwd', () => {
    renderToolbar({ sessionSelected: true, simpleChat: true, cwd: '', onChangeCwd: undefined })
    expect(screen.getByTestId('simple-chat-badge').textContent).toBe('Chat')
    expect(screen.queryByRole('button', { name: /working directory/i })).toBeNull()
  })

  it('uses a downward arrow to expand a collapsed Topbar', () => {
    renderToolbar({ topbarAvailable: true })

    const toggle = screen.getByTestId('topbar-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Expand top bar')
    expect(toggle.querySelector('.lucide-chevron-down')).toBeTruthy()
    expect(toggle.querySelector('.lucide-chevron-up')).toBeNull()
  })

  it('uses an upward arrow to collapse an expanded Topbar', () => {
    const onToggle = vi.fn()
    renderToolbar({ topbarAvailable: true, topbarExpanded: true, onOpenTopbar: onToggle })

    const toggle = screen.getByTestId('topbar-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Collapse top bar')
    expect(toggle.querySelector('.lucide-chevron-up')).toBeTruthy()
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('leaves a compact restore control after the Topbar is collapsed', () => {
    const onOpen = vi.fn()
    render(<TopbarRestoreButton onClick={onOpen} />)

    const restore = screen.getByTestId('topbar-restore')
    const button = screen.getByRole('button', { name: 'Expand top bar' })
    expect(restore.className).toContain('absolute')
    expect(button.className).toContain('rounded-full')
    expect(button.querySelector('.lucide-chevron-down')).toBeTruthy()
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('can render as a capsule inside the collapsed workbench topbar', () => {
    renderToolbar({
      placement: 'topbar',
      sessionSelected: true,
      simpleChat: true,
      topbarAvailable: true,
      explorerAvailable: true,
      sidebarAvailable: true,
      brand: <span data-testid="collapsed-brand">Kala</span>,
      rightSlot: <span data-testid="collapsed-actions">Actions</span>,
    })

    expect(screen.queryByTestId('workbench-toolbar-rail')).toBeNull()
    expect(screen.getByTestId('workbench-toolbar').className).not.toContain('ak-titlebar-surface')
    expect(screen.getByTestId('workbench-toolbar').className).not.toContain('ak-fused-topbar')
    expect(screen.getByTestId('workbench-toolbar').className).not.toContain('ak-global-topbar')
    expect(screen.getByTestId('workbench-toolbar').className).toContain('flex-none')
    expect(screen.getByTestId('workbench-toolbar').className).not.toContain('flex-1')
    expect(screen.getByTestId('workbench-toolbar').querySelector('.ak-fused-topbar-capsule')).toBeTruthy()
    expect(screen.getByTestId('collapsed-brand').textContent).toBe('Kala')
    expect(screen.getByTestId('explorer-toggle').className).toContain('rounded-full')
    expect(screen.getByTestId('sidebar-toggle').className).toContain('rounded-full')
    expect(screen.getByTestId('explorer-toggle').compareDocumentPosition(screen.getByTestId('collapsed-brand')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('collapsed-actions').textContent).toBe('Actions')
    expect(screen.getByTestId('session-title').className).not.toContain('text-zinc-100')
    expect(screen.getByTestId('session-title').className).toContain('max-w-[36vw]')
    expect(screen.getByTestId('session-status-indicator').className).toContain('w-6')
    expect(screen.getByTestId('session-status-indicator').textContent).toBe('Unknown')
    expect(screen.getByTestId('session-status-indicator').querySelector('span:last-child')?.className).toContain('sr-only')
    expect(screen.getByTestId('session-label').textContent).toBe('Loaded session')
    expect(screen.getByTestId('simple-chat-badge').className).toContain('hidden')
    expect(screen.getByTestId('simple-chat-badge').className).toContain('sm:inline-flex')
    expect(screen.getByTestId('collapsed-actions').compareDocumentPosition(screen.getByTestId('topbar-toggle')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('uses one sidebar opener and does not duplicate it with a terminal shortcut', () => {
    const onOpenSidebar = vi.fn()
    renderToolbar({ sessionSelected: true, onOpenSidebar, sidebarAvailable: true })

    fireEvent.click(screen.getByRole('button', { name: 'Open inspector' }))
    expect(onOpenSidebar).toHaveBeenCalledOnce()
    expect(screen.getByTestId('sidebar-toggle')).toBeTruthy()
    expect(screen.queryByTestId('terminal-toggle')).toBeNull()
    expect(screen.queryByTestId('inspector-toggle')).toBeNull()
  })

  it('keeps a stable Sessions title while the directory is loading', () => {
    renderToolbar({ sessionDirectoryLoading: true })

    expect(screen.getByTestId('session-title').getAttribute('data-loading')).toBeNull()
    expect(screen.getByTestId('session-label').textContent).toBe('Sessions')
    expect(screen.getByTestId('session-label').textContent).not.toBe('no session selected')
    const title = screen.getByTestId('session-title')
    expect(title.querySelector('.ak-loading-spinner')).toBeNull()
    expect(title.querySelector('svg.animate-spin')).toBeNull()
  })

  it('shows no session selected only after loading has settled without a selected session', () => {
    renderToolbar({ sessionDirectoryLoading: false })

    expect(screen.getByTestId('session-title').getAttribute('data-loading')).toBeNull()
    expect(screen.getByTestId('session-label').textContent).toBe('no session selected')
  })

  it('keeps the selected session label when a session is active', () => {
    renderToolbar({ sessionSelected: true, sessionDirectoryLoading: true, sessionActivityStatus: 'loading', onChangeCwd: vi.fn() })

    expect(screen.getByTestId('session-label').textContent).toBe('Loaded session')
  })

  it('uses the dedicated transform owner for the title activity spinner', () => {
    renderToolbar({ sessionSelected: true, sessionActivityStatus: 'thinking', onChangeCwd: vi.fn() })

    const indicator = screen.getByTestId('session-status-indicator')
    const spinner = screen.getByTestId('session-status-spinner')
    const icon = indicator.querySelector('svg')
    expect(spinner.className).toContain('ak-session-status-spinner')
    expect(icon?.className.baseVal).not.toContain('animate-spin')
    expect(icon?.className.baseVal).not.toContain('translateZ')
    expect(indicator.textContent).toContain('Thinking')
  })

  it('keeps one stable spinner DOM node across rapid running-state updates', () => {
    const { rerender } = render(
      <WorkbenchToolbar
        sessionLabel="Loaded session"
        cwd="/workspace"
        onOpenTopbar={() => {}}
        topbarAvailable={false}
        onOpenExplorer={() => {}}
        explorerAvailable={false}
        onOpenSidebar={() => {}}
        sidebarAvailable={false}
        onChangeCwd={() => {}}
        sessionSelected
        sessionActivityStatus="loading"
      />,
    )
    const spinner = screen.getByTestId('session-status-spinner')
    rerender(
      <WorkbenchToolbar
        sessionLabel="Loaded session"
        cwd="/workspace"
        onOpenTopbar={() => {}}
        topbarAvailable={false}
        onOpenExplorer={() => {}}
        explorerAvailable={false}
        onOpenSidebar={() => {}}
        sidebarAvailable={false}
        onChangeCwd={() => {}}
        sessionSelected
        sessionActivityStatus="loading"
      />,
    )
    expect(screen.getByTestId('session-status-spinner')).toBe(spinner)
    expect(spinner.className).toContain('ak-session-status-spinner')
    expect(screen.getByTestId('session-status-indicator').textContent).toBeTruthy()
    expect(screen.getByTestId('session-status-indicator').getAttribute('data-status')).toBe('loading')
  })
})

describe('NoSessionArea', () => {
  it('starts a new session without passing the click event as workspace id', () => {
    const onNewSession = vi.fn()
    render(<NoSessionArea onNewSession={onNewSession} hasSessions={false} />)

    fireEvent.click(screen.getByTestId('no-session-new-button'))

    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(onNewSession).toHaveBeenCalledWith()
  })

  it('shows only the three sessions updated most recently within 48 hours on the startup page', () => {
    const now = Date.now()
    const makeSession = (sessionId: string, hoursAgo: number): SessionSummary => ({
      sessionId,
      agentRuntime: 'kernel',
      createdAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
      lastEventAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
      eventCount: 1,
    })
    render(
      <NoSessionArea
        onNewSession={() => {}}
        hasSessions
        sessions={[
          makeSession('old', 49),
          makeSession('third', 24),
          makeSession('newest', 1),
          makeSession('fourth', 36),
          makeSession('second', 12),
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: 'What can I help with?' })).toBeTruthy()
    expect(screen.getAllByTestId('session-cockpit-session')).toHaveLength(3)
    expect(screen.queryByText('old')).toBeNull()
    expect(screen.queryByText('fourth')).toBeNull()
  })

  describe('initial session selection', () => {
    it('preserves a forced refresh through app boot while stripping credentials and unrelated query parameters', () => {
      const search = '?__kala_refresh=once&token=secret&host=remote'
      expect(sessionLocationSearch({ explicit: false, sessionId: null }, search)).toBe('?__kala_refresh=once')
      expect(sessionLocationSearch({ explicit: true, sessionId: 'selected' }, search)).toBe('?sessionId=selected&__kala_refresh=once')
      expect(sessionLocationSearch({ explicit: true, sessionId: 'selected' }, '?token=secret')).toBe('?sessionId=selected')
    })

    it.each(['/', '/#/agent', '/#/docs'])('opens %s as an unsaved draft regardless of saved tabs', (url) => {
      window.history.replaceState(null, '', url)
      localStorage.setItem('ak-session-tabs-v1', JSON.stringify({ open: ['previous-session'] }))
      expect(readInitialConfig()).toEqual({ sessionId: null, explicit: false })
    })

    it.each(['/?sessionId=selected', '/#/sessions/selected'])('preserves explicit session links: %s', (url) => {
      window.history.replaceState(null, '', url)
      expect(readInitialConfig()).toEqual({ sessionId: 'selected', explicit: true })
      window.history.replaceState(null, '', '/')
    })
  })

  it('keeps a simple chat entry available before any workspace is connected', () => {
    const onNewSession = vi.fn()
    const onConnectWorkspace = vi.fn()
    render(<NoSessionArea onNewSession={onNewSession} onConnectWorkspace={onConnectWorkspace} hasSessions={false} hasWorkspace={false} />)

    fireEvent.click(screen.getByTestId('no-session-new-button'))

    expect(screen.getByTestId('no-session-new-button').textContent).toBe('New chat')
    expect(screen.getByTestId('no-session-connect-workspace')).toBeTruthy()
    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(onConnectWorkspace).not.toHaveBeenCalled()
  })
})

describe('deriveSelectedSessionActivity', () => {
  it('does not leak the previous session live state during a selection switch', () => {
    const activity = deriveSelectedSessionActivity({
      selectedSessionId: 'session-b',
      hydratedSessionId: 'session-a',
      summaryStatus: 'idle',
      liveStatus: 'executing_tools',
      streamingActive: true,
      awaitingAck: true,
      compactRunning: true,
    })

    expect(activity.status).toBe('idle')
    expect(activity.derived.isRunning).toBe(false)
    expect(activity.usesLiveProjection).toBe(false)
  })

  it('keeps a completed Host summary stable while stale cached running content paints', () => {
    const activity = deriveSelectedSessionActivity({
      selectedSessionId: 'session-done',
      hydratedSessionId: null,
      summaryStatus: 'done',
      liveStatus: 'executing_tools',
      streamingActive: false,
      awaitingAck: false,
      compactRunning: false,
    })

    expect(activity.status).toBe('done')
    expect(activity.indicatorStatus).toBe('done')
    expect(activity.derived.isRunning).toBe(false)
    expect(activity.usesLiveProjection).toBe(false)
  })

  it('uses live state only after the selected session projection is hydrated', () => {
    const activity = deriveSelectedSessionActivity({
      selectedSessionId: 'session-b',
      hydratedSessionId: 'session-b',
      summaryStatus: 'idle',
      liveStatus: 'thinking',
      streamingActive: false,
      awaitingAck: false,
      compactRunning: false,
    })

    expect(activity.status).toBe('thinking')
    expect(activity.indicatorStatus).toBe('loading')
    expect(activity.derived.isRunning).toBe(true)
  })
})

describe('coarseStatusForIndicator', () => {
  it('collapses every running activity to a single stable value', () => {
    // thinking ⇄ executing_tools flips many times during a tool-heavy turn;
    // both (and the client `loading` bridge) must map to the same value so the
    // status-indicator identity is stable and the spinner/Explorer do not
    // re-render on every flip.
    expect(coarseStatusForIndicator('thinking')).toBe('loading')
    expect(coarseStatusForIndicator('executing_tools')).toBe('loading')
    expect(coarseStatusForIndicator('loading')).toBe('loading')
  })

  it('passes non-running statuses through unchanged', () => {
    expect(coarseStatusForIndicator('idle')).toBe('idle')
    expect(coarseStatusForIndicator('done')).toBe('done')
    expect(coarseStatusForIndicator('awaiting_approval')).toBe('awaiting_approval')
    expect(coarseStatusForIndicator('error')).toBe('error')
    expect(coarseStatusForIndicator(undefined)).toBeUndefined()
  })
})
