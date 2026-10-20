import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migratePostgres } from '../postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import {
  createPostgresRuntimeResourceOwnershipStore,
  RuntimeResourceOwnershipFencedError,
  type PostgresRuntimeResourceOwnershipStore,
  type RuntimeResourceOwnership,
} from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from '../tenant-runtime/unit.js'
import { PostgresDagStore } from './postgres-store.js'

const execFileAsync = promisify(execFile)
const connectionString = process.env.KALA_TEST_POSTGRES_URL
const describePg = connectionString ? describe : describe.skip
const describeIsolatedPg = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

describePg('PostgresDagStore client restart', () => {
  const tenantId = `dag-test-${randomUUID()}`
  const unitId = randomUUID()
  let database: PostgresHotStateStore

  beforeAll(async () => {
    database = createPostgresHotStateStore({ connectionString: connectionString!, applicationName: `kala-dag-test-${unitId}` })
    await database.initialize()
  })

  afterAll(async () => {
    if (!database) return
    await database.database.query('DELETE FROM tenant_dag_state WHERE tenant_id = $1', [tenantId])
    await database.close()
  })

  it('preserves graph, attempts, events and operation idempotency across a new client', async () => {
    const first = new PostgresDagStore(database.database, tenantId, unitId)
    const created = await first.createRun('parent', 'Persist safely', 'create')
    await first.installGraph(created.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'work',
      nodes: [{ id: 'work', title: 'Work', instructions: 'Do it' }],
      edges: [],
    }, 'graph')
    const [claim] = await first.claimReadyNodes(created.id, 'worker-a', 1, 60_000)
    expect(claim).toBeDefined()
    await first.updateNodeProgress(created.id, 'work', 'worker-a', 'halfway', new Date().toISOString(), claim!.leaseGeneration)

    const restarted = new PostgresDagStore(database.database, tenantId, unitId)
    const retried = await restarted.createRun('parent', 'Persist safely', 'create')
    expect(retried.id).toBe(created.id)
    await restarted.completeNode(created.id, 'work', 'worker-a', { status: 'succeeded', result: 'done' }, 'complete', new Date().toISOString(), claim!.leaseGeneration)

    const complete = await restarted.getRun(created.id)
    expect(complete).toMatchObject({ status: 'completed', result: 'done', graphVersion: 1 })
    expect(complete?.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 'succeeded' })])
    expect(complete?.events.some((event) => event.message === 'Progress: halfway')).toBe(true)
    expect(complete?.graphHistory).toHaveLength(1)
  })

  it('fences stale clients and blocks automatic duplicate execution after an expired lease', async () => {
    const first = new PostgresDagStore(database.database, tenantId, `${unitId}-fence`)
    const run = await first.createRun('parent-fence', 'Unknown effects', 'create-fence')
    await first.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'effect',
      nodes: [{ id: 'effect', title: 'Effect', instructions: 'Perform external effect' }],
      edges: [],
    }, 'graph-fence')
    const startedAt = new Date('2026-01-01T00:00:00.000Z')
    const [claim] = await first.claimReadyNodes(run.id, 'worker-old', 1, 1_000, startedAt)

    const restarted = new PostgresDagStore(database.database, tenantId, `${unitId}-fence`)
    const takeover = await restarted.claimReadyNodes(run.id, 'worker-new', 1, 60_000, new Date('2026-01-01T00:00:02.000Z'))
    expect(takeover).toEqual([])
    const recovered = await restarted.getRun(run.id)
    expect(recovered?.status).toBe('failed')
    expect(recovered?.nodes[0]).toMatchObject({ status: 'failed', progress: 'Execution outcome unknown' })
    await expect(first.completeNode(run.id, 'effect', 'worker-old', { status: 'succeeded', result: 'late' }, 'late', new Date('2026-01-01T00:00:02.000Z').toISOString(), claim!.leaseGeneration)).rejects.toThrow()
  })
})

describeIsolatedPg('PostgresDagStore Session owner fencing in isolated PostgreSQL', () => {
  const project = `kala-dag-owner-${randomUUID()}`
  const container = `${project}-postgres`
  const databaseName = `kala_dag_owner_${randomUUID().replaceAll('-', '')}`
  const password = `test-${randomUUID()}`
  let isolatedConnectionString = ''
  let database: PostgresHotStateStore
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
    isolatedConnectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`
    database = createPostgresHotStateStore({ connectionString: isolatedConnectionString, applicationName: `${project}-dag` })
    first = createPostgresRuntimeResourceOwnershipStore({ connectionString: isolatedConnectionString, applicationName: `${project}-owner-a` })
    second = createPostgresRuntimeResourceOwnershipStore({ connectionString: isolatedConnectionString, applicationName: `${project}-owner-b` })
    await eventually(async () => { await database.database.query('SELECT 1') }, 30_000)
    await migratePostgres({ connectionString: isolatedConnectionString })
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled([database?.close(), first?.close(), second?.close()])
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  it('rejects every stale owner mutation before idempotent replay or worker lease recovery', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentSessionId = randomUUID()
    const scope = { organizationId, unitId, resourceType: 'session' as const, resourceId: parentSessionId }
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://dag-old.example',
    }, 2_000)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://dag-new.example',
    }, 10_000)
    const oldOwner = await first.acquireResourceOwner(scope, replicaA, randomUUID(), 8_000)
    const prepared: string[] = []
    const staleStore = ownerStore(oldOwner, async (sessionId) => { prepared.push(sessionId) })

    const completing = await staleStore.createRun(parentSessionId, 'Complete under successor', 'create-completing')
    const graph = {
      expectedGraphVersion: 0,
      resultNodeId: 'work',
      nodes: [{ id: 'work', title: 'Work', instructions: 'Do it' }],
      edges: [],
    }
    await staleStore.installGraph(completing.id, graph, 'graph-completing')
    const [longClaim] = await staleStore.claimReadyNodes(completing.id, 'worker-old', 1, 60_000)
    expect(longClaim).toBeDefined()

    const recovering = await staleStore.createRun(parentSessionId, 'Recover expired worker', 'create-recovering')
    await staleStore.installGraph(recovering.id, graph, 'graph-recovering')
    const [shortClaim] = await staleStore.claimReadyNodes(recovering.id, 'worker-expired', 1, 1_000)
    expect(shortClaim).toBeDefined()

    let newOwner: RuntimeResourceOwnership | undefined
    await eventually(async () => {
      newOwner = await second.acquireResourceOwner(scope, replicaB, randomUUID(), 8_000)
    }, 6_000)
    expect(newOwner!.generation).toBe(oldOwner.generation + 1n)
    const liveStore = ownerStore(newOwner!)

    await expect(staleStore.createRun(parentSessionId, 'Complete under successor', 'create-completing'))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.installGraph(completing.id, graph, 'graph-completing'))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.attachChildSession(completing.id, 'work', 'worker-old', randomUUID(), undefined, longClaim!.leaseGeneration))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.updateNodeProgress(completing.id, 'work', 'worker-old', 'stale', undefined, longClaim!.leaseGeneration))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.renewLease(completing.id, 'work', 'worker-old', 60_000, undefined, longClaim!.leaseGeneration))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.expandNode(completing.id, 'work', 'worker-old', {
      expectedGraphVersion: 1, resultNodeId: 'replacement',
      nodes: [{ id: 'replacement', title: 'Replacement', instructions: 'Replace it' }], edges: [],
    }, 'expand-stale', undefined, longClaim!.leaseGeneration)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.createDecision({
      id: 'decision-stale', runId: completing.id, nodeId: 'work', workerId: 'worker-old',
      question: 'Continue?', context: 'Stale owner', choices: ['yes'], allowFreeform: false,
      leaseGeneration: longClaim!.leaseGeneration,
    })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(staleStore.answerDecision(completing.id, 'missing', 'yes', 'answer-stale'))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)

    await liveStore.completeNode(completing.id, 'work', 'worker-old', { status: 'succeeded', result: 'done' },
      'complete-successor', undefined, longClaim!.leaseGeneration)
    await expect(staleStore.completeNode(completing.id, 'work', 'worker-old', { status: 'succeeded', result: 'done' },
      'complete-successor', undefined, longClaim!.leaseGeneration)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)

    await expect(staleStore.claimReadyNodes(recovering.id, 'worker-stale', 1, 60_000))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(liveStore.claimReadyNodes(recovering.id, 'worker-new', 1, 60_000)).resolves.toEqual([])
    expect(await liveStore.getRun(recovering.id)).toMatchObject({
      status: 'failed', nodes: [expect.objectContaining({ status: 'failed', progress: 'Execution outcome unknown' })],
    })
    expect(prepared).toContain(parentSessionId)

    function ownerStore(owner: RuntimeResourceOwnership, prepareSessionOwner = async () => undefined): PostgresDagStore {
      return new PostgresDagStore(database.database, organizationId, unitId, {
        schemaManagement: 'external', prepareSessionOwner, resourceOwnerForSession: () => owner,
      })
    }
  }, 20_000)
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
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}
