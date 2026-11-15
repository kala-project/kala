/**
 * Web Push subscription lifecycle from the browser side.
 *
 * Called by the notification-settings dialog. Encapsulates:
 *
 * - Feature detection (SW + PushManager; iOS also requires standalone mode).
 * - Fetching the server's VAPID public key and converting it to the
 *   Uint8Array applicationServerKey PushManager expects.
 * - Subscribing (or updating an existing subscription) and POSTing to
 *   /push/subscribe with the current per-kind preferences.
 * - Unsubscribing on the browser AND on the server so we don't leave stale
 *   endpoints receiving pushes forever.
 *
 * Settings supplies its immutable target transport; other callers retain
 * the current-Origin fetch transport.
 */

import type {
  DesktopNotificationKind,
  PushSubscribeRequest,
  PushVapidKeyResponse,
} from '@agent-kernel/shared/push'

import { isStandalone } from './pwa.js'
import { pushDeviceId } from './push-activity.js'

export type PushSupport = {
  supported: boolean
  reason?: 'no_service_worker' | 'no_push_manager' | 'no_notification' | 'ios_needs_standalone'
}

export function detectPushSupport(): PushSupport {
  if (typeof window === 'undefined') return { supported: false, reason: 'no_service_worker' }
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'no_service_worker' }
  if (!('PushManager' in window)) return { supported: false, reason: 'no_push_manager' }
  if (!('Notification' in window)) return { supported: false, reason: 'no_notification' }
  // iOS 16.4+ exposes PushManager but rejects subscribe() unless the site
  // has been added to the home screen (display-mode: standalone).
  if (isIos() && !isStandalone()) return { supported: false, reason: 'ios_needs_standalone' }
  return { supported: true }
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) && !(navigator as { MSStream?: unknown }).MSStream
}

type PushRequest = (path: string, init?: RequestInit) => Promise<Response>

async function fetchVapidPublicKey(request: PushRequest): Promise<string | null> {
  const res = await request('/push/vapid-public-key', { credentials: 'same-origin', cache: 'no-store' })
  if (!res.ok) return null
  const body = (await res.json()) as PushVapidKeyResponse
  return body.publicKey ?? null
}

/**
 * Convert a URL-safe base64 VAPID public key to the Uint8Array shape
 * PushManager.subscribe expects. Standard incantation from the Web Push
 * spec examples; no external dependency needed.
 */
function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buffer
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission
  }
  return Notification.requestPermission()
}

export async function subscribeToPush(kinds: readonly DesktopNotificationKind[], request: PushRequest = fetch): Promise<
  | { ok: true; endpoint: string }
  | { ok: false; reason: 'permission_denied' | 'no_vapid' | 'subscribe_failed' | 'server_rejected'; detail?: string }
> {
  const permission = await ensureNotificationPermission()
  if (permission !== 'granted') return { ok: false, reason: 'permission_denied' }
  const publicKey = await fetchVapidPublicKey(request)
  if (!publicKey) return { ok: false, reason: 'no_vapid' }

  const registration = await navigator.serviceWorker.ready
  let subscription: PushSubscription
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  } catch (err) {
    return { ok: false, reason: 'subscribe_failed', detail: err instanceof Error ? err.message : String(err) }
  }

  const jsonSub = subscription.toJSON()
  const p256dh = jsonSub.keys?.p256dh
  const auth = jsonSub.keys?.auth
  if (!p256dh || !auth) return { ok: false, reason: 'subscribe_failed', detail: 'missing subscription keys' }

  const payload: PushSubscribeRequest = {
    endpoint: subscription.endpoint,
    keys: { p256dh, auth },
    kinds,
    deviceId: pushDeviceId(),
    deviceName: describeCurrentDevice(),
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  }
  const res = await request('/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return { ok: false, reason: 'server_rejected', detail: `HTTP ${res.status}` }
  return { ok: true, endpoint: subscription.endpoint }
}

function describeCurrentDevice(): string {
  const ua = navigator.userAgent
  const platform = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Linux computer'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${browser} on ${platform}`
}

export async function unsubscribeFromPush(request: PushRequest = fetch): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return false
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return false
  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  // Best-effort: tell the server too. Ignore failures — the browser side is
  // already gone, and the server will drop the endpoint on next dispatch
  // failure anyway.
  try {
    await request('/push/unsubscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
  } catch {}
  return true
}

export async function currentPushEndpoint(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return null
  const subscription = await registration.pushManager.getSubscription()
  return subscription?.endpoint ?? null
}
