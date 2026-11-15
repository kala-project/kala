import { KalaStateStore } from '../store/state-store.js'
import type { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import type { SettingsWriteOptions } from '../settings-concurrency.js'

export const DEFAULT_AZURE_SPEECH_ENDPOINT = 'https://japaneast.api.cognitive.microsoft.com/'
export const DEFAULT_SPEECH_MAX_MINUTES = 15
export const MAX_SPEECH_MAX_MINUTES = 120
export type SpeechTranscriptionMode = 'realtime' | 'after_recording'

export type AzureSpeechCredential = {
  apiKey: string
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
  realtimeMaxMinutes: number
  afterRecordingMaxMinutes: number
}

export type AzureSpeechCredentialStatus = {
  configured: boolean
  provider: 'azure'
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
  realtimeMaxMinutes: number
  afterRecordingMaxMinutes: number
  updatedAt?: string
}

export interface AzureSpeechCredentialStore {
  get(): Promise<AzureSpeechCredential | undefined> | AzureSpeechCredential | undefined
  status(): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  set(input: {
    endpoint: string
    apiKey?: string
    enabled: boolean
    mode: SpeechTranscriptionMode
    realtimeMaxMinutes?: number
    afterRecordingMaxMinutes?: number
  }, options?: SettingsWriteOptions): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  delete(options?: SettingsWriteOptions): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  configuration?(): Promise<{ revision: string; value: AzureSpeechCredentialStatus }> | { revision: string; value: AzureSpeechCredentialStatus }
}

export function normalizeAzureSpeechEndpoint(raw: string): { endpoint: string; region: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('endpoint must be a valid HTTPS Azure Speech regional endpoint')
  }
  const match = /^([a-z0-9-]+)\.api\.cognitive\.microsoft\.com$/u.exec(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('endpoint must match https://<region>.api.cognitive.microsoft.com/')
  }
  return { endpoint: `https://${url.hostname.toLowerCase()}/`, region: match[1]! }
}

export class PostgresAzureSpeechCredentialStore implements AzureSpeechCredentialStore {
  constructor(private readonly state: PostgresTenantStateStore) {}

  async status(): Promise<AzureSpeechCredentialStatus> {
    const record = await this.state.getCredential('azure_speech')
    return record ? statusFromRecord(record) : unconfiguredStatus()
  }

  async get(): Promise<AzureSpeechCredential | undefined> {
    const record = await this.state.getCredential('azure_speech')
    if (!record) return undefined
    const status = statusFromRecord(record)
    return {
      apiKey: record.secret,
      endpoint: status.endpoint,
      region: status.region,
      enabled: status.enabled,
      mode: status.mode,
      realtimeMaxMinutes: status.realtimeMaxMinutes,
      afterRecordingMaxMinutes: status.afterRecordingMaxMinutes,
    }
  }

  async configuration(): Promise<{ revision: string; value: AzureSpeechCredentialStatus }> {
    const snapshot = await this.state.credentialConfiguration('azure_speech')
    return { revision: snapshot.revision, value: snapshot.value ? statusFromRecord(snapshot.value) : unconfiguredStatus() }
  }

  async set(input: {
    endpoint: string
    apiKey?: string
    enabled: boolean
    mode: SpeechTranscriptionMode
    realtimeMaxMinutes?: number
    afterRecordingMaxMinutes?: number
  }, options: SettingsWriteOptions = {}): Promise<AzureSpeechCredentialStatus> {
    return this.state.withCredentialLock('azure_speech', async (transaction) => {
      const current = await this.state.getCredential('azure_speech', transaction)
      const next = speechCredentialUpdate(input, current)
      await this.state.setCredential('azure_speech', next.secret, next.metadata, next.status.updatedAt, transaction, options)
      return next.status
    })
  }

  async delete(options: SettingsWriteOptions = {}): Promise<AzureSpeechCredentialStatus> {
    await this.state.deleteCredential('azure_speech', undefined, options)
    return unconfiguredStatus()
  }
}

export class LocalAzureSpeechCredentialStore implements AzureSpeechCredentialStore {
  private readonly state: KalaStateStore

  constructor(directory: string | KalaStateStore, keyPath?: string) {
    this.state = typeof directory === 'string'
      ? new KalaStateStore(directory, {
          ...(keyPath ? { keyPath } : {}),
          legacyCredentialDirectory: directory,
        })
      : directory
  }

  async status(): Promise<AzureSpeechCredentialStatus> {
    const record = this.state.getCredential('azure_speech')
    return record ? statusFromRecord(record) : unconfiguredStatus()
  }

  async get(): Promise<AzureSpeechCredential | undefined> {
    const record = this.state.getCredential('azure_speech')
    if (!record) return undefined
    const status = statusFromRecord(record)
    return {
      apiKey: record.secret,
      endpoint: status.endpoint,
      region: status.region,
      enabled: status.enabled,
      mode: status.mode,
      realtimeMaxMinutes: status.realtimeMaxMinutes,
      afterRecordingMaxMinutes: status.afterRecordingMaxMinutes,
    }
  }

  async configuration(): Promise<{ revision: string; value: AzureSpeechCredentialStatus }> {
    const snapshot = this.state.credentialConfiguration('azure_speech')
    return { revision: snapshot.revision, value: snapshot.value ? statusFromRecord(snapshot.value) : unconfiguredStatus() }
  }

  async set(input: {
    endpoint: string
    apiKey?: string
    enabled: boolean
    mode: SpeechTranscriptionMode
    realtimeMaxMinutes?: number
    afterRecordingMaxMinutes?: number
  }, options: SettingsWriteOptions = {}): Promise<AzureSpeechCredentialStatus> {
    return this.state.maintenanceTransaction(() => {
      const next = speechCredentialUpdate(input, this.state.getCredential('azure_speech'))
      this.state.setCredential('azure_speech', next.secret, next.metadata, next.status.updatedAt, options)
      return next.status
    })
  }

  async delete(options: SettingsWriteOptions = {}): Promise<AzureSpeechCredentialStatus> {
    this.state.deleteCredential('azure_speech', options)
    return unconfiguredStatus()
  }
}

function speechCredentialUpdate(
  input: Parameters<AzureSpeechCredentialStore['set']>[0],
  current: { secret: string; metadata: Record<string, unknown>; updatedAt: string } | undefined,
): { secret: string; metadata: Record<string, unknown>; status: AzureSpeechCredentialStatus & { updatedAt: string } } {
  const { endpoint, region } = normalizeAzureSpeechEndpoint(input.endpoint)
  const existing = current ? statusFromRecord(current) : undefined
  const secret = input.apiKey ?? current?.secret
  if (!secret) throw new Error('an Azure Speech key is required')
  const realtimeMaxMinutes = input.realtimeMaxMinutes === undefined
    ? existing?.realtimeMaxMinutes ?? DEFAULT_SPEECH_MAX_MINUTES
    : validatedMaxMinutes('realtimeMaxMinutes', input.realtimeMaxMinutes)
  const afterRecordingMaxMinutes = input.afterRecordingMaxMinutes === undefined
    ? existing?.afterRecordingMaxMinutes ?? DEFAULT_SPEECH_MAX_MINUTES
    : validatedMaxMinutes('afterRecordingMaxMinutes', input.afterRecordingMaxMinutes)
  const status = {
    configured: true, provider: 'azure' as const, endpoint, region, enabled: input.enabled, mode: input.mode,
    realtimeMaxMinutes, afterRecordingMaxMinutes, updatedAt: new Date().toISOString(),
  }
  const { configured: _configured, updatedAt: _updatedAt, ...metadata } = status
  return { secret, metadata: { version: 1, ...metadata }, status }
}

function statusFromRecord(record: { metadata: Record<string, unknown>; updatedAt: string }): AzureSpeechCredentialStatus {
  const endpoint = typeof record.metadata.endpoint === 'string' ? record.metadata.endpoint : DEFAULT_AZURE_SPEECH_ENDPOINT
  const normalized = normalizeAzureSpeechEndpoint(endpoint)
  return {
    configured: true,
    provider: 'azure',
    endpoint: normalized.endpoint,
    region: typeof record.metadata.region === 'string' ? record.metadata.region : normalized.region,
    enabled: record.metadata.enabled === true,
    mode: record.metadata.mode === 'after_recording' ? 'after_recording' : 'realtime',
    realtimeMaxMinutes: storedMaxMinutes(record.metadata.realtimeMaxMinutes),
    afterRecordingMaxMinutes: storedMaxMinutes(record.metadata.afterRecordingMaxMinutes),
    updatedAt: record.updatedAt,
  }
}

function unconfiguredStatus(): AzureSpeechCredentialStatus {
  const { endpoint, region } = normalizeAzureSpeechEndpoint(DEFAULT_AZURE_SPEECH_ENDPOINT)
  return {
    configured: false,
    provider: 'azure',
    endpoint,
    region,
    enabled: false,
    mode: 'realtime',
    realtimeMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
    afterRecordingMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
  }
}

function storedMaxMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SPEECH_MAX_MINUTES
    ? value
    : DEFAULT_SPEECH_MAX_MINUTES
}

function validatedMaxMinutes(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SPEECH_MAX_MINUTES) {
    throw new Error(`${field} must be an integer between 1 and ${MAX_SPEECH_MAX_MINUTES}`)
  }
  return value
}
