import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { io } from 'socket.io-client'
import type { ComputerResponse } from '@agent-kernel/shared'
import type { WorkspaceSocket } from '../../lib/workspace-exec.js'
import { ComputerPanel } from './ComputerPanel.js'
import { requestComputer } from './computer-client.js'

vi.mock('./computer-client.js', () => ({ requestComputer: vi.fn() }))
const mocked = vi.mocked(requestComputer)
const leaseId = '00000000-0000-4000-8000-000000000001'
const socket: WorkspaceSocket = io('http://127.0.0.1:1/dashboard', { autoConnect: false })
const props = { socket, workspaceId: 'workspace', sessionId: 'session', visible: true }
const image = { mimeType: 'image/png' as const, base64: 'AA==', width: 1280, height: 800, originX: -1280, originY: 0 }

describe('ComputerPanel', () => {
  beforeEach(() => {
    let active = false
    let allowAgent = false
    mocked.mockImplementation(async (_socket, request): Promise<ComputerResponse> => {
      if (request.operation === 'start') { active = true; allowAgent = request.allowAgent }
      if (request.operation === 'stop') active = false
      if (request.operation === 'input') allowAgent = false
      if (request.operation === 'agent') allowAgent = request.allowAgent
      const status = { available: true, platform: 'linux', active, allowAgent }
      if (request.operation === 'capture') return { requestId: request.requestId, screenshot: image }
      return { requestId: request.requestId, status, ...(request.operation === 'start' ? { leaseId } : {}) }
    })
  })
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); socket.disconnect() })

  const operations = () => mocked.mock.calls.map(([, request]) => request)
  const begin = async () => {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share desktop' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Share desktop' }))
    await screen.findByAltText('Executor desktop screenshot')
  }

  it('does not capture or grant access without explicit consent, even when the panel is visible', async () => {
    render(<ComputerPanel {...props} />)
    await waitFor(() => expect(operations()).toHaveLength(1))
    expect(operations()[0]?.operation).toBe('status')
    expect(screen.getByRole('button', { name: 'Share desktop' }).hasAttribute('disabled')).toBe(true)
    expect(operations().some((request) => request.operation === 'start')).toBe(false)
  })

  it('sends Enter and Escape to the real desktop, and Unicode through the IME-safe text field', async () => {
    render(<ComputerPanel {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    const region = screen.getByRole('group', { name: 'Remote desktop input' })
    fireEvent.keyDown(region, { key: 'Enter' })
    fireEvent.keyDown(region, { key: 'Escape' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Text to type on the remote desktop' }), { target: { value: '中文\nhello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Type text remotely' }))
    await waitFor(() => expect(operations().filter((request) => request.operation === 'input')).toHaveLength(3))
    expect(operations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'input', leaseId, action: { type: 'key', key: 'Enter' } }),
      expect.objectContaining({ operation: 'input', leaseId, action: { type: 'key', key: 'Escape' } }),
      expect.objectContaining({ operation: 'input', leaseId, action: { type: 'type', text: '中文\nhello' } }),
    ]))
  })

  it('stops sharing and clears the screenshot when its tab becomes hidden', async () => {
    const view = render(<ComputerPanel {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    view.rerender(<ComputerPanel {...props} visible={false} />)
    await waitFor(() => expect(operations().some((request) => request.operation === 'stop' && request.leaseId === leaseId)).toBe(true))
    expect(screen.queryByAltText('Executor desktop screenshot')).toBeNull()
  })

  it('expands in an accessible modal and forwards Escape without dismissing it or stopping sharing', async () => {
    render(<ComputerPanel {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    fireEvent.click(screen.getByRole('button', { name: 'Expand desktop' }))
    const dialog = await screen.findByRole('dialog')
    const input = screen.getByRole('group', { name: 'Remote desktop input' })
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
    await waitFor(() => expect(operations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'input', action: { type: 'key', key: 'Escape' } }),
    ])))
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Expand desktop' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByAltText('Executor desktop screenshot')).toBeTruthy()
    expect(operations().some((request) => request.operation === 'stop')).toBe(false)
  })

  it('surfaces unavailable native desktops and keeps sharing disabled', async () => {
    mocked.mockImplementation(async (_socket, request) => ({ requestId: request.requestId, status: { available: false, platform: 'win32', reason: 'Windows Session 0 requires a desktop companion', active: false, allowAgent: false } }))
    render(<ComputerPanel {...props} />)
    expect(await screen.findByText(/Session 0 requires/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    expect(screen.getByRole('button', { name: 'Share desktop' }).hasAttribute('disabled')).toBe(true)
  })

  it('revokes sharing when the browser page is backgrounded', async () => {
    render(<ComputerPanel {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(screen.queryByAltText('Executor desktop screenshot')).toBeNull())
    expect(operations()).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'stop', leaseId })]))
  })

  it('preserves the next draft while an earlier Unicode input is in flight', async () => {
    const original = mocked.getMockImplementation()!
    let complete: (() => void) | undefined
    mocked.mockImplementation((socket, request) => request.operation === 'input'
      ? new Promise((resolve) => { complete = () => resolve({ requestId: request.requestId, status: { available: true, platform: 'linux', active: true, allowAgent: false } }) })
      : original(socket, request))
    render(<ComputerPanel {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text to type on the remote desktop' })
    fireEvent.change(field, { target: { value: '中文😀' } })
    fireEvent.click(screen.getByRole('button', { name: 'Type text remotely' }))
    expect(screen.getByRole('button', { name: 'Type text remotely' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(field, { target: { value: 'next draft' } })
    await act(async () => { complete!() })
    expect(field.value).toBe('next draft')
    expect(screen.getByRole('button', { name: 'Type text remotely' }).hasAttribute('disabled')).toBe(false)
  })

  it('ignores an old heartbeat failure after switching sessions and authorizing a new lease', async () => {
    const intervals = vi.spyOn(window, 'setInterval')
    const original = mocked.getMockImplementation()!
    let rejectRenew: ((error: Error) => void) | undefined
    mocked.mockImplementation((socket, request) => request.operation === 'renew'
      ? new Promise((_resolve, reject) => { rejectRenew = reject })
      : original(socket, request))
    const view = render(<ComputerPanel {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0]
    if (typeof heartbeat !== 'function') throw new Error('Heartbeat was not installed')
    heartbeat()
    view.rerender(<ComputerPanel {...props} sessionId="new-session" />)
    await screen.findByRole('button', { name: 'Share desktop' })
    fireEvent.click(screen.getByRole('checkbox', { name: /I authorize sharing/ }))
    await begin()
    const stopped = operations().filter((request) => request.operation === 'stop').length
    await act(async () => { rejectRenew!(new Error('Old connection expired')) })
    expect(screen.getByAltText('Executor desktop screenshot')).toBeTruthy()
    expect(operations().filter((request) => request.operation === 'stop')).toHaveLength(stopped)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
