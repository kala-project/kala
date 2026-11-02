import type { AgentConfig, AgentState } from '@agent-kernel/kernel'
import type { AgentRuntimeId, ContextUsageSnapshot, QueuedMessagePreview, RuntimeCompactionPolicy, SessionErrorEvent, SessionExecutionMode } from '@agent-kernel/shared'

import { DASHBOARD_PREFERENCES } from './lib/prefs.js'
import type { ConnectionStatus, TimelineEntry } from './session-projection.js'

export const DEFAULT_SESSION_VIEW_CACHE_MAX_MB = DASHBOARD_PREFERENCES.sessionViewCacheMaxMb.defaultValue
export const PREF_SESSION_VIEW_CACHE_MAX_MB = DASHBOARD_PREFERENCES.sessionViewCacheMaxMb.key

const BYTES_PER_STRING_CHAR = 2
const MB = 1024 * 1024

export type CachedSessionView = {
  sessionId: string
  scheduledMessageTasks?: Readonly<Record<string, string>>
  agentRuntime?: AgentRuntimeId
  executionMode?: SessionExecutionMode
  status: ConnectionStatus
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  runtimeCompactionPolicy?: RuntimeCompactionPolicy
  /** Optional for durable entries written by older Dashboard versions. */
  turnStartedAt?: string | null
  turnStartedAtCursor?: number | null
  timeline: readonly TimelineEntry[]
  queuedMessages: readonly QueuedMessagePreview[]
  lastError: SessionErrorEvent | null
  parentSessionId: string | null
  parentCursor: number | null
  selectedModel: string | null
  hydratedSessionId: string | null
  cachedAt: number
  estimatedBytes: number
  estimateParts: CachedSessionViewEstimateParts
}

export type CachedSessionViewInput = Omit<CachedSessionView, 'cachedAt' | 'estimatedBytes' | 'estimateParts'> & {
  cachedAt?: number
}

export type CachedSessionViewEstimateParts = {
  staticBytes: number
  stateBytes: number
  timelineBytes: number
}

export type SessionViewCache = {
  get(sessionId: string): CachedSessionView | null
  peek(sessionId: string): CachedSessionView | null
  subscribe(sessionId: string, listener: () => void): () => void
  set(sessionId: string, view: CachedSessionViewInput): CachedSessionView | null
  patch(sessionId: string, patch: Partial<CachedSessionViewInput>): CachedSessionView | null
  delete(sessionId: string): void
  clear(): void
  setMaxBytes(maxBytes: number): void
  stats(): { sessions: number; estimatedBytes: number; maxBytes: number }
}

export function sessionViewCacheMaxBytesFromMb(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0
  return Math.round(mb * MB)
}

export function createSessionViewCache(options: { maxBytes?: number; now?: () => number } = {}): SessionViewCache {
  let maxBytes = Math.max(0, Math.round(options.maxBytes ?? sessionViewCacheMaxBytesFromMb(DEFAULT_SESSION_VIEW_CACHE_MAX_MB)))
  const now = options.now ?? (() => Date.now())
  const entries = new Map<string, CachedSessionView>()
  const listeners = new Map<string, Set<() => void>>()
  let estimatedBytes = 0
  const notify = (sessionId: string): void => {
    for (const listener of listeners.get(sessionId) ?? []) listener()
  }

  const enforceLimit = (): void => {
    if (maxBytes <= 0) {
      entries.clear()
      estimatedBytes = 0
      return
    }
    while (estimatedBytes > maxBytes && entries.size > 0) {
      let oldest: CachedSessionView | null = null
      for (const entry of entries.values()) {
        if (oldest === null || entry.cachedAt < oldest.cachedAt) oldest = entry
      }
      if (oldest === null) break
      entries.delete(oldest.sessionId)
      estimatedBytes -= oldest.estimatedBytes
    }
  }

  const put = (sessionId: string, input: CachedSessionViewInput): CachedSessionView | null => {
    const previous = entries.get(sessionId)
    if (previous) estimatedBytes -= previous.estimatedBytes
    if (maxBytes <= 0) {
      entries.delete(sessionId)
      return null
    }
    const entry = normalizeEntry(sessionId, input, now(), previous)
    if (entry.estimatedBytes > maxBytes) {
      entries.delete(sessionId)
      return null
    }
    entries.set(sessionId, entry)
    estimatedBytes += entry.estimatedBytes
    enforceLimit()
    notify(sessionId)
    return entries.get(sessionId) ?? null
  }

  return {
    get(sessionId) {
      const entry = entries.get(sessionId) ?? null
      if (!entry) return null
      const refreshed = { ...entry, cachedAt: now() }
      entries.set(sessionId, refreshed)
      return refreshed
    },
    peek(sessionId) {
      return entries.get(sessionId) ?? null
    },
    subscribe(sessionId, listener) {
      const current = listeners.get(sessionId) ?? new Set<() => void>()
      current.add(listener)
      listeners.set(sessionId, current)
      return () => {
        current.delete(listener)
        if (current.size === 0) listeners.delete(sessionId)
      }
    },
    set: put,
    patch(sessionId, patch) {
      const current = entries.get(sessionId)
      if (!current) return null
      return put(sessionId, { ...current, ...patch, sessionId })
    },
    delete(sessionId) {
      const previous = entries.get(sessionId)
      if (!previous) return
      entries.delete(sessionId)
      estimatedBytes -= previous.estimatedBytes
      notify(sessionId)
    },
    clear() {
      entries.clear()
      estimatedBytes = 0
    },
    setMaxBytes(next) {
      maxBytes = Math.max(0, Math.round(next))
      enforceLimit()
    },
    stats() {
      return { sessions: entries.size, estimatedBytes: Math.max(0, estimatedBytes), maxBytes }
    },
  }
}

function normalizeEntry(
  sessionId: string,
  input: CachedSessionViewInput,
  fallbackNow: number,
  previous?: CachedSessionView,
): CachedSessionView {
  const base = {
    ...input,
    sessionId,
    cachedAt: input.cachedAt ?? fallbackNow,
  }
  const estimateParts = estimateCachedSessionViewParts(base, previous)
  return {
    ...base,
    estimateParts,
    estimatedBytes: estimateParts.staticBytes + estimateParts.stateBytes + estimateParts.timelineBytes,
  }
}

export function estimateCachedSessionViewBytes(input: Omit<CachedSessionView, 'estimatedBytes'>): number {
  const parts = estimateCachedSessionViewParts(input)
  return parts.staticBytes + parts.stateBytes + parts.timelineBytes
}

function estimateCachedSessionViewParts(
  input: Omit<CachedSessionViewInput, 'estimateParts'>,
  previous?: CachedSessionView,
): CachedSessionViewEstimateParts {
  return {
    staticBytes: estimateJsonBytes({
      sessionId: input.sessionId,
      status: input.status,
      config: input.config,
      contextSnapshot: input.contextSnapshot,
      turnStartedAt: input.turnStartedAt,
      turnStartedAtCursor: input.turnStartedAtCursor,
      scheduledMessageTasks: input.scheduledMessageTasks,
      queuedMessages: input.queuedMessages,
      lastError: input.lastError,
      parentSessionId: input.parentSessionId,
      parentCursor: input.parentCursor,
      selectedModel: input.selectedModel,
      hydratedSessionId: input.hydratedSessionId,
    }),
    stateBytes: previous && input.state === previous.state ? previous.estimateParts.stateBytes : estimateJsonBytes(input.state),
    timelineBytes: previous && input.timeline === previous.timeline ? previous.estimateParts.timelineBytes : estimateJsonBytes(input.timeline),
  }
}

function estimateJsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length * BYTES_PER_STRING_CHAR
  } catch {
    return 0
  }
}
