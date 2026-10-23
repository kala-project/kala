import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { connect, Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerObservation, ComputerSemanticRequest } from '@agent-kernel/shared'
import {
  createConfiguredDesktopDriver, serveDesktopCompanion, type ConfiguredDesktopDriver,
} from './companion.js'
import {
  authenticateCompanion, companionFrames, COMPANION_MAX_REQUEST, validateCompanionAction,
  validateCompanionScreenshot,
} from './companion-protocol.js'
import {
  companionLoopbackPort, COMPANION_WINDOWS_ACL_SCRIPT, readCompanionConfig, validateCompanionConfig,
  type CompanionConfig,
} from './companion-security.js'
import type { DesktopInputAction } from './desktop-driver.js'

const roots: string[] = []
const companions: { close(): Promise<void> }[] = []
const proxies: ConfiguredDesktopDriver[] = []
const rawSockets: Socket[] = []
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7UkAAAAASUVORK5CYII='
const screenshot = { mimeType: 'image/png' as const, base64: png, width: 1, height: 1, originX: 0, originY: 0 }
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const observation: ComputerObservation = {
  backend: 'desktop', snapshotId: randomUUID(), targetId: 'fixture', title: 'Fixture',
  elements: [{ ref: 'e1', role: 'button', name: 'Save', enabled: true, actions: ['invoke'] }], truncated: false,
}

afterEach(async () => {
  for (const socket of rawSockets.splice(0)) socket.destroy()
  for (const proxy of proxies.splice(0)) await proxy.close().catch(() => {})
  for (const companion of companions.splice(0)) await companion.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function native() {
  return {
    status: vi.fn(async () => ({ available: true, platform: 'linux' })),
    screenshot: vi.fn(async (_signal?: AbortSignal) => ({ ...screenshot })),
    input: vi.fn(async (_action: DesktopInputAction, _signal?: AbortSignal) => {}),
    semantic: vi.fn(async (_request: ComputerSemanticRequest, _signal?: AbortSignal): Promise<ComputerObservation> => observation),
    releaseInputs: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}
function path() {
  // Project-local, short enough for AF_UNIX; never uses OS temporary directories.
  const root = join(fileURLToPath(new URL('../../../../', import.meta.url)), `.cu-${randomBytes(3).toString('hex')}`)
  roots.push(root)
  return join(root, 'companion.json')
}
async function start(options: { idleTimeoutMs?: number; operationTimeoutMs?: number } = {}) {
  const driver = native()
  const configPath = path()
  const companion = await serveDesktopCompanion(configPath, { platform: 'linux', driver, ...options })
  companions.push(companion)
  const config = await readCompanionConfig(configPath, { platform: 'linux' })
  return { driver, configPath, config, companion }
}
function proxy(configPath: string, operationTimeoutMs = 1000) {
  const result = createConfiguredDesktopDriver({
    platform: 'linux', env: { KALA_COMPUTER_USE_COMPANION_CONFIG: configPath }, operationTimeoutMs,
  })
  proxies.push(result)
  return result
}
async function raw(config: CompanionConfig) {
  const socket = config.platform === 'win32'
    ? connect({ host: '127.0.0.1', port: companionLoopbackPort(config.endpoint) })
    : connect(config.endpoint)
  rawSockets.push(socket)
  socket.on('error', () => {})
  await new Promise<void>((done, reject) => { socket.once('connect', done); socket.once('error', reject) })
  return socket
}
function rawRequest(config: CompanionConfig, operation = 'status', owner = randomUUID()) {
  return { version: 1, id: randomUUID(), token: config.token, owner, operation }
}
function response(socket: Socket) {
  return new Promise<Record<string, unknown>>((done, reject) => {
    const onData = companionFrames(64 * 1024, (value) => {
      socket.off('data', onData)
      done(value as Record<string, unknown>)
    }, () => reject(new Error('Malformed response')))
    socket.on('data', onData)
    socket.once('close', () => reject(new Error('Connection closed')))
  })
}
async function until(check: () => boolean, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (!check()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await delay(5) }
}

describe('desktop companion real local IPC with injected native driver (not desktop acceptance)', () => {
  it('publishes a random token and private owner-only config/socket and removes config on shutdown', async () => {
    const { configPath, config, companion } = await start()
    expect(config.token).toMatch(/^[0-9a-f]{64}$/)
    expect(config.endpoint).toMatch(/\.kala-[0-9a-f]{32}\.sock$/)
    expect((await lstat(join(configPath, '..'))).mode & 0o777).toBe(0o700)
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(config.endpoint)).mode & 0o777).toBe(0o600)
    await companion.close()
    await expect(lstat(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires explicit acquisition for screenshots/input, then validates returned screenshots', async () => {
    const { configPath, driver } = await start()
    const client = proxy(configPath)
    expect(await client.status()).toEqual({ available: true, platform: 'linux' })
    await expect(client.screenshot()).rejects.toThrow('Acquire')
    await expect(client.input({ type: 'move', x: 0, y: 0 })).rejects.toThrow('Acquire')
    await client.acquire!()
    expect(await client.screenshot()).toEqual(screenshot)
    await client.input({ type: 'type', text: '中文 😀 $(not shell)' })
    expect(driver.input).toHaveBeenCalledWith({ type: 'type', text: '中文 😀 $(not shell)' }, expect.any(AbortSignal))
  })

  it('gives one proxy exclusive ownership, and status from another owner does not refresh it', async () => {
    const { configPath } = await start()
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    await expect(second.acquire!()).rejects.toThrow('already claimed')
    expect(await second.status()).toMatchObject({ available: false, reason: expect.stringContaining('claimed') })
    await first.releaseClaim!()
    await second.acquire!()
    await expect(second.screenshot()).resolves.toEqual(screenshot)
    await expect(first.screenshot()).rejects.toThrow('Acquire')
  })

  it('requires the owning claim for semantic IPC and validates native observations', async () => {
    const { configPath, driver } = await start()
    const first = proxy(configPath), second = proxy(configPath)
    const request = { operation: 'observe', backend: 'desktop' } as const
    await expect(first.semantic!(request)).rejects.toThrow('Acquire')
    expect(driver.semantic).not.toHaveBeenCalled()
    await first.acquire!()
    await expect(second.semantic!(request)).rejects.toThrow('Acquire')
    await expect(first.semantic!(request)).resolves.toEqual(observation)
    expect(driver.semantic).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    driver.semantic.mockResolvedValueOnce({ ...observation, title: 'x'.repeat(161) })
    await expect(first.semantic!(request)).rejects.toThrow(/title|Too big/)
  })

  it('cancels semantic IPC before another operation is allowed to execute', async () => {
    const { configPath, driver } = await start()
    driver.semantic.mockImplementationOnce(async (_request, signal) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true })
    }))
    const client = proxy(configPath)
    await client.acquire!()
    const controller = new AbortController()
    const result = client.semantic!({ operation: 'observe', backend: 'desktop' }, controller.signal)
    const rejected = expect(result).rejects.toThrow(/cancel/i)
    await until(() => driver.semantic.mock.calls.length === 1)
    controller.abort()
    await rejected
    await until(() => driver.releaseInputs.mock.calls.length > 0)
    await expect(client.semantic!({ operation: 'observe', backend: 'desktop' })).resolves.toEqual(observation)
  })

  it('releaseInputs retains ownership for Agent pause; releaseClaim relinquishes it for stop', async () => {
    const { configPath, driver } = await start()
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    await first.input({ type: 'button', x: 0, y: 0, button: 'left', down: true })
    await first.releaseInputs()
    expect(driver.releaseInputs).toHaveBeenCalled()
    await expect(second.acquire!()).rejects.toThrow('claimed')
    await expect(first.input({ type: 'move', x: 0, y: 0 })).resolves.toBeUndefined()
    await first.releaseClaim!()
    await second.acquire!()
  })

  it('proxy close revokes only its claim, leaving the explicit companion alive', async () => {
    const { configPath, driver } = await start()
    const first = proxy(configPath)
    await first.acquire!()
    await first.close()
    expect(driver.close).not.toHaveBeenCalled()
    const second = proxy(configPath)
    await second.acquire!()
    await expect(second.screenshot()).resolves.toEqual(screenshot)
  })

  it('rejects incorrect authentication without invoking native operations or leaking tokens', async () => {
    const { config, driver } = await start()
    const socket = await raw(config)
    const closed = new Promise<void>((done) => socket.once('close', done))
    socket.write(`${JSON.stringify({ ...rawRequest(config), token: '0'.repeat(64) })}\n`)
    await closed
    expect(driver.status).toHaveBeenCalledTimes(1)
    expect(driver.screenshot).not.toHaveBeenCalled()
  })

  it('binds claim ownership to the connection, not only an owner UUID supplied by another proxy', async () => {
    const { config } = await start()
    const first = await raw(config), second = await raw(config)
    const owner = randomUUID()
    let next = response(first)
    first.write(`${JSON.stringify(rawRequest(config, 'acquire', owner))}\n`)
    expect(await next).toMatchObject({ ok: true })
    next = response(second)
    second.write(`${JSON.stringify({ ...rawRequest(config, 'input', owner), action: { type: 'move', x: 0, y: 0 } })}\n`)
    expect(await next).toMatchObject({ ok: false, error: { code: 'NOT_OWNER' } })
  })

  it('expires inactive ownership and releases held input even while another owner polls status', async () => {
    const { configPath, driver } = await start({ idleTimeoutMs: 80 })
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    await first.input({ type: 'button', x: 0, y: 0, button: 'left', down: true })
    for (let i = 0; i < 5; i++) { await second.status(); await delay(20) }
    await until(() => driver.releaseInputs.mock.calls.length > 0)
    await second.acquire!()
    await expect(first.screenshot()).rejects.toThrow('Acquire')
  })

  it('refreshes inactivity only through the owning proxy status', async () => {
    const { configPath } = await start({ idleTimeoutMs: 120 })
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    for (let i = 0; i < 4; i++) { await delay(40); expect((await first.status()).available).toBe(true) }
    await expect(second.acquire!()).rejects.toThrow('claimed')
  })

  it('aborts a running operation on cancellation, cleans input, and retains the manual claim', async () => {
    const { configPath, driver } = await start()
    driver.input.mockImplementation(async (_action, signal) => {
      await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true }))
    })
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    const abort = new AbortController()
    const pending = first.input({ type: 'key', key: 'Ctrl+A' }, abort.signal)
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await until(() => driver.input.mock.calls.length > 0)
    abort.abort()
    await cancelled
    await first.releaseInputs()
    expect(driver.releaseInputs).toHaveBeenCalled()
    await expect(second.acquire!()).rejects.toThrow('claimed')
    await expect(first.screenshot()).resolves.toEqual(screenshot)
  })

  it('cancels queued client operations without submitting them or losing ownership', async () => {
    const { configPath, driver } = await start()
    const first = proxy(configPath)
    await first.acquire!()
    await expect(first.input({ type: 'move', x: 0, y: 0 }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(driver.input).not.toHaveBeenCalled()
    await expect(first.screenshot()).resolves.toEqual(screenshot)
  })

  it('cleans a button hold if cancellation crosses an already-completed response, retaining the claim', async () => {
    const { config, driver } = await start()
    const socket = await raw(config)
    const owner = randomUUID()
    let next = response(socket)
    socket.write(`${JSON.stringify(rawRequest(config, 'acquire', owner))}\n`)
    await next
    const click = { ...rawRequest(config, 'input', owner), action: { type: 'button', x: 0, y: 0, button: 'left', down: true } }
    next = response(socket)
    socket.write(`${JSON.stringify(click)}\n`)
    await next
    next = response(socket)
    socket.write(`${JSON.stringify({ ...rawRequest(config, 'cancel', owner), target: click.id })}\n`)
    expect(await next).toMatchObject({ ok: true })
    await until(() => driver.releaseInputs.mock.calls.length > 0)
    next = response(socket)
    socket.write(`${JSON.stringify(rawRequest(config, 'screenshot', owner))}\n`)
    expect(await next).toMatchObject({ ok: true })
  })

  it('expiry aborts an in-flight native operation and releases the old claim', async () => {
    const { configPath, driver } = await start({ idleTimeoutMs: 60, operationTimeoutMs: 1000 })
    driver.input.mockImplementation(async (_action, signal) => {
      await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('expiry', 'AbortError')), { once: true }))
    })
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    await expect(first.input({ type: 'key', key: 'Ctrl+A' })).rejects.toMatchObject({ name: 'AbortError' })
    await second.acquire!()
    expect(driver.releaseInputs).toHaveBeenCalled()
  })

  it('serializes native operations and snapshots queued request data', async () => {
    const { configPath, driver } = await start()
    const client = proxy(configPath)
    await client.acquire!()
    let unblock!: () => void
    driver.screenshot.mockImplementationOnce(async () => { await new Promise<void>((done) => { unblock = done }); return screenshot })
    const first = client.screenshot()
    await until(() => Boolean(unblock))
    const action = { type: 'type' as const, text: 'original' }
    const second = client.input(action)
    action.text = 'mutated'
    await delay(10)
    expect(driver.input).not.toHaveBeenCalled()
    unblock()
    await first; await second
    expect(driver.input).toHaveBeenCalledWith({ type: 'type', text: 'original' }, expect.any(AbortSignal))
  })

  it('aborts on operation timeout, releases inputs and relinquishes the claim', async () => {
    const { configPath, driver } = await start({ operationTimeoutMs: 60 })
    driver.input.mockImplementation(async (_action, signal) => {
      await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true }))
    })
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    await expect(first.input({ type: 'key', key: 'Ctrl+A' })).rejects.toThrow('timed out')
    await until(() => driver.releaseInputs.mock.calls.length > 0)
    await second.acquire!()
  })

  it('releases owner inputs and cancels active operations on abrupt socket disconnect', async () => {
    const { config, driver } = await start()
    const socket = await raw(config)
    const owner = randomUUID()
    let next = response(socket)
    socket.write(`${JSON.stringify(rawRequest(config, 'acquire', owner))}\n`)
    await next
    driver.input.mockImplementation(async (_action, signal) => {
      await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true }))
    })
    socket.write(`${JSON.stringify({ ...rawRequest(config, 'input', owner), action: { type: 'key', key: 'Ctrl+A' } })}\n`)
    await until(() => driver.input.mock.calls.length > 0)
    socket.destroy()
    await until(() => driver.releaseInputs.mock.calls.length > 0)
    expect(driver.input.mock.calls[0]![1]!.aborted).toBe(true)
  })

  it('does not silently continue if native input cleanup fails', async () => {
    const { configPath, driver } = await start()
    const first = proxy(configPath), second = proxy(configPath)
    await first.acquire!()
    driver.releaseInputs.mockRejectedValue(new Error('locked input cleanup failed'))
    await expect(first.releaseClaim!()).rejects.toThrow('cleanup failed')
    await expect(second.acquire!()).rejects.toThrow('cleanup failed')
  })

  it('redacts token bytes even if a native diagnostic unexpectedly includes them', async () => {
    const { configPath, config, driver } = await start()
    const client = proxy(configPath)
    await client.acquire!()
    driver.input.mockRejectedValue(new Error(`Unexpected diagnostic ${config.token}`))
    try {
      await client.input({ type: 'move', x: 0, y: 0 })
      throw new Error('Expected failure')
    } catch (error) {
      expect((error as Error).message).toContain('[redacted]')
      expect((error as Error).message).not.toContain(config.token)
    }
  })

  it('rejects oversized request framing and arbitrary RPC without native execution', async () => {
    const { config, driver } = await start()
    const large = await raw(config)
    const closed = new Promise<void>((done) => large.once('close', done))
    large.write(Buffer.alloc(COMPANION_MAX_REQUEST + 1, 65))
    await closed
    const unknown = await raw(config)
    const closedUnknown = new Promise<void>((done) => unknown.once('close', done))
    unknown.write(`${JSON.stringify(rawRequest(config, 'powershell'))}\n`)
    await closedUnknown
    expect(driver.status).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid native screenshots rather than passing through malformed data', async () => {
    const { configPath, driver } = await start()
    const client = proxy(configPath)
    await client.acquire!()
    driver.screenshot.mockResolvedValue({ ...screenshot, base64: 'AAAA' })
    await expect(client.screenshot()).rejects.toThrow('PNG')
  })

  it('shutdown cancels active native operations, cleans input and closes the native driver', async () => {
    const { configPath, companion, driver } = await start()
    const client = proxy(configPath)
    await client.acquire!()
    driver.input.mockImplementation(async (_action, signal) => {
      await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('shutdown', 'AbortError')), { once: true }))
    })
    const pending = client.input({ type: 'key', key: 'Ctrl+A' })
    const failed = expect(pending).rejects.toThrow()
    await until(() => driver.input.mock.calls.length > 0)
    await companion.close()
    await failed
    expect(driver.releaseInputs).toHaveBeenCalled()
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('rejects companion startup in Session 0 before creating config or listening', async () => {
    const driver = native()
    driver.status.mockResolvedValue({ available: false, platform: 'win32', reason: 'Session 0 is non-interactive' } as Awaited<ReturnType<typeof driver.status>>)
    const configPath = path()
    await expect(serveDesktopCompanion(configPath, { platform: 'win32', driver })).rejects.toThrow('Session 0')
    await expect(lstat(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(driver.close).toHaveBeenCalled()
  })

  it('never falls back to native when configured companion is missing or unavailable', async () => {
    const run = vi.fn()
    const client = createConfiguredDesktopDriver({
      platform: 'linux', env: { KALA_COMPUTER_USE_COMPANION_CONFIG: path() }, nativeOptions: { run },
    })
    proxies.push(client)
    expect(await client.status()).toMatchObject({ available: false })
    await expect(client.acquire!()).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('uses native driver only when the companion setting is absent; empty configuration fails closed', async () => {
    const run = vi.fn(async () => { throw new Error('Session 0 is non-interactive') })
    const driver = createConfiguredDesktopDriver({ platform: 'win32', env: {}, nativeOptions: { run } })
    proxies.push(driver)
    expect(driver.acquire).toBeUndefined()
    expect(await driver.status()).toMatchObject({ available: false, reason: expect.stringContaining('Session 0') })
    expect(() => createConfiguredDesktopDriver({ env: { KALA_COMPUTER_USE_COMPANION_CONFIG: '' } })).toThrow('private companion config')
  })

  it('refuses to overwrite an existing config for another companion', async () => {
    const { configPath } = await start()
    const original = await readFile(configPath, 'utf8')
    const driver = native()
    await expect(serveDesktopCompanion(configPath, { platform: 'linux', driver })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(configPath, 'utf8')).toBe(original)
    expect(driver.close).toHaveBeenCalled()
  })
})

describe('Windows loopback transport with injected native driver and ACL runner (not Windows acceptance)', () => {
  async function windows(options: { idleTimeoutMs?: number } = {}) {
    const configPath = path(), driver = native()
    driver.status.mockResolvedValue({ available: true, platform: 'win32' })
    await mkdir(join(configPath, '..'), { mode: 0o700 })
    const run = vi.fn(async () => Buffer.from('{"ok":true}'))
    const security = { platform: 'win32' as const, run }
    const companion = await serveDesktopCompanion(configPath, { ...security, driver, ...options })
    companions.push(companion)
    const config = await readCompanionConfig(configPath, security)
    const client = () => {
      const result = createConfiguredDesktopDriver({ ...security, env: { KALA_COMPUTER_USE_COMPANION_CONFIG: configPath } })
      proxies.push(result)
      return result
    }
    return { configPath, config, driver, companion, client }
  }

  it('binds only explicit IPv4 loopback port0, publishes the assigned port and connects without named pipes', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen')
    try {
      const { config, client, companion, configPath } = await windows()
      expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 0, exclusive: true }, expect.any(Function))
      expect(companionLoopbackPort(config.endpoint)).toBeGreaterThan(0)
      expect(config.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/)
      expect(await client().status()).toEqual({ available: true, platform: 'win32' })
      const socket = await raw(config)
      expect(socket.remoteAddress).toBe('127.0.0.1')
      await companion.close()
      await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { listen.mockRestore() }
  })

  it('closes unauthenticated TCP clients without output or native status dispatch', async () => {
    const { config, driver } = await windows()
    const socket = await raw(config)
    const received: Buffer[] = []
    socket.on('data', bytes => received.push(bytes))
    const closed = new Promise<void>(done => socket.once('close', done))
    socket.write(JSON.stringify({ ...rawRequest(config), token: '0'.repeat(64) }) + '\n')
    await closed
    expect(Buffer.concat(received)).toHaveLength(0)
    expect(driver.status).toHaveBeenCalledTimes(1)
  })

  it('preserves socket-bound exclusivity, pause ownership and inactivity release over TCP', async () => {
    const { client, driver } = await windows({ idleTimeoutMs: 100 })
    const first = client(), second = client()
    await first.acquire!()
    await expect(second.acquire!()).rejects.toThrow('claimed')
    await first.releaseInputs()
    await expect(second.acquire!()).rejects.toThrow('claimed')
    await first.releaseClaim!()
    await second.acquire!()
    const count = driver.releaseInputs.mock.calls.length
    await until(() => driver.releaseInputs.mock.calls.length > count)
    await first.acquire!()
    await first.close()
    await second.acquire!()
  })
})

describe('companion configuration and protocol validation', () => {
  it.each([
    '\\\\.\\pipe\\kala-desktop-' + 'a'.repeat(64), '\\\\remote\\pipe\\evil',
    'tcp://0.0.0.0:1234', 'tcp://localhost:1234', 'tcp://127.0.0.2:1234',
    'tcp://192.0.2.1:1234', 'tcp://[::1]:1234', 'tcp://127.1:1234',
    'tcp://2130706433:1234', 'tcp://127.0.0.1:0', 'tcp://127.0.0.1:65536',
    'tcp://127.0.0.1:0123', 'tcp://127.0.0.1:1234/', 'tcp://127.0.0.1:1234?x=1',
    'tcp://user@127.0.0.1:1234', 'tcp://127.0.0.1:1234\n', ' tcp://127.0.0.1:1234',
  ])('rejects noncanonical, remote, wildcard or legacy Windows endpoints: %s', endpoint => {
    expect(() => validateCompanionConfig({ version: 1, platform: 'win32', token: 'a'.repeat(64), endpoint }, path(), 'win32')).toThrow('local')
  })

  it.each([1, 65535])('accepts canonical Windows loopback port %d only', port => {
    expect(companionLoopbackPort(`tcp://127.0.0.1:${port}`)).toBe(port)
  })
  it('rejects public config directory/file permissions and symlinks', async () => {
    const { configPath } = await start()
    await chmod(configPath, 0o644)
    await expect(readCompanionConfig(configPath, { platform: 'linux' })).rejects.toThrow('0600')
    await chmod(configPath, 0o600)
    await chmod(join(configPath, '..'), 0o755)
    await expect(readCompanionConfig(configPath, { platform: 'linux' })).rejects.toThrow('0700')
    await chmod(join(configPath, '..'), 0o700)
    const link = join(configPath, '..', 'link.json')
    await symlink(configPath, link)
    await expect(readCompanionConfig(link, { platform: 'linux' })).rejects.toThrow()
  })

  it('rejects a public socket before sending authentication bytes', async () => {
    const { configPath, config, driver } = await start()
    await chmod(config.endpoint, 0o666)
    const client = proxy(configPath)
    expect(await client.status()).toMatchObject({ available: false, reason: expect.stringContaining('0600') })
    expect(driver.status).toHaveBeenCalledTimes(1)
    await chmod(config.endpoint, 0o600)
  })

  it('bounds config reads and rejects remote or arbitrary endpoints, without echoing token bytes', async () => {
    const configPath = path()
    await mkdir(join(configPath, '..'), { mode: 0o700 })
    await writeFile(configPath, 'x'.repeat(4097), { mode: 0o600 })
    await expect(readCompanionConfig(configPath, { platform: 'linux' })).rejects.toThrow('private')
    const secret = randomBytes(32).toString('hex')
    await writeFile(configPath, `{"token":"${secret}"`)
    try { await readCompanionConfig(configPath, { platform: 'linux' }) } catch (error) { expect((error as Error).message).not.toContain(secret) }
    expect(() => validateCompanionConfig({ version: 1, platform: 'win32', token: secret, endpoint: '\\\\remote\\pipe\\evil' }, configPath, 'win32')).toThrow('local')
    expect(() => validateCompanionConfig({ version: 1, platform: 'linux', token: secret, endpoint: '/unrelated/socket' }, configPath, 'linux')).toThrow('local')
  })

  it.each([
    { type: 'move', x: NaN, y: 0 },
    { type: 'move', x: 0, y: 0, shell: 'evil' },
    { type: 'click', x: 0, y: 0, button: '__proto__' },
    { type: 'type', text: 'a'.repeat(513) },
    { type: 'type', text: '\ud800' },
    { type: 'key', key: 'Ctrl+Control+a' },
    { type: 'key', key: 'Ctrl+$(evil)' },
    { type: 'exec', command: 'evil' },
  ])('rejects invalid action schema %#', (action) => {
    expect(() => validateCompanionAction(action)).toThrow()
  })

  it('uses fixed-length constant-time token comparison and validates image metadata', () => {
    const token = randomBytes(32).toString('hex')
    expect(authenticateCompanion(token, token)).toBe(true)
    expect(authenticateCompanion(token, '0'.repeat(64))).toBe(false)
    expect(authenticateCompanion('', token)).toBe(false)
    expect(() => validateCompanionScreenshot({ ...screenshot, width: 100 })).toThrow('metadata')
    expect(() => validateCompanionScreenshot({ ...screenshot, originX: Infinity })).toThrow()
  })

  it('accepts the exact 512 UTF-16-unit mixed Unicode boundary in the companion schema', () => {
    const text = 'Ab9-中é文😀|'.repeat(51) + '界Z'
    expect(text.length).toBe(512)
    expect(() => validateCompanionAction({ type: 'type', text })).not.toThrow()
    expect(() => validateCompanionAction({ type: 'type', text: text + 'x' })).toThrow()
  })

  it('handles split frames and rejects oversized or invalid UTF-8 frames', () => {
    const receive = vi.fn(), fail = vi.fn()
    const frames = companionFrames(16, receive, fail)
    frames(Buffer.from('{"ok":'))
    frames(Buffer.from('true}\n'))
    expect(receive).toHaveBeenCalledWith({ ok: true })
    frames(Buffer.alloc(17))
    expect(fail).toHaveBeenCalledTimes(1)
    const utf8Fail = vi.fn()
    companionFrames(64, vi.fn(), utf8Fail)(Buffer.from([34, 0xff, 34, 10]))
    expect(utf8Fail).toHaveBeenCalled()
  })

  it('keeps Windows ACL setup static, with only the user SID and SYSTEM and no token on stdin', () => {
    expect(COMPANION_WINDOWS_ACL_SCRIPT).toContain("$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')")
    expect(COMPANION_WINDOWS_ACL_SCRIPT).toContain('$acl.SetAccessRuleProtection($true,$false)')
    expect(COMPANION_WINDOWS_ACL_SCRIPT).toContain('foreach($sid in @($current,$system))')
    expect(COMPANION_WINDOWS_ACL_SCRIPT).toContain('$sid -ne $owner.Value -and $sid -ne $system.Value')
    expect(COMPANION_WINDOWS_ACL_SCRIPT).not.toContain('$r.token')
  })

  it('validates Windows config ACLs using fixed PowerShell source, never sending the token to it', async () => {
    const configPath = path()
    await mkdir(join(configPath, '..'), { mode: 0o700 })
    const config = { version: 1, platform: 'win32', token: randomBytes(32).toString('hex'), endpoint: 'tcp://127.0.0.1:43210' }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    const run = vi.fn(async () => Buffer.from('{"ok":true}'))
    expect(await readCompanionConfig(configPath, { platform: 'win32', run })).toEqual(config)
    const calls = run.mock.calls as unknown as [string, string[], { stdin: string }][]
    expect(Buffer.from(calls[0]![1][4]!, 'base64').toString('utf16le')).toBe(COMPANION_WINDOWS_ACL_SCRIPT)
    expect(JSON.parse(calls[0]![2].stdin)).toEqual({ path: configPath, operation: 'validate' })
    expect(calls[0]![2].stdin).not.toContain(config.token)
  })
})
