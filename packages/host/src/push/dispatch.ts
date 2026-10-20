/**
 * Push dispatch loop.
 *
 * Wraps web-push.sendNotification with subscription-store bookkeeping:
 *
 * - Filters recipients by their per-kind preferences (a subscriber that
 *   didn't opt in to `approval_required` never receives one).
 * - Fans out in parallel with individual error handling — one bad endpoint
 *   never blocks the rest.
 * - 404 / 410 responses mean the subscription is dead at the browser and
 *   the store drops it. Other errors are logged but keep the subscription
 *   (transient outages of push services should not garbage-collect valid
 *   subscribers).
 *
 * The payload contract is intentionally narrow (see PushEventPayload in
 * shared/src/push.ts): title/body/url/tag only, never diff content or
 * secrets.
 */

import webpush from 'web-push'

import type { PushEventPayload, DesktopNotificationKind } from '@agent-kernel/shared/push'

import type { PushSubscriptionStorage } from './store.js'
import type { VapidKeys } from './vapid.js'

export type PushSendOutcome = {
  endpoint: string
  ok: boolean
  statusCode?: number
  message?: string
}

export type PushDispatcher = {
  /**
   * Send a notification to every subscriber whose preferences include
   * `payload.kind`. Returns the count of subscribers actually messaged.
   */
  send: (payload: PushEventPayload) => Promise<number>
  /**
   * Send to *all* subscribers regardless of per-kind preferences. Used by
   * the /push/test diagnostic route so a user with no kinds enabled can
   * still verify plumbing.
   */
  sendRaw: (payload: PushEventPayload) => Promise<number>
  /**
   * Like sendRaw but returns per-endpoint outcomes with the underlying
   * web-push status code / error message. Powers /push/test so the client
   * can display *why* delivered=0 without needing host logs.
   */
  sendRawDetailed: (payload: PushEventPayload) => Promise<PushSendOutcome[]>
  sendToDevice: (deviceId: string, payload: PushEventPayload) => Promise<PushSendOutcome[]>
  /** Diagnostic surface for the settings page. */
  status: () => Promise<{ configured: true; subscribers: number } | { configured: false }>
}

export function createPushDispatcher(input: {
  store: PushSubscriptionStorage
  vapid: VapidKeys | null
  /** Product notifications are skipped while any dashboard is actively used. */
  shouldSuppress?: () => boolean
  logger?: (message: string, meta?: Record<string, unknown>) => void
}): PushDispatcher {
  const { store, vapid } = input
  const log = input.logger ?? ((message, meta) => {
    if (meta) {
      // eslint-disable-next-line no-console
      console.warn(`[push] ${message}`, meta)
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[push] ${message}`)
    }
  })

  if (vapid) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
  }

  return {
    status: async () => vapid ? { configured: true, subscribers: await store.size() } : { configured: false },
    send: async (payload: PushEventPayload): Promise<number> => {
      if (!vapid || input.shouldSuppress?.()) return 0
      const targets = (await store.list()).filter((sub) => sub.enabled !== false && matchesKind(sub.kinds, payload.kind))
      const outcomes = await fanout(targets, payload)
      return outcomes.filter((o) => o.ok).length
    },
    sendRaw: async (payload: PushEventPayload): Promise<number> => {
      if (!vapid) return 0
      const outcomes = await fanout(await store.list(), payload)
      return outcomes.filter((o) => o.ok).length
    },
    sendRawDetailed: async (payload: PushEventPayload): Promise<PushSendOutcome[]> => {
      if (!vapid) return []
      return fanout(await store.list(), payload)
    },
    sendToDevice: async (deviceId, payload) => {
      if (!vapid) return []
      return fanout((await store.list()).filter((sub) => sub.deviceId === deviceId && sub.enabled !== false), payload)
    },
  }

  async function fanout(
    targets: readonly { endpoint: string; keys: { p256dh: string; auth: string } }[],
    payload: PushEventPayload,
  ): Promise<PushSendOutcome[]> {
      if (targets.length === 0) return []
      const body = JSON.stringify(payload)
      const results = await Promise.allSettled(
        targets.map((subscription) =>
          webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            body,
            { TTL: 60 * 60 * 24 }, // one day; after that, the event is stale
          ),
        ),
      )
      const outcomes: PushSendOutcome[] = []
      for (const [index, outcome] of results.entries()) {
        const subscription = targets[index]!
        if (outcome.status === 'fulfilled') {
          outcomes.push({ endpoint: subscription.endpoint, ok: true })
          continue
        }
        const err = outcome.reason as (Error & { statusCode?: number; body?: string }) | undefined
        const status = err?.statusCode
        if (status === 404 || status === 410) {
          await store.remove(subscription.endpoint)
          log('dropped dead subscription', { endpoint: subscription.endpoint, statusCode: status })
        } else {
          log('push send failed', {
            endpoint: subscription.endpoint,
            statusCode: status,
            message: err?.message,
          })
        }
        outcomes.push({
          endpoint: subscription.endpoint,
          ok: false,
          ...(status !== undefined ? { statusCode: status } : {}),
          ...(err?.message ? { message: err.message } : {}),
        })
      }
      return outcomes
  }
}

function matchesKind(subscribed: readonly DesktopNotificationKind[], kind: DesktopNotificationKind): boolean {
  if (subscribed.length === 0) return false
  return subscribed.includes(kind)
}
