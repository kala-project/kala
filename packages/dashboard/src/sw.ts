/// <reference lib="webworker" />
/**
 * Kala service worker.
 *
 * Scope + strategy (see docs/planning/roadmap-notes/pwa-mobile-and-push.md
 * §3.4 and §4.1):
 *
 * - App shell (hashed assets/*, index.html, manifest, icons, fonts) is
 *   precached by workbox from the injected manifest.
 * - Navigations fall back to index.html for SPA routes, but denylist all
 *   host RPC surfaces so the SW never intercepts socket.io upgrades or
 *   long-lived API calls.
 * - Host API, Socket.IO, and session data are always network-owned. The
 *   service worker never turns stale runtime data into an apparent live view.
 * - Push handler (commit 4/5) will land alongside — this file is shared
 *   between "make it installable" and "make push work".
 *
 * Wait-then-activate: never skipWaiting. The registration prompts the user
 * (see src/lib/pwa.ts + BannerStack).
 */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

const APP_SHELL_URL = '/index.html'
const RUNTIME_ICON_CACHE = 'ak-icons-v1'

// Precache the app shell + hashed assets. `__WB_MANIFEST` is replaced by
// vite-plugin-pwa at build time with the actual file list.
cleanupOutdatedCaches()

// Host RPC and external consoles must never use the cached SPA shell.
const NETWORK_NAVIGATION_DENYLIST: RegExp[] = [
  /^\/socket\.io(\/|$)/,
  /^\/admin\/socket\.io(\/|$)/,
  /^\/silo(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/models(\/|$)/,
  /^\/settings(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/artifacts(\/|$)/,
  /^\/eval(\/|$)/,
  /^\/enhancement(\/|$)/,
  /^\/router(\/|$)/,
  /^\/push(\/|$)/,
  /^\/api(\/|$)/,
  /^\/events(\/|$)/,
  /^\/runtime(\/|$)/,
  /^\/signed-out$/,
  /^\/oauth(\/|$)/,
  /^\/oidc(\/|$)/,
  /^\/ui(\/|$)/,
  /^\/idps(\/|$)/,
  /^\/saml(\/|$)/,
  /^\/v2(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/management(\/|$)/,
  /^\/zitadel\./,
  /^\/\.well-known\/(openid-configuration|oauth-authorization-server)$/,
  /^\/debug\/(healthz|ready)$/,
]

registerRoute(
  new NavigationRoute(async (options) => {
    // A cached HTML shell can reference lazy chunks removed by an immutable
    // deployment. Prefer the current network shell whenever online; use the
    // precache only as an actual offline fallback.
    try {
      return await fetch(options.request, { cache: 'no-store' })
    } catch {
      // Offline: fall through to the precached shell.
    }
    return await createHandlerBoundToURL(APP_SHELL_URL)(options)
  }, {
    denylist: NETWORK_NAVIGATION_DENYLIST,
  }),
)

// Directory-index precaching also matches "/"; navigation must run first so
// expired sessions follow the server's login redirect instead of a cached shell.
precacheAndRoute(self.__WB_MANIFEST)

// Icons + manifest served under /icons/**. StaleWhileRevalidate — never
// blocks paint, always refreshes in the background.
registerRoute(
  ({ url }) => url.pathname.startsWith('/icons/'),
  new StaleWhileRevalidate({
    cacheName: RUNTIME_ICON_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
)

// Allow the client (via workbox-window messageSkipWaiting) to activate a new
// SW on demand — the user-facing "Reload" button in the update banner sends
// this message after we caught the waiting worker in registerSW.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
  if (event.data?.type === 'AUTH_LOGOUT') {
    event.waitUntil((async () => {
      const delivered = await self.registration.getNotifications()
      delivered.forEach((notification) => notification.close())
      await caches.delete(RUNTIME_ICON_CACHE)
    })())
  }
})

// Kill-switch route: hitting /__sw_kill triggers self-unregistration,
// covering the case where the SW itself is the cause of a bad user
// experience (bad cache, buggy handler) and we need a URL to recover.
registerRoute(
  ({ url }) => url.pathname === '/__sw_kill',
  async () => {
    await self.registration.unregister()
    const clients = await self.clients.matchAll()
    clients.forEach((client) => client.postMessage({ type: 'SW_UNREGISTERED' }))
    return new Response('unregistered', { status: 200 })
  },
)

// -------- Web Push (see docs/planning/roadmap-notes/pwa-mobile-and-push.md §5.3) --------

type PushEventBody = {
  kind: string
  sessionId?: string
  title: string
  body: string
  url: string
  tag?: string
  icon?: string
}

self.addEventListener('push', (event) => {
  // Missing / non-JSON payload → still show something so the user at least
  // knows we tried to notify. Browsers require userVisibleOnly=true which
  // means every push MUST result in a visible notification.
  let payload: PushEventBody
  try {
    payload = event.data?.json() as PushEventBody
  } catch {
    payload = {
      kind: 'unknown',
      title: 'Kala',
      body: 'You have a new notification.',
      url: '/',
    }
  }
  const tag = payload.tag ?? payload.kind
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Kala', {
      body: payload.body ?? '',
      tag,
      // renotify + requireInteraction are widely supported but not in the
      // ambient lib.webworker.d.ts NotificationOptions. Cast to keep TS
      // happy without dropping the fields at runtime.
      ...({
        renotify: payload.kind === 'approval_required',
        requireInteraction: payload.kind === 'approval_required',
      } as unknown as NotificationOptions),
      icon: payload.icon ?? '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data: {
        url: payload.url ?? '/',
        kind: payload.kind,
        sessionId: payload.sessionId,
      },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data as { url?: string } | null)?.url ?? '/'
  event.waitUntil(
    (async () => {
      // A notification tap means the user has entered the app. Dismiss every
      // delivered notification from this registration so iOS can recompute its
      // Home Screen badge instead of retaining stale notification-center count.
      const delivered = await self.registration.getNotifications()
      delivered.forEach((notification) => notification.close())
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // If a dashboard tab is already open, focus it and let the page handle
      // the deep-link via postMessage (avoids a full reload that would drop
      // any composer draft or open panel state).
      const existing = clients.find((client) => {
        try {
          return new URL(client.url).origin === self.location.origin
        } catch {
          return false
        }
      })
      if (existing) {
        await (existing as WindowClient).focus()
        existing.postMessage({ type: 'PUSH_NAVIGATE', url: target })
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})
