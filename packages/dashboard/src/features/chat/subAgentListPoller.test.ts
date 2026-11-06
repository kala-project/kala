import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubAgentListResult } from '@agent-kernel/shared'
import type { DashboardSocket } from '../../session.js'
import { subscribeSubAgentList } from './subAgentListPoller.js'

afterEach(() => vi.useRealTimers())

describe('shared parent sub-agent polling', () => {
  it('uses one bounded request per socket/parent for multiple history cards and retains UNKNOWN', () => {
    vi.useFakeTimers()
    const callbacks: Array<(result: SubAgentListResult) => void> = []
    const socket = { emit: vi.fn((_event: string, _request: unknown, ack: (result: SubAgentListResult) => void) => {
      callbacks.push(ack)
    }) } as unknown as DashboardSocket
    const first = vi.fn(), second = vi.fn()
    const unsubscribeFirst = subscribeSubAgentList(socket, 'parent', first)
    const unsubscribeSecond = subscribeSubAgentList(socket, 'parent', second)
    expect(socket.emit).toHaveBeenCalledTimes(1)
    const unknown: SubAgentListResult = {
      requestId: 'list', parentSessionId: 'parent',
      children: [{ childSessionId: 'child', parentCallId: 'call', status: 'running', commandState: 'unknown' }],
    }
    callbacks[0]!(unknown)
    expect(first).toHaveBeenLastCalledWith(unknown)
    expect(second).toHaveBeenLastCalledWith(unknown)
    vi.advanceTimersByTime(2_000)
    expect(socket.emit).toHaveBeenCalledTimes(2)
    unsubscribeFirst()
    callbacks[1]!({ ...unknown, children: [{ ...unknown.children[0]!, commandState: 'queued', pendingCommandCount: 1 }] })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    unsubscribeSecond()
    vi.advanceTimersByTime(10_000)
    expect(socket.emit).toHaveBeenCalledTimes(2)
  })

  it('ignores a late acknowledgement from a timed-out request or a removed subscriber', () => {
    vi.useFakeTimers()
    const callbacks: Array<(result: SubAgentListResult) => void> = []
    const socket = { emit: vi.fn((_event: string, _request: unknown, ack: (result: SubAgentListResult) => void) => {
      callbacks.push(ack)
    }) } as unknown as DashboardSocket
    const listener = vi.fn()
    const unsubscribe = subscribeSubAgentList(socket, 'parent', listener)
    vi.advanceTimersByTime(6_000)
    expect(socket.emit).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ error: 'Sub-agent status query timed out' }))
    const response: SubAgentListResult = { requestId: 'list', parentSessionId: 'parent', children: [] }
    callbacks[0]!(response)
    expect(listener).toHaveBeenCalledTimes(1)
    callbacks[1]!(response)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    callbacks[1]!(response)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
