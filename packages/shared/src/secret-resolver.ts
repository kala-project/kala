// Node-only composition-root API. Deliberately not exported from the browser-facing root.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

export interface SecretResolver { resolve(reference: string, signal?: AbortSignal): Promise<string> }
export class SecretResolutionError extends Error {
  constructor(readonly reason: 'configuration' | 'denied' | 'unavailable') {
    super(`Secret resolution ${reason}`)
    this.name = 'SecretResolutionError'
  }
}

type Login = { token: string; expiresAt: number; identity: string }
const segment = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u
const validSegment = (s: string) => segment.test(s) && s.length <= 128
const unavailable = () => new SecretResolutionError('unavailable')

// A cancelled caller must not cancel another caller's shared workload login.
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable())
    if (signal.aborted) { reject(unavailable()); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export type OpenBaoJWTOptions = {
  origin: string
  authMount: string
  role: string
  jwtFile: string
  kvMount: string
  /** Explicit isolated evaluation only; never permits non-loopback HTTP. */
  allowLoopbackHttp?: boolean
}

export class OpenBaoJWTSecretResolver implements SecretResolver {
  private readonly origin: string
  private login?: Login
  private pending?: { identity: string; promise: Promise<Login> }

  constructor(private readonly options: OpenBaoJWTOptions) {
    let url: URL
    try { url = new URL(options.origin) } catch { throw new SecretResolutionError('configuration') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(options.allowLoopbackHttp && loopback && url.protocol === 'http:'))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !validSegment(options.authMount) || !validSegment(options.kvMount)
      || !validSegment(options.role) || !options.jwtFile.trim()) throw new SecretResolutionError('configuration')
    this.origin = url.origin
  }

  async resolve(reference: string, parentSignal?: AbortSignal): Promise<string> {
    // Mount/role/authority are operator configuration, never selected by a reference.
    const match = /^bao:([^#]+)#([^#]+)$/u.exec(reference)
    const path = match?.[1]?.split('/')
    const field = match?.[2]
    if (!path || path.length > 16 || !path.every(validSegment) || !field || !validSegment(field)) {
      throw new SecretResolutionError('configuration')
    }
    const deadline = AbortSignal.timeout(5_000)
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline
    try {
      signal.throwIfAborted()
      const info = await waitFor(stat(this.options.jwtFile), signal)
      if (!info.isFile() || info.size > 64 * 1024) throw unavailable()
      const jwt = (await waitFor(readFile(this.options.jwtFile, { encoding: 'utf8', signal }), signal)).trim()
      signal.throwIfAborted()
      if (!jwt || Buffer.byteLength(jwt) > 64 * 1024) throw unavailable()
      const identity = createHash('sha256').update(jwt).digest('hex')
      const login = await waitFor(this.getLogin(jwt, identity), signal)
      signal.throwIfAborted()
      const result = await this.request(`/${this.options.kvMount}/data/${path.map(encodeURIComponent).join('/')}`, {
        headers: { 'X-Vault-Token': login.token }, signal,
      })
      const value = result?.data?.data?.[field]
      if (typeof value !== 'string' || !value.trim()) throw new SecretResolutionError('denied')
      return value.trim()
    } catch (error) {
      this.login = undefined
      if (parentSignal?.aborted) throw new DOMException('Secret resolution cancelled', 'AbortError')
      // Do not expose file paths, JWTs, secret values or external error bodies/causes.
      throw error instanceof SecretResolutionError ? error : unavailable()
    }
  }

  private getLogin(jwt: string, identity: string): Promise<Login> {
    if (this.login?.identity === identity && this.login.expiresAt > Date.now()) return Promise.resolve(this.login)
    if (this.pending?.identity === identity) return this.pending.promise
    const promise = this.authenticate(jwt, identity)
    this.pending = { identity, promise }
    void promise.finally(() => {
      if (this.pending?.promise === promise) this.pending = undefined
    }).catch(() => {})
    return promise
  }

  private async authenticate(jwt: string, identity: string): Promise<Login> {
    const started = Date.now()
    const result = await this.request(`/auth/${this.options.authMount}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: this.options.role, jwt }), signal: AbortSignal.timeout(5_000),
    })
    const token = result?.auth?.client_token
    const lease = result?.auth?.lease_duration
    if (typeof token !== 'string' || !token || typeof lease !== 'number' || !Number.isFinite(lease) || lease <= 0) throw unavailable()
    if (lease > 60) throw new SecretResolutionError('configuration')
    const login = { token, identity, expiresAt: started + Math.max(0, Math.min(60_000, lease * 1000) - 1000) }
    this.login = login
    return login
  }

  private async request(path: string, init: RequestInit): Promise<{ auth?: { client_token?: unknown; lease_duration?: unknown }; data?: { data?: Record<string, unknown> } }> {
    try {
      const response = await fetch(`${this.origin}/v1${path}`, { ...init, redirect: 'error' })
      if (!response.ok) {
        await response.body?.cancel()
        throw new SecretResolutionError([400, 401, 403, 404].includes(response.status) ? 'denied' : 'unavailable')
      }
      const reader = response.body?.getReader()
      if (!reader) throw unavailable()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 256 * 1024) throw unavailable()
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) { throw error instanceof SecretResolutionError ? error : unavailable() }
  }
}

/** Explicit selection; absent means the caller's existing local adapter, not external fallback. */
export function createConfiguredSecretResolver(environment: NodeJS.ProcessEnv): SecretResolver | undefined {
  const mode = environment.KALA_SECRET_RESOLVER?.trim()
  if (!mode) return undefined
  if (mode !== 'openbao-jwt') throw new SecretResolutionError('configuration')
  const required = (name: string) => {
    const value = environment[name]?.trim()
    if (!value) throw new SecretResolutionError('configuration')
    return value
  }
  return new OpenBaoJWTSecretResolver({
    origin: required('KALA_OPENBAO_ADDR'), authMount: required('KALA_OPENBAO_AUTH_MOUNT'),
    role: required('KALA_OPENBAO_ROLE'), jwtFile: required('KALA_OPENBAO_JWT_FILE'),
    kvMount: required('KALA_OPENBAO_KV_MOUNT'),
    allowLoopbackHttp: environment.KALA_OPENBAO_ALLOW_LOOPBACK_HTTP === '1',
  })
}

/** Bootstrap reads stay pinned by their consumers; this API does not rotate existing pools. */
export function createSecretEnvironmentReader(environment: NodeJS.ProcessEnv = process.env) {
  let resolver: SecretResolver | undefined
  return async (name: string, signal?: AbortSignal): Promise<string> => {
    const direct = environment[name]?.trim()
    const file = environment[`${name}_FILE`]?.trim()
    const reference = environment[`${name}_REF`]?.trim()
    if ([direct, file, reference].filter(Boolean).length > 1) throw new Error(`${name}, ${name}_FILE and ${name}_REF are mutually exclusive`)
    if (reference) {
      resolver ??= createConfiguredSecretResolver(environment)
      if (!resolver) throw new SecretResolutionError('configuration')
      return resolver.resolve(reference, signal)
    }
    const value = direct || (file ? (await readFile(file, { encoding: 'utf8', signal })).trim() : '')
    if (!value) throw new Error(`${name}, ${name}_FILE or ${name}_REF is required`)
    return value
  }
}
