import { responseError } from '../settings/section-utils.js'

export const DEFAULT_AZURE_SPEECH_ENDPOINT = 'https://japaneast.api.cognitive.microsoft.com/'
export const SPEECH_SETTINGS_CHANGED_EVENT = 'ak:speech-settings-changed'
export const DEFAULT_SPEECH_MAX_MINUTES = 15
export const MAX_SPEECH_MAX_MINUTES = 120
export function speechMaxMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SPEECH_MAX_MINUTES
    ? value : DEFAULT_SPEECH_MAX_MINUTES
}
export type SpeechTranscriptionMode = 'realtime' | 'after_recording'

export type SpeechSettings = {
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

export type SpeechToken = {
  token: string
  endpoint: string
  region: string
  expiresInSeconds: number
}

export async function loadSpeechSettings(request: (path: string, init?: RequestInit) => Promise<Response> = fetch): Promise<SpeechSettings> {
  const response = await request('/settings/speech', { cache: 'no-store' })
  if (!response.ok) throw new Error(await responseError(response))
  const settings = await response.json() as Omit<SpeechSettings, 'mode' | 'realtimeMaxMinutes' | 'afterRecordingMaxMinutes'> & { mode?: unknown; realtimeMaxMinutes?: unknown; afterRecordingMaxMinutes?: unknown }
  return {
    ...settings,
    mode: settings.mode === 'after_recording' ? 'after_recording' : 'realtime',
    realtimeMaxMinutes: speechMaxMinutes(settings.realtimeMaxMinutes),
    afterRecordingMaxMinutes: speechMaxMinutes(settings.afterRecordingMaxMinutes),
  }
}

export async function requestSpeechToken(): Promise<SpeechToken> {
  const response = await fetch('/runtime/speech/token', { method: 'POST', cache: 'no-store' })
  if (!response.ok) throw new Error(await responseError(response))
  return (await response.json()) as SpeechToken
}

export async function transcribeSpeechRecording(recording: Blob): Promise<string> {
  const response = await fetch('/runtime/speech/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': recording.type || 'audio/webm' },
    body: recording,
  })
  if (!response.ok) throw new Error(await responseError(response))
  const result = await response.json() as { text?: unknown }
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Voice transcription returned no text')
  return result.text.trim()
}
