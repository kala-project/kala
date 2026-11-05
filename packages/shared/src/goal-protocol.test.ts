import { describe, expect, it } from 'vitest'
import { schema } from './index.js'

describe('Goal wire contract', () => {
  it('requires an explicit bounded Goal on creation and a distinct control action', () => {
    const payload = {
      sessionId: 'session-one',
      goal: { objective: 'Ship the feature', successCriteria: 'Tests pass', maxTurns: 100 },
    }
    expect(schema.ClientCreateSessionSchema.parse(payload).goal).toEqual(payload.goal)
    expect(schema.ClientCreateSessionSchema.safeParse({ ...payload, goal: { ...payload.goal, maxTurns: 101 } }).success).toBe(false)
    expect(schema.ClientCreateSessionSchema.safeParse({ ...payload, goal: { ...payload.goal, objective: ' ' } }).success).toBe(false)
    expect(schema.ClientGoalControlSchema.parse({
      sessionId: 'session-one', operationId: 'pause-1', action: 'pause',
    }).action).toBe('pause')
  })
})
