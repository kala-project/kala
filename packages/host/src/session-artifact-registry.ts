import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export type SessionArtifactRecord = { artifactId: string; sessionId: string; title: string; mediaType: string; bytes: number; sha256: string; fileName: string; createdAt: string }
export type ResolvedSessionArtifact = SessionArtifactRecord & { read(): Promise<Buffer> }
export type SessionArtifactStorage = {
  load(): Promise<void>
  registerImage(input: { sessionId: string; title?: string; fileName: string; data: Buffer }): Promise<SessionArtifactRecord>
  get(sessionId: string, artifactId: string): ResolvedSessionArtifact | undefined | Promise<ResolvedSessionArtifact | undefined>
  deleteSession(sessionId: string): Promise<void>
}
type RegistryFile = { schemaVersion: 1; records: SessionArtifactRecord[] }

export class SessionArtifactRegistry implements SessionArtifactStorage {
  private readonly records = new Map<string, SessionArtifactRecord>()
  private tail = Promise.resolve()
  constructor(private readonly rootDir: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as RegistryFile
      if (parsed.schemaVersion === 1) for (const record of parsed.records) this.records.set(record.artifactId, record)
    } catch {}
  }

  async registerImage(input: { sessionId: string; title?: string; fileName: string; data: Buffer }): Promise<SessionArtifactRecord> {
    const mediaType = detectImageMime(input.data, input.fileName)
    if (!mediaType) throw new Error('unsupported image type')
    if (input.data.length === 0 || input.data.length > MAX_IMAGE_BYTES) throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`)
    const artifactId = randomUUID()
    const extension = extensionForMime(mediaType)
    const fileName = `${artifactId}${extension}`
    const path = join(this.rootDir, 'content', fileName)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(input.data); await file.sync() } finally { await file.close() }
    const record: SessionArtifactRecord = {
      artifactId, sessionId: input.sessionId, title: input.title?.trim() || basename(input.fileName), mediaType,
      bytes: input.data.length, sha256: createHash('sha256').update(input.data).digest('hex'), fileName, createdAt: new Date().toISOString(),
    }
    this.records.set(artifactId, record)
    await this.persist()
    return record
  }

  get(artifactId: string): SessionArtifactRecord | undefined
  get(sessionId: string, artifactId: string): ResolvedSessionArtifact | undefined
  get(sessionIdOrArtifactId: string, artifactId?: string): SessionArtifactRecord | ResolvedSessionArtifact | undefined {
    if (artifactId === undefined) return this.records.get(sessionIdOrArtifactId)
    const record = this.records.get(artifactId)
    if (!record || record.sessionId !== sessionIdOrArtifactId) return undefined
    return {
      ...record,
      read: async () => {
        const data = await readFile(this.contentPath(record))
        if (data.length !== record.bytes || createHash('sha256').update(data).digest('hex') !== record.sha256) {
          throw new Error(`Artifact "${record.title}" failed Host integrity validation`)
        }
        return data
      },
    }
  }
  contentPath(record: SessionArtifactRecord): string { return join(this.rootDir, 'content', record.fileName) }
  async deleteSession(sessionId: string): Promise<void> {
    const removed = [...this.records.values()].filter((record) => record.sessionId === sessionId)
    if (removed.length === 0) return
    for (const record of removed) this.records.delete(record.artifactId)
    await Promise.all(removed.map(async (record) => await rm(this.contentPath(record), { force: true })))
    await this.persist()
  }

  private get registryPath(): string { return join(this.rootDir, 'registry.json') }
  private persist(): Promise<void> {
    this.tail = this.tail.then(async () => {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
      const temp = `${this.registryPath}.tmp-${process.pid}`
      const file = await open(temp, 'w', 0o600)
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] }, null, 2)); await file.sync() } finally { await file.close() }
      await rename(temp, this.registryPath)
    })
    return this.tail
  }
}

export function detectImageMime(data: Buffer, fileName: string): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (extname(fileName).toLowerCase() === '.svg' && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(data.subarray(0, 64 * 1024).toString('utf8'))) return 'image/svg+xml'
  return undefined
}
export function extensionForMime(mime: string): string { return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : mime === 'image/svg+xml' ? '.svg' : '.png' }
