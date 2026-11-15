import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { KalaStateStore } from '../store/state-store.js'
import {
  DEFAULT_AZURE_SPEECH_ENDPOINT,
  DEFAULT_SPEECH_MAX_MINUTES,
  LocalAzureSpeechCredentialStore,
  normalizeAzureSpeechEndpoint,
} from './credential-store.js'

const roots: string[] = []
const TEST_KEY = 'azure-speech-test-key-value'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LocalAzureSpeechCredentialStore', () => {
  it('encrypts the key, preserves endpoint settings, and never exposes the key in status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azure-speech-credentials-'))
    roots.push(root)
    const store = new LocalAzureSpeechCredentialStore(root)

    expect(await store.status()).toEqual({
      configured: false,
      provider: 'azure',
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
      enabled: false,
      mode: 'realtime',
      realtimeMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
      afterRecordingMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
    })
    const status = await store.set({
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      apiKey: TEST_KEY,
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 4,
      afterRecordingMaxMinutes: 22,
    })
    expect(status).toMatchObject({
      configured: true,
      provider: 'azure',
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 4,
      afterRecordingMaxMinutes: 22,
    })
    expect(JSON.stringify(status)).not.toContain(TEST_KEY)
    expect(await store.get()).toEqual({
      apiKey: TEST_KEY,
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 4,
      afterRecordingMaxMinutes: 22,
    })
    expect(await readFile(join(root, 'state.sqlite'))).not.toContain(TEST_KEY)
    expect((await stat(join(root, 'state-store.key'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'state.sqlite'))).mode & 0o777).toBe(0o600)

    await store.set({ endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT, enabled: false, mode: 'realtime' })
    expect((await store.get())?.apiKey).toBe(TEST_KEY)
    expect(await store.status()).toMatchObject({ enabled: false, realtimeMaxMinutes: 4, afterRecordingMaxMinutes: 22 })
    await expect(store.set({
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      enabled: false,
      mode: 'realtime',
      realtimeMaxMinutes: 121,
    })).rejects.toThrow('realtimeMaxMinutes must be an integer between 1 and 120')
    expect(await store.delete()).toMatchObject({
      configured: false,
      enabled: false,
      realtimeMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
      afterRecordingMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
    })
  })

  it('returns defaults for legacy persisted configuration without duration fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azure-speech-legacy-'))
    roots.push(root)
    const state = new KalaStateStore(root)
    state.setCredential('azure_speech', TEST_KEY, {
      version: 1,
      provider: 'azure',
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
      enabled: true,
      mode: 'realtime',
    })

    const store = new LocalAzureSpeechCredentialStore(state)
    expect(await store.status()).toMatchObject({
      configured: true,
      realtimeMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
      afterRecordingMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
    })
    expect(await store.get()).toMatchObject({
      realtimeMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
      afterRecordingMaxMinutes: DEFAULT_SPEECH_MAX_MINUTES,
    })
  })

  it('accepts only regional Azure Cognitive Services HTTPS endpoints', () => {
    expect(normalizeAzureSpeechEndpoint('https://JapanEast.api.cognitive.microsoft.com')).toEqual({
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
    })
    for (const endpoint of [
      'http://japaneast.api.cognitive.microsoft.com/',
      'https://localhost/',
      'https://japaneast.api.cognitive.microsoft.com/path',
      'https://example.com/',
    ]) {
      expect(() => normalizeAzureSpeechEndpoint(endpoint)).toThrow()
    }
  })

  it('rejects stale partial edits before changing key or metadata and preserves the key on a conditional update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azure-speech-cas-'))
    roots.push(root)
    const first = new LocalAzureSpeechCredentialStore(root)
    const second = new LocalAzureSpeechCredentialStore(root)
    const input = { endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT, enabled: true, mode: 'realtime' as const }
    expect((await first.configuration()).revision).toBe('1')
    await first.set({ ...input, apiKey: TEST_KEY, realtimeMaxMinutes: 7 }, { expectedRevision: '1' })
    await expect(second.set({ ...input, apiKey: 'stale-key' }, { expectedRevision: '1' })).rejects.toThrow('configuration_conflict')
    expect(await first.get()).toMatchObject({ apiKey: TEST_KEY, realtimeMaxMinutes: 7 })
    await second.set({ ...input, enabled: false }, { expectedRevision: '2' })
    expect(await first.get()).toMatchObject({ apiKey: TEST_KEY, enabled: false, realtimeMaxMinutes: 7 })
    expect((await second.configuration()).revision).toBe('3')
    expect(JSON.stringify(await second.configuration())).not.toContain(TEST_KEY)
  })
})
