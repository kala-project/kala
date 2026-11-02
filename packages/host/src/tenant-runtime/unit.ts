export type TenantRuntimeUnitId = string & { readonly __parseTenantRuntimeUnitId: unique symbol }

export type TenantRuntimeUnitState =
  | 'provisioning'
  | 'loading'
  | 'ready'
  | 'draining'
  | 'suspended'
  | 'failed'
  | 'closed'

const UNIT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u

export function parseTenantRuntimeUnitId(value: string): TenantRuntimeUnitId {
  if (!UNIT_ID.test(value) || value === '.' || value === '..') {
    throw new Error('invalid TenantRuntimeUnit id')
  }
  return value as TenantRuntimeUnitId
}

export interface TenantRuntimeUnit {
  readonly id: TenantRuntimeUnitId
  readonly state: TenantRuntimeUnitState
  readonly origin: string
  purgeOrganizationSessions?(params: { organizationId: string; before: Date }): Promise<{ sessions: number; sessionIds: string[] }>
  drain(): Promise<void>
  close(): Promise<void>
}

export type TenantRuntimeUnitFactory = (id: TenantRuntimeUnitId) => Promise<TenantRuntimeUnit>

/** Serializes first load and owns the lifecycle of all loaded runtime Units. */
export class TenantRuntimeUnitRegistry {
  private readonly units = new Map<TenantRuntimeUnitId, TenantRuntimeUnit>()
  private readonly loading = new Map<TenantRuntimeUnitId, Promise<TenantRuntimeUnit>>()
  private readonly closing = new Map<TenantRuntimeUnitId, Promise<void>>()
  private draining = false

  constructor(
    private readonly factory: TenantRuntimeUnitFactory,
    private readonly maxLoadedUnits = Number.POSITIVE_INFINITY,
    private readonly countsTowardCapacity: (id: TenantRuntimeUnitId) => boolean = () => true,
  ) {}

  get(id: TenantRuntimeUnitId): TenantRuntimeUnit | undefined {
    return this.units.get(id)
  }

  list(): readonly TenantRuntimeUnit[] {
    return [...this.units.values()]
  }

  async getOrLoad(id: TenantRuntimeUnitId): Promise<TenantRuntimeUnit> {
    const closing = this.closing.get(id)
    if (closing) await closing
    const loaded = this.units.get(id)
    if (loaded) return loaded
    if (this.draining) throw new Error('TenantRuntimeUnitRegistry is draining')
    const pending = this.loading.get(id)
    if (pending) return pending
    if (this.countsTowardCapacity(id)) {
      const count = [...this.units.keys(), ...this.loading.keys()].filter(this.countsTowardCapacity).length
      if (count >= this.maxLoadedUnits) throw new Error('TenantRuntimeUnit capacity exceeded')
    }
    const creation = this.factory(id).then((unit) => {
      if (unit.id !== id) throw new Error('TenantRuntimeUnit factory returned a mismatched id')
      this.units.set(id, unit)
      return unit
    }).finally(() => this.loading.delete(id))
    this.loading.set(id, creation)
    return creation
  }

  close(id: TenantRuntimeUnitId): Promise<void> {
    const existing = this.closing.get(id)
    if (existing) return existing
    const teardown = Promise.resolve().then(async () => {
      const pending = this.loading.get(id)
      const unit = this.units.get(id) ?? (pending ? await pending : undefined)
      if (!unit) return
      await unit.close()
      this.units.delete(id)
    })
    this.closing.set(id, teardown)
    void teardown.then(() => {
      if (this.closing.get(id) === teardown) this.closing.delete(id)
    }, () => {})
    return teardown
  }

  async drainAll(): Promise<void> {
    this.draining = true
    await Promise.all([...this.loading.values()].map((pending) => pending.catch(() => undefined)))
    await Promise.all([...this.units.values()].map((unit) => unit.drain()))
  }

  async closeAll(): Promise<void> {
    this.draining = true
    const ids = new Set([...this.closing.keys(), ...this.loading.keys(), ...this.units.keys()])
    const results = await Promise.allSettled([...ids].map((id) => this.close(id)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
