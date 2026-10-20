import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresSessionAuthority } from '../store/postgres-session-authority.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { ObjectMetadataSessionDeletingError, PostgresObjectMetadataLog } from './postgres-object-metadata.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresObjectMetadataLog scope isolation integration', () => {
  const testProject = `kala-object-metadata-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const hotStores: PostgresHotStateStore[] = []
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_object_metadata_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgres://postgres:kala_test_only@127.0.0.1:${port}/kala_object_metadata_test`

    const probe = makeHotStore('probe')
    await eventually(async () => await probe.initialize(), 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(hotStores.map(async (store) => await store.close()))
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function makeHotStore(node: string): PostgresHotStateStore {
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${node}` })
    hotStores.push(hotState)
    return hotState
  }

  it('keeps Session authority and object metadata leases, writes, and two-node replay isolated', async () => {
    const nodeA = makeHotStore('node-a')
    const nodeB = makeHotStore('node-b')
    const authorityA = new PostgresSessionAuthority(nodeA, 'tenant-a', { ownerId: 'session-node-a' })
    const authorityB = new PostgresSessionAuthority(nodeB, 'tenant-a', { ownerId: 'session-node-b' })
    const objectsA = new PostgresObjectMetadataLog('tenant-a', nodeA)
    const objectsB = new PostgresObjectMetadataLog('tenant-a', nodeB)
    const otherTenantObjects = new PostgresObjectMetadataLog('tenant-b', nodeB)
    const sessionId = 'shared-session'

    await authorityA.initialize()
    // PostgreSQL CREATE TABLE IF NOT EXISTS is not safe from the catalog race
    // caused by several first-time initializers in the same empty schema.
    await objectsA.initialize()
    await objectsB.initialize()
    await otherTenantObjects.initialize()

    await objectsA.append(sessionId, {
      idempotencyKey: 'object-node-a',
      eventType: 'object.created',
      payload: { objectKey: 'first' },
    })

    await expect(authorityB.load(sessionId)).resolves.toBeUndefined()
    const projectionsBeforeSessionWrite = await nodeB.database.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM tenant_session_latest_projection WHERE tenant_id = $1 AND session_id = $2`, ['tenant-a', sessionId])
    expect(projectionsBeforeSessionWrite.rows).toEqual([{ count: '0' }])

    await authorityB.create({ sessionId, state: { cursor: 0 }, marker: 'session-only' })
    await expect(objectsB.replay<{ objectKey: string }>(sessionId)).resolves.toMatchObject([
      { sequence: 1n, eventType: 'object.created', payload: { objectKey: 'first' } },
    ])

    await Promise.all([
      authorityA.mutate(sessionId, {
        mutationId: 'session-node-a-update',
        eventType: 'session.updated',
        apply: (current) => current ? { ...current, state: { cursor: 1 } } : undefined,
      }),
      objectsB.append(sessionId, {
        idempotencyKey: 'object-node-b',
        eventType: 'object.updated',
        payload: { objectKey: 'second' },
      }),
    ])

    await expect(authorityB.load(sessionId)).resolves.toMatchObject({
      sessionId,
      state: { cursor: 1 },
      marker: 'session-only',
    })
    await expect(objectsA.replay<{ objectKey: string }>(sessionId)).resolves.toMatchObject([
      { sequence: 1n, eventType: 'object.created', payload: { objectKey: 'first' } },
      { sequence: 2n, eventType: 'object.updated', payload: { objectKey: 'second' } },
    ])
    await expect(otherTenantObjects.replay(sessionId)).resolves.toEqual([])

    const scopes = await nodeA.database.query<{
      tenant_id: string
      scope_type: string
      scope_id: string
      sequences: string[]
      event_types: string[]
    }>(`SELECT tenant_id, scope_type, scope_id,
        array_agg(sequence::text ORDER BY sequence) AS sequences,
        array_agg(event_type ORDER BY sequence) AS event_types
      FROM tenant_runtime_hot_events
      GROUP BY tenant_id, scope_type, scope_id
      ORDER BY tenant_id, scope_type, scope_id`)
    expect(scopes.rows).toEqual([
      {
        tenant_id: 'tenant-a',
        scope_type: 'session',
        scope_id: sessionId,
        sequences: ['1', '2'],
        event_types: ['session.created', 'session.updated'],
      },
      {
        tenant_id: 'tenant-a',
        scope_type: 'task',
        scope_id: `object:${sessionId}`,
        sequences: ['1', '2'],
        event_types: ['object.created', 'object.updated'],
      },
    ])

    const leases = await nodeA.database.query<{ scope_type: string; scope_id: string }>(`SELECT scope_type, scope_id
      FROM tenant_runtime_hot_leases WHERE tenant_id = $1 ORDER BY scope_type, scope_id`, ['tenant-a'])
    expect(leases.rows).toEqual([
      { scope_type: 'session', scope_id: sessionId },
      { scope_type: 'task', scope_id: `object:${sessionId}` },
    ])
  })

  it('atomically fences object preparation and publication after Session deletion starts', async () => {
    const nodeA = makeHotStore('delete-fence-node-a')
    const nodeB = makeHotStore('delete-fence-node-b')
    const writer = new PostgresObjectMetadataLog('tenant-delete-fence', nodeA)
    const deleter = new PostgresObjectMetadataLog('tenant-delete-fence', nodeB)
    await Promise.all([writer.initialize(), deleter.initialize()])

    const intent = await writer.prepareObject('fenced-session', 'objects/already-put')
    await deleter.beginSessionDeletion('fenced-session')

    await expect(writer.prepareObject('fenced-session', 'objects/new')).rejects.toBeInstanceOf(ObjectMetadataSessionDeletingError)
    await expect(writer.append('fenced-session', {
      idempotencyKey: 'publish-after-delete-fence',
      eventType: 'object.registered',
      payload: { objectKey: intent.objectKey },
      intent,
    })).rejects.toBeInstanceOf(ObjectMetadataSessionDeletingError)

    const orphan = await nodeA.database.query<{ state: string }>(`SELECT state FROM tenant_object_orphan_intents
      WHERE tenant_id = $1 AND object_key = $2`, ['tenant-delete-fence', intent.objectKey])
    expect(orphan.rows).toEqual([{ state: 'pending' }])
    await expect(deleter.append('fenced-session', {
      idempotencyKey: 'cleanup-after-delete-fence',
      eventType: 'object.delete_completed',
      payload: { objectKey: intent.objectKey },
      allowDuringSessionDeletion: true,
    })).resolves.toBeUndefined()
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
