import { describe, expect, it, vi } from 'vitest'

import type { ArtifactObject, ArtifactObjectStore } from './object-store.js'
import type { ObjectMetadataEvent, ObjectMetadataLog, ObjectOrphanIntent } from './postgres-object-metadata.js'
import { S3SessionArtifactRegistry } from './s3-session-artifact-registry.js'
import { S3MessageAttachmentStore } from '../message-attachments/s3-message-attachment-store.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

class MemoryObjects implements ArtifactObjectStore {
  readonly values = new Map<string, Uint8Array>()
  failDeleteOnce = false
  async put(object: ArtifactObject): Promise<void> { this.values.set(`${object.organizationId}/${object.key}`, object.body.slice()) }
  async get(organizationId: string, key: string): Promise<Uint8Array> {
    const value = this.values.get(`${organizationId}/${key}`)
    if (!value) throw new Error('not found')
    return value.slice()
  }
  async delete(organizationId: string, key: string): Promise<void> {
    if (this.failDeleteOnce) { this.failDeleteOnce = false; throw new Error('temporary S3 failure') }
    this.values.delete(`${organizationId}/${key}`)
  }
  async signedGetUrl(): Promise<URL> { return new URL('https://objects.invalid/signed') }
}

class MemoryMetadata implements ObjectMetadataLog {
  readonly events = new Map<string, ObjectMetadataEvent[]>()
  readonly intents = new Map<string, ObjectOrphanIntent>()
  readonly deletingSessions = new Set<string>()
  failNextAppend = false
  async initialize(): Promise<void> {}
  async beginSessionDeletion(sessionId: string): Promise<void> { this.deletingSessions.add(sessionId) }
  async replay<Payload>(sessionId: string): Promise<readonly ObjectMetadataEvent<Payload>[]> {
    return (this.events.get(sessionId) ?? []) as ObjectMetadataEvent<Payload>[]
  }
  async prepareObject(sessionId: string, objectKey: string): Promise<ObjectOrphanIntent> {
    if (this.deletingSessions.has(sessionId)) throw new Error(`Session ${sessionId} is being deleted`)
    const intent = { intentId: `${sessionId}:${objectKey}`, sessionId, objectKey }
    this.intents.set(objectKey, intent)
    return intent
  }
  async append<Payload>(sessionId: string, input: { idempotencyKey: string; eventType: string; payload: Payload; intent?: ObjectOrphanIntent; allowDuringSessionDeletion?: boolean }): Promise<void> {
    if (this.failNextAppend) { this.failNextAppend = false; throw new Error('temporary PG failure') }
    if (this.deletingSessions.has(sessionId) && !input.allowDuringSessionDeletion) throw new Error(`Session ${sessionId} is being deleted`)
    if (input.intent && this.intents.get(input.intent.objectKey) !== input.intent) throw new Error('intent unavailable')
    const events = this.events.get(sessionId) ?? []
    const existing = events.find((event) => (event as ObjectMetadataEvent & { idempotencyKey?: string }).idempotencyKey === input.idempotencyKey)
    if (!existing) events.push({ sequence: BigInt(events.length + 1), eventType: input.eventType, payload: input.payload, createdAt: new Date(), idempotencyKey: input.idempotencyKey } as ObjectMetadataEvent)
    this.events.set(sessionId, events)
    if (input.intent) this.intents.delete(input.intent.objectKey)
  }
  async completeObjectCleanup(intent: ObjectOrphanIntent): Promise<void> { this.intents.delete(intent.objectKey) }
}

describe('Private Cloud S3-backed stores', () => {
  it('publishes Artifact metadata only after object put and verifies reads after restart', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    const first = new S3SessionArtifactRegistry('org_acme', objects, metadata)
    const record = await first.registerImage({ sessionId: 'session-a', fileName: 'image.png', data: png })

    const restarted = new S3SessionArtifactRegistry('org_acme', objects, metadata)
    const resolved = await restarted.get('session-a', record.artifactId)
    expect(await resolved?.read()).toEqual(png)

    const storedKey = [...objects.values.keys()][0]!
    objects.values.set(storedKey, Buffer.from('corrupt'))
    await expect(resolved?.read()).rejects.toThrow('integrity')
  })

  it('retains an intent for reconciliation when metadata publication fails', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    metadata.failNextAppend = true
    const registry = new S3SessionArtifactRegistry('org_acme', objects, metadata)

    await expect(registry.registerImage({ sessionId: 'session-a', fileName: 'image.png', data: png })).rejects.toThrow('PG failure')
    expect(objects.values.size).toBe(1)
    expect(metadata.intents.size).toBe(1)
  })

  it('does not try immediate deletion when S3 delete would fail', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    metadata.failNextAppend = true
    objects.failDeleteOnce = true
    const registry = new S3SessionArtifactRegistry('org_acme', objects, metadata)

    await expect(registry.registerImage({ sessionId: 'session-a', fileName: 'image.png', data: png })).rejects.toThrow('PG failure')
    expect(objects.values.size).toBe(1)
    expect(metadata.intents.size).toBe(1)
    expect(objects.failDeleteOnce).toBe(true)
  })

  it('keeps failed deletes tombstoned and retries them without exposing the Artifact', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    const registry = new S3SessionArtifactRegistry('org_acme', objects, metadata)
    const record = await registry.registerImage({ sessionId: 'session-a', fileName: 'image.png', data: png })
    objects.failDeleteOnce = true

    await expect(registry.deleteSession('session-a')).rejects.toThrow('S3 failure')
    expect(await registry.get('session-a', record.artifactId)).toBeUndefined()
    expect(objects.values.size).toBe(1)

    await registry.deleteSession('session-a')
    expect(objects.values.size).toBe(0)
  })

  it('persists a deletion fence even for an empty store and rejects later object publication', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    const artifacts = new S3SessionArtifactRegistry('org_acme', objects, metadata)
    const attachments = new S3MessageAttachmentStore('org_acme', objects, metadata)

    await artifacts.deleteSession('session-a')
    await attachments.deleteSession('session-a')

    await expect(artifacts.registerImage({ sessionId: 'session-a', fileName: 'late.png', data: png })).rejects.toThrow('being deleted')
    await expect(attachments.register({ sessionId: 'session-a', name: 'late.txt', data: Buffer.from('late') })).rejects.toThrow('being deleted')
    expect(objects.values.size).toBe(0)
  })

  it('does not delete an attachment when release races its confirmation on one Runtime', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    const attachments = new S3MessageAttachmentStore('org_acme', objects, metadata)
    const file = await attachments.register({ sessionId: 'session-a', name: 'notes.txt', data: Buffer.from('preserve') })
    const replay = metadata.replay.bind(metadata)
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    let blocked = false
    vi.spyOn(metadata, 'replay').mockImplementation(async (sessionId) => {
      if (!blocked) { blocked = true; entered(); await gate }
      return await replay(sessionId)
    })
    const commit = attachments.commitReferences('session-a', [file])
    await started
    const release = attachments.releasePending('session-a', [file.source.attachmentId])
    resume()
    await Promise.all([commit, release])
    expect(await (await attachments.resolve('session-a', file)).read()).toEqual(Buffer.from('preserve'))
    expect(objects.values.size).toBe(1)
  })

  it('runs attachment register, commit, restart read, pending release, and Session deletion through object storage', async () => {
    const objects = new MemoryObjects()
    const metadata = new MemoryMetadata()
    const first = new S3MessageAttachmentStore('org_acme', objects, metadata)
    const committed = await first.register({ sessionId: 'session-a', name: 'notes.md', mediaType: 'text/markdown', data: Buffer.from('committed') })
    await first.commitReferences('session-a', [committed])
    const pending = await first.register({ sessionId: 'session-a', name: 'draft.md', mediaType: 'text/markdown', data: Buffer.from('pending') })

    const restarted = new S3MessageAttachmentStore('org_acme', objects, metadata)
    expect(await (await restarted.resolve('session-a', committed)).read()).toEqual(Buffer.from('committed'))
    expect(await restarted.sdkFilePath()).toBeUndefined()
    expect(restarted.allowsSdkRead()).toBe(false)

    await restarted.releasePending('session-a', [pending.source.attachmentId])
    await expect(restarted.resolve('session-a', pending)).rejects.toThrow('unavailable')
    expect(await (await restarted.resolve('session-a', committed)).read()).toEqual(Buffer.from('committed'))

    await restarted.deleteSession('session-a')
    await expect(restarted.resolve('session-a', committed)).rejects.toThrow('unavailable')
    expect(objects.values.size).toBe(0)
  })
})
