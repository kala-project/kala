import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerTerminalOutput } from '@agent-kernel/shared'
import { SessionTerminalPanel } from './SessionTerminalPanel.js'
import type { DashboardSocket } from '../../session.js'
import { TERMINAL_CREATE_CLIENT_TIMEOUT_MS } from '@agent-kernel/shared'

const writeMock = vi.fn()
const clearMock = vi.fn()
const focusMock = vi.fn()
const fitMock = vi.fn()
const inputListeners: Array<(data: string) => void> = []
let fitCols = 100
let fitRows = 12
let terminalOptions: { fontSize: number } | null = null
const terminalModes = { applicationCursorKeysMode: false }

vi.mock('@xterm/xterm', () => ({
  Terminal: class TerminalMock {
    options = { fontSize: 12 }
    modes = terminalModes
    cols = 100
    rows = 12
    write = writeMock
    writeln = vi.fn()
    clear = clearMock
    focus = focusMock
    loadAddon(addon: { activate?(terminal: TerminalMock): void }): void { addon.activate?.(this) }
    open(): void {}
    dispose(): void {}
    constructor() { terminalOptions = this.options }
    onData(listener: (data: string) => void): { dispose(): void } { inputListeners.push(listener); return { dispose() {} } }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FitAddonMock {
    private terminal?: { cols: number; rows: number }
    activate(terminal: { cols: number; rows: number }): void { this.terminal = terminal }
    fit(): void {
      fitMock()
      if (this.terminal) {
        this.terminal.cols = fitCols
        this.terminal.rows = fitRows
      }
    }
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class SearchAddonMock {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class WebLinksAddonMock {} }))

function makeSocket() {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const emit = vi.fn((event: string, payload: Record<string, unknown>, ack?: (result: unknown) => void) => {
    if (event === 'terminal:create') ack?.({ ...payload, terminalId: 'term-1', cwd: '/repo' })
    if (event === 'terminal:kill') ack?.({ ...payload, killed: true })
  })
  return {
    socket: {
      emit,
      on: (event: string, listener: (payload: never) => void) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
      off: (event: string, listener: (payload: never) => void) => listeners.get(event)?.delete(listener),
    } as unknown as DashboardSocket,
    emit,
    server(event: string, payload: unknown) { listeners.get(event)?.forEach((listener) => listener(payload as never)) },
  }
}

describe('SessionTerminalPanel', () => {
  let width: ReturnType<typeof vi.spyOn>
  let height: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writeMock.mockClear(); clearMock.mockClear(); focusMock.mockClear(); fitMock.mockClear(); inputListeners.length = 0
    fitCols = 100
    fitRows = 12
    terminalOptions = null
    terminalModes.applicationCursorKeysMode = false
    localStorage.clear()
    vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void { this.callback([], this as unknown as ResizeObserver) }
      unobserve(): void {}
      disconnect(): void {}
    })
    width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
    height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  })
  afterEach(() => {
    vi.useRealTimers()
    width.mockRestore()
    height.mockRestore()
    vi.unstubAllGlobals()
  })

  it('remains starting beyond five seconds and accepts a delayed native create ACK', async () => {
    vi.useFakeTimers()
    const mock = makeSocket()
    let acknowledge!: (result: unknown) => void
    mock.emit.mockImplementation((event, _payload, ack) => {
      if (event === 'terminal:create') acknowledge = ack!
    })
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('starting')
    await act(async () => acknowledge({ terminalId: 'delayed', cwd: '/repo' }))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('running')
  })

  it('cleans a fresh create after UI cancellation even when keep-running defaults on', async () => {
    const mock = makeSocket()
    let acknowledge!: (result: unknown) => void
    mock.emit.mockImplementation((event, payload, ack) => {
      if (event === 'terminal:create') acknowledge = ack!
      if (event === 'terminal:kill') ack?.({ ...payload, killed: true })
    })
    const { unmount } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    unmount()
    await act(async () => acknowledge({ terminalId: 'cancelled-create' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:kill', expect.objectContaining({ terminalId: 'cancelled-create' }), expect.any(Function))
  })

  it('cleans a fresh ACK after the client deadline without adopting it into the UI', async () => {
    vi.useFakeTimers()
    const mock = makeSocket()
    let acknowledge!: (result: unknown) => void
    mock.emit.mockImplementation((event, payload, ack) => {
      if (event === 'terminal:create') acknowledge = ack!
      if (event === 'terminal:kill') ack?.({ ...payload, killed: true })
    })
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_CREATE_CLIENT_TIMEOUT_MS) })
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('error')
    await act(async () => acknowledge({ terminalId: 'late-create' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:kill', expect.objectContaining({ terminalId: 'late-create' }), expect.any(Function))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('error')
  })

  it('cancels an old identity without adopting its terminal into the replacement panel', async () => {
    const mock = makeSocket()
    const acknowledgements: Array<(result: unknown) => void> = []
    mock.emit.mockImplementation((event, payload, ack) => {
      if (event === 'terminal:create') acknowledgements.push(ack!)
      if (event === 'terminal:kill') ack?.({ ...payload, killed: true })
    })
    const { rerender } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    rerender(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-2" autoStart />)
    await act(async () => acknowledgements[0]!({ terminalId: 'old-terminal' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:kill', expect.objectContaining({ sessionId: 'sess-1', terminalId: 'old-terminal' }), expect.any(Function))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('starting')
    await act(async () => acknowledgements[1]!({ terminalId: 'new-terminal' }))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('running')
  })

  it('does not kill a fresh late result reused by a reopened modal', async () => {
    const mock = makeSocket()
    const acknowledgements: Array<(result: unknown) => void> = []
    mock.emit.mockImplementation((event, _payload, ack) => {
      if (event === 'terminal:create') acknowledgements.push(ack!)
    })
    const first = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    first.unmount()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    await act(async () => acknowledgements[0]!({ terminalId: 'shared-result' }))
    await act(async () => acknowledgements[1]!({ terminalId: 'shared-result', reused: true }))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('running')
    expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:kill')).toHaveLength(0)
  })

  it('starts, filters output, sends xterm and touch input, resizes, clears, and does not kill on unmount', async () => {
    const mock = makeSocket()
    const { unmount } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:create', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1' }), expect.any(Function)))
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:resize', expect.objectContaining({ terminalId: 'term-1', cols: 100, rows: 12 })))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('running')
    expect(screen.getByTestId('terminal-toolbar').className).toContain('flex-nowrap')
    expect(screen.getByTestId('terminal-toolbar').className).toContain('overflow-hidden')
    expect(screen.getByTestId('terminal-status').querySelector('span')?.className).toContain('bg-emerald-500')
    expect(screen.getByTestId('terminal-viewport').className).toContain('focus-within:ring-1')
    expect(focusMock).toHaveBeenCalled()
    focusMock.mockClear()
    fireEvent.pointerDown(screen.getByTestId('terminal-viewport'))
    expect(focusMock).toHaveBeenCalledOnce()

    mock.server('server:terminal_output', { workspaceId: 'ws-other', sessionId: 'sess-1', terminalId: 'term-1', data: 'wrong' } satisfies ServerTerminalOutput)
    mock.server('server:terminal_output', { workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1', data: 'right' } satisfies ServerTerminalOutput)
    expect(writeMock).toHaveBeenCalledWith('right')
    expect(writeMock).not.toHaveBeenCalledWith('wrong')

    inputListeners.at(-1)?.('ls\r')
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:input', expect.objectContaining({ data: 'ls\r', terminalId: 'term-1' }))
    expect(mock.emit).toHaveBeenCalledWith('terminal:input', expect.objectContaining({ data: '\u0003', terminalId: 'term-1' }))

    fireEvent.click(screen.getByRole('button', { name: 'Clear terminal' }))
    expect(clearMock).toHaveBeenCalledOnce()
    unmount()
    expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:kill')).toHaveLength(0)
  })

  it('keeps control keys visible and sends touch arrows in xterm cursor mode without stealing focus', async () => {
    const mock = makeSocket()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    await screen.findByText('Running')
    const keys = screen.getByTestId('terminal-touch-keys')
    expect(keys.className).not.toContain('hidden')
    for (const [label, data] of [['Enter', '\r'], ['Ctrl+D', '\u0004'], ['Ctrl+Z', '\u001a'], ['Ctrl+B', '\u0002'], ['↑', '\u001b[A']]) {
      const button = screen.getByRole('button', { name: label })
      expect(fireEvent.pointerDown(button)).toBe(false)
      fireEvent.click(button)
      expect(mock.emit).toHaveBeenLastCalledWith('terminal:input', expect.objectContaining({ data }))
    }
    terminalModes.applicationCursorKeysMode = true
    for (const [label, data] of [['↑', '\u001bOA'], ['↓', '\u001bOB'], ['←', '\u001bOD'], ['→', '\u001bOC']]) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(mock.emit).toHaveBeenLastCalledWith('terminal:input', expect.objectContaining({ data }))
    }
    expect(focusMock).toHaveBeenCalled()
  })

  it('refits and resizes a preserved PTY when its tab becomes visible', async () => {
    const mock = makeSocket()
    const { rerender } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" visible={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByText('Running')
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:resize', expect.objectContaining({
      terminalId: 'term-1',
      cols: 100,
      rows: 12,
    })))

    fitCols = 148
    fitRows = 46
    rerender(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" visible />)

    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:resize', expect.objectContaining({
      terminalId: 'term-1',
      cols: 148,
      rows: 46,
    })))
    expect(screen.getByTestId('terminal-viewport').getAttribute('data-terminal-cols')).toBe('148')
    expect(screen.getByTestId('terminal-viewport').getAttribute('data-terminal-rows')).toBe('46')
    expect(fitMock).toHaveBeenCalled()
  })

  it('shows offline guidance and disables start', () => {
    const mock = makeSocket()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" online={false} />)
    expect(screen.getByText(/reconnect the workspace executor/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('accepts terminal creation after the socket hydrates', async () => {
    const mock = makeSocket()
    const { rerender } = render(<SessionTerminalPanel socket={null} workspaceId="ws-1" sessionId="sess-1" />)
    rerender(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    await screen.findByText('Running')
    expect(mock.emit).toHaveBeenCalledWith('terminal:create', expect.objectContaining({
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
    }), expect.any(Function))
  })

  it('shows the ambient connection line while terminal creation is pending', () => {
    const socket = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as DashboardSocket
    render(<SessionTerminalPanel socket={socket} workspaceId="ws-1" sessionId="sess-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(screen.getByTestId('session-terminal-panel').getAttribute('data-terminal-status')).toBe('starting')
    expect(screen.getByTestId('terminal-toolbar').querySelector('.ak-terminal-connecting')).toBeTruthy()
  })

  it('keeps an auto-started terminal alive by default when the modal unmounts', async () => {
    const mock = makeSocket()
    const { unmount } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" autoStart />)
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:create', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', cwd: '/repo' }), expect.any(Function)))
    await screen.findByText('Running')
    unmount()
    expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:kill')).toHaveLength(0)
  })

  it('kills the terminal on unmount when keep-running is disabled', async () => {
    const mock = makeSocket()
    const { unmount } = render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" autoStart />)
    await screen.findByText('Running')
    fireEvent.click(screen.getByTestId('terminal-keep-running'))
    expect(screen.getByTestId('terminal-keep-running').getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem('ak-terminal:keep-running:session:sess-1')).toBe('0')
    unmount()
    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('terminal:kill', expect.objectContaining({ terminalId: 'term-1' }), expect.any(Function)))
  })

  it('persists and applies independent terminal font controls', async () => {
    const mock = makeSocket()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" />)
    expect(terminalOptions?.fontSize).toBe(12)
    fireEvent.click(screen.getByTestId('terminal-font-increase'))
    expect(screen.getByTestId('terminal-font-size').textContent).toBe('13')
    await waitFor(() => expect(terminalOptions?.fontSize).toBe(13))
    expect(localStorage.getItem('ak-terminal:font-size:session:sess-1')).toBe('13')
    fireEvent.click(screen.getByTestId('terminal-font-size'))
    await waitFor(() => expect(terminalOptions?.fontSize).toBe(12))
  })

  it('kills explicitly and can restart with a new create request', async () => {
    const mock = makeSocket()
    render(<SessionTerminalPanel socket={mock.socket} workspaceId="ws-1" sessionId="sess-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByText('Running')
    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }))
    await waitFor(() => expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:create')).toHaveLength(2))
    expect(mock.emit.mock.calls.filter(([event]) => event === 'terminal:kill')).toHaveLength(1)
  })
})
