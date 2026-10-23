import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_SCREENSHOT_KIND, type ComputerRequest, type ComputerObservation } from '@agent-kernel/shared'
import { ComputerUseManager, COMPUTER_LEASE_MS } from './manager.js'

const screenshot = { mimeType: 'image/png' as const, base64: 'AA==', width: 1280, height: 800, originX: -1280, originY: 0 }
const signal = () => new AbortController().signal
const request = (operation: Record<string, unknown>): ComputerRequest => ({
  requestId: crypto.randomUUID(), workspaceId: 'workspace', sessionId: 'session', ...operation,
}) as ComputerRequest
function fixture(enabled = true, clock: () => number = Date.now) {
  const driver = {
    status: vi.fn(async () => ({ available: true, platform: 'linux' })),
    screenshot: vi.fn(async (_signal?: AbortSignal) => screenshot),
    input: vi.fn(async (_action: unknown, _signal?: AbortSignal) => {}),
    close: vi.fn(async () => {}),
    releaseInputs: vi.fn(async () => {}),
    acquire: vi.fn(async () => {}),
    releaseClaim: vi.fn(async () => {}),
    semantic: vi.fn(async (_request: unknown, _signal?: AbortSignal): Promise<ComputerObservation> => ({
      backend: 'desktop', snapshotId: crypto.randomUUID(), targetId: 'fixture', title: 'Fixture', elements: [], truncated: false,
    })),
  }
  return { driver, manager: new ComputerUseManager(driver, enabled, clock) }
}
async function start(manager: ComputerUseManager, allowAgent = false) {
  const result = await manager.request(request({ operation: 'start', consent: true, allowAgent }), 'owner', signal())
  expect(result.error).toBeUndefined()
  expect(result.leaseId).toBeTruthy()
  return result.leaseId!
}

describe('computer desktop authorization', () => {
  afterEach(() => vi.useRealTimers())

  it('defaults to denying use until the machine locally opts in', async () => {
    const { manager, driver } = fixture(false)
    expect(await manager.status()).toMatchObject({ available: false, active: false })
    const result = await manager.request(request({ operation: 'start', consent: true, allowAgent: true }), 'owner', signal())
    expect(result.error?.code).toBe('unavailable')
    expect(driver.acquire).not.toHaveBeenCalled()
    await manager.close()
  })

  it('requires explicit consent and never lets the model grant or renew its own lease', async () => {
    const { manager } = fixture()
    expect((await manager.request(request({ operation: 'start', allowAgent: true }), 'owner', signal())).error?.code).toBe('invalid_request')
    await expect(manager.agent({ operation: 'start', consent: true }, 'session', signal())).rejects.toThrow(/authorization/i)
    await start(manager)
    await expect(manager.agent({ operation: 'input', action: { type: 'key', key: 'Enter' } }, 'session', signal())).rejects.toThrow(/paused/i)
    await manager.close()
  })

  it('binds control to one session, socket, and lease and rejects competing controllers', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    const capture = request({ operation: 'capture', leaseId })
    expect((await manager.request(capture, 'another-owner', signal())).error?.code).toBe('denied')
    expect((await manager.request({ ...capture, sessionId: 'another-session' }, 'owner', signal())).error?.code).toBe('denied')
    expect((await manager.request(request({ operation: 'start', consent: true, allowAgent: true }), 'another-owner', signal())).error?.code).toBe('busy')
    await expect(manager.agent({ operation: 'screenshot' }, 'another-session', signal())).rejects.toThrow(/another session/i)
    expect(driver.screenshot).not.toHaveBeenCalled()
    await manager.close()
  })

  it('delivers native image observations only to explicitly authorized Agents', async () => {
    const { manager } = fixture()
    await start(manager, true)
    expect(JSON.parse(await manager.agent({ operation: 'screenshot' }, 'session', signal()))).toEqual({ kind: COMPUTER_SCREENSHOT_KIND, screenshot })
    await expect(manager.agent({ operation: 'renew' }, 'session', signal())).rejects.toThrow(/only the user/i)
    await manager.close()
  })

  it('applies the same consent, session, cancellation and revocation boundary to semantic control', async () => {
    const { manager, driver } = fixture()
    const observe = { operation: 'observe', backend: 'desktop' }
    await expect(manager.agent(observe, 'session', signal())).rejects.toThrow(/authorization/i)
    const leaseId = await start(manager, false)
    await expect(manager.agent(observe, 'session', signal())).rejects.toThrow(/paused/i)
    await manager.request(request({ operation: 'agent', leaseId, allowAgent: true }), 'owner', signal())
    expect(JSON.parse(await manager.agent(observe, 'session', signal()))).toMatchObject({ backend: 'desktop', title: 'Fixture' })
    await expect(manager.agent(observe, 'other-session', signal())).rejects.toThrow(/another session/i)
    manager.revoke()
    await expect(manager.agent(observe, 'session', signal())).rejects.toThrow(/authorization/i)
    expect(driver.semantic).toHaveBeenCalledOnce()
    await manager.close()
  })

  it('executes visual batches in order and returns the final image without another model turn', async () => {
    const { manager, driver } = fixture()
    await start(manager, true)
    const actions = [{ type: 'key', key: 'Enter' }, { type: 'key', key: 'Escape' }]
    expect(JSON.parse(await manager.agent({ operation: 'batch', actions }, 'session', signal()))).toEqual({ kind: COMPUTER_SCREENSHOT_KIND, screenshot })
    expect(driver.input.mock.calls.map(([action]) => action)).toEqual(actions)
    expect(driver.screenshot).toHaveBeenCalledOnce()
    driver.input.mockRejectedValueOnce(new Error('blocked'))
    await expect(manager.agent({ operation: 'batch', actions }, 'session', signal())).rejects.toThrow('1 later actions skipped')
    expect(driver.input).toHaveBeenCalledTimes(3)
    expect(driver.releaseInputs).toHaveBeenCalledOnce()
    expect(driver.screenshot).toHaveBeenCalledOnce()
    await manager.close()
  })

  it('manual input immediately takes over from Agent without dropping the user lease', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    const result = await manager.request(request({ operation: 'input', leaseId, action: { type: 'key', key: 'Escape' } }), 'owner', signal())
    expect(result.status).toMatchObject({ active: true, allowAgent: false })
    expect(driver.releaseInputs).toHaveBeenCalledOnce()
    expect(driver.releaseClaim).not.toHaveBeenCalled()
    expect(driver.input).toHaveBeenCalledWith({ type: 'key', key: 'Escape' }, expect.any(AbortSignal))
    await manager.close()
  })

  it('stop and disconnect abort work and release the physical desktop claim', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    let activeSignal: AbortSignal | undefined
    driver.screenshot.mockImplementation(async (operationSignal) => {
      activeSignal = operationSignal
      return await new Promise((_resolve, reject) => operationSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })

    const observation = manager.agent({ operation: 'screenshot' }, 'session', signal())
    await vi.waitFor(() => expect(activeSignal).toBeDefined())
    const rejection = expect(observation).rejects.toThrow('cancelled')
    const result = await manager.request(request({ operation: 'stop', leaseId }), 'owner', signal())
    await rejection
    expect(result.status?.active).toBe(false)
    expect(activeSignal!.aborted).toBe(true)
    expect(driver.releaseClaim).toHaveBeenCalledOnce()
    await manager.close()
  })

  it.each(['input', 'agent'] as const)('preserves a pending user screenshot when %s pauses Agent control', async (operation) => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    let captureSignal: AbortSignal | undefined
    let complete: (() => void) | undefined
    driver.screenshot.mockImplementationOnce(async (operationSignal) => {
      captureSignal = operationSignal
      await new Promise<void>((resolve, reject) => {
        complete = resolve
        operationSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      return screenshot
    })
    const capture = manager.request(request({ operation: 'capture', leaseId }), 'owner', signal())
    await vi.waitFor(() => expect(complete).toBeDefined())
    const pause = manager.request(request(operation === 'input'
      ? { operation, leaseId, action: { type: 'key', key: 'Escape' } }
      : { operation, leaseId, allowAgent: false }), 'owner', signal())
    try {
      expect(captureSignal!.aborted).toBe(false)
      complete!()
      expect(await capture).toMatchObject({ screenshot })
      expect(await pause).toMatchObject({ status: { active: true, allowAgent: false } })
    } finally {
      complete!()
      await Promise.allSettled([capture, pause])
      await manager.close()
    }
  })

  it('still cancels an in-flight Agent observation on manual takeover', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    let captureSignal: AbortSignal | undefined
    driver.screenshot.mockImplementationOnce(async (operationSignal) => {
      captureSignal = operationSignal
      return await new Promise((_resolve, reject) => operationSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const observation = manager.agent({ operation: 'screenshot' }, 'session', signal())
    await vi.waitFor(() => expect(captureSignal).toBeDefined())
    const rejection = expect(observation).rejects.toThrow('cancelled')
    const result = await manager.request(request({ operation: 'input', leaseId, action: { type: 'key', key: 'Escape' } }), 'owner', signal())
    await rejection
    expect(captureSignal!.aborted).toBe(true)
    expect(result.status).toMatchObject({ active: true, allowAgent: false })
    expect((await manager.request(request({ operation: 'capture', leaseId }), 'owner', signal())).screenshot).toEqual(screenshot)
    await manager.close()
  })

  it('expires without a browser heartbeat; neither screenshots nor model calls extend the lease', async () => {
    let now = 0
    const { manager, driver } = fixture(true, () => now)
    const leaseId = await start(manager, true)
    await manager.agent({ operation: 'screenshot' }, 'session', signal())
    now = COMPUTER_LEASE_MS + 1
    expect((await manager.request(request({ operation: 'capture', leaseId }), 'owner', signal())).error?.code).toBe('denied')
    expect(await manager.status()).toMatchObject({ active: false, allowAgent: false })
    expect(driver.releaseClaim).toHaveBeenCalledOnce()
    await manager.close()
  })

  it('renews an authenticated user lease without waiting behind native operations', async () => {
    let now = 0
    const { manager, driver } = fixture(true, () => now)
    const leaseId = await start(manager, true)
    let complete: (() => void) | undefined
    driver.screenshot.mockImplementation(async () => {
      await new Promise<void>((resolve) => { complete = resolve })
      return screenshot
    })
    const capture = manager.agent({ operation: 'screenshot' }, 'session', signal())
    await vi.waitFor(() => expect(complete).toBeDefined())
    now = COMPUTER_LEASE_MS - 1_000
    const renewal = request({ operation: 'renew', leaseId })
    let renewed = false
    const pending = manager.request(renewal, 'owner', signal()).then((response) => { renewed = true; return response })
    try {
      await vi.waitFor(() => expect(renewed).toBe(true), { timeout: 100 })
      expect(await pending).toMatchObject({ status: { active: true, expiresAt: now + COMPUTER_LEASE_MS } })
      expect(driver.status).toHaveBeenCalledTimes(2)
      now += 2_000
      expect((await manager.request(renewal, 'owner', signal())).status?.expiresAt).toBe(COMPUTER_LEASE_MS * 2 - 1_000)
    } finally {
      complete!()
      await Promise.allSettled([capture, pending])
      await manager.close()
    }
  })

  it('deduplicates input but rejects reuse of a request ID with different arguments', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager)
    const input = request({ operation: 'input', leaseId, action: { type: 'key', key: 'Enter' } })
    await manager.request(input, 'owner', signal())
    await manager.request(input, 'owner', signal())
    expect(driver.input).toHaveBeenCalledOnce()
    const result = await manager.request({ ...input, operation: 'input', leaseId, action: { type: 'key', key: 'Escape' } }, 'owner', signal())
    expect(result.error?.message).toMatch(/request ID/i)
    await manager.close()
  })

  it('fails closed and exposes native input cleanup failures', async () => {
    const { manager, driver } = fixture()
    await start(manager, true)
    driver.releaseClaim.mockRejectedValueOnce(new Error('locked desktop'))
    manager.revoke()
    expect(await manager.status()).toMatchObject({ available: false, active: false, reason: expect.stringContaining('cleanup failed') })
    await manager.close()
  })

  it('does not acknowledge stop as successful when physical input cleanup fails', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    driver.releaseClaim.mockRejectedValueOnce(new Error('Native input release failed'))
    const stopped = await manager.request(request({ operation: 'stop', leaseId }), 'owner', signal())
    expect(stopped.error).toMatchObject({ code: 'execution_error', message: expect.stringContaining('Native input release failed') })
    expect(await manager.status()).toMatchObject({ available: false, active: false })
    await manager.close()
  })

  it('releases a companion claim if acquisition is cancelled before a lease is created', async () => {
    const { manager, driver } = fixture()
    const controller = new AbortController()
    driver.acquire.mockImplementation(async () => { controller.abort() })
    const result = await manager.request(request({ operation: 'start', consent: true, allowAgent: true }), 'owner', controller.signal)
    expect(result.error?.message).toMatch(/cancelled/i)
    expect(driver.releaseClaim).toHaveBeenCalledOnce()
    expect(driver.releaseInputs).not.toHaveBeenCalled()
    expect((await manager.status()).active).toBe(false)
    await manager.close()
  })

  it('never grants a pending authorization after the desktop connection closes', async () => {
    const { manager, driver } = fixture()
    let acquired: (() => void) | undefined
    driver.acquire.mockImplementation(() => new Promise<void>((resolve) => { acquired = resolve }))
    const pending = manager.request(request({ operation: 'start', consent: true, allowAgent: true }), 'owner', signal())
    await vi.waitFor(() => expect(acquired).toBeDefined())
    const closing = manager.close()
    acquired!()
    expect((await pending).error?.message).toMatch(/cancelled/i)
    await closing
    await manager.close()
    expect(driver.close).toHaveBeenCalledOnce()
    expect(driver.releaseClaim).toHaveBeenCalledOnce()
    expect(await manager.status()).toMatchObject({ available: false, active: false })
    expect((await manager.request(request({ operation: 'start', consent: true, allowAgent: true }), 'owner', signal())).error?.message).toMatch(/closed/i)
  })

  it('bounds queued actions and reports overload as busy without blocking urgent revocation', async () => {
    const { manager, driver } = fixture()
    const leaseId = await start(manager, true)
    let active = false
    driver.screenshot.mockImplementation(async (operationSignal) => {
      active = true
      return await new Promise((_resolve, reject) => operationSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const actions = Array.from({ length: 16 }, () => manager.agent({ operation: 'screenshot' }, 'session', signal()))
    const completed = Promise.allSettled(actions)
    await vi.waitFor(() => expect(active).toBe(true))
    expect((await manager.request(request({ operation: 'capture', leaseId }), 'owner', signal())).error?.code).toBe('busy')
    expect((await manager.request(request({ operation: 'renew', leaseId }), 'owner', signal())).status?.active).toBe(true)
    expect((await manager.request(request({ operation: 'stop', leaseId }), 'owner', signal())).status?.active).toBe(false)
    expect((await completed).every((result) => result.status === 'rejected')).toBe(true)
    expect(driver.screenshot).toHaveBeenCalledOnce()
    await manager.close()
  })
})
