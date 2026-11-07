import type { AgentState, MessageContent } from '@agent-kernel/kernel'

import type { DagRun } from './dag.js'
import type { SessionExecutionMode, SessionSummary } from './protocol.js'

export const KALA_API_VERSION = 'v1' as const
export const KALA_API_COMPATIBILITY = '1' as const

export type ApiErrorCode =
  | 'authentication_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_request'
  | 'rate_limited'
  | 'service_unavailable'
  | 'internal_error'

export type ApiErrorEnvelope = {
  error: {
    code: ApiErrorCode
    message: string
    requestId: string
    details?: unknown
  }
}

export type ApiPage<T> = {
  items: readonly T[]
  nextCursor?: string
}

export type ApiSession = {
  summary: SessionSummary
  state?: AgentState
}

export type ApiCreateSessionRequest = {
  operationId: string
  sessionId: string
  executionMode?: SessionExecutionMode
  workspaceId?: string
  workspaceName?: string
  cwd?: string
  selectedModel?: string
}

export type ApiSendMessageRequest = {
  operationId: string
  text: string
  mode?: 'queue' | 'steer'
  content?: readonly MessageContent[]
}

export type ApiMessageAdmission = {
  accepted: boolean
  committed: boolean
  cursor?: number
  operationId: string
}

export type ApiAnswerDagDecisionRequest = {
  operationId: string
  answer: string
}

export type ApiSessionResponse = { session: ApiSession }
export type ApiDagRunResponse = { run: DagRun | null }

export type KalaApiClientOptions = {
  baseUrl: string
  token?: string
  fetch?: typeof globalThis.fetch
}

export class KalaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly requestId: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'KalaApiError'
  }
}

export class KalaApiClient {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly baseUrl: string

  constructor(private readonly options: KalaApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (!this.fetchImpl) throw new Error('fetch is required')
  }

  async listSessions(input: { limit?: number; cursor?: string } = {}): Promise<ApiPage<ApiSession>> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor) query.set('cursor', input.cursor)
    return await this.request(`/api/v1/sessions${query.size > 0 ? `?${query}` : ''}`)
  }

  async getSession(sessionId: string): Promise<ApiSessionResponse> {
    return await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  async createSession(input: ApiCreateSessionRequest): Promise<ApiSessionResponse> {
    return await this.request('/api/v1/sessions', { method: 'POST', body: JSON.stringify(input) })
  }

  async deleteSession(sessionId: string, operationId: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'idempotency-key': operationId },
    }, true)
  }

  async sendMessage(sessionId: string, input: ApiSendMessageRequest): Promise<ApiMessageAdmission> {
    return await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async getDagRun(sessionId: string): Promise<ApiDagRunResponse> {
    return await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/dag`)
  }

  async answerDagDecision(
    sessionId: string,
    decisionId: string,
    input: ApiAnswerDagDecisionRequest,
  ): Promise<ApiDagRunResponse> {
    return await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/dag/decisions/${encodeURIComponent(decisionId)}`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  }

  private async request<T>(path: string, init: RequestInit = {}, allowEmpty = false): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body) headers.set('content-type', 'application/json')
    if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`)
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers })
    const compatibility = response.headers.get('x-kala-api-compatibility')
    if (compatibility && compatibility !== KALA_API_COMPATIBILITY) {
      throw new KalaApiError(
        502,
        'internal_error',
        `Unsupported Kala API compatibility level: ${compatibility}`,
        response.headers.get('x-request-id') ?? 'unknown',
      )
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as ApiErrorEnvelope | undefined
      throw new KalaApiError(
        response.status,
        payload?.error.code ?? 'internal_error',
        payload?.error.message ?? `Kala API request failed with ${response.status}`,
        payload?.error.requestId ?? response.headers.get('x-request-id') ?? 'unknown',
        payload?.error.details,
      )
    }
    if (allowEmpty || response.status === 204) return undefined as T
    return await response.json() as T
  }
}

export const publicApiOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'Kala Product API',
    version: '1.0.0',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }, { browserSession: [] }],
  paths: {
    '/api/v1/sessions': {
      get: {
        summary: 'List Sessions',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Session page' } },
      },
      post: {
        summary: 'Create a Session',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSessionRequest' } } },
        },
        responses: {
          '200': { description: 'Existing Session returned idempotently' },
          '201': { description: 'Session created' },
        },
      },
    },
    '/api/v1/sessions/{sessionId}': {
      get: {
        summary: 'Get a Session',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Session' }, '404': { $ref: '#/components/responses/NotFound' } },
      },
      delete: {
        summary: 'Delete a Session tree',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'Deleted or already absent' }, '409': { $ref: '#/components/responses/Conflict' } },
      },
    },
    '/api/v1/sessions/{sessionId}/messages': {
      post: {
        summary: 'Admit a durable user message',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SendMessageRequest' } } },
        },
        responses: { '202': { description: 'Message accepted' }, '409': { $ref: '#/components/responses/Conflict' } },
      },
    },
    '/api/v1/sessions/{sessionId}/dag': {
      get: {
        summary: 'Get the authoritative DAG run',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'DAG run or null' } },
      },
    },
    '/api/v1/sessions/{sessionId}/dag/decisions/{decisionId}': {
      post: {
        summary: 'Answer a pending DAG decision',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'decisionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AnswerDagDecisionRequest' } } },
        },
        responses: { '200': { description: 'Updated DAG run' }, '409': { $ref: '#/components/responses/Conflict' } },
      },
    },
    '/api/v1/openapi.json': {
      get: { summary: 'Get this OpenAPI document', security: [], responses: { '200': { description: 'OpenAPI document' } } },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      browserSession: { type: 'apiKey', in: 'cookie', name: 'ak_session' },
    },
    responses: {
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
      Conflict: {
        description: 'Resource state conflict',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    },
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string' },
              details: {},
            },
          },
        },
      },
      CreateSessionRequest: {
        type: 'object',
        required: ['operationId', 'sessionId'],
        properties: {
          operationId: { type: 'string' },
          sessionId: { type: 'string' },
          executionMode: { type: 'string', enum: ['chat', 'dag'] },
          workspaceId: { type: 'string' },
          workspaceName: { type: 'string' },
          cwd: { type: 'string' },
          selectedModel: { type: 'string' },
        },
      },
      SendMessageRequest: {
        type: 'object',
        required: ['operationId', 'text'],
        properties: {
          operationId: { type: 'string' },
          text: { type: 'string' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
          content: { type: 'array', items: { type: 'object' } },
        },
      },
      AnswerDagDecisionRequest: {
        type: 'object',
        required: ['operationId', 'answer'],
        properties: {
          operationId: { type: 'string' },
          answer: { type: 'string' },
        },
      },
    },
  },
} as const
