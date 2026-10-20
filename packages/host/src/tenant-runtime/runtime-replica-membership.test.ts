import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RegisterRuntimeUnitReplicaInput, RuntimeUnitReplicaMembership } from './postgres-runtime-resource-ownership.js'
import { PostgresRuntimeReplicaMembership, type RuntimeReplicaMembershipStore } from './runtime-replica-membership.js'

function fixture() {
  const registerReplica = vi.fn(async (input: RegisterRuntimeUnitReplicaInput): Promise<RuntimeUnitReplicaMembership> => ({
    ...input, generation: 1n, expiresAt: new Date(Date.now() + 5_000),
  }))
  const renewReplica = vi.fn(async (lease: RuntimeUnitReplicaMembership): Promise<RuntimeUnitReplicaMembership> => ({
    ...lease, expiresAt: new Date(Date.now() + 5_000),
  }))
  const releaseReplica = vi.fn(async (_lease: RuntimeUnitReplicaMembership) => undefined)
  const store: RuntimeReplicaMembershipStore = { registerReplica, renewReplica, releaseReplica }
  const membership = new PostgresRuntimeReplicaMembership(store, {
    replicaId: 'replica-test', origin: 'http://runtime.test:13002', ttlMs: 5_000,
  })
  return { store, membership, registerReplica, renewReplica, releaseReplica }
}

afterEach(() => { vi.useRealTimers() })

describe('experimental Runtime replica membership lifecycle', () => {
  it('registers a unique token, renews, and releases only the acquired membership', async () => {
    vi.useFakeTimers()
    const { membership, registerReplica, renewReplica, releaseReplica } = fixture()
    await membership.activate('unit-a', 'org-a')
    const live = membership.activeLease('unit-a', 'org-a')
    expect(live).toMatchObject({ unitId: 'unit-a', organizationId: 'org-a' })
    expect(membership.activeLease('unit-a', 'org-b')).toBeUndefined()
    expect(membership.activeLease('unit-b', 'org-a')).toBeUndefined()
    live!.expiresAt.setTime(0)
    expect(membership.activeLease('unit-a', 'org-a')?.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(registerReplica).toHaveBeenCalledTimes(1)
    const registration = registerReplica.mock.calls[0]![0]
    expect(registration).toMatchObject({ unitId: 'unit-a', organizationId: 'org-a', replicaId: 'replica-test' })
    expect(registration.membershipToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await vi.advanceTimersByTimeAsync(1_667)
    expect(renewReplica).toHaveBeenCalledTimes(1)
    await membership.activate('unit-a', 'org-a')
    expect(registerReplica).toHaveBeenCalledTimes(1)
    expect(renewReplica).toHaveBeenCalledTimes(2)
    await membership.releaseAll()
    expect(membership.activeLease('unit-a', 'org-a')).toBeUndefined()
    expect(releaseReplica).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewReplica).toHaveBeenCalledTimes(2)
  })

  it('hides an expired local membership immediately and notifies the Unit once', async () => {
    vi.useFakeTimers()
    const { membership, registerReplica, releaseReplica } = fixture()
    const lost = vi.fn(async () => undefined)
    membership.setLeaseLostHandler(lost)
    await membership.activate('unit-a', 'org-a')
    expect(registerReplica).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5_001)
    expect(membership.activeLease('unit-a', 'org-a')).toBeUndefined()
    await Promise.resolve()
    expect(lost).toHaveBeenCalledTimes(1)
    expect(membership.activeLease('unit-a', 'org-a')).toBeUndefined()
    await membership.releaseAll()
    expect(releaseReplica).not.toHaveBeenCalled()
  })

  it('does not register a different organization over the same Unit', async () => {
    const { membership, registerReplica } = fixture()
    await membership.activate('unit-a', 'org-a')
    await expect(membership.activate('unit-a', 'org-b')).rejects.toThrow('organization mismatch')
    expect(registerReplica).toHaveBeenCalledTimes(1)
    await membership.releaseAll()
  })

  it('fails closed after heartbeat renewal fails without renewing or releasing a stolen lease', async () => {
    vi.useFakeTimers()
    const { membership, renewReplica, releaseReplica } = fixture()
    const lost = vi.fn(async () => undefined)
    membership.setLeaseLostHandler(lost)
    await membership.activate('unit-a', 'org-a')
    renewReplica.mockRejectedValueOnce(new Error('database unavailable'))
    await vi.advanceTimersByTimeAsync(1_667)
    expect(lost).toHaveBeenCalledWith('unit-a')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(renewReplica).toHaveBeenCalledTimes(1)
    await membership.releaseAll()
    expect(releaseReplica).not.toHaveBeenCalled()
  })

  it('allows loss callback to release the same Unit after an explicit failed reactivation', async () => {
    const { membership, renewReplica } = fixture()
    await membership.activate('unit-a', 'org-a')
    const lost = vi.fn(async () => await membership.release('unit-a'))
    membership.setLeaseLostHandler(lost)
    renewReplica.mockRejectedValueOnce(new Error('fenced'))
    await expect(membership.activate('unit-a', 'org-a')).rejects.toThrow('fenced')
    expect(lost).toHaveBeenCalledTimes(1)
  })
})
