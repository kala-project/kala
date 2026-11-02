import { expect, it } from 'vitest'
import { ScheduledInboxChangedEventSchema } from './schema/dashboard-outbound.js'

it('accepts change/reconnect invalidation without exposing another principal or accepting ownership fields', () => {
  expect(ScheduledInboxChangedEventSchema.parse({ reason: 'changed' })).toEqual({ reason: 'changed' })
  expect(ScheduledInboxChangedEventSchema.safeParse({ reason: 'reconnected' }).success).toBe(true)
  expect(ScheduledInboxChangedEventSchema.safeParse({ reason: 'ordinary-message' }).success).toBe(false)
  expect(ScheduledInboxChangedEventSchema.safeParse({ reason: 'changed', principal: 'other' }).success).toBe(false)
})
