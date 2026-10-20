import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import {
  detectImageMime,
  extensionForMime,
  MAX_IMAGE_BYTES,
  type ResolvedSessionArtifact,
  type SessionArtifactRecord,
  type SessionArtifactStorage,
} from '../session-artifact-registry.js'
import type { ArtifactObjectStore } from './object-store.js'
import type { ObjectCapacityLedger, ObjectCapacityReservation } from './postgres-object-capacity.js'
import type { ObjectMetadataEvent, ObjectMetadataLog, ObjectOrphanIntent } from './postgres-object-metadata.js'

type StoredArtifact = SessionArtifactRecord & { objectKey: string }
type ArtifactEvent =
  | { kind: 'registered'; record: StoredArtifact }
  | { kind: 'delete_requested'; records: StoredArtifact[] }
  | { kind: 'delete_completed'; objectKeys: string[] }

type ArtifactState = { records: Map<string, StoredArtifact>; pendingDeletes: Map<string, StoredArtifact> }

/** S3 byte storage plus PostgreSQL event metadata for Private Cloud. */
export class S3SessionArtifactRegistry implements SessionArtifactStorage {
  constructor(
    private readonly organizationId: string,
    private readonly objects: ArtifactObjectStore,
    private readonly metadata: ObjectMetadataLog,
    private readonly capacity?: ObjectCapacityLedger,
  ) {}

  async load(): Promise<void> {
    await this.metadata.initialize()
  }

  async registerImage(input: { sessionId: string; title?: string; fileName: string; data: Buffer }): Promise<SessionArtifactRecord> {
    const mediaType = detectImageMime(input.data, input.fileName)
    if (!mediaType) throw new Error('unsupported image type')
    if (input.data.length === 0 || input.data.length > MAX_IMAGE_BYTES) throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`)
    const artifactId = randomUUID()
    const fileName = `${artifactId}${extensionForMime(mediaType)}`
    const record: StoredArtifact = {
      artifactId,
      sessionId: input.sessionId,
      title: input.title?.trim() || basename(input.fileName),
      mediaType,
      bytes: input.data.length,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      fileName,
      createdAt: new Date().toISOString(),
      objectKey: objectKey('session-artifacts', input.sessionId, fileName),
    }
    const reservation = await this.capacity?.reserve({
      objectKey: record.objectKey,
      sessionId: input.sessionId,
      kind: 'session_artifact',
      bytes: record.bytes,
    })
    let intent: ObjectOrphanIntent | undefined
    try {
      intent = await this.metadata.prepareObject(input.sessionId, record.objectKey)
      await this.objects.put({ organizationId: this.organizationId, key: record.objectKey, contentType: mediaType, body: input.data })
      await this.metadata.append(input.sessionId, {
        idempotencyKey: `session-artifact-register:${artifactId}`,
        eventType: 'session_artifact.registered',
        payload: { kind: 'registered', record } satisfies ArtifactEvent,
        intent,
        ...(reservation ? { capacity: { kind: 'commit' as const, reservation } } : {}),
      })
    } catch (error) {
      await this.compensateFailedUpload(reservation, intent)
      throw error
    }
    return publicRecord(record)
  }

  async get(sessionId: string, artifactId: string): Promise<ResolvedSessionArtifact | undefined> {
    const record = (await this.state(sessionId)).records.get(artifactId)
    if (!record) return undefined
    return {
      ...publicRecord(record),
      read: async () => await this.readVerified(record),
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Persist the publication fence before hiding metadata or deleting bytes.
    // Registrations that already put an object can no longer consume their
    // orphan intent, so reconciliation safely removes those late objects.
    await this.metadata.beginSessionDeletion(sessionId)
    let state = await this.state(sessionId)
    const toRequest = [...state.records.values()]
    if (toRequest.length > 0) {
      const requestId = randomUUID()
      await this.metadata.append(sessionId, {
        idempotencyKey: `session-artifact-delete-request:${requestId}`,
        eventType: 'session_artifact.delete_requested',
        payload: { kind: 'delete_requested', records: toRequest } satisfies ArtifactEvent,
        allowDuringSessionDeletion: true,
      })
      state = await this.state(sessionId)
    }
    const pending = [...state.pendingDeletes.values()]
    if (pending.length === 0) return
    for (const record of pending) await this.objects.delete(this.organizationId, record.objectKey)
    const objectKeys = pending.map((record) => record.objectKey).sort()
    await this.metadata.append(sessionId, {
      idempotencyKey: `session-artifact-delete-complete:${digestKeys(objectKeys)}`,
      eventType: 'session_artifact.delete_completed',
      payload: { kind: 'delete_completed', objectKeys } satisfies ArtifactEvent,
      ...(this.capacity ? { capacity: { kind: 'release_committed' as const, objectKeys } } : {}),
      allowDuringSessionDeletion: true,
    })
  }

  private async compensateFailedUpload(reservation: ObjectCapacityReservation | undefined, intent: ObjectOrphanIntent | undefined): Promise<void> {
    if (!reservation || !this.capacity) return
    if (!intent) {
      await this.capacity.release(reservation)
      return
    }
    // A PG commit may still be in flight (or its acknowledgement may have been
    // lost). Never delete a potentially published object outside a fenced orphan
    // claim. Retain the reservation until the old writer is provably stopped.
  }

  private async state(sessionId: string): Promise<ArtifactState> {
    return reduceArtifactEvents(await this.metadata.replay<ArtifactEvent>(sessionId))
  }

  private async readVerified(record: StoredArtifact): Promise<Buffer> {
    const data = Buffer.from(await this.objects.get(this.organizationId, record.objectKey))
    if (data.length !== record.bytes || createHash('sha256').update(data).digest('hex') !== record.sha256) {
      throw new Error(`Artifact "${record.title}" failed object integrity validation`)
    }
    return data
  }
}

function reduceArtifactEvents(events: readonly ObjectMetadataEvent<ArtifactEvent>[]): ArtifactState {
  const state: ArtifactState = { records: new Map(), pendingDeletes: new Map() }
  for (const event of events) {
    if (!event.eventType.startsWith('session_artifact.')) continue
    const payload = event.payload
    if (payload.kind === 'registered') {
      if (!state.pendingDeletes.has(payload.record.objectKey)) state.records.set(payload.record.artifactId, payload.record)
    } else if (payload.kind === 'delete_requested') {
      for (const record of payload.records) {
        state.records.delete(record.artifactId)
        state.pendingDeletes.set(record.objectKey, record)
      }
    } else if (payload.kind === 'delete_completed') {
      for (const key of payload.objectKeys) state.pendingDeletes.delete(key)
    }
  }
  return state
}

function publicRecord({ objectKey: _objectKey, ...record }: StoredArtifact): SessionArtifactRecord { return record }
function objectKey(kind: string, sessionId: string, fileName: string): string {
  const sessionKey = createHash('sha256').update(sessionId).digest('hex')
  return `${kind}/sessions/${sessionKey}/${fileName}`
}
function digestKeys(keys: readonly string[]): string { return createHash('sha256').update(keys.join('\n')).digest('hex') }
