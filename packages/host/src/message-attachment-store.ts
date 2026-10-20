import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { MessageContent, ReferencedFileContent } from '@agent-kernel/kernel'

export const MAX_MESSAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024
export const MAX_SESSION_ATTACHMENT_BYTES = 64 * 1024 * 1024
export const MAX_SESSION_ATTACHMENTS = 256
export const MAX_ATTACHMENT_STORE_BYTES = 512 * 1024 * 1024
export const PENDING_MESSAGE_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000

type AttachmentRecord = {
  attachmentId: string
  sessionId: string
  name: string
  mediaType: string
  bytes: number
  sha256: string
  createdAt: string
  committedAt?: string
}

type RegistryFile = {
  schemaVersion: 1
  records: AttachmentRecord[]
}

export type ResolvedMessageAttachment = AttachmentRecord & {
  path: string
  read(): Promise<Buffer>
}

export type MessageAttachmentStorage = {
  load(): Promise<void>
  register(input: { sessionId: string; name: string; mediaType?: string; data: Buffer }): Promise<ReferencedFileContent>
  commitReferences(sessionId: string, content: readonly MessageContent[] | undefined): Promise<void>
  releasePending(sessionId: string, attachmentIds: readonly string[]): Promise<void>
  resolve(sessionId: string, file: ReferencedFileContent): ResolvedMessageAttachment | Promise<ResolvedMessageAttachment>
  resolveById(sessionId: string, attachmentId: string): ResolvedMessageAttachment | Promise<ResolvedMessageAttachment>
  sdkFilePath(sessionId: string, file: ReferencedFileContent): Promise<string | undefined>
  allowsSdkRead(sessionId: string, requestedPath: string): boolean
  deleteSession(sessionId: string): Promise<void>
}

export class MessageAttachmentStore implements MessageAttachmentStorage {
  private readonly records = new Map<string, AttachmentRecord>()
  private tail = Promise.resolve()

  constructor(private readonly rootDir: string) {}

  async load(): Promise<void> {
    await this.transact(async () => {
      await this.cleanupExpiredPendingUnsafe()
    })
  }

  private async reloadUnsafe(): Promise<void> {
    let parsed: RegistryFile
    try {
      parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as RegistryFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records.clear()
        return
      }
      throw new Error(`Unable to load message attachment registry: ${error instanceof Error ? error.message : String(error)}`)
    }
    replaceRecords(this.records, parsed)
  }

  async register(input: {
    sessionId: string
    name: string
    mediaType?: string
    data: Buffer
  }): Promise<ReferencedFileContent> {
    return await this.transact(async () => {
      await this.cleanupExpiredPendingUnsafe()
      const sessionId = normalizeSessionId(input.sessionId)
      const name = safeDisplayName(input.name)
      const mediaType = safeMediaType(input.mediaType)
      if (input.data.length < 1 || input.data.length > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new Error(`Attachment must be between 1 byte and ${MAX_MESSAGE_ATTACHMENT_BYTES} bytes`)
      }
      const sha256 = createHash('sha256').update(input.data).digest('hex')
      const duplicate = [...this.records.values()].find((record) =>
        record.sessionId === sessionId
        && record.sha256 === sha256
        && record.name === name
        && record.mediaType === mediaType
        && Boolean(record.committedAt),
      )
      if (duplicate) return referencedFile(duplicate)

      const sessionRecords = [...this.records.values()].filter((record) => record.sessionId === sessionId)
      if (sessionRecords.length >= MAX_SESSION_ATTACHMENTS) throw new Error(`Session attachment limit of ${MAX_SESSION_ATTACHMENTS} files exceeded`)
      if (sessionRecords.reduce((total, record) => total + record.bytes, 0) + input.data.length > MAX_SESSION_ATTACHMENT_BYTES) {
        throw new Error(`Session attachment storage limit of ${MAX_SESSION_ATTACHMENT_BYTES} bytes exceeded`)
      }

      const contentAlreadyStored = [...this.records.values()].some((record) => record.sha256 === sha256)
      const physicalBytes = new Map([...this.records.values()].map((record) => [record.sha256, record.bytes]))
      if (!contentAlreadyStored && [...physicalBytes.values()].reduce((total, bytes) => total + bytes, 0) + input.data.length > MAX_ATTACHMENT_STORE_BYTES) {
        throw new Error(`Host attachment storage limit of ${MAX_ATTACHMENT_STORE_BYTES} bytes exceeded`)
      }

      const path = this.pathForHash(sha256)
      if (!contentAlreadyStored) await writeExclusive(path, input.data, sha256)
      const record: AttachmentRecord = {
        attachmentId: randomUUID(),
        sessionId,
        name,
        mediaType,
        bytes: input.data.length,
        sha256,
        createdAt: new Date().toISOString(),
      }
      this.records.set(record.attachmentId, record)
      try {
        await this.persist()
      } catch (error) {
        this.records.delete(record.attachmentId)
        if (!contentAlreadyStored) await rm(path, { force: true })
        throw error
      }
      return referencedFile(record)
    })
  }

  async commitReferences(sessionId: string, content: readonly MessageContent[] | undefined): Promise<void> {
    const attachmentIds = referencedAttachmentIds(content)
    if (attachmentIds.length === 0) return
    await this.transact(async () => {
      for (const block of content ?? []) {
        if (block.type === 'file' && 'source' in block && block.source.kind === 'host_ref') {
          this.resolve(sessionId, block)
        }
      }
      const committedAt = new Date().toISOString()
      const changed: AttachmentRecord[] = []
      for (const attachmentId of attachmentIds) {
        const record = this.records.get(attachmentId)
        if (!record || record.sessionId !== sessionId) throw new Error('Attachment reference does not belong to this Session')
        if (!record.committedAt) {
          record.committedAt = committedAt
          changed.push(record)
        }
      }
      if (changed.length === 0) return
      try {
        await this.persist()
      } catch (error) {
        for (const record of changed) delete record.committedAt
        throw error
      }
    })
  }

  async releasePending(sessionId: string, attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return
    await this.transact(async () => {
      const removedHashes = new Set<string>()
      let changed = false
      for (const attachmentId of attachmentIds) {
        const record = this.records.get(attachmentId)
        if (!record || record.sessionId !== sessionId || record.committedAt) continue
        this.records.delete(attachmentId)
        removedHashes.add(record.sha256)
        changed = true
      }
      if (!changed) return
      await this.persist()
      await this.deleteUnreferencedContent(removedHashes)
    })
  }

  resolve(sessionId: string, file: ReferencedFileContent): ResolvedMessageAttachment {
    const resolved = this.resolveById(sessionId, file.source.attachmentId)
    if (
      resolved.sha256 !== file.source.sha256
      || resolved.bytes !== file.source.bytes
      || resolved.name !== file.name
      || resolved.mediaType !== file.mediaType
    ) {
      throw new Error(`Attachment "${file.name}" reference metadata does not match Host storage`)
    }
    return resolved
  }

  resolveById(sessionId: string, attachmentId: string): ResolvedMessageAttachment {
    this.reloadSyncUnsafe()
    const record = this.records.get(attachmentId)
    if (!record || record.sessionId !== sessionId) {
      throw new Error('Attachment is unavailable or does not belong to this Session')
    }
    const path = this.pathForHash(record.sha256)
    return {
      ...record,
      path,
      read: async () => {
        const data = await readFile(path).catch((error) => {
          throw new Error(`Attachment "${record.name}" bytes are unavailable: ${error instanceof Error ? error.message : String(error)}`)
        })
        if (data.length !== record.bytes || createHash('sha256').update(data).digest('hex') !== record.sha256) {
          throw new Error(`Attachment "${record.name}" failed Host integrity validation`)
        }
        return data
      },
    }
  }

  async sdkFilePath(sessionId: string, file: ReferencedFileContent): Promise<string | undefined> {
    const resolved = this.resolve(sessionId, file)
    if (!isAbsolute(resolved.path)) return undefined
    const info = await stat(resolved.path).catch(() => undefined)
    if (!info?.isFile() || info.size !== resolved.bytes) return undefined
    return resolved.path
  }

  allowsSdkRead(sessionId: string, requestedPath: string): boolean {
    if (!isAbsolute(requestedPath)) return false
    const candidate = resolve(requestedPath)
    return [...this.records.values()].some((record) =>
      record.sessionId === sessionId && this.pathForHash(record.sha256) === candidate)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.transact(async () => {
      const removed = [...this.records.values()].filter((record) => record.sessionId === sessionId)
      if (removed.length === 0) return
      for (const record of removed) this.records.delete(record.attachmentId)
      const retainedHashes = new Set([...this.records.values()].map((record) => record.sha256))
      try {
        await this.persist()
      } catch (error) {
        for (const record of removed) this.records.set(record.attachmentId, record)
        throw error
      }
      await Promise.all([...new Set(removed.map((record) => record.sha256))]
        .filter((sha256) => !retainedHashes.has(sha256))
        .map(async (sha256) => await rm(this.pathForHash(sha256), { force: true })))
    })
  }

  private pathForHash(sha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid attachment content hash')
    const root = resolve(this.rootDir, 'content')
    const path = resolve(root, sha256.slice(0, 2), sha256)
    if (!isContainedAttachmentPath(root, path)) throw new Error('Invalid attachment content path')
    return path
  }

  private async cleanupExpiredPendingUnsafe(): Promise<void> {
    const cutoff = Date.now() - PENDING_MESSAGE_ATTACHMENT_TTL_MS
    const removedHashes = new Set<string>()
    let changed = false
    for (const [attachmentId, record] of this.records) {
      if (record.committedAt || Date.parse(record.createdAt) > cutoff) continue
      this.records.delete(attachmentId)
      removedHashes.add(record.sha256)
      changed = true
    }
    if (!changed) return
    await this.persist()
    await this.deleteUnreferencedContent(removedHashes)
  }

  private async deleteUnreferencedContent(hashes: ReadonlySet<string>): Promise<void> {
    for (const hash of hashes) {
      if ([...this.records.values()].some((record) => record.sha256 === hash)) continue
      await rm(this.pathForHash(hash), { force: true })
    }
  }

  private get registryPath(): string {
    return join(this.rootDir, 'registry.json')
  }

  private get registryLockPath(): string {
    return join(this.rootDir, 'registry.lock')
  }

  private async persist(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const temporary = `${this.registryPath}.tmp-${process.pid}-${randomUUID()}`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] }, null, 2))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, this.registryPath)
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return await result
  }

  private async transact<T>(operation: () => Promise<T>): Promise<T> {
    return await this.serialize(async () => await this.withRegistryLock(async () => {
      await this.reloadUnsafe()
      return await operation()
    }))
  }

  private async withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const deadline = Date.now() + 30_000
    while (true) {
      const lock = await open(this.registryLockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return undefined
        throw error
      })
      if (lock) {
        try {
          await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
          await lock.sync()
          return await operation()
        } finally {
          await lock.close()
          await rm(this.registryLockPath, { force: true })
        }
      }
      if (await staleRegistryLock(this.registryLockPath)) {
        await rm(this.registryLockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Host attachment registry lock')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  private reloadSyncUnsafe(): void {
    let parsed: RegistryFile
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, 'utf8')) as RegistryFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`Unable to refresh message attachment registry: ${error instanceof Error ? error.message : String(error)}`)
    }
    replaceRecords(this.records, parsed)
  }
}

export function isContainedAttachmentPath(
  root: string,
  candidate: string,
  pathApi: { relative(from: string, to: string): string; isAbsolute(path: string): boolean; sep: string } = { relative, isAbsolute, sep },
): boolean {
  const relativePath = pathApi.relative(root, candidate)
  return relativePath !== '..'
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath)
}

function referencedFile(record: AttachmentRecord): ReferencedFileContent {
  return {
    type: 'file',
    name: record.name,
    mediaType: record.mediaType,
    source: {
      kind: 'host_ref',
      attachmentId: record.attachmentId,
      sha256: record.sha256,
      bytes: record.bytes,
    },
  }
}

function normalizeSessionId(value: string): string {
  const sessionId = value.trim()
  if (!sessionId || sessionId.length > 200) throw new Error('Invalid attachment Session id')
  return sessionId
}

function safeDisplayName(value: string): string {
  const name = value.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim() ?? ''
  if (!name || name === '.' || name === '..' || name.length > 255) throw new Error('Invalid attachment file name')
  return name
}

function safeMediaType(value: string | undefined): string {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream'
  if (mediaType.length > 255 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mediaType)) {
    throw new Error('Invalid attachment media type')
  }
  return mediaType
}

function validRecord(value: unknown): value is AttachmentRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<AttachmentRecord>
  try {
    return typeof record.attachmentId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.attachmentId)
      && typeof record.sessionId === 'string'
      && record.sessionId.length > 0
      && record.sessionId.length <= 200
      && typeof record.name === 'string'
      && record.name === safeDisplayName(record.name)
      && typeof record.mediaType === 'string'
      && record.mediaType === safeMediaType(record.mediaType)
      && Number.isSafeInteger(record.bytes)
      && (record.bytes ?? 0) > 0
      && (record.bytes ?? 0) <= MAX_MESSAGE_ATTACHMENT_BYTES
      && typeof record.sha256 === 'string'
      && /^[a-f0-9]{64}$/u.test(record.sha256)
      && typeof record.createdAt === 'string'
      && Number.isFinite(Date.parse(record.createdAt))
      && (record.committedAt === undefined || (typeof record.committedAt === 'string' && Number.isFinite(Date.parse(record.committedAt))))
  } catch {
    return false
  }
}

function replaceRecords(target: Map<string, AttachmentRecord>, parsed: RegistryFile): void {
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new Error('Invalid message attachment registry')
  const next = new Map<string, AttachmentRecord>()
  for (const record of parsed.records) {
    if (!validRecord(record)) throw new Error('Invalid message attachment registry record')
    next.set(record.attachmentId, record)
  }
  target.clear()
  for (const [attachmentId, record] of next) target.set(attachmentId, record)
}

async function staleRegistryLock(path: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; createdAt?: unknown }
    if (typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) && raw.pid > 0) {
      try {
        process.kill(raw.pid, 0)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      }
    }
    return typeof raw.createdAt !== 'string' || Date.now() - Date.parse(raw.createdAt) > 30_000
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    const info = await stat(path).catch(() => undefined)
    return Boolean(info && Date.now() - info.mtimeMs > 30_000)
  }
}

function referencedAttachmentIds(content: readonly MessageContent[] | undefined): string[] {
  return [...new Set((content ?? []).flatMap((block) =>
    block.type === 'file' && 'source' in block && block.source.kind === 'host_ref'
      ? [block.source.attachmentId]
      : []))]
}

async function writeExclusive(path: string, data: Buffer, sha256: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return undefined
    throw error
  })
  if (!file) {
    const existing = await readFile(path)
    if (existing.length !== data.length || createHash('sha256').update(existing).digest('hex') !== sha256) {
      throw new Error('Host attachment content-addressed file failed integrity validation')
    }
    return
  }
  try {
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
}
