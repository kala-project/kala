import type { RuntimeResourceOwnership, RuntimeUnitReplicaMembership } from './postgres-runtime-resource-ownership.js'
import { RuntimeResourceOwnershipFencedError } from './postgres-runtime-resource-ownership.js'
import type { RuntimeReplicaMembership } from './runtime-replica-membership.js'
import { RuntimeResourceOwnershipManager, type RuntimeResourceOwnerLease } from './runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from './unit.js'

/** One Unit's server-side Session owners. This does not replace Unit placement or fence external effects. */
export class RuntimeSessionOwnership {
  readonly #unitId: TenantRuntimeUnitId
  readonly #handles = new Map<string, RuntimeResourceOwnerLease>()
  readonly #pending = new Map<string, Promise<RuntimeResourceOwnership>>()
  #closed = false
  #closing?: Promise<void>

  constructor(
    readonly organizationId: string,
    unitId: string,
    readonly membership: Pick<RuntimeReplicaMembership, 'activeLease'>,
    readonly manager: RuntimeResourceOwnershipManager,
    readonly onLost: (unitId: TenantRuntimeUnitId, reason: unknown) => void | Promise<void>,
  ) {
    if (!organizationId || organizationId.trim() !== organizationId) throw new TypeError('invalid organizationId')
    this.#unitId = parseTenantRuntimeUnitId(unitId)
  }

  /** Never expose a cached owner once either the membership or the owner lease is unhealthy. */
  activeLease(sessionId: string): RuntimeResourceOwnership | undefined {
    const member = this.membership.activeLease(this.#unitId, this.organizationId)
    const owner = this.#handles.get(sessionId)?.activeLease()
    return !this.#closed && member && owner && sameMember(owner, member) ? owner : undefined
  }

  /** Pin a live activation for an opaque external stream without SQL in its byte path. */
  captureEffectFence(sessionId: string): (() => boolean) | undefined {
    const lease = this.activeLease(sessionId)
    if (!lease) return undefined
    const { ownerToken, generation, replicaId, membershipToken, membershipGeneration } = lease
    return () => {
      const current = this.activeLease(sessionId)
      return !!current && current.ownerToken === ownerToken && current.generation === generation
        && current.replicaId === replicaId && current.membershipToken === membershipToken
        && current.membershipGeneration === membershipGeneration
    }
  }

  /** Coalesce concurrent Host requests; all PG writes must still check this lease in their transaction. */
  async ensure(sessionId: string): Promise<RuntimeResourceOwnership> {
    if (!sessionId || sessionId.trim() !== sessionId) throw new TypeError('invalid sessionId')
    if (this.#closed) throw new RuntimeResourceOwnershipFencedError()
    const current = this.activeLease(sessionId)
    if (current) return current
    // A stale handle must never be replaced silently while this Unit is still running.
    if (this.#handles.has(sessionId)) throw new RuntimeResourceOwnershipFencedError()
    const pending = this.#pending.get(sessionId)
    if (pending) return await pending
    const acquiring = this.#acquire(sessionId)
    this.#pending.set(sessionId, acquiring)
    try { return await acquiring } finally {
      if (this.#pending.get(sessionId) === acquiring) this.#pending.delete(sessionId)
    }
  }

  async chooseChildReplicaId(childSessionId: string): Promise<string | undefined> {
    const member = this.membership.activeLease(this.#unitId, this.organizationId)
    if (!member || this.#closed) throw new RuntimeResourceOwnershipFencedError()
    const replicas = await this.manager.store.lookupLiveReplicas?.({
      organizationId: this.organizationId, unitId: this.#unitId,
    })
    const remote = replicas?.filter((replica) => replica.replicaId !== member.replicaId
      && replica.expiresAt.getTime() > Date.now() + 1_000)
    if (!remote?.length) return undefined
    return remote[childSessionId.charCodeAt(childSessionId.length - 1) % remote.length]!.replicaId
  }

  /** Release only the newly created child lease; never release its parent's independent owner. */
  async handoffChild(sessionId: string, targetReplicaId: string): Promise<void> {
    const member = this.membership.activeLease(this.#unitId, this.organizationId)
    if (!member || member.replicaId === targetReplicaId || this.#closed) throw new RuntimeResourceOwnershipFencedError()
    const handle = this.#handles.get(sessionId)
    if (!handle) return
    if (!handle.activeLease()) throw new RuntimeResourceOwnershipFencedError()
    this.#handles.delete(sessionId)
    await handle.release()
  }

  async close(): Promise<void> {
    if (this.#closing) return await this.#closing
    this.#closed = true
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending.values()])
      this.#handles.clear()
      // An onLost notification can be waiting for Host.suspendUnit(), whose
      // disposer is this close(). Wait for capabilities/releases, not the
      // notification that will finish immediately after teardown returns.
      await this.manager.releaseAll({ waitForLossCallbacks: false })
    })()
    return await this.#closing
  }

  async #acquire(sessionId: string): Promise<RuntimeResourceOwnership> {
    const member = this.membership.activeLease(this.#unitId, this.organizationId)
    if (!member) throw new RuntimeResourceOwnershipFencedError()
    const handle = await this.manager.acquire({
      organizationId: this.organizationId, unitId: this.#unitId, resourceType: 'session', resourceId: sessionId,
    }, member, async (lost, reason) => {
      if (this.#handles.get(sessionId) === lost) this.#handles.delete(sessionId)
      if (this.#closed) return
      this.#closed = true
      await this.onLost(this.#unitId, reason)
    })
    const stillMember = this.membership.activeLease(this.#unitId, this.organizationId)
    const lease = handle.activeLease()
    if (this.#closed || !lease || !stillMember || !sameMember(lease, stillMember)) {
      await handle.release()
      throw new RuntimeResourceOwnershipFencedError()
    }
    this.#handles.set(sessionId, handle)
    return lease
  }
}

function sameMember(owner: RuntimeResourceOwnership, member: RuntimeUnitReplicaMembership): boolean {
  return owner.organizationId === member.organizationId && owner.unitId === member.unitId
    && owner.replicaId === member.replicaId && owner.membershipToken === member.membershipToken
    && owner.membershipGeneration === member.generation && member.expiresAt.getTime() > Date.now()
}
