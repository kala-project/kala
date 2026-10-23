import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalRequestManager, TERMINAL_CREATE_ACK_TIMEOUT_MS, TERMINAL_CREATE_CLIENT_TIMEOUT_MS } from './terminal-create.js'
import type { TerminalCreateResult } from './protocol.js'

const payload = { requestId: 'request', workspaceId: 'workspace', sessionId: 'session' }

function fixture() {
  const callbacks: Array<(result: TerminalCreateResult) => void> = []
  const dispose = vi.fn()
  const manager = createTerminalRequestManager({
    timeoutMs: TERMINAL_CREATE_ACK_TIMEOUT_MS,
    emit: (_payload, ack) => callbacks.push(ack),
    dispose,
  })
  return { manager, dispose, reply: (index: number, result: Partial<TerminalCreateResult> = {}) => callbacks[index]!({ ...payload, terminalId: 'terminal', ...result }) }
}

describe('terminal create deadlines and ownership', () => {
  afterEach(() => vi.useRealTimers())

  it('accepts native creation beyond five seconds and aligns the client after the Host deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const request = f.manager.request(payload)
    await vi.advanceTimersByTimeAsync(10_000)
    f.reply(0)
    await expect(request.result).resolves.toMatchObject({ terminalId: 'terminal' })
    request.accept()
    request.cancel()
    expect(f.dispose).not.toHaveBeenCalled()
    expect(TERMINAL_CREATE_CLIENT_TIMEOUT_MS).toBeGreaterThan(TERMINAL_CREATE_ACK_TIMEOUT_MS)
  })

  it('disposes a fresh terminal arriving after the bounded create deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const request = f.manager.request(payload)
    await vi.advanceTimersByTimeAsync(TERMINAL_CREATE_ACK_TIMEOUT_MS)
    await expect(request.result).resolves.toMatchObject({ error: 'terminal create acknowledgement timed out' })
    f.reply(0)
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it.each([false, true])('cleans cancelled creates whether ACK arrived before cancellation: %s', async (ackFirst) => {
    const f = fixture()
    const request = f.manager.request(payload)
    if (ackFirst) f.reply(0)
    request.cancel()
    if (!ackFirst) f.reply(0)
    await request.result
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('never disposes a reused terminal merely because its attaching UI was cancelled', async () => {
    const f = fixture()
    const request = f.manager.request(payload)
    request.cancel()
    f.reply(0, { reused: true })
    await request.result
    expect(f.dispose).not.toHaveBeenCalled()
  })

  it('does not kill a late fresh create claimed by a concurrently reopened panel', async () => {
    const f = fixture()
    const first = f.manager.request(payload)
    first.cancel()
    const reopened = f.manager.request({ ...payload, requestId: 'reopened' })
    f.reply(0)
    expect(f.dispose).not.toHaveBeenCalled()
    f.reply(1, { reused: true })
    await reopened.result
    reopened.accept()
    expect(f.dispose).not.toHaveBeenCalled()
  })

  it('cleans a deferred late create when every concurrent claimant cancels', async () => {
    const f = fixture()
    const first = f.manager.request(payload)
    const second = f.manager.request({ ...payload, requestId: 'second' })
    first.cancel()
    f.reply(0)
    expect(f.dispose).not.toHaveBeenCalled()
    second.cancel()
    f.reply(1, { reused: true })
    await Promise.all([first.result, second.result])
    expect(f.dispose).toHaveBeenCalledOnce()
  })
})
