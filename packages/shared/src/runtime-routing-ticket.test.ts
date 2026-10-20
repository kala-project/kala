import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  issueRuntimeRoutingTicket,
  RUNTIME_ROUTING_TICKET_KIND,
  RUNTIME_ROUTING_TICKET_SCHEMA,
  RUNTIME_ROUTING_TICKET_VERSION,
  verifyRuntimeRoutingTicket,
} from './runtime-routing-ticket.js'

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const otherKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
const nowMs = 1_800_000_000_000
const maxTtlMs = 30_000
const input = {
  audience: 'runtime-ingress-gateway',
  principalId: 'aHR0cHM6Ly9pZGVudGl0eS5leGFtcGxlAHVzZXJfMDE',
  organizationId: 'org_acme',
  unitId: '00000000-0000-4000-8000-000000000001',
  resourceKind: 'session' as const,
  resourceId: '00000000-0000-4000-8000-000000000002',
  ownerReplicaId: '00000000-0000-4000-8000-000000000003',
  ownerGeneration: 42n,
  ttlMs: 5_000,
}

describe('runtime routing ticket codec', () => {
  it('round-trips all bound claims using an externally supplied raw32 key', () => {
    const ticket = issueRuntimeRoutingTicket(input, { key, maxTtlMs, nowMs })

    expect(verifyRuntimeRoutingTicket(ticket, {
      key, audience: input.audience, maxTtlMs, nowMs: nowMs + 1,
    })).toEqual({
      version: RUNTIME_ROUTING_TICKET_VERSION,
      schema: RUNTIME_ROUTING_TICKET_SCHEMA,
      kind: RUNTIME_ROUTING_TICKET_KIND,
      audience: input.audience,
      principalId: input.principalId,
      organizationId: input.organizationId,
      unitId: input.unitId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      ownerReplicaId: input.ownerReplicaId,
      ownerGeneration: '42',
      issuedAt: nowMs,
      expiresAt: nowMs + input.ttlMs,
    })
  })

  it('rejects forgery, wrong audience, expiry, future issue time, and an excessive verifier TTL', () => {
    const ticket = issueRuntimeRoutingTicket(input, { key, maxTtlMs, nowMs })
    const verify = (candidate: unknown, overrides: Partial<Parameters<typeof verifyRuntimeRoutingTicket>[1]> = {}) =>
      verifyRuntimeRoutingTicket(candidate, {
        key, audience: input.audience, maxTtlMs, nowMs: nowMs + 1, ...overrides,
      })

    expect(verify(ticket, { key: otherKey })).toBeUndefined()
    expect(verify(ticket, { audience: 'another-gateway' })).toBeUndefined()
    expect(verify(ticket, { nowMs: nowMs + input.ttlMs })).toBeUndefined()
    expect(verify(ticket, { nowMs: nowMs - 1 })).toBeUndefined()
    expect(verify(ticket, { maxTtlMs: input.ttlMs - 1 })).toBeUndefined()

    const [payload, signature] = ticket.split('.') as [string, string]
    const changed = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`
    expect(verify(changed)).toBeUndefined()
  })

  it('tolerates only explicitly bounded verifier clock lag without extending ticket expiry', () => {
    const ticket = issueRuntimeRoutingTicket(input, { key, maxTtlMs, nowMs })
    const verify = (verificationTime: number, skew: number) => verifyRuntimeRoutingTicket(ticket, {
      key, audience: input.audience, maxTtlMs, nowMs: verificationTime, maxFutureSkewMs: skew,
    })
    expect(verify(nowMs - 50, 100)).toBeDefined()
    expect(verify(nowMs - 101, 100)).toBeUndefined()
    expect(verify(nowMs + input.ttlMs, 100)).toBeUndefined()
    expect(() => verify(nowMs, 5_001)).toThrow('maxFutureSkewMs')
  })

  it('rejects polluted transport values and malformed or non-canonical compact encodings', () => {
    const ticket = issueRuntimeRoutingTicket(input, { key, maxTtlMs, nowMs })
    const verify = (candidate: unknown) => verifyRuntimeRoutingTicket(candidate, {
      key, audience: input.audience, maxTtlMs, nowMs: nowMs + 1,
    })

    expect(verify([ticket, ticket])).toBeUndefined()
    expect(verify(`${ticket}.${ticket}`)).toBeUndefined()
    expect(verify(` ${ticket}`)).toBeUndefined()
    expect(verify(`${ticket}=`)).toBeUndefined()
    expect(verify('')).toBeUndefined()
  })

  it('rejects signed payloads with extra fields, wrong schema metadata, or non-canonical key order', () => {
    const base = {
      audience: input.audience,
      expiresAt: nowMs + 5_000,
      issuedAt: nowMs,
      kind: RUNTIME_ROUTING_TICKET_KIND,
      organizationId: input.organizationId,
      ownerGeneration: '42',
      ownerReplicaId: input.ownerReplicaId,
      principalId: input.principalId,
      resourceId: input.resourceId,
      resourceKind: input.resourceKind,
      schema: RUNTIME_ROUTING_TICKET_SCHEMA,
      unitId: input.unitId,
      version: RUNTIME_ROUTING_TICKET_VERSION,
    }
    const verify = (candidate: string) => verifyRuntimeRoutingTicket(candidate, {
      key, audience: input.audience, maxTtlMs, nowMs: nowMs + 1,
    })

    expect(verify(signJson({ ...base, unexpected: true }))).toBeUndefined()
    expect(verify(signJson({ ...base, schema: 'kala.runtime-routing-ticket.v3' }))).toBeUndefined()
    expect(verify(signJson({ ...base, kind: 'untrusted-kind' }))).toBeUndefined()
    const { version, ...claimsAfterVersion } = base
    expect(verify(signJson({ version, ...claimsAfterVersion }))).toBeUndefined()
  })

  it('enforces raw32 keys, positive generations, and the issuer maximum TTL', () => {
    expect(() => issueRuntimeRoutingTicket(input, { key: new Uint8Array(31), maxTtlMs, nowMs })).toThrow('exactly 32 bytes')
    expect(() => issueRuntimeRoutingTicket({ ...input, ttlMs: maxTtlMs + 1 }, { key, maxTtlMs, nowMs })).toThrow('ttlMs')
    expect(() => issueRuntimeRoutingTicket({ ...input, ownerGeneration: '01' }, { key, maxTtlMs, nowMs })).toThrow('claims')
    expect(() => issueRuntimeRoutingTicket({ ...input, ownerGeneration: 0n }, { key, maxTtlMs, nowMs })).toThrow('claims')
  })
})

function signJson(value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(payload, 'ascii').digest('base64url')
  return `${payload}.${signature}`
}
