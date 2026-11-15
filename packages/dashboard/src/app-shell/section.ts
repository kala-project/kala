/**
 * Top-level nav for the dashboard. URL-hash routing.
 *
 * Deep-link contract (per principle C4):
 * - `#/agent`, `#/operations`, `#/artifacts`, `#/pipeline`, `#/docs`
 * - default (empty hash) resolves to `#/agent`
 * - back/forward and refresh restore the same section
 *
 * Phase-1 scope: the tab bar is a router only. Agent stays in the current
 * layout; the other four tabs open the existing surfaces (ArtifactExplorer
 * modes, PipelineGuideDialog) as a bridge. Phase-2 replaces them with real
 * pages. Settings is not a tab — it lives as an icon on the right of the nav.
 */

import { useEffect, useState } from 'react'

export type AppSection = 'agent' | 'operations' | 'artifacts' | 'pipeline' | 'docs' | 'memo' | 'settings'

const SECTIONS: readonly AppSection[] = ['agent', 'operations', 'artifacts', 'pipeline', 'docs', 'memo', 'settings']

function parseHash(hash: string): AppSection {
  const cleaned = hash.replace(/^#\/?/, '').split('/')[0]?.toLowerCase() ?? ''
  return (SECTIONS as readonly string[]).includes(cleaned) ? (cleaned as AppSection) : 'agent'
}

export function useAppSection(): [AppSection, (next: AppSection) => void] {
  const [section, setSection] = useState<AppSection>(() =>
    typeof window === 'undefined' ? 'agent' : parseHash(window.location.hash),
  )
  useEffect(() => {
    let previousHash = window.location.hash
    const onHash = (): void => {
      const event = new CustomEvent<string>('kala:settings-navigation', { cancelable: true, detail: window.location.hash })
      if (!window.dispatchEvent(event)) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${previousHash}`)
        return
      }
      previousHash = window.location.hash
      const next = parseHash(window.location.hash)
      setSection(next)
    }
    window.addEventListener('hashchange', onHash)
    const restored = (): void => { previousHash = window.location.hash }
    window.addEventListener('kala:settings-route-accepted', restored)
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('kala:settings-route-accepted', restored) }
  }, [])
  const go = (next: AppSection): void => {
    if (typeof window === 'undefined') {
      setSection(next)
      return
    }
    const target = `#/${next}`
    if (window.location.hash === target) return
    window.location.hash = target
  }
  return [section, go]
}

/**
 * Extract a session id from a `#/sessions/<id>` deep-link hash, or null.
 * Used by notification deep-links (Web Push URL `/#/sessions/<id>`), both for a
 * cold-start (openWindow with the hash) and a focused tab (the SW posts
 * PUSH_NAVIGATE which sets the hash → hashchange).
 */
export function parseSessionDeepLink(hash: string): string | null {
  const cleaned = hash.replace(/^#\/?/, '')
  const parts = cleaned.split('/')
  if (parts[0]?.toLowerCase() !== 'sessions' || parts.length !== 2) return null
  const encoded = parts[1]
  if (!encoded || encoded.length > 512) return null
  try {
    const id = decodeURIComponent(encoded)
    return id && !/[\u0000-\u001f\u007f/\\]/u.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Route a `#/sessions/<id>` deep-link to the given session selector on load and
 * on hashchange, then normalise the hash to `#/agent` so the same link doesn't
 * re-fire and so the section router settles on the agent surface.
 */
export function useSessionDeepLink(onSelect: (sessionId: string) => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = (): void => {
      const sessionId = parseSessionDeepLink(window.location.hash)
      if (!sessionId) return
      onSelect(sessionId)
      // Replace the hash without adding a history entry or re-triggering us.
      const url = `${window.location.pathname}${window.location.search}#/agent`
      window.history.replaceState(null, '', url)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [onSelect])
}
