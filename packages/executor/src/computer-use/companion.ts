import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createDesktopDriver, type DesktopDriverOptions, type DesktopInputAction, type DesktopScreenshot, type DesktopStatus,
} from './desktop-driver.js'
import {
  authenticateCompanion, companionFrames, COMPANION_ID, COMPANION_MAX_REQUEST, COMPANION_MAX_RESPONSE,
  validateCompanionAction, validateCompanionRequest, validateCompanionScreenshot, validateCompanionStatus,
  type CompanionOperation, type CompanionRequest,
} from './companion-protocol.js'
import {
  companionEndpoint, companionLoopbackPort, prepareCompanionDirectory, readCompanionConfig, validateCompanionConfig, writeCompanionConfig,
  type CompanionConfig, type CompanionSecurityOptions,
} from './companion-security.js'

export type ConfiguredDesktopDriver = {
  status(): Promise<DesktopStatus>
  screenshot(signal?: AbortSignal): Promise<DesktopScreenshot>
  input(action: DesktopInputAction, signal?: AbortSignal): Promise<void>
  releaseInputs(): Promise<void>
  close(): Promise<void>
  acquire?(): Promise<void>
  releaseClaim?(): Promise<void>
}
export type DesktopCompanionOptions = CompanionSecurityOptions & {
  /** Test seam; production always uses the existing logged-in native desktop. */
  driver?: ConfiguredDesktopDriver
  operationTimeoutMs?: number
  idleTimeoutMs?: number
}
export type ConfiguredDesktopOptions = CompanionSecurityOptions & {
  nativeOptions?: DesktopDriverOptions
  operationTimeoutMs?: number
}

class CompanionError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
function cancelError() { return new DOMException('Desktop companion operation cancelled', 'AbortError') }
function checkSignal(signal?: AbortSignal) { if (signal?.aborted) throw cancelError() }
function boundedTimeout(value: number | undefined, fallback: number) {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 10 || result > 120_000) throw new Error('Invalid companion timeout')
  return result
}
function safeMessage(error: unknown, token: string) {
  return (error instanceof Error ? error.message : 'Desktop companion operation failed').replaceAll(token, '[redacted]').slice(0, 1024)
}

/** Explicitly run in the opted-in user's interactive session; never starts another desktop. */
export async function serveDesktopCompanion(configPath: string, options: DesktopCompanionOptions = {}): Promise<{ close(): Promise<void>; configPath: string }> {
  if (typeof configPath !== 'string' || !configPath.trim() || configPath.length > 4096) throw new Error('Desktop companion requires a bounded private config file path')
  const platform = options.platform ?? process.platform
  if (platform !== 'linux' && platform !== 'win32') throw new Error('Desktop companion supports only Linux X11 and Windows')
  const timeoutMs = boundedTimeout(options.operationTimeoutMs, 15_000)
  const idleMs = boundedTimeout(options.idleTimeoutMs, 30_000)
  const driver = options.driver ?? createDesktopDriver({ platform, env: options.env })
  try {
    const initial = await driver.status()
    validateCompanionStatus(initial)
    if (!initial.available) throw new Error(`Cannot start desktop companion: ${initial.reason ?? 'interactive desktop unavailable'}. Start it in the logged-in, unlocked user session, never Windows Session 0.`)
  } catch (error) {
    try { await driver.close() } finally { throw error }
  }
  let path: string
  try { path = await prepareCompanionDirectory(configPath, options) } catch (error) { await driver.close(); throw error }
  const config: CompanionConfig = {
    version: 1, platform, token: randomBytes(32).toString('hex'),
    endpoint: platform === 'linux' ? companionEndpoint(path, randomBytes(16).toString('hex')) : '',
  }
  if (platform === 'linux') {
    try { validateCompanionConfig(config, path, platform) } catch (error) { await driver.close(); throw error }
  }
  const sockets = new Set<Socket>()
  let stopped = false
  let poisoned = false
  let pending = 0
  let tail: Promise<void> = Promise.resolve()
  let owner: { id: string; socket: Socket; touched: number; revoking: boolean } | undefined
  const active = new Map<Socket, { id: string; controller: AbortController }>()
  const enqueue = (operation: () => Promise<void>) => {
    const work = tail.then(operation)
    tail = work.catch(() => { poisoned = true })
    return work
  }
  const revoke = (socket?: Socket) => {
    const claim = owner
    if (!claim || (socket && claim.socket !== socket) || claim.revoking) return
    claim.revoking = true
    active.get(claim.socket)?.controller.abort()
    void enqueue(async () => {
      try { await driver.releaseInputs() } catch { poisoned = true }
      if (owner === claim) owner = undefined
    })
  }
  const send = (socket: Socket, id: string, result?: unknown, error?: unknown) => {
    if (socket.destroyed) return
    const payload = error
      ? { id, ok: false, error: { code: error instanceof CompanionError ? error.code : 'NATIVE_FAILED', message: safeMessage(error, config.token) } }
      : { id, ok: true, result: result ?? null }
    const frame = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
    if (frame.length > COMPANION_MAX_RESPONSE || socket.writableLength + frame.length > COMPANION_MAX_RESPONSE) { socket.destroy(); return }
    socket.write(frame)
  }
  const isOwner = (request: CompanionRequest, socket: Socket) => owner?.id === request.owner && owner.socket === socket && !owner.revoking
  const perform = async (request: CompanionRequest, socket: Socket, signal: AbortSignal): Promise<unknown> => {
    if (stopped) throw new CompanionError('CLOSED', 'Desktop companion is shutting down')
    if (poisoned) throw new CompanionError('CLEANUP_FAILED', 'Desktop input cleanup failed; unlock the desktop and restart the companion')
    if (request.operation === 'release') {
      if (!owner) return null
      if (!isOwner(request, socket)) throw new CompanionError('NOT_OWNER', 'This proxy does not own the desktop claim')
      const claim = owner!
      claim.revoking = true
      try { await driver.releaseInputs() } catch (error) { poisoned = true; throw error }
      if (owner === claim) owner = undefined
      return null
    }
    if (request.operation === 'acquire') {
      if (owner && !isOwner(request, socket)) throw new CompanionError('BUSY', 'Desktop companion is already claimed by another manager')
      const status = await driver.status()
      validateCompanionStatus(status)
      checkSignal(signal)
      if (!status.available) throw new CompanionError('UNAVAILABLE', status.reason ?? 'Interactive desktop unavailable')
      owner = { id: request.owner, socket, touched: performance.now(), revoking: false }
      return null
    }
    if (request.operation === 'status') {
      if (owner && !isOwner(request, socket)) return { available: false, platform, reason: 'Desktop companion is already claimed by another manager' }
      if (isOwner(request, socket)) owner!.touched = performance.now()
      const status = await driver.status()
      validateCompanionStatus(status)
      return status
    }
    if (!isOwner(request, socket)) throw new CompanionError('NOT_OWNER', 'Acquire the desktop companion claim before screenshot or input')
    owner!.touched = performance.now()
    checkSignal(signal)
    if (request.operation === 'release-inputs') {
      try { await driver.releaseInputs() } catch (error) { poisoned = true; revoke(socket); throw error }
      return null
    }
    if (request.operation === 'screenshot') {
      const image = await driver.screenshot(signal)
      checkSignal(signal)
      validateCompanionScreenshot(image)
      return image
    }
    if (request.operation === 'input') {
      await driver.input(request.action!, signal)
      checkSignal(signal)
      return null
    }
    throw new CompanionError('BAD_REQUEST', 'Unsupported companion operation')
  }
  const server = createServer((socket) => {
    if (platform === 'win32' && (socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1')) { socket.destroy(); return }
    if (stopped || sockets.size >= 16) { socket.destroy(); return }
    sockets.add(socket)
    let busy = false
    let identity: string | undefined
    let lastCompleted: string | undefined
    socket.setTimeout(5000)
    socket.on('timeout', () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      active.get(socket)?.controller.abort()
      revoke(socket)
    })
    socket.on('data', companionFrames(COMPANION_MAX_REQUEST, (value) => {
      try { validateCompanionRequest(value) } catch { socket.destroy(); return }
      const request = value
      if (!authenticateCompanion(request.token, config.token) || (identity && identity !== request.owner)) { socket.destroy(); return }
      identity = request.owner
      socket.setTimeout(0)
      if (request.operation === 'cancel') {
        if (isOwner(request, socket)) {
          if (active.get(socket)?.id === request.target) active.get(socket)!.controller.abort()
          else if (lastCompleted === request.target) {
            // Cancellation can cross an already-written button-down response.
            void enqueue(async () => {
              try { await driver.releaseInputs() } catch { poisoned = true; revoke(socket) }
            })
          }
        }
        send(socket, request.id, null)
        return
      }
      if (busy || pending >= 32) { send(socket, request.id, undefined, new CompanionError('BUSY', 'A desktop operation is already pending')); return }
      busy = true; pending++
      void enqueue(async () => {
        if (socket.destroyed) return
        const controller = new AbortController()
        active.set(socket, { id: request.id, controller })
        let timeout: ReturnType<typeof setTimeout> | undefined
        let timedOut = false
        const native = Promise.resolve().then(() => perform(request, socket, controller.signal))
        const expiry = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true
            controller.abort()
            revoke(socket)
            reject(new CompanionError('TIMEOUT', 'Desktop companion operation timed out'))
          }, timeoutMs)
        })
        let result: unknown
        let failure: unknown
        try {
          result = await Promise.race([native, expiry])
          checkSignal(controller.signal)
        } catch (error) {
          failure = timedOut ? new CompanionError('TIMEOUT', 'Desktop companion operation timed out')
            : controller.signal.aborted ? new CompanionError('CANCELLED', 'Desktop companion operation cancelled')
              : error ?? new CompanionError('NATIVE_FAILED', 'Native desktop operation failed')
          if (timedOut) send(socket, request.id, undefined, failure)
        } finally {
          if (timeout) clearTimeout(timeout)
          // Do not allow another native call to overtake an operation ignoring abort.
          await native.catch(() => {})
          if (controller.signal.aborted || (failure && request.operation === 'input')) {
            try { await driver.releaseInputs() } catch { poisoned = true; revoke(socket) }
          }
          active.delete(socket)
        }
        lastCompleted = request.id
        if (!timedOut) send(socket, request.id, result, failure)
      }).catch(() => socket.destroy()).finally(() => { busy = false; pending-- })
    }, () => socket.destroy()))
  })
  let removeConfig: (() => Promise<void>) | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  const closeSockets = () => { for (const socket of sockets) socket.destroy() }
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      const ready = () => { server.off('error', reject); resolveListen() }
      if (platform === 'win32') server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, ready)
      else server.listen(config.endpoint, ready)
    })
    server.on('error', () => { poisoned = true; closeSockets(); revoke() })
    if (platform === 'win32') {
      const address = server.address()
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.family !== 'IPv4') throw new Error('Desktop companion must listen only on IPv4 loopback')
      config.endpoint = `tcp://127.0.0.1:${address.port}`
      validateCompanionConfig(config, path, platform)
    } else {
      await chmod(config.endpoint, 0o600)
      const info = await lstat(config.endpoint)
      if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Companion socket permissions are not private')
    }
    removeConfig = await writeCompanionConfig(path, config, options)
    interval = setInterval(() => {
      if (owner && !owner.revoking && performance.now() - owner.touched >= idleMs) revoke()
    }, Math.max(10, Math.min(1000, Math.floor(idleMs / 4))))
    interval.unref()
  } catch (error) {
    stopped = true
    closeSockets()
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    await removeConfig?.()
    await driver.close()
    throw error
  }
  let closePromise: Promise<void> | undefined
  return {
    configPath: path,
    close: () => closePromise ??= (async () => {
      stopped = true
      if (interval) clearInterval(interval)
      revoke()
      for (const entry of active.values()) entry.controller.abort()
      closeSockets()
      await new Promise<void>((done) => server.close(() => done()))
      await tail
      try { await driver.releaseInputs() } finally {
        try { await driver.close() } finally { await removeConfig?.() }
      }
    })(),
  }
}

/** Synchronous structural factory; configured IPC failures never fall back to native. */
export function createConfiguredDesktopDriver(options: ConfiguredDesktopOptions = {}): ConfiguredDesktopDriver {
  const env = options.env ?? process.env
  const configured = env.KALA_COMPUTER_USE_COMPANION_CONFIG
  if (configured === undefined) return createDesktopDriver({ ...options.nativeOptions, platform: options.platform ?? options.nativeOptions?.platform, env })
  if (!configured.trim() || configured.length > 4096) throw new Error('KALA_COMPUTER_USE_COMPANION_CONFIG must name a private companion config file')
  const path = resolve(configured)
  const platform = options.platform ?? process.platform
  const timeoutMs = boundedTimeout(options.operationTimeoutMs, 20_000)
  const owner = randomUUID()
  let closed = false
  let claimed = false
  let socket: Socket | undefined
  let config: CompanionConfig | undefined
  let connecting: Promise<Socket> | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const cancellations = new Set<string>()
  let pending: { id: string; resolve(value: unknown): void; reject(error: Error): void } | undefined
  const failConnection = (current: Socket, error: Error) => {
    if (socket !== current) return
    socket = undefined; claimed = false; connecting = undefined; cancellations.clear()
    const request = pending; pending = undefined
    request?.reject(error)
    current.destroy()
  }
  const getSocket = async () => {
    if (closed) throw new Error('Desktop companion proxy is closed')
    if (socket && !socket.destroyed) return socket
    if (connecting) return connecting
    connecting = (async () => {
      config = await readCompanionConfig(path, options)
      if (config.platform === 'linux') {
        const info = await lstat(config.endpoint)
        if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
          throw new Error('Desktop companion endpoint must be a private owner-only local socket (0600)')
        }
      }
      const current = config.platform === 'win32'
        ? connect({ host: '127.0.0.1', port: companionLoopbackPort(config.endpoint) })
        : connect(config.endpoint)
      socket = current
      current.on('error', () => failConnection(current, new Error('Cannot connect to desktop companion; start it in the opted-in logged-in user session')))
      current.on('close', () => failConnection(current, new Error('Desktop companion disconnected; acquire a new claim')))
      current.on('data', companionFrames(COMPANION_MAX_RESPONSE, (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { failConnection(current, new Error('Invalid desktop companion response')); return }
        const response = value as Record<string, unknown>
        if (typeof response.id !== 'string' || !COMPANION_ID.test(response.id) || typeof response.ok !== 'boolean'
            || Object.keys(response).some((key) => !['id', 'ok', 'result', 'error'].includes(key))) { failConnection(current, new Error('Invalid desktop companion response')); return }
        if (cancellations.delete(response.id)) return
        if (!pending || response.id !== pending.id) { failConnection(current, new Error('Unexpected desktop companion response')); return }
        const request = pending; pending = undefined
        if (response.ok) request.resolve(response.result)
        else {
          const error = response.error as Record<string, unknown> | undefined
          if (!error || typeof error.code !== 'string' || error.code.length > 40 || typeof error.message !== 'string' || error.message.length > 2048) { request.reject(new Error('Invalid desktop companion error')); current.destroy(); return }
          if (error.code === 'NOT_OWNER' || error.code === 'TIMEOUT') claimed = false
          request.reject(error.code === 'CANCELLED' ? cancelError() : new CompanionError(error.code, error.message.replaceAll(config!.token, '[redacted]')))
        }
      }, () => failConnection(current, new Error('Desktop companion response exceeds bounds or is malformed'))))
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { current.destroy(); reject(new Error('Desktop companion connection timed out')) }, timeoutMs)
        current.once('connect', () => { clearTimeout(timer); done() })
        current.once('error', () => { clearTimeout(timer); reject(new Error('Desktop companion connection failed')) })
        current.once('close', () => { clearTimeout(timer); reject(new Error('Desktop companion connection closed')) })
      })
      return current
    })()
    try { return await connecting } catch (error) { connecting = undefined; throw error }
    finally { if (socket && !socket.destroyed) connecting = undefined }
  }
  const request = async (operation: CompanionOperation, action?: DesktopInputAction, signal?: AbortSignal): Promise<unknown> => {
    checkSignal(signal)
    const current = await getSocket()
    checkSignal(signal)
    const id = randomUUID()
    const message: CompanionRequest = { version: 1, id, owner, token: config!.token, operation, ...(action ? { action } : {}) }
    const frame = Buffer.from(`${JSON.stringify(message)}\n`)
    if (frame.length > COMPANION_MAX_REQUEST) throw new Error('Desktop companion request exceeds bounds')
    return new Promise((resolveRequest, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      const timer = setTimeout(() => failConnection(current, new Error('Desktop companion request timed out; claim revoked')), timeoutMs)
      const onAbort = () => {
        if (current.destroyed || !config || cancellations.size >= 4) { failConnection(current, cancelError()); return }
        const cancellation = randomUUID()
        cancellations.add(cancellation)
        current.write(`${JSON.stringify({ version: 1, id: cancellation, owner, token: config.token, operation: 'cancel', target: id })}\n`)
      }
      pending = {
        id,
        resolve: (value) => { cleanup(); if (signal?.aborted) reject(cancelError()); else resolveRequest(value) },
        reject: (error) => { cleanup(); reject(signal?.aborted ? cancelError() : error) },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      current.write(frame)
      if (signal?.aborted) onAbort()
    })
  }
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Desktop companion proxy is closed'))
    const work = tail.then(operation)
    tail = work.catch(() => {})
    return work
  }
  const releaseClaim = () => serialize(async () => {
    if (!socket || socket.destroyed || !claimed) return
    try { await request('release') }
    catch (error) {
      if (socket) failConnection(socket, new Error('Desktop companion claim revocation failed; connection closed for cleanup'))
      throw error
    } finally { claimed = false }
  })
  return {
    acquire: () => serialize(async () => { await request('acquire'); claimed = true }),
    status: () => serialize(async () => {
      try {
        const result = await request('status')
        validateCompanionStatus(result)
        return result
      } catch (error) { return { available: false, platform, reason: error instanceof Error ? error.message.slice(0, 2048) : 'Desktop companion unavailable' } }
    }),
    screenshot: (signal) => serialize(async () => {
      checkSignal(signal)
      if (!claimed) throw new Error('Acquire the desktop companion claim before screenshot or input')
      const result = await request('screenshot', undefined, signal)
      validateCompanionScreenshot(result)
      return result
    }),
    input: (action, signal) => {
      let copy: DesktopInputAction
      try { validateCompanionAction(action); copy = { ...action } } catch (error) { return Promise.reject(error) }
      return serialize(async () => {
        checkSignal(signal)
        if (!claimed) throw new Error('Acquire the desktop companion claim before screenshot or input')
        await request('input', copy, signal)
      })
    },
    releaseInputs: () => serialize(async () => {
      if (claimed) await request('release-inputs')
    }),
    releaseClaim,
    close: async () => {
      if (closed) return
      try { await releaseClaim() } finally { closed = true; socket?.destroy(); socket = undefined; claimed = false }
    },
  }
}
