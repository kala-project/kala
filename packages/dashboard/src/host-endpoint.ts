import { PREF_HOST_ENDPOINT, writeDashboardPreference } from './lib/prefs.js'
import { isDesktopClient } from './lib/desktop.js'

const STORAGE_KEY = PREF_HOST_ENDPOINT

export type HostEndpointSource = 'query' | 'settings' | 'build' | 'default'

export interface ResolvedHostEndpoint {
  url: string
  source: HostEndpointSource
}

function normalize(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  return trimmed
}

export function resolveHostEndpoint(): ResolvedHostEndpoint {
  if (typeof window === 'undefined') {
    return { url: '', source: 'default' }
  }
  if (isDesktopClient()) return { url: window.location.origin, source: 'default' }
  const query = new URLSearchParams(window.location.search).get('host')
  if (query) return { url: normalize(query), source: 'query' }
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY)
    if (stored) return { url: normalize(stored), source: 'settings' }
  } catch {}
  const buildTime = (import.meta.env?.VITE_KALA_HOST as string | undefined)?.trim()
  if (buildTime) return { url: normalize(buildTime), source: 'build' }
  return { url: window.location.origin, source: 'default' }
}

export function getStoredHostEndpoint(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function setStoredHostEndpoint(url: string | null): boolean {
  if (typeof window === 'undefined') return false
  if (!writeDashboardPreference(STORAGE_KEY, url === null || url.trim() === '' ? null : normalize(url))) return false
  window.dispatchEvent(new CustomEvent('agent-kernel:host-endpoint-changed'))
  return true
}
