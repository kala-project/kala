import { afterEach, describe, expect, it } from 'vitest'
import { readPendingDeliveries, removePendingDelivery, savePendingDelivery } from './pending-delivery.js'

const host = 'https://kala.example'
const sessionId = 'delivery-journal-test'
const record = {
  id: 'operation-1',
  text: 'review the result',
  mode: 'steer' as const,
  createdAt: '2026-07-06T00:00:00.000Z',
  afterSeq: 4,
  deliveryStatus: 'sending' as const,
}

afterEach(() => {
  window.localStorage.removeItem(`ak-pending-delivery:${host}:${sessionId}`)
  window.localStorage.removeItem(`ak-pending-delivery:${host}:other-session`)
  window.localStorage.removeItem(`ak-pending-delivery:${host}:another-identity:${sessionId}`)
})

describe('saved pending deliveries', () => {
  it('preserves the original operation identity and content across reloads without mixing sessions', () => {
    const withContent = { ...record, content: [{ type: 'text' as const, text: record.text }] }
    savePendingDelivery(host, sessionId, withContent)
    savePendingDelivery(host, sessionId, { ...withContent, deliveryStatus: 'accepted' })
    expect(readPendingDeliveries(host, sessionId)).toEqual([{ ...withContent, deliveryStatus: 'accepted' }])
    expect(readPendingDeliveries(host, 'other-session')).toEqual([])
    expect(readPendingDeliveries(`${host}:another-identity`, sessionId)).toEqual([])
    removePendingDelivery(host, sessionId, record.id)
    expect(readPendingDeliveries(host, sessionId)).toEqual([])
  })

  it('refuses corrupt storage instead of silently forgetting an unconfirmed operation', () => {
    window.localStorage.setItem(`ak-pending-delivery:${host}:${sessionId}`, '[{"id":42}]')
    expect(() => readPendingDeliveries(host, sessionId)).toThrow('Invalid saved message delivery record')
    expect(() => savePendingDelivery(host, sessionId, record)).toThrow('Invalid saved message delivery record')
  })
})
