import { createHash } from 'node:crypto'
import { dirname, join, posix } from 'node:path'

import type { CallToolEffect, ToolSchema } from '@agent-kernel/kernel'

import type { HostLoopDeps } from '../loop-types.js'
import { validateSchedule } from '../scheduled-tasks/recurrence.js'
import { assertNoResumableGoal } from '../scheduled-tasks/goal-guard.js'
import { ScheduledTaskStore, type ScheduledTaskStorage } from '../scheduled-tasks/store.js'
import type {
  ScheduleSpec,
  ScheduledTask,
  ScheduledTaskTarget,
  UpdateScheduledTask,
} from '../scheduled-tasks/types.js'
import type { SessionRecord, SessionStore } from '../store/session.js'

export const SCHEDULED_TASK_TOOL_NAME = 'scheduled_task'

const INVISIBLE_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

const PROMPT_THREAT_PATTERNS: readonly { pattern: RegExp; id: string; reason: string }[] = [
  {
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions|rules|guidelines|prompts)\b/i,
    id: 'prompt_injection',
    reason: 'scheduled task prompt contains instruction-override / prompt-injection directive',
  },
  {
    pattern: /\bsystem\s+prompt\s+override\b|\byou\s+are\s+now\s+in\s+developer\s+mode\b/i,
    id: 'sys_prompt_override',
    reason: 'scheduled task prompt contains system/developer role override directive',
  },
  {
    pattern: /\bdo\s+not\s+tell\s+the\s+user\b|\bhide\s+this\s+from\s+the\s+user\b/i,
    id: 'deception_hide',
    reason: 'scheduled task prompt contains user-deception directive',
  },
  {
    pattern: /\b(?:curl|wget|nc|netcat)\b[^\n]*(?:\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\}?|\.env\b|id_rsa|id_ed25519|\.pgpass|\.netrc)/i,
    id: 'secret_exfiltration',
    reason: 'scheduled task prompt contains credential/secret exfiltration command',
  },
  {
    pattern: /\b(?:authorized_keys|\/etc\/sudoers|visudo)\b/i,
    id: 'persistence_backdoor',
    reason: 'scheduled task prompt references privileged persistence files (authorized_keys/sudoers)',
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|`|'|"|\*)/i,
    id: 'destructive_root_rm',
    reason: 'scheduled task prompt contains destructive root filesystem deletion command',
  },
]

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

const fallbackStores = new WeakMap<SessionStore, Promise<ScheduledTaskStorage>>()

export type PromptScanResult =
  | { ok: true }
  | { ok: false; patternId: string; reason: string }

export function scanScheduledTaskPrompt(prompt: string): PromptScanResult {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { ok: false, patternId: 'empty_prompt', reason: 'prompt must be a non-empty string' }
  }
  if (prompt.length > 100_000) {
    return {
      ok: false,
      patternId: 'prompt_too_long',
      reason: 'prompt must not exceed 100000 characters',
    }
  }
  if (INVISIBLE_UNICODE_RE.test(prompt)) {
    return {
      ok: false,
      patternId: 'invisible_unicode',
      reason: 'scheduled task prompt contains forbidden invisible or bidirectional control characters',
    }
  }
  for (const rule of PROMPT_THREAT_PATTERNS) {
    if (rule.pattern.test(prompt)) {
      return { ok: false, patternId: rule.id, reason: rule.reason }
    }
  }
  return { ok: true }
}

/**
 * Normalizes agent schedule inputs into Kala's authoritative `ScheduleSpec`.
 * Supports:
 * 1. Canonical `ScheduleSpec` objects (`once`, `daily`, `weekly`, `interval`, `monthly`)
 * 2. Relative delay shorthands:
 *    - `{ kind: 'once', inMinutes: 30 }`
 *    - string `"in 30m"`, `"in 2h"`, `"in 1d"`, `"+45m"`
 * 3. Standard 5-field cron expressions:
 *    - `{ kind: 'cron', expression: '30 9 * * 1-5', timezone: 'Asia/Shanghai' }`
 *    - string `"30 9 * * 1-5"` (uses `defaultTimezone`, defaults to `'UTC'`)
 */
export function normalizeScheduleInput(
  raw: unknown,
  options: { now?: Date; defaultTimezone?: string } = {},
): ScheduleSpec {
  const now = options.now ?? new Date()
  const fallbackTz = options.defaultTimezone?.trim() || 'UTC'

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const relativeMs = parseRelativeDelayMs(trimmed)
    if (relativeMs !== null) {
      return { kind: 'once', at: new Date(now.getTime() + relativeMs).toISOString() }
    }
    if (trimmed.split(/\s+/u).length === 5) {
      const spec = parseFiveFieldCron(trimmed, fallbackTz)
      validateSchedule(spec)
      return spec
    }
    const parsedTime = Date.parse(trimmed)
    if (Number.isFinite(parsedTime)) {
      const spec: ScheduleSpec = { kind: 'once', at: new Date(parsedTime).toISOString() }
      validateSchedule(spec)
      return spec
    }
    throw new Error(
      'schedule string must be an ISO timestamp, a relative delay (e.g. "in 30m", "in 2h"), or a 5-field cron expression (e.g. "30 9 * * 1-5")',
    )
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('schedule must be a ScheduleSpec object or schedule string')
  }

  const obj = raw as Record<string, unknown>
  const kind = obj.kind
  const timezone = typeof obj.timezone === 'string' && obj.timezone.trim() ? obj.timezone.trim() : fallbackTz

  if (kind === 'cron' || (kind === undefined && typeof obj.expression === 'string')) {
    if (typeof obj.expression !== 'string' || !obj.expression.trim()) {
      throw new Error('cron schedule requires a non-empty expression string')
    }
    const spec = parseFiveFieldCron(obj.expression.trim(), timezone)
    validateSchedule(spec)
    return spec
  }

  if (kind === 'once') {
    const inMinutes = obj.inMinutes ?? obj.in_minutes
    if (typeof inMinutes === 'number' && Number.isFinite(inMinutes) && inMinutes > 0) {
      const spec: ScheduleSpec = {
        kind: 'once',
        at: new Date(now.getTime() + Math.round(inMinutes * 60_000)).toISOString(),
      }
      validateSchedule(spec)
      return spec
    }
    if (typeof obj.at !== 'string' || !obj.at.trim()) {
      throw new Error('once schedule requires an ISO timestamp in "at" or positive number in "inMinutes"')
    }
    const spec: ScheduleSpec = { kind: 'once', at: obj.at.trim() }
    validateSchedule(spec)
    return spec
  }

  if (kind === 'daily') {
    const spec: ScheduleSpec = {
      kind: 'daily',
      timezone,
      hour: Number(obj.hour),
      minute: Number(obj.minute ?? 0),
    }
    validateSchedule(spec)
    return spec
  }

  if (kind === 'weekly') {
    const rawDays = obj.daysOfWeek ?? obj.days_of_week
    if (!Array.isArray(rawDays)) {
      throw new Error('weekly schedule requires daysOfWeek array of integers 0 (Sunday) through 6 (Saturday)')
    }
    const spec: ScheduleSpec = {
      kind: 'weekly',
      timezone,
      daysOfWeek: rawDays.map((d) => Number(d)),
      hour: Number(obj.hour),
      minute: Number(obj.minute ?? 0),
    }
    validateSchedule(spec)
    return spec
  }

  if (kind === 'interval') {
    const everyDays = Number(obj.everyDays ?? obj.every_days)
    const startDateRaw = obj.startDate ?? obj.start_date
    const startDate =
      typeof startDateRaw === 'string' && startDateRaw.trim()
        ? startDateRaw.trim()
        : now.toISOString().slice(0, 10)
    const spec: ScheduleSpec = {
      kind: 'interval',
      timezone,
      everyDays,
      startDate,
      hour: Number(obj.hour),
      minute: Number(obj.minute ?? 0),
    }
    validateSchedule(spec)
    return spec
  }

  if (kind === 'monthly') {
    const rawDays = obj.daysOfMonth ?? obj.days_of_month
    if (!Array.isArray(rawDays)) {
      throw new Error('monthly schedule requires daysOfMonth array of integers 1 through 31')
    }
    const spec: ScheduleSpec = {
      kind: 'monthly',
      timezone,
      daysOfMonth: rawDays.map((d) => Number(d)),
      hour: Number(obj.hour),
      minute: Number(obj.minute ?? 0),
    }
    validateSchedule(spec)
    return spec
  }

  throw new Error('schedule.kind must be once, daily, weekly, interval, monthly, or cron')
}

function parseRelativeDelayMs(text: string): number | null {
  const match = /^(?:in\s+|\+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu.exec(
    text,
  )
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = match[2]!.toLowerCase()
  if (unit.startsWith('m')) return Math.round(amount * 60_000)
  if (unit.startsWith('h')) return Math.round(amount * 3_600_000)
  if (unit.startsWith('d')) return Math.round(amount * 86_400_000)
  return null
}

function parseFiveFieldCron(expression: string, timezone: string): ScheduleSpec {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) {
    throw new Error('cron expression must have exactly 5 fields: "minute hour day-of-month month day-of-week"')
  }
  const [minField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]
  const minute = Number(minField)
  const hour = Number(hourField)
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('cron minute field must be a specific integer between 0 and 59')
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('cron hour field must be a specific integer between 0 and 23')
  }
  if (monthField !== '*') {
    throw new Error('cron month field must be "*" (use daily, weekly, monthly, or interval schedules)')
  }
  if (domField !== '*' && dowField !== '*') {
    throw new Error('cron expression cannot specify both day-of-month and day-of-week simultaneously')
  }
  if (domField === '*' && dowField === '*') {
    return { kind: 'daily', timezone, hour, minute }
  }
  if (dowField !== '*') {
    const daysOfWeek = parseCronDayOfWeekList(dowField)
    return { kind: 'weekly', timezone, daysOfWeek, hour, minute }
  }
  const daysOfMonth = parseCronNumberList(domField, 1, 31, 'day-of-month')
  return { kind: 'monthly', timezone, daysOfMonth, hour, minute }
}

function parseCronDayOfWeekList(field: string): number[] {
  const result = new Set<number>()
  for (const part of field.split(',')) {
    const trimmed = part.trim().toUpperCase()
    if (!trimmed) throw new Error('invalid empty day-of-week token in cron expression')
    const rangeParts = trimmed.split('-')
    if (rangeParts.length === 1) {
      result.add(normalizeCronWeekday(rangeParts[0]!))
    } else if (rangeParts.length === 2) {
      const start = parseCronWeekday(rangeParts[0]!)
      const end = parseCronWeekday(rangeParts[1]!)
      if (start > end) throw new Error(`invalid day-of-week range "${part}" in cron expression`)
      for (let d = start; d <= end; d += 1) result.add(d === 7 ? 0 : d)
    } else {
      throw new Error(`invalid day-of-week token "${part}" in cron expression`)
    }
  }
  return [...result].sort((a, b) => a - b)
}

function normalizeCronWeekday(token: string): number {
  const n = parseCronWeekday(token)
  return n === 7 ? 0 : n
}

function parseCronWeekday(token: string): number {
  if (token in WEEKDAY_NAMES) return WEEKDAY_NAMES[token]!
  if (!/^[0-7]$/u.test(token)) throw new Error(`day-of-week "${token}" must be 0-7 or SUN-SAT`)
  const n = Number(token)
  return n
}

function parseCronNumberList(field: string, min: number, max: number, label: string): number[] {
  const result = new Set<number>()
  for (const part of field.split(',')) {
    const trimmed = part.trim()
    const rangeParts = trimmed.split('-')
    if (rangeParts.length === 1) {
      const val = Number(rangeParts[0])
      if (!Number.isInteger(val) || val < min || val > max) {
        throw new Error(`${label} "${part}" must be between ${min} and ${max}`)
      }
      result.add(val)
    } else if (rangeParts.length === 2) {
      const start = Number(rangeParts[0])
      const end = Number(rangeParts[1])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`invalid ${label} range "${part}"`)
      }
      for (let v = start; v <= end; v += 1) result.add(v)
    } else {
      throw new Error(`invalid ${label} token "${part}"`)
    }
  }
  return [...result].sort((a, b) => a - b)
}

export function scheduledTaskToolSchema(): ToolSchema {
  return {
    name: SCHEDULED_TASK_TOOL_NAME,
    description:
      'Create, list, inspect, update, pause, resume, delete, or view run history for scheduled tasks (cron jobs) in the current Unit. Supports one-time future runs (ISO timestamp or relative delay like "in 30m"), daily, weekly, monthly, multi-day interval schedules, and 5-field cron expressions.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'pause', 'resume', 'delete', 'history'],
          description: 'CRUD or lifecycle operation to perform on scheduled tasks.',
        },
        task_id: {
          type: 'string',
          description: 'Scheduled task ID. Required for get, update, pause, resume, delete, and history.',
        },
        prompt: {
          type: 'string',
          description:
            'Self-contained prompt that the Agent will execute when the scheduled occurrence fires. Required for create; optional for update.',
        },
        schedule: {
          description:
            'Schedule specification for create or update. Can be a structured ScheduleSpec object ({ kind: "once" | "daily" | "weekly" | "interval" | "monthly" | "cron", ... }) or a shorthand string ("in 30m", "in 2h", ISO timestamp, or 5-field cron expression like "30 9 * * 1-5").',
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['once', 'daily', 'weekly', 'interval', 'monthly', 'cron'],
                },
                at: { type: 'string', description: 'ISO-8601 future timestamp when kind="once".' },
                inMinutes: {
                  type: 'number',
                  description: 'Relative delay in minutes from now when kind="once".',
                },
                expression: {
                  type: 'string',
                  description: '5-field cron expression (minute hour dom month dow) when kind="cron".',
                },
                timezone: {
                  type: 'string',
                  description: 'Valid IANA timezone (e.g. "Asia/Shanghai", "UTC", "America/New_York").',
                },
                hour: { type: 'integer', minimum: 0, maximum: 23 },
                minute: { type: 'integer', minimum: 0, maximum: 59 },
                daysOfWeek: {
                  type: 'array',
                  items: { type: 'integer', minimum: 0, maximum: 6 },
                  description: 'Unique weekdays 0 (Sunday) through 6 (Saturday) when kind="weekly".',
                },
                daysOfMonth: {
                  type: 'array',
                  items: { type: 'integer', minimum: 1, maximum: 31 },
                  description: 'Unique days of month (1..31) when kind="monthly".',
                },
                everyDays: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 3650,
                  description: 'Day interval when kind="interval".',
                },
                startDate: {
                  type: 'string',
                  description: 'Anchor date YYYY-MM-DD when kind="interval".',
                },
              },
            },
          ],
        },
        timezone: {
          type: 'string',
          description: 'Default IANA timezone when schedule is passed as a 5-field cron string (defaults to UTC).',
        },
        target: {
          type: 'object',
          description:
            'Execution target for the scheduled prompt. Defaults to the current session ({ kind: "session", sessionId: <current> }). Use { kind: "workspace" } to spawn a fresh session in the current workspace for each run.',
          properties: {
            kind: { type: 'string', enum: ['session', 'workspace'] },
            sessionId: { type: 'string' },
            workspaceId: { type: 'string' },
            workspaceName: { type: 'string' },
            cwd: { type: 'string' },
          },
        },
        paused: {
          type: 'boolean',
          description: 'For action="create": when true, creates the task in paused state.',
        },
        allow_session_queue: {
          type: 'boolean',
          description: 'Required as true when creating or retargeting a session task: scheduled prompts join that session queue and may count against an active Goal budget. Use a workspace target for an isolated new session instead.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Required for create. Reuse the same unique key when retrying the same request; a different request with the same key is rejected.',
        },
        auto_pause: {
          type: 'boolean',
          description:
            'For action="delete": when true (default), automatically pauses an active task before deleting it.',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'all'],
          description: 'Optional status filter for action="list" (default "all").',
        },
        target_session_id: {
          type: 'string',
          description: 'Optional sessionId filter for action="list".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum run history entries to return for action="history" (default 20).',
        },
      },
    },
    requiresApproval: false,
  }
}

export async function runScheduledTaskTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  options?: { now?: () => Date },
): Promise<{ ok: boolean; content: string }> {
  const record = deps.store.get(sessionId)
  if (!record) return { ok: false, content: `unknown session: ${sessionId}` }

  const input = effect.input
  const action = input.action
  if (
    action !== 'list' &&
    action !== 'get' &&
    action !== 'create' &&
    action !== 'update' &&
    action !== 'pause' &&
    action !== 'resume' &&
    action !== 'delete' &&
    action !== 'history'
  ) {
    return {
      ok: false,
      content:
        'scheduled_task action must be one of: list, get, create, update, pause, resume, delete, history',
    }
  }

  const isMutation =
    action === 'create' ||
    action === 'update' ||
    action === 'pause' ||
    action === 'resume' ||
    action === 'delete'

  if (isMutation && (record.parentSessionId !== undefined || (record.delegationDepth ?? 0) > 0)) {
    return {
      ok: false,
      content:
        'sub-agent sessions cannot create, modify, pause, resume, or delete scheduled tasks; return the recommended schedule to the parent agent',
    }
  }

  let actor = resolveSessionScheduleActor(record)
  if (record.organizationId) {
    if (!deps.authorizeScheduledTaskPrincipal) {
      return { ok: false, content: 'current organization authority is unavailable' }
    }
    try {
      const role = await deps.authorizeScheduledTaskPrincipal(record.organizationId, actor.principal)
      actor = { ...actor, role, canWrite: role !== 'viewer' }
    } catch {
      return { ok: false, content: 'current organization authority denied or unavailable' }
    }
  }
  if (isMutation && !actor.canWrite) {
    return {
      ok: false,
      content: 'viewer role cannot create or modify scheduled tasks',
    }
  }

  let taskStore: ScheduledTaskStorage
  try {
    taskStore = await resolveScheduledTaskStore(deps, record, options?.now)
  } catch (err) {
    return {
      ok: false,
      content: `scheduled task storage unavailable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const now = options?.now ? options.now() : new Date()

  try {
    if (action === 'list') {
      const all = await taskStore.listTasks(actor.ownerKey)
      const statusFilter =
        input.status === 'active' || input.status === 'paused' ? input.status : 'all'
      const targetSessionFilter =
        typeof input.target_session_id === 'string' && input.target_session_id.trim()
          ? input.target_session_id.trim()
          : undefined
      const filtered = all.filter((task) => {
        if (statusFilter !== 'all' && task.status !== statusFilter) return false
        if (
          targetSessionFilter &&
          (task.target.kind !== 'session' || task.target.sessionId !== targetSessionFilter)
        ) {
          return false
        }
        return true
      })
      return {
        ok: true,
        content: JSON.stringify({
          action: 'list',
          count: filtered.length,
          tasks: filtered.map(publicTaskView),
        }),
      }
    }

    if (action === 'get') {
      const taskId = requiredTaskId(input.task_id)
      const task = await taskStore.getTask(actor.ownerKey, taskId)
      if (!task) return { ok: false, content: `scheduled task not found: ${taskId}` }
      const runs = (await taskStore.history(actor.ownerKey, taskId)) ?? []
      return {
        ok: true,
        content: JSON.stringify({
          action: 'get',
          task: publicTaskView(task),
          recentRuns: runs.slice(0, 5),
        }),
      }
    }

    if (action === 'history') {
      const taskId = requiredTaskId(input.task_id)
      const runs = await taskStore.history(actor.ownerKey, taskId)
      if (!runs) return { ok: false, content: `scheduled task not found: ${taskId}` }
      const limit =
        typeof input.limit === 'number' && Number.isInteger(input.limit)
          ? Math.max(1, Math.min(100, input.limit))
          : 20
      return {
        ok: true,
        content: JSON.stringify({
          action: 'history',
          taskId,
          count: Math.min(runs.length, limit),
          totalRuns: runs.length,
          runs: runs.slice(0, limit),
        }),
      }
    }

    if (action === 'create') {
      const key = input.idempotency_key
      if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(key)) {
        return { ok: false, content: 'create requires an idempotency_key (1-128 letters, digits, _ or -)' }
      }
      const fingerprint = createHash('sha256').update(JSON.stringify([
        input.prompt, input.schedule, input.timezone ?? null, input.target ?? null, input.paused === true, input.allow_session_queue === true,
      ])).digest('hex')
      const prior = await taskStore.getTaskByCreateRequest(actor.ownerKey, actor.principal, key, fingerprint)
      if (prior) {
        if (prior.target.kind === 'session') {
          const targetRecord = await loadSessionForActor(deps, actor, prior.target.sessionId)
          if (!targetRecord) throw new Error('target session not found or unauthorized')
          assertNoResumableGoal(targetRecord)
        }
        return { ok: true, content: JSON.stringify({ action: 'create', task: publicTaskView(prior) }) }
      }
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      const scan = scanScheduledTaskPrompt(prompt)
      if (!scan.ok) {
        return { ok: false, content: `prompt security check failed (${scan.patternId}): ${scan.reason}` }
      }
      if (input.schedule === undefined) {
        return { ok: false, content: 'schedule is required when action="create"' }
      }
      const defaultTimezone = typeof input.timezone === 'string' ? input.timezone : undefined
      const schedule = normalizeScheduleInput(input.schedule, { now, defaultTimezone })
      const target = await resolveAndValidateTarget(deps, record, actor, input.target)
      if (target.kind === 'session' && input.allow_session_queue !== true) {
        return { ok: false, content: 'session targets require allow_session_queue=true: scheduled prompts join the session queue and may consume its Goal budget; use a workspace target for isolation' }
      }

      await assertCurrentMutationAuthority(deps, record, actor)
      const created = await taskStore.create({
        ownerKey: actor.ownerKey,
        createdBy: actor.principal,
        prompt,
        target,
        schedule,
        paused: input.paused === true,
        createRequest: {
          key,
          fingerprint,
        },
      })
      return {
        ok: true,
        content: JSON.stringify({
          action: 'create',
          task: publicTaskView(created),
        }),
      }
    }

    if (action === 'update') {
      const taskId = requiredTaskId(input.task_id)
      const existing = await taskStore.getTask(actor.ownerKey, taskId)
      if (!existing) return { ok: false, content: `scheduled task not found: ${taskId}` }
      assertCanMutateTask(actor, existing, false)

      const patch: UpdateScheduledTask = {}
      if (input.prompt !== undefined) {
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
        const scan = scanScheduledTaskPrompt(prompt)
        if (!scan.ok) {
          return {
            ok: false,
            content: `prompt security check failed (${scan.patternId}): ${scan.reason}`,
          }
        }
        patch.prompt = prompt
      }
      if (input.schedule !== undefined) {
        const defaultTimezone = typeof input.timezone === 'string' ? input.timezone : undefined
        patch.schedule = normalizeScheduleInput(input.schedule, { now, defaultTimezone })
      }
      if (input.target !== undefined) {
        patch.target = await resolveAndValidateTarget(deps, record, actor, input.target)
        if (patch.target.kind === 'session' && input.allow_session_queue !== true) {
          return { ok: false, content: 'session targets require allow_session_queue=true: scheduled prompts join the session queue and may consume its Goal budget; use a workspace target for isolation' }
        }
      }
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          content: 'update requires at least one of prompt, schedule, or target',
        }
      }

      if (!patch.target && existing.target.kind === 'session') {
        const targetRecord = await loadSessionForActor(deps, actor, existing.target.sessionId)
        if (!targetRecord) throw new Error('target session not found or unauthorized')
        assertNoResumableGoal(targetRecord)
        await deps.validateScheduledTaskTarget?.(actor, existing.target)
      }
      await assertCurrentMutationAuthority(deps, record, actor, existing, false)
      const updated = await taskStore.update(actor.ownerKey, taskId, patch)
      return {
        ok: true,
        content: JSON.stringify({
          action: 'update',
          task: publicTaskView(updated),
        }),
      }
    }

    if (action === 'pause' || action === 'resume') {
      const taskId = requiredTaskId(input.task_id)
      const existing = await taskStore.getTask(actor.ownerKey, taskId)
      if (!existing) return { ok: false, content: `scheduled task not found: ${taskId}` }
      const paused = action === 'pause'
      assertCanMutateTask(actor, existing, paused)
      if (!paused && existing.target.kind === 'session') {
        const targetRecord = await loadSessionForActor(deps, actor, existing.target.sessionId)
        if (!targetRecord) throw new Error('target session not found or unauthorized')
        assertNoResumableGoal(targetRecord)
      }
      await assertCurrentMutationAuthority(deps, record, actor, existing, paused)
      const updated = await taskStore.setPaused(actor.ownerKey, taskId, paused)
      return {
        ok: true,
        content: JSON.stringify({
          action,
          task: publicTaskView(updated),
        }),
      }
    }

    // action === 'delete'
    const taskId = requiredTaskId(input.task_id)
    const existing = await taskStore.getTask(actor.ownerKey, taskId)
    if (!existing) return { ok: false, content: `scheduled task not found: ${taskId}` }
    assertCanMutateTask(actor, existing, true)

    const autoPause = input.auto_pause !== false
    await assertCurrentMutationAuthority(deps, record, actor, existing, true)
    const deleted = await taskStore.delete(actor.ownerKey, taskId, autoPause)
    if (!deleted) return { ok: false, content: `scheduled task not found: ${taskId}` }
    return {
      ok: true,
      content: JSON.stringify({
        action: 'delete',
        taskId,
        deleted: true,
      }),
    }
  } catch (err) {
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
    }
  }
}

type SessionScheduleActor = {
  ownerKey: string
  principal: string
  organizationId?: string
  role?: 'owner' | 'admin' | 'member' | 'viewer'
  canWrite: boolean
}

async function assertCurrentMutationAuthority(
  deps: HostLoopDeps,
  record: SessionRecord,
  actor: SessionScheduleActor,
  task?: ScheduledTask,
  revoking = false,
): Promise<void> {
  if (!record.organizationId) return
  if (!deps.authorizeScheduledTaskPrincipal) throw new Error('current organization authority is unavailable')
  let role: 'owner' | 'admin' | 'member' | 'viewer'
  try {
    role = await deps.authorizeScheduledTaskPrincipal(record.organizationId, actor.principal)
  } catch {
    throw new Error('current organization authority denied or unavailable')
  }
  if (role === 'viewer') throw new Error('current viewer role cannot create or modify scheduled tasks')
  if (task) assertCanMutateTask({ ...actor, role }, task, revoking)
}

function resolveSessionScheduleActor(record: SessionRecord): SessionScheduleActor {
  const principal = record.principal?.trim() || 'local'
  if (record.organizationId) {
    return {
      ownerKey: `organization:${record.organizationId}`,
      principal,
      organizationId: record.organizationId,
      ...(record.organizationRole ? { role: record.organizationRole } : {}),
      canWrite: false,
    }
  }
  return {
    ownerKey: `principal:${principal}`,
    principal,
    canWrite: true,
  }
}

function assertCanMutateTask(
  actor: SessionScheduleActor,
  task: ScheduledTask,
  revoking: boolean,
): void {
  if (
    task.createdBy !== actor.principal &&
    !(revoking && (actor.role === 'owner' || actor.role === 'admin'))
  ) {
    throw new Error('only the original principal may change or resume delegated scheduled work')
  }
}

async function resolveAndValidateTarget(
  deps: HostLoopDeps,
  currentRecord: SessionRecord,
  actor: SessionScheduleActor,
  rawTarget: unknown,
): Promise<ScheduledTaskTarget> {
  if (rawTarget === undefined || rawTarget === null) {
    return await validatedSessionTarget(deps, currentRecord, actor)
  }
  if (typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    throw new Error('target must be an object with kind="session" or kind="workspace"')
  }
  const obj = rawTarget as Record<string, unknown>
  const kind = obj.kind ?? 'session'

  if (kind === 'session') {
    const targetSessionId =
      typeof obj.sessionId === 'string' && obj.sessionId.trim()
        ? obj.sessionId.trim()
        : currentRecord.sessionId
    const targetRecord = await loadSessionForActor(deps, actor, targetSessionId)
    if (!targetRecord) {
      throw new Error(`target session not found or unauthorized: ${targetSessionId}`)
    }
    return await validatedSessionTarget(deps, targetRecord, actor)
  }

  if (kind === 'workspace') {
    const workspaceId =
      typeof obj.workspaceId === 'string' && obj.workspaceId.trim()
        ? obj.workspaceId.trim()
        : currentRecord.workspaceId
    if (!workspaceId) {
      throw new Error('workspace target requires workspaceId (current session is not bound to a workspace)')
    }
    const workspaceName =
      typeof obj.workspaceName === 'string' && obj.workspaceName.trim()
        ? obj.workspaceName.trim()
        : workspaceId === currentRecord.workspaceId
          ? currentRecord.workspaceName
          : undefined
    const rawCwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : undefined
    const baseCwd = workspaceId === currentRecord.workspaceId ? currentRecord.state.cwd : undefined
    const cwd = rawCwd
      ? rawCwd === '.' && baseCwd
        ? baseCwd
        : !rawCwd.startsWith('/') && baseCwd?.startsWith('/')
          ? posix.resolve(baseCwd, rawCwd)
          : rawCwd
      : baseCwd

    // Verify workspace belongs to an accessible session in this Unit/organization
    if (workspaceId !== currentRecord.workspaceId) {
      const summaries = await deps.store.listSummaries(
        actor.organizationId ? { organizationId: actor.organizationId } : undefined,
      )
      const owned = summaries.some((s) => s.workspaceId === workspaceId)
      if (!owned) {
        throw new Error(`workspace not found or unauthorized: ${workspaceId}`)
      }
    }

    const target: ScheduledTaskTarget = {
      kind: 'workspace',
      workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      ...(cwd ? { cwd } : {}),
    }
    if (!deps.validateScheduledTaskTarget) {
      throw new Error('workspace target validation is unavailable')
    }
    await deps.validateScheduledTaskTarget(actor, target)
    return target
  }

  async function validatedSessionTarget(
    deps: HostLoopDeps,
    record: SessionRecord,
    actor: SessionScheduleActor,
  ): Promise<ScheduledTaskTarget> {
    assertNoResumableGoal(record)
    if (record.executionMode !== 'chat') {
      throw new Error('scheduled tasks cannot target autonomous or DAG sessions; use a workspace target')
    }
    const target: ScheduledTaskTarget = { kind: 'session', sessionId: record.sessionId }
    await deps.validateScheduledTaskTarget?.(actor, target)
    return target
  }

  throw new Error('target.kind must be "session" or "workspace"')
}

async function loadSessionForActor(
  deps: HostLoopDeps,
  actor: SessionScheduleActor,
  targetSessionId: string,
): Promise<SessionRecord | undefined> {
  const existing = deps.store.get(targetSessionId)
  const record =
    existing ??
    (await deps.store.load(targetSessionId, { recoverDangling: false }))
  if (!record) return undefined
  if (actor.organizationId) {
    if (record.organizationId !== actor.organizationId) return undefined
  } else if (record.organizationId) {
    return undefined
  }
  return record
}

async function resolveScheduledTaskStore(
  deps: HostLoopDeps,
  record: SessionRecord,
  now?: () => Date,
): Promise<ScheduledTaskStorage> {
  if (deps.scheduledTaskStore) return deps.scheduledTaskStore
  let pending = fallbackStores.get(deps.store)
  if (!pending) {
    const sessionsDir = dirname(dirname(record.logPath))
    const store = new ScheduledTaskStore(join(sessionsDir, '.scheduled-tasks'), now)
    pending = store.start(`local-tool-${process.pid}`).then(() => store)
    fallbackStores.set(deps.store, pending)
  }
  return await pending
}

function requiredTaskId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('task_id is required for this action')
  }
  return raw.trim()
}

function publicTaskView(task: ScheduledTask): Omit<ScheduledTask, 'ownerKey'> {
  const { ownerKey: _ownerKey, ...rest } = task
  return rest
}
