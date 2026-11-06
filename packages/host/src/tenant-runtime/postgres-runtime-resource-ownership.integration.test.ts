import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { migratePostgres } from '../postgres-migrations.js'
import type { ArtifactObjectStore } from '../artifacts/object-store.js'
import { PostgresObjectMetadataLog } from '../artifacts/postgres-object-metadata.js'
import { PostgresObjectCapacityLedger } from '../artifacts/postgres-object-capacity.js'
import { PostgresSessionAuthority, SessionDeletingError } from '../store/postgres-session-authority.js'
import { consumeNextChildCommand, consumeNextChildStop } from '../store/child-command-consumer.js'
import { reconcileChildTurn, startChildCommandWorker, stopChildTurn } from '../store/child-command-worker.js'
import { messageOperationFingerprint } from '../message-operation-fingerprint.js'
import { createPostgresHotStateStore, type HotStateSqlExecutor } from './postgres-hot-state.js'
import {
  createPostgresRuntimeResourceOwnershipStore,
  RuntimeResourceOwnershipFencedError,
  RuntimeResourceOwnershipHeldError,
  RuntimeUnitReplicaMembershipFencedError,
  type PostgresRuntimeResourceOwnershipStore,
  type RuntimeResourceScope,
} from './postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from './unit.js'
import { RuntimeResourceOwnershipManager } from './runtime-resource-ownership.js'
import { RuntimeSessionOwnership } from './runtime-session-ownership.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresRuntimeResourceOwnershipStore isolated PostgreSQL integration', () => {
  const project = `kala-resource-owner-${randomUUID()}`
  const container = `${project}-postgres`
  const databaseName = `kala_resource_owner_${randomUUID().replaceAll('-', '')}`
  const password = `test-${randomUUID()}`
  let connectionString = ''
  let first: PostgresRuntimeResourceOwnershipStore
  let second: PostgresRuntimeResourceOwnershipStore

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', `POSTGRES_DB=${databaseName}`,
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker(
      'inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container,
    )
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`
    first = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${project}-a` })
    second = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${project}-b` })
    await eventually(async () => { await first.database.query('SELECT 1') }, 30_000)
    await migratePostgres({ connectionString })
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled([first?.close(), second?.close()])
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  it('registers two replicas for one Unit and lets each own a different Session', async () => {
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const organizationId = randomUUID()
    const [replicaA, replicaB] = await Promise.all([
      first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://replica-a.example',
      }, 5_000),
      second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://replica-b.example',
      }, 5_000),
    ])

    const renewedA = await first.renewReplica(replicaA, 8_000)
    const replicas = await second.lookupLiveReplicas({ organizationId, unitId })
    expect(replicas).toHaveLength(2)
    expect(replicas.map((replica) => replica.replicaId)).toEqual(expect.arrayContaining([replicaA.replicaId, replicaB.replicaId]))
    expect(renewedA.expiresAt.getTime()).toBeGreaterThan(replicaA.expiresAt.getTime())

    const sessionA = resource(organizationId, unitId, 'session')
    const sessionB = resource(organizationId, unitId, 'session')
    const [ownerA, ownerB] = await Promise.all([
      first.acquireResourceOwner(sessionA, renewedA, randomUUID(), 5_000),
      second.acquireResourceOwner(sessionB, replicaB, randomUUID(), 5_000),
    ])
    await expect(second.acquireResourceOwner(sessionA, replicaB, randomUUID(), 5_000))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
    await expect(first.lookupResourceOwner(sessionA)).resolves.toMatchObject({
      replicaId: ownerA.replicaId, origin: renewedA.origin, generation: 1n,
    })
    await expect(first.lookupResourceOwner(sessionB)).resolves.toMatchObject({
      replicaId: ownerB.replicaId, origin: replicaB.origin, generation: 1n,
    })
    await expect(first.lookupResourceOwner({ ...sessionA, organizationId: randomUUID() })).resolves.toBeUndefined()
  })

  it('manages two independent owner leases on one Unit and rejects a released writer in PG', async () => {
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const organizationId = randomUUID()
    const [replicaA, replicaB] = await Promise.all([
      first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://managed-a.example',
      }, 9_000),
      second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://managed-b.example',
      }, 9_000),
    ])
    const managers = [new RuntimeResourceOwnershipManager(first), new RuntimeResourceOwnershipManager(second)]
    const scopeA = resource(organizationId, unitId, 'session')
    const scopeB = resource(organizationId, unitId, 'session')
    const lost = async () => { throw new Error('unexpected owner lease loss') }
    try {
      const [ownerA, ownerB] = await Promise.all([
        managers[0]!.acquire(scopeA, replicaA, lost),
        managers[1]!.acquire(scopeB, replicaB, lost),
      ])
      expect(ownerA.activeLease()?.replicaId).toBe(replicaA.replicaId)
      expect(ownerB.activeLease()?.replicaId).toBe(replicaB.replicaId)
      const staleLease = ownerA.activeLease()!
      await ownerA.release()
      expect(ownerA.activeLease()).toBeUndefined()
      const successor = await managers[1]!.acquire(scopeA, replicaB, lost)
      const transaction = await first.database.connect()
      try {
        await transaction.query('BEGIN')
        await expect(first.assertResourceOwner(transaction, staleLease))
          .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
        await transaction.query('ROLLBACK')
      } finally { transaction.release() }
      expect(successor.activeLease()?.generation).toBe(2n)
    } finally {
      await Promise.allSettled(managers.map(async (manager) => await manager.releaseAll()))
    }
  })

  it('delivers child commands across replica owners and reclaims only after generation transfer', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), commandId = randomUUID()
    const memberA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://inbox-a.example',
    }, 60_000)
    const memberB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://inbox-b.example',
    }, 60_000)
    const parentScope = { organizationId, unitId, resourceType: 'session' as const, resourceId: parentId }
    const childScope = { ...parentScope, resourceId: childId }
    const parentOwner = await first.acquireResourceOwner(parentScope, memberA, randomUUID(), 60_000)
    const initialChildOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `${project}-inbox-a` })
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: `${project}-inbox-b` })
    const authority = (hot: typeof hotA, owner: typeof parentOwner) => new PostgresSessionAuthority(hot, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => owner,
    })
    try {
      const parent = authority(hotA, parentOwner)
      const initialChild = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner : initialChildOwner,
      })
      await parent.create({ sessionId: parentId, config: { maxAgentFanOut: 1 }, state: { cursor: 0 } })
      const toolCallId = randomUUID()
      for (const [index, action] of ['copilot.tool_call', 'copilot.tool_result', 'copilot.tool_call'].entries()) {
        await parent.mutate(parentId, {
          mutationId: `${toolCallId}:${index}`,
          eventType: action,
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: parentId,
            action, payload: { callId: toolCallId } },
          apply(current) { return current && { ...current, state: { cursor: current.state.cursor + 1 } } },
        })
        expect(await parent.hasCommittedCopilotToolResult(parentId, toolCallId)).toBe(index === 1)
      }
      await parent.mutate(parentId, {
        mutationId: `${toolCallId}:3`, eventType: 'copilot.tool_result',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: parentId,
          action: 'copilot.tool_result', payload: { callId: toolCallId } },
        apply(current) { return current && { ...current, state: { cursor: current.state.cursor + 1 } } },
      })
      expect(await parent.hasCommittedCopilotToolResult(parentId, toolCallId)).toBe(true)
      await initialChild.create({ sessionId: childId, parentSessionId: parentId, state: { cursor: 0 } }, undefined, {
        fenceSessionId: parentId,
      })
      await first.releaseResourceOwner(initialChildOwner)
      const childOwnerB = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const childB = authority(hotB, childOwnerB)
      const queued = await parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'steer', 1)
      expect(queued.status).toBe('pending')
      await expect(parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'steer', 1)).resolves.toEqual(queued)
      await expect(parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'different', 1))
        .rejects.toThrow('idempotency key conflicts')
      await expect(childB.enqueueChildCommand(parentId, childId, randomUUID(), 'stop'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(parent.enqueueChildCommand(randomUUID(), childId, randomUUID(), 'stop'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect((await parent.readChildCommands(parentId, childId)).map((command) => command.commandId)).toEqual([commandId])
      await expect(childB.readChildCommands(parentId, childId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const claimed = await childB.claimChildCommand(childId)
      expect(claimed).toMatchObject({ commandId, status: 'claimed', ownerGeneration: childOwnerB.generation.toString() })
      const marked = await childB.markChildCommandDispatched(childId, commandId)
      expect(marked.dispatchedAt).toBeTruthy()
      await expect(childB.markChildCommandDispatched(childId, commandId)).resolves.toEqual(marked)
      const pendingId = randomUUID()
      await parent.enqueueChildCommand(parentId, childId, pendingId, 'stop')
      await expect(childB.claimChildCommand(childId)).resolves.toBeUndefined()
      await expect(initialChild.claimChildCommand(childId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await first.releaseResourceOwner(parentOwner)
      const parentOwnerB = await second.acquireResourceOwner(parentScope, memberB, randomUUID(), 60_000)
      const parentB = authority(hotB, parentOwnerB)
      await expect(parent.hasCommittedCopilotToolResult(parentId, toolCallId))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await parentB.hasCommittedCopilotToolResult(parentId, toolCallId)).toBe(true)
      await expect(parent.enqueueChildCommand(parentId, childId, randomUUID(), 'stop'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect((await parentB.readChildCommands(parentId, childId))[0]?.status).toBe('claimed')
      await second.releaseResourceOwner(childOwnerB)
      const successorOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
      const restarted = authority(hotA, successorOwner)
      expect((await parentB.readChildCommandsForDashboard(parentId, childId))[0]?.ownerGeneration)
        .toBeUndefined()
      await expect(childB.completeChildCommand(childId, commandId, { ok: true, content: 'old' }))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(childB.markChildCommandDispatched(childId, commandId))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await restarted.claimChildCommand(childId)).toMatchObject({
        commandId, status: 'claimed', ownerGeneration: successorOwner.generation.toString(), dispatchedAt: marked.dispatchedAt,
      })
      expect((await parentB.readChildCommandsForDashboard(parentId, childId))[0]?.ownerGeneration)
        .toBe(successorOwner.generation.toString())
      expect(await restarted.completeChildCommand(childId, commandId, { ok: true, content: 'delivered' }))
        .toMatchObject({ status: 'completed', outcome: { ok: true, content: 'delivered' } })
      const afterRestart = authority(hotA, successorOwner)
      await expect(afterRestart.claimChildCommand(childId)).resolves.toBeUndefined()
      const resumedPending = await afterRestart.claimChildStop(childId)
      expect(resumedPending).toMatchObject({ commandId: pendingId, status: 'claimed' })
      expect(resumedPending?.dispatchedAt).toBeUndefined()
      await afterRestart.completeChildCommand(childId, pendingId, { ok: true, content: 'stopped' })
      await expect(afterRestart.claimChildCommand(childId)).resolves.toBeUndefined()
      expect((await parentB.readChildCommands(parentId, childId))[0]?.outcome?.content).toBe('delivered')
      const extraIds = [randomUUID(), randomUUID()]
      await Promise.all(extraIds.map((id) => parentB.enqueueChildCommand(parentId, childId, id, 'stop')))
      const [firstClaim, duplicate] = await Promise.all([
        restarted.claimChildStop(childId), afterRestart.claimChildStop(childId),
      ])
      expect([firstClaim, duplicate].filter(Boolean)).toHaveLength(1)
      const firstId = firstClaim?.commandId ?? duplicate!.commandId
      await restarted.completeChildCommand(childId, firstId, { ok: true, content: 'stopped' })
      const secondClaim = await afterRestart.claimChildStop(childId)
      expect(secondClaim?.commandId).toBe(extraIds.find((id) => id !== firstId))
      await afterRestart.completeChildCommand(childId, secondClaim!.commandId, { ok: true, content: 'stopped' })
      await restarted.mutate(childId, {
        mutationId: randomUUID(), eventType: 'session.done',
        apply(current) { return current && { ...current, state: { ...current.state, status: 'done' } } },
      })
      {
      const childId = randomUUID()
      const childScope = { ...parentScope, resourceId: childId }
      const successorOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
      const creator = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : successorOwner,
      })
      await creator.create({ sessionId: childId, parentSessionId: parentId, parentCallId: randomUUID(),
        state: { cursor: 0, status: 'idle' } }, undefined, { fenceSessionId: parentId })
      const afterRestart = authority(hotA, successorOwner)
      const abandonedId = randomUUID()
      await parentB.enqueueChildCommand(parentId, childId, abandonedId, 'message', 'before transfer', 1,
        { timeoutMs: 2_000, maxTurns: 3 })
      await expect(parentB.enqueueChildCommand(parentId, childId, abandonedId, 'message', 'before transfer', 1,
        { timeoutMs: 2_001, maxTurns: 3 })).rejects.toThrow('idempotency key conflicts')
      await afterRestart.markChildCommandDispatched(childId, (await afterRestart.claimChildCommand(childId))!.commandId)
      expect(await afterRestart.readActiveChildMessage(childId)).toMatchObject({
        commandId: abandonedId, timeoutMs: 2_000, maxTurns: 3,
      })
      await first.releaseResourceOwner(successorOwner)
      const finalOwner = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const finalReplica = authority(hotB, finalOwner)
      const attempted: string[] = []
      const uncertain = await consumeNextChildCommand(finalReplica, childId, async (command) => {
        attempted.push(command.commandId)
      }, async () => undefined)
      expect(attempted).toEqual([])
      expect(uncertain).toMatchObject({ commandId: abandonedId, status: 'claimed', dispatchedAt: expect.any(String) })
      await expect(afterRestart.readActiveChildMessage(childId))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await finalReplica.readActiveChildMessage(childId)).toMatchObject({
        commandId: abandonedId, timeoutMs: 2_000, maxTurns: 3,
      })
      const siblingId = randomUUID()
      const siblingOwner = await second.acquireResourceOwner({ ...childScope, resourceId: siblingId }, memberB, randomUUID(), 60_000)
      const sibling = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : siblingOwner,
      })
      await sibling.create({ sessionId: siblingId, parentSessionId: parentId, state: { cursor: 0 } }, undefined, {
        fenceSessionId: parentId,
      })
      const siblingCommand = randomUUID()
      await expect(parentB.enqueueChildCommand(parentId, siblingId, siblingCommand, 'message', 'blocked', 128))
        .rejects.toThrow('agent fan-out exceeded')
      const freshId = randomUUID()
      await parentB.enqueueChildCommand(parentId, childId, freshId, 'stop')
      expect(await finalReplica.hasUnconfirmedMessageBeforeStop(childId, freshId)).toBe(true)
      await expect(consumeNextChildCommand(finalReplica, childId, async () => {
        throw new Error('must not dispatch behind an uncertain turn')
      }, async () => undefined)).resolves.toBeUndefined()
      const remoteCallId = randomUUID()
      const requestDigest = 'a'.repeat(64)
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'copilot.tool_call',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
          action: 'copilot.tool_call', payload: { callId: remoteCallId, ownerGeneration: marked.dispatchedOwnerGeneration, requestDigest } },
        apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1 } } },
      })
      const cancelExecution = vi.fn(async () => ({ status: 'unavailable' as const }))
      const delivered = await consumeNextChildStop(finalReplica, childId, async (command) => {
        attempted.push(command.commandId)
        return stopChildTurn({
          inbox: finalReplica,
          store: {
            load: async () => ({ parentSessionId: parentId, agentRuntime: 'copilot',
              state: { status: 'executing_tools', pendingCalls: [{ callId: remoteCallId, status: 'dispatched' }] } }),
            findCopilotToolRequest: (id: string, callId: string) => finalReplica.findCopilotToolRequest(id, callId),
          } as never,
          runtimes: { require: () => ({ cancelForChildStop: async () => false }) } as never,
          executors: { cancelExecution, queryExecutionReceipt: async () => ({ status: 'unavailable' }) } as never,
          assertOwner: async () => await hotB.database.transaction(async (transaction) => {
            await second.assertResourceOwner(transaction, finalOwner)
          }),
        }, command)
      })
      expect(delivered).toMatchObject({ commandId: freshId, status: 'completed',
        outcome: { ok: false, content: expect.stringContaining('UNKNOWN') } })
      expect(cancelExecution).toHaveBeenCalledWith({
        sessionId: childId, callId: remoteCallId, stopCommandId: freshId,
        ownerGeneration: marked.dispatchedOwnerGeneration, requestDigest,
      })
      expect(attempted).toEqual([freshId])
      expect((await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === abandonedId)?.status)
        .toBe('claimed')
      await finalReplica.completeChildCommand(childId, abandonedId, {
        ok: false, content: 'external effects reconciled by an operator',
      })
      expect(await finalReplica.hasUnconfirmedMessageBeforeStop(childId, freshId)).toBe(false)
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'session.done',
        apply(current) { return current && { ...current, state: { ...current.state, status: 'done' } } },
      })
      const competingId = randomUUID()
      const competingOwner = await second.acquireResourceOwner({ ...childScope, resourceId: competingId }, memberB, randomUUID(), 60_000)
      const competing = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : competingOwner,
      })
      await competing.create({ sessionId: competingId, parentSessionId: parentId, state: { cursor: 0 } }, undefined, {
        fenceSessionId: parentId,
      })
      const competingCommand = randomUUID()
      const secondClientParent = authority(hotA, parentOwnerB)
      const racing = await Promise.allSettled([
        parentB.enqueueChildCommand(parentId, siblingId, siblingCommand, 'message', 'first', 1),
        secondClientParent.enqueueChildCommand(parentId, competingId, competingCommand, 'message', 'second', 1),
      ])
      expect(racing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(racing.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const admitted = racing[0]?.status === 'fulfilled'
        ? { authority: sibling, id: siblingId, commandId: siblingCommand, message: 'first' }
        : { authority: competing, id: competingId, commandId: competingCommand, message: 'second' }
      await expect(parentB.enqueueChildCommand(parentId, admitted.id, admitted.commandId, 'message', admitted.message, 0))
        .resolves.toMatchObject({ status: 'pending', childSessionId: admitted.id })
      expect((await admitted.authority.claimChildCommand(admitted.id))?.commandId).toBe(admitted.commandId)
      const batched = await parentB.readChildCommandsForDashboard(parentId)
      expect(batched.some((command) => command.childSessionId === admitted.id
        && command.commandId === admitted.commandId && command.status === 'claimed')).toBe(true)
      expect(batched.some((command) => command.childSessionId === childId && command.kind === 'stop')).toBe(true)
      expect(await parentB.readChildCommandsForDashboard(randomUUID())).toEqual([])
      await admitted.authority.completeChildCommand(admitted.id, admitted.commandId, { ok: true, content: 'done' })
      await expect(consumeNextChildCommand(finalReplica, childId, async () => {
        throw new Error('unexpected replay')
      }, async () => undefined)).resolves.toBeUndefined()
      await finalReplica.requestDeletion(childId)
      await finalReplica.delete(childId)
      }
      {
      const childId = randomUUID()
      const childScope = { ...parentScope, resourceId: childId }
      const finalOwner = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const creator = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : finalOwner,
      })
      await creator.create({ sessionId: childId, parentSessionId: parentId, parentCallId: randomUUID(),
        state: { cursor: 0, status: 'idle' } }, undefined, { fenceSessionId: parentId })
      const finalReplica = authority(hotB, finalOwner)
      const failedId = randomUUID()
      await parentB.enqueueChildCommand(parentId, childId, failedId, 'message', 'unknown effect', 1)
      await expect(consumeNextChildCommand(finalReplica, childId, async () => {
        throw new Error('executor acknowledgement lost')
      }, async () => undefined)).rejects.toThrow('executor acknowledgement lost')
      expect((await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === failedId)?.outcome)
        .toBeUndefined()
      expect((await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === failedId))
        .toMatchObject({ status: 'claimed', dispatchedAt: expect.any(String) })
      const failedCommand = (await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === failedId)!
      const reconcile = () => reconcileChildTurn({
        inbox: finalReplica,
        store: {
          load: async () => {
            const document = (await finalReplica.load(childId))!
            return { ...document, agentRuntime: 'copilot', state: {
              ...document.state, status: document.state.status ?? 'thinking', pendingCalls: [],
            } }
          },
          findOperation: (id: string, operationId: string) => finalReplica.findOperation(id, operationId),
          findLatestRuntimeMetadata: (id: string, action: string) => finalReplica.findLatestRuntimeMetadata(id, action),
        } as never,
        runtimes: {} as never,
        assertOwner: async () => {
          await hotB.database.transaction(async (transaction) => {
            await second.assertResourceOwner(transaction, finalOwner)
          })
        },
      }, failedCommand)
      await expect(reconcile()).resolves.toBeUndefined()
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'copilot.user_message',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
          action: 'copilot.user_message', payload: { operationId: failedId, text: 'unknown effect',
            requestFingerprint: messageOperationFingerprint('unknown effect') } },
        apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'thinking' } } },
      })
      await expect(reconcile()).resolves.toBeUndefined()
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'copilot.session_idle',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
          action: 'copilot.session_idle', payload: { childCommandId: failedId } },
        apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'done' } } },
      })
      await expect(reconcile()).resolves.toMatchObject({ ok: true, content: expect.stringContaining(failedId) })
      await finalReplica.completeChildCommand(childId, failedId, (await reconcile())!)
      await finalReplica.requestDeletion(childId)
      await finalReplica.delete(childId)
      const remaining = await hotA.database.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM tenant_session_child_commands WHERE tenant_id = $1 AND child_session_id = $2',
        [organizationId, childId],
      )
      expect(remaining.rows[0]?.count).toBe('0')
      }
    } finally {
      await Promise.allSettled([hotA.close(), hotB.close()])
    }
  })

  it('orders parent enqueue and child completion locks without deadlocking either replica', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), commandId = randomUUID()
    const memberA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://enqueue.example',
    }, 60_000)
    const memberB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://complete.example',
    }, 60_000)
    const parentOwner = await first.acquireResourceOwner({
      organizationId, unitId, resourceType: 'session', resourceId: parentId,
    }, memberA, randomUUID(), 60_000)
    const childOwner = await second.acquireResourceOwner({
      organizationId, unitId, resourceType: 'session', resourceId: childId,
    }, memberB, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `board-parent-${parentId.slice(0, 8)}` })
    const childApplication = `board-child-${childId.slice(0, 8)}`
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: childApplication })
    const parent = new PostgresSessionAuthority(hotA, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => parentOwner,
    })
    const child = new PostgresSessionAuthority(hotB, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => childOwner,
    })
    let releaseParent!: () => void
    const parentMayProceed = new Promise<void>((resolve) => { releaseParent = resolve })
    let parentLocked!: () => void
    const parentHasLock = new Promise<void>((resolve) => { parentLocked = resolve })
    let enqueue: Promise<unknown> | undefined
    let completion: Promise<unknown> | undefined
    try {
      await parent.create({ sessionId: parentId, state: { cursor: 0 } })
      const creator = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner : childOwner,
      })
      await creator.create({ sessionId: childId, parentSessionId: parentId, state: { cursor: 0 } },
        undefined, { fenceSessionId: parentId })
      await parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'work', 1)
      await child.claimChildCommand(childId)
      await child.markChildCommandDispatched(childId, commandId)
      const transaction = hotA.database.transaction.bind(hotA.database)
      const spy = vi.spyOn(hotA.database, 'transaction').mockImplementation((operation) =>
        transaction((client) => operation({
          query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values)
            if (sql.includes('SELECT document') && sql.includes('FOR UPDATE') && values?.[1] === parentId) {
              parentLocked()
              await parentMayProceed
            }
            return result
          },
        })))
      try {
        const nextId = randomUUID()
        enqueue = parent.enqueueChildCommand(parentId, childId, nextId, 'message', 'next', 1)
        await parentHasLock
        completion = child.completeChildCommand(childId, commandId, { ok: true, content: 'done' })
        const concurrent = Promise.all([enqueue, completion])
        void concurrent.catch(() => undefined)
        await eventually(async () => {
          const waiting = await hotA.database.query<{ waiting: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
          ) AS waiting`, [childApplication])
          expect(waiting.rows[0]?.waiting).toBe(true)
        }, 5_000)
        releaseParent()
        await expect(concurrent).resolves.toHaveLength(2)
        expect((await parent.readChildCommands(parentId, childId)).map((item) => item.status))
          .toEqual(['completed', 'pending'])
        await child.claimChildCommand(childId)
        await child.markChildCommandDispatched(childId, nextId)
        const completeTransaction = hotB.database.transaction.bind(hotB.database)
        const rollback = vi.spyOn(hotB.database, 'transaction').mockImplementationOnce((operation) =>
          completeTransaction(async (client) => {
            await operation(client)
            throw Object.assign(new Error('injected completion rollback'), { code: '40P01' })
          }))
        try {
          await expect(child.completeChildCommand(childId, nextId, { ok: true, content: 'next done' }))
            .rejects.toMatchObject({ code: '40P01' })
          expect(await child.readActiveChildMessage(childId)).toMatchObject({
            commandId: nextId, status: 'claimed', dispatchedAt: expect.any(String),
          })
        } finally { rollback.mockRestore() }
        await expect(child.claimChildCommand(childId)).resolves.toBeUndefined()
        await expect(child.completeChildCommand(childId, nextId, { ok: true, content: 'next done' }))
          .resolves.toMatchObject({ status: 'completed', outcome: { ok: true, content: 'next done' } })
        const unmarkedId = randomUUID()
        await parent.enqueueChildCommand(parentId, childId, unmarkedId, 'message', 'safe retry', 1)
        await child.claimChildCommand(childId)
        const dispatchTransaction = hotB.database.transaction.bind(hotB.database)
        const failedMark = vi.spyOn(hotB.database, 'transaction').mockImplementationOnce((operation) =>
          dispatchTransaction(async (client) => {
            await operation(client)
            throw Object.assign(new Error('injected mark rollback'), { code: '40001' })
          }))
        try {
          await expect(child.markChildCommandDispatched(childId, unmarkedId))
            .rejects.toMatchObject({ code: '40001' })
        } finally { failedMark.mockRestore() }
        const undispatched = await child.readActiveChildMessage(childId)
        expect(undispatched).toMatchObject({
          commandId: unmarkedId, status: 'claimed', ownerGeneration: childOwner.generation.toString(),
        })
        expect(undispatched?.dispatchedAt).toBeUndefined()
        expect(await child.findOperation(childId, unmarkedId)).toBeUndefined()
        const marked = await child.markChildCommandDispatched(childId, unmarkedId, true)
        expect(marked.dispatchedAt).toBeTruthy()
        await expect(child.markChildCommandDispatched(childId, unmarkedId, true))
          .rejects.toThrow('already recorded')
        const takeoverId = randomUUID()
        await parent.enqueueChildCommand(parentId, childId, takeoverId, 'message', 'after takeover', 1)
        // A claimed-but-unmarked head can only be resumed after a new owner
        // proves that neither the marker nor a matching SDK operation exists.
        await child.completeChildCommand(childId, unmarkedId, { ok: false, content: 'fixture only' })
        await child.claimChildCommand(childId)
        await second.releaseResourceOwner(childOwner)
        const successor = await first.acquireResourceOwner({
          organizationId, unitId, resourceType: 'session', resourceId: childId,
        }, memberA, randomUUID(), 60_000)
        const afterTakeover = new PostgresSessionAuthority(hotA, organizationId, {
          schemaManagement: 'external', unitId, resourceOwnerForSession: () => successor,
        })
        const reclaimed = await afterTakeover.claimChildCommand(childId)
        expect(reclaimed).toMatchObject({ commandId: takeoverId, status: 'claimed', reclaimed: true,
          ownerGeneration: successor.generation.toString() })
        expect(reclaimed?.dispatchedAt).toBeUndefined()
      } finally {
        releaseParent()
        spy.mockRestore()
        await Promise.allSettled([enqueue, completion].filter((value) => value !== undefined))
      }
    } finally {
      await Promise.allSettled([hotA.close(), hotB.close()])
    }
  }, 20_000)

  it('targets a budgeted follow-up with child-owner timeout Stop across parent and child replicas', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), initialId = randomUUID()
    const [memberA, memberB] = await Promise.all([
      first.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://budget-parent.example' }, 60_000),
      second.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://budget-child.example' }, 60_000),
    ])
    const parentOwner = await first.acquireResourceOwner(
      { organizationId, unitId, resourceType: 'session', resourceId: parentId }, memberA, randomUUID(), 60_000)
    const childOwner = await second.acquireResourceOwner(
      { organizationId, unitId, resourceType: 'session', resourceId: childId }, memberB, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `${project}-budget-parent` })
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: `${project}-budget-child` })
    const authority = (hot: typeof hotA) => new PostgresSessionAuthority(hot, organizationId, {
      schemaManagement: 'external', unitId,
      resourceOwnerForSession: (id) => id === parentId ? parentOwner : childOwner,
    })
    try {
      const parent = authority(hotA), child = authority(hotB)
      await parent.create({ sessionId: parentId, config: { maxAgentFanOut: 1 }, state: { status: 'idle' } })
      await child.create({ sessionId: childId, parentSessionId: parentId, parentCallId: initialId,
        state: { status: 'done' } }, undefined, { fenceSessionId: parentId })
      const commandId = randomUUID()
      await parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'next turn', 1,
        { timeoutMs: 1_000, maxTurns: 2 })
      expect(await child.readActiveChildMessage(childId)).toMatchObject({
        commandId, timeoutMs: 1_000, maxTurns: 2, status: 'pending',
      })
      await child.claimChildCommand(childId)
      await child.markChildCommandDispatched(childId, commandId)
      const stopId = randomUUID()
      await expect(child.enqueueTimedOutChildStop(childId, stopId, commandId))
        .resolves.toMatchObject({ commandId: stopId, kind: 'stop', status: 'pending' })
      await expect(child.claimChildStop(childId)).resolves.toMatchObject({ commandId: stopId })
      const laterId = randomUUID()
      await expect(parent.enqueueChildCommand(parentId, childId, laterId, 'message', 'later', 1))
        .rejects.toThrow('Stop barrier')
      expect(await child.claimChildCommand(childId)).toBeUndefined()
      expect(await child.hasUnconfirmedMessageBeforeStop(childId, stopId)).toBe(true)
      await expect(child.markChildCommandDispatched(childId, laterId)).rejects.toThrow()
    } finally { await Promise.allSettled([hotA.close(), hotB.close()]) }
  })

  it('creates a child and initial command atomically with bounded fan-out across independent owner leases', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), rejectedId = randomUUID(), commandId = randomUUID()
    const memberA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://create-a.example',
    }, 60_000)
    const memberB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://create-b.example',
    }, 60_000)
    const parentScope = { organizationId, unitId, resourceType: 'session' as const, resourceId: parentId }
    const childScope = { ...parentScope, resourceId: childId }
    let parentOwner = await first.acquireResourceOwner(parentScope, memberA, randomUUID(), 60_000)
    const childOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
    const rejectedOwner = await first.acquireResourceOwner({ ...childScope, resourceId: rejectedId }, memberA, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `${project}-create-a` })
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: `${project}-create-b` })
    const createOnA = new PostgresSessionAuthority(hotA, organizationId, {
      schemaManagement: 'external', unitId, localReplicaId: memberA.replicaId,
      resourceOwnerForSession: (id) => id === parentId ? parentOwner : id === childId ? childOwner : rejectedOwner,
    })
    try {
      await createOnA.create({ sessionId: parentId, config: { maxAgentFanOut: 1 }, state: { cursor: 0, status: 'done' } })
      const childDocument = {
        sessionId: childId, parentSessionId: parentId, parentCallId: commandId,
        preferredChildReplicaId: memberB.replicaId,
        preferences: { selectedModel: 'provider/model-v1' },
        agentRuntime: 'copilot', state: { cursor: 0, status: 'idle', pendingCalls: [] },
      }
      await createOnA.createChildWithCommand(childDocument, commandId, 'initial prompt', 1)
      expect(await createOnA.pendingChildSessionIds()).not.toContain(childId)
      expect(await createOnA.claimChildCommand(childId)).toBeUndefined()
      expect(await createOnA.readChildCommands(parentId, childId)).toMatchObject([
        { commandId, status: 'pending', message: 'initial prompt' },
      ])
      await expect(createOnA.createChildWithCommand({
        sessionId: rejectedId, parentSessionId: parentId, parentCallId: randomUUID(),
        state: { cursor: 0, status: 'idle' },
      }, randomUUID(), 'another prompt', 1)).rejects.toThrow()
      expect(await createOnA.load(rejectedId)).toBeUndefined()
      await expect(createOnA.createChildWithCommand(childDocument, commandId, 'initial prompt', 1))
        .resolves.toMatchObject(childDocument)
      await expect(createOnA.createChildWithCommand(childDocument, commandId, 'different prompt', 1))
        .rejects.toThrow()
      await first.releaseResourceOwner(childOwner)
      const successorOwner = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const ownerB = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId, localReplicaId: memberB.replicaId,
        resourceOwnerForSession: (id) => id === childId ? successorOwner : undefined,
      })
      expect(await ownerB.pendingChildSessionIds()).toContain(childId)
      expect(await ownerB.readChildCommandsForDashboard(parentId, childId)).toMatchObject([
        { commandId, status: 'pending', parentSessionId: parentId },
      ])
      expect(await ownerB.readChildCommandsForDashboard(rejectedId, childId)).toEqual([])
      expect((await ownerB.load(childId))?.preferences).toEqual({ selectedModel: 'provider/model-v1' })
      const delivered = await consumeNextChildCommand(ownerB, childId, async (command) => {
        expect(command.dispatchedOwnerGeneration).toBe(successorOwner.generation.toString())
        await ownerB.mutate(childId, {
          mutationId: randomUUID(), eventType: 'copilot.user_message',
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
            action: 'copilot.user_message', payload: { operationId: command.commandId, text: command.message,
              requestFingerprint: messageOperationFingerprint(command.message!) } },
          apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'thinking' } } },
        })
        expect(await ownerB.enqueueTimedOutChildStop(childId, 'timeout-initial'))
          .toMatchObject({ kind: 'stop', status: 'pending', parentSessionId: parentId })
        await ownerB.mutate(childId, {
          mutationId: randomUUID(), eventType: 'copilot.assistant_turn_end',
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
            action: 'copilot.assistant_turn_end', payload: { childCommandId: command.commandId, turnId: 'sdk-turn-1' } },
          apply(current) { return current },
        })
        await ownerB.mutate(childId, {
          mutationId: randomUUID(), eventType: 'copilot.session_idle',
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
            action: 'copilot.session_idle', payload: { childCommandId: command.commandId } },
          apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'done' } } },
        })
      }, async (command) => reconcileChildTurn({
        inbox: ownerB,
        store: {
          load: (id: string) => ownerB.load(id),
          findOperation: (id: string, operationId: string) => ownerB.findOperation(id, operationId),
          findLatestRuntimeMetadata: (id: string, action: string) => ownerB.findLatestRuntimeMetadata(id, action),
        } as never,
        runtimes: {} as never,
        assertOwner: async () => await hotB.database.transaction(async (transaction) => {
          await second.assertResourceOwner(transaction, successorOwner)
        }),
      }, command))
      expect(delivered).toMatchObject({ commandId, status: 'completed', outcome: { ok: true } })
      expect(await ownerB.readChildTurnEnds(childId, commandId)).toHaveLength(1)
      expect(await createOnA.pendingFinishedParentSessionIds()).toContain(parentId)
      await expect(ownerB.readPendingChildCompletions(parentId)).rejects.toThrow()
      const replicaRoomEvents = await ownerB.readFinishedChildCompletions(parentId)
      expect(replicaRoomEvents).toMatchObject([{ commandId, childSessionId: childId, outcome: { ok: true } }])
      expect(await ownerB.readFinishedChildCompletions(parentId, {
        sequence: replicaRoomEvents[0]!.sequence,
      })).toEqual([])
      const peerFinished = vi.fn()
      const peerOwnerAttempt = vi.fn(async () => { throw new Error('Parent belongs to replica A') })
      const stopPeerWorker = startChildCommandWorker({
        inbox: {
          pendingChildSessionIds: async () => [],
          pendingFinishedParentSessionIds: async () => [],
          readFinishedChildCompletions: (id, since) => ownerB.readFinishedChildCompletions(id, since),
        } as never,
        store: {
          load: (id: string) => ownerB.load(id),
          countCompletedChildModelTurns: async (id: string, operationId: string) =>
            (await ownerB.readChildTurnEnds(id, operationId)).length,
        } as never,
        runtimes: {} as never,
        assertOwner: peerOwnerAttempt,
        listLocalParentRooms: () => [parentId],
        onChildFinished: peerFinished,
      }, 10)
      try {
        await vi.waitFor(() => expect(peerFinished).toHaveBeenCalledOnce())
        expect(peerFinished).toHaveBeenCalledWith(expect.objectContaining({
          parentSessionId: parentId, childSessionId: childId, parentCallId: commandId,
          status: 'completed', turns: 1,
        }))
        expect(peerOwnerAttempt).not.toHaveBeenCalled()
      } finally { await stopPeerWorker() }
      const notices = await createOnA.readPendingChildCompletions(parentId)
      expect(notices).toMatchObject([{ commandId, parentSessionId: parentId, childSessionId: childId, outcome: { ok: true } }])
      expect(Date.parse(notices[0]!.completedAt)).toBeGreaterThan(0)
      await expect(ownerB.acknowledgeChildCompletion(parentId, childId, commandId)).rejects.toThrow()
      await first.releaseResourceOwner(parentOwner)
      const newParentOwner = await second.acquireResourceOwner(parentScope, memberB, randomUUID(), 60_000)
      const parentOnB = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId, localReplicaId: memberB.replicaId,
        resourceOwnerForSession: (id) => id === parentId ? newParentOwner : successorOwner,
      })
      await expect(createOnA.acknowledgeChildCompletion(parentId, childId, commandId)).rejects.toThrow()
      expect(await parentOnB.readPendingChildCompletions(parentId)).toHaveLength(1)
      await parentOnB.acknowledgeChildCompletion(parentId, childId, commandId)
      expect(await createOnA.pendingFinishedParentSessionIds()).not.toContain(parentId)
      expect(await parentOnB.readPendingChildCompletions(parentId)).toEqual([])
      expect(await createOnA.readFinishedChildCompletions(parentId)).toHaveLength(1)
      await second.releaseResourceOwner(newParentOwner)
      parentOwner = await first.acquireResourceOwner(parentScope, memberA, randomUUID(), 60_000)
      await expect(createOnA.markChildCommandDispatched(childId, commandId)).rejects.toThrow()
      expect(await ownerB.claimChildCommand(childId)).toBeUndefined()
      await expect(consumeNextChildStop(ownerB, childId, async () => {
        throw new Error('timeout cancellation ACK lost')
      })).rejects.toThrow('timeout cancellation ACK lost')
      await second.releaseResourceOwner(successorOwner)
      await second.releaseReplica(memberB)
      const fallbackOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
      const fallback = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId, localReplicaId: memberA.replicaId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner : fallbackOwner,
      })
      expect(await fallback.pendingChildSessionIds()).toContain(childId)
      expect(await consumeNextChildStop(fallback, childId, async () => {
        throw new Error('never repeat an unacknowledged cancellation')
      })).toMatchObject({ status: 'completed', outcome: { ok: false, content: expect.stringContaining('UNKNOWN') } })
      await expect(ownerB.completeChildCommand(childId, 'timeout-initial', { ok: true, content: 'stale ACK' }))
        .rejects.toThrow()
      const competingId = randomUUID()
      const competingOwner = await first.acquireResourceOwner({ ...childScope, resourceId: competingId }, memberA, randomUUID(), 60_000)
      const competing = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner
          : id === rejectedId ? rejectedOwner : id === competingId ? competingOwner : undefined,
      })
      const candidates = [rejectedId, competingId]
      const outcomes = await Promise.allSettled(candidates.map(async (id) =>
        competing.createChildWithCommand({
          sessionId: id, parentSessionId: parentId, parentCallId: id,
          state: { cursor: 0, status: 'idle' },
        }, id, `prompt for ${id}`, 1)))
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect((await Promise.all(candidates.map(async (id) => competing.load(id)))).filter(Boolean)).toHaveLength(1)
    } finally {
      await Promise.all([hotA.close(), hotB.close()])
    }
  })

  it('fences HotState event and projection callbacks in one transaction even on idempotent retry', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://event-a.example',
    }, 8_000)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://event-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const oldOwner = await first.acquireResourceOwner(scope, replicaA, randomUUID(), 100)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-fenced-event` })
    try {
      const token = await hotState.acquireLease({ tenantId: organizationId, scopeType: 'session', scopeId: scope.resourceId }, 'writer-a', 5_000)
      const event = { idempotencyKey: randomUUID(), eventType: 'session.updated', payload: { value: 1 } }
      const sideEffect = async (transaction: HotStateSqlExecutor) => {
        await transaction.query('SELECT 1')
      }
      await hotState.appendEventWithSideEffect(token, event, sideEffect, oldOwner)
      let successor: Awaited<ReturnType<typeof second.acquireResourceOwner>> | undefined
      await eventually(async () => {
        successor = await second.acquireResourceOwner(scope, replicaB, randomUUID(), 5_000)
      }, 5_000)
      await expect(hotState.appendEventWithSideEffect(token, event, sideEffect, oldOwner))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(hotState.appendEventWithSideEffect(token, {
        ...event, idempotencyKey: randomUUID(),
      }, sideEffect, oldOwner)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(hotState.appendEventWithSideEffect(token, event, sideEffect, {
        ...successor!, resourceId: randomUUID(),
      })).rejects.toThrow('scope must match')
      const accepted = await hotState.appendEventWithSideEffect(token, {
        ...event, idempotencyKey: randomUUID(),
      }, sideEffect, successor!)
      expect(accepted.sequence).toBe(2n)
      expect(await hotState.replay({ tenantId: organizationId, scopeType: 'session', scopeId: scope.resourceId })).toHaveLength(2)
    } finally { await hotState.close() }
  })

  it('fences native SDK chunks across owner takeover, tenant isolation and Session final deletion', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID()), sessionId = randomUUID()
    const memberA = await first.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://native-a.example' }, 60_000)
    const memberB = await second.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://native-b.example' }, 60_000)
    const scope = { organizationId, unitId, resourceType: 'session' as const, resourceId: sessionId }
    const ownerA = await first.acquireResourceOwner(scope, memberA, randomUUID(), 60_000)
    const hot = createPostgresHotStateStore({ connectionString, applicationName: `${project}-native-chunks` })
    const authority = (owner: typeof ownerA, tenantId = organizationId) => new PostgresSessionAuthority(hot, tenantId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => owner,
    })
    try {
      const old = authority(ownerA), oldFs = old.nativeSessionFs(sessionId)
      await old.create({ sessionId, state: { cursor: 0 } })
      await oldFs.writeFile('/session-state/events.jsonl', 'native-before-takeover\n')
      const auditBefore = await hot.database.query('SELECT count(*)::integer AS n FROM tenant_runtime_hot_events WHERE tenant_id = $1', [organizationId])
      await first.releaseResourceOwner(ownerA)
      const ownerB = await second.acquireResourceOwner(scope, memberB, randomUUID(), 60_000)
      const live = authority(ownerB), fs = live.nativeSessionFs(sessionId)
      await expect(oldFs.readFile('/session-state/events.jsonl')).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(oldFs.appendFile('/session-state/events.jsonl', 'stale')).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(authority(ownerB, randomUUID()).nativeSessionFs(sessionId).readFile('/session-state/events.jsonl')).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await fs.appendFile('/session-state/events.jsonl', 'native-after-takeover\n')
      expect(await fs.readFile('/session-state/events.jsonl')).toBe('native-before-takeover\nnative-after-takeover\n')
      const auditAfter = await hot.database.query('SELECT count(*)::integer AS n FROM tenant_runtime_hot_events WHERE tenant_id = $1', [organizationId])
      expect(auditAfter.rows).toEqual(auditBefore.rows)
      await live.requestDeletion(sessionId)
      await expect(fs.appendFile('/session-state/events.jsonl', 'after tombstone')).rejects.toBeInstanceOf(SessionDeletingError)
      await live.delete(sessionId)
      const chunks = await hot.database.query('SELECT count(*)::integer AS n FROM tenant_session_native_fs_chunks WHERE tenant_id = $1 AND session_id = $2', [organizationId, sessionId])
      expect(chunks.rows[0]?.n).toBe(0)
    } finally { await hot.close() }
  })

  it('fences object intents and idempotent metadata writes when a Session owner moves to another replica', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const sessionId = randomUUID()
    const [memberA, memberB] = await Promise.all([
      first.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://object-a.example' }, 15_000),
      second.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://object-b.example' }, 15_000),
    ])
    const scope = { organizationId, unitId, resourceType: 'session' as const, resourceId: sessionId }
    const ownerA = await first.acquireResourceOwner(scope, memberA, randomUUID(), 10_000)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-fenced-objects` })
    const objectLog = (owner: typeof ownerA) => new PostgresObjectMetadataLog(organizationId, hotState, {
      schemaManagement: 'external', prepareSessionOwner: async () => undefined,
      resourceOwnerForSession: () => owner,
    })
    const objectsA = objectLog(ownerA)
    const sessionY = randomUUID()
    const ownerY = await second.acquireResourceOwner({ ...scope, resourceId: sessionY }, memberB, randomUUID(), 10_000)
    const objectsY = objectLog(ownerY)
    const capacity = (owner: typeof ownerA) => new PostgresObjectCapacityLedger(organizationId, 1024, hotState, {
      schemaManagement: 'external', prepareSessionOwner: async () => undefined,
      resourceOwnerForSession: () => owner,
    })
    try {
      await capacity(ownerA).initialize()
      const reservationA = await capacity(ownerA).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })
      const intentA = await objectsA.prepareObject(sessionId, `objects/${randomUUID()}`)
      const firstEvent = { idempotencyKey: randomUUID(), eventType: 'artifact.registered', payload: { objectKey: intentA.objectKey }, intent: intentA }
      await objectsA.append(sessionId, firstEvent)
      const intentY = await objectsY.prepareObject(sessionY, `objects/${randomUUID()}`)
      await objectsY.append(sessionY, { idempotencyKey: randomUUID(), eventType: 'artifact.registered',
        payload: { objectKey: intentY.objectKey }, intent: intentY })
      expect(await objectsY.replay(sessionY)).toHaveLength(1)
      const takeoverIntent = await objectsA.prepareObject(sessionId, `objects/${randomUUID()}`)
      await hotState.database.query(`UPDATE tenant_object_orphan_intents
        SET upload_expires_at = clock_timestamp() - interval '1 millisecond'
        WHERE tenant_id = $1 AND object_key = $2`, [organizationId, takeoverIntent.objectKey])
      const deleted: string[] = []
      const cleaner: ArtifactObjectStore = {
        put: async () => { throw new Error('unexpected put') },
        get: async () => { throw new Error('unexpected get') },
        signedGetUrl: async () => { throw new Error('unexpected signed URL') },
        delete: async (_organizationId: string, objectKey: string) => { deleted.push(objectKey) },
      }
      await expect(objectsA.reconcileOrphanIntents(cleaner, { limit: 1 }))
        .resolves.toEqual({ claimed: 0, deleted: 0, failed: 0 })
      await expect(objectLog(ownerY).prepareObject(sessionId, `objects/${randomUUID()}`))
        .rejects.toThrow('scope must match')
      await expect(capacity(ownerY).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })).rejects.toThrow('scope must match')
      const wrongOrganization = new PostgresObjectMetadataLog(randomUUID(), hotState, {
        schemaManagement: 'external', prepareSessionOwner: async () => undefined,
        resourceOwnerForSession: () => ownerA,
      })
      await expect(wrongOrganization.prepareObject(sessionId, `objects/${randomUUID()}`))
        .rejects.toThrow('scope must match')
      await first.releaseResourceOwner(ownerA)
      const ownerB = await second.acquireResourceOwner(scope, memberB, randomUUID(), 10_000)
      const objectsB = objectLog(ownerB)
      await expect(objectsB.reconcileOrphanIntents(cleaner, { limit: 1 }))
        .resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
      expect(deleted).toEqual([takeoverIntent.objectKey])
      await expect(objectsA.prepareObject(sessionId, `objects/${randomUUID()}`))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(capacity(ownerA).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(objectsA.beginSessionDeletion(sessionId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(objectsA.completeObjectCleanup(intentA)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(objectsA.append(sessionId, firstEvent))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await capacity(ownerB).release(reservationA)
      const reservationB = await capacity(ownerB).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })
      const intentB = await objectsB.prepareObject(sessionId, `objects/${randomUUID()}`)
      await objectsB.append(sessionId, {
        idempotencyKey: randomUUID(), eventType: 'artifact.registered', payload: { objectKey: intentB.objectKey }, intent: intentB,
      })
      expect(await objectsB.replay(sessionId)).toHaveLength(2)
      await objectsB.beginSessionDeletion(sessionId)
      await capacity(ownerB).release(reservationB)
      expect(await capacity(ownerB).usageBytes()).toBe(0)
    } finally { await hotState.close() }
  })

  it('acquires live Session owners for SessionAuthority and queue and recovers them on a second replica', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const [memberA, memberB] = await Promise.all([
      first.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://session-a.example' }, 1_200),
      second.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://session-b.example' }, 9_000),
    ])
    const lostA = async () => undefined
    const ownershipA = new RuntimeSessionOwnership(organizationId, unitId,
      { activeLease: () => memberA }, new RuntimeResourceOwnershipManager(first), lostA)
    const ownershipB = new RuntimeSessionOwnership(organizationId, unitId,
      { activeLease: () => memberB }, new RuntimeResourceOwnershipManager(second), async () => undefined)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-managed-sessions` })
    const authority = (ownership: RuntimeSessionOwnership) => new PostgresSessionAuthority(hotState, organizationId, {
      schemaManagement: 'external', unitId,
      resourceOwnerForSession: (sessionId) => ownership.activeLease(sessionId),
      prepareSessionOwner: async (sessionId) => { await ownership.ensure(sessionId) },
    })
    const old = authority(ownershipA)
    const live = authority(ownershipB)
    const sessionA = randomUUID()
    const sessionB = randomUUID()
    try {
      await Promise.all([
        old.create({ sessionId: sessionA, organizationId, state: { cursor: 0 } }),
        live.create({ sessionId: sessionB, organizationId, state: { cursor: 0 } }),
      ])
      expect(ownershipA.activeLease(sessionA)?.replicaId).toBe(memberA.replicaId)
      expect(ownershipB.activeLease(sessionB)?.replicaId).toBe(memberB.replicaId)
      const queued = { id: 'first', operationId: 'first', text: 'one', mode: 'queue' as const, createdAt: new Date().toISOString() }
      await old.messageQueue.enqueue(sessionA, queued, 'back')
      await old.agentBoardTransaction(sessionA, (_root, board) => {
        board.entries.note = { topic: 'note', content: 'persisted', authorSessionId: sessionA, tags: [],
          revision: 1, updatedAt: new Date().toISOString() }
        board.revision += 1
      })
      await expect(live.load(sessionA)).resolves.toMatchObject({ sessionId: sessionA })
      await expect(live.list([sessionA])).resolves.toEqual([expect.objectContaining({ sessionId: sessionA })])
      expect(ownershipB.activeLease(sessionA)).toBeUndefined()
      await expect(live.messageQueue.load(sessionA)).rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
      await eventually(async () => { await live.messageQueue.load(sessionA) }, 5_000)
      expect(ownershipB.activeLease(sessionA)?.replicaId).toBe(memberB.replicaId)
      await expect(old.messageQueue.enqueue(sessionA, { ...queued, id: 'stale', operationId: 'stale' }, 'back'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.agentBoardTransaction(sessionA, () => undefined))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await live.agentBoardTransaction(sessionA, (_root, board) => board.entries.note?.content)).toBe('persisted')
      await live.messageQueue.enqueue(sessionA, { ...queued, id: 'recovered', operationId: 'recovered' }, 'back')
      expect((await live.messageQueue.load(sessionA)).items.map((item) => item.operationId)).toEqual(['first', 'recovered'])
      await expect(live.load(sessionA)).resolves.toMatchObject({ sessionId: sessionA })
    } finally {
      await Promise.allSettled([ownershipA.close(), ownershipB.close()])
      await hotState.close()
    }
  })

  it('fences SessionAuthority create, retry, mutation and projection repair by the current owner', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://authority-a.example',
    }, 1_200)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://authority-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const ownerA = await first.acquireResourceOwner(scope, replicaA, randomUUID(), 6_000)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-session-authority` })
    const old = new PostgresSessionAuthority(hotState, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => ownerA,
    })
    try {
      const initial = { sessionId: scope.resourceId, organizationId, state: { cursor: 0 } }
      await old.create(initial)
      await old.initializeEmptyNativePosixSession(scope.resourceId)
      const oldNative = old.nativePosixSessionFs(scope.resourceId)
      await oldNative.create('/epoch', 0o600)
      await oldNative.write('/epoch', 0, Buffer.from([0, 1, 255]))
      const queued = { id: 'queued-old', operationId: 'queued-old', text: 'one', mode: 'queue' as const, createdAt: new Date().toISOString() }
      await old.messageQueue.enqueue(scope.resourceId, queued, 'back')
      const claim = (await old.messageQueue.claimHead(scope.resourceId, 'writer-a', 5_000)).claim!
      expect(claim.item.operationId).toBe('queued-old')
      expect(() => new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', resourceOwnerForSession: () => ownerA,
      })).toThrow('trusted Unit ID')
      expect(() => new PostgresSessionAuthority(hotState, organizationId, {
        unitId, resourceOwnerForSession: () => ownerA,
      })).toThrow('operator-migrated PostgreSQL schema')
      const wrongUnit = new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', unitId: parseTenantRuntimeUnitId(randomUUID()), resourceOwnerForSession: () => ownerA,
      })
      await expect(wrongUnit.messageQueue.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      let ownerB: Awaited<ReturnType<typeof second.acquireResourceOwner>> | undefined
      await eventually(async () => {
        ownerB = await second.acquireResourceOwner(scope, replicaB, randomUUID(), 5_000)
      }, 5_000)
      expect(ownerA.expiresAt.getTime()).toBeGreaterThan(Date.now())
      await expect(old.create(initial)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(oldNative.write('/epoch', 0, Buffer.from('stale'))).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.loadOrInitialize(scope.resourceId, async () => ({ items: [], cancelledOperationIds: [] })))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.confirmClaim(claim)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.renewClaim(claim, 5_000)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.releaseClaim(claim)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.completeClaim(claim)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.enqueue(scope.resourceId, { ...queued, id: 'stale', operationId: 'stale' }, 'back'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.mutate(scope.resourceId, {
        mutationId: 'stale-session-mutation', eventType: 'session.updated',
        apply: (document) => document && { ...document, state: { cursor: 1 } },
      })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const absent = new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', unitId, resourceOwnerForSession: () => undefined,
      })
      await expect(absent.create(initial)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(absent.messageQueue.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const live = new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', unitId, resourceOwnerForSession: () => ownerB,
      })
      await expect(live.nativePosixSessionFs(scope.resourceId).read('/epoch', 0, 3)).resolves.toEqual(Buffer.from([0, 1, 255]))
      await live.messageQueue.enqueue(scope.resourceId, { ...queued, id: 'queued-new', operationId: 'queued-new' }, 'back')
      expect((await live.messageQueue.load(scope.resourceId)).items.map((item) => item.operationId)).toEqual(['queued-old', 'queued-new'])
      await expect(live.mutate(scope.resourceId, {
        mutationId: 'live-session-mutation', eventType: 'session.updated',
        apply: (document) => document && { ...document, state: { cursor: 1 } },
      })).resolves.toMatchObject({ state: { cursor: 1 } })
      await hotState.database.query('DELETE FROM tenant_session_latest_projection WHERE tenant_id=$1 AND session_id=$2', [
        organizationId, scope.resourceId,
      ])
      await expect(old.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(live.load(scope.resourceId)).resolves.toMatchObject({ state: { cursor: 1 } })
      await expect(hotState.replay({ tenantId: organizationId, scopeType: 'session', scopeId: scope.resourceId }))
        .resolves.toHaveLength(2)
    } finally { await hotState.close() }
  })

  it('rejects the same organization-global Session ID across Units but allows distinct Sessions', async () => {
    const organizationId = randomUUID()
    const unitA = parseTenantRuntimeUnitId(randomUUID())
    const unitB = parseTenantRuntimeUnitId(randomUUID())
    const resourceId = randomUUID()
    const [replicaA, replicaB] = await Promise.all([
      first.registerReplica({
        organizationId, unitId: unitA, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://unit-a.example',
      }, 5_000),
      second.registerReplica({
        organizationId, unitId: unitB, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://unit-b.example',
      }, 5_000),
    ])
    const sessionA: RuntimeResourceScope = { organizationId, unitId: unitA, resourceType: 'session', resourceId }
    const sameSessionInAnotherUnit: RuntimeResourceScope = { organizationId, unitId: unitB, resourceType: 'session', resourceId }
    const attempts = await Promise.allSettled([
      first.acquireResourceOwner(sessionA, replicaA, randomUUID(), 5_000),
      second.acquireResourceOwner(sameSessionInAnotherUnit, replicaB, randomUUID(), 5_000),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected'))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: '23505' }) })])
    const winningScope = attempts[0]?.status === 'fulfilled' ? sessionA : sameSessionInAnotherUnit
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled')
    if (!winner || winner.status !== 'fulfilled') throw new Error('missing ownership winner')
    await expect(first.lookupResourceOwner(winningScope)).resolves.toMatchObject({
      unitId: winningScope.unitId, replicaId: winner.value.replicaId,
    })
    const distinctSession: RuntimeResourceScope = { ...sameSessionInAnotherUnit, resourceId: randomUUID() }
    const distinctOwner = await second.acquireResourceOwner(distinctSession, replicaB, randomUUID(), 5_000)
    await expect(second.lookupResourceOwner(distinctSession)).resolves.toMatchObject({
      unitId: unitB, replicaId: distinctOwner.replicaId, origin: replicaB.origin,
    })
  })

  it('joins ownership to a live organization membership and fences expired membership and old owner tokens', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://short-lived.example',
    }, 100)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://takeover.example',
    }, 8_000)
    const task = resource(organizationId, unitId, 'task')
    const oldOwner = await first.acquireResourceOwner(task, replicaA, randomUUID(), 8_000)

    await eventually(async () => {
      expect(await second.lookupResourceOwner(task)).toBeUndefined()
    }, 5_000)
    const newOwner = await second.acquireResourceOwner(task, replicaB, randomUUID(), 8_000)
    expect(newOwner.generation).toBe(oldOwner.generation + 1n)
    await expect(first.renewResourceOwner(oldOwner, 5_000)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(first.releaseResourceOwner(oldOwner)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(first.renewReplica(replicaA, 5_000)).rejects.toThrow()

    const otherOrganizationReplica = await first.registerReplica({
      organizationId: randomUUID(), unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://other-org.example',
    }, 5_000)
    await expect(first.acquireResourceOwner(
      resource(organizationId, otherOrganizationReplica.unitId, 'session'), otherOrganizationReplica, randomUUID(), 5_000,
    )).rejects.toThrow('organizationId and unitId must match')
    await expect(second.lookupResourceOwner(task)).resolves.toMatchObject({ replicaId: replicaB.replicaId })
  })

  it('fences an old writer inside its SQL transaction and remains usable after rollback', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://writer-a.example',
    }, 5_000)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://writer-b.example',
    }, 5_000)
    const session = resource(organizationId, unitId, 'session')
    const oldOwner = await first.acquireResourceOwner(session, replicaA, randomUUID(), 80)
    let newOwner: Awaited<ReturnType<typeof second.acquireResourceOwner>> | undefined
    await eventually(async () => {
      newOwner = await second.acquireResourceOwner(session, replicaB, randomUUID(), 5_000)
    }, 5_000)

    await first.database.query('CREATE TABLE IF NOT EXISTS resource_owner_fenced_writes (value text)')
    const staleTransaction = await first.database.connect()
    await staleTransaction.query('BEGIN')
    try {
      await first.assertResourceOwner(staleTransaction, oldOwner)
      await staleTransaction.query('INSERT INTO resource_owner_fenced_writes (value) VALUES ($1)', ['stale'])
      await staleTransaction.query('COMMIT')
      throw new Error('stale owner unexpectedly committed a mutation')
    } catch (error) {
      await staleTransaction.query('ROLLBACK').catch(() => undefined)
      expect(error).toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    } finally {
      staleTransaction.release()
    }
    const staleWrites = await first.database.query('SELECT value FROM resource_owner_fenced_writes')
    expect(staleWrites.rows).toEqual([])

    const liveTransaction = await second.database.connect()
    try {
      await liveTransaction.query('BEGIN')
      await second.assertResourceOwner(liveTransaction, newOwner!)
      await liveTransaction.query('SELECT 1')
      await liveTransaction.query('COMMIT')
    } catch (error) {
      await liveTransaction.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      liveTransaction.release()
    }

    await expect(second.renewResourceOwner(newOwner!, 5_000)).resolves.toMatchObject({ generation: newOwner!.generation })
    await expect(first.renewReplica({ ...replicaA, membershipToken: randomUUID() }, 5_000))
      .rejects.toBeInstanceOf(RuntimeUnitReplicaMembershipFencedError)
  })
})

function resource(
  organizationId: string,
  unitId: ReturnType<typeof parseTenantRuntimeUnitId>,
  resourceType: 'session' | 'task',
): RuntimeResourceScope {
  return { organizationId, unitId, resourceType, resourceId: randomUUID() }
}

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}
