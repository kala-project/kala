import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AcquireRuntimeUnitPlacementInput,
  RuntimeUnitLivePlacement,
  RuntimeUnitPlacementLease,
  RuntimeUnitPlacementScope,
} from './postgres-runtime-unit-placement-store.js'
import {
  PostgresRuntimeUnitPlacementOwnership,
  type RuntimeUnitPlacementStore,
  validateNodeId,
  validateNodeOrigin,
} from './runtime-unit-placement-ownership.js'

const unitId = 'unit-a' as const
const scope = { unitId, organizationId: 'org-a' }

class FakePlacementStore implements RuntimeUnitPlacementStore {
  lease?: RuntimeUnitPlacementLease
  readonly acquired: AcquireRuntimeUnitPlacementInput[] = []
  readonly released: RuntimeUnitPlacementLease[] = []
  lookupError?: Error
  renewError?: Error

  async acquire(input: AcquireRuntimeUnitPlacementInput, ttlMs: number): Promise<RuntimeUnitPlacementLease> {
    this.acquired.push(input)
    this.lease = { ...input, generation: 1n, expiresAt: new Date(Date.now() + ttlMs) }
    return this.lease
  }

  async renew(lease: RuntimeUnitPlacementLease, ttlMs: number): Promise<RuntimeUnitPlacementLease> {
    if (this.renewError) throw this.renewError
    this.lease = { ...lease, expiresAt: new Date(Date.now() + ttlMs) }
    return this.lease
  }

  async release(lease: RuntimeUnitPlacementLease): Promise<void> {
    this.released.push(lease)
    if (this.lease?.ownerToken === lease.ownerToken) this.lease = undefined
  }

  async lookupLive(requested: RuntimeUnitPlacementScope): Promise<RuntimeUnitLivePlacement | undefined> {
    if (this.lookupError) throw this.lookupError
    if (!this.lease || requested.unitId !== this.lease.unitId || requested.organizationId !== this.lease.organizationId) return undefined
    const { ownerToken: _ownerToken, ...live } = this.lease
    return live
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PostgresRuntimeUnitPlacementOwnership', () => {
  it('uses a fresh owner token, checks PostgreSQL on every gate, and releases that exact lease', async () => {
    const store = new FakePlacementStore()
    const ownership = createOwnership(store)

    await ownership.activate(unitId, scope.organizationId)
    expect(store.acquired).toHaveLength(1)
    expect(store.acquired[0]).toMatchObject({ ...scope, nodeId: 'node-a', origin: 'https://runtime-a.example' })
    expect(store.acquired[0]!.ownerToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
    expect(ownership.activeLease(unitId, scope.organizationId)).toEqual(store.lease)
    expect(() => ownership.activeLease(unitId, 'org-other')).toThrow(/no active placement lease/u)

    const lookup = vi.spyOn(store, 'lookupLive')
    expect(await ownership.isCurrent(unitId)).toBe(true)
    expect(await ownership.isCurrent(unitId)).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(2)

    const acquiredLease = store.lease!
    await ownership.release(unitId)
    expect(store.released).toEqual([acquiredLease])
    expect(await ownership.isCurrent(unitId)).toBe(false)
    expect(() => ownership.activeLease(unitId, scope.organizationId)).toThrow(/no active placement lease/u)
  })

  it('fails closed when DB lookup fails or the live node origin/generation differs', async () => {
    const store = new FakePlacementStore()
    const ownership = createOwnership(store)
    const lost = vi.fn(async () => undefined)
    ownership.setLeaseLostHandler(lost)
    await ownership.activate(unitId, scope.organizationId)

    store.lease = { ...store.lease!, origin: 'https://runtime-b.example', generation: 2n }
    expect(await ownership.isCurrent(unitId)).toBe(false)
    expect(lost).toHaveBeenCalledWith(unitId)
    expect(await ownership.isCurrent(unitId)).toBe(false)

    await ownership.activate(unitId, scope.organizationId)
    store.lookupError = new Error('postgres unavailable')
    expect(await ownership.isCurrent(unitId)).toBe(false)
    expect(lost).toHaveBeenCalledTimes(2)
  })

  it('treats a hanging PostgreSQL lookup as unavailable instead of using the local lease cache', async () => {
    vi.useFakeTimers()
    const store = new FakePlacementStore()
    const ownership = createOwnership(store)
    const lost = vi.fn(async () => undefined)
    ownership.setLeaseLostHandler(lost)
    await ownership.activate(unitId, scope.organizationId)
    vi.spyOn(store, 'lookupLive').mockImplementation(async () => await new Promise(() => undefined))

    const current = ownership.isCurrent(unitId)
    await vi.advanceTimersByTimeAsync(501)

    expect(await current).toBe(false)
    expect(lost).toHaveBeenCalledWith(unitId)
  })

  it('renews periodically and immediately revokes ownership on renewal failure', async () => {
    vi.useFakeTimers()
    const store = new FakePlacementStore()
    const renew = vi.spyOn(store, 'renew')
    const ownership = createOwnership(store)
    const lost = vi.fn(async () => undefined)
    ownership.setLeaseLostHandler(lost)
    await ownership.activate(unitId, scope.organizationId)
    store.renewError = new Error('fenced')

    await vi.advanceTimersByTimeAsync(1_700)

    expect(renew).toHaveBeenCalledTimes(1)
    expect(lost).toHaveBeenCalledWith(unitId)
    expect(await ownership.isCurrent(unitId)).toBe(false)
  })

  it('validates explicit node identity and exact HTTP(S) origin', () => {
    expect(validateNodeId('runtime-node_01')).toBe('runtime-node_01')
    expect(() => validateNodeId(' node ')).toThrow(/KALA_RUNTIME_NODE_ID/u)
    expect(validateNodeOrigin('https://runtime.example:8443')).toBe('https://runtime.example:8443')
    for (const value of ['runtime.example', 'ftp://runtime.example', Object.assign(new URL('https://runtime.example'), { username: 'user' }).href, 'https://runtime.example/path', 'https://runtime.example/']) {
      expect(() => validateNodeOrigin(value)).toThrow(/KALA_RUNTIME_NODE_ORIGIN/u)
    }
  })
})

function createOwnership(store: RuntimeUnitPlacementStore): PostgresRuntimeUnitPlacementOwnership {
  return new PostgresRuntimeUnitPlacementOwnership(store, {
    nodeId: 'node-a',
    origin: 'https://runtime-a.example',
    ttlMs: 5_000,
    operationTimeoutMs: 500,
  })
}
