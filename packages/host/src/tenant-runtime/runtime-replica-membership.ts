import { randomBytes } from 'node:crypto'

import type {
  RegisterRuntimeUnitReplicaInput,
  RuntimeUnitReplicaMembership,
} from './postgres-runtime-resource-ownership.js'
import { validateNodeOrigin } from './runtime-unit-placement-ownership.js'
import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from './unit.js'

export interface RuntimeReplicaMembershipStore {
  registerReplica(input: RegisterRuntimeUnitReplicaInput, ttlMs: number): Promise<RuntimeUnitReplicaMembership>
  renewReplica(lease: RuntimeUnitReplicaMembership, ttlMs: number): Promise<RuntimeUnitReplicaMembership>
  releaseReplica(lease: RuntimeUnitReplicaMembership): Promise<void>
}

export interface RuntimeReplicaMembership {
  activate(unitId: string, organizationId: string): Promise<void>
  activeLease(unitId: string, organizationId: string): RuntimeUnitReplicaMembership | undefined
  release(unitId: string): Promise<void>
  releaseAll(): Promise<void>
  setLeaseLostHandler(handler: (unitId: TenantRuntimeUnitId) => Promise<void>): void
}

type Active = { lease: RuntimeUnitReplicaMembership; renewal?: NodeJS.Timeout }

/**
 * Experimental live membership, intentionally separate from Session ownership.
 * A registered replica cannot run any work merely by appearing in this table:
 * the existing Unit placement and its SQL transaction fence remain mandatory.
 */
export class PostgresRuntimeReplicaMembership implements RuntimeReplicaMembership {
  readonly #leases = new Map<TenantRuntimeUnitId, Active>()
  readonly #operations = new Map<TenantRuntimeUnitId, Promise<void>>()
  readonly #ttlMs: number
  readonly #operationTimeoutMs: number
  readonly #renewAfterMs: number
  readonly #replicaId: string
  readonly #origin: string
  #leaseLost: (unitId: TenantRuntimeUnitId) => Promise<void> = async () => undefined

  constructor(readonly store: RuntimeReplicaMembershipStore, options: {
    replicaId: string; origin: string; ttlMs?: number; operationTimeoutMs?: number
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(options.replicaId)) throw new Error('invalid replicaId')
    this.#replicaId = options.replicaId
    this.#origin = validateNodeOrigin(options.origin)
    this.#ttlMs = options.ttlMs ?? 15_000
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 5_000 || this.#ttlMs > 120_000) {
      throw new Error('Runtime replica membership TTL must be between 5000 and 120000 milliseconds')
    }
    this.#operationTimeoutMs = options.operationTimeoutMs ?? Math.min(5_000, Math.floor(this.#ttlMs / 3))
    if (!Number.isSafeInteger(this.#operationTimeoutMs) || this.#operationTimeoutMs < 100 || this.#operationTimeoutMs >= this.#ttlMs) {
      throw new Error('Runtime replica membership operation timeout must be below the TTL')
    }
    this.#renewAfterMs = Math.max(1_000, Math.floor(this.#ttlMs / 3))
  }

  setLeaseLostHandler(handler: (unitId: TenantRuntimeUnitId) => Promise<void>): void {
    this.#leaseLost = handler
  }

  async activate(rawId: string, organizationId: string): Promise<void> {
    const unitId = parseTenantRuntimeUnitId(rawId)
    if (!organizationId || organizationId.trim() !== organizationId || organizationId.length > 200) throw new Error('invalid organizationId')
    let lostExistingLease = false
    try {
      await this.#serialize(unitId, async () => {
        const active = this.#leases.get(unitId)
        if (active) {
          if (active.lease.organizationId !== organizationId) throw new Error('replica membership organization mismatch')
          try {
            active.lease = await timed(this.store.renewReplica(active.lease, this.#ttlMs), this.#operationTimeoutMs)
            return
          } catch (error) {
            this.#forget(unitId, active)
            lostExistingLease = true
            throw error
          }
        }
        const lease = await timed(this.store.registerReplica({
          organizationId, unitId, replicaId: this.#replicaId,
          membershipToken: randomBytes(32).toString('base64url'), origin: this.#origin,
        }, this.#ttlMs), this.#operationTimeoutMs)
        const registered: Active = { lease }
        this.#leases.set(unitId, registered)
        this.#renewLater(unitId, registered)
      })
    } catch (error) {
      // Invoke the fail-closed callback only after releasing the per-Unit
      // serialization lock: the callback itself may release this membership.
      if (lostExistingLease) await this.#leaseLost(unitId)
      throw error
    }
  }

  /** A synchronous, server-only capability; never return a stale or differently scoped membership. */
  activeLease(rawId: string, organizationId: string): RuntimeUnitReplicaMembership | undefined {
    const unitId = parseTenantRuntimeUnitId(rawId)
    const active = this.#leases.get(unitId)
    if (!active || active.lease.organizationId !== organizationId) return undefined
    if (active.lease.expiresAt.getTime() <= Date.now()) {
      this.#forget(unitId, active)
      void Promise.resolve().then(async () => await this.#leaseLost(unitId)).catch(() => undefined)
      return undefined
    }
    return { ...active.lease, expiresAt: new Date(active.lease.expiresAt) }
  }

  async release(rawId: string): Promise<void> {
    const unitId = parseTenantRuntimeUnitId(rawId)
    await this.#serialize(unitId, async () => {
      const active = this.#leases.get(unitId)
      if (!active) return
      this.#forget(unitId, active)
      await timed(this.store.releaseReplica(active.lease), this.#operationTimeoutMs)
    })
  }

  async releaseAll(): Promise<void> {
    const settled = await Promise.allSettled([...this.#leases.keys()].map(async (id) => await this.release(id)))
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }

  #renewLater(unitId: TenantRuntimeUnitId, active: Active): void {
    active.renewal = setTimeout(() => { void this.#renew(unitId, active).catch(() => undefined) }, this.#renewAfterMs)
    active.renewal.unref()
  }

  async #renew(unitId: TenantRuntimeUnitId, active: Active): Promise<void> {
    if (this.#leases.get(unitId) !== active) return
    try {
      const lease = await timed(this.store.renewReplica(active.lease, this.#ttlMs), this.#operationTimeoutMs)
      if (this.#leases.get(unitId) !== active) return
      active.lease = lease
      this.#renewLater(unitId, active)
    } catch {
      if (this.#leases.get(unitId) !== active) return
      this.#forget(unitId, active)
      await this.#leaseLost(unitId)
    }
  }

  #forget(unitId: TenantRuntimeUnitId, active: Active): void {
    if (this.#leases.get(unitId) !== active) return
    this.#leases.delete(unitId)
    if (active.renewal) clearTimeout(active.renewal)
  }

  async #serialize(unitId: TenantRuntimeUnitId, operation: () => Promise<void>): Promise<void> {
    const previous = this.#operations.get(unitId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#operations.set(unitId, current)
    try { await current } finally {
      if (this.#operations.get(unitId) === current) this.#operations.delete(unitId)
    }
  }
}

async function timed<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Runtime replica membership operation timed out')), timeoutMs)
      timeout.unref()
    })])
  } finally { if (timeout) clearTimeout(timeout) }
}
