import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migratePostgres } from '../postgres-migrations.js'
import type { ArtifactObjectStore } from '../artifacts/object-store.js'
import { PostgresObjectMetadataLog } from '../artifacts/postgres-object-metadata.js'
import { PostgresObjectCapacityLedger } from '../artifacts/postgres-object-capacity.js'
import { PostgresSessionAuthority } from '../store/postgres-session-authority.js'
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
      await expect(live.load(sessionA)).resolves.toMatchObject({ sessionId: sessionA })
      expect(ownershipB.activeLease(sessionA)).toBeUndefined()
      await expect(live.messageQueue.load(sessionA)).rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
      await eventually(async () => { await live.messageQueue.load(sessionA) }, 5_000)
      expect(ownershipB.activeLease(sessionA)?.replicaId).toBe(memberB.replicaId)
      await expect(old.messageQueue.enqueue(sessionA, { ...queued, id: 'stale', operationId: 'stale' }, 'back'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
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
