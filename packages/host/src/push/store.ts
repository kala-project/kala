/**
 * Web Push subscription store.
 *
 * Persists browser Push Subscription objects to a JSONL file next to the
 * session store (same convention as workspace-aliases.json). One line per
 * subscription; the endpoint URL is the primary key. Replacing a
 * subscription (same endpoint, new keys/prefs) rewrites the file in place.
 *
 * The JSONL layout keeps the format append-friendly for debugging and
 * survives partial writes — a corrupt tail just loses the last few
 * subscriptions rather than the whole store.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

import type { DesktopNotificationKind } from '@agent-kernel/shared/push'

export type PushSubscriptionRecord = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** ISO timestamp when the subscription was first stored. */
  createdAt: string
  /** ISO timestamp when the subscription was last confirmed by the client. */
  updatedAt: string
  /** Opaque client-supplied identifier; scopes subscriptions to a user/session. */
  ownerId?: string
  /** Which notification kinds this subscriber wants to receive. */
  kinds: readonly DesktopNotificationKind[]
  /** Optional UA string; helps triage when dropping stale subscriptions. */
  userAgent?: string
  deviceId?: string
  deviceName?: string
  enabled?: boolean
}

export type PushStorageResult<T> = T | Promise<T>

/** Storage authority used by push routes and dispatch. Implementations may be local/sync or remote/async. */
export interface PushSubscriptionStorage {
  list(): PushStorageResult<readonly PushSubscriptionRecord[]>
  upsert(record: PushSubscriptionRecord): PushStorageResult<void>
  remove(endpoint: string): PushStorageResult<boolean>
  updateDevice(deviceId: string, update: { enabled?: boolean; name?: string }): PushStorageResult<boolean>
  removeDevice(deviceId: string): PushStorageResult<boolean>
  size(): PushStorageResult<number>
}

export class PushSubscriptionStore implements PushSubscriptionStorage {
  private readonly byEndpoint = new Map<string, PushSubscriptionRecord>()

  constructor(private readonly filePath: string) {}

  /** Read from disk. Missing file is treated as empty. */
  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return
    const raw = readFileSync(this.filePath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as PushSubscriptionRecord
        if (typeof parsed.endpoint === 'string' && parsed.keys?.p256dh && parsed.keys?.auth) {
          this.byEndpoint.set(parsed.endpoint, normalizePushSubscriptionRecord(parsed))
        }
      } catch {
        // Skip corrupt line — see class comment.
      }
    }
  }

  list(): readonly PushSubscriptionRecord[] {
    return [...this.byEndpoint.values()]
  }

  /**
   * Persist or replace a subscription. Called on every /push/subscribe or
   * PATCH so the store always reflects the browser's current preferences.
   */
  upsert(record: PushSubscriptionRecord): void {
    this.byEndpoint.set(record.endpoint, normalizePushSubscriptionRecord(record))
    this.flush()
  }

  /**
   * Drop by endpoint. Called on explicit /push/unsubscribe and also on
   * dispatch failures with HTTP 404/410 (subscription gone at the browser).
   */
  remove(endpoint: string): boolean {
    const existed = this.byEndpoint.delete(endpoint)
    if (existed) this.flush()
    return existed
  }

  size(): number {
    return this.byEndpoint.size
  }

  updateDevice(deviceId: string, update: { enabled?: boolean; name?: string }): boolean {
    let changed = false
    for (const [endpoint, record] of this.byEndpoint) {
      if (record.deviceId !== deviceId) continue
      this.byEndpoint.set(endpoint, {
        ...record,
        ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
        ...(update.name !== undefined ? { deviceName: update.name } : {}),
      })
      changed = true
    }
    if (changed) this.flush()
    return changed
  }

  removeDevice(deviceId: string): boolean {
    let changed = false
    for (const [endpoint, record] of this.byEndpoint) {
      if (record.deviceId === deviceId) {
        this.byEndpoint.delete(endpoint)
        changed = true
      }
    }
    if (changed) this.flush()
    return changed
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const body = [...this.byEndpoint.values()]
      .map((record) => JSON.stringify(record))
      .join('\n')
    writeFileSync(this.filePath, body ? `${body}\n` : '', 'utf8')
  }
}

export function normalizePushSubscriptionRecord(record: PushSubscriptionRecord): PushSubscriptionRecord {
  return {
    ...record,
    deviceId: record.deviceId ?? pushDeviceIdForEndpoint(record.endpoint),
    deviceName: record.deviceName ?? deviceNameFromUserAgent(record.userAgent),
    enabled: record.enabled ?? true,
  }
}

export function pushDeviceIdForEndpoint(endpoint: string): string {
  return `legacy-${createHash('sha256').update(endpoint).digest('base64url').slice(0, 16)}`
}

export function deviceNameFromUserAgent(userAgent?: string): string {
  if (!userAgent) return 'Previously registered device'
  const platform = /iPhone|iPad/.test(userAgent) ? 'iPhone or iPad' : /Android/.test(userAgent) ? 'Android' : /Macintosh/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows PC' : 'Linux computer'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  return `${browser} on ${platform}`
}
