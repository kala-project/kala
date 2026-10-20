import { DESKTOP_NOTIFICATION_KINDS, type DesktopNotificationKind } from '@agent-kernel/shared/push'

import type { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import type { HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import {
  normalizePushSubscriptionRecord,
  type PushSubscriptionRecord,
  type PushSubscriptionStorage,
} from './store.js'

const CREDENTIAL_ID = 'push-subscriptions:v1'

type PushSubscriptionSnapshot = {
  version: 1
  subscriptions: PushSubscriptionRecord[]
}

/**
 * Tenant-bound push storage backed by PostgresTenantStateStore's AES-256-GCM
 * credential envelope. Endpoint URLs and browser keys live only in ciphertext;
 * the state store binds the envelope to both tenant id and credential id as AAD.
 */
export class PostgresPushSubscriptionStore implements PushSubscriptionStorage {
  constructor(private readonly state: PostgresTenantStateStore) {}

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    return [...await this.readSubscriptions()]
  }

  async upsert(record: PushSubscriptionRecord): Promise<void> {
    return this.state.withCredentialLock(CREDENTIAL_ID, async (transaction) => {
    const subscriptions = await this.readSubscriptions(transaction)
    const normalized = normalizePushSubscriptionRecord(record)
    const index = subscriptions.findIndex((candidate) => candidate.endpoint === normalized.endpoint)
    if (index === -1) subscriptions.push(normalized)
    else subscriptions[index] = normalized
    await this.writeSubscriptions(subscriptions, transaction)
    })
  }

  async remove(endpoint: string): Promise<boolean> {
    return this.state.withCredentialLock(CREDENTIAL_ID, async (transaction) => {
    const subscriptions = await this.readSubscriptions(transaction)
    const remaining = subscriptions.filter((record) => record.endpoint !== endpoint)
    if (remaining.length === subscriptions.length) return false
    await this.writeSubscriptions(remaining, transaction)
    return true
    })
  }

  async updateDevice(deviceId: string, update: { enabled?: boolean; name?: string }): Promise<boolean> {
    return this.state.withCredentialLock(CREDENTIAL_ID, async (transaction) => {
    const subscriptions = await this.readSubscriptions(transaction)
    let changed = false
    const updated = subscriptions.map((record) => {
      if (record.deviceId !== deviceId) return record
      changed = true
      return {
        ...record,
        ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
        ...(update.name !== undefined ? { deviceName: update.name } : {}),
      }
    })
    if (changed) await this.writeSubscriptions(updated, transaction)
    return changed
    })
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    return this.state.withCredentialLock(CREDENTIAL_ID, async (transaction) => {
    const subscriptions = await this.readSubscriptions(transaction)
    const remaining = subscriptions.filter((record) => record.deviceId !== deviceId)
    if (remaining.length === subscriptions.length) return false
    await this.writeSubscriptions(remaining, transaction)
    return true
    })
  }

  async size(): Promise<number> {
    return (await this.readSubscriptions()).length
  }

  private async readSubscriptions(transaction?: HotStateSqlExecutor): Promise<PushSubscriptionRecord[]> {
    const credential = await this.state.getCredential(CREDENTIAL_ID, transaction)
    if (!credential) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(credential.secret)
    } catch (cause) {
      throw new Error('invalid_push_subscription_state', { cause })
    }
    if (!isSnapshot(parsed)) throw new Error('invalid_push_subscription_state')
    return parsed.subscriptions.map(normalizePushSubscriptionRecord)
  }

  private async writeSubscriptions(subscriptions: readonly PushSubscriptionRecord[], transaction: HotStateSqlExecutor): Promise<void> {
    if (subscriptions.length === 0) {
      await this.state.deleteCredential(CREDENTIAL_ID, transaction)
      return
    }
    const snapshot: PushSubscriptionSnapshot = { version: 1, subscriptions: [...subscriptions] }
    await this.state.setCredential(CREDENTIAL_ID, JSON.stringify(snapshot), { format: 'push-subscriptions-v1' }, undefined, transaction)
  }
}

function isSnapshot(value: unknown): value is PushSubscriptionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Partial<PushSubscriptionSnapshot>
  return snapshot.version === 1
    && Array.isArray(snapshot.subscriptions)
    && snapshot.subscriptions.every(isSubscription)
}

function isSubscription(value: unknown): value is PushSubscriptionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PushSubscriptionRecord>
  return typeof record.endpoint === 'string'
    && !!record.keys
    && typeof record.keys.p256dh === 'string'
    && typeof record.keys.auth === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && Array.isArray(record.kinds)
    && record.kinds.every((kind): kind is DesktopNotificationKind =>
      typeof kind === 'string' && (DESKTOP_NOTIFICATION_KINDS as readonly string[]).includes(kind))
}
