import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfiguredSecretResolver, createSecretEnvironmentReader, OpenBaoJWTSecretResolver } from './secret-resolver.js'

const options = { origin: 'https://secret-resolver.example', authMount: 'workload', role: 'runtime', jwtFile: '/unused', kvMount: 'kala' }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('server-only secret boundary', () => {
  it('requires explicit external selection, canonical references and verified HTTPS outside opt-in loopback', async () => {
    expect(createConfiguredSecretResolver({})).toBeUndefined()
    expect(() => createConfiguredSecretResolver({ KALA_SECRET_RESOLVER: 'unknown' })).toThrow('configuration')
    for (const origin of ['http://secret-resolver.example',
      'https://secret-resolver.example/path', 'https://secret-resolver.example?query=1', 'https://secret-resolver.example/#hash']) {
      expect(() => new OpenBaoJWTSecretResolver({ ...options, origin, allowLoopbackHttp: true })).toThrow('configuration')
    }
    expect(() => new OpenBaoJWTSecretResolver({ ...options, origin: 'http://127.0.0.1' })).toThrow('configuration')
    expect(() => new OpenBaoJWTSecretResolver({ ...options, origin: 'http://127.0.0.1', allowLoopbackHttp: true })).not.toThrow()
    const resolver = new OpenBaoJWTSecretResolver(options)
    for (const reference of ['file:secret', 'bao:../secret#key', 'bao:providers/%2fsecret#key', 'bao:/providers/key#key', 'bao:a#b#c']) {
      await expect(resolver.resolve(reference)).rejects.toMatchObject({ reason: 'configuration' })
    }
    const reader = createSecretEnvironmentReader({ KEY: 'value', KEY_REF: 'bao:provider#key' })
    await expect(reader('KEY')).rejects.toThrow('mutually exclusive')
    await expect(createSecretEnvironmentReader({ KEY_REF: 'bao:provider#key' })('KEY')).rejects.toThrow('configuration')
  })

  it('shares short logins, never caches values, expires leases, and redacts bounded transport failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kala-secret-unit-'))
    const jwtFile = join(directory, 'jwt')
    await writeFile(jwtFile, 'fixture-identity', { mode: 0o600 })
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let logins = 0
    let reads = 0
    let behavior: 'normal' | 'denied' | 'oversized' | 'long-lease' | 'redirect' = 'normal'
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      if (init.method === 'POST') {
        logins++
        return Response.json({ auth: { client_token: 'fixture-token', lease_duration: behavior === 'long-lease' ? 3600 : 30 } })
      }
      reads++
      if (behavior === 'denied') return new Response('sensitive-external-error-body', { status: 403 })
      if (behavior === 'oversized') return new Response('x'.repeat(256 * 1024 + 1))
      if (behavior === 'redirect') throw new TypeError('sensitive-transport-details')
      return Response.json({ data: { data: { key: `value-${reads}` } } })
    })
    vi.stubGlobal('fetch', fetch)
    const resolver = new OpenBaoJWTSecretResolver({ ...options, jwtFile })
    try {
      expect((await Promise.all([resolver.resolve('bao:providers/key#key'), resolver.resolve('bao:providers/key#key')])).sort())
        .toEqual(['value-1', 'value-2'])
      expect(logins).toBe(1)
      now += 30_000
      await resolver.resolve('bao:providers/key#key')
      expect(logins).toBe(2)
      behavior = 'denied'
      await expect(resolver.resolve('bao:providers/key#key')).rejects.toMatchObject({ reason: 'denied', message: 'Secret resolution denied' })
      expect(logins).toBe(2) // No automatic reauthentication after a denied KV request.
      behavior = 'oversized'
      await expect(resolver.resolve('bao:providers/key#key')).rejects.toMatchObject({ reason: 'unavailable' })
      behavior = 'redirect'
      await expect(resolver.resolve('bao:providers/key#key')).rejects.toMatchObject({ message: 'Secret resolution unavailable' })
      behavior = 'long-lease'
      await expect(resolver.resolve('bao:providers/key#key')).rejects.toMatchObject({ reason: 'configuration' })
      const count = fetch.mock.calls.length
      const controller = new AbortController()
      controller.abort()
      await expect(resolver.resolve('bao:providers/key#key', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetch).toHaveBeenCalledTimes(count)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
