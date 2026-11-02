import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ScheduledTaskInbox } from './ScheduledTaskInbox.js'
import type { DashboardSocket } from '../../session.js'

function inboxSocket(connected = true) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    connected,
    on(event: string, callback: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(callback)
    },
    off(event: string, callback: () => void) { listeners.get(event)?.delete(callback) },
    receive(event: string) { for (const listener of listeners.get(event) ?? []) listener() },
    asSocket() { return this as unknown as DashboardSocket },
  }
}

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

  it('shows conversation names and only the updated time without claiming agent completion', async () => {
    const item = {
      ...makeItem(1), taskLabel: 'Morning repository review',
      target: { kind: 'workspace', workspaceId: 'ws-1', workspaceName: 'Payments', cwd: '/repo' },
      claimedAt: '2026-10-04T01:00:02.000Z', sessionId: 'session-1',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST'
      ? { acknowledged: ['occ-1'], unreadCount: 0 }
      : { items: [item, { ...makeItem(3), target: { kind: 'session', sessionId: 'session-2' }, error: 'Workspace Executor is offline.' }], unreadCount: 2 }), { status: 200 })))
    const onOpenSession = vi.fn()
    render(<ScheduledTaskInbox host="https://runlab.example" onOpenTask={() => {}} onOpenSession={onOpenSession} sessionNames={new Map([['session-1', 'Payments review'], ['session-2', 'Release checklist']])} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Scheduled run inbox, 2 unread' }))
    expect(screen.getByText('Morning repository review')).toBeTruthy()
    expect(screen.getByText('Workspace: Payments')).toBeTruthy()
    expect(screen.getByText('/repo')).toBeTruthy()
    expect(screen.getByText('Session: Payments review')).toBeTruthy()
    expect(screen.getByText('Session: Release checklist')).toBeTruthy()
    expect(screen.queryByText(/session-[12]/)).toBeNull()
    expect(screen.queryByText(/Claimed for dispatch:/)).toBeNull()
    expect(screen.queryByText(/Scheduled:/)).toBeNull()
    expect(screen.getAllByText(/Updated:/)).toHaveLength(2)
    expect(screen.getAllByText(/Updated:/)[0]?.getAttribute('datetime')).toBe(item.updatedAt)
    expect(screen.getByText('Message queued for the session. Completion and results are not tracked here.')).toBeTruthy()
    expect(screen.getByText('Workspace Executor is offline.')).toBeTruthy()
    expect(screen.queryByText('Run started')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }))
    expect(onOpenSession).toHaveBeenCalledWith('session-1')
  })

  it('never polls a closed or hidden bell and refreshes only on Inbox invalidation, cancelling older requests', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    const socket = inboxSocket()
    const view = render(<ScheduledTaskInbox host="https://runlab.example" socket={socket.asSocket()} onOpenTask={() => {}} />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstSignal = fetchMock.mock.calls[0]![1]?.signal

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(5 * 60_000); socket.receive('event:appended') })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { socket.receive('server:scheduled_inbox_changed') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)
    const secondSignal = fetchMock.mock.calls[1]![1]?.signal

    view.unmount()
    expect(secondSignal?.aborted).toBe(true)
    act(() => { vi.advanceTimersByTime(60_000); socket.receive('server:scheduled_inbox_changed') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('updates unread items while closed and rehydrates on reconnect without waiting for the popover', async () => {
    const socket = inboxSocket(false)
    let items: ReturnType<typeof makeItem>[] = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ items, unreadCount: items.length }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ScheduledTaskInbox host="https://runlab.example" socket={socket.asSocket()} onOpenTask={() => {}} />)
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => { socket.connected = true; socket.receive('connect') })
    await screen.findByRole('button', { name: 'Scheduled run inbox, 0 unread' })
    items = [makeItem(1)]
    act(() => { socket.receive('server:scheduled_inbox_changed') })
    await screen.findByRole('button', { name: 'Scheduled run inbox, 1 unread' })
    expect(screen.queryByRole('dialog')).toBeNull()
    items = [makeItem(1), makeItem(2)]
    act(() => { socket.receive('connect') })
    await screen.findByRole('button', { name: 'Scheduled run inbox, 2 unread' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects a superseded same-identity HTTP snapshot after an actual Inbox change', async () => {
    const socket = inboxSocket()
    let resolveOld!: (response: Response) => void
    const old = new Promise<Response>((resolve) => { resolveOld = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementationOnce(() => old)
      .mockResolvedValue(new Response(JSON.stringify({ items: [makeItem(2)], unreadCount: 1 }), { status: 200 })))
    render(<ScheduledTaskInbox host="https://runlab.example" socket={socket.asSocket()} onOpenTask={() => {}} />)
    act(() => { socket.receive('server:scheduled_inbox_changed') })
    await screen.findByRole('button', { name: 'Scheduled run inbox, 1 unread' })
    await act(async () => { resolveOld(new Response(JSON.stringify({ items: [], unreadCount: 0 }), { status: 200 })); await old })
    expect(screen.getByRole('button', { name: 'Scheduled run inbox, 1 unread' })).toBeTruthy()
  })

  it('does not let an older acknowledgement erase unread items received since that acknowledgement', async () => {
    const socket = inboxSocket()
    let items = [makeItem(1)]
    let resolveSeen!: (response: Response) => void
    const seen = new Promise<Response>((resolve) => { resolveSeen = resolve })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return await seen
      return new Response(JSON.stringify({ items, unreadCount: items.filter((item) => !item.seen).length }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ScheduledTaskInbox host="https://runlab.example" socket={socket.asSocket()} onOpenTask={() => {}} />)
    const trigger = await screen.findByRole('button', { name: 'Scheduled run inbox, 1 unread' })
    fireEvent.click(trigger)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    fireEvent.click(trigger)
    items = [makeItem(2), makeItem(1, true)]
    act(() => { socket.receive('server:scheduled_inbox_changed') })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await act(async () => { resolveSeen(new Response(JSON.stringify({ acknowledged: ['occ-1'], unreadCount: 0 }), { status: 200 })); await seen })
    expect(screen.getByRole('button', { name: 'Scheduled run inbox, 1 unread' })).toBeTruthy()
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
