import { issueRuntimeRoutingTicket } from '@agent-kernel/shared'
import { describe, expect, it, vi } from 'vitest'

import type { RuntimeResourceOwnerBindingResolver } from './postgres-runtime-resource-owner-resolver.js'
import { RuntimeRoutingTicketResolver } from './runtime-routing-ticket-resolver.js'

const key = new Uint8Array(32).fill(7)
const nowMs = 1_800_000_000_000
const claims = {
  audience: 'gateway.example',
  principalId: 'aHR0cHM6Ly9pZGVudGl0eS5leGFtcGxlAHVzZXJfMDE',
  organizationId: 'org_acme',
  unitId: 'unit_acme',
  resourceKind: 'session' as const,
  resourceId: 'session_01',
  ownerReplicaId: 'replica_a',
  ownerGeneration: 3n,
  ttlMs: 5_000,
}
const authenticatedScope = {
  principalId: claims.principalId, organizationId: claims.organizationId, unitId: claims.unitId,
}

function ticket(): string {
  return issueRuntimeRoutingTicket(claims, { key, maxTtlMs: 10_000, nowMs })
}

describe('RuntimeRoutingTicketResolver', () => {
  it('re-reads the exact resource scope and returns only the matching current owner', async () => {
    const resolveResourceOwnerBinding = vi.fn(async () => ({
      origin: 'https://replica-a.example', replicaId: 'replica_a', generation: 3n,
    }))
    const resolver = createResolver({ resolveResourceOwnerBinding })

    await expect(resolver.resolveTicketForOrganization(ticket(), authenticatedScope)).resolves.toBe('https://replica-a.example')
    expect(resolveResourceOwnerBinding).toHaveBeenCalledWith({
      organizationId: 'org_acme', unitId: 'unit_acme', resourceType: 'session', resourceId: 'session_01',
    })
  })

  it('rejects a ticket outside the authenticated organization and Unit before querying PG', async () => {
    const ownerResolver = { resolveResourceOwnerBinding: vi.fn() }
    const resolver = createResolver(ownerResolver)

    await expect(resolver.resolveTicketForOrganization(ticket(), {
      principalId: claims.principalId, organizationId: 'org_other', unitId: claims.unitId,
    })).resolves.toBeUndefined()
    await expect(resolver.resolveTicketForOrganization(ticket(), {
      principalId: claims.principalId, organizationId: claims.organizationId, unitId: 'unit_other',
    })).resolves.toBeUndefined()
    await expect(resolver.resolveTicketForOrganization(ticket(), {
      principalId: 'other_principal', organizationId: claims.organizationId, unitId: claims.unitId,
    })).resolves.toBeUndefined()
    expect(ownerResolver.resolveResourceOwnerBinding).not.toHaveBeenCalled()
  })

  it('accepts only Session tickets through the WebSocket-specific entry point', async () => {
    const ownerResolver = { resolveResourceOwnerBinding: vi.fn(async () => ({
      origin: 'https://replica-a.example', replicaId: 'replica_a', generation: 3n,
    })) }
    const resolver = createResolver(ownerResolver)
    const organization = { principalId: claims.principalId, organizationId: claims.organizationId, unitId: claims.unitId }

    await expect(resolver.resolveSessionTicketForOrganization(ticket(), organization))
      .resolves.toBe('https://replica-a.example')
    const taskTicket = issueRuntimeRoutingTicket({ ...claims, resourceKind: 'task' }, { key, maxTtlMs: 10_000, nowMs })
    await expect(resolver.resolveSessionTicketForOrganization(taskTicket, organization)).resolves.toBeUndefined()
  })

  it.each([
    ['missing owner', undefined],
    ['different replica', { origin: 'https://replica-b.example', replicaId: 'replica_b', generation: 3n }],
    ['old generation', { origin: 'https://replica-a.example', replicaId: 'replica_a', generation: 4n }],
  ])('rejects %s after successful ticket verification', async (_name, owner) => {
    const resolver = createResolver({ resolveResourceOwnerBinding: async () => owner })
    await expect(resolver.resolveTicketForOrganization(ticket(), authenticatedScope)).resolves.toBeUndefined()
  })

  it('issues only live owner-backed Session tickets with the authenticated scope and a bounded TTL', async () => {
    const ownerResolver = { resolveResourceOwnerBinding: vi.fn(async () => ({
      origin: 'https://replica-a.example', replicaId: 'replica_a', generation: 3n,
    })) }
    const resolver = new RuntimeRoutingTicketResolver({
      key, audience: claims.audience, maxTtlMs: 60_000, ownerResolver, now: () => nowMs,
    })
    const signed = await resolver.issueSessionTicketForOrganization('session_01', authenticatedScope)
    expect(signed).toBeTruthy()
    expect(ownerResolver.resolveResourceOwnerBinding).toHaveBeenCalledWith({
      organizationId: claims.organizationId, unitId: claims.unitId, resourceType: 'session', resourceId: 'session_01',
    })
    await expect(resolver.resolveSessionTicketForOrganization(signed, authenticatedScope))
      .resolves.toBe('https://replica-a.example')
    const expired = new RuntimeRoutingTicketResolver({
      key, audience: claims.audience, maxTtlMs: 60_000, ownerResolver, now: () => nowMs + 15_000,
    })
    await expect(expired.resolveSessionTicketForOrganization(signed, authenticatedScope)).resolves.toBeUndefined()
    await expect(resolver.issueSessionTicketForOrganization('../bad', authenticatedScope)).resolves.toBeUndefined()
    expect(ownerResolver.resolveResourceOwnerBinding).toHaveBeenCalledTimes(2)
    ownerResolver.resolveResourceOwnerBinding.mockResolvedValueOnce(undefined as never)
    await expect(resolver.issueSessionTicketForOrganization('session_missing', authenticatedScope)).resolves.toBeUndefined()
  })

  it('does not query PG for forged, expired, polluted, or wrong-audience tickets', async () => {
    const ownerResolver = { resolveResourceOwnerBinding: vi.fn() }
    const resolver = createResolver(ownerResolver)
    const signed = ticket()

    await expect(resolver.resolveTicketForOrganization(`${signed.slice(0, -1)}x`, authenticatedScope)).resolves.toBeUndefined()
    await expect(resolver.resolveTicketForOrganization([signed, signed], authenticatedScope)).resolves.toBeUndefined()
    await expect(new RuntimeRoutingTicketResolver({
      key, audience: 'other-gateway', maxTtlMs: 10_000, ownerResolver, now: () => nowMs + 1,
    }).resolveTicketForOrganization(signed, authenticatedScope)).resolves.toBeUndefined()
    await expect(new RuntimeRoutingTicketResolver({
      key, audience: claims.audience, maxTtlMs: 10_000, ownerResolver, now: () => nowMs + claims.ttlMs,
    }).resolveTicketForOrganization(signed, authenticatedScope)).resolves.toBeUndefined()
    expect(ownerResolver.resolveResourceOwnerBinding).not.toHaveBeenCalled()
  })
})

function createResolver(ownerResolver: RuntimeResourceOwnerBindingResolver): RuntimeRoutingTicketResolver {
  return new RuntimeRoutingTicketResolver({
    key, audience: claims.audience, maxTtlMs: 10_000, ownerResolver, now: () => nowMs + 1,
  })
}
