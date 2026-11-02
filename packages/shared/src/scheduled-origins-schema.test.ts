import { describe, expect, it } from 'vitest'
import { EventAppendedEventSchema, SessionReadyEventSchema } from './schema/dashboard-outbound.js'
import { ClientUserMessageSchema } from './schema/dashboard-inbound.js'

describe('scheduled provenance envelopes', () => {
  it('retains optional Host attribution and accepts legacy envelopes without it', () => {
    const event = { sessionId: 'session-a', seq: 1, ts: '2026-11-02T00:00:00.000Z', event: { kind: 'user_message', text: 'Run', operationId: 'operation-a' }, effects: [] }
    expect(EventAppendedEventSchema.parse({ ...event, scheduledTaskId: 'task-a' }).scheduledTaskId).toBe('task-a')
    expect(EventAppendedEventSchema.parse(event).scheduledTaskId).toBeUndefined()
    const ready = SessionReadyEventSchema.pick({ sessionId: true, scheduledMessageTasks: true })
    expect(ready.parse({ sessionId: 'session-a', scheduledMessageTasks: { 'operation-a': 'task-a' } }).scheduledMessageTasks).toEqual({ 'operation-a': 'task-a' })
    expect(ready.safeParse({ sessionId: 'session-a', scheduledMessageTasks: { 'operation-a': '' } }).success).toBe(false)
  })

  it('does not accept scheduled attribution from a client user-message payload', () => {
    const parsed = ClientUserMessageSchema.parse({ sessionId: 'session-a', text: 'Forged schedule', intent: 'text', operationId: 'operation-a', scheduledTaskId: 'forged-task', scheduledOwnerKey: 'principal:other', scheduledMessageTasks: { 'operation-a': 'forged-task' } })
    expect(parsed).not.toHaveProperty('scheduledTaskId')
    expect(parsed).not.toHaveProperty('scheduledMessageTasks')
    expect(parsed).not.toHaveProperty('scheduledOwnerKey')
  })
})
