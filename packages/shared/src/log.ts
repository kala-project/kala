/**
 * JSONL event log entry types. See `docs/protocol/event-log.md`.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import type { EventTimingMetadata } from './turn-timing.js'
import type { AgentRuntimeId, SessionExecutionMode } from './protocol.js'

export type LogEntryKind = 'header' | 'event' | 'snapshot' | 'metadata' | 'runtime_metadata'

export type HeaderEntry = {
  kind: 'header'
  seq: 0
  ts: string
  sessionId: string
  /** Runtime that owns the session's agent loop. Missing in legacy logs means `kernel`. */
  agentRuntime?: AgentRuntimeId
  /** Session orchestration semantics. Missing in legacy logs means `chat`. */
  executionMode?: SessionExecutionMode
  /** Runtime implementation version captured when the session was created. */
  agentRuntimeVersion?: string
  /** Runtime-native durable session identity, when different from sessionId. */
  externalSessionId?: string
  parentSessionId?: string
  parentCursor?: number
  /** Durable delegation authority depth. Fork ancestry alone does not increment it. */
  delegationDepth?: number
  /** Parent tool_call id when this session was spawned by the `agent` tool. */
  parentCallId?: string
  /** Display/type label requested for the sub-agent, when provided. */
  agentType?: string
  /** Spawn timestamp for runtime recovery and dashboard replay. */
  subAgentStartedAt?: string
  /**
   * Workspace this session is bound to — stable ULID minted by the
   * executor on first launch. Written once at create time and never
   * rewritten. Host routes tool calls to any executor announcing a
   * matching workspaceId. Legacy logs predating this field have it
   * undefined and are treated as unassigned.
   */
  workspaceId?: string
  /**
   * Display label captured at create time. Not authoritative — the live
   * executor's `workspaceName` in its announce is what the dashboard
   * shows when an executor is online. Persisted here so offline
   * workspaces still render with something more useful than a bare ULID.
   */
  workspaceName?: string
  organizationId?: string
  principal?: string
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  initialCwd?: string
  formatVersion: 2
  kernelVersion: string
  config: AgentConfig
  initialState: AgentState
}

export type EventEntry = {
  kind: 'event'
  seq: number
  ts: string
  event: AgentEvent
  /**
   * Lightweight effect summaries for timeline/state inspection. Large reducer
   * outputs such as full LLM prompt messages are stored out-of-band and loaded
   * only when an inspector needs the raw payload.
   */
  effects: readonly Effect[]
  usage?: UsageTotal
  effectsArtifact?: LogArtifactRef
  llmTrace?: LLMTrace
  llmTraceArtifact?: LogArtifactRef
  /**
   * Model that answered this event, when the event was produced by an LLM
   * call (`llm_response` / `llm_error`). Recorded independently of `llmTrace`
   * so the Inspector can display the model even when the provider trace body
   * was suppressed or an older adapter didn't capture one.
   */
  model?: string
  timing?: EventTimingMetadata
}

export type LogArtifactRef = {
  path: string
  bytes: number
  sha256: string
}

export type LLMTrace = {
  provider: 'anthropic' | 'openai' | 'unknown'
  model: string
  request: {
    url: string
    headers: Record<string, string>
    body: unknown
  }
  response?: {
    status: number
    /** Provider-native stop reason, e.g. Anthropic `stop_reason` or OpenAI `finish_reason`. */
    finishReason?: string
    body?: unknown
    streamEventTypes?: readonly string[]
    metrics?: {
      durationMs?: number
      timeToFirstChunkMs?: number
    }
  }
  /**
   * Provider- or gateway-issued request id, when the response carried one.
   * Anthropic returns `request-id`; OpenAI returns `x-request-id`; local
   * gateways may inject their own id. Recording it lets us cross-link a
   * session event with provider-side traces, and lets RL rollout capture
   * artifacts reference the exact generation call.
   */
  gatewayRequestId?: string
  /**
   * Serving-side model weight version. Hosted providers rarely expose this;
   * a local SGLang/vLLM gateway or an adapter with policy metadata may set
   * it. Written when known so RL rollouts and A/B evals can pin generations
   * to a specific policy checkpoint.
   */
  weightVersion?: string
}

/**
 * Redact provider endpoint and credential headers before a trace is persisted,
 * broadcast, exported, or rendered. Message/request bodies are preserved so the
 * debugger still shows the real API payload sent to the provider.
 */
export function redactLlmTrace(trace: LLMTrace): LLMTrace {
  const response = trace.response
    ? {
        ...trace.response,
        ...(trace.response.body !== undefined
          ? { body: redactLlmTracePayload(trace.response.body) }
          : {}),
      }
    : undefined
  return {
    ...trace,
    request: {
      ...trace.request,
      url: redactLlmTraceUrl(trace.request.url),
      headers: redactLlmTraceHeaders(trace.request.headers),
      body: redactLlmTracePayload(trace.request.body),
    },
    ...(response ? { response } : {}),
  }
}

function redactLlmTraceUrl(url: string): string {
  if (url === '<redacted>') return url
  const alreadyRedacted = url.match(/^([a-z][a-z0-9+.-]*:)\/\/<redacted>(\/[^?#]*)?/i)
  if (alreadyRedacted) return `${alreadyRedacted[1]}//<redacted>${alreadyRedacted[2] ?? ''}`
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//<redacted>${parsed.pathname}`
  } catch {
    return '<redacted>'
  }
}

function redactLlmTraceHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isLlmTraceSecretKey(key) ? '[redacted]' : redactLlmTraceSecretString(value)
  }
  return out
}

function isLlmTraceSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    lower === 'authorization' ||
    lower === 'x-api-key' ||
    lower === 'api-key' ||
    lower === 'apikey' ||
    lower === 'api_key' ||
    lower === 'proxy-authorization' ||
    lower === 'token' ||
    lower === 'access_token' ||
    lower === 'refresh_token' ||
    lower === 'password' ||
    lower === 'secret' ||
    lower === 'clientsecret' ||
    lower === 'client_secret' ||
    lower === 'sessionsecret' ||
    lower === 'session_secret' ||
    lower.endsWith('_key') ||
    lower.endsWith('_token') ||
    lower.endsWith('-api-key') ||
    lower.endsWith('-token')
  )
}

function redactLlmTracePayload(input: unknown): unknown {
  if (typeof input === 'string') return redactLlmTraceSecretString(input)
  if (input === null || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(redactLlmTracePayload)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (isLlmTraceSecretKey(key)) {
      out[key] = '[redacted]'
    } else if (lower === 'url' || lower === 'baseurl' || lower === 'apiurl') {
      out[key] = typeof value === 'string' ? redactLlmTraceUrl(value) : redactLlmTracePayload(value)
    } else {
      out[key] = redactLlmTracePayload(value)
    }
  }
  return out
}

function redactLlmTraceSecretString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|TOKEN)=([^\s]+)/g, (_m, name) => `${name}=[redacted]`)
}

export type SnapshotEntry = {
  kind: 'snapshot'
  seq: number
  ts: string
  state: AgentState
}

/**
 * Out-of-band metadata mutation. Kept out of the kernel event stream because
 * these fields do not affect reducer transitions. Append-only: reading picks
 * the most recent entry for each field.
 */
export type MetadataEntry = {
  kind: 'metadata'
  ts: string
  label?: string
  workspaceId?: string
  workspaceName?: string
  organizationId?: string
  principal?: string
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  selectedModel?: string
  toolCardMode?: import('./protocol.js').ToolCardMode
  transcriptViewStart?: number
  rightPanelTab?: import('./protocol.js').RightPanelTab
  /** `null` is an append-only tombstone that clears the per-session override. */
  chapterReadingMode?: import('./protocol.js').ChapterReadingMode | null
}

export type RuntimeMetadataEntry = {
  kind: 'runtime_metadata'
  ts: string
  sessionId: string
  action: string
  payload: Record<string, unknown>
  artifactRef?: LogArtifactRef
}

export type LogEntry = HeaderEntry | EventEntry | SnapshotEntry | MetadataEntry | RuntimeMetadataEntry

export const LOG_FORMAT_VERSION = 2 as const
