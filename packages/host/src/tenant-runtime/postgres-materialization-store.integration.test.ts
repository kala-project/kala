import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { RuntimeUnitMaterialization } from './materialization-store.js'
import {
  createPostgresRuntimeUnitMaterializationStore,
  type PostgresRuntimeUnitMaterializationStore,
} from './postgres-materialization-store.js'
import { parseTenantRuntimeUnitId } from './unit.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresRuntimeUnitMaterializationStore isolated PostgreSQL integration', () => {
  const testProject = `kala-materialization-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  let connectionString: string
  const stores: PostgresRuntimeUnitMaterializationStore[] = []

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_materialization_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgres://postgres:kala_test_only@127.0.0.1:${port}/kala_materialization_test`
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(stores.map((store) => store.close()))
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  it('fences stale caches, preserves organization binding, and restores a routable unit after restart', async () => {
    const first = createStore('node-a')
    const second = createStore('node-b')
    await eventually(() => first.load(), 30_000)
    await second.load()

    await first.apply(entry(1, 'provision-1'))
    expect(second.get(parseTenantRuntimeUnitId('unit-a'))).toBeUndefined()
    expect(await second.refresh(parseTenantRuntimeUnitId('unit-a'))).toMatchObject({
      organizationId: 'org-a', generation: 1, desiredState: 'ready', lastOperationId: 'provision-1',
    })
    await second.apply(entry(2, 'takeover-2'))

    expect(first.get(parseTenantRuntimeUnitId('unit-a'))).toMatchObject({ generation: 1 })
    await expect(first.apply(entry(2, 'stale-node-2'))).rejects.toThrow('stale TenantRuntimeUnit generation')
    await expect(first.apply({ ...entry(3, 'wrong-org-3'), organizationId: 'org-other' })).rejects.toThrow('organization binding cannot change')

    await second.close()
    const restarted = createStore('node-b-restarted')
    await restarted.load()
    expect(restarted.list()).toEqual([expect.objectContaining({
      unitId: 'unit-a', organizationId: 'org-a', generation: 2, desiredState: 'ready', lastOperationId: 'takeover-2',
    })])

    await restarted.tombstone({ ...entry(3, 'delete-3'), desiredState: 'deleted' })
    await expect(first.apply(entry(4, 'stale-cache-resume-4'))).rejects.toThrow('deleted TenantRuntimeUnit cannot be resumed')

    const finalRestart = createStore('node-c')
    await finalRestart.load()
    expect(finalRestart.get(parseTenantRuntimeUnitId('unit-a'))).toMatchObject({
      organizationId: 'org-a', generation: 3, desiredState: 'deleted', lastOperationId: 'delete-3',
    })
  })

  function createStore(node: string): PostgresRuntimeUnitMaterializationStore {
    const store = createPostgresRuntimeUnitMaterializationStore({ connectionString, applicationName: `${testProject}-${node}` })
    stores.push(store)
    return store
  }
})

function entry(generation: number, operationId: string): RuntimeUnitMaterialization {
  return {
    schemaVersion: 1,
    unitId: parseTenantRuntimeUnitId('unit-a'),
    organizationId: 'org-a',
    routingKeyDigest: '',
    routingKeyVersion: 1,
    generation,
    desiredState: 'ready',
    dataRoot: '/ephemeral/tenant-runtime-units/unit-a',
    capabilities: AGENT_RUNTIME_CAPABILITIES,
    lastOperationId: operationId,
    updatedAt: new Date(generation * 1_000).toISOString(),
  }
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
