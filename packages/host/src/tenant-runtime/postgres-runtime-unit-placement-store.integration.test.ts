import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migratePostgres } from '../postgres-migrations.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './postgres-hot-state.js'
import {
  createPostgresRuntimeUnitPlacementStore,
  PARALLEL_PLACEMENT_BARRIER,
  PARALLEL_PLACEMENT_BARRIER_ORIGIN,
  type PostgresRuntimeUnitPlacementStore,
  RuntimeUnitPlacementFencedError,
  RuntimeUnitPlacementHeldError,
  RuntimeUnitPlacementProtocolError,
  type RuntimeUnitPlacementLease,
  type RuntimeUnitPlacementScope,
} from './postgres-runtime-unit-placement-store.js'
import { parseTenantRuntimeUnitId } from './unit.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresRuntimeUnitPlacementStore isolated PostgreSQL integration', () => {
  const testProject = `kala-unit-placement-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  let first: PostgresRuntimeUnitPlacementStore
  let second: PostgresRuntimeUnitPlacementStore
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_unit_placement_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${port}/kala_unit_placement_test`
    first = createPostgresRuntimeUnitPlacementStore({ connectionString, applicationName: `${testProject}-node-a` })
    second = createPostgresRuntimeUnitPlacementStore({ connectionString, applicationName: `${testProject}-node-b` })
    await eventually(async () => {
      await first.database.query('SELECT 1')
    }, 30_000)
    await migratePostgres({ connectionString, applicationName: `${testProject}-migrate` })
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled([first?.close(), second?.close()])
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  it('elects one activation under concurrent acquire, rejects reentry, renews, releases, and fences the old token', async () => {
    const scope = placementScope('unit-concurrent')
    const attempts = await Promise.allSettled([
      first.acquire({ ...scope, nodeId: 'node-a', ownerToken: randomUUID(), origin: 'https://runtime-a.example' }, 2_000),
      second.acquire({ ...scope, nodeId: 'node-b', ownerToken: randomUUID(), origin: 'https://runtime-b.example' }, 2_000),
    ])
    const won = attempts.filter((attempt): attempt is PromiseFulfilledResult<RuntimeUnitPlacementLease> => attempt.status === 'fulfilled')
    const lost = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toBeInstanceOf(RuntimeUnitPlacementHeldError)

    const lease = won[0]!.value
    const ownerStore = lease.nodeId === 'node-a' ? first : second
    const otherStore = lease.nodeId === 'node-a' ? second : first
    const live = await otherStore.lookupLive(scope)
    expect(live).toEqual(expect.objectContaining({
      unitId: scope.unitId,
      organizationId: scope.organizationId,
      nodeId: lease.nodeId,
      origin: lease.origin,
      generation: 1n,
    }))
    expect(live).not.toHaveProperty('ownerToken')

    await expect(ownerStore.acquire({
      ...scope, nodeId: lease.nodeId, ownerToken: lease.ownerToken, origin: lease.origin,
    }, 2_000)).rejects.toBeInstanceOf(RuntimeUnitPlacementHeldError)

    const renewed = await ownerStore.renew(lease, 5_000)
    expect(renewed.generation).toBe(lease.generation)
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(lease.expiresAt.getTime())
    await ownerStore.release(renewed)
    expect(await otherStore.lookupLive(scope)).toBeUndefined()

    const replacement = await otherStore.acquire({
      ...scope,
      nodeId: lease.nodeId === 'node-a' ? 'node-b' : 'node-a',
      ownerToken: randomUUID(),
      origin: lease.nodeId === 'node-a' ? 'https://runtime-b.example' : 'https://runtime-a.example',
    }, 5_000)
    expect(replacement.generation).toBe(lease.generation + 1n)
    await expect(ownerStore.renew(renewed, 5_000)).rejects.toBeInstanceOf(RuntimeUnitPlacementFencedError)
    await expect(ownerStore.release(renewed)).rejects.toBeInstanceOf(RuntimeUnitPlacementFencedError)
  })

  it('uses PostgreSQL time for expiry lookup and monotonically increments generation on takeover', async () => {
    const scope = placementScope('unit-expiry')
    const before = await databaseClock(first)
    const oldLease = await first.acquire({
      ...scope,
      nodeId: 'node-a',
      ownerToken: randomUUID(),
      origin: 'http://127.0.0.1:4101',
    }, 250)
    const after = await databaseClock(second)
    expect(oldLease.expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 200)
    expect(oldLease.expiresAt.getTime()).toBeLessThanOrEqual(after.getTime() + 500)
    await expect(second.acquire({
      ...scope,
      nodeId: 'node-b',
      ownerToken: randomUUID(),
      origin: 'http://127.0.0.1:4102',
    }, 5_000)).rejects.toBeInstanceOf(RuntimeUnitPlacementHeldError)

    await eventually(async () => {
      const now = await databaseClock(second)
      expect(now.getTime()).toBeGreaterThanOrEqual(oldLease.expiresAt.getTime())
      expect(await second.lookupLive(scope)).toBeUndefined()
    }, 5_000)

    const replacement = await second.acquire({
      ...scope,
      nodeId: 'node-b',
      ownerToken: randomUUID(),
      origin: 'http://127.0.0.1:4102',
    }, 5_000)
    expect(replacement.generation).toBe(oldLease.generation + 1n)
    expect(await first.lookupLive(scope)).toEqual(expect.objectContaining({
      nodeId: 'node-b', origin: 'http://127.0.0.1:4102', generation: replacement.generation,
    }))
    await expect(first.renew(oldLease, 5_000)).rejects.toBeInstanceOf(RuntimeUnitPlacementFencedError)
    await expect(first.release(oldLease)).rejects.toBeInstanceOf(RuntimeUnitPlacementFencedError)
  })

  it('holds takeover behind an in-flight fenced transaction, then rejects stale SQL and accepts the new owner', async () => {
    const scope = placementScope('unit-transaction-fence')
    await first.database.query('CREATE TABLE transaction_fence_writes (value text PRIMARY KEY)')
    const oldLease = await first.acquire({
      ...scope,
      nodeId: 'node-a',
      ownerToken: randomUUID(),
      origin: 'https://runtime-a.example',
    }, 150)
    const oldHotState = createPostgresHotStateStore({ connectionString, placementLease: oldLease })
    let newHotState: PostgresHotStateStore | undefined
    let entered!: () => void
    const transactionEntered = new Promise<void>((resolve) => { entered = resolve })
    let unblock!: () => void
    const transactionUnblocked = new Promise<void>((resolve) => { unblock = resolve })

    try {
      const delayedOldWrite = oldHotState.database.transaction(async (transaction) => {
        await transaction.query('INSERT INTO transaction_fence_writes (value) VALUES ($1)', ['old-before-takeover'])
        entered()
        await transactionUnblocked
        await transaction.query('INSERT INTO transaction_fence_writes (value) VALUES ($1)', ['old-before-commit'])
      })
      await transactionEntered
      await eventually(async () => {
        expect(await second.lookupLive(scope)).toBeUndefined()
      }, 5_000)

      let takeoverSettled = false
      const takeover = second.acquire({
        ...scope,
        nodeId: 'node-b',
        ownerToken: randomUUID(),
        origin: 'https://runtime-b.example',
      }, 5_000).finally(() => { takeoverSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(takeoverSettled).toBe(false)

      unblock()
      await delayedOldWrite
      const newLease = await takeover
      expect(newLease.generation).toBe(oldLease.generation + 1n)

      await expect(oldHotState.database.query(
        'INSERT INTO transaction_fence_writes (value) VALUES ($1)',
        ['stale-after-takeover'],
      )).rejects.toBeInstanceOf(RuntimeUnitPlacementFencedError)
      newHotState = createPostgresHotStateStore({ connectionString, placementLease: newLease })
      await newHotState.database.query('INSERT INTO transaction_fence_writes (value) VALUES ($1)', ['new-owner'])

      const written = await first.database.query<{ value: string }>('SELECT value FROM transaction_fence_writes ORDER BY value')
      expect(written.rows.map((row) => row.value)).toEqual(['new-owner', 'old-before-commit', 'old-before-takeover'])
    } finally {
      unblock?.()
      await Promise.allSettled([oldHotState.close(), newHotState?.close() ?? Promise.resolve()])
    }
  })

  it('requires an expired legacy lease, admits two v1 replicas, blocks legacy acquire, and rejects unknown versions', async () => {
    const scope = placementScope('unit-protected-parallel')
    await expect(first.promoteToParallel(scope, 1n)).rejects.toBeInstanceOf(RuntimeUnitPlacementProtocolError)
    const legacyLease = await first.acquire({
      ...scope, nodeId: 'legacy-node', ownerToken: randomUUID(), origin: 'https://legacy.example',
    }, 5_000)

    await expect(first.database.query(`UPDATE tenant_runtime_unit_placement_leases
      SET node_id=$3, owner_token=$3, origin=$4, generation=generation+1, expires_at='infinity'
      WHERE unit_id=$1 AND organization_id=$2`, [
      scope.unitId, scope.organizationId, PARALLEL_PLACEMENT_BARRIER, PARALLEL_PLACEMENT_BARRIER_ORIGIN,
    ])).rejects.toMatchObject({ code: '55006' })

    await expect(first.promoteToParallel(scope, legacyLease.generation + 1n))
      .rejects.toBeInstanceOf(RuntimeUnitPlacementHeldError)
    await first.release(legacyLease)
    await expect(first.promoteToParallel(scope, legacyLease.generation))
      .rejects.toBeInstanceOf(RuntimeUnitPlacementFencedError)
    const promoted = await first.promoteToParallel(scope, legacyLease.generation + 1n)
    expect(await second.promoteToParallel(scope, promoted.generation)).toEqual(promoted)
    const barrierGeneration = promoted.generation.toString()

    const [replicaA, replicaB] = await Promise.all([
      first.acquire({ ...scope, nodeId: 'new-a', ownerToken: randomUUID(), origin: 'https://new-a.example' }, 5_000),
      second.acquire({ ...scope, nodeId: 'new-b', ownerToken: randomUUID(), origin: 'https://new-b.example' }, 5_000),
    ])
    expect(replicaA).toEqual(expect.objectContaining({
      protocol: 'parallel-v1', nodeId: PARALLEL_PLACEMENT_BARRIER, generation: BigInt(barrierGeneration),
    }))
    expect(replicaB).toEqual(replicaA)
    await Promise.all([first.release(replicaA), second.release(replicaB)])

    const legacyInsert = await second.database.query(`INSERT INTO tenant_runtime_unit_placement_leases
      (unit_id,organization_id,node_id,owner_token,origin,generation,expires_at)
      VALUES ($1,$2,'legacy-new','legacy-token','https://legacy-new.example',1,clock_timestamp()+interval '5 seconds')
      ON CONFLICT (unit_id,organization_id) DO NOTHING`, [scope.unitId, scope.organizationId])
    expect(legacyInsert.rowCount).toBe(0)
    const legacyTakeover = await second.database.query(`UPDATE tenant_runtime_unit_placement_leases
      SET node_id='legacy-new', owner_token='legacy-token', origin='https://legacy-new.example',
          generation=generation+1, expires_at=clock_timestamp()+interval '5 seconds'
      WHERE unit_id=$1 AND organization_id=$2 AND expires_at<=clock_timestamp()`, [scope.unitId, scope.organizationId])
    expect(legacyTakeover.rowCount).toBe(0)

    await expect(first.database.query(`DELETE FROM tenant_runtime_unit_protocol_gates
      WHERE organization_id=$1 AND unit_id=$2`, [scope.organizationId, scope.unitId]))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query(`UPDATE tenant_runtime_unit_protocol_gates SET feature_version=2
      WHERE organization_id=$1 AND unit_id=$2`, [scope.organizationId, scope.unitId]))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query(`DELETE FROM tenant_runtime_unit_placement_leases
      WHERE organization_id=$1 AND unit_id=$2`, [scope.organizationId, scope.unitId]))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query(`UPDATE tenant_runtime_unit_placement_leases
      SET node_id='legacy-new', owner_token='legacy-token', origin='https://legacy-new.example',
          generation=generation+1, expires_at=clock_timestamp()+interval '5 seconds'
      WHERE organization_id=$1 AND unit_id=$2`, [scope.organizationId, scope.unitId]))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query(`UPDATE tenant_runtime_unit_placement_leases
      SET unit_id='moved-to-another-unit'
      WHERE organization_id=$1 AND unit_id=$2`, [scope.organizationId, scope.unitId]))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query('TRUNCATE tenant_runtime_unit_protocol_gates'))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query('TRUNCATE tenant_runtime_unit_placement_leases'))
      .rejects.toMatchObject({ code: '55006' })
    await expect(first.database.query(`UPDATE tenant_runtime_unit_placement_leases
      SET organization_id='another-organization'
      WHERE organization_id=$1 AND unit_id=$2`, [scope.organizationId, scope.unitId]))
      .rejects.toMatchObject({ code: '55006' })

    const futureScope = placementScope('unit-unknown-feature-version')
    const previous = await first.acquire({
      ...futureScope, nodeId: 'temporary', ownerToken: randomUUID(), origin: 'https://temporary.example',
    }, 5_000)
    await first.release(previous)
    await first.database.query(`UPDATE tenant_runtime_unit_placement_leases
      SET node_id=$3, owner_token=$3, origin=$4, generation=generation+1, expires_at='infinity'
      WHERE unit_id=$1 AND organization_id=$2`, [
      futureScope.unitId, futureScope.organizationId, PARALLEL_PLACEMENT_BARRIER, PARALLEL_PLACEMENT_BARRIER_ORIGIN,
    ])
    await first.database.query(`INSERT INTO tenant_runtime_unit_protocol_gates
      (organization_id, unit_id, feature_version, barrier_generation) VALUES ($1,$2,2,$3)`, [
      futureScope.organizationId, futureScope.unitId, previous.generation + 1n,
    ])
    await expect(first.acquire({
      ...futureScope, nodeId: 'future-reader', ownerToken: randomUUID(), origin: 'https://future.example',
    }, 5_000)).rejects.toBeInstanceOf(RuntimeUnitPlacementProtocolError)
    await expect(first.lookupLive(futureScope)).rejects.toBeInstanceOf(RuntimeUnitPlacementProtocolError)
  })

  it('rejects unsafe origins and non-simple schema identifiers before issuing SQL', async () => {
    const scope = placementScope('unit-validation')
    for (const origin of [
      'postgres://runtime.example',
      Object.assign(new URL('https://runtime.example'), { username: 'user' }).href,
      'https://runtime.example/private',
      'https://runtime.example?target=other',
      'https://runtime.example#fragment',
    ]) {
      await expect(first.acquire({ ...scope, nodeId: 'node-a', ownerToken: randomUUID(), origin }, 1_000)).rejects.toThrow(TypeError)
    }
    expect(() => createPostgresRuntimeUnitPlacementStore({
      connectionString: 'postgresql://unused', schema: 'public; DROP SCHEMA public',
    })).toThrow('schema must be a simple PostgreSQL identifier')
  })
})

function placementScope(unitId: string): RuntimeUnitPlacementScope {
  return { unitId: parseTenantRuntimeUnitId(unitId), organizationId: 'org-a' }
}

async function databaseClock(store: PostgresRuntimeUnitPlacementStore): Promise<Date> {
  const result = await store.database.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  return result.rows[0]!.now
}

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
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
