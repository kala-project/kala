import { issueRuntimeRoutingTicket } from '@agent-kernel/shared'

import type { RuntimeResourceLiveOwner, RuntimeResourceScope } from './postgres-runtime-resource-ownership.js'

/** Construct this only after server-side authentication has completed. */
export type VerifiedRoutingTicketPrincipal = {
  /** Gateway-canonical authenticated principal: base64url(issuer + NUL + subject). */
  principalId: string
  organizationId: string
}

export type AuthorizedRuntimeRoutingTicketScope = RuntimeResourceScope

export interface RuntimeRoutingTicketAuthorizer<AuthorizationInput = unknown> {
  /** Return a trusted scope after authorizing the verified principal, or undefined to deny. */
  authorizeRuntimeRoute(
    principal: VerifiedRoutingTicketPrincipal,
    authorizationInput: AuthorizationInput,
  ): Promise<AuthorizedRuntimeRoutingTicketScope | undefined>
}

export interface RuntimeResourceLiveOwnerReader {
  lookupResourceOwner(scope: RuntimeResourceScope): Promise<RuntimeResourceLiveOwner | undefined>
}

export type RuntimeRoutingTicketIssuerOptions<AuthorizationInput> = {
  key: Uint8Array
  audience: string
  ttlMs: number
  maxTtlMs: number
  authorizer: RuntimeRoutingTicketAuthorizer<AuthorizationInput>
  owners: RuntimeResourceLiveOwnerReader
  now?: () => number
}

/**
 * Read-only Host helper for a future authenticated issuance API. It accepts no
 * header/query resource IDs directly: an injected server-side authorizer must
 * derive and return the trusted organization/resource scope first, then the
 * current live owner is read without exposing membership or owner tokens.
 */
export class RuntimeRoutingTicketIssuer<AuthorizationInput = unknown> {
  readonly #options: RuntimeRoutingTicketIssuerOptions<AuthorizationInput>

  constructor(options: RuntimeRoutingTicketIssuerOptions<AuthorizationInput>) {
    this.#options = options
  }

  async issueForVerifiedPrincipal(
    principal: VerifiedRoutingTicketPrincipal,
    authorizationInput: AuthorizationInput,
  ): Promise<string | undefined> {
    const scope = await this.#options.authorizer.authorizeRuntimeRoute(principal, authorizationInput)
    if (!scope || scope.organizationId !== principal.organizationId) return undefined
    const owner = await this.#options.owners.lookupResourceOwner(scope)
    if (!owner || owner.organizationId !== scope.organizationId || owner.unitId !== scope.unitId
      || owner.resourceType !== scope.resourceType || owner.resourceId !== scope.resourceId) return undefined

    return issueRuntimeRoutingTicket({
      audience: this.#options.audience,
      principalId: principal.principalId,
      organizationId: scope.organizationId,
      unitId: scope.unitId,
      resourceKind: scope.resourceType,
      resourceId: scope.resourceId,
      ownerReplicaId: owner.replicaId,
      ownerGeneration: owner.generation,
      ttlMs: this.#options.ttlMs,
    }, {
      key: this.#options.key,
      maxTtlMs: this.#options.maxTtlMs,
      nowMs: this.#options.now?.(),
    })
  }
}
