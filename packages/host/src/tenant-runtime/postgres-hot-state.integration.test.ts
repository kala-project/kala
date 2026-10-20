import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createPostgresHotStateStore,
  IdempotencyConflictError,
  LeaseFencedError,
  LeaseHeldError,
  type HotStateScope,
  type LeaseToken,
  type PostgresHotStateStore,
} from './postgres-hot-state.js'

const execFileAsync = promisify(execFile)
const runIntegration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1'
const integrationDescribe = runIntegration ? describe : describe.skip

integrationDescribe('PostgresHotStateStore isolated PostgreSQL integration', () => {
  const testProject = `kala-hot-state-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  let first: PostgresHotStateStore
  let second: PostgresHotStateStore

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_hot_state_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout: portOutput } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = portOutput.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    const connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${port}/kala_hot_state_test`
    first = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-node-a` })
    second = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-node-b` })
    await eventually(async () => {
      await first.database.query('SELECT 1')
    }, 30_000)
    await first.initialize()
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled([first?.close(), second?.close()])
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  it('serializes appends from two independent clients and deduplicates retries', async () => {
    const scope: HotStateScope = { tenantId: 'tenant-a', scopeType: 'session', scopeId: 'session-a' }
    const token = await first.acquireLease(scope, 'runtime-node-a', 10_000)
    await expect(second.acquireLease(scope, 'runtime-node-b', 10_000)).rejects.toBeInstanceOf(LeaseHeldError)

    const writes = Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? first : second).appendEvent(token, {
      idempotencyKey: `operation-${index}`,
      eventType: 'message',
      payload: index === 0 ? { index, nested: { a: 1, b: 2 } } : { index },
    }))
    await Promise.all(writes)

    const retry = await second.appendEvent(token, {
      idempotencyKey: 'operation-0',
      eventType: 'message',
      payload: { nested: { b: 2, a: 1 }, index: 0 },
    })
    expect(retry.sequence).toBeGreaterThanOrEqual(1n)
    await expect(second.appendEvent(token, {
      idempotencyKey: 'operation-0', eventType: 'different', payload: { index: 0 },
    })).rejects.toBeInstanceOf(IdempotencyConflictError)

    const replayed = await second.replay<{ index: number }>(scope)
    expect(replayed).toHaveLength(12)
    expect(replayed.map((event) => event.sequence)).toEqual(Array.from({ length: 12 }, (_, index) => BigInt(index + 1)))
    expect(new Set(replayed.map((event) => event.idempotencyKey)).size).toBe(12)
    expect((await first.replay(scope, { afterSequence: 5n, limit: 3 })).map((event) => event.sequence)).toEqual([6n, 7n, 8n])
  })

  it('allows expired lease takeover and rejects the old generation writer', async () => {
    const scope: HotStateScope = { tenantId: 'tenant-a', scopeType: 'task', scopeId: 'task-a' }
    const oldToken = await first.acquireLease(scope, 'runtime-node-a', 80)
    await expect(second.acquireLease(scope, 'runtime-node-b', 5_000)).rejects.toBeInstanceOf(LeaseHeldError)

    let newToken: LeaseToken | undefined
    await eventually(async () => {
      newToken = await second.acquireLease(scope, 'runtime-node-b', 5_000)
    }, 5_000)
    expect(newToken!.generation).toBe(oldToken.generation + 1n)
    await expect(first.appendEvent(oldToken, {
      idempotencyKey: 'stale-write', eventType: 'task-progress', payload: { progress: 1 },
    })).rejects.toBeInstanceOf(LeaseFencedError)
    await expect(first.renewLease(oldToken, 5_000)).rejects.toBeInstanceOf(LeaseFencedError)

    const accepted = await second.appendEvent(newToken!, {
      idempotencyKey: 'new-write', eventType: 'task-progress', payload: { progress: 2 },
    })
    expect(accepted).toMatchObject({ sequence: 1n, generation: newToken!.generation })
  })
})

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
