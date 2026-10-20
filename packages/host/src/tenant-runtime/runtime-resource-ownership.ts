import { randomBytes } from 'node:crypto'

import {
  RuntimeResourceOwnershipExpiredError,
  RuntimeUnitReplicaMembershipExpiredError,
  type RuntimeResourceOwnership,
  type RuntimeResourceScope,
  type RuntimeUnitReplicaMembership,
} from './postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from './unit.js'

export interface RuntimeResourceOwnershipStore {
  acquireResourceOwner(
    scope: RuntimeResourceScope,
    replica: RuntimeUnitReplicaMembership,
    ownerToken: string,
    ttlMs: number,
  ): Promise<RuntimeResourceOwnership>
  renewResourceOwner(lease: RuntimeResourceOwnership, ttlMs: number): Promise<RuntimeResourceOwnership>
  releaseResourceOwner(lease: RuntimeResourceOwnership): Promise<void>
}

export interface RuntimeResourceOwnerLease {
  readonly scope: RuntimeResourceScope
  /**
   * A capability for a future store transaction fence. It is unavailable as
   * soon as this process cannot prove that the managed lease is healthy.
   */
  activeLease(): RuntimeResourceOwnership | undefined
  release(): Promise<void>
}

export type RuntimeResourceOwnerLostHandler = (
  lease: RuntimeResourceOwnerLease,
  reason: unknown,
) => void | Promise<void>

type Active = {
  readonly key: string
  readonly scope: RuntimeResourceScope
  readonly lost: RuntimeResourceOwnerLostHandler
  lease: RuntimeResourceOwnership
  handle: RuntimeResourceOwnerLease
  healthy: boolean
  renewal?: NodeJS.Timeout
  release?: Promise<void>
}

/**
 * Experimental in-process lifecycle management for Session/Task owner leases.
 *
 * Holding a managed lease does not authorize resource work by itself. Callers
 * must eventually pass activeLease() to a PostgreSQL transaction fence before
 * every protected mutation.
 */
export class RuntimeResourceOwnershipManager {
  readonly #leases = new Map<string, Active>()
  readonly #operations = new Map<string, Promise<unknown>>()
  readonly #lossCallbacks = new Set<Promise<void>>()
  readonly #ttlMs: number
  readonly #operationTimeoutMs: number
  readonly #renewAfterMs: number

  constructor(readonly store: RuntimeResourceOwnershipStore, options: {
    ttlMs?: number
    operationTimeoutMs?: number
  } = {}) {
    this.#ttlMs = options.ttlMs ?? 15_000
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 5_000 || this.#ttlMs > 120_000) {
      throw new Error('Runtime resource ownership TTL must be between 5000 and 120000 milliseconds')
    }
    this.#operationTimeoutMs = options.operationTimeoutMs ?? Math.min(5_000, Math.floor(this.#ttlMs / 3))
    if (!Number.isSafeInteger(this.#operationTimeoutMs)
      || this.#operationTimeoutMs < 100
      || this.#operationTimeoutMs >= this.#ttlMs) {
      throw new Error('Runtime resource ownership operation timeout must be at least 100 milliseconds and below the TTL')
    }
    this.#renewAfterMs = Math.max(1_000, Math.floor(this.#ttlMs / 3))
  }

  async acquire(
    rawScope: RuntimeResourceScope,
    replica: RuntimeUnitReplicaMembership,
    onLost: RuntimeResourceOwnerLostHandler,
  ): Promise<RuntimeResourceOwnerLease> {
    const scope = normalizeScope(rawScope)
    validateReplica(scope, replica)
    if (typeof onLost !== 'function') throw new TypeError('onLost must be a function')
    if (!isFuture(replica.expiresAt)) throw new RuntimeUnitReplicaMembershipExpiredError(replica.expiresAt)
    const key = resourceKey(scope)

    return await this.#serialize(key, async () => {
      if (this.#leases.has(key)) throw new Error('runtime resource ownership is already active in this manager')
      const ownerToken = randomBytes(32).toString('base64url')
      const lease = await timed(
        this.store.acquireResourceOwner(scope, replica, ownerToken, this.#ttlMs),
        this.#operationTimeoutMs,
      )
      if (!sameAcquisition(lease, scope, replica, ownerToken)) {
        throw new Error('runtime resource ownership store returned a different acquisition')
      }
      if (!isFuture(lease.expiresAt)) throw new RuntimeResourceOwnershipExpiredError(lease.expiresAt)

      const active = {} as Active
      const handle: RuntimeResourceOwnerLease = {
        scope,
        activeLease: () => this.#activeLease(active),
        release: async () => await this.#release(active),
      }
      Object.assign(active, { key, scope, lost: onLost, lease, handle, healthy: true })
      this.#leases.set(key, active)
      this.#renewLater(active)
      return handle
    })
  }

  /** Releases every lease that is active when shutdown starts, even if some releases fail. */
  async releaseAll(): Promise<void> {
    const releases = [...this.#leases.values()].map(async (active) => await this.#release(active))
    const settled = await Promise.allSettled(releases)
    // A loss callback may have started while releases were being marked unhealthy.
    await Promise.allSettled([...this.#lossCallbacks])
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'One or more runtime resource ownership releases failed')
  }

  #activeLease(active: Active): RuntimeResourceOwnership | undefined {
    if (!active.healthy || this.#leases.get(active.key) !== active) return undefined
    if (!isFuture(active.lease.expiresAt)) {
      this.#lose(active, new RuntimeResourceOwnershipExpiredError(active.lease.expiresAt))
      return undefined
    }
    return active.lease
  }

  #renewLater(active: Active): void {
    active.renewal = setTimeout(() => {
      void this.#renew(active).catch(() => undefined)
    }, this.#renewAfterMs)
    active.renewal.unref()
  }

  async #renew(active: Active): Promise<void> {
    if (!active.healthy || this.#leases.get(active.key) !== active) return
    try {
      const renewed = await timed(
        this.store.renewResourceOwner(active.lease, this.#ttlMs),
        this.#operationTimeoutMs,
      )
      if (!active.healthy || this.#leases.get(active.key) !== active) return
      if (!sameOwner(renewed, active.lease) || !isFuture(renewed.expiresAt)) {
        throw new RuntimeResourceOwnershipExpiredError(renewed.expiresAt)
      }
      active.lease = renewed
      this.#renewLater(active)
    } catch (error) {
      if (active.healthy && this.#leases.get(active.key) === active) this.#lose(active, error)
    }
  }

  #lose(active: Active, reason: unknown): void {
    if (!active.healthy || this.#leases.get(active.key) !== active) return
    this.#forget(active)
    let callback: Promise<void>
    callback = Promise.resolve()
      .then(async () => await active.lost(active.handle, reason))
      .catch(() => undefined)
      .finally(() => this.#lossCallbacks.delete(callback))
    this.#lossCallbacks.add(callback)
  }

  #release(active: Active): Promise<void> {
    if (active.release) return active.release
    if (!active.healthy || this.#leases.get(active.key) !== active) return Promise.resolve()
    // Stop visibility and renewal before starting the database release. A late
    // renewal can neither reinsert this Active object nor schedule another run.
    this.#forget(active)
    active.release = this.#serialize(active.key, async () => {
      await timed(this.store.releaseResourceOwner(active.lease), this.#operationTimeoutMs)
    })
    return active.release
  }

  #forget(active: Active): void {
    active.healthy = false
    if (this.#leases.get(active.key) === active) this.#leases.delete(active.key)
    if (active.renewal) clearTimeout(active.renewal)
    active.renewal = undefined
  }

  async #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#operations.set(key, current)
    try {
      return await current
    } finally {
      if (this.#operations.get(key) === current) this.#operations.delete(key)
    }
  }
}

function normalizeScope(scope: RuntimeResourceScope): RuntimeResourceScope {
  if (!scope.organizationId) throw new TypeError('organizationId must be a non-empty string')
  if (scope.resourceType !== 'session' && scope.resourceType !== 'task') {
    throw new TypeError('resourceType must be session or task')
  }
  if (!scope.resourceId) throw new TypeError('resourceId must be a non-empty string')
  return {
    organizationId: scope.organizationId,
    unitId: parseTenantRuntimeUnitId(scope.unitId),
    resourceType: scope.resourceType,
    resourceId: scope.resourceId,
  }
}

function validateReplica(scope: RuntimeResourceScope, replica: RuntimeUnitReplicaMembership): void {
  if (replica.organizationId !== scope.organizationId || replica.unitId !== scope.unitId) {
    throw new TypeError('resource and replica organizationId and unitId must match')
  }
  if (!(replica.expiresAt instanceof Date) || !Number.isFinite(replica.expiresAt.getTime())) {
    throw new TypeError('replica expiresAt must be a valid Date')
  }
}

function resourceKey(scope: RuntimeResourceScope): string {
  return JSON.stringify([scope.organizationId, scope.unitId, scope.resourceType, scope.resourceId])
}

function isFuture(expiresAt: Date): boolean {
  return expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now()
}

function sameAcquisition(
  lease: RuntimeResourceOwnership,
  scope: RuntimeResourceScope,
  replica: RuntimeUnitReplicaMembership,
  ownerToken: string,
): boolean {
  return lease.organizationId === scope.organizationId
    && lease.unitId === scope.unitId
    && lease.resourceType === scope.resourceType
    && lease.resourceId === scope.resourceId
    && lease.replicaId === replica.replicaId
    && lease.membershipGeneration === replica.generation
    && lease.membershipToken === replica.membershipToken
    && lease.ownerToken === ownerToken
}

function sameOwner(left: RuntimeResourceOwnership, right: RuntimeResourceOwnership): boolean {
  return left.organizationId === right.organizationId
    && left.unitId === right.unitId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId
    && left.replicaId === right.replicaId
    && left.membershipGeneration === right.membershipGeneration
    && left.membershipToken === right.membershipToken
    && left.ownerToken === right.ownerToken
    && left.generation === right.generation
}

async function timed<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Runtime resource ownership operation timed out')), timeoutMs)
      timeout.unref()
    })])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
