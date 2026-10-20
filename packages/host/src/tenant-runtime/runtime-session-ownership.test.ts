import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeResourceOwnership, RuntimeResourceScope, RuntimeUnitReplicaMembership } from './postgres-runtime-resource-ownership.js'
import { RuntimeSessionOwnership } from './runtime-session-ownership.js'
import { RuntimeResourceOwnershipManager, type RuntimeResourceOwnershipStore } from './runtime-resource-ownership.js'

function fixture() {
  const member: RuntimeUnitReplicaMembership = {
    organizationId: 'org-a', unitId: 'unit-a', replicaId: 'replica-a',
    membershipToken: 'member-a', origin: 'https://replica.test', generation: 1n,
    expiresAt: new Date(Date.now() + 30_000),
  }
  let live: RuntimeUnitReplicaMembership | undefined = member
  const acquireResourceOwner = vi.fn(async (scope: RuntimeResourceScope, replica: RuntimeUnitReplicaMembership, ownerToken: string): Promise<RuntimeResourceOwnership> => {
    return { ...scope, replicaId: replica.replicaId, membershipGeneration: replica.generation,
      membershipToken: replica.membershipToken, ownerToken, generation: 1n, expiresAt: new Date(Date.now() + 15_000) }
  })
  const renewResourceOwner = vi.fn(async (owner: RuntimeResourceOwnership) => ({ ...owner, expiresAt: new Date(Date.now() + 15_000) }))
  const releaseResourceOwner = vi.fn(async (_owner: RuntimeResourceOwnership) => undefined)
  const store: RuntimeResourceOwnershipStore = { acquireResourceOwner, renewResourceOwner, releaseResourceOwner }
  const lost = vi.fn(async () => undefined)
  const ownership = new RuntimeSessionOwnership('org-a', 'unit-a', {
    activeLease: (_unitId, organizationId) => organizationId === live?.organizationId ? live : undefined,
  }, new RuntimeResourceOwnershipManager(store), lost)
  return { member, ownership, lost, acquireResourceOwner, renewResourceOwner, releaseResourceOwner,
    setMember: (next: RuntimeUnitReplicaMembership | undefined) => { live = next },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('RuntimeSessionOwnership', () => {
  it('immediately withdraws Session access and closes its Unit after owner renewal fails', async () => {
    vi.useFakeTimers()
    const { ownership, lost, renewResourceOwner } = fixture()
    await ownership.ensure('session-a')
    renewResourceOwner.mockRejectedValueOnce(new Error('fenced by another replica'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ownership.activeLease('session-a')).toBeUndefined()
    expect(lost).toHaveBeenCalledTimes(1)
    await expect(ownership.ensure('session-a')).rejects.toHaveProperty('code', 'RUNTIME_RESOURCE_OWNERSHIP_FENCED')
    await ownership.close()
  })

  it('coalesces simultaneous Session requests and separates distinct Sessions', async () => {
    const { ownership, acquireResourceOwner, releaseResourceOwner } = fixture()
    const [first, duplicate, second] = await Promise.all([
      ownership.ensure('session-a'), ownership.ensure('session-a'), ownership.ensure('session-b'),
    ])
    expect(first.ownerToken).toBe(duplicate.ownerToken)
    expect(first.ownerToken).not.toBe(second.ownerToken)
    expect(acquireResourceOwner).toHaveBeenCalledTimes(2)
    expect(ownership.activeLease('session-a')?.ownerToken).toBe(first.ownerToken)
    await ownership.close()
    expect(ownership.activeLease('session-a')).toBeUndefined()
    expect(releaseResourceOwner).toHaveBeenCalledTimes(2)
    await expect(ownership.ensure('session-a')).rejects.toHaveProperty('code', 'RUNTIME_RESOURCE_OWNERSHIP_FENCED')
  })

  it('refuses a stale membership instead of silently acquiring another owner', async () => {
    const { ownership, member, setMember, acquireResourceOwner } = fixture()
    await ownership.ensure('session-a')
    setMember({ ...member, generation: 2n, membershipToken: 'member-b' })
    expect(ownership.activeLease('session-a')).toBeUndefined()
    await expect(ownership.ensure('session-a')).rejects.toHaveProperty('code', 'RUNTIME_RESOURCE_OWNERSHIP_FENCED')
    expect(acquireResourceOwner).toHaveBeenCalledTimes(1)
    await ownership.close()
  })

  it('cannot expose an owner after closing while a database acquisition is pending', async () => {
    let releaseAcquisition: (() => void) | undefined
    const { ownership, acquireResourceOwner, releaseResourceOwner } = fixture()
    acquireResourceOwner.mockImplementationOnce(async (scope, replica, ownerToken) => {
      await new Promise<void>((resolve) => { releaseAcquisition = resolve })
      return { ...scope, replicaId: replica.replicaId, membershipGeneration: replica.generation,
        membershipToken: replica.membershipToken, ownerToken, generation: 1n, expiresAt: new Date(Date.now() + 15_000) }
    })
    const acquiring = ownership.ensure('session-a')
    const closing = ownership.close()
    await vi.waitFor(() => expect(releaseAcquisition).toBeDefined())
    releaseAcquisition!()
    await expect(acquiring).rejects.toHaveProperty('code', 'RUNTIME_RESOURCE_OWNERSHIP_FENCED')
    await closing
    expect(ownership.activeLease('session-a')).toBeUndefined()
    expect(releaseResourceOwner).toHaveBeenCalledTimes(1)
  })
})
