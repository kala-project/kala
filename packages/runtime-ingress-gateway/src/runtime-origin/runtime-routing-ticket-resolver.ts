import { issueRuntimeRoutingTicket, verifyRuntimeRoutingTicket } from '@agent-kernel/shared'

import type { RuntimeResourceOwnerBindingResolver } from './postgres-runtime-resource-owner-resolver.js'

export type RuntimeRoutingTicketResolverOptions = {
  key: Uint8Array
  audience: string
  maxTtlMs: number
  ownerResolver: RuntimeResourceOwnerBindingResolver
  now?: () => number
}

export type RuntimeRoutingTicketOrganization = {
  principalId: string
  organizationId: string
  unitId: string
}

/**
 * Optional ticket-to-origin adapter. Edge callers must opt in and pass a single
 * untrusted transport value together with their independently authenticated scope.
 * A valid signature is necessary but never sufficient; current PG authority,
 * membership, ownership generation, and exact origin allowlisting are re-read.
 */
export class RuntimeRoutingTicketResolver {
  readonly #key: Uint8Array
  readonly #audience: string
  readonly #maxTtlMs: number
  readonly #ownerResolver: RuntimeResourceOwnerBindingResolver
  readonly #now: () => number

  constructor(options: RuntimeRoutingTicketResolverOptions) {
    this.#key = options.key
    this.#audience = options.audience
    this.#maxTtlMs = options.maxTtlMs
    this.#ownerResolver = options.ownerResolver
    this.#now = options.now ?? Date.now
  }

  /** The caller must authenticate the browser, check runtime:write, and derive this scope server-side. */
  async issueSessionTicketForOrganization(
    sessionId: string,
    organization: RuntimeRoutingTicketOrganization,
  ): Promise<string | undefined> {
    if (!/^[0-9A-Za-z][0-9A-Za-z_.:-]{0,255}$/u.test(sessionId)) return undefined
    const owner = await this.#ownerResolver.resolveResourceOwnerBinding({
      organizationId: organization.organizationId,
      unitId: organization.unitId,
      resourceType: 'session',
      resourceId: sessionId,
    })
    if (!owner) return undefined
    return issueRuntimeRoutingTicket({
      audience: this.#audience,
      principalId: organization.principalId,
      organizationId: organization.organizationId,
      unitId: organization.unitId,
      resourceKind: 'session', resourceId: sessionId,
      ownerReplicaId: owner.replicaId, ownerGeneration: owner.generation,
      ttlMs: Math.min(15_000, this.#maxTtlMs),
    }, { key: this.#key, maxTtlMs: this.#maxTtlMs, nowMs: this.#now() })
  }

  async resolveTicketForOrganization(ticket: unknown, organization: RuntimeRoutingTicketOrganization): Promise<string | undefined> {
    return (await this.#resolveTicket(ticket, organization))?.origin
  }

  async resolveSessionTicketForOrganization(ticket: unknown, organization: RuntimeRoutingTicketOrganization): Promise<string | undefined> {
    return (await this.resolveSessionBindingForOrganization(ticket, organization))?.origin
  }

  /** Return the verified Session identity along with the live owner so Host can bind the later Socket.IO handshake. */
  async resolveSessionBindingForOrganization(ticket: unknown, organization: RuntimeRoutingTicketOrganization): Promise<{ origin: string; sessionId: string } | undefined> {
    const resolved = await this.#resolveTicket(ticket, organization, 'session')
    return resolved ? { origin: resolved.origin, sessionId: resolved.resourceId } : undefined
  }

  async #resolveTicket(
    ticket: unknown,
    organization?: RuntimeRoutingTicketOrganization,
    requiredResourceKind?: 'session' | 'task',
  ): Promise<{ origin: string; resourceId: string } | undefined> {
    const claims = verifyRuntimeRoutingTicket(ticket, {
      key: this.#key,
      audience: this.#audience,
      maxTtlMs: this.#maxTtlMs,
      nowMs: this.#now(),
      maxFutureSkewMs: 2_000,
    })
    if (!claims || (requiredResourceKind && claims.resourceKind !== requiredResourceKind)) return undefined
    if (organization && (claims.principalId !== organization.principalId
      || claims.organizationId !== organization.organizationId || claims.unitId !== organization.unitId)) return undefined

    const owner = await this.#ownerResolver.resolveResourceOwnerBinding({
      organizationId: claims.organizationId,
      unitId: claims.unitId,
      resourceType: claims.resourceKind,
      resourceId: claims.resourceId,
    })
    if (!owner || owner.replicaId !== claims.ownerReplicaId
      || owner.generation.toString(10) !== claims.ownerGeneration) return undefined
    return { origin: owner.origin, resourceId: claims.resourceId }
  }
}
