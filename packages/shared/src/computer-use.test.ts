import { describe, expect, it } from 'vitest'
import { COMPUTER_TYPE_MAX_LENGTH, ComputerInputActionSchema, ComputerRequestSchema, ComputerResponseSchema } from './computer-use.js'

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
})
