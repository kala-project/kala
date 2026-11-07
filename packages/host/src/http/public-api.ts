import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  KALA_API_VERSION,
  KALA_API_COMPATIBILITY,
  publicApiOpenApi,
  schema,
  validateInlineMessageFiles,
  validateInlineMessageImages,
  type ApiAnswerDagDecisionRequest,
  type ApiCreateSessionRequest,
  type ApiErrorCode,
  type ApiSendMessageRequest,
  type ApiSession,
  type SessionSummary,
} from '@agent-kernel/shared'
import { validateSchedule } from '../scheduled-tasks/recurrence.js'
import { ScheduledTaskFencedError } from '../scheduled-tasks/postgres-store.js'
import type {
  CreateScheduledTask,
  ScheduledInbox,
  ScheduledInboxSeenResult,
  ScheduledRun,
  ScheduledTask,
  UpdateScheduledTask,
} from '../scheduled-tasks/types.js'

export type PublicApiActor = {
  principal: string
  organizationId?: string
  role?: 'owner' | 'admin' | 'member' | 'viewer'
  canWrite: boolean
}

export type PublicApiDependencies = {
  authorize(request: IncomingMessage): { ok: true; actor: PublicApiActor } | { ok: false; status: 401 | 403; code: 'authentication_required' | 'forbidden' }
  listSessions(actor: PublicApiActor): Promise<readonly ApiSession[]>
  canAccessSession(actor: PublicApiActor, sessionId: string): Promise<boolean>
  getSession(actor: PublicApiActor, sessionId: string): Promise<ApiSession | undefined>
  createSession(actor: PublicApiActor, input: ApiCreateSessionRequest): Promise<{ session: ApiSession; created: boolean }>
  deleteSession(actor: PublicApiActor, sessionId: string, operationId: string): Promise<void>
  sendMessage(actor: PublicApiActor, sessionId: string, input: ApiSendMessageRequest): Promise<{ accepted?: boolean; committed: boolean; cursor?: number }>
  getDagRun(actor: PublicApiActor, sessionId: string): Promise<unknown | null>
  answerDagDecision(actor: PublicApiActor, sessionId: string, decisionId: string, input: ApiAnswerDagDecisionRequest): Promise<unknown>
  scheduledTasks?: {
    list(actor: PublicApiActor): Promise<readonly ScheduledTask[]>
    get(actor: PublicApiActor, taskId: string): Promise<ScheduledTask | undefined>
    create(actor: PublicApiActor, input: Omit<CreateScheduledTask, 'ownerKey' | 'createdBy'>): Promise<ScheduledTask>
    update(actor: PublicApiActor, taskId: string, input: UpdateScheduledTask): Promise<ScheduledTask>
    pause(actor: PublicApiActor, taskId: string, paused: boolean): Promise<ScheduledTask>
    delete(actor: PublicApiActor, taskId: string): Promise<boolean>
    history(actor: PublicApiActor, taskId: string): Promise<readonly ScheduledRun[] | undefined>
    origins(actor: PublicApiActor, sessionId: string): Promise<Record<string, string>>
    inbox(actor: PublicApiActor): Promise<ScheduledInbox>
    markInboxSeen(actor: PublicApiActor, occurrenceIds: readonly string[]): Promise<ScheduledInboxSeenResult>
  }
  onInternalError?(error: unknown, requestId: string): void
}

const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export function createPublicApiHandler(deps: PublicApiDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/v1' && !url.pathname.startsWith('/api/v1/')) return false
    const requestId = requestIdFor(request)
    response.setHeader('x-request-id', requestId)
    response.setHeader('x-kala-api-version', KALA_API_VERSION)
    response.setHeader('x-kala-api-compatibility', KALA_API_COMPATIBILITY)
    response.setHeader('cache-control', 'no-store')

    try {
      if (url.pathname === '/api/v1/openapi.json') {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiHttpError(405, 'invalid_request', 'method not allowed')
        sendJson(response, 200, publicApiOpenApi, request.method === 'HEAD')
        return true
      }
      const auth = deps.authorize(request)
      if (!auth.ok) throw new ApiHttpError(auth.status, auth.code, auth.code)
      const actor = auth.actor
      const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/u)
      const messageMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/u)
      const dagMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/dag$/u)
      const decisionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/dag\/decisions\/([^/]+)$/u)
      const scheduledTaskMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)$/u)
      const scheduledActionMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/(pause|resume|history)$/u)

      if (url.pathname === '/api/v1/scheduled-tasks/origins' && request.method === 'GET') {
        requireScheduledTasks(deps)
        const sessionId = requiredIdentifier(url.searchParams.get('sessionId'), 'sessionId')
        if (!await deps.canAccessSession(actor, sessionId)) throw new ApiHttpError(404, 'not_found', 'session not found')
        sendJson(response, 200, { origins: await deps.scheduledTasks.origins(actor, sessionId) })
        return true
      }
      if (url.pathname === '/api/v1/scheduled-tasks/inbox' && request.method === 'GET') {
        requireScheduledTasks(deps)
        sendJson(response, 200, await deps.scheduledTasks.inbox(actor))
        return true
      }
      if (url.pathname === '/api/v1/scheduled-tasks/inbox/seen' && request.method === 'POST') {
        requireScheduledTasks(deps)
        const occurrenceIds = validateInboxSeen(await readJson(request))
        sendJson(response, 200, await deps.scheduledTasks.markInboxSeen(actor, occurrenceIds))
        return true
      }
      if (url.pathname === '/api/v1/scheduled-tasks' && request.method === 'GET') {
        requireScheduledTasks(deps)
        sendJson(response, 200, { items: (await deps.scheduledTasks.list(actor)).map(publicScheduledTask) })
        return true
      }
      if (url.pathname === '/api/v1/scheduled-tasks' && request.method === 'POST') {
        requireWrite(actor); requireScheduledTasks(deps)
        const task = await deps.scheduledTasks.create(actor, validateScheduledTask(await readJson(request)))
        sendJson(response, 201, { task: publicScheduledTask(task) })
        return true
      }
      if (scheduledActionMatch && scheduledActionMatch[2] === 'history' && request.method === 'GET') {
        requireScheduledTasks(deps)
        const runs = await deps.scheduledTasks.history(actor, decodePath(scheduledActionMatch[1]!))
        if (!runs) throw new ApiHttpError(404, 'not_found', 'scheduled task not found')
        sendJson(response, 200, { items: runs })
        return true
      }
      if (scheduledActionMatch && (scheduledActionMatch[2] === 'pause' || scheduledActionMatch[2] === 'resume') && request.method === 'POST') {
        requireWrite(actor); requireScheduledTasks(deps)
        await requireScheduleMutation(deps, actor, decodePath(scheduledActionMatch[1]!), scheduledActionMatch[2] === 'pause')
        const task = await deps.scheduledTasks.pause(actor, decodePath(scheduledActionMatch[1]!), scheduledActionMatch[2] === 'pause')
        sendJson(response, 200, { task: publicScheduledTask(task) })
        return true
      }
      if (scheduledTaskMatch && request.method === 'GET') {
        requireScheduledTasks(deps)
        const task = await deps.scheduledTasks.get(actor, decodePath(scheduledTaskMatch[1]!))
        if (!task) throw new ApiHttpError(404, 'not_found', 'scheduled task not found')
        sendJson(response, 200, { task: publicScheduledTask(task) })
        return true
      }
      if (scheduledTaskMatch && request.method === 'PATCH') {
        requireWrite(actor); requireScheduledTasks(deps)
        await requireScheduleMutation(deps, actor, decodePath(scheduledTaskMatch[1]!))
        const task = await deps.scheduledTasks.update(actor, decodePath(scheduledTaskMatch[1]!), validateScheduledTaskPatch(await readJson(request)))
        sendJson(response, 200, { task: publicScheduledTask(task) })
        return true
      }
      if (scheduledTaskMatch && request.method === 'DELETE') {
        requireWrite(actor); requireScheduledTasks(deps)
        await requireScheduleMutation(deps, actor, decodePath(scheduledTaskMatch[1]!), true)
        if (!await deps.scheduledTasks.delete(actor, decodePath(scheduledTaskMatch[1]!))) throw new ApiHttpError(404, 'not_found', 'scheduled task not found')
        response.writeHead(204); response.end()
        return true
      }

      if (url.pathname === '/api/v1/sessions' && request.method === 'GET') {
        const limit = parseLimit(url.searchParams.get('limit'))
        const cursor = decodeCursor(url.searchParams.get('cursor'))
        const sessions = [...await deps.listSessions(actor)].sort(compareSessions)
        const start = cursor
          ? sessions.findIndex((item) => compareSummaryToCursor(item.summary, cursor) > 0)
          : 0
        const offset = start < 0 ? sessions.length : start
        const items = sessions.slice(offset, offset + limit)
        const next = sessions[offset + limit]
        sendJson(response, 200, {
          items,
          ...(next && items.length > 0 ? { nextCursor: encodeCursor(items.at(-1)!.summary) } : {}),
        })
        return true
      }
      if (url.pathname === '/api/v1/sessions' && request.method === 'POST') {
        requireWrite(actor)
        const input = validateCreateSession(await readJson(request))
        const result = await deps.createSession(actor, input)
        sendJson(response, result.created ? 201 : 200, { session: result.session })
        return true
      }
      if (sessionMatch && request.method === 'GET') {
        const session = await deps.getSession(actor, decodePath(sessionMatch[1]!))
        if (!session) throw new ApiHttpError(404, 'not_found', 'session not found')
        sendJson(response, 200, { session })
        return true
      }
      if (sessionMatch && request.method === 'DELETE') {
        requireWrite(actor)
        const operationId = requiredOperationId(request.headers['idempotency-key'])
        await deps.deleteSession(actor, decodePath(sessionMatch[1]!), operationId)
        response.writeHead(204)
        response.end()
        return true
      }
      if (messageMatch && request.method === 'POST') {
        requireWrite(actor)
        const input = validateMessage(await readJson(request))
        const result = await deps.sendMessage(actor, decodePath(messageMatch[1]!), input)
        sendJson(response, 202, { accepted: result.accepted ?? true, ...result, operationId: input.operationId })
        return true
      }
      if (dagMatch && request.method === 'GET') {
        const run = await deps.getDagRun(actor, decodePath(dagMatch[1]!))
        sendJson(response, 200, { run })
        return true
      }
      if (decisionMatch && request.method === 'POST') {
        requireWrite(actor)
        const input = validateDecision(await readJson(request))
        const run = await deps.answerDagDecision(
          actor,
          decodePath(decisionMatch[1]!),
          decodePath(decisionMatch[2]!),
          input,
        )
        sendJson(response, 200, { run })
        return true
      }
      throw new ApiHttpError(404, 'not_found', 'API resource not found')
    } catch (error) {
      const normalized = normalizeError(error)
      if (normalized.code === 'internal_error') deps.onInternalError?.(error, requestId)
      sendJson(response, normalized.status, {
        error: {
          code: normalized.code,
          message: normalized.message,
          requestId,
        },
      })
      return true
    }
  }
}

class ApiHttpError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string) {
    super(message)
  }
}

function normalizeError(error: unknown): ApiHttpError {
  if (error instanceof ApiHttpError) return error
  if (error instanceof ScheduledTaskFencedError) return new ApiHttpError(503, 'service_unavailable', 'scheduled task writer temporarily unavailable; retry shortly')
  const message = error instanceof Error ? error.message : String(error)
  if (/not found|does not exist|unknown session/iu.test(message)) return new ApiHttpError(404, 'not_found', message)
  if (/conflict|already|active turn|mismatch/iu.test(message)) return new ApiHttpError(409, 'conflict', message)
  if (/invalid|required|unsupported|must /iu.test(message)) return new ApiHttpError(400, 'invalid_request', message)
  return new ApiHttpError(500, 'internal_error', 'internal API error')
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > MAX_BODY_BYTES) throw new ApiHttpError(400, 'invalid_request', 'request body exceeds 1 MiB')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiHttpError(400, 'invalid_request', 'request body must be valid JSON')
  }
}

function validateCreateSession(raw: unknown): ApiCreateSessionRequest {
  const value = record(raw)
  return {
    operationId: requiredString(value.operationId, 'operationId'),
    sessionId: requiredIdentifier(value.sessionId, 'sessionId'),
    ...(value.executionMode === 'chat' || value.executionMode === 'dag' ? { executionMode: value.executionMode } : value.executionMode === undefined ? {} : invalid('executionMode')),
    ...(optionalString(value.workspaceId, 'workspaceId')),
    ...(optionalString(value.workspaceName, 'workspaceName')),
    ...(optionalString(value.cwd, 'cwd')),
    ...(optionalString(value.selectedModel, 'selectedModel')),
  }
}

function validateMessage(raw: unknown): ApiSendMessageRequest {
  const value = record(raw)
  const text = typeof value.text === 'string' ? value.text : invalidValue('text is required')
  if (text.trim().length === 0 && !Array.isArray(value.content)) throw new ApiHttpError(400, 'invalid_request', 'text or content is required')
  if (value.mode !== undefined && value.mode !== 'queue' && value.mode !== 'steer') invalidValue('mode must be queue or steer')
  const content = schema.MessageContentSchema.array().safeParse(value.content ?? [])
  if (!content.success) throw new ApiHttpError(400, 'invalid_request', 'content is invalid')
  const imageValidation = validateInlineMessageImages(content.data)
  if (!imageValidation.ok) throw new ApiHttpError(400, 'invalid_request', imageValidation.error.message)
  const fileValidation = validateInlineMessageFiles(content.data)
  if (!fileValidation.ok) throw new ApiHttpError(400, 'invalid_request', fileValidation.error.message)
  return {
    operationId: requiredString(value.operationId, 'operationId'),
    text,
    ...(value.mode ? { mode: value.mode as 'queue' | 'steer' } : {}),
    ...(content.data.length > 0 ? { content: content.data } : {}),
  }
}

function validateDecision(raw: unknown): ApiAnswerDagDecisionRequest {
  const value = record(raw)
  return {
    operationId: requiredString(value.operationId, 'operationId'),
    answer: requiredString(value.answer, 'answer'),
  }
}

function publicScheduledTask(task: ScheduledTask): Omit<ScheduledTask, 'ownerKey'> {
  const { ownerKey: _ownerKey, ...visible } = task
  return visible
}

function validateScheduledTask(raw: unknown): Omit<CreateScheduledTask, 'ownerKey' | 'createdBy'> {
  const value = record(raw)
  return { prompt: scheduledPrompt(value.prompt), target: scheduledTarget(value.target), schedule: scheduledSchedule(value.schedule) }
}

function validateScheduledTaskPatch(raw: unknown): UpdateScheduledTask {
  const value = record(raw)
  const patch: UpdateScheduledTask = {
    ...(value.prompt !== undefined ? { prompt: scheduledPrompt(value.prompt) } : {}),
    ...(value.target !== undefined ? { target: scheduledTarget(value.target) } : {}),
    ...(value.schedule !== undefined ? { schedule: scheduledSchedule(value.schedule) } : {}),
  }
  if (Object.keys(patch).length === 0) throw new ApiHttpError(400, 'invalid_request', 'at least one task field is required')
  return patch
}

function validateInboxSeen(raw: unknown): string[] {
  const value = record(raw)
  if (!Array.isArray(value.occurrenceIds)) throw new ApiHttpError(400, 'invalid_request', 'occurrenceIds must be an array')
  if (value.occurrenceIds.length > MAX_PAGE_SIZE) throw new ApiHttpError(400, 'invalid_request', `occurrenceIds must contain at most ${MAX_PAGE_SIZE} items`)
  const occurrenceIds = value.occurrenceIds.map((item) => requiredIdentifier(item, 'occurrenceIds'))
  if (new Set(occurrenceIds).size !== occurrenceIds.length) throw new ApiHttpError(400, 'invalid_request', 'occurrenceIds must be unique')
  return occurrenceIds
}

function scheduledPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new ApiHttpError(400, 'invalid_request', 'prompt is required and must not exceed 100000 characters')
  return value
}

function scheduledTarget(raw: unknown): CreateScheduledTask['target'] {
  const value = record(raw)
  if (value.kind === 'session') return { kind: 'session', sessionId: requiredIdentifier(value.sessionId, 'target.sessionId') }
  if (value.kind === 'workspace') return {
    kind: 'workspace', workspaceId: requiredString(value.workspaceId, 'target.workspaceId'),
    ...(value.workspaceName !== undefined ? { workspaceName: requiredString(value.workspaceName, 'target.workspaceName') } : {}),
    ...(value.cwd !== undefined ? { cwd: requiredString(value.cwd, 'target.cwd') } : {}),
  }
  throw new ApiHttpError(400, 'invalid_request', 'target.kind must be session or workspace')
}

function scheduledSchedule(raw: unknown): CreateScheduledTask['schedule'] {
  const value = record(raw)
  let schedule: CreateScheduledTask['schedule']
  if (value.kind === 'once') schedule = { kind: 'once', at: requiredString(value.at, 'schedule.at') }
  else if (value.kind === 'daily') schedule = { kind: 'daily', ...scheduledWallClock(value) }
  else if (value.kind === 'weekly') {
    schedule = { kind: 'weekly', ...scheduledWallClock(value), daysOfWeek: integerArray(value.daysOfWeek, 'schedule.daysOfWeek') }
  } else if (value.kind === 'interval') {
    schedule = {
      kind: 'interval', ...scheduledWallClock(value), everyDays: integer(value.everyDays, 'schedule.everyDays'),
      startDate: requiredString(value.startDate, 'schedule.startDate'),
    }
  } else if (value.kind === 'monthly') {
    schedule = { kind: 'monthly', ...scheduledWallClock(value), daysOfMonth: integerArray(value.daysOfMonth, 'schedule.daysOfMonth') }
  } else {
    throw new ApiHttpError(400, 'invalid_request', 'schedule.kind must be once, daily, weekly, interval, or monthly')
  }
  try { validateSchedule(schedule) } catch (error) {
    throw new ApiHttpError(400, 'invalid_request', error instanceof Error ? error.message : 'schedule is invalid')
  }
  return schedule
}

function scheduledWallClock(value: Record<string, unknown>): { timezone: string; hour: number; minute: number } {
  return { timezone: requiredString(value.timezone, 'schedule.timezone'), hour: integer(value.hour, 'schedule.hour'), minute: integer(value.minute, 'schedule.minute') }
}

function integerArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'invalid_request', `${name} must be an array`)
  return value.map((item) => integer(item, name))
}

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new ApiHttpError(400, 'invalid_request', `${name} must be an integer`)
  return value as number
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidValue('request body must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) invalidValue(`${name} is required`)
  return value
}

function requiredIdentifier(value: unknown, name: string): string {
  const result = requiredString(value, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(result)) invalidValue(`${name} is invalid`)
  return result
}

function optionalString(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {}
  return { [name]: requiredString(value, name) }
}

function invalid(name: string): never {
  throw new ApiHttpError(400, 'invalid_request', `${name} is invalid`)
}

function invalidValue(message: string): never {
  throw new ApiHttpError(400, 'invalid_request', message)
}

function requiredOperationId(value: string | string[] | undefined): string {
  if (typeof value !== 'string') throw new ApiHttpError(400, 'invalid_request', 'Idempotency-Key header is required')
  return requiredString(value, 'Idempotency-Key')
}

function requireWrite(actor: PublicApiActor): void {
  if (!actor.canWrite) throw new ApiHttpError(403, 'forbidden', 'workspace:write scope is required')
}

async function requireScheduleMutation(deps: PublicApiDependencies, actor: PublicApiActor, id: string, revoking = false): Promise<void> {
  requireScheduledTasks(deps)
  const task = await deps.scheduledTasks.get(actor, id)
  if (!task) throw new ApiHttpError(404, 'not_found', 'scheduled task not found')
  // Administrative revocation may reduce authority, not rewrite or reactivate
  // another principal's delegated program. Create a new task under your identity.
  if (task.createdBy !== actor.principal && !(revoking && (actor.role === 'owner' || actor.role === 'admin'))) {
    throw new ApiHttpError(403, 'forbidden', 'only the original principal may change or resume delegated work')
  }
}

function requireScheduledTasks(deps: PublicApiDependencies): asserts deps is PublicApiDependencies & { scheduledTasks: NonNullable<PublicApiDependencies['scheduledTasks']> } {
  if (!deps.scheduledTasks) throw new ApiHttpError(404, 'not_found', 'scheduled tasks are unavailable')
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_SIZE
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new ApiHttpError(400, 'invalid_request', `limit must be between 1 and ${MAX_PAGE_SIZE}`)
  }
  return parsed
}

type SessionCursor = { createdAt: string; sessionId: string }

function encodeCursor(summary: SessionSummary): string {
  return Buffer.from(JSON.stringify({ createdAt: summary.createdAt, sessionId: summary.sessionId }), 'utf8').toString('base64url')
}

function decodeCursor(value: string | null): SessionCursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SessionCursor>
    if (typeof parsed.createdAt !== 'string' || typeof parsed.sessionId !== 'string') throw new Error()
    return { createdAt: parsed.createdAt, sessionId: parsed.sessionId }
  } catch {
    throw new ApiHttpError(400, 'invalid_request', 'cursor is invalid')
  }
}

function compareSessions(a: ApiSession, b: ApiSession): number {
  return b.summary.createdAt.localeCompare(a.summary.createdAt) || b.summary.sessionId.localeCompare(a.summary.sessionId)
}

function compareSummaryToCursor(summary: SessionSummary, cursor: SessionCursor): number {
  return cursor.createdAt.localeCompare(summary.createdAt) || cursor.sessionId.localeCompare(summary.sessionId)
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ApiHttpError(400, 'invalid_request', 'path identifier is invalid')
  }
}

function requestIdFor(request: IncomingMessage): string {
  const supplied = request.headers['x-request-id']
  return typeof supplied === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(supplied) ? supplied : randomUUID()
}

function sendJson(response: ServerResponse, status: number, body: unknown, head = false): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(head ? undefined : JSON.stringify(body))
}
