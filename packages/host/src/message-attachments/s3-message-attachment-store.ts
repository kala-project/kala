import { createHash, randomUUID } from 'node:crypto'

import type { MessageContent, ReferencedFileContent } from '@agent-kernel/kernel'

import type { ArtifactObjectStore } from '../artifacts/object-store.js'
import type { ObjectCapacityLedger, ObjectCapacityReservation } from '../artifacts/postgres-object-capacity.js'
import type { ObjectMetadataEvent, ObjectMetadataLog, ObjectOrphanIntent } from '../artifacts/postgres-object-metadata.js'
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENTS,
  PENDING_MESSAGE_ATTACHMENT_TTL_MS,
  type MessageAttachmentStorage,
  type ResolvedMessageAttachment,
} from '../message-attachment-store.js'

type AttachmentRecord = {
  attachmentId: string
  sessionId: string
  name: string
  mediaType: string
  bytes: number
  sha256: string
  createdAt: string
  committedAt?: string
  objectKey: string
}

type AttachmentEvent =
  | { kind: 'registered'; record: AttachmentRecord }
  | { kind: 'committed'; attachmentIds: string[]; committedAt: string }
  | { kind: 'delete_requested'; records: AttachmentRecord[] }
  | { kind: 'delete_completed'; objectKeys: string[] }

type AttachmentState = { records: Map<string, AttachmentRecord>; pendingDeletes: Map<string, AttachmentRecord> }

/** Private Cloud attachment storage. All methods that consult PG metadata are asynchronous. */
export class S3MessageAttachmentStore implements MessageAttachmentStorage {
  private readonly sessionTails = new Map<string, Promise<void>>()

  constructor(
    private readonly organizationId: string,
    private readonly objects: ArtifactObjectStore,
    private readonly metadata: ObjectMetadataLog,
    private readonly capacity?: ObjectCapacityLedger,
  ) {}

  async load(): Promise<void> { await this.metadata.initialize() }

  async register(input: { sessionId: string; name: string; mediaType?: string; data: Buffer }): Promise<ReferencedFileContent> {
    return await this.serializeSession(normalizeSessionId(input.sessionId), async () => await this.registerLocked(input))
  }

  private async registerLocked(input: { sessionId: string; name: string; mediaType?: string; data: Buffer }): Promise<ReferencedFileContent> {
    await this.cleanupExpiredPending(input.sessionId)
    const sessionId = normalizeSessionId(input.sessionId)
    const name = safeDisplayName(input.name)
    const mediaType = safeMediaType(input.mediaType)
    if (input.data.length < 1 || input.data.length > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new Error(`Attachment must be between 1 byte and ${MAX_MESSAGE_ATTACHMENT_BYTES} bytes`)
    }
    const sha256 = createHash('sha256').update(input.data).digest('hex')
    const state = await this.state(sessionId)
    const duplicate = [...state.records.values()].find((record) => record.sha256 === sha256 && record.name === name && record.mediaType === mediaType && record.committedAt)
    if (duplicate) return referencedFile(duplicate)
    const records = [...state.records.values()]
    if (records.length >= MAX_SESSION_ATTACHMENTS) throw new Error(`Session attachment limit of ${MAX_SESSION_ATTACHMENTS} files exceeded`)
    if (records.reduce((total, record) => total + record.bytes, 0) + input.data.length > MAX_SESSION_ATTACHMENT_BYTES) {
      throw new Error(`Session attachment storage limit of ${MAX_SESSION_ATTACHMENT_BYTES} bytes exceeded`)
    }
    const attachmentId = randomUUID()
    const record: AttachmentRecord = {
      attachmentId, sessionId, name, mediaType, bytes: input.data.length, sha256,
      createdAt: new Date().toISOString(),
      objectKey: objectKey(sessionId, attachmentId),
    }
    const reservation = await this.capacity?.reserve({
      objectKey: record.objectKey,
      sessionId,
      kind: 'message_attachment',
      bytes: record.bytes,
    })
    let intent: ObjectOrphanIntent | undefined
    try {
      intent = await this.metadata.prepareObject(sessionId, record.objectKey)
      await this.objects.put({ organizationId: this.organizationId, key: record.objectKey, contentType: mediaType, body: input.data })
      await this.metadata.append(sessionId, {
        idempotencyKey: `message-attachment-register:${attachmentId}`,
        eventType: 'message_attachment.registered',
        payload: { kind: 'registered', record } satisfies AttachmentEvent,
        intent,
        ...(reservation ? { capacity: { kind: 'commit' as const, reservation } } : {}),
      })
    } catch (error) {
      await this.compensateFailedUpload(reservation, intent)
      throw error
    }
    return referencedFile(record)
  }

  async commitReferences(sessionId: string, content: readonly MessageContent[] | undefined): Promise<void> {
    const ids = referencedAttachmentIds(content)
    if (ids.length === 0) return
    await this.serializeSession(normalizeSessionId(sessionId), async () => await this.commitReferencesLocked(sessionId, content, ids))
  }

  private async commitReferencesLocked(sessionId: string, content: readonly MessageContent[] | undefined, ids: readonly string[]): Promise<void> {
    const state = await this.state(sessionId)
    for (const block of content ?? []) {
      if (isHostReference(block)) validateReference(state, sessionId, block)
    }
    const attachmentIds = [...new Set(ids.filter((id) => !state.records.get(id)?.committedAt))]
    if (attachmentIds.length === 0) return
    await this.metadata.append(sessionId, {
      idempotencyKey: `message-attachment-commit:${randomUUID()}`,
      eventType: 'message_attachment.committed',
      payload: { kind: 'committed', attachmentIds, committedAt: new Date().toISOString() } satisfies AttachmentEvent,
    })
  }

  async releasePending(sessionId: string, attachmentIds: readonly string[]): Promise<void> {
    await this.serializeSession(normalizeSessionId(sessionId), async () => {
      const state = await this.state(sessionId)
      const records = attachmentIds.map((id) => state.records.get(id)).filter((record): record is AttachmentRecord => Boolean(record && !record.committedAt))
      await this.deleteRecords(sessionId, records)
    })
  }

  async resolve(sessionId: string, file: ReferencedFileContent): Promise<ResolvedMessageAttachment> {
    const state = await this.state(sessionId)
    const record = validateReference(state, sessionId, file)
    return this.resolved(record)
  }

  async resolveById(sessionId: string, attachmentId: string): Promise<ResolvedMessageAttachment> {
    const record = (await this.state(sessionId)).records.get(attachmentId)
    if (!record || record.sessionId !== sessionId) throw new Error('Attachment is unavailable or does not belong to this Session')
    return this.resolved(record)
  }

  async sdkFilePath(): Promise<undefined> { return undefined }
  allowsSdkRead(): boolean { return false }

  async deleteSession(sessionId: string): Promise<void> {
    await this.serializeSession(normalizeSessionId(sessionId), async () => {
      // Fence publication before metadata is hidden or any S3 bytes are removed.
      // An in-flight put can then only leave a durable orphan intent for the
      // reconciler; it cannot become a newly visible attachment after cleanup.
      await this.metadata.beginSessionDeletion(sessionId)
      const state = await this.state(sessionId)
      await this.deleteRecords(sessionId, [...state.records.values()], true)
    })
  }

  /** Single-Runtime ordering; multi-replica deletion still needs a PG-transaction fence. */
  private async serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.sessionTails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    this.sessionTails.set(sessionId, next)
    await prior
    try { return await operation() } finally {
      release()
      if (this.sessionTails.get(sessionId) === next) this.sessionTails.delete(sessionId)
    }
  }

  private resolved(record: AttachmentRecord): ResolvedMessageAttachment {
    return {
      ...publicRecord(record),
      path: `s3-object://${this.organizationId}/${record.objectKey}`,
      read: async () => {
        const data = Buffer.from(await this.objects.get(this.organizationId, record.objectKey))
        if (data.length !== record.bytes || createHash('sha256').update(data).digest('hex') !== record.sha256) {
          throw new Error(`Attachment "${record.name}" failed object integrity validation`)
        }
        return data
      },
    }
  }

  private async cleanupExpiredPending(sessionId: string): Promise<void> {
    const cutoff = Date.now() - PENDING_MESSAGE_ATTACHMENT_TTL_MS
    const records = [...(await this.state(sessionId)).records.values()].filter((record) => !record.committedAt && Date.parse(record.createdAt) <= cutoff)
    await this.deleteRecords(sessionId, records)
  }

  private async deleteRecords(sessionId: string, records: readonly AttachmentRecord[], allowDuringSessionDeletion = false): Promise<void> {
    let state = await this.state(sessionId)
    if (records.length > 0) {
      await this.metadata.append(sessionId, {
        idempotencyKey: `message-attachment-delete-request:${randomUUID()}`,
        eventType: 'message_attachment.delete_requested',
        payload: { kind: 'delete_requested', records: [...records] } satisfies AttachmentEvent,
        allowDuringSessionDeletion,
      })
      state = await this.state(sessionId)
    }
    const pending = [...state.pendingDeletes.values()]
    if (pending.length === 0) return
    for (const record of pending) await this.objects.delete(this.organizationId, record.objectKey)
    const objectKeys = pending.map((record) => record.objectKey).sort()
    await this.metadata.append(sessionId, {
      idempotencyKey: `message-attachment-delete-complete:${digest(objectKeys)}`,
      eventType: 'message_attachment.delete_completed',
      payload: { kind: 'delete_completed', objectKeys } satisfies AttachmentEvent,
      ...(this.capacity ? { capacity: { kind: 'release_committed' as const, objectKeys } } : {}),
      allowDuringSessionDeletion,
    })
  }

  private async compensateFailedUpload(reservation: ObjectCapacityReservation | undefined, intent: ObjectOrphanIntent | undefined): Promise<void> {
    if (!reservation || !this.capacity) return
    if (!intent) {
      await this.capacity.release(reservation)
      return
    }
    // An in-flight PG commit is invisible to a non-locking reservation read;
    // immediate S3 deletion could destroy an already-published attachment.
    // Keep the intent and conservative reservation for fenced reconciliation.
  }

  private async state(sessionId: string): Promise<AttachmentState> {
    return reduceEvents(await this.metadata.replay<AttachmentEvent>(sessionId))
  }
}

function reduceEvents(events: readonly ObjectMetadataEvent<AttachmentEvent>[]): AttachmentState {
  const state: AttachmentState = { records: new Map(), pendingDeletes: new Map() }
  for (const event of events) {
    if (!event.eventType.startsWith('message_attachment.')) continue
    const payload = event.payload
    if (payload.kind === 'registered') state.records.set(payload.record.attachmentId, payload.record)
    else if (payload.kind === 'committed') {
      for (const id of payload.attachmentIds) {
        const record = state.records.get(id)
        if (record) record.committedAt = payload.committedAt
      }
    } else if (payload.kind === 'delete_requested') {
      for (const record of payload.records) {
        state.records.delete(record.attachmentId)
        state.pendingDeletes.set(record.objectKey, record)
      }
    } else if (payload.kind === 'delete_completed') for (const key of payload.objectKeys) state.pendingDeletes.delete(key)
  }
  return state
}

function validateReference(state: AttachmentState, sessionId: string, file: ReferencedFileContent): AttachmentRecord {
  const record = state.records.get(file.source.attachmentId)
  if (!record || record.sessionId !== sessionId) throw new Error('Attachment is unavailable or does not belong to this Session')
  if (record.sha256 !== file.source.sha256 || record.bytes !== file.source.bytes || record.name !== file.name || record.mediaType !== file.mediaType) {
    throw new Error(`Attachment "${file.name}" reference metadata does not match Host storage`)
  }
  return record
}
function isHostReference(block: MessageContent): block is ReferencedFileContent { return block.type === 'file' && 'source' in block && block.source.kind === 'host_ref' }
function referencedAttachmentIds(content: readonly MessageContent[] | undefined): string[] { return (content ?? []).filter(isHostReference).map((block) => block.source.attachmentId) }
function referencedFile(record: AttachmentRecord): ReferencedFileContent { return { type: 'file', name: record.name, mediaType: record.mediaType, source: { kind: 'host_ref', attachmentId: record.attachmentId, sha256: record.sha256, bytes: record.bytes } } }
function publicRecord({ objectKey: _objectKey, ...record }: AttachmentRecord) { return record }
function normalizeSessionId(value: string): string { const id = value.trim(); if (!id || id.length > 200) throw new Error('Invalid attachment Session id'); return id }
function safeDisplayName(value: string): string { const name = value.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim() ?? ''; if (!name || name === '.' || name === '..' || name.length > 255) throw new Error('Invalid attachment file name'); return name }
function safeMediaType(value: string | undefined): string { const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream'; if (mediaType.length > 255 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mediaType)) throw new Error('Invalid attachment media type'); return mediaType }
function objectKey(sessionId: string, attachmentId: string): string { return `message-attachments/sessions/${createHash('sha256').update(sessionId).digest('hex')}/${attachmentId}` }
function digest(values: readonly string[]): string { return createHash('sha256').update(values.join('\n')).digest('hex') }
