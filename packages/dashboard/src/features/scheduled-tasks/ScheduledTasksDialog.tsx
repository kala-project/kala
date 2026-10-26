import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import { CalendarClock, Check, ChevronRight, Clock3, History, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import {
  createScheduledTasksClient,
  type ScheduleSpec,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskSnapshot,
  type ScheduledTaskTarget,
  type ScheduledTasksClient,
} from '../../scheduled-tasks-client.js'

const DAYS = ['日', '一', '二', '三', '四', '五', '六'] as const
const SCHEDULE_OPTIONS: ReadonlyArray<{ kind: ScheduleSpec['kind']; label: string }> = [
  { kind: 'once', label: '一次' },
  { kind: 'daily', label: '每天' },
  { kind: 'interval', label: '每几天' },
  { kind: 'weekly', label: '每周' },
  { kind: 'monthly', label: '每月' },
]

type DialogProps = {
  open: boolean
  onOpenChange(open: boolean): void
  host: string
  token?: string
  target: ScheduledTaskTarget | null
  taskId?: string | null
  client?: ScheduledTasksClient
  onOpenSession?(sessionId: string): void
  sessionNames?: ReadonlyMap<string, string>
  onTasksChange?(): void
}

export type ScheduledTasksPanelProps = {
  /** The current Session target. For backwards compatibility a workspace target is also accepted. */
  target: ScheduledTaskTarget | null
  workspaceTarget?: Extract<ScheduledTaskTarget, { kind: 'workspace' }> | null
  host?: string
  token?: string
  client?: ScheduledTasksClient
  onOpen(target: ScheduledTaskTarget): void
  onTaskOpen?(taskId: string, target: ScheduledTaskTarget): void
  reloadKey?: unknown
}

type FormState = {
  prompt: string
  kind: ScheduleSpec['kind']
  onceAt: string
  timezone: string
  time: string
  daysOfWeek: number[]
  everyDays: string
  startDate: string
  daysOfMonth: string
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function localDateInput(date = new Date()): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 10)
}

function localDateTimeInput(date = new Date(Date.now() + 60 * 60 * 1000)): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

function initialForm(): FormState {
  const now = new Date()
  return {
    prompt: '',
    kind: 'once',
    onceAt: localDateTimeInput(),
    timezone: localTimezone(),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    daysOfWeek: [now.getDay()],
    everyDays: '3',
    startDate: localDateInput(),
    daysOfMonth: '1, 15',
  }
}

function targetMatches(left: ScheduledTaskTarget, right: ScheduledTaskTarget): boolean {
  return left.kind === right.kind && (left.kind === 'session'
    ? left.sessionId === (right as Extract<ScheduledTaskTarget, { kind: 'session' }>).sessionId
    : left.workspaceId === (right as Extract<ScheduledTaskTarget, { kind: 'workspace' }>).workspaceId)
}

type RequestIdentity = {
  open: boolean
  host: string | undefined
  token: string | undefined
  client: ScheduledTasksClient | null
  sessionId: string | undefined
  workspaceId: string | undefined
  taskId: string | null
}

type RequestChannel = 'load' | 'mutation' | 'history'
type RequestSnapshot = { identity: RequestIdentity; generation: number; channel: RequestChannel; request: number }
type RequestTracker = { identity: RequestIdentity; generation: number; nextRequest: number; latest: Record<RequestChannel, number> }

function requestIdentityMatches(left: RequestIdentity, right: RequestIdentity): boolean {
  return left.open === right.open
    && left.host === right.host
    && left.token === right.token
    && left.client === right.client
    && left.sessionId === right.sessionId
    && left.workspaceId === right.workspaceId
    && left.taskId === right.taskId
}

function targetIdentity(target: ScheduledTaskTarget | null | undefined): Pick<RequestIdentity, 'sessionId' | 'workspaceId'> {
  return {
    sessionId: target?.kind === 'session' ? target.sessionId : undefined,
    workspaceId: target?.kind === 'workspace' ? target.workspaceId : undefined,
  }
}

function newRequestTracker(identity: RequestIdentity, generation = 0): RequestTracker {
  return { identity, generation, nextRequest: 0, latest: { load: 0, mutation: 0, history: 0 } }
}

function beginRequest(tracker: RequestTracker, channel: RequestChannel): RequestSnapshot {
  const request = ++tracker.nextRequest
  tracker.latest[channel] = request
  return { identity: tracker.identity, generation: tracker.generation, channel, request }
}

function requestIsCurrent(tracker: RequestTracker, snapshot: RequestSnapshot): boolean {
  return tracker.generation === snapshot.generation
    && requestIdentityMatches(tracker.identity, snapshot.identity)
    && tracker.latest[snapshot.channel] === snapshot.request
}

function parseMonthDates(value: string): number[] {
  return [...new Set(value.split(/[，,\s]+/u).filter(Boolean).map(Number))].filter((day) => Number.isInteger(day) && day >= 1 && day <= 31).sort((a, b) => a - b)
}

function scheduleFromForm(form: FormState): ScheduleSpec {
  if (form.kind === 'once') return { kind: 'once', at: new Date(form.onceAt).toISOString() }
  const [hour = 0, minute = 0] = form.time.split(':').map(Number)
  if (form.kind === 'daily') return { kind: 'daily', timezone: form.timezone, hour, minute }
  if (form.kind === 'interval') return { kind: 'interval', timezone: form.timezone, hour, minute, everyDays: Number(form.everyDays), startDate: form.startDate }
  if (form.kind === 'monthly') return { kind: 'monthly', timezone: form.timezone, hour, minute, daysOfMonth: parseMonthDates(form.daysOfMonth) }
  return { kind: 'weekly', timezone: form.timezone, daysOfWeek: form.daysOfWeek, hour, minute }
}

function formFromTask(task: ScheduledTask): FormState {
  const base = initialForm()
  if (task.schedule.kind === 'once') return { ...base, prompt: task.prompt, kind: 'once', onceAt: localDateTimeInput(new Date(task.schedule.at)) }
  const time = `${String(task.schedule.hour).padStart(2, '0')}:${String(task.schedule.minute).padStart(2, '0')}`
  return {
    ...base,
    prompt: task.prompt,
    kind: task.schedule.kind,
    timezone: task.schedule.timezone,
    time,
    daysOfWeek: task.schedule.kind === 'weekly' ? [...task.schedule.daysOfWeek] : base.daysOfWeek,
    everyDays: task.schedule.kind === 'interval' ? String(task.schedule.everyDays) : base.everyDays,
    startDate: task.schedule.kind === 'interval' ? task.schedule.startDate : base.startDate,
    daysOfMonth: task.schedule.kind === 'monthly' ? task.schedule.daysOfMonth.join(', ') : base.daysOfMonth,
  }
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '尚未安排'
}

function scheduleTimezone(schedule: ScheduleSpec): string {
  return schedule.kind === 'once' ? '—' : schedule.timezone
}

function scheduleLabel(schedule: ScheduleSpec): string {
  if (schedule.kind === 'once') return `一次 · ${formatDate(schedule.at)}`
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  if (schedule.kind === 'daily') return `每天 · ${time}`
  if (schedule.kind === 'interval') return `每隔 ${schedule.everyDays} 天 · ${time}`
  if (schedule.kind === 'monthly') return `每月 ${schedule.daysOfMonth.join('、')} 日 · ${time}`
  return `每周${schedule.daysOfWeek.map((day) => DAYS[day]).join('、')} · ${time}`
}

function taskTitle(task: Pick<ScheduledTask, 'prompt'>): string {
  return task.prompt.split('\n').find((line) => line.trim())?.trim() || '未命名任务'
}

function targetLabel(target: ScheduledTaskTarget): string {
  if (target.kind === 'session') return `对话 · ${target.sessionId}`
  return `工作区 · ${target.workspaceName ?? target.workspaceId}`
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

export function ScheduledTasksTrigger({ target, onOpen, className, scope: requestedScope }: { target: ScheduledTaskTarget | null; onOpen(): void; className?: string; scope?: ScheduledTaskTarget['kind'] }): JSX.Element {
  const scope = target?.kind ?? requestedScope ?? 'session'
  return (
    <Button type="button" variant="outline" size="sm" disabled={target === null} onClick={onOpen} className={className} aria-label={`Scheduled tasks for this ${scope}`} title={target === null ? 'Select a workspace first' : `Scheduled tasks for this ${scope}`} data-testid={`scheduled-tasks-${scope}-trigger`}>
      <CalendarClock className="mr-1.5 h-4 w-4" aria-hidden />
      定时任务
    </Button>
  )
}

export function ScheduledTasksPanel({ target, workspaceTarget, host, token, client: suppliedClient, onOpen, onTaskOpen, reloadKey }: ScheduledTasksPanelProps): JSX.Element {
  const client = useMemo(() => suppliedClient ?? (host ? createScheduledTasksClient({ host, ...(token ? { token } : {}) }) : null), [host, suppliedClient, token])
  const sessionTarget = target?.kind === 'session' ? target : null
  const resolvedWorkspaceTarget = workspaceTarget ?? (target?.kind === 'workspace' ? target : null)
  const [scope, setScope] = useState<ScheduledTaskTarget['kind']>(target?.kind ?? 'session')
  const [tasks, setTasks] = useState<readonly ScheduledTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelIdentity: RequestIdentity = {
    open: true,
    host,
    token,
    client,
    sessionId: sessionTarget?.sessionId,
    workspaceId: resolvedWorkspaceTarget?.workspaceId,
    taskId: null,
  }
  const requestTracker = useRef<RequestTracker>(newRequestTracker(panelIdentity))
  if (!requestIdentityMatches(requestTracker.current.identity, panelIdentity)) {
    requestTracker.current = newRequestTracker(panelIdentity, requestTracker.current.generation + 1)
    setTasks([])
    setLoading(false)
    setError(null)
  }

  const load = useCallback(async (): Promise<void> => {
    if (!client) return
    const request = beginRequest(requestTracker.current, 'load')
    setLoading(true)
    setError(null)
    try {
      const loadedTasks = await client.list()
      if (requestIsCurrent(requestTracker.current, request)) setTasks(loadedTasks)
    } catch (caught) {
      if (requestIsCurrent(requestTracker.current, request)) setError(errorMessage(caught))
    } finally {
      if (requestIsCurrent(requestTracker.current, request)) setLoading(false)
    }
  }, [client, host, resolvedWorkspaceTarget?.workspaceId, sessionTarget?.sessionId, token])

  useEffect(() => { void load() }, [load, reloadKey])

  const activeTarget = scope === 'session' ? sessionTarget : resolvedWorkspaceTarget
  const visibleTasks = activeTarget ? tasks.filter((task) => targetMatches(task.target, activeTarget)) : []

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="scheduled-tasks-panel">
      <div className="shrink-0 px-4 pt-3">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/65 p-1" role="tablist" aria-label="计划范围">
          <button type="button" role="tab" aria-selected={scope === 'session'} onClick={() => setScope('session')} className={scope === 'session' ? 'rounded-lg bg-card py-2 text-xs font-medium shadow-sm' : 'py-2 text-xs text-muted-foreground'}>此对话</button>
          <button type="button" role="tab" aria-selected={scope === 'workspace'} onClick={() => setScope('workspace')} className={scope === 'workspace' ? 'rounded-lg bg-card py-2 text-xs font-medium shadow-sm' : 'py-2 text-xs text-muted-foreground'}>此工作区</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-semibold text-muted-foreground">计划 · {visibleTasks.length}</span>
          <button type="button" disabled={!activeTarget} onClick={() => activeTarget && onOpen(activeTarget)} className="inline-flex items-center gap-1 text-xs font-medium text-primary disabled:opacity-40"><Plus className="size-3.5" aria-hidden />新建</button>
        </div>
        {!client ? <p className="mt-5 text-center text-xs text-muted-foreground">连接后显示计划</p> : null}
        {loading ? <p role="status" className="mt-5 text-center text-xs text-muted-foreground">正在加载计划…</p> : null}
        {error ? <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error}<Button type="button" variant="ghost" size="sm" onClick={() => void load()}>重试</Button></div> : null}
        {!loading && !error && client && !activeTarget ? <p className="mt-5 text-center text-xs text-muted-foreground">当前范围不可用</p> : null}
        {!loading && !error && client && activeTarget && visibleTasks.length === 0 ? <p className="mt-5 text-center text-xs text-muted-foreground">此范围还没有计划</p> : null}
        <div className="mt-3 space-y-2">
          {visibleTasks.map((task) => (
            <button key={task.id} type="button" onClick={() => onTaskOpen?.(task.id, task.target)} className="w-full rounded-xl border border-border/70 bg-card p-3 text-left hover:bg-muted/35" data-testid={`scheduled-task-card-${task.id}`}>
              <span className="flex items-start justify-between gap-2"><span className="line-clamp-2 text-sm font-medium leading-5">{taskTitle(task)}</span><ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /></span>
              <span className="mt-2 block text-xs text-muted-foreground">{scheduleLabel(task.schedule)}</span>
              <span className="mt-2 flex items-center justify-between gap-2 text-[11px]"><span className={task.status === 'active' ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>{task.status === 'active' ? '运行中' : '已暂停'}</span><span className="truncate text-muted-foreground">下次 {formatDate(task.nextRunAt)}</span></span>
            </button>
          ))}
        </div>
        <button type="button" disabled={!activeTarget} onClick={() => activeTarget && onOpen(activeTarget)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-xs font-medium text-muted-foreground hover:border-primary/50 hover:text-primary disabled:opacity-40"><Plus className="size-4" aria-hidden />创建新的定时任务</button>
      </div>
      <div className="shrink-0 border-t border-border/40 px-5 py-3 text-[11px] text-muted-foreground">显示时区 · {localTimezone()}</div>
    </div>
  )
}

function ScheduleEditor({ form, setForm }: { form: FormState; setForm: Dispatch<SetStateAction<FormState>> }): JSX.Element {
  return (
    <div className="space-y-4">
      <label className="block text-xs font-medium text-muted-foreground">执行指令<textarea required rows={3} value={form.prompt} onChange={(event) => setForm((previous) => ({ ...previous, prompt: event.target.value }))} className="mt-2 w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label>
      <fieldset><legend className="text-xs font-medium text-muted-foreground">重复方式</legend><div className="mt-2 flex flex-wrap gap-2">{SCHEDULE_OPTIONS.map(({ kind, label }) => <button type="button" key={kind} aria-pressed={form.kind === kind} onClick={() => setForm((previous) => ({ ...previous, kind }))} className={form.kind === kind ? 'rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground' : 'rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground'}>{label}</button>)}</div></fieldset>
      {form.kind === 'once' ? <label className="block text-xs font-medium text-muted-foreground">日期和时间<input required type="datetime-local" value={form.onceAt} onChange={(event) => setForm((previous) => ({ ...previous, onceAt: event.target.value }))} className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /></label> : null}
      {form.kind === 'interval' ? <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium text-muted-foreground">每隔几天<input required aria-label="每隔几天" type="number" min="1" max="3650" value={form.everyDays} onChange={(event) => setForm((previous) => ({ ...previous, everyDays: event.target.value }))} className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /></label><label className="text-xs font-medium text-muted-foreground">从哪天开始<input required type="date" value={form.startDate} onChange={(event) => setForm((previous) => ({ ...previous, startDate: event.target.value }))} className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /></label></div> : null}
      {form.kind === 'weekly' ? <fieldset><legend className="text-xs font-medium text-muted-foreground">星期</legend><div className="mt-2 flex flex-wrap gap-2">{DAYS.map((day, index) => <label key={day} className={form.daysOfWeek.includes(index) ? 'flex size-8 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground' : 'flex size-8 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground'}><input className="sr-only" type="checkbox" aria-label={`星期${day}`} checked={form.daysOfWeek.includes(index)} onChange={(event) => setForm((previous) => ({ ...previous, daysOfWeek: event.target.checked ? [...previous.daysOfWeek, index].sort((a, b) => a - b) : previous.daysOfWeek.filter((item) => item !== index) }))} />{day}</label>)}</div></fieldset> : null}
      {form.kind === 'monthly' ? <label className="block text-xs font-medium text-muted-foreground">每月日期<input required aria-label="每月日期" value={form.daysOfMonth} onChange={(event) => setForm((previous) => ({ ...previous, daysOfMonth: event.target.value }))} placeholder="例如：1, 15, 28" className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /><span className="mt-1 block text-[11px] font-normal">输入 1–31，可用逗号分隔</span></label> : null}
      {form.kind !== 'once' ? <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium text-muted-foreground">执行时间<input required type="time" value={form.time} onChange={(event) => setForm((previous) => ({ ...previous, time: event.target.value }))} className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /></label><label className="text-xs font-medium text-muted-foreground">时区<input required list="scheduled-task-timezones" value={form.timezone} onChange={(event) => setForm((previous) => ({ ...previous, timezone: event.target.value }))} className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /><datalist id="scheduled-task-timezones"><option value={localTimezone()} /><option value="UTC" /></datalist></label></div> : null}
    </div>
  )
}

export function ScheduledTasksDialog({ open, onOpenChange, host, token, target, taskId = null, client: suppliedClient, onOpenSession, onTasksChange, sessionNames }: DialogProps): JSX.Element {
  const client = useMemo(() => suppliedClient ?? createScheduledTasksClient({ host, ...(token ? { token } : {}) }), [host, suppliedClient, token])
  const [task, setTask] = useState<ScheduledTask | null>(null)
  const [archivedTask, setArchivedTask] = useState<ScheduledTaskSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'details' | 'history'>('details')
  const [form, setForm] = useState<FormState>(() => initialForm())
  const [history, setHistory] = useState<readonly ScheduledRun[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const dialogIdentity: RequestIdentity = { open, host, token, client, ...targetIdentity(target), taskId }
  const requestTracker = useRef<RequestTracker>(newRequestTracker(dialogIdentity))
  if (!requestIdentityMatches(requestTracker.current.identity, dialogIdentity)) {
    requestTracker.current = newRequestTracker(dialogIdentity, requestTracker.current.generation + 1)
    // A render-phase reset prevents even one committed frame from retaining the previous identity's data.
    setTask(null)
    setArchivedTask(null)
    setLoading(false)
    setSaving(false)
    setError(null)
    setEditing(false)
    setTab('details')
    setForm(initialForm())
    setHistory([])
    setHistoryLoading(false)
  }

  const loadTask = useCallback(async (): Promise<void> => {
    if (!taskId) return
    const request = beginRequest(requestTracker.current, 'load')
    setLoading(true)
    setError(null)
    try {
      const found = (await client.list()).find((item) => item.id === taskId && (!target || targetMatches(item.target, target))) ?? null
      if (!requestIsCurrent(requestTracker.current, request)) return
      if (found) {
        setTask(found)
        return
      }

      const loadedHistory = await client.history(taskId)
      if (!requestIsCurrent(requestTracker.current, request)) return
      const snapshot = loadedHistory.find((run) => run.task.id === taskId && (!target || targetMatches(run.task.target, target)))?.task ?? null
      setHistory(snapshot ? loadedHistory : [])
      setArchivedTask(snapshot)
      if (!snapshot) setError('找不到这个定时任务')
    } catch (caught) {
      if (requestIsCurrent(requestTracker.current, request)) setError(errorMessage(caught))
    } finally {
      if (requestIsCurrent(requestTracker.current, request)) setLoading(false)
    }
  }, [client, host, target, taskId, token])

  useEffect(() => {
    if (!open) return
    setTask(null)
    setArchivedTask(null)
    setError(null)
    setEditing(false)
    setTab('details')
    setHistory([])
    setForm(initialForm())
    if (taskId) void loadTask()
  }, [loadTask, open, taskId])

  const valid = Boolean(target && form.prompt.trim())
    && (form.kind !== 'weekly' || form.daysOfWeek.length > 0)
    && (form.kind !== 'interval' || (Number.isInteger(Number(form.everyDays)) && Number(form.everyDays) >= 1 && Number(form.everyDays) <= 3650 && Boolean(form.startDate)))
    && (form.kind !== 'monthly' || parseMonthDates(form.daysOfMonth).length > 0)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!target || !valid) return
    setSaving(true)
    setError(null)
    const request = beginRequest(requestTracker.current, 'mutation')
    try {
      const draft = { prompt: form.prompt.trim(), target, schedule: scheduleFromForm(form) }
      const saved = task ? await client.update(task.id, draft) : await client.create(draft)
      if (!requestIsCurrent(requestTracker.current, request)) return
      onTasksChange?.()
      if (task) {
        setTask(saved)
        setEditing(false)
      } else {
        onOpenChange(false)
      }
    } catch (caught) {
      if (requestIsCurrent(requestTracker.current, request)) setError(errorMessage(caught))
    } finally {
      if (requestIsCurrent(requestTracker.current, request)) setSaving(false)
    }
  }

  const runAction = async (action: () => Promise<ScheduledTask>): Promise<void> => {
    setError(null)
    const request = beginRequest(requestTracker.current, 'mutation')
    try {
      const updatedTask = await action()
      if (!requestIsCurrent(requestTracker.current, request)) return
      setTask(updatedTask)
      onTasksChange?.()
    } catch (caught) {
      if (requestIsCurrent(requestTracker.current, request)) setError(errorMessage(caught))
    }
  }

  const showHistory = async (): Promise<void> => {
    const selectedTaskId = task?.id ?? archivedTask?.id
    if (!selectedTaskId) return
    setTab('history')
    if (history.length > 0 || archivedTask) return
    setHistoryLoading(true)
    setError(null)
    const request = beginRequest(requestTracker.current, 'history')
    try {
      const loadedHistory = await client.history(selectedTaskId)
      if (requestIsCurrent(requestTracker.current, request)) setHistory(loadedHistory)
    } catch (caught) {
      if (requestIsCurrent(requestTracker.current, request)) setError(errorMessage(caught))
    } finally {
      if (requestIsCurrent(requestTracker.current, request)) setHistoryLoading(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!task || !window.confirm('删除这个定时任务？')) return
    setError(null)
    const request = beginRequest(requestTracker.current, 'mutation')
    try {
      await client.delete(task.id)
      if (!requestIsCurrent(requestTracker.current, request)) return
      onTasksChange?.()
      onOpenChange(false)
    } catch (caught) {
      if (requestIsCurrent(requestTracker.current, request)) setError(errorMessage(caught))
    }
  }

  const isCreate = !taskId
  const displayedTask = task ?? archivedTask
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(dialogMobileSheetClassName, 'max-h-[min(46rem,calc(var(--ak-viewport-h,100dvh)-1rem))] max-w-xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden gap-0 p-0')} data-testid="scheduled-tasks-dialog">
        <DialogHeader className="border-b border-border/60 px-5 py-5 sm:px-7">
          <DialogTitle>{isCreate ? '创建任务' : displayedTask ? taskTitle(displayedTask) : '任务详情'}</DialogTitle>
          <DialogDescription className="sr-only">{isCreate ? '设置执行指令和计划规则' : '查看任务详情和运行记录'}</DialogDescription>
        </DialogHeader>
        {loading ? <DialogBody className="p-7"><p role="status" className="text-sm text-muted-foreground">正在加载任务…</p></DialogBody> : null}
        {!loading && error ? <div role="alert" className="mx-5 mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}{taskId && !displayedTask ? <Button type="button" variant="ghost" size="sm" onClick={() => void loadTask()}>重试</Button> : null}</div> : null}
        {!loading && isCreate ? <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col"><DialogBody className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7"><ScheduleEditor form={form} setForm={setForm} /></DialogBody><div className="flex justify-end border-t border-border/60 px-5 py-4 sm:px-7"><Button type="submit" disabled={!valid || saving}>{saving ? '正在保存…' : '创建计划'}</Button></div></form> : null}
        {!loading && displayedTask ? <div className="flex min-h-0 flex-col"><div className="flex gap-1 border-b border-border/50 px-5 pt-3 sm:px-7" role="tablist" aria-label="任务详情标签"><button type="button" role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')} className={tab === 'details' ? 'border-b-2 border-primary px-3 pb-3 text-sm font-medium text-primary' : 'px-3 pb-3 text-sm text-muted-foreground'}>详情</button><button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => void showHistory()} className={tab === 'history' ? 'border-b-2 border-primary px-3 pb-3 text-sm font-medium text-primary' : 'px-3 pb-3 text-sm text-muted-foreground'}>运行记录</button></div>
          <DialogBody className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
            {tab === 'details' && editing && task ? <form onSubmit={(event) => void submit(event)} className="space-y-5"><ScheduleEditor form={form} setForm={setForm} /><div className="flex gap-2"><Button type="submit" disabled={!valid || saving}>{saving ? '正在保存…' : '保存更改'}</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>取消</Button></div></form> : null}
            {tab === 'details' && !editing && task ? <div className="space-y-5"><div className="rounded-xl bg-muted/60 px-4 py-3"><p className="text-xs font-medium text-muted-foreground">执行指令</p><p className="mt-1.5 whitespace-pre-wrap text-sm leading-6">{task.prompt}</p></div><div className="grid grid-cols-2 gap-x-5 gap-y-5 text-sm"><div><p className="text-xs text-muted-foreground">计划</p><p className="mt-1 font-medium">{scheduleLabel(task.schedule)}</p></div><div><p className="text-xs text-muted-foreground">下一次执行</p><p className="mt-1 font-medium">{formatDate(task.nextRunAt)}</p></div><div><p className="text-xs text-muted-foreground">时区</p><p className="mt-1 font-medium">{scheduleTimezone(task.schedule)}</p></div><div><p className="text-xs text-muted-foreground">状态</p><p className="mt-1 font-medium">{task.status === 'active' ? '运行中' : '已暂停'}</p></div>{task.createdBy ? <div><p className="text-xs text-muted-foreground">创建者</p><p className="mt-1 font-medium">{task.createdBy}</p></div> : null}</div><button type="button" onClick={() => void showHistory()} className="flex w-full items-center justify-between rounded-xl border border-border px-4 py-3 text-left text-sm hover:bg-muted/40"><span className="inline-flex items-center gap-2"><History className="size-4 text-primary" aria-hidden />查看过去的运行</span><ChevronRight className="size-4 text-muted-foreground" aria-hidden /></button><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void runAction(() => task.status === 'active' ? client.pause(task.id) : client.resume(task.id))}>{task.status === 'active' ? <Pause className="mr-1 size-3.5" aria-hidden /> : <Play className="mr-1 size-3.5" aria-hidden />}{task.status === 'active' ? '暂停' : '恢复'}</Button><Button type="button" variant="outline" size="sm" onClick={() => { setForm(formFromTask(task)); setEditing(true) }}><Pencil className="mr-1 size-3.5" aria-hidden />编辑</Button><Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => void remove()}><Trash2 className="mr-1 size-3.5" aria-hidden />删除</Button></div></div> : null}
            {tab === 'details' && archivedTask ? <div className="space-y-5"><div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3"><p className="text-xs font-medium text-muted-foreground">已删除的任务 · 只读</p></div><div className="rounded-xl bg-muted/60 px-4 py-3"><p className="text-xs font-medium text-muted-foreground">执行指令</p><p className="mt-1.5 whitespace-pre-wrap text-sm leading-6">{archivedTask.prompt}</p></div><div className="grid grid-cols-2 gap-x-5 gap-y-5 text-sm"><div><p className="text-xs text-muted-foreground">目标</p><p className="mt-1 font-medium">{targetLabel(archivedTask.target)}</p></div><div><p className="text-xs text-muted-foreground">创建者</p><p className="mt-1 font-medium">{archivedTask.createdBy}</p></div></div><button type="button" onClick={() => void showHistory()} className="flex w-full items-center justify-between rounded-xl border border-border px-4 py-3 text-left text-sm hover:bg-muted/40"><span className="inline-flex items-center gap-2"><History className="size-4 text-primary" aria-hidden />查看过去的运行</span><ChevronRight className="size-4 text-muted-foreground" aria-hidden /></button></div> : null}
            {tab === 'history' ? <div>{historyLoading ? <p role="status" className="text-sm text-muted-foreground">正在加载运行记录…</p> : history.length === 0 ? <p className="text-sm text-muted-foreground">还没有运行记录</p> : <ol>{history.map((run, index) => <li key={run.occurrenceId} className="relative flex gap-3 pb-5"><div className="flex flex-col items-center"><span className={run.status === 'failed' || run.status === 'needs_review' ? 'z-10 flex size-7 items-center justify-center rounded-full bg-amber-500/10 text-amber-700' : 'z-10 flex size-7 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700'}>{run.status === 'enqueued' ? <Check className="size-3.5" aria-hidden /> : <Clock3 className="size-3.5" aria-hidden />}</span>{index < history.length - 1 ? <span className="mt-1 h-full w-px bg-border" /> : null}</div><div className="min-w-0 flex-1 rounded-xl border border-border/70 bg-card p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{run.status.replace('_', ' ')}</span><time className="text-[11px] text-muted-foreground" dateTime={run.updatedAt ?? run.scheduledFor}>{formatDate(run.updatedAt ?? run.scheduledFor)}</time></div>{run.sessionId ? <button type="button" className="mt-2 text-xs font-medium text-primary" onClick={() => onOpenSession?.(run.sessionId!)}>打开对话 {sessionNames?.get(run.sessionId) || '未命名对话'}</button> : null}<details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">时间详情</summary><dl className="mt-1 space-y-1"><div><dt className="inline">计划时间：</dt><dd className="inline">{formatDate(run.scheduledFor)}</dd></div>{run.claimedAt ? <div><dt className="inline">领取派发：</dt><dd className="inline">{formatDate(run.claimedAt)}</dd></div> : null}{run.updatedAt ? <div><dt className="inline">更新时间：</dt><dd className="inline">{formatDate(run.updatedAt)}</dd></div> : null}</dl></details>{run.error ? <p className="mt-2 text-xs text-destructive">{run.error}</p> : null}</div></li>)}</ol>}</div> : null}
          </DialogBody>
        </div> : null}
      </DialogContent>
    </Dialog>
  )
}
