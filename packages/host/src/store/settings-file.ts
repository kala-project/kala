import { randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { checkSettingsPrecondition, nextSettingsRevision, settingsRevision, type SettingsWriteOptions } from '../settings-concurrency.js'
import { KalaStateStore } from './state-store.js'

type Metadata = { formatVersion: 1; revision: string; contentHmac: string }
type Resource = { kind: 'models' | 'agent'; id: string }
export type SettingsFileSnapshot<T> = { revision: string; value: T | undefined }

export class SettingsFile<T extends Record<string, unknown>> {
  constructor(
    readonly path: string,
    private readonly state: KalaStateStore,
    private readonly resource: Resource,
    private readonly validate: (input: unknown) => T,
  ) {}

  read(): SettingsFileSnapshot<T> {
    return this.state.maintenanceTransaction(() => this.readLocked())
  }

  update(
    change: (current: T | undefined) => T,
    options: SettingsWriteOptions = {},
  ): SettingsFileSnapshot<T> {
    let persisted = false
    try {
      return this.state.maintenanceTransaction(() => {
        const current = this.readLocked()
        if (!this.state.settingsRevisionsAvailable()) {
          this.state.requireLegacySettingsWrite(options)
          const value = this.validate(change(current.value))
          atomicPrivateSettingsFile(this.path, `${JSON.stringify(value, null, 2)}\n`)
          return { revision: '1', value }
        }
        checkSettingsPrecondition(current.revision, options)
        const value = this.validate(change(current.value))
        const revision = nextSettingsRevision(current.revision)
        this.replace(value, revision)
        persisted = true
        this.state.recordSettingsRevision(this.resource, revision)
        return { revision, value }
      })
    } catch (error) {
      if (persisted) throw Object.assign(new Error('settings_file_saved_pending_reconciliation', { cause: error }), { status: 503, settingsSaved: true })
      throw error
    }
  }

  import(value: unknown): SettingsFileSnapshot<T> {
    if (!this.state.settingsRevisionsAvailable()) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
    const validated = this.validate(value)
    return this.state.maintenanceTransaction(() => {
      const highWater = this.state.settingsHighWater(this.resource)
      let fileRevision: string | undefined
      try { fileRevision = this.readLocked().revision } catch (error) {
        const raw = readRegularFile(this.path)
        let migrated = false
        try { migrated = raw !== undefined && Object.hasOwn(JSON.parse(raw), '_kalaSettings') } catch { /* Invalid unmanaged input can only be repaired through this explicit import. */ }
        if (highWater || migrated) this.state.settingsContentHmac('', false)
      }
      const revision = nextSettingsRevision(
        highWater && (!fileRevision || BigInt(highWater) > BigInt(fileRevision)) ? highWater : fileRevision ?? '1',
      )
      this.replace(validated, revision)
      this.state.recordSettingsRevision(this.resource, revision)
      return { revision, value: validated }
    })
  }

  private readLocked(): SettingsFileSnapshot<T> {
    const revisioned = this.state.settingsRevisionsAvailable()
    const highWater = this.state.settingsHighWater(this.resource)
    const raw = readRegularFile(this.path)
    if (raw === undefined) {
      if (highWater) throw new Error('settings_file_missing_after_migration')
      return { revision: '1', value: undefined }
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_settings_file')
    const { _kalaSettings, ...content } = parsed as Record<string, unknown>
    const value = this.validate(content)
    if (!revisioned) {
      if (_kalaSettings !== undefined) throw new Error('settings_metadata_requires_expanded_schema')
      return { revision: '1', value }
    }
    if (_kalaSettings === undefined) {
      if (highWater) throw new Error('settings_metadata_missing_after_migration')
      this.replace(value, '1')
      this.state.recordSettingsRevision(this.resource, '1')
      return { revision: '1', value }
    }
    const metadata = parseMetadata(_kalaSettings)
    const expected = this.contentHmac(content, metadata.revision, false)
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(metadata.contentHmac, 'hex'))) {
      throw new Error('settings_content_integrity_failed')
    }
    if (highWater && BigInt(metadata.revision) < BigInt(highWater)) throw new Error('settings_revision_rollback_detected')
    if (highWater !== metadata.revision) this.state.recordSettingsRevision(this.resource, metadata.revision)
    return { revision: metadata.revision, value }
  }

  private contentHmac(value: Record<string, unknown>, revision: string, create: boolean): string {
    return this.state.settingsContentHmac(canonicalSettingsJson({ resource: this.resource, revision, value }), create)
  }

  private replace(value: T, revision: string): void {
    const metadata: Metadata = { formatVersion: 1, revision, contentHmac: this.contentHmac(value, revision, true) }
    atomicPrivateSettingsFile(this.path, `${JSON.stringify({ ...value, _kalaSettings: metadata }, null, 2)}\n`)
  }
}

export function canonicalSettingsJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('settings_content_not_json')
    return serialized
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSettingsJson).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(
    ([key, entry]) => `${JSON.stringify(key)}:${canonicalSettingsJson(entry)}`,
  ).join(',')}}`
}

function parseMetadata(value: unknown): Metadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_settings_metadata')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'contentHmac,formatVersion,revision' ||
    record.formatVersion !== 1 || typeof record.revision !== 'string' ||
    typeof record.contentHmac !== 'string' || !/^[a-f0-9]{64}$/u.test(record.contentHmac)) {
    throw new Error('invalid_settings_metadata')
  }
  settingsRevision(record.revision)
  return record as Metadata
}

function readRegularFile(path: string): string | undefined {
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('settings_file_must_be_regular')
    return readFileSync(descriptor, 'utf8')
  } finally { closeSync(descriptor) }
}

export function atomicPrivateSettingsFile(path: string, value: string): void {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  readRegularFile(absolute)
  const candidate = `${absolute}.${randomUUID()}.pending`
  const descriptor = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let renamed = false
  try {
    writeFileSync(descriptor, value, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    renameSync(candidate, absolute)
    renamed = true
    if (process.platform !== 'win32') {
      const directory = openSync(parent, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally {
    if (!renamed) {
      try { closeSync(descriptor) } catch { /* The descriptor may already be closed before rename failed. */ }
      unlinkSync(candidate)
    }
  }
}
