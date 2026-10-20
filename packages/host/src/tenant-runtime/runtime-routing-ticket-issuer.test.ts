import { verifyRuntimeRoutingTicket } from '@agent-kernel/shared'
import { describe, expect, it, vi } from 'vitest'

import { parseTenantRuntimeUnitId } from './unit.js'
import { RuntimeRoutingTicketIssuer } from './runtime-routing-ticket-issuer.js'

const key = new Uint8Array(32).fill(11)
const nowMs = 1_800_000_000_000
const principal = { principalId: Buffer.from('issuer.example\0user_01').toString('base64url'), organizationId: 'org_acme' }
const scope = {
  organizationId: 'org_acme',
  unitId: parseTenantRuntimeUnitId('00000000-0000-4000-8000-000000000001'),
  resourceType: 'task' as const,
  resourceId: '00000000-0000-4000-8000-000000000002',
}
const owner = {
  ...scope,
  replicaId: '00000000-0000-4000-8000-000000000003',
  membershipGeneration: 2n,
  generation: 9n,
  expiresAt: new Date(nowMs + 60_000),
  origin: 'https://replica.example',
}

describe('RuntimeRoutingTicketIssuer', () => {
  it('authorizes a verified principal, reads the live owner, and signs no secret tokens', async () => {
    const authorizeRuntimeRoute = vi.fn(async () => scope)
    const lookupResourceOwner = vi.fn(async () => owner)
    const issuer = new RuntimeRoutingTicketIssuer({
      key, audience: 'gateway.example', ttlMs: 5_000, maxTtlMs: 10_000,
      authorizer: { authorizeRuntimeRoute }, owners: { lookupResourceOwner }, now: () => nowMs,
    })

    const ticket = await issuer.issueForVerifiedPrincipal(principal, { routeHandle: 'trusted-server-handle' })
    expect(authorizeRuntimeRoute).toHaveBeenCalledWith(principal, { routeHandle: 'trusted-server-handle' })
    expect(lookupResourceOwner).toHaveBeenCalledWith(scope)
    expect(verifyRuntimeRoutingTicket(ticket, {
      key, audience: 'gateway.example', maxTtlMs: 10_000, nowMs: nowMs + 1,
    })).toMatchObject({
      organizationId: scope.organizationId,
      principalId: principal.principalId,
      unitId: scope.unitId,
      resourceKind: scope.resourceType,
      resourceId: scope.resourceId,
      ownerReplicaId: owner.replicaId,
      ownerGeneration: '9',
    })
    expect(ticket).not.toContain('membershipToken')
    expect(ticket).not.toContain('ownerToken')
    expect(ticket).not.toContain(owner.origin)
  })

  it('denies failed authorization, cross-organization scopes, and missing live owners', async () => {
    const lookupResourceOwner = vi.fn(async () => owner)
    const denied = new RuntimeRoutingTicketIssuer({
      key, audience: 'gateway.example', ttlMs: 5_000, maxTtlMs: 10_000,
      authorizer: { authorizeRuntimeRoute: async () => undefined }, owners: { lookupResourceOwner }, now: () => nowMs,
    })
    await expect(denied.issueForVerifiedPrincipal(principal, null)).resolves.toBeUndefined()
    expect(lookupResourceOwner).not.toHaveBeenCalled()

    const crossOrganization = new RuntimeRoutingTicketIssuer({
      key, audience: 'gateway.example', ttlMs: 5_000, maxTtlMs: 10_000,
      authorizer: { authorizeRuntimeRoute: async () => ({ ...scope, organizationId: 'org_other' }) },
      owners: { lookupResourceOwner }, now: () => nowMs,
    })
    await expect(crossOrganization.issueForVerifiedPrincipal(principal, null)).resolves.toBeUndefined()
    expect(lookupResourceOwner).not.toHaveBeenCalled()

    const noOwner = new RuntimeRoutingTicketIssuer({
      key, audience: 'gateway.example', ttlMs: 5_000, maxTtlMs: 10_000,
      authorizer: { authorizeRuntimeRoute: async () => scope },
      owners: { lookupResourceOwner: async () => undefined }, now: () => nowMs,
    })
    await expect(noOwner.issueForVerifiedPrincipal(principal, null)).resolves.toBeUndefined()
  })
})
