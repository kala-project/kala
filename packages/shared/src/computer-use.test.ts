import { describe, expect, it } from 'vitest'
import { COMPUTER_TYPE_MAX_LENGTH, ComputerInputActionSchema, ComputerRequestSchema, ComputerResponseSchema, ComputerSemanticRequestSchema, ComputerObservationSchema } from './computer-use.js'

describe('computer-use wire bounds', () => {
  it('accepts the exact paced Unicode input limit but rejects larger requests', () => {
    const text = '中😀\n'.repeat(COMPUTER_TYPE_MAX_LENGTH / 4)
    expect(text.length).toBe(COMPUTER_TYPE_MAX_LENGTH)
    expect(ComputerInputActionSchema.safeParse({ type: 'type', text }).success).toBe(true)
    expect(ComputerInputActionSchema.safeParse({ type: 'type', text: `${text}x` }).success).toBe(false)
    expect(ComputerInputActionSchema.safeParse({ type: 'type', text: 'secret\u001b' }).success).toBe(false)
  })

  it('requires explicit consent and rejects forged ownership and origin arguments', () => {
    const identity = { requestId: 'request', workspaceId: 'workspace', sessionId: 'session' }
    expect(ComputerRequestSchema.safeParse({ ...identity, operation: 'start', consent: true, allowAgent: false }).success).toBe(true)
    expect(ComputerRequestSchema.safeParse({ ...identity, operation: 'start', allowAgent: true }).success).toBe(false)
    expect(ComputerRequestSchema.safeParse({ ...identity, operation: 'status', owner: 'another-socket', origin: 'host' }).success).toBe(false)
  })

  it('rejects empty success-shaped responses', () => {
    expect(ComputerResponseSchema.safeParse({ requestId: 'request' }).success).toBe(false)
    expect(ComputerResponseSchema.safeParse({ requestId: 'request', error: { code: 'unavailable', message: 'Desktop is locked' } }).success).toBe(true)
    expect(ComputerResponseSchema.safeParse({ requestId: 'request', status: { available: true, platform: 'linux', active: false, allowAgent: false } }).success).toBe(true)
  })

  it('bounds semantic batches and observations and rejects arbitrary executable fields', () => {
    const action = { ref: 'e1', action: 'setValue', value: 'hello' }
    const request = { operation: 'act', backend: 'browser', snapshotId: crypto.randomUUID(), actions: [action] }
    expect(ComputerSemanticRequestSchema.safeParse(request).success).toBe(true)
    expect(ComputerSemanticRequestSchema.safeParse({ ...request, actions: [{ ...action, value: '\u0000' }] }).success).toBe(false)
    expect(ComputerSemanticRequestSchema.safeParse({ ...request, actions: [{ ...action, value: '\ud800' }] }).success).toBe(false)
    expect(ComputerSemanticRequestSchema.safeParse({ ...request, actions: Array(9).fill(action) }).success).toBe(false)
    expect(ComputerSemanticRequestSchema.safeParse({ ...request, script: 'arbitrary JavaScript' }).success).toBe(false)
    expect(ComputerSemanticRequestSchema.safeParse({ ...request, actions: [{ ref: 'e1', action: 'invoke', value: 'unexpected' }] }).success).toBe(false)
    const node = { ref: 'e1', role: 'button', name: 'Save', enabled: true, actions: ['invoke'] }
    const observation = { backend: 'browser', snapshotId: request.snapshotId, targetId: 'tab', title: 'Fixture', elements: [node], truncated: false }
    expect(ComputerObservationSchema.safeParse(observation).success).toBe(true)
    expect(ComputerObservationSchema.safeParse({ ...observation, elements: Array(65).fill(node) }).success).toBe(false)
  })
})
