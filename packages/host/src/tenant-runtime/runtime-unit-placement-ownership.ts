import { randomBytes } from 'node:crypto'

import {
  type AcquireRuntimeUnitPlacementInput,
  type RuntimeUnitLivePlacement,
  type RuntimeUnitPlacementLease,
  type RuntimeUnitPlacementScope,
} from './postgres-runtime-unit-placement-store.js'
import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId } from './unit.js'

export interface RuntimeUnitPlacementStore {
  acquire(input: AcquireRuntimeUnitPlacementInput, ttlMs: number): Promise<RuntimeUnitPlacementLease>
  renew(lease: RuntimeUnitPlacementLease, ttlMs: number): Promise<RuntimeUnitPlacementLease>
  release(lease: RuntimeUnitPlacementLease): Promise<void>
  lookupLive(scope: RuntimeUnitPlacementScope): Promise<RuntimeUnitLivePlacement | undefined>
}

export interface RuntimeUnitPlacementOwnership {
  activate(unitId: string, organizationId: string): Promise<RuntimeUnitPlacementLease>
  activeLease(unitId: string, organizationId: string): RuntimeUnitPlacementLease
  isCurrent(unitId: string): Promise<boolean>
  release(unitId: string): Promise<void>
  releaseAll(): Promise<void>
  setLeaseLostHandler(handler: (unitId: TenantRuntimeUnitId) => Promise<void>): void
}

type ActiveLease = {
  lease: RuntimeUnitPlacementLease
  renewal?: NodeJS.Timeout
}

/**
 * Owns the in-process side of PostgreSQL placement leases. Every routing check
 * goes back to PostgreSQL; the local lease is only a fencing identity and is
 * never an availability cache.
 */
export class PostgresRuntimeUnitPlacementOwnership implements RuntimeUnitPlacementOwnership {
  readonly #nodeId: string
  readonly #origin: string
  readonly #ttlMs: number
  readonly #operationTimeoutMs: number
  readonly #renewAfterMs: number
  readonly #leases = new Map<TenantRuntimeUnitId, ActiveLease>()
  readonly #operations = new Map<TenantRuntimeUnitId, Promise<void>>()
  #leaseLost: (unitId: TenantRuntimeUnitId) => Promise<void> = async () => undefined

  constructor(readonly store: RuntimeUnitPlacementStore, options: {
    nodeId: string
    origin: string
    ttlMs?: number
    operationTimeoutMs?: number
  }) {
    this.#nodeId = validateNodeId(options.nodeId)
    this.#origin = validateNodeOrigin(options.origin)
    this.#ttlMs = options.ttlMs ?? 15_000
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 5_000 || this.#ttlMs > 120_000) {
      throw new Error('Runtime Unit placement TTL must be an integer between 5000 and 120000 milliseconds')
    }
    this.#renewAfterMs = Math.max(1_000, Math.floor(this.#ttlMs / 3))
    this.#operationTimeoutMs = options.operationTimeoutMs ?? Math.min(5_000, Math.floor(this.#ttlMs / 3))
    if (!Number.isSafeInteger(this.#operationTimeoutMs) || this.#operationTimeoutMs < 100 || this.#operationTimeoutMs >= this.#ttlMs) {
      throw new Error('Runtime Unit placement operation timeout must be an integer below the lease TTL')
    }
  }

  setLeaseLostHandler(handler: (unitId: TenantRuntimeUnitId) => Promise<void>): void {
    this.#leaseLost = handler
  }

  async activate(rawUnitId: string, organizationId: string): Promise<RuntimeUnitPlacementLease> {
    const unitId = parseTenantRuntimeUnitId(rawUnitId)
    const scope = { unitId, organizationId: validateOrganizationId(organizationId) }
    await this.#serialize(unitId, async () => {
      const active = this.#leases.get(unitId)
      if (active) {
        if (active.lease.organizationId !== scope.organizationId || !await this.#lookupMatches(active.lease)) {
          await this.#failClosed(unitId, active)
          throw new Error(`Runtime Unit ${unitId} no longer owns its placement lease`)
        }
        return
      }
      const lease = await withTimeout(
        this.store.acquire({
          ...scope,
          nodeId: this.#nodeId,
          ownerToken: randomBytes(32).toString('base64url'),
          origin: this.#origin,
        }, this.#ttlMs),
        this.#operationTimeoutMs,
        'Runtime Unit placement acquire timed out',
      )
      const activation = { lease } satisfies ActiveLease
      this.#leases.set(unitId, activation)
      this.#scheduleRenewal(unitId, activation)
    })
    return this.activeLease(unitId, scope.organizationId)
  }

  activeLease(rawUnitId: string, organizationId: string): RuntimeUnitPlacementLease {
    const unitId = parseTenantRuntimeUnitId(rawUnitId)
    const active = this.#leases.get(unitId)
    if (!active || active.lease.organizationId !== validateOrganizationId(organizationId)) {
      throw new Error(`Runtime Unit ${unitId} has no active placement lease for organization ${organizationId}`)
    }
    return { ...active.lease }
  }

  async isCurrent(rawUnitId: string): Promise<boolean> {
    const unitId = parseTenantRuntimeUnitId(rawUnitId)
    const active = this.#leases.get(unitId)
    if (!active) return false
    try {
      if (await this.#lookupMatches(active.lease) && this.#leases.get(unitId) === active) return true
    } catch {
      // PostgreSQL is the authority. Any lookup error or timeout is unavailable.
    }
    await this.#failClosed(unitId, active)
    return false
  }

  async release(rawUnitId: string): Promise<void> {
    const unitId = parseTenantRuntimeUnitId(rawUnitId)
    await this.#serialize(unitId, async () => {
      const active = this.#leases.get(unitId)
      if (!active) return
      this.#forget(unitId, active)
      await withTimeout(this.store.release(active.lease), this.#operationTimeoutMs, 'Runtime Unit placement release timed out')
    })
  }

  async releaseAll(): Promise<void> {
    const unitIds = [...this.#leases.keys()]
    const results = await Promise.allSettled(unitIds.map(async (unitId) => await this.release(unitId)))
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }

  async #lookupMatches(lease: RuntimeUnitPlacementLease): Promise<boolean> {
    const live = await withTimeout(
      this.store.lookupLive({ unitId: lease.unitId, organizationId: lease.organizationId }),
      this.#operationTimeoutMs,
      'Runtime Unit placement lookup timed out',
    )
    return live !== undefined
      && live.nodeId === lease.nodeId
      && live.origin === lease.origin
      && live.generation === lease.generation
  }

  #scheduleRenewal(unitId: TenantRuntimeUnitId, active: ActiveLease): void {
    active.renewal = setTimeout(() => { void this.#renew(unitId, active).catch(() => undefined) }, this.#renewAfterMs)
    active.renewal.unref()
  }

  async #renew(unitId: TenantRuntimeUnitId, active: ActiveLease): Promise<void> {
    if (this.#leases.get(unitId) !== active) return
    try {
      const renewed = await withTimeout(
        this.store.renew(active.lease, this.#ttlMs),
        this.#operationTimeoutMs,
        'Runtime Unit placement renewal timed out',
      )
      if (this.#leases.get(unitId) !== active) return
      active.lease = renewed
      this.#scheduleRenewal(unitId, active)
    } catch {
      await this.#failClosed(unitId, active)
    }
  }

  async #failClosed(unitId: TenantRuntimeUnitId, active: ActiveLease): Promise<void> {
    if (this.#leases.get(unitId) !== active) return
    this.#forget(unitId, active)
    await this.#leaseLost(unitId)
  }

  #forget(unitId: TenantRuntimeUnitId, active: ActiveLease): void {
    if (this.#leases.get(unitId) !== active) return
    this.#leases.delete(unitId)
    if (active.renewal) clearTimeout(active.renewal)
  }

  async #serialize(unitId: TenantRuntimeUnitId, operation: () => Promise<void>): Promise<void> {
    const previous = this.#operations.get(unitId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#operations.set(unitId, current)
    try {
      await current
    } finally {
      if (this.#operations.get(unitId) === current) this.#operations.delete(unitId)
    }
  }
}

export function validateNodeId(value: string): string {
  if (value.length < 1 || value.length > 200 || value !== value.trim() || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u.test(value)) {
    throw new Error('KALA_RUNTIME_NODE_ID must be 1-200 safe identifier characters')
  }
  return value
}

export function validateNodeOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('KALA_RUNTIME_NODE_ORIGIN must be a valid absolute HTTP(S) origin') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new Error('KALA_RUNTIME_NODE_ORIGIN must be an exact HTTP(S) origin without credentials, path, query, or fragment')
  }
  return value
}

function validateOrganizationId(value: string): string {
  if (value.length < 1 || value.length > 200 || value !== value.trim()) throw new Error('invalid organizationId')
  return value
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
