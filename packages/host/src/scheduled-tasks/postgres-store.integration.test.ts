import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migratePostgres } from '../postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import {
  createPostgresRuntimeResourceOwnershipStore,
  RuntimeResourceOwnershipFencedError,
  RuntimeResourceOwnershipHeldError,
  type PostgresRuntimeResourceOwnershipStore,
  type RuntimeResourceOwnership,
} from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { PARALLEL_PLACEMENT_BARRIER, PARALLEL_PLACEMENT_BARRIER_ORIGIN } from '../tenant-runtime/postgres-runtime-unit-placement-store.js'
import { parseTenantRuntimeUnitId } from '../tenant-runtime/unit.js'
import { UnitScheduler, type ScheduledTaskExecutor } from './scheduler.js'
import { PostgresScheduledTaskStore, ScheduledTaskFencedError, ScheduledTaskLeaseHeldError } from './postgres-store.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('Private Cloud PostgreSQL scheduled task store', () => {
  const testProject = `kala-pg-scheduled-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const databaseName = `kala_scheduled_${randomUUID().replaceAll('-', '')}`
  const password = `test-${randomUUID()}`
  const databases: PostgresHotStateStore[] = []
  const ownershipStores: PostgresRuntimeResourceOwnershipStore[] = []
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', `POSTGRES_DB=${databaseName}`,
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`
    await eventually(async () => {
      const probe = makeDatabase('probe')
      await probe.database.query('SELECT 1')
    }, 30_000)
    await migratePostgres({ connectionString })
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled([
      ...databases.map(async (database) => await database.close()),
      ...ownershipStores.map(async (store) => await store.close()),
    ])
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function makeDatabase(name: string): PostgresHotStateStore {
    const database = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${name}` })
    databases.push(database)
    return database
  }

  function makeOwnershipStore(name: string): PostgresRuntimeResourceOwnershipStore {
    const store = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${testProject}-${name}` })
    ownershipStores.push(store)
    return store
  }

  async function enableParallelGate(database: PostgresHotStateStore, organizationId: string, unitId: string): Promise<void> {
    await database.database.query(`INSERT INTO tenant_runtime_unit_placement_leases
      (unit_id, organization_id, node_id, owner_token, origin, generation, expires_at)
      VALUES ($1, $2, $3, $3, $4, 1, 'infinity')`, [
      unitId, organizationId, PARALLEL_PLACEMENT_BARRIER, PARALLEL_PLACEMENT_BARRIER_ORIGIN,
    ])
    await database.database.query(`INSERT INTO tenant_runtime_unit_protocol_gates
      (organization_id, unit_id, feature_version, barrier_generation) VALUES ($1, $2, 1, 1)`, [organizationId, unitId])
  }

  it('preserves ownership, history, origins and inbox receipts across two clients', async () => {
    let now = new Date('2035-01-01T00:00:00.000Z')
    const namespace = `tenant-${randomUUID()}`
    const firstDb = makeDatabase('recovery-a')
    const secondDb = makeDatabase('recovery-b')
    const first = new PostgresScheduledTaskStore(firstDb.database, namespace, { now: () => now })
    const second = new PostgresScheduledTaskStore(secondDb.database, namespace, { now: () => now })
    await first.start('unit-recovery')
    await expect(second.start('unit-recovery')).rejects.toBeInstanceOf(ScheduledTaskLeaseHeldError)

    const task = await first.create({
      ownerKey: 'organization:acme', createdBy: 'alice', prompt: 'daily report',
      target: { kind: 'session', sessionId: 'session-a' },
      schedule: { kind: 'once', at: '2035-01-01T00:01:00.000Z' },
    })
    expect(await first.getTask('organization:other', task.id)).toBeUndefined()
    now = new Date('2035-01-01T00:02:00.000Z')
    const run = await first.claim(task.id, task.nextRunAt!)
    expect(run?.status).toBe('claimed')
    await first.finish(run!.occurrenceId, 'enqueued', { sessionId: 'session-a' })
    expect(await first.origins('organization:acme', 'session-a')).toEqual({ [run!.operationId]: task.id })
    expect((await first.inbox('organization:acme', 'alice')).unreadCount).toBe(1)
    expect(await first.markInboxSeen('organization:acme', 'alice', [run!.occurrenceId])).toEqual({ acknowledged: [run!.occurrenceId], unreadCount: 0 })
    await first.close()

    await second.start('unit-recovery')
    expect((await second.history('organization:acme', task.id))?.[0]).toMatchObject({ occurrenceId: run!.occurrenceId, status: 'enqueued' })
    expect((await second.inbox('organization:acme', 'alice')).items[0]).toMatchObject({ occurrenceId: run!.occurrenceId, seen: true })
    await second.close()
  })

  it('fences an old writer after a newer generation takes over', async () => {
    const namespace = `tenant-${randomUUID()}`
    const firstDb = makeDatabase('fence-a')
    const secondDb = makeDatabase('fence-b')
    const first = new PostgresScheduledTaskStore(firstDb.database, namespace, { leaseTtlMs: 1_000, heartbeatMs: 900 })
    const second = new PostgresScheduledTaskStore(secondDb.database, namespace, { leaseTtlMs: 1_000, heartbeatMs: 900 })
    await first.start('unit-fence')
    const task = await first.create({
      ownerKey: 'organization:acme', createdBy: 'alice', prompt: 'fence me',
      target: { kind: 'session', sessionId: 'session-a' },
      schedule: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    })
    await firstDb.database.query(`UPDATE public.scheduled_task_writer_leases
      SET expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE namespace = $1 AND unit_id = $2`, [namespace, 'unit-fence'])
    await second.start('unit-fence')

    await expect(first.setPaused('organization:acme', task.id, true)).rejects.toBeInstanceOf(ScheduledTaskFencedError)
    await expect(second.setPaused('organization:acme', task.id, true)).resolves.toMatchObject({ status: 'paused' })
    await first.close()
    await second.close()
  })

  it('fences mutations, idempotent claim replay and recovery after a Session owner takeover', async () => {
    let now = new Date('2037-01-01T00:00:00.000Z')
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const sessionId = randomUUID()
    const ownerDbA = makeOwnershipStore('owner-a')
    const ownerDbB = makeOwnershipStore('owner-b')
    const [replicaA, replicaB] = await Promise.all([
      ownerDbA.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://scheduled-a.example' }, 60_000),
      ownerDbB.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://scheduled-b.example' }, 60_000),
    ])
    const scope = { organizationId, unitId, resourceType: 'session' as const, resourceId: sessionId }
    const ownerA = await ownerDbA.acquireResourceOwner(scope, replicaA, randomUUID(), 60_000)
    let activeOwner: RuntimeResourceOwnership | undefined = ownerA
    const database = makeDatabase('owner-scheduled')
    const store = new PostgresScheduledTaskStore(database.database, organizationId, {
      schemaManagement: 'external', now: () => now,
      prepareSessionOwner: async () => undefined,
      resourceOwnerForSession: () => activeOwner,
    })
    await store.start(unitId)
    try {
      const task = await store.create({
        ownerKey: `organization:${organizationId}`, createdBy: 'alice', prompt: 'owned delivery',
        target: { kind: 'session', sessionId },
        schedule: { kind: 'once', at: '2037-01-01T00:01:00.000Z' },
      })
      now = new Date('2037-01-01T00:02:00.000Z')
      const claimed = await store.claim(task.id, task.nextRunAt!)
      expect(claimed?.status).toBe('claimed')

      await ownerDbA.releaseResourceOwner(ownerA)
      const ownerB = await ownerDbB.acquireResourceOwner(scope, replicaB, randomUUID(), 60_000)
      expect(ownerB.generation).toBeGreaterThan(ownerA.generation)
      await expect(store.setPaused(task.ownerKey, task.id, true)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(store.claim(task.id, task.nextRunAt!)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(store.claimedRuns()).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(store.finish(claimed!.occurrenceId, 'enqueued', { sessionId }))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)

      activeOwner = ownerB
      await expect(store.claim(task.id, task.nextRunAt!)).resolves.toMatchObject({ occurrenceId: claimed!.occurrenceId })
      await expect(store.finish(claimed!.occurrenceId, 'enqueued', { sessionId })).resolves.toMatchObject({ status: 'enqueued' })
    } finally {
      await store.close()
    }
  })

  it('shares one state across parallel-v1 clients, runs only current owners, takes over, and fences unsafe modes', async () => {
    let now = new Date('2038-01-01T00:00:00.000Z')
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const sessionA = randomUUID()
    const sessionB = randomUUID()
    const databaseA = makeDatabase('parallel-a')
    const databaseB = makeDatabase('parallel-b')
    await enableParallelGate(databaseA, organizationId, unitId)

    const ownerDbA = makeOwnershipStore('parallel-owner-a')
    const ownerDbB = makeOwnershipStore('parallel-owner-b')
    const [replicaA, replicaB] = await Promise.all([
      ownerDbA.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://parallel-scheduled-a.example' }, 60_000),
      ownerDbB.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://parallel-scheduled-b.example' }, 60_000),
    ])
    const activeA = new Map<string, RuntimeResourceOwnership>()
    const activeB = new Map<string, RuntimeResourceOwnership>()
    const ensureA = async (sessionId: string): Promise<RuntimeResourceOwnership> => {
      const current = activeA.get(sessionId)
      if (current) return current
      const owner = await ownerDbA.acquireResourceOwner({ organizationId, unitId, resourceType: 'session', resourceId: sessionId },
        replicaA, randomUUID(), 60_000)
      activeA.set(sessionId, owner)
      return owner
    }
    const ensureB = async (sessionId: string): Promise<RuntimeResourceOwnership> => {
      const current = activeB.get(sessionId)
      if (current) return current
      const owner = await ownerDbB.acquireResourceOwner({ organizationId, unitId, resourceType: 'session', resourceId: sessionId },
        replicaB, randomUUID(), 60_000)
      activeB.set(sessionId, owner)
      return owner
    }
    const tryEnsure = (ensure: (sessionId: string) => Promise<RuntimeResourceOwnership>) => async (sessionId: string): Promise<boolean> => {
      try {
        await ensure(sessionId)
        return true
      } catch (error) {
        if (error instanceof RuntimeResourceOwnershipHeldError) return false
        throw error
      }
    }
    const parallelOptions = (
      ensure: (sessionId: string) => Promise<RuntimeResourceOwnership>,
      active: Map<string, RuntimeResourceOwnership>,
    ) => ({
      schemaManagement: 'external' as const, writerMode: 'parallel-v1' as const, now: () => now,
      leaseTtlMs: 1_000, heartbeatMs: 900,
      prepareSessionOwner: async (sessionId: string) => { await ensure(sessionId) },
      resourceOwnerForSession: (sessionId: string) => active.get(sessionId),
      tryPrepareScheduledSessionOwner: tryEnsure(ensure),
    })

    await Promise.all([ensureA(sessionA), ensureB(sessionB)])
    const first = new PostgresScheduledTaskStore(databaseA.database, organizationId, parallelOptions(ensureA, activeA))
    const second = new PostgresScheduledTaskStore(databaseB.database, organizationId, parallelOptions(ensureB, activeB))
    await first.start(unitId)
    await second.start(unitId)
    const legacy = new PostgresScheduledTaskStore(makeDatabase('parallel-legacy-conflict').database, organizationId)
    await expect(legacy.start(unitId)).rejects.toBeInstanceOf(ScheduledTaskLeaseHeldError)

    const [taskA, taskB] = await Promise.all([
      first.create({ ownerKey: `organization:${organizationId}`, createdBy: 'alice', prompt: 'owned by a',
        target: { kind: 'session', sessionId: sessionA }, schedule: { kind: 'once', at: '2038-01-01T00:01:00.000Z' } }),
      second.create({ ownerKey: `organization:${organizationId}`, createdBy: 'bob', prompt: 'owned by b',
        target: { kind: 'session', sessionId: sessionB }, schedule: { kind: 'once', at: '2038-01-01T00:01:00.000Z' } }),
    ])
    now = new Date('2038-01-01T00:02:00.000Z')
    expect((await first.due(10)).map((task) => task.id)).toEqual([taskA.id])
    expect((await second.due(10)).map((task) => task.id)).toEqual([taskB.id])
    const [runA, runB] = await Promise.all([
      first.claim(taskA.id, taskA.nextRunAt!),
      second.claim(taskB.id, taskB.nextRunAt!),
    ])
    await Promise.all([
      first.finish(runA!.occurrenceId, 'enqueued', { sessionId: sessionA }),
      second.finish(runB!.occurrenceId, 'enqueued', { sessionId: sessionB }),
    ])
    expect((await second.history(taskA.ownerKey, taskA.id))?.[0]).toMatchObject({ status: 'enqueued' })

    const takeoverTask = await first.create({ ownerKey: taskA.ownerKey, createdBy: 'alice', prompt: 'recover safely',
      target: { kind: 'session', sessionId: sessionA }, schedule: { kind: 'once', at: '2038-01-01T00:03:00.000Z' } })
    now = new Date('2038-01-01T00:04:00.000Z')
    const uncertain = await first.claim(takeoverTask.id, takeoverTask.nextRunAt!)
    await databaseA.database.query(`UPDATE scheduled_task_writer_leases
      SET expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE namespace = $1 AND unit_id = $2`, [organizationId, unitId])
    await ownerDbA.releaseResourceOwner(activeA.get(sessionA)!)
    activeA.delete(sessionA)
    expect(await second.claimedRuns()).toEqual([expect.objectContaining({ occurrenceId: uncertain!.occurrenceId })])
    expect(activeB.get(sessionA)?.replicaId).toBe(replicaB.replicaId)
    await first.close()
    await second.close()

    let deliveries = 0
    const replacement = new PostgresScheduledTaskStore(databaseB.database, organizationId, parallelOptions(ensureB, activeB))
    const scheduler = new UnitScheduler(replacement, {
      async validate() {},
      async receipt() { return 'unknown' },
      async enqueueSession() { deliveries += 1 },
      async createWorkspaceSession() { deliveries += 1 },
    }, { unitId, pollMs: 60_000 })
    await scheduler.start()
    expect(deliveries).toBe(0)
    expect((await replacement.history(takeoverTask.ownerKey, takeoverTask.id))?.[0]).toMatchObject({
      occurrenceId: uncertain!.occurrenceId, status: 'needs_review',
    })
    const legacyWhileShared = new PostgresScheduledTaskStore(makeDatabase('parallel-old-writer').database, organizationId)
    await expect(legacyWhileShared.start(unitId)).rejects.toBeInstanceOf(ScheduledTaskLeaseHeldError)
    await scheduler.stop()

    const probe = new PostgresScheduledTaskStore(databaseA.database, organizationId, parallelOptions(ensureB, activeB))
    await probe.start(unitId)
    await expect(databaseA.database.query(`DELETE FROM tenant_runtime_unit_protocol_gates
      WHERE organization_id = $1 AND unit_id = $2`, [organizationId, unitId]))
      .rejects.toMatchObject({ code: '55006' })
    expect((await probe.listTasks(taskA.ownerKey)).map((task) => task.id))
      .toEqual(expect.arrayContaining([taskA.id, takeoverTask.id]))
    await probe.close()
  }, 30_000)

  it('rejects a parallel-v1 client while a legacy writer is live', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const database = makeDatabase('legacy-before-parallel')
    await enableParallelGate(database, organizationId, unitId)
    const legacy = new PostgresScheduledTaskStore(database.database, organizationId)
    await legacy.start(unitId)
    const parallel = new PostgresScheduledTaskStore(makeDatabase('parallel-after-legacy').database, organizationId, {
      schemaManagement: 'external', writerMode: 'parallel-v1',
      prepareSessionOwner: async () => undefined,
      resourceOwnerForSession: () => undefined,
      tryPrepareScheduledSessionOwner: async () => false,
    })
    await expect(parallel.start(unitId)).rejects.toBeInstanceOf(ScheduledTaskLeaseHeldError)
    await legacy.close()
  })

  it('recovers an uncertain claimed occurrence as needs_review without replaying it', async () => {
    let now = new Date('2036-01-01T00:00:00.000Z')
    const namespace = `tenant-${randomUUID()}`
    const firstDb = makeDatabase('scheduler-a')
    const secondDb = makeDatabase('scheduler-b')
    const first = new PostgresScheduledTaskStore(firstDb.database, namespace, { now: () => now })
    await first.start('unit-scheduler')
    const task = await first.create({
      ownerKey: 'organization:acme', createdBy: 'alice', prompt: 'do not replay',
      target: { kind: 'session', sessionId: 'session-uncertain' },
      schedule: { kind: 'once', at: '2036-01-01T00:01:00.000Z' },
    })
    now = new Date('2036-01-01T00:02:00.000Z')
    const claimed = await first.claim(task.id, task.nextRunAt!)
    await first.close()

    let deliveries = 0
    const executor: ScheduledTaskExecutor = {
      async validate() {},
      async receipt() { return 'unknown' },
      async enqueueSession() { deliveries += 1 },
      async createWorkspaceSession() { deliveries += 1 },
    }
    const replacement = new PostgresScheduledTaskStore(secondDb.database, namespace, { now: () => now })
    const scheduler = new UnitScheduler(replacement, executor, { unitId: 'unit-scheduler', pollMs: 60_000 })
    await scheduler.start()
    expect(deliveries).toBe(0)
    expect((await replacement.history('organization:acme', task.id))?.[0]).toMatchObject({
      occurrenceId: claimed!.occurrenceId,
      status: 'needs_review',
      sessionId: 'session-uncertain',
      error: expect.stringContaining('not replayed'),
    })
    await scheduler.stop()
  })
})

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
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}
