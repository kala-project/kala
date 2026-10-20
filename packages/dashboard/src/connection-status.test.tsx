import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionStatus, ConnectionStatusEntry, ConnectionStatusProvider } from './app.js'
import { SidebarBrand } from './app-shell/AppShellNav.js'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog.js'

function socketWithRtt(hostRttMs = 12, executorRttMs: number | null = 34) {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += hostRttMs
    return now
  })
  return {
    connected: true,
    timeout: vi.fn((_timeout: number) => ({
      emit: (event: string, _arg: unknown, callback: (...args: unknown[]) => void) => {
        if (event === 'client:connection_ping') callback(null)
        if (event === 'client:executor_ping') callback(null, { rttMs: executorRttMs ?? undefined })
      },
    })),
  }
}

function socketWithRttSeries(hostRtts: readonly number[], executorRtts: readonly number[]) {
  let performanceNow = 0
  let hostIndex = 0
  let executorIndex = 0
  vi.spyOn(performance, 'now').mockImplementation(() => performanceNow)
  return {
    connected: true,
    timeout: vi.fn(() => ({
      emit: (event: string, _arg: unknown, callback: (...args: unknown[]) => void) => {
        if (event === 'client:connection_ping') {
          const next = hostRtts[Math.min(hostIndex, hostRtts.length - 1)] ?? 0
          hostIndex += 1
          performanceNow += next
          callback(null)
        }
        if (event === 'client:executor_ping') {
          const next = executorRtts[Math.min(executorIndex, executorRtts.length - 1)] ?? 0
          executorIndex += 1
          callback(null, { rttMs: next })
        }
      },
    })),
  }
}

function timedOutSocket() {
  return {
    connected: true,
    timeout: vi.fn(() => ({
      emit: (_event: string, _arg: unknown, callback: (...args: unknown[]) => void) => callback(new Error('timeout')),
    })),
  }
}

describe('ConnectionStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows animated pending synchronization without confusing it with readiness', () => {
    render(<ConnectionStatus socket={socketWithRtt() as never} status="connecting" cursor={0} executorConnected={false} onResync={() => {}} />)
    const indicator = screen.getByTestId('connection-status')
    expect(indicator.getAttribute('data-status')).toBe('connecting')
    expect(indicator.textContent).toContain('Connecting')
    expect(indicator.querySelector('.bg-amber-500')).not.toBeNull()
    expect(indicator.querySelector('.ak-status-pulse')).toBeTruthy()
  })

  it('keeps transport on one visible row and moves the explanation to a help icon', () => {
    render(<ConnectionStatus socket={socketWithRtt() as never} status="ready" transport="websocket" cursor={9} executorConnected={false} onResync={() => {}} />)
    fireEvent.click(screen.getByTestId('connection-status'))
    const popover = screen.getByTestId('connection-status-popover')
    expect(popover.querySelector('details')).toBeNull()
    expect(within(popover).queryByText('Diagnostics')).toBeNull()
    expect(within(popover).queryByText('Reachability and round-trip latency')).toBeNull()
    expect(screen.queryByText('Reachability and round-trip latency')).toBeNull()
    fireEvent.click(screen.getByTestId('connection-health-help'))
    expect(screen.getByRole('tooltip').textContent).toBe('Reachability and round-trip latency')
    const row = within(screen.getByTestId('connection-transport-row'))
    expect(row.getByText('Transport · websocket')).toBeTruthy()
    expect(row.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it.each([true, false])('measures only the host for Chats regardless of executor presence (%s)', async (executorConnected) => {
    const socket = socketWithRtt()
    const clipboard = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    render(<ConnectionStatus socket={socket as never} status="ready" cursor={9} executorConnected={executorConnected} onResync={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('12 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('ready')
    expect(screen.getByText('Healthy')).toBeTruthy()
    expect(screen.queryByTestId('connection-segment-service-executor')).toBeNull()
    expect(screen.queryByTestId('connection-health-executor-line')).toBeNull()
    expect(screen.queryByText('Executor')).toBeNull()
    expect(screen.getAllByTestId('connection-health-host-marker').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByTestId('connection-health-executor-marker')).toBeNull()
    expect(screen.getAllByTestId('connection-health-sample-hit')[0]?.getAttribute('aria-label')).not.toContain('Executor')
    expect(socket.timeout.mock.calls.every(([timeout]) => timeout === 3000)).toBe(true)
    fireEvent.click(screen.getByText('Copy'))
    expect(JSON.parse(clipboard.mock.calls[0]![0])).not.toHaveProperty('executorPresence')
  })

  it('renders a dot-only compact trigger for collapsed topbar', async () => {
    render(<ConnectionStatus socket={socketWithRtt() as never} status="ready" cursor={9} executorConnected={false} onResync={() => {}} compact />)

    const indicator = screen.getByTestId('connection-status')
    expect(indicator.getAttribute('data-compact')).toBe('true')
    expect(indicator.textContent).toBe('')
    expect(indicator.querySelector('.bg-emerald-500')).not.toBeNull()
    await waitFor(() => expect(indicator.getAttribute('title')).toBe('Connected · 12 ms'))
    expect(screen.queryByTestId('connection-headline-latency')).toBeNull()
    fireEvent.click(indicator)
    expect(screen.getByTestId('connection-status-popover')).toBeTruthy()
  })

  it('softens single host probe failures while keeping session synchronization errors visible for Chats', () => {
    const view = render(<ConnectionStatus socket={timedOutSocket() as never} status="ready" cursor={0} executorConnected onResync={() => {}} />)
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('ready')
    view.rerender(<ConnectionStatus socket={socketWithRtt() as never} status="error" cursor={0} executorConnected onResync={() => {}} />)
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('error')
    view.rerender(<ConnectionStatus socket={null} status="disconnected" cursor={0} executorConnected onResync={() => {}} />)
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('disconnected')
  })

  it('discards pending workspace probes and history when switching to host-only Chat', () => {
    const pending: Array<(...args: unknown[]) => void> = []
    const socket = {
      connected: true,
      timeout: () => ({ emit: (_event: string, _arg: unknown, callback: (...args: unknown[]) => void) => pending.push(callback) }),
    }
    const view = render(<ConnectionStatus socket={socket as never} workspaceId="w1" status="ready" cursor={0} executorConnected onResync={() => {}} />)
    const oldProbes = pending.splice(0)
    view.rerender(<ConnectionStatus socket={socket as never} status="ready" cursor={0} executorConnected onResync={() => {}} />)
    act(() => pending.splice(0).forEach((callback) => callback(null)))
    act(() => oldProbes.forEach((callback) => callback(new Error('stale timeout'))))
    fireEvent.click(screen.getByTestId('connection-status'))
    act(() => pending.splice(0).forEach((callback) => callback(null)))
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('ready')
    expect(screen.getAllByTestId('connection-health-host-marker').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByTestId('connection-health-executor-marker')).toBeNull()
    expect(screen.queryByTestId('connection-segment-service-executor')).toBeNull()
  })

  it('presents the complete Device to Service to Executor RTT as the headline', async () => {
    const socket = socketWithRtt()
    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('46 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    const path = within(screen.getByTestId('connection-path'))
    expect(screen.getByTestId('connection-segment-device-service').getAttribute('title')).toContain('Device → Service')
    expect(screen.getByTestId('connection-segment-service-executor').getAttribute('title')).toContain('Service → Executor')
    expect(path.getByText('Device')).toBeTruthy()
    expect(path.getByText('Service')).toBeTruthy()
    expect(path.getByText('Executor')).toBeTruthy()
    expect(screen.getByText('12 ms')).toBeTruthy()
    expect(screen.getByText('34 ms')).toBeTruthy()
    expect(screen.queryByText(/cursor/i)).toBeNull()
  })

  it('does not present a partial segment as complete latency while Executor measurement is unavailable', async () => {
    const socket = socketWithRtt(12, null)
    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('—'))
  })

  it('distinguishes offline from an unknown or timed-out latency', () => {
    render(<ConnectionStatus socket={null} status="disconnected" cursor={0} workspaceId="w1" executorConnected={false} onResync={() => {}} />)

    expect(screen.getByTestId('connection-headline-latency').textContent).toBe('—')
    fireEvent.click(screen.getByTestId('connection-status'))
    expect(screen.getByText('Offline')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Measure again' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not call a real workspace healthy when its executor is offline', () => {
    render(<ConnectionStatus socket={socketWithRtt() as never} status="ready" cursor={0} workspaceId="w1" executorConnected={false} onResync={() => {}} />)
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('error')
    expect(screen.getByTestId('connection-status').querySelector('.bg-rose-500')).not.toBeNull()
    fireEvent.click(screen.getByTestId('connection-status'))
    expect(screen.getByTestId('connection-segment-service-executor').getAttribute('title')).toContain('Offline')
    expect(screen.queryByText('Healthy')).toBeNull()
    expect(screen.getAllByText('Connection issue').length).toBeGreaterThanOrEqual(1)
  })

  it.each([
    ['ready', 'border-emerald-500'],
    ['connecting', 'border-amber-500'],
    ['disconnected', 'border-rose-500'],
  ])('maps %s to the same semantic brand-ring color', (status, ringClass) => {
    const socket = status === 'disconnected' ? null : socketWithRtt()
    render(
      <ConnectionStatusProvider socket={socket as never} status={status} cursor={0} executorConnected={false} onResync={() => {}}>
        <SidebarBrand connectionStatus={<ConnectionStatusEntry appearance="brand" triggerId="desktop-sidebar" />} />
      </ConnectionStatusProvider>,
    )

    const trigger = screen.getByTestId('sidebar-connection-status')
    expect(trigger.getAttribute('data-status')).toBe(status)
    const ring = screen.getByTestId('sidebar-connection-status-ring')
    expect(ring.classList.contains(ringClass)).toBe(true)
    expect(ring.className).toContain('relative')
    expect(ring.querySelector('span')?.className).toContain('absolute inset-0 grid place-items-center')
    expect(ring.querySelector('img')?.getAttribute('style')).toBeNull()
  })

  it('shares one probe, title, and details popover across desktop sidebar and mobile drawer entries', async () => {
    const socket = socketWithRtt()
    render(
      <ConnectionStatusProvider socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected={false} onResync={() => {}}>
        <ConnectionStatusEntry triggerId="topbar" />
        <div data-testid="desktop-sidebar"><SidebarBrand connectionStatus={<ConnectionStatusEntry appearance="brand" triggerId="desktop-sidebar" />} /></div>
        <div data-testid="mobile-drawer"><SidebarBrand connectionStatus={<ConnectionStatusEntry appearance="brand" triggerId="mobile-drawer" />} /></div>
      </ConnectionStatusProvider>,
    )

    const ordinary = screen.getByTestId('connection-status')
    const desktop = within(screen.getByTestId('desktop-sidebar')).getByTestId('sidebar-connection-status')
    const mobile = within(screen.getByTestId('mobile-drawer')).getByTestId('sidebar-connection-status')
    await waitFor(() => expect(socket.timeout).toHaveBeenCalledTimes(1))
    fireEvent.focus(window)
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(socket.timeout).toHaveBeenCalledTimes(2))
    expect(ordinary.getAttribute('data-status')).toBe('error')
    expect(desktop.getAttribute('data-status')).toBe('error')
    expect(mobile.getAttribute('data-status')).toBe('error')
    expect(desktop.getAttribute('title')).toBe(ordinary.getAttribute('title'))
    expect(mobile.getAttribute('title')).toBe(ordinary.getAttribute('title'))
    fireEvent.mouseEnter(desktop)
    expect(desktop.getAttribute('title')).toContain('Connection issue')

    fireEvent.click(desktop)
    let popover = screen.getByTestId('connection-status-popover')
    expect(within(popover).getByText('Connection health')).toBeTruthy()
    expect(popover.parentElement).toBe(document.body)
    expect(screen.getByTestId('desktop-sidebar').contains(popover)).toBe(false)
    expect(popover.className).toContain('safe-area-inset-left')
    fireEvent.click(desktop)
    fireEvent.click(mobile)
    popover = screen.getByTestId('connection-status-popover')
    expect(within(popover).getByText('Connection health')).toBeTruthy()
    expect(popover.className).toContain('sm:w-[22.5rem]')
    expect(screen.getAllByTestId('connection-status-popover')).toHaveLength(1)
  })

  it('keeps mobile drawer health controls inside the modal pointer-event and focus boundary', () => {
    const onResync = vi.fn()
    render(
      <ConnectionStatusProvider socket={socketWithRtt() as never} status="ready" cursor={0} executorConnected={false} onResync={onResync}>
        <Dialog open>
          <DialogContent data-testid="explorer-drawer">
            <DialogTitle>Sessions</DialogTitle>
            <DialogDescription>Choose a session</DialogDescription>
            <SidebarBrand connectionStatus={<ConnectionStatusEntry appearance="brand" triggerId="mobile-drawer" />} />
            <button type="button" data-testid="session-behind-health">A session</button>
          </DialogContent>
        </Dialog>
      </ConnectionStatusProvider>,
    )
    fireEvent.click(screen.getByTestId('sidebar-connection-status'))
    const popover = screen.getByTestId('connection-status-popover')
    const drawer = screen.getByTestId('explorer-drawer')
    expect(popover.parentElement).toBe(drawer)
    expect(within(popover).getByRole('button', { name: 'Resync' })).toBeTruthy()
    fireEvent.click(within(popover).getByRole('button', { name: 'Resync' }))
    expect(onResync).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('session-behind-health')).toBeTruthy()
  })

  it('keeps an unselected sidebar brand free of a replacement status entry', () => {
    render(<SidebarBrand />)
    expect(screen.queryByTestId('sidebar-connection-status')).toBeNull()
  })

  it('marks the overall connection as failed after repeated latency probe timeouts', async () => {
    render(<ConnectionStatus socket={timedOutSocket() as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('ready'))
    fireEvent.click(screen.getByTestId('connection-status'))
    expect(screen.queryByText('Connection issue')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('error'))
    expect(screen.getAllByText('Connection issue').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('connection-headline-latency').textContent).toBe('—')

    expect(screen.getByTestId('connection-segment-device-service').getAttribute('title')).toContain('Timed out')
    expect(screen.getByTestId('connection-segment-service-executor').getAttribute('title')).toContain('Timed out')
    expect(screen.getAllByText('Connection issue').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps a rolling 10 minute curve instead of only the latest measurement', async () => {
    let wallClock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRtt(10, 20)

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('30 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    const initialSampleCount = await waitFor(() => {
      const count = Number(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count'))
      expect(count).toBeGreaterThanOrEqual(1)
      return count
    })
    expect(screen.getByText('Last 10 minutes')).toBeTruthy()

    wallClock = 9 * 60 * 1000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(Number(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count'))).toBe(initialSampleCount + 1))

    wallClock = 20 * 60 * 1000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count')).toBe('1'))
  })

  it('plots host and executor latency against the same millisecond axis', async () => {
    let wallClock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRttSeries([100, 200, 300], [1000, 2000, 3000])

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('1100 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    const initialSampleCount = await waitFor(() => {
      const count = Number(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count'))
      expect(count).toBeGreaterThanOrEqual(1)
      return count
    })

    wallClock = 30_000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))
    await waitFor(() => expect(Number(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count'))).toBe(initialSampleCount + 1))

    expect(screen.getByTestId('connection-health-host-line').getAttribute('points')).not.toBe(screen.getByTestId('connection-health-executor-line').getAttribute('points'))
    expect(screen.getByTestId('connection-health-chart').textContent).toContain('2000')
    expect(screen.getByTestId('connection-health-chart').textContent).toContain('ms')
    const hits = screen.getAllByTestId('connection-health-sample-hit')
    expect(hits).toHaveLength(2)
    const firstRight = Number(hits[0]!.getAttribute('x')) + Number(hits[0]!.getAttribute('width'))
    expect(firstRight).toBeCloseTo(Number(hits[1]!.getAttribute('x')))
    fireEvent.mouseEnter(hits[0]!)
    expect(screen.getByRole('tooltip').textContent).toContain('Host: 100 ms')
    fireEvent.mouseEnter(hits[1]!)
    expect(screen.getByRole('tooltip').textContent).toContain('Host: 200 ms')
  })

  it('uses the full chart width before the 10 minute window is full', async () => {
    let wallClock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRttSeries([100, 200], [1000, 2000])

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('1100 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))
    wallClock = 30_000
    fireEvent.click(screen.getByRole('button', { name: 'Measure again' }))

    await waitFor(() => expect(screen.getByTestId('connection-health-host-line').getAttribute('points')).toContain('312.0,'))
  })

  it('exposes per-sample hover details with time and latency', async () => {
    let wallClock = Date.UTC(2026, 8, 6, 16, 25, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    const socket = socketWithRtt(89, 85)

    render(<ConnectionStatus socket={socket as never} status="ready" transport="websocket" cursor={9} workspaceId="w1" executorConnected onResync={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('connection-headline-latency').textContent).toBe('174 ms'))
    fireEvent.click(screen.getByTestId('connection-status'))

    const hit = await waitFor(() => {
      const hits = screen.getAllByTestId('connection-health-sample-hit')
      const match = hits.find((node) => node.getAttribute('aria-label')?.includes('Host: 89 ms') && node.getAttribute('aria-label')?.includes('Executor: 85 ms'))
      expect(match).toBeTruthy()
      return match!
    })

    const sampleCount = Number(screen.getByTestId('connection-health-curve').getAttribute('data-sample-count'))
    expect(screen.getAllByTestId('connection-health-host-marker')).toHaveLength(sampleCount)
    expect(screen.getAllByTestId('connection-health-executor-marker')).toHaveLength(sampleCount)
    expect(hit.getAttribute('aria-label')).toContain('2026')

    fireEvent.mouseEnter(hit)
    expect(screen.getByRole('tooltip').textContent).toContain('Host: 89 ms')
    expect(screen.getByRole('tooltip').textContent).toContain('Executor: 85 ms')
    fireEvent.mouseLeave(hit)

    fireEvent.focus(hit)
    expect(screen.getByRole('tooltip').textContent).toContain('2026')
    expect(hit.getAttribute('aria-describedby')).toBe('connection-health-tooltip')
    fireEvent.blur(hit)

    fireEvent.touchStart(hit)
    expect(screen.getByRole('tooltip').textContent).toContain('Host: 89 ms')
  })

  it('shows a labeled empty chart while the first measurement is pending', () => {
    const socket = {
      connected: true,
      timeout: vi.fn(() => ({ emit: vi.fn() })),
    }

    render(<ConnectionStatus socket={socket as never} status="ready" cursor={0} executorConnected={false} onResync={() => {}} />)
    fireEvent.click(screen.getByTestId('connection-status'))

    expect(screen.getByTestId('connection-health-empty').textContent).toBe('Waiting for the first measurement…')
    expect(screen.getByRole('group', { name: 'Last 10 minutes connection health chart' })).toBeTruthy()
    expect(screen.queryByTestId('connection-health-sample-hit')).toBeNull()
  })
})
