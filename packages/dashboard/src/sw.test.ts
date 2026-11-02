import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'

const workbox = vi.hoisted(() => ({
  navigation: undefined as {
    handler(options: { request: Request }): Promise<Response>
    denylist: RegExp[]
  } | undefined,
  fallback: vi.fn<() => Promise<Response>>(),
}))

vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  precacheAndRoute: vi.fn(),
  createHandlerBoundToURL: () => workbox.fallback,
}))
vi.mock('workbox-routing', () => ({
  registerRoute: vi.fn(),
  NavigationRoute: class {
    constructor(handler: (options: { request: Request }) => Promise<Response>, options: { denylist: RegExp[] }) {
      workbox.navigation = { handler, denylist: options.denylist }
    }
  },
}))
vi.mock('workbox-strategies', () => ({ StaleWhileRevalidate: vi.fn() }))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: vi.fn() }))
vi.mock('workbox-cacheable-response', () => ({ CacheableResponsePlugin: vi.fn() }))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('self', { __WB_MANIFEST: [], addEventListener: vi.fn() })
  vi.stubGlobal('fetch', vi.fn())
  await import('./sw.js')
})
afterEach(() => vi.unstubAllGlobals())

describe('authenticated PWA navigation', () => {
  it('handles navigation before the precache directory-index route can serve an expired-session shell', () => {
    expect(registerRoute).toHaveBeenCalled()
    expect(precacheAndRoute).toHaveBeenCalled()
    expect(vi.mocked(registerRoute).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(precacheAndRoute).mock.invocationCallOrder[0])
  })

  it.each([
    '/auth/login',
    '/auth/callback',
    '/signed-out',
    '/oauth/v2/authorize',
    '/oidc/v1/end_session',
    '/ui/v2/login/loginname',
    '/idps/123',
    '/saml/v2/metadata',
    '/v2/sessions',
    '/admin/v1',
    '/management/v1',
    '/zitadel.session.v2.SessionService/GetSession',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-authorization-server',
  ])('leaves %s to the network rather than rendering the Dashboard', (path) => {
    expect(workbox.navigation?.denylist.some((pattern) => pattern.test(path))).toBe(true)
  })

  it.each([302, 303, 401, 403, 503])('preserves the network response (%s), including login redirects', async (status) => {
    const response = new Response(null, { status, ...(status < 400 ? { headers: { location: '/auth/login' } } : {}) })
    vi.mocked(fetch).mockResolvedValue(response)
    const request = new Request('http://localhost/')
    expect(await workbox.navigation?.handler({ request })).toBe(response)
    expect(workbox.fallback).not.toHaveBeenCalled()
  })

  it('uses the cached shell only for an actual network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'))
    const cached = new Response('offline shell')
    workbox.fallback.mockResolvedValue(cached)
    expect(await workbox.navigation?.handler({ request: new Request('http://localhost/') })).toBe(cached)
  })
})
