import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { BgKillResult, BgListResult } from '@agent-kernel/shared'

import type { DashboardSocket } from '../../session.js'
import { BackgroundShellsButton } from './BackgroundTerminalPanel.js'

describe('BackgroundShellsButton', () => {
  it('labels live executor tasks as workspace shells', async () => {
    const socket = makeBgListSocket({
      requestId: 'ignored',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      tasks: [
        {
          taskId: 'task-live-1',
          sessionId: 'sess-1',
              command: 'pnpm dev -- --host 0.0.0.0',
              cwd: '/repo',
              pid: 4242,
              startedAt: '2026-07-07T00:00:00.000Z',
              status: 'running',
          exitCode: null,
          signal: null,
          bytesLogged: 0,
          bytesTruncated: 0,
        },
      ],
    })
    render(
      <BackgroundShellsButton
        socket={socket}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    const trigger = await screen.findByTestId('background-shells-trigger')
    expect(trigger.textContent).toBe('')
    expect(trigger.getAttribute('aria-label') ?? '').toContain('workspace background shell')
    expect(trigger.className).toContain('h-11')
    expect(trigger.className).toContain('w-10')

    fireEvent.click(trigger)
    expect(await screen.findByText('Workspace shells')).toBeTruthy()
    expect(screen.getByTestId('background-terminal-panel').className).toContain('w-[calc(100vw-1rem)]')
    expect(screen.getByTestId('background-terminal-layout').className).toContain('grid-rows-[auto_minmax(0,1fr)]')
    expect(screen.queryByTestId('bg-task-kill-task-live-1')).toBeNull()
    expect(screen.getAllByTestId('bg-task-kill-selected-task-live-1')).toHaveLength(1)
    expect(screen.getByText(/workspace live · task-live-1/i)).toBeTruthy()
    expect(screen.getByTestId('bg-task-command').textContent ?? '').toContain('pnpm dev -- --host 0.0.0.0')
    expect(screen.getByText('PID')).toBeTruthy()
    expect(screen.getByText('4242')).toBeTruthy()
    expect(screen.getAllByText('running').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('bg-task-kill-selected-task-live-1'))
    expect(socket.emitMock).toHaveBeenCalledWith(
      'bg:kill',
      expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', taskId: 'task-live-1' }),
      expect.any(Function),
    )
  })

  it('labels timeline-derived tasks as session replay shells', async () => {
    render(
      <BackgroundShellsButton
        socket={null}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[
          {
            taskId: 'task-replay-1',
            callId: 'call-1',
            command: 'sleep 20',
            status: 'running',
            output: '',
          },
        ]}
      />,
    )

    const trigger = screen.getByTestId('background-shells-trigger')
    expect(trigger.textContent).toBe('')
    expect(trigger.getAttribute('aria-label') ?? '').toContain('session replay background shell')

    fireEvent.click(trigger)
    expect(await screen.findByText('Session replay shells')).toBeTruthy()
    expect(screen.getByText(/session replay · task-replay-1/i)).toBeTruthy()
    expect(screen.getByTestId('bg-task-command').textContent ?? '').toContain('sleep 20')

    await waitFor(() => expect(screen.queryByTestId('bg-task-kill-task-replay-1')).toBeNull())
    expect(screen.queryByTestId('bg-task-kill-selected-task-replay-1')).toBeNull()
  })

  it('keeps the trigger for completed live tasks but counts zero running shells', async () => {
    render(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          tasks: [
            {
              taskId: 'task-killed-1',
              sessionId: 'sess-1',
              command: 'sleep 100',
              cwd: '/repo',
              pid: 4243,
              startedAt: '2026-07-07T00:00:00.000Z',
              endedAt: '2026-07-07T00:01:00.000Z',
              status: 'killed',
              exitCode: null,
              signal: 'SIGTERM',
              bytesLogged: 0,
              bytesTruncated: 0,
            },
          ],
        })}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    const trigger = await screen.findByTestId('background-shells-trigger')
    expect(trigger.textContent).toBe('')
    expect(trigger.getAttribute('aria-label') ?? '').toContain('0 running workspace background shells')

    fireEvent.click(trigger)
    expect(await screen.findByText('Workspace shells')).toBeTruthy()
    expect(screen.getByText(/workspace live · task-killed-1/i)).toBeTruthy()
    expect(screen.getAllByText('killed').length).toBeGreaterThan(0)
    expect(screen.getByText('4243')).toBeTruthy()
    expect(screen.queryByTestId('bg-task-kill-selected-task-killed-1')).toBeNull()
  })

  it('shows a zero workspace shell trigger when the live registry is empty', async () => {
    render(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          tasks: [],
        })}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    const trigger = await screen.findByTestId('background-shells-trigger')
    expect(trigger.textContent).toBe('')

    fireEvent.click(trigger)
    expect(await screen.findByText('Workspace shells')).toBeTruthy()
    expect(screen.getByTestId('bg-task-empty').textContent ?? '').toContain('No background shells')
  })

  it.each([
    { mode: 'control', auth: { clientId: 'dashboard' }, subscriptions: 2 },
    { mode: 'Session-bound', auth: { sessionId: 'sess-1' }, subscriptions: 1 },
  ])('waits only for authorized $mode subscriptions before listing shells', async ({ auth, subscriptions }) => {
    const socket = makeManagedBgListSocket({
      requestId: 'ignored',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      tasks: [],
    })
    socket.auth = auth
    render(
      <BackgroundShellsButton
        socket={socket}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    await waitFor(() => expect(socket.events.filter((event) => event === 'client:subscribe_channels')).toHaveLength(subscriptions))
    expect(socket.events).not.toContain('bg:list')
    socket.acknowledgeSubscriptions()

    await waitFor(() => expect(socket.events).toContain('bg:list'))
  })

  it('surfaces workspace operation errors in the shell panel', async () => {
    render(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          tasks: [],
          error: 'This workspace operation belongs to another session. Switch back to that session and reopen the panel.',
        })}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    fireEvent.click(await screen.findByTestId('background-shells-trigger'))

    expect(await screen.findByText(/belongs to another session/i)).toBeTruthy()
  })

  it('closes the shell panel when the session binding changes', async () => {
    const { rerender } = render(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          tasks: [],
        })}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    fireEvent.click(await screen.findByTestId('background-shells-trigger'))
    expect(await screen.findByText('Workspace shells')).toBeTruthy()

    rerender(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-2',
          tasks: [],
        })}
        workspaceId="ws-1"
        sessionId="sess-2"
        fallbackTasks={[]}
      />,
    )

    await waitFor(() => expect(screen.queryByText('Workspace shells')).toBeNull())
  })
})

function makeBgListSocket(result: BgListResult): DashboardSocket & { emitMock: ReturnType<typeof vi.fn> } {
  const socket = {
    emitMock: vi.fn(),
    on() {
      return this
    },
    off() {
      return this
    },
    emit(event: string, _payload: unknown, ack?: (result: BgListResult) => void) {
      this.emitMock(event, _payload, ack)
      if (event === 'bg:list') window.setTimeout(() => ack?.(result), 0)
      if (event === 'bg:kill') window.setTimeout(() => ack?.({ ..._payload, killed: true } as BgKillResult), 0)
      return this
    },
  }

  return socket as unknown as DashboardSocket & { emitMock: ReturnType<typeof vi.fn> }
}

function makeManagedBgListSocket(result: BgListResult): DashboardSocket & {
  events: string[]
  acknowledgeSubscriptions(): void
} {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const subscriptionAcks: Array<() => void> = []
  const socket = {
    io: {},
    connected: true,
    events: [] as string[],
    acknowledgeSubscriptions() {
      for (const acknowledge of subscriptionAcks.splice(0)) acknowledge()
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      const eventHandlers = handlers.get(event) ?? new Set()
      eventHandlers.add(handler)
      handlers.set(event, eventHandlers)
      return this
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
    emit(event: string, payload: any, ack?: (value: any) => void) {
      this.events.push(event)
      if (event === 'client:subscribe_channels') {
        subscriptionAcks.push(() => ack?.({
          requestId: payload.requestId,
          generation: payload.generation,
          accepted: payload.channels,
          rejected: [],
          cursors: {},
        }))
      }
      if (event === 'client:unsubscribe_channels') {
        ack?.({
          requestId: payload.requestId,
          generation: payload.generation,
          accepted: payload.channels,
          rejected: [],
          cursors: {},
        })
      }
      if (event === 'bg:list') ack?.(result)
      return this
    },
  }
  return socket as unknown as DashboardSocket & {
    events: string[]
    acknowledgeSubscriptions(): void
  }
}
