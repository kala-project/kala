/**
 * HTTP endpoints for Web Push subscription management.
 *
 * Three URLs, all under /push, all JSON:
 *
 *   GET   /push/vapid-public-key   → { publicKey } for pushManager.subscribe()
 *   POST  /push/subscribe          → upsert PushSubscriptionRecord
 *   POST  /push/unsubscribe        → { endpoint } removes the subscription
 *
 * Deliberately minimal: no per-kind PATCH — the client sends a fresh
 * subscribe with the current preferences whenever prefs change. This keeps
 * the server-side state trivially eventually-consistent with the browser.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  PushDevice,
  PushSubscribeRequest,
  PushVapidKeyResponse,
} from '@agent-kernel/shared/push'
import { DESKTOP_NOTIFICATION_KINDS } from '@agent-kernel/shared/push'

import type { PushDispatcher } from './dispatch.js'
import { deviceNameFromUserAgent, pushDeviceIdForEndpoint, type PushSubscriptionStorage } from './store.js'
import type { VapidKeys } from './vapid.js'
import type { PushActivityTracker } from './activity.js'

type PushHttpContext = {
  store: PushSubscriptionStorage
  vapid: VapidKeys | null
  dispatcher: PushDispatcher
  activity: PushActivityTracker
}

export type PushRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

export function createPushRoutes(ctx: PushHttpContext): PushRouteHandler {
  return async (req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]?.split('#')[0] ?? ''
    if (!path.startsWith('/push/')) return false

    if (path === '/push/vapid-public-key' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body: PushVapidKeyResponse = { publicKey: ctx.vapid?.publicKey ?? null }
      sendJson(res, 200, body)
      return true
    }
    if (path === '/push/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Diagnostic: lets the settings UI show whether the host knows about
      // any subscribers at all. When users report "I don't receive pushes"
      // the first question is always "does the store even have your
      // endpoint" — surface it instead of forcing an SSH into the box.
      const status = await ctx.dispatcher.status()
      const subscribers = status.configured ? status.subscribers : 0
      sendJson(res, 200, { configured: status.configured, subscribers })
      return true
    }
    if (path === '/push/devices' && req.method === 'GET') {
      const currentDeviceId = new URL(url, 'http://localhost').searchParams.get('currentDeviceId')
      const devices: PushDevice[] = (await ctx.store.list()).map((record) => ({
        deviceId: record.deviceId ?? pushDeviceIdForEndpoint(record.endpoint),
        name: record.deviceName ?? deviceNameFromUserAgent(record.userAgent),
        enabled: record.enabled !== false,
        current: currentDeviceId !== null && record.deviceId === currentDeviceId,
        lastSeenAt: record.updatedAt,
        ...(record.userAgent ? { userAgent: record.userAgent } : {}),
      }))
      sendJson(res, 200, { devices })
      return true
    }
    if (path === '/push/device' && req.method === 'PATCH') {
      const body = await readJson<{ deviceId?: unknown; enabled?: unknown; name?: unknown }>(req)
      if (typeof body?.deviceId !== 'string') {
        sendJson(res, 400, { error: 'missing deviceId' })
        return true
      }
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : undefined
      const changed = await ctx.store.updateDevice(body.deviceId, {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(name ? { name } : {}),
      })
      sendJson(res, changed ? 200 : 404, { ok: changed })
      return true
    }
    if (path === '/push/device' && req.method === 'DELETE') {
      const body = await readJson<{ deviceId?: unknown }>(req)
      if (typeof body?.deviceId !== 'string') {
        sendJson(res, 400, { error: 'missing deviceId' })
        return true
      }
      sendJson(res, 200, { ok: true, removed: await ctx.store.removeDevice(body.deviceId) })
      return true
    }
    if (path === '/push/test' && req.method === 'POST') {
      // Fires a single notification to every current subscriber (usually
      // just the caller). Bypasses the per-kind filter so users can verify
      // the pipeline end-to-end from Settings even before an approval /
      // waiting event happens. Returns per-endpoint outcomes so a "delivered:0"
      // is immediately explainable from the client without SSHing into the
      // host to read logs.
      const body = await readJson<{ deviceId?: unknown }>(req)
      const payload = {
        kind: 'session_error',
        sessionId: 'test',
        title: 'Kala test notification',
        body: 'Notifications are working on this device.',
        url: '/',
        tag: 'ak-test-push',
      } as const
      const outcomes = typeof body?.deviceId === 'string'
        ? await ctx.dispatcher.sendToDevice(body.deviceId, payload)
        : await ctx.dispatcher.sendRawDetailed(payload)
      sendJson(res, 200, {
        ok: true,
        delivered: outcomes.filter((o) => o.ok).length,
        outcomes,
      })
      return true
    }
    if (path === '/push/activity' && req.method === 'POST') {
      const body = await readJson<{ deviceId?: unknown; active?: unknown }>(req)
      if (typeof body?.deviceId !== 'string' || body.deviceId.length < 8 || body.deviceId.length > 128 || typeof body.active !== 'boolean') {
        sendJson(res, 400, { error: 'invalid activity payload' })
        return true
      }
      ctx.activity.update(body.deviceId, body.active)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (path === '/push/subscribe' && req.method === 'POST') {
      const parsed = await parseSubscribeBody(req)
      if (!parsed) {
        sendJson(res, 400, { error: 'invalid subscription payload' })
        return true
      }
      const now = new Date().toISOString()
      const existing = (await ctx.store.list()).find((r) => r.endpoint === parsed.endpoint)
      await ctx.store.upsert({
        endpoint: parsed.endpoint,
        keys: parsed.keys,
        kinds: parsed.kinds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(parsed.ownerId ? { ownerId: parsed.ownerId } : {}),
        ...(parsed.userAgent ? { userAgent: parsed.userAgent } : {}),
        ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}),
        ...(parsed.deviceName ? { deviceName: parsed.deviceName } : {}),
        enabled: existing?.enabled ?? true,
      })
      sendJson(res, 200, { ok: true, subscribers: await ctx.store.size() })
      return true
    }
    if (path === '/push/unsubscribe' && req.method === 'POST') {
      const body = await readJson<{ endpoint?: unknown }>(req)
      const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : null
      if (!endpoint) {
        sendJson(res, 400, { error: 'missing endpoint' })
        return true
      }
      const removed = await ctx.store.remove(endpoint)
      sendJson(res, 200, { ok: true, removed })
      return true
    }
    return false
  }
}

async function parseSubscribeBody(req: IncomingMessage): Promise<PushSubscribeRequest | null> {
  const body = await readJson<Partial<PushSubscribeRequest>>(req)
  if (!body || typeof body.endpoint !== 'string') return null
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((kind): kind is PushSubscribeRequest['kinds'][number] =>
        typeof kind === 'string' && (DESKTOP_NOTIFICATION_KINDS as readonly string[]).includes(kind),
      )
    : []
  return {
    endpoint: body.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    kinds,
    ...(typeof body.ownerId === 'string' ? { ownerId: body.ownerId } : {}),
    ...(typeof body.userAgent === 'string' ? { userAgent: body.userAgent } : {}),
    ...(typeof body.deviceId === 'string' ? { deviceId: body.deviceId } : {}),
    ...(typeof body.deviceName === 'string' ? { deviceName: body.deviceName } : {}),
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.byteLength, 0) > 64 * 1024) {
      return null
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(encoded)),
    'cache-control': 'no-store',
  })
  res.end(encoded)
}
