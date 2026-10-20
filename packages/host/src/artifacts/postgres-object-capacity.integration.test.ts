import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { S3MessageAttachmentStore } from '../message-attachments/s3-message-attachment-store.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import type { ArtifactObject, ArtifactObjectStore } from './object-store.js'
import { PostgresObjectCapacityLedger } from './postgres-object-capacity.js'
import { PostgresObjectMetadataLog, type ObjectMetadataLog } from './postgres-object-metadata.js'
import { S3SessionArtifactRegistry } from './s3-session-artifact-registry.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

class MemoryObjects implements ArtifactObjectStore {
  readonly values = new Map<string, Uint8Array>()
  failPutOnce = false
  failDeleteOnce = false
  async put(object: ArtifactObject): Promise<void> {
    if (this.failPutOnce) { this.failPutOnce = false; throw new Error('S3 put failed') }
    this.values.set(`${object.organizationId}/${object.key}`, object.body.slice())
  }
  async get(organizationId: string, key: string): Promise<Uint8Array> {
    const value = this.values.get(`${organizationId}/${key}`)
    if (!value) throw new Error('not found')
    return value.slice()
  }
  async delete(organizationId: string, key: string): Promise<void> {
    if (this.failDeleteOnce) { this.failDeleteOnce = false; throw new Error('S3 delete failed') }
    this.values.delete(`${organizationId}/${key}`)
  }
  async signedGetUrl(): Promise<URL> { return new URL('https://objects.invalid/signed') }
}

integrationDescribe('PostgreSQL object capacity integration', () => {
  const project = `kala-object-capacity-${randomUUID()}`
  const container = `${project}-postgres`
  const database = 'kala_object_capacity_test'
  const stores: PostgresHotStateStore[] = []
  let connectionString = ''

  beforeAll(async () => {
    await docker('run', '--detach', '--rm', '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only', '--env', `POSTGRES_DB=${database}`,
      '--publish', '127.0.0.1::5432', 'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container)
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${stdout.trim()}/${database}`
    const probe = makeStore('probe')
    await eventually(async () => await probe.initialize(), 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(stores.map(async (store) => await store.close()))
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  function makeStore(node: string): PostgresHotStateStore {
    const store = createPostgresHotStateStore({ connectionString, applicationName: `${project}-${node}` })
    stores.push(store)
    return store
  }

  async function authorities(node: string, organizationId: string, limit: number) {
    const hotState = makeStore(node)
    await hotState.initialize()
    const capacity = new PostgresObjectCapacityLedger(organizationId, limit, hotState)
    const metadata = new PostgresObjectMetadataLog(organizationId, hotState, { capacity })
    await metadata.initialize()
    await capacity.initialize()
    return { hotState, capacity, metadata }
  }

  it('atomically bounds two-node uploads, survives restart, and does not credit a failed delete', async () => {
    const organizationId = `org_${randomUUID().replaceAll('-', '')}`
    const nodeA = await authorities('node-a', organizationId, png.length)
    const nodeB = await authorities('node-b', organizationId, png.length)
    const objects = new MemoryObjects()
    const registryA = new S3SessionArtifactRegistry(organizationId, objects, nodeA.metadata, nodeA.capacity)
    const registryB = new S3SessionArtifactRegistry(organizationId, objects, nodeB.metadata, nodeB.capacity)

    const results = await Promise.allSettled([
      registryA.registerImage({ sessionId: 'session-a', fileName: 'a.png', data: png }),
      registryB.registerImage({ sessionId: 'session-b', fileName: 'b.png', data: png }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(objects.values.size).toBe(1)
    expect(await nodeA.capacity.usageBytes()).toBe(png.length)

    const restarted = new PostgresObjectCapacityLedger(organizationId, png.length, makeStore('restarted'))
    await restarted.initialize()
    expect(await restarted.usageBytes()).toBe(png.length)

    const sessionId = results[0]?.status === 'fulfilled' ? 'session-a' : 'session-b'
    const registry = sessionId === 'session-a' ? registryA : registryB
    objects.failDeleteOnce = true
    await expect(registry.deleteSession(sessionId)).rejects.toThrow('S3 delete failed')
    expect(await restarted.usageBytes()).toBe(png.length)
    await registry.deleteSession(sessionId)
    expect(await restarted.usageBytes()).toBe(0)
  }, 60_000)

  it('shares one organization quota between attachments and Artifacts', async () => {
    const organizationId = `org_${randomUUID().replaceAll('-', '')}`
    const authority = await authorities('shared-kinds', organizationId, png.length)
    const objects = new MemoryObjects()
    const attachments = new S3MessageAttachmentStore(organizationId, objects, authority.metadata, authority.capacity)
    const artifacts = new S3SessionArtifactRegistry(organizationId, objects, authority.metadata, authority.capacity)
    const attachment = await attachments.register({ sessionId: 'shared', name: 'note.txt', data: Buffer.from('x') })

    await expect(artifacts.registerImage({ sessionId: 'shared', fileName: 'image.png', data: png })).rejects.toThrow('quota exceeded')
    expect(await authority.capacity.usageBytes()).toBe(1)
    await attachments.releasePending('shared', [attachment.source.attachmentId])
    expect(await authority.capacity.usageBytes()).toBe(0)
  }, 60_000)

  it('onboards legacy published metadata while excluding durably completed deletes', async () => {
    const organizationId = `org_${randomUUID().replaceAll('-', '')}`
    const hotState = makeStore('legacy-onboarding')
    await hotState.initialize()
    const metadata = new PostgresObjectMetadataLog(organizationId, hotState)
    await metadata.initialize()
    const objects = new MemoryObjects()
    const legacy = new S3SessionArtifactRegistry(organizationId, objects, metadata)
    await legacy.registerImage({ sessionId: 'kept', fileName: 'kept.png', data: png })
    await legacy.registerImage({ sessionId: 'deleted', fileName: 'deleted.png', data: png })
    await legacy.deleteSession('deleted')

    const capacity = new PostgresObjectCapacityLedger(organizationId, png.length * 2, makeStore('legacy-restart'))
    await capacity.initialize()
    expect(await capacity.usageBytes()).toBe(png.length)
  }, 60_000)

  it('fails closed when a legacy orphan intent has no trustworthy byte count', async () => {
    const organizationId = `org_${randomUUID().replaceAll('-', '')}`
    const hotState = makeStore('legacy-orphan')
    await hotState.initialize()
    const metadata = new PostgresObjectMetadataLog(organizationId, hotState)
    await metadata.initialize()
    await metadata.prepareObject('unknown-bytes', 'session-artifacts/sessions/legacy/orphan.png')

    const capacity = new PostgresObjectCapacityLedger(organizationId, png.length, hotState)
    await expect(capacity.initialize()).rejects.toThrow('uploads are disabled')
  }, 60_000)

  it('does not delete an object when metadata commit succeeds but its acknowledgement is lost', async () => {
    const organizationId = `org_${randomUUID().replaceAll('-', '')}`
    const authority = await authorities('lost-ack', organizationId, png.length * 2)
    const objects = new MemoryObjects()
    const lostAckMetadata: ObjectMetadataLog = {
      initialize: async () => await authority.metadata.initialize(),
      replay: async <Payload>(sessionId: string) => await authority.metadata.replay<Payload>(sessionId),
      beginSessionDeletion: async (sessionId) => await authority.metadata.beginSessionDeletion(sessionId),
      prepareObject: async (sessionId, objectKey) => await authority.metadata.prepareObject(sessionId, objectKey),
      append: async (sessionId, input) => {
        await authority.metadata.append(sessionId, input)
        throw new Error('metadata acknowledgement lost')
      },
      completeObjectCleanup: async (intent) => await authority.metadata.completeObjectCleanup(intent),
    }
    const registry = new S3SessionArtifactRegistry(organizationId, objects, lostAckMetadata, authority.capacity)
    await expect(registry.registerImage({ sessionId: 'lost-ack', fileName: 'a.png', data: png })).rejects.toThrow('acknowledgement lost')
    expect(objects.values.size).toBe(1)
    expect(await authority.capacity.usageBytes()).toBe(png.length)
    const recovered = new S3SessionArtifactRegistry(organizationId, objects, authority.metadata, authority.capacity)
    const published = await authority.metadata.replay<{ record: { artifactId: string } }>('lost-ack')
    const registered = published.find((event) => event.eventType === 'session_artifact.registered')
    expect(registered).toBeDefined()
    expect(await (await recovered.get('lost-ack', registered!.payload.record.artifactId))?.read()).toEqual(png)
  }, 60_000)

  it('conservatively accounts for ambiguous put and metadata failures', async () => {
    const organizationId = `org_${randomUUID().replaceAll('-', '')}`
    const authority = await authorities('compensation', organizationId, png.length * 2)
    const objects = new MemoryObjects()
    const registry = new S3SessionArtifactRegistry(organizationId, objects, authority.metadata, authority.capacity)

    objects.failPutOnce = true
    await expect(registry.registerImage({ sessionId: 'put-failure', fileName: 'a.png', data: png })).rejects.toThrow('put failed')
    expect(await authority.capacity.usageBytes()).toBe(png.length)

    const failingMetadata: ObjectMetadataLog = {
      initialize: async () => await authority.metadata.initialize(),
      replay: async <Payload>(sessionId: string) => await authority.metadata.replay<Payload>(sessionId),
      beginSessionDeletion: async (sessionId) => await authority.metadata.beginSessionDeletion(sessionId),
      prepareObject: async (sessionId, objectKey) => await authority.metadata.prepareObject(sessionId, objectKey),
      append: async () => { throw new Error('metadata publish failed') },
      completeObjectCleanup: async (intent) => await authority.metadata.completeObjectCleanup(intent),
    }
    const metadataFailureRegistry = new S3SessionArtifactRegistry(organizationId, objects, failingMetadata, authority.capacity)
    await expect(metadataFailureRegistry.registerImage({ sessionId: 'metadata-failure', fileName: 'b.png', data: png })).rejects.toThrow('metadata publish failed')
    expect(objects.values.size).toBe(1)
    expect(await authority.capacity.usageBytes()).toBe(png.length * 2)
  }, 60_000)
})

async function docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await operation(); return } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 250)) }
  }
  throw lastError
}
