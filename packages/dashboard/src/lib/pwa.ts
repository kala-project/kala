/**
 * PWA registration + update prompt.
 *
 * vite-plugin-pwa exposes `virtual:pwa-register` — a tiny wrapper around
 * workbox-window that reports when a new SW is waiting and when the app is
 * ready to run offline. We drive both signals through explicit callbacks
 * so the surrounding UI (BannerStack) decides how to present them.
 *
 * Rules the callbacks encode (see docs/planning/roadmap-notes/pwa-mobile-
 * and-push.md §4.2):
 *
 * - `registerType: 'prompt'` keeps activation under this controller's control.
 *   A waiting worker is activated immediately because a mixed Dashboard
 *   generation can keep a page connected while its actions no longer match
 *   the served assets. Composer drafts are persisted per Session before this
 *   controlled reload.
 * - Long-open tabs schedule a low-frequency update check so they converge on
 *   an independently deployed Dashboard without operator intervention.
 * - We register only in production builds. In `vite dev` the plugin is
 *   disabled, so `virtual:pwa-register` synchronously returns a no-op —
 *   but we still guard on `import.meta.env.PROD` to be explicit.
 */

import { isDesktopClient } from './desktop.js'

export type PwaLifecycleHandlers = {
  onNeedRefresh: () => void
  onOfflineReady: () => void
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
  onRegisterError?: (error: unknown) => void
}

export type PwaController = {
  /** Send SKIP_WAITING to the waiting worker and reload once it activates. */
  applyUpdate: () => Promise<void>
  /** Remove stale worker/cache state and load the current network shell. */
  forceRefresh: () => Promise<void>
  /** Manually trigger an update check. */
  checkForUpdate: () => Promise<void>
}

const NOOP_CONTROLLER: PwaController = {
  applyUpdate: async () => {},
  forceRefresh: async () => {},
  checkForUpdate: async () => {},
}

export const UPDATE_POLL_INTERVAL_MS = 30 * 60_000
const UPDATE_DEDUPE_MS = 5_000
export const UPDATE_RELOAD_TIMEOUT_MS = 5_000

/**
 * Activate the waiting worker, then reload as soon as it controls this page.
 * The timeout is a recovery path for browsers that lose Workbox's controlling
 * event (seen after long-lived iOS/PWA tabs); the update button must never stay
 * in an unbounded "Reloading…" state.
 */
export async function activatePwaUpdate(options: {
  sendSkipWaiting(): Promise<void>
  serviceWorker: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>
  reload(): void
  timeoutMs?: number
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? UPDATE_RELOAD_TIMEOUT_MS
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveControl: (() => void) | undefined
  const controlled = new Promise<void>((resolve) => { resolveControl = resolve })
  const finish = (): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    options.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    resolveControl?.()
  }
  const onControllerChange = (): void => finish()
  options.serviceWorker.addEventListener('controllerchange', onControllerChange)
  timer = setTimeout(finish, timeoutMs)
  try {
    await options.sendSkipWaiting()
    await controlled
  } finally {
    finish()
  }
  options.reload()
}

export function initPwa(handlers: PwaLifecycleHandlers): PwaController {
  if (isDesktopClient()) return NOOP_CONTROLLER
  if (typeof window === 'undefined') return NOOP_CONTROLLER
  if (!('serviceWorker' in navigator)) return NOOP_CONTROLLER
  // In dev the vite-plugin-pwa virtual module is intentionally a no-op, but
  // the import still resolves. Guard on PROD anyway so we never register a
  // worker against a Vite dev server (which would break HMR).
  if (!import.meta.env.PROD) return NOOP_CONTROLLER
  const bootUrl = new URL(window.location.href)
  const forcedRefresh = bootUrl.searchParams.has(FORCE_REFRESH_PARAMETER)
  if (forcedRefresh) {
    bootUrl.searchParams.delete(FORCE_REFRESH_PARAMETER)
    window.history.replaceState(window.history.state, '', bootUrl.toString())
  }

  let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined
  let reloading = false
  const reloadOnce = (): void => {
    if (reloading) return
    reloading = true
    window.location.reload()
  }
  const notifyWaitingUpdate = async (): Promise<void> => {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration?.waiting) return
    if (forcedRefresh) {
      await activateWaitingWorker(registration.waiting)
      reloadOnce()
    } else handlers.onNeedRefresh()
  }
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let lastUpdateCheckAt = 0
  let updateCheck: Promise<void> | null = null
  const checkRegistration = (registration: ServiceWorkerRegistration, force = false): Promise<void> => {
    const now = Date.now()
    if (updateCheck) return updateCheck
    if (!force && now - lastUpdateCheckAt < UPDATE_DEDUPE_MS) return Promise.resolve()
    lastUpdateCheckAt = now
    updateCheck = registration.update().then(() => undefined, () => undefined).finally(() => { updateCheck = null })
    return updateCheck
  }

  const load = async (): Promise<void> => {
    try {
      // The virtual module is generated by vite-plugin-pwa at build time.
      // Dynamic import so tests can execute this file without the plugin.
      const mod = await import(/* @vite-ignore */ 'virtual:pwa-register')
      updateSW = mod.registerSW({
        immediate: true,
        // Other tabs also need the new shell when a worker takes control.
        // Share the guard with explicit activation to avoid two reloads.
        onNeedReload: reloadOnce,
        onNeedRefresh: () => {
          // Workbox can report an external installation without a waiting
          // update, particularly after unregistering during force refresh.
          void notifyWaitingUpdate().catch((error) => handlers.onRegisterError?.(error))
        },
        onOfflineReady: () => handlers.onOfflineReady(),
        onRegisteredSW: (_url: string, registration: ServiceWorkerRegistration | undefined) => {
          handlers.onRegistered?.(registration)
          if (registration) {
            const scheduleUpdateCheck = (): void => {
              if (pollTimer) clearTimeout(pollTimer)
              pollTimer = setTimeout(() => {
                pollTimer = undefined
                // Ignore rejections: a transient network failure just means we
                // retry in 30 minutes.
                void checkRegistration(registration, true).finally(scheduleUpdateCheck)
              }, UPDATE_POLL_INTERVAL_MS)
            }
            scheduleUpdateCheck()
            // Trigger an immediate update check whenever the tab regains
            // visibility (returning from another app, unlocking the phone,
            // switching back from a background tab). This catches new
            // deploys in ~seconds instead of ~minutes in the common case
            // where the user briefly left the app.
            const onVisibility = (): void => {
              if (document.visibilityState !== 'visible') return
              void checkRegistration(registration)
            }
            document.addEventListener('visibilitychange', onVisibility)
            // Same idea for `focus`, which fires in browsers where
            // visibilitychange doesn't (some older WebKit standalone builds).
            window.addEventListener('focus', onVisibility)
          }
        },
        onRegisterError: (error: unknown) => handlers.onRegisterError?.(error),
      })
    } catch (error) {
      handlers.onRegisterError?.(error)
    }
  }

  void load()

  // The SW notificationclick handler posts { type: 'PUSH_NAVIGATE', url }
  // when the user taps a notification and an existing tab is focused
  // instead of opening a new window. Route the deep-link into the app's
  // hash router so the same code path handles both entry modes.
  const onSwMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; url?: string } | null
    if (!data || data.type !== 'PUSH_NAVIGATE' || typeof data.url !== 'string') return
    try {
      const url = new URL(data.url, window.location.origin)
      if (url.hash) {
        window.location.hash = url.hash
      } else if (url.pathname && url.pathname !== window.location.pathname) {
        window.location.href = url.toString()
      }
    } catch {
      // Malformed URL from a stale SW — ignore.
    }
  }
  navigator.serviceWorker.addEventListener('message', onSwMessage)

  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearTimeout(pollTimer)
    navigator.serviceWorker.removeEventListener('message', onSwMessage)
  })

  return {
    applyUpdate: async () => {
      if (!updateSW) return
      await activatePwaUpdate({
        // Manage reload ourselves instead of waiting indefinitely for the
        // virtual module's Workbox `controlling` callback.
        sendSkipWaiting: () => updateSW!(false),
        serviceWorker: navigator.serviceWorker,
        reload: reloadOnce,
      })
    },
    forceRefresh: async () => {
      reloading = true
      try {
        await forcePwaRefresh()
      } catch (error) {
        reloading = false
        handlers.onRegisterError?.(error)
        throw error
      }
    },
    checkForUpdate: async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration) await checkRegistration(registration, true)
    },
  }
}

export const FORCE_REFRESH_PARAMETER = '__kala_refresh'

export async function activateWaitingWorker(
  worker: Pick<ServiceWorker, 'state' | 'postMessage' | 'addEventListener' | 'removeEventListener'>,
  timeoutMs = UPDATE_RELOAD_TIMEOUT_MS,
): Promise<void> {
  if (worker.state === 'activated') return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', changed)
    }
    const changed = (): void => {
      if (worker.state === 'activated') { cleanup(); resolve() }
      else if (worker.state === 'redundant') { cleanup(); reject(new Error('Dashboard update was superseded before activation')) }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Dashboard update activation timed out'))
    }, timeoutMs)
    worker.addEventListener('statechange', changed)
    try {
      worker.postMessage({ type: 'SKIP_WAITING' })
      changed()
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export async function forcePwaRefresh(options: {
  serviceWorker?: ServiceWorkerContainer
  cacheStorage?: Pick<CacheStorage, 'keys' | 'delete'>
  location?: Pick<Location, 'href' | 'replace'>
  nonce?: string
} = {}): Promise<void> {
  const serviceWorker = options.serviceWorker ?? navigator.serviceWorker
  const cacheStorage = options.cacheStorage ?? caches
  const locationValue = options.location ?? window.location
  const registration = await serviceWorker.getRegistration().catch(() => undefined)
  // Unregistering first can leave another tab's old worker active and reinstall
  // the same waiting update on every refresh.
  if (registration?.waiting) await activateWaitingWorker(registration.waiting)
  await registration?.unregister()
  const cacheNames = await cacheStorage.keys().catch(() => [])
  await Promise.all(cacheNames
    .filter((name) => name.startsWith('workbox-precache') || name.startsWith('ak-'))
    .map((name) => cacheStorage.delete(name)))
  const url = new URL(locationValue.href)
  url.searchParams.set(FORCE_REFRESH_PARAMETER, options.nonce ?? String(Date.now()))
  locationValue.replace(url.toString())
}

/**
 * Standalone-mode detection. Used to hide "add to home screen" hints once
 * the app is already installed, and to gate iOS-only push flows (iOS 16.4+
 * only allows PushManager.subscribe when display-mode === 'standalone').
 */
export function isStandalone(input: {
  matches?: boolean
  navigatorStandalone?: boolean
} = {}): boolean {
  if (input.matches !== undefined || input.navigatorStandalone !== undefined) {
    return input.matches === true || input.navigatorStandalone === true
  }
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // Legacy iOS Safari — property is non-standard but still present in iOS 17.
  const nav = navigator as unknown as { standalone?: boolean }
  return nav.standalone === true
}
