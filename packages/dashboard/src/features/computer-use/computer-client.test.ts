import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { io } from 'socket.io-client'
import type { ComputerResponse } from '@agent-kernel/shared'
import type { WorkspaceSocket } from '../../lib/workspace-exec.js'
import { requestComputer } from './computer-client.js'

const release = vi.fn()
const manager = { acquire: vi.fn(() => release), waitUntilActive: vi.fn(async () => {}) }
vi.mock('../../session.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../session.js')>(),
  dashboardConnectionManager: () => manager,
}))

describe('desktop request client', () => {
  let socket: WorkspaceSocket
  const request = { requestId: 'request', workspaceId: 'workspace', sessionId: 'session', operation: 'status' } as const
  const response: ComputerResponse = { requestId: 'request', status: { available: true, platform: 'linux', active: false, allowAgent: false } }

  beforeEach(() => {
    vi.clearAllMocks()
    socket = io('http://127.0.0.1:1/dashboard', { autoConnect: false })
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); socket.disconnect() })

  const reply = async (value: unknown) => {
    const emit = vi.spyOn(socket, 'emit').mockReturnValue(socket)
    const pending = requestComputer(socket, request)
    await vi.waitFor(() => expect(emit).toHaveBeenCalled())
    const callback = emit.mock.calls[0]?.at(-1)
    if (typeof callback !== 'function') throw new Error('Desktop request did not include an acknowledgement callback')
    callback(value)
    return pending
  }

  it('keeps a Session-bound desktop request inside its Session channel', async () => {
    socket.auth = { sessionId: 'session' }
    expect(await reply(response)).toEqual(response)
    expect(manager.acquire.mock.calls).toEqual([['session:session']])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('waits for both channels and releases them after a correlated response', async () => {
    expect(await reply(response)).toEqual(response)
    expect(manager.acquire.mock.calls).toEqual([['session:session'], ['workspace:workspace']])
    expect(manager.waitUntilActive.mock.calls).toEqual([['session:session', 2_000], ['workspace:workspace', 2_000]])
    expect(release).toHaveBeenCalledTimes(2)
  })

  it.each([
    { requestId: 'another-request', status: response.status },
    { requestId: 'request' },
    { requestId: 'request', status: { available: 'yes' } },
  ])('rejects mismatched or invalid acknowledgement %#', async (value) => {
    expect((await reply(value)).error?.code).toBe('execution_error')
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('preserves an explicit Host error', async () => {
    const error: ComputerResponse = { requestId: 'request', error: { code: 'denied', message: 'Desktop access requires runtime:write' } }
    expect(await reply(error)).toEqual(error)
  })

  it('reports subscription failures and still releases both channels', async () => {
    manager.waitUntilActive.mockRejectedValueOnce(new Error('Channel subscription denied'))
    const emit = vi.spyOn(socket, 'emit')
    expect((await requestComputer(socket, request)).error?.message).toBe('Channel subscription denied')
    expect(emit).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('times out without retaining channel subscriptions', async () => {
    vi.useFakeTimers()
    vi.spyOn(socket, 'emit').mockReturnValue(socket)
    const pending = requestComputer(socket, request)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await pending).error?.code).toBe('unavailable')
    expect(release).toHaveBeenCalledTimes(2)
  })
})
