import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ScheduledTaskInbox } from './ScheduledTaskInbox.js'

const makeItem = (index: number, seen = false) => ({
  occurrenceId: `occ-${index}`,
  taskId: `task-${index}`,
  status: index % 3 === 0 ? 'failed' as const : index % 2 === 0 ? 'needs_review' as const : 'enqueued' as const,
  scheduledFor: `2026-10-04T${String(index).padStart(2, '0')}:00:00.000Z`,
  updatedAt: `2026-10-04T${String(index).padStart(2, '0')}:01:00.000Z`,
  seen,
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ScheduledTaskInbox', () => {
  it('does not acknowledge in the background and marks only rendered unseen rows after the popover opens', async () => {
    const items = Array.from({ length: 6 }, (_, index) => makeItem(index + 1))
    const seen = new Set<string>()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        const { occurrenceIds } = JSON.parse(String(init.body)) as { occurrenceIds: string[] }
        occurrenceIds.forEach((id) => seen.add(id))
        return new Response(JSON.stringify({ acknowledged: occurrenceIds, unreadCount: 6 - seen.size }), { status: 200 })
      }
      return new Response(JSON.stringify({ items: items.map((item) => ({ ...item, seen: seen.has(item.occurrenceId) })), unreadCount: 6 - seen.size }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenTask = vi.fn()
    render(<ScheduledTaskInbox host="https://runlab.example" token="secret" onOpenTask={onOpenTask} />)

    const trigger = await screen.findByRole('button', { name: 'Scheduled run inbox, 6 unread' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined()

    fireEvent.click(trigger)
    const popover = await screen.findByRole('dialog', { name: 'Scheduled runs' })
    expect(popover.querySelectorAll('button.group')).toHaveLength(5)
    expect(within(popover).getByText('1–5 / 6')).toBeTruthy()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const acknowledgement = fetchMock.mock.calls[1]!
    expect(acknowledgement[0]).toBe('https://runlab.example/api/v1/scheduled-tasks/inbox/seen')
    expect(JSON.parse(String(acknowledgement[1]?.body))).toEqual({ occurrenceIds: ['occ-1', 'occ-2', 'occ-3', 'occ-4', 'occ-5'] })
    expect(await screen.findByRole('button', { name: 'Scheduled run inbox, 1 unread' })).toBeTruthy()
    fireEvent.click(within(popover).getByRole('button', { name: 'Older' }))
    expect(popover.querySelectorAll('button.group')).toHaveLength(1)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ occurrenceIds: ['occ-6'] })
    expect(await screen.findByRole('button', { name: 'Scheduled run inbox, 0 unread' })).toBeTruthy()
    fireEvent.click(within(popover).getByRole('button', { name: 'Newer' }))

    const firstRun = within(popover).getAllByRole('button').find((button) => button.textContent?.includes('Queued'))
    expect(firstRun).toBeTruthy()
    fireEvent.click(firstRun!)
    expect(onOpenTask).toHaveBeenCalledWith('task-1')
    expect(screen.queryByRole('dialog', { name: 'Scheduled runs' })).toBeNull()
  })

  it('shows immutable task context, dispatch times and errors without claiming agent completion, and opens the known session', async () => {
    const item = {
      ...makeItem(1), taskLabel: 'Morning repository review',
      target: { kind: 'workspace', workspaceId: 'ws-1', workspaceName: 'Payments', cwd: '/repo' },
      claimedAt: '2026-10-04T01:00:02.000Z', sessionId: 'session-1',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST'
      ? { acknowledged: ['occ-1'], unreadCount: 0 }
      : { items: [item, { ...makeItem(3), error: 'Workspace Executor is offline.' }], unreadCount: 2 }), { status: 200 })))
    const onOpenSession = vi.fn()
    render(<ScheduledTaskInbox host="https://runlab.example" onOpenTask={() => {}} onOpenSession={onOpenSession} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Scheduled run inbox, 2 unread' }))
    expect(screen.getByText('Morning repository review')).toBeTruthy()
    expect(screen.getByText('Workspace: Payments')).toBeTruthy()
    expect(screen.getByText('/repo')).toBeTruthy()
    expect(screen.getByText(/Claimed for dispatch:/)).toBeTruthy()
    expect(screen.getAllByText(/Status updated:/)).toHaveLength(2)
    expect(screen.getByText('Message queued for the session. Completion and results are not tracked here.')).toBeTruthy()
    expect(screen.getByText('Workspace Executor is offline.')).toBeTruthy()
    expect(screen.queryByText('Run started')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }))
    expect(onOpenSession).toHaveBeenCalledWith('session-1')
  })

  it('polls every 30 seconds and aborts overlapping and unmounted requests without leaving timers', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    const view = render(<ScheduledTaskInbox host="https://runlab.example" onOpenTask={() => {}} />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstSignal = fetchMock.mock.calls[0]![1]?.signal

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)
    const secondSignal = fetchMock.mock.calls[1]![1]?.signal

    view.unmount()
    expect(secondSignal?.aborted).toBe(true)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards a stale response when the authenticated host changes', async () => {
    let resolveOld!: (response: Response) => void
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).startsWith('https://old.example')) return await oldResponse
      return new Response(JSON.stringify({ items: [makeItem(2)], unreadCount: 1 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const view = render(<ScheduledTaskInbox host="https://old.example" onOpenTask={() => {}} />)
    const oldSignal = fetchMock.mock.calls[0]![1]?.signal
    view.rerender(<ScheduledTaskInbox host="https://new.example" token="new-account" onOpenTask={() => {}} />)

    expect(oldSignal?.aborted).toBe(true)
    expect(await screen.findByRole('button', { name: 'Scheduled run inbox, 1 unread' })).toBeTruthy()
    resolveOld(new Response(JSON.stringify({ items: [makeItem(1)], unreadCount: 9 }), { status: 200 }))
    await act(async () => { await oldResponse })
    expect(screen.getByRole('button', { name: 'Scheduled run inbox, 1 unread' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Scheduled run inbox, 9 unread' })).toBeNull()
  })
})
