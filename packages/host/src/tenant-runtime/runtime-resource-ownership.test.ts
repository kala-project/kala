import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RuntimeResourceOwnershipFencedError,
  RuntimeResourceOwnershipHeldError,
  type RuntimeResourceOwnership,
  type RuntimeResourceScope,
  type RuntimeUnitReplicaMembership,
} from './postgres-runtime-resource-ownership.js'
import {
  RuntimeResourceOwnershipManager,
  type RuntimeResourceOwnershipStore,
} from './runtime-resource-ownership.js'

const scope: RuntimeResourceScope = {
  organizationId: 'org-a', unitId: 'unit-a', resourceType: 'session', resourceId: 'session-a',
}

function replica(overrides: Partial<RuntimeUnitReplicaMembership> = {}): RuntimeUnitReplicaMembership {
  return {
    organizationId: 'org-a', unitId: 'unit-a', replicaId: 'replica-a',
    membershipToken: 'membership-a', origin: 'http://runtime.test:13002',
    generation: 3n, expiresAt: new Date(Date.now() + 30_000), ...overrides,
  }
}

function fixture() {
  let generation = 0n
  const acquireResourceOwner = vi.fn(async (
    acquiredScope: RuntimeResourceScope,
    member: RuntimeUnitReplicaMembership,
    ownerToken: string,
    ttlMs: number,
  ): Promise<RuntimeResourceOwnership> => ({
    ...acquiredScope,
    replicaId: member.replicaId,
    membershipGeneration: member.generation,
    membershipToken: member.membershipToken,
    ownerToken,
    generation: ++generation,
    expiresAt: new Date(Date.now() + ttlMs),
  }))
  const renewResourceOwner = vi.fn(async (
    lease: RuntimeResourceOwnership,
    ttlMs: number,
  ): Promise<RuntimeResourceOwnership> => ({ ...lease, expiresAt: new Date(Date.now() + ttlMs) }))
  const releaseResourceOwner = vi.fn(async (_lease: RuntimeResourceOwnership): Promise<void> => undefined)
  const store: RuntimeResourceOwnershipStore = {
    acquireResourceOwner, renewResourceOwner, releaseResourceOwner,
  }
  const manager = new RuntimeResourceOwnershipManager(store, { ttlMs: 5_000, operationTimeoutMs: 100 })
  return { manager, acquireResourceOwner, renewResourceOwner, releaseResourceOwner }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => { vi.useRealTimers() })

describe('experimental Runtime resource ownership lifecycle', () => {
  it('acquires with a random per-acquisition token, renews, and releases normally', async () => {
    vi.useFakeTimers()
    const { manager, acquireResourceOwner, renewResourceOwner, releaseResourceOwner } = fixture()
    const lost = vi.fn()

    const handle = await manager.acquire(scope, replica(), lost)
    const acquired = handle.activeLease()
    expect(acquireResourceOwner).toHaveBeenCalledWith(scope, expect.any(Object), expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), 5_000)
    expect(acquired).toMatchObject({ ...scope, generation: 1n, membershipGeneration: 3n })

    await vi.advanceTimersByTimeAsync(1_665)
    expect(renewResourceOwner).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(renewResourceOwner).toHaveBeenCalledTimes(1)
    expect(handle.activeLease()?.expiresAt.getTime()).toBe(Date.now() + 5_000)

    await handle.release()
    expect(handle.activeLease()).toBeUndefined()
    expect(releaseResourceOwner).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewResourceOwner).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
  })

  it('rejects held acquisition and never exposes or retries an owner', async () => {
    const { manager, acquireResourceOwner, renewResourceOwner } = fixture()
    const lost = vi.fn()
    acquireResourceOwner.mockRejectedValueOnce(new RuntimeResourceOwnershipHeldError('replica-b', new Date(Date.now() + 5_000)))

    await expect(manager.acquire(scope, replica(), lost)).rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
    expect(renewResourceOwner).not.toHaveBeenCalled()
    expect(lost).not.toHaveBeenCalled()
    await manager.releaseAll()
  })

  it('fails closed and invokes the stop callback once when renewal is fenced', async () => {
    vi.useFakeTimers()
    const { manager, renewResourceOwner, releaseResourceOwner } = fixture()
    const lost = vi.fn(async () => undefined)
    const handle = await manager.acquire(scope, replica(), lost)
    renewResourceOwner.mockRejectedValueOnce(new RuntimeResourceOwnershipFencedError())

    await vi.advanceTimersByTimeAsync(1_667)
    expect(handle.activeLease()).toBeUndefined()
    expect(lost).toHaveBeenCalledTimes(1)
    expect(lost.mock.calls[0]![0]).toBe(handle)
    expect(lost.mock.calls[0]![1]).toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewResourceOwner).toHaveBeenCalledTimes(1)
    await handle.release()
    expect(releaseResourceOwner).not.toHaveBeenCalled()
  })

  it('does not let a renewal finishing after release resurrect the old acquisition', async () => {
    vi.useFakeTimers()
    const { manager, renewResourceOwner, releaseResourceOwner } = fixture()
    const renewal = deferred<RuntimeResourceOwnership>()
    renewResourceOwner.mockImplementationOnce(async () => await renewal.promise)
    const lost = vi.fn()
    const handle = await manager.acquire(scope, replica(), lost)
    const oldLease = handle.activeLease()!

    await vi.advanceTimersByTimeAsync(1_667)
    expect(renewResourceOwner).toHaveBeenCalledTimes(1)
    const releasing = handle.release()
    expect(handle.activeLease()).toBeUndefined()
    await releasing
    renewal.resolve({ ...oldLease, expiresAt: new Date(Date.now() + 5_000) })
    await flush()

    expect(handle.activeLease()).toBeUndefined()
    expect(releaseResourceOwner).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewResourceOwner).toHaveBeenCalledTimes(1)
  })

  it('isolates a subsequent generation from the released handle and owner token', async () => {
    const { manager, acquireResourceOwner, releaseResourceOwner } = fixture()
    const old = await manager.acquire(scope, replica(), vi.fn())
    const oldLease = old.activeLease()!
    await old.release()

    const current = await manager.acquire(scope, replica(), vi.fn())
    const currentLease = current.activeLease()!
    expect(currentLease.generation).toBe(2n)
    expect(currentLease.ownerToken).not.toBe(oldLease.ownerToken)
    expect(old.activeLease()).toBeUndefined()
    await old.release()
    expect(releaseResourceOwner).toHaveBeenCalledTimes(1)
    expect(current.activeLease()).toBe(currentLease)
    expect(acquireResourceOwner).toHaveBeenCalledTimes(2)
    await current.release()
  })

  it('fails closed on renewal timeout and ignores the eventual old result', async () => {
    vi.useFakeTimers()
    const { manager, renewResourceOwner } = fixture()
    const renewal = deferred<RuntimeResourceOwnership>()
    renewResourceOwner.mockImplementationOnce(async () => await renewal.promise)
    const lost = vi.fn(async () => undefined)
    const handle = await manager.acquire(scope, replica(), lost)
    const lease = handle.activeLease()!

    await vi.advanceTimersByTimeAsync(1_767)
    expect(handle.activeLease()).toBeUndefined()
    expect(lost).toHaveBeenCalledTimes(1)
    expect(lost.mock.calls[0]![1]).toEqual(expect.objectContaining({ message: 'Runtime resource ownership operation timed out' }))

    renewal.resolve({ ...lease, expiresAt: new Date(Date.now() + 5_000) })
    await flush()
    expect(handle.activeLease()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewResourceOwner).toHaveBeenCalledTimes(1)
  })

  it('releaseAll settles every release, reports failures, and stops all renewals', async () => {
    vi.useFakeTimers()
    const { manager, releaseResourceOwner, renewResourceOwner } = fixture()
    const taskScope: RuntimeResourceScope = { ...scope, resourceType: 'task', resourceId: 'task-a' }
    const session = await manager.acquire(scope, replica(), vi.fn())
    const task = await manager.acquire(taskScope, replica(), vi.fn())
    releaseResourceOwner.mockImplementation(async (lease) => {
      if (lease.resourceType === 'session') throw new Error('database unavailable')
    })

    await expect(manager.releaseAll()).rejects.toEqual(expect.objectContaining({
      name: 'AggregateError', message: 'One or more runtime resource ownership releases failed',
    }))
    expect(releaseResourceOwner).toHaveBeenCalledTimes(2)
    expect(session.activeLease()).toBeUndefined()
    expect(task.activeLease()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewResourceOwner).not.toHaveBeenCalled()
  })

  it('waits for an in-flight loss callback during shutdown without leaking callback rejection', async () => {
    vi.useFakeTimers()
    const { manager, renewResourceOwner } = fixture()
    const callback = deferred<void>()
    const lost = vi.fn(async () => await callback.promise)
    await manager.acquire(scope, replica(), lost)
    renewResourceOwner.mockRejectedValueOnce(new Error('database unavailable'))
    await vi.advanceTimersByTimeAsync(1_667)

    let shutdownDone = false
    const shutdown = manager.releaseAll().then(() => { shutdownDone = true })
    await flush()
    expect(shutdownDone).toBe(false)
    callback.resolve()
    await shutdown
    expect(shutdownDone).toBe(true)
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('validates TTL, timeout, membership scope, and current membership expiry', async () => {
    const { store } = (() => {
      const current = fixture()
      return { store: {
        acquireResourceOwner: current.acquireResourceOwner,
        renewResourceOwner: current.renewResourceOwner,
        releaseResourceOwner: current.releaseResourceOwner,
      } satisfies RuntimeResourceOwnershipStore }
    })()
    expect(() => new RuntimeResourceOwnershipManager(store, { ttlMs: 4_999 })).toThrow('TTL must be between')
    expect(() => new RuntimeResourceOwnershipManager(store, { ttlMs: 5_000, operationTimeoutMs: 99 })).toThrow('at least 100')
    expect(() => new RuntimeResourceOwnershipManager(store, { ttlMs: 5_000, operationTimeoutMs: 5_000 })).toThrow('below the TTL')

    const manager = new RuntimeResourceOwnershipManager(store, { ttlMs: 5_000 })
    await expect(manager.acquire(scope, replica({ organizationId: 'org-b' }), vi.fn())).rejects.toThrow('must match')
    await expect(manager.acquire(scope, replica({ expiresAt: new Date(Date.now() - 1) }), vi.fn())).rejects.toThrow('expired')
  })
})
