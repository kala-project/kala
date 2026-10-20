import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { S3ArtifactObjectStore, type ArtifactObjectStore } from './object-store.js'
import { PostgresObjectMetadataLog } from './postgres-object-metadata.js'
import { createPrivateCloudObjectStorage } from './private-cloud-storage.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' && process.env.KALA_RUN_SILO_INTEGRATION === '1'
  ? describe
  : describe.skip
const siloImage = 'pgsty/silo@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'

integrationDescribe('PG/S3 orphan intent reconciliation with isolated Docker services', () => {
  const project = `kala-orphan-test-${randomUUID()}`
  const postgresContainer = `${project}-postgres`
  const siloContainer = `${project}-silo`
  const accessKeyId = 'kala-test-access'
  const secretAccessKey = `test-${randomUUID()}-only`
  const stores: PostgresHotStateStore[] = []
  let connectionString: string
  let endpoint: string
  let objects: S3ArtifactObjectStore

  beforeAll(async () => {
    await docker('run', '--detach', '--rm', '--name', postgresContainer,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_orphan_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    await docker('run', '--detach', '--rm', '--name', siloContainer,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/data:rw,nosuid,size=256m',
      '--publish', '127.0.0.1::9000',
      '--env', `MINIO_ROOT_USER=${accessKeyId}`,
      '--env', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      siloImage, 'server', '/data')

    const [{ stdout: pgPortOutput }, { stdout: siloPortOutput }] = await Promise.all([
      docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', postgresContainer),
      docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}', siloContainer),
    ])
    const pgPort = pgPortOutput.trim()
    const siloPort = siloPortOutput.trim()
    if (!/^\d+$/u.test(pgPort) || !/^\d+$/u.test(siloPort)) throw new Error('Docker did not assign integration ports')
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${pgPort}/kala_orphan_test`
    endpoint = `http://127.0.0.1:${siloPort}`

    const probe = makeHotStore('probe')
    await Promise.all([
      eventually(async () => await probe.initialize(), 30_000),
      eventually(async () => {
        const response = await fetch(`${endpoint}/minio/health/live`)
        if (!response.ok) throw new Error(`Silo not ready: ${response.status}`)
      }, 30_000),
    ])
    await docker('exec', siloContainer, 'mcli', 'alias', 'set', 'test', 'http://127.0.0.1:9000', accessKeyId, secretAccessKey)
    await docker('exec', siloContainer, 'mcli', 'mb', 'test/kala-orphan-artifacts')
    objects = new S3ArtifactObjectStore({
      endpoint, region: 'us-east-1', bucket: 'kala-orphan-artifacts',
      accessKeyId, secretAccessKey, maxObjectBytes: 1024,
    })
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(stores.map(async (store) => await store.close()))
    await Promise.allSettled([
      docker('rm', '--force', postgresContainer),
      docker('rm', '--force', siloContainer),
    ])
  }, 30_000)

  function makeHotStore(node: string): PostgresHotStateStore {
    const store = createPostgresHotStateStore({ connectionString, applicationName: `${project}-${node}` })
    stores.push(store)
    return store
  }

  async function expirePending(organizationId: string): Promise<void> {
    await stores[0]!.database.query(`UPDATE tenant_object_orphan_intents
      SET upload_expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE tenant_id = $1 AND state = 'pending'`, [organizationId])
  }

  it('does not reconcile a pending intent while its PutObject lease is live', async () => {
    const metadata = new PostgresObjectMetadataLog('org_inflight', makeHotStore('inflight'), { uploadIntentLeaseMs: 30_000 })
    await metadata.initialize()
    const key = 'session-artifacts/inflight/object.png'
    const intent = await metadata.prepareObject('session-inflight', key)
    let releasePut!: () => void
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    let putStarted!: () => void
    const started = new Promise<void>((resolve) => { putStarted = resolve })
    const upload = (async () => {
      putStarted()
      await putGate
      await put('org_inflight', key, 'in-flight')
    })()
    await started

    await expect(metadata.reconcileOrphanIntents(objects, { limit: 1 }))
      .resolves.toEqual({ claimed: 0, deleted: 0, failed: 0 })
    releasePut()
    await upload
    await metadata.append('session-inflight', {
      idempotencyKey: 'publish-inflight', eventType: 'session_artifact.registered',
      payload: { objectKey: key }, intent,
    })
    await expect(objects.get('org_inflight', key)).resolves.toEqual(new TextEncoder().encode('in-flight'))
  })

  it('cleans a post-upload crash on the next Runtime while preserving published objects', async () => {
    const crashed = new PostgresObjectMetadataLog('org_crash', makeHotStore('crashed'))
    await crashed.initialize()
    const orphanKey = 'session-artifacts/crashed/orphan.png'
    await crashed.prepareObject('session-crashed', orphanKey)
    await put('org_crash', orphanKey, 'orphan')

    const publishedKey = 'session-artifacts/live/published.png'
    const publishedIntent = await crashed.prepareObject('session-live', publishedKey)
    await put('org_crash', publishedKey, 'published')
    await crashed.append('session-live', {
      idempotencyKey: 'publish-live', eventType: 'session_artifact.registered',
      payload: { objectKey: publishedKey }, intent: publishedIntent,
    })
    // Simulate a colliding stale intent from a retry/migration. Historical PG
    // metadata must make reconciliation fail closed rather than delete the live object.
    const collidingIntent = await crashed.prepareObject('session-live', publishedKey)

    const restartedHotState = makeHotStore('restarted')
    // Legacy intents lack byte allocations; boot must fail closed until an
    // operator reconciles them, while the lower-level orphan cleaner remains usable.
    await expect(createPrivateCloudObjectStorage({
      organizationId: 'org_crash', endpoint, region: 'us-east-1', bucket: 'kala-orphan-artifacts',
      accessKeyId, secretAccessKey, maxObjectBytes: 1024, maxArtifactBytes: 4096, hotState: restartedHotState,
      orphanReconciliationLimit: 10,
    })).rejects.toThrow('Legacy object intents have unknown byte usage')
    const restarted = new PostgresObjectMetadataLog('org_crash', restartedHotState)
    await expirePending('org_crash')
    await expect(restarted.reconcileOrphanIntents(objects, { limit: 10 })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
    await expect(objects.get('org_crash', orphanKey)).rejects.toThrow()
    await expect(objects.get('org_crash', publishedKey)).resolves.toEqual(new TextEncoder().encode('published'))
    await crashed.completeObjectCleanup(collidingIntent)
    await expect(restarted.reconcileOrphanIntents(objects, { limit: 10 })).resolves.toEqual({ claimed: 0, deleted: 0, failed: 0 })
  })

  it('bounds each pass and never scans or deletes another organization', async () => {
    const tenantA = new PostgresObjectMetadataLog('org_a', makeHotStore('tenant-a'))
    const tenantB = new PostgresObjectMetadataLog('org_b', makeHotStore('tenant-b'))
    await Promise.all([tenantA.initialize(), tenantB.initialize()])
    const keys = ['message-attachments/a/one', 'message-attachments/a/two']
    for (const key of keys) {
      await tenantA.prepareObject('session-a', key)
      await put('org_a', key, key)
    }
    const tenantBKey = 'message-attachments/b/only'
    await tenantB.prepareObject('session-b', tenantBKey)
    await put('org_b', tenantBKey, 'tenant-b')
    await Promise.all([expirePending('org_a'), expirePending('org_b')])

    await expect(tenantA.reconcileOrphanIntents(objects, { limit: 1 })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
    const remainingA = await Promise.all(keys.map(async (key) => objects.get('org_a', key).then(() => true, () => false)))
    expect(remainingA.filter(Boolean)).toHaveLength(1)
    await expect(objects.get('org_b', tenantBKey)).resolves.toEqual(new TextEncoder().encode('tenant-b'))

    await expect(tenantA.reconcileOrphanIntents(objects, { limit: 1 })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
    await expect(tenantB.reconcileOrphanIntents(objects, { limit: 1 })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
  })

  it('serializes concurrent publication against a claim without leaving a visible missing object', async () => {
    const writer = new PostgresObjectMetadataLog('org_race', makeHotStore('race-writer'))
    const sweeper = new PostgresObjectMetadataLog('org_race', makeHotStore('race-sweeper'))
    await Promise.all([writer.initialize(), sweeper.initialize()])
    const key = 'session-artifacts/race/object.png'
    const intent = await writer.prepareObject('session-race', key)
    await put('org_race', key, 'race')

    const [publishResult, reconciliation] = await Promise.allSettled([
      writer.append('session-race', {
        idempotencyKey: 'race-publish', eventType: 'session_artifact.registered',
        payload: { objectKey: key }, intent,
      }),
      sweeper.reconcileOrphanIntents(objects, { limit: 1 }),
    ])
    const events = await writer.replay<{ objectKey: string }>('session-race')
    expect(publishResult.status).toBe('fulfilled')
    expect(reconciliation).toMatchObject({ status: 'fulfilled', value: { claimed: 0, deleted: 0, failed: 0 } })
    expect(events).toHaveLength(1)
    await expect(objects.get('org_race', key)).resolves.toEqual(new TextEncoder().encode('race'))
  })

  it('turns a put racing Session deletion into a recoverable orphan instead of published metadata', async () => {
    const writer = new PostgresObjectMetadataLog('org_delete_race', makeHotStore('delete-race-writer'))
    const deleter = new PostgresObjectMetadataLog('org_delete_race', makeHotStore('delete-race-deleter'))
    await Promise.all([writer.initialize(), deleter.initialize()])
    const key = 'session-artifacts/delete-race/object.png'
    const intent = await writer.prepareObject('session-delete-race', key)
    await put('org_delete_race', key, 'put-before-delete-fence')

    await deleter.beginSessionDeletion('session-delete-race')
    await expect(writer.append('session-delete-race', {
      idempotencyKey: 'late-publish-after-session-delete',
      eventType: 'session_artifact.registered',
      payload: { objectKey: key },
      intent,
    })).rejects.toThrow('being deleted')
    await expect(writer.replay('session-delete-race')).resolves.toEqual([])
    await expirePending('org_delete_race')
    await expect(deleter.reconcileOrphanIntents(objects, { limit: 1, claimTimeoutMs: 1 }))
      .resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
    await expect(objects.get('org_delete_race', key)).rejects.toThrow()
  })

  it('keeps an ambiguous failed delete fenced and retries it idempotently after claim expiry', async () => {
    const metadata = new PostgresObjectMetadataLog('org_retry', makeHotStore('retry'))
    await metadata.initialize()
    const key = 'message-attachments/retry/object'
    const intent = await metadata.prepareObject('session-retry', key)
    await put('org_retry', key, 'retry')
    let failOnce = true
    const ambiguousObjects: ArtifactObjectStore = {
      put: async (object) => await objects.put(object),
      get: async (organizationId, objectKey) => await objects.get(organizationId, objectKey),
      signedGetUrl: async (organizationId, objectKey, ttlSeconds) => await objects.signedGetUrl(organizationId, objectKey, ttlSeconds),
      delete: async (organizationId: string, objectKey: string) => {
        if (failOnce) { failOnce = false; throw new Error('ambiguous S3 failure') }
        await objects.delete(organizationId, objectKey)
      },
    }

    await expirePending('org_retry')
    await expect(metadata.reconcileOrphanIntents(ambiguousObjects, { limit: 1, claimTimeoutMs: 1 }))
      .resolves.toEqual({ claimed: 1, deleted: 0, failed: 1 })
    await expect(metadata.append('session-retry', {
      idempotencyKey: 'must-stay-fenced', eventType: 'message_attachment.registered',
      payload: { objectKey: key }, intent,
    })).rejects.toThrow('intent is unavailable')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(metadata.reconcileOrphanIntents(objects, { limit: 1, claimTimeoutMs: 1 }))
      .resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
    await expect(objects.get('org_retry', key)).rejects.toThrow()

    // A process paused before put can write after the first successful sweep and
    // then be killed. The retained tombstone lets the next Runtime delete it again.
    await put('org_retry', key, 'late-write-after-sweep')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(metadata.reconcileOrphanIntents(objects, { limit: 1, claimTimeoutMs: 1 }))
      .resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
    await expect(objects.get('org_retry', key)).rejects.toThrow()
  })

  async function put(organizationId: string, key: string, value: string): Promise<void> {
    await objects.put({ organizationId, key, contentType: 'application/octet-stream', body: new TextEncoder().encode(value) })
  }
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
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}
