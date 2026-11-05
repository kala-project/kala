import type { MessageContent } from '@agent-kernel/kernel'
import { schema } from '@agent-kernel/shared'

export type SavedPendingDelivery = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  displayMode?: 'steer' | 'queue'
  createdAt: string
  afterSeq: number
  afterMessageCount?: number
  content?: readonly MessageContent[]
  deliveryStatus: 'sending' | 'accepted' | 'unconfirmed' | 'failed'
}

export class PendingDeliveryStorageError extends Error {
  readonly safeToReleaseAttachments = true
  constructor(cause: unknown) {
    super('Message was not sent because its recovery record could not be saved.', { cause })
  }
}

function storageKey(host: string, sessionId: string): string {
  return `ak-pending-delivery:${host}:${sessionId}`
}

export function readPendingDeliveries(host: string, sessionId: string): readonly SavedPendingDelivery[] {
  const raw = window.localStorage.getItem(storageKey(host, sessionId))
  if (!raw) return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || !value.every((item) =>
    item !== null && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.text === 'string'
    && (item.mode === 'steer' || item.mode === 'queue')
    && (item.displayMode === undefined || item.displayMode === 'steer' || item.displayMode === 'queue')
    && typeof item.createdAt === 'string'
    && Number.isSafeInteger(item.afterSeq)
    && (item.afterMessageCount === undefined || Number.isSafeInteger(item.afterMessageCount))
    && (item.deliveryStatus === 'sending' || item.deliveryStatus === 'accepted' || item.deliveryStatus === 'unconfirmed' || item.deliveryStatus === 'failed')
    && (item.content === undefined || schema.MessageContentSchema.array().safeParse(item.content).success)
  )) throw new Error('Invalid saved message delivery record')
  return value as SavedPendingDelivery[]
}

export function savePendingDelivery(host: string, sessionId: string, record: SavedPendingDelivery): void {
  const entries = readPendingDeliveries(host, sessionId)
  window.localStorage.setItem(storageKey(host, sessionId), JSON.stringify([
    ...entries.filter((item) => item.id !== record.id),
    record,
  ]))
}

export function removePendingDelivery(host: string, sessionId: string, operationId: string): void {
  const entries = readPendingDeliveries(host, sessionId)
  if (!entries.some((item) => item.id === operationId)) return
  const remaining = entries.filter((item) => item.id !== operationId)
  if (remaining.length === 0) window.localStorage.removeItem(storageKey(host, sessionId))
  else window.localStorage.setItem(storageKey(host, sessionId), JSON.stringify(remaining))
}
