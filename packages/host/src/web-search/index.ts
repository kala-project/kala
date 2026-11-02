import type { ToolExecutionResult } from '../agent-modules/execution.js'
import { decideNetworkPolicy, type NetworkPolicy } from '@agent-kernel/shared'
import type { AuditLogger } from '../audit-log.js'
import { ulid } from 'ulid'
import { WEB_SEARCH_DEFAULT_LIMIT, WEB_SEARCH_MAX_LIMIT, WEB_SEARCH_MAX_PAGE, WEB_SEARCH_MAX_QUERIES, WEB_SEARCH_MAX_TOTAL_RESULTS, WEB_SEARCH_MAX_PAGES, WEB_SEARCH_MAX_REQUESTS } from './contract.js'

const SERPER_SEARCH_URL = 'https://google.serper.dev/search'
const DEFAULT_TIMEOUT_MS = 15_000
const SNIPPET_MAX_CHARS = 500

export interface WebSearchCredentialStore {
  get(provider: 'serper'): Promise<string | undefined> | string | undefined
}

export type WebSearchOptions = {
  credentials: WebSearchCredentialStore
  fetchImpl?: typeof fetch
  timeoutMs?: number
  sessionId?: string
  callId?: string
  audit?: AuditLogger
  networkPolicy?: NetworkPolicy
}

type SearchResult = { title: string; url: string; snippet: string }

export async function runWebSearch(
  input: Record<string, unknown>,
  options: WebSearchOptions,
): Promise<ToolExecutionResult> {
  const batch = input.queries !== undefined
  if ((input.query !== undefined) === batch) {
    return failure('EINVAL', 'Provide exactly one of query or queries', 'input', 'model', false)
  }
  const raw = batch ? input.queries : [input.query]
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > WEB_SEARCH_MAX_QUERIES
      || raw.some((q) => typeof q !== 'string' || !q.trim())) {
    return failure('EINVAL', `Provide 1–${WEB_SEARCH_MAX_QUERIES} non-empty queries`, 'input', 'model', false)
  }
  const queries = (raw as string[]).map((q) => q.trim())
  const limit = input.limit === undefined ? WEB_SEARCH_DEFAULT_LIMIT : input.limit
  const page = input.page === undefined ? 1 : input.page
  const pages = input.pages === undefined ? 1 : input.pages
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > WEB_SEARCH_MAX_LIMIT
      || !Number.isInteger(page) || (page as number) < 1 || (page as number) > WEB_SEARCH_MAX_PAGE
      || !Number.isInteger(pages) || (pages as number) < 1 || (pages as number) > WEB_SEARCH_MAX_PAGES
      || (page as number) + (pages as number) - 1 > WEB_SEARCH_MAX_PAGE
      || queries.length * (pages as number) > WEB_SEARCH_MAX_REQUESTS
      || (limit as number) * queries.length * (pages as number) > WEB_SEARCH_MAX_TOTAL_RESULTS
      || new Set(queries).size !== queries.length) {
    return failure('EINVAL', `limit must be 1–${WEB_SEARCH_MAX_LIMIT}, page 1–${WEB_SEARCH_MAX_PAGE}; pages 1–${WEB_SEARCH_MAX_PAGES}; unique queries, at most ${WEB_SEARCH_MAX_REQUESTS} provider requests and ${WEB_SEARCH_MAX_TOTAL_RESULTS} requested results per call`, 'input', 'model', false)
  }
  // Validate the entire batch before any credential access, audit or network work.
  const jobs = queries.flatMap((query, queryIndex) => Array.from({ length: pages as number }, (_, i) => ({ query, queryIndex, page: (page as number) + i })))
  const results = await Promise.all(jobs.map((job) => searchPage(job.query, limit as number, job.page, options)))
  if (!batch && pages === 1) return results[0]!
  const failed = results.find((result) => !result.ok)
  const content = `Web search batch: ${results.filter((result) => result.ok).length}/${results.length} succeeded. Pages ${page}–${(page as number) + (pages as number) - 1} were requested for each query; do not refetch included pages. Failed sections are not evidence of no matches.\n\n`
    + results.map((result, index) => `===== query[${jobs[index]!.queryIndex}] page[${jobs[index]!.page}] (${result.ok ? 'ok' : 'failed'}) =====\n${result.content}`).join('\n\n')
  return { ok: !failed, content, ...(failed?.failure ? { failure: failed.failure } : {}) }
}

async function searchPage(query: string, limit: number, page: number, options: WebSearchOptions): Promise<ToolExecutionResult> {
  const apiKey = await options.credentials.get('serper')
  if (!apiKey) {
    return failure('ESEARCH_CREDENTIAL', 'web search credential is not configured', 'precondition', 'user', false)
  }

  const policy = options.networkPolicy ?? { version: 1 as const, policyId: 'host-default', revision: '1', defaultAction: 'allow' as const, rules: [] }
  const decision = decideNetworkPolicy(policy, { toolName: 'websearch', executionLocation: 'host', url: SERPER_SEARCH_URL })
  const decisionId = ulid()
  options.audit?.log({ action: 'network.policy_decision', actor: { kind: 'system' }, target: { sessionId: options.sessionId, callId: options.callId, toolName: 'websearch', target: decision.target }, outcome: decision.action === 'allow' ? 'ok' : 'denied', refs: { decisionId, policyId: policy.policyId, policyRevision: policy.revision }, metadata: { evidenceLevel: 'declared', enforcementMode: 'application', matchedRuleId: decision.matchedRuleId } })
  if (decision.action !== 'allow') return failure('ENETWORKPOLICY', `network target ${decision.action} by policy`, 'precondition', 'user', false)
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    options.audit?.log({ action: 'network.request_observed', actor: { kind: 'system' }, target: { sessionId: options.sessionId, callId: options.callId, toolName: 'websearch', target: decision.target }, outcome: 'ok', refs: { decisionId }, metadata: { evidenceLevel: 'application_observed', enforcementMode: 'application', phase: 'started' } })
    const response = await (options.fetchImpl ?? fetch)(SERPER_SEARCH_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: query, num: limit, page }),
      signal: controller.signal,
    })
    options.audit?.log({ action: 'network.request_observed', actor: { kind: 'system' }, target: { sessionId: options.sessionId, callId: options.callId, toolName: 'websearch', target: decision.target }, outcome: response.ok ? 'ok' : 'error', refs: { decisionId }, metadata: { evidenceLevel: 'application_observed', enforcementMode: 'application', phase: 'response', statusCode: response.status } })
    if (!response.ok) {
      return await providerHttpFailure(response)
    }
    const body = await response.json() as {
      organic?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }>
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.organic != null && !Array.isArray(body.organic))) {
      return failure('ESEARCH_RESPONSE', 'Serper returned an invalid result list', 'infrastructure', 'provider', true)
    }
    const results = (body.organic ?? [])
      .filter((item) => item && typeof item === 'object')
      .map((item): SearchResult => ({
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.link === 'string' ? item.link : '',
        snippet: truncate(typeof item.snippet === 'string' ? item.snippet : ''),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, limit)
    return { ok: true, content: formatResults(query, results, page, limit) }
  } catch (error) {
    if (controller.signal.aborted) {
      return failure('ETIMEDOUT', `search timed out after ${timeoutMs}ms`, 'infrastructure', 'provider', true, 'timeout')
    }
    const message = error instanceof Error ? error.message : String(error)
    return failure('ENETWORK', `search failed: ${message}`, 'infrastructure', 'provider', true)
  } finally {
    clearTimeout(timer)
  }
}

async function providerHttpFailure(response: Response): Promise<ToolExecutionResult> {
  const status = response.status
  if (status >= 400 && status < 500 && status !== 429) {
    const reason = await boundedProviderReason(response)
    if (['not enough credits', 'insufficient credits', 'credits exhausted'].includes(reason)) {
      return failure('ESEARCH_QUOTA', `Serper returned HTTP ${status}: search credits are exhausted; resolve provider billing before retrying.`, 'precondition', 'user', false)
    }
    if (['invalid api key', 'unauthorized'].includes(reason)) {
      return failure('ESEARCH_CREDENTIAL', `Serper returned HTTP ${status}: provider authentication was rejected; correct the configured credential before retrying.`, 'precondition', 'user', false)
    }
  } else {
    void response.body?.cancel().catch(() => undefined)
  }
  const retryAfter = response.headers.get('retry-after') ?? ''
  const seconds = /^\d{1,5}$/.test(retryAfter) && Number(retryAfter) <= 86_400 ? Number(retryAfter) : undefined
  const hint = status === 429
    ? ` Rate limited; back off${seconds !== undefined ? ` for at least ${seconds} seconds` : ''} before retrying; do not loop unchanged requests.`
    : status === 400 ? ' Request or provider account needs correction; do not repeat it unchanged. No recognized safe provider reason was available.'
      : status === 401 || status === 403 ? ' Check configured provider credentials and account permissions; do not bypass access restrictions.' : ''
  return failure('EHTTP', `Serper returned HTTP ${status}.${hint}`, 'infrastructure', 'provider', status === 429 || status >= 500)
}

// Only recognize fixed provider reason labels. Never return arbitrary response
// text (which may echo queries, account information or credentials), and never
// buffer an unbounded error body merely to improve diagnostics.
async function boundedProviderReason(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 4_096) {
        void reader.cancel().catch(() => undefined)
        return ''
      }
      chunks.push(part.value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || !('message' in body) || typeof body.message !== 'string') return ''
    return body.message.trim().toLowerCase().replace(/[.!]+$/, '')
  } catch {
    return ''
  } finally {
    reader.releaseLock()
  }
}

function truncate(value: string): string {
  return value.length > SNIPPET_MAX_CHARS ? `${value.slice(0, SNIPPET_MAX_CHARS - 3)}...` : value
}

function formatResults(query: string, results: readonly SearchResult[], page: number, limit: number): string {
  const continuation = results.length && page < WEB_SEARCH_MAX_PAGE
    ? `To inspect another provider page, use page=${page + 1} with the same query and limit; another page is not guaranteed.`
    : 'Refine the query if coverage is insufficient; no exhaustive-search claim is made.'
  const header = `Web search results for: ${query}\nPage: ${page}; requested: ${limit}; returned: ${results.length}. ${continuation}`
  if (results.length === 0) return `${header}\n\nNo results on this page.`
  const body = results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`]
    if (result.snippet) lines.push(`   ${result.snippet}`)
    return lines.join('\n')
  }).join('\n\n')
  return `${header}\n\n${body}`
}

function failure(
  code: string,
  content: string,
  category: 'input' | 'precondition' | 'infrastructure',
  responsibility: 'model' | 'provider' | 'user',
  retryable: boolean,
  outcome: 'blocked' | 'failed' | 'timeout' = category === 'precondition' ? 'blocked' : 'failed',
): ToolExecutionResult {
  return { ok: false, content, failure: { code, category, outcome, retryable, responsibility } }
}
