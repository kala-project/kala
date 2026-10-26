import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Bell, ChevronRight, CircleAlert, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  createScheduledTasksClient,
  type ScheduledTaskInbox as ScheduledTaskInboxSnapshot,
  type ScheduledTaskInboxItem,
} from '../../scheduled-tasks-client.js'

const POLL_INTERVAL_MS = 30_000
const MAX_VISIBLE_ITEMS = 5
const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 8

export type ScheduledTaskInboxProps = {
  host: string
  token?: string
  onOpenTask: (taskId: string) => void
  onOpenSession?: (sessionId: string) => void
  sessionNames?: ReadonlyMap<string, string>
}

type InboxState = ScheduledTaskInboxSnapshot & {
  identity: string
  loading: boolean
  error: string | null
}

const emptyState = (identity: string): InboxState => ({
  identity,
  items: [],
  unreadCount: 0,
  loading: true,
  error: null,
})

const statusDetails: Record<ScheduledTaskInboxItem['status'], { className: string }> = {
  enqueued: { className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  failed: { className: 'bg-destructive/10 text-destructive' },
  needs_review: { className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function formatScheduledTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ScheduledTaskInbox({ host, token, onOpenTask, onOpenSession, sessionNames }: ScheduledTaskInboxProps) {
  const { t } = useTranslation()
  const identity = `${host}\u0000${token ?? ''}`
  const client = useMemo(() => createScheduledTasksClient({ host, token }), [host, token])
  const [state, setState] = useState<InboxState>(() => emptyState(identity))
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ position: 'fixed', top: VIEWPORT_MARGIN, left: VIEWPORT_MARGIN, width: POPOVER_WIDTH })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)
  const pendingSeenRef = useRef(new Set<string>())
  const acknowledgementControllersRef = useRef(new Set<AbortController>())

  const currentState = state.identity === identity ? state : emptyState(identity)
  const visibleItems = currentState.items.slice(page * MAX_VISIBLE_ITEMS, (page + 1) * MAX_VISIBLE_ITEMS)

  useEffect(() => {
    setPage((previous) => Math.min(previous, Math.max(0, Math.ceil(currentState.items.length / MAX_VISIBLE_ITEMS) - 1)))
  }, [currentState.items.length, identity])

  useEffect(() => {
    const generation = ++generationRef.current
    let disposed = false
    let requestController: AbortController | null = null

    setState(emptyState(identity))

    const load = async () => {
      requestController?.abort()
      const controller = new AbortController()
      requestController = controller
      try {
        const result = await client.inbox({ signal: controller.signal })
        if (disposed || generationRef.current !== generation) return
        setState({ identity, ...result, loading: false, error: null })
      } catch (error) {
        if (disposed || generationRef.current !== generation || isAbortError(error)) return
        setState((previous) => previous.identity === identity
          ? { ...previous, loading: false, error: error instanceof Error ? error.message : t('scheduledTaskInbox.loadError') }
          : previous)
      }
    }

    void load()
    const interval = window.setInterval(() => { void load() }, POLL_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
      requestController?.abort()
      for (const controller of acknowledgementControllersRef.current) controller.abort()
      acknowledgementControllersRef.current.clear()
      pendingSeenRef.current.clear()
    }
  }, [client, identity])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
    setPopoverStyle({
      position: 'fixed',
      top: Math.min(rect.bottom + VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN)),
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.right - POPOVER_WIDTH, maxLeft)),
      width: POPOVER_WIDTH,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, updatePosition])

  const unseenVisibleIds = open ? visibleItems.filter((item) => !item.seen).map((item) => item.occurrenceId) : []
  const acknowledgementKey = unseenVisibleIds.join('\u0000')

  useEffect(() => {
    if (!open || !acknowledgementKey) return
    const occurrenceIds = acknowledgementKey.split('\u0000')
    const pendingKeys = occurrenceIds.map((occurrenceId) => `${identity}\u0000${occurrenceId}`)
    const newIds = occurrenceIds.filter((_, index) => !pendingSeenRef.current.has(pendingKeys[index]!))
    if (newIds.length === 0) return

    const controller = new AbortController()
    const generation = generationRef.current
    const ownPendingKeys = newIds.map((occurrenceId) => `${identity}\u0000${occurrenceId}`)
    ownPendingKeys.forEach((key) => pendingSeenRef.current.add(key))
    acknowledgementControllersRef.current.add(controller)

    void client.markInboxSeen(newIds, { signal: controller.signal }).then((result) => {
      if (generationRef.current !== generation) return
      const acknowledged = new Set(result.acknowledged)
      setState((previous) => previous.identity === identity ? {
        ...previous,
        unreadCount: result.unreadCount,
        items: previous.items.map((item) => acknowledged.has(item.occurrenceId) ? { ...item, seen: true } : item),
      } : previous)
    }).catch((error: unknown) => {
      if (!isAbortError(error) && generationRef.current === generation) {
        setState((previous) => previous.identity === identity
          ? { ...previous, error: error instanceof Error ? error.message : t('scheduledTaskInbox.seenError') }
          : previous)
      }
    }).finally(() => {
      acknowledgementControllersRef.current.delete(controller)
      ownPendingKeys.forEach((key) => pendingSeenRef.current.delete(key))
    })
  }, [acknowledgementKey, client, identity, open])

  const unreadLabel = t('scheduledTaskInbox.unread', { count: currentState.unreadCount })
  const popover = open && typeof document !== 'undefined' ? createPortal(
    <div
      ref={popoverRef}
      id="scheduled-task-inbox-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="scheduled-task-inbox-title"
      className="z-[100] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
      style={popoverStyle}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <h2 id="scheduled-task-inbox-title" className="text-sm font-semibold">{t('scheduledTaskInbox.title')}</h2>
          {currentState.unreadCount > 0 ? <p className="text-xs text-muted-foreground">{unreadLabel}</p> : null}
        </div>
        <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('scheduledTaskInbox.close')} onClick={() => setOpen(false)}>
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="max-h-[22rem] overflow-y-auto p-1.5">
        {currentState.loading ? (
          <div role="status" className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> {t('scheduledTaskInbox.loading')}
          </div>
        ) : currentState.error && currentState.items.length === 0 ? (
          <div role="alert" className="flex gap-2 px-3 py-6 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{currentState.error}</span>
          </div>
        ) : visibleItems.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('scheduledTaskInbox.empty')}</p>
        ) : (
          <>
            {visibleItems.map((item) => {
              const details = statusDetails[item.status]
              const target = item.target
              const sessionId = item.sessionId ?? (target?.kind === 'session' ? target.sessionId : undefined)
              const sessionName = sessionId ? sessionNames?.get(sessionId) || t('scheduledTaskInbox.unnamedSession') : undefined
              return (
                <div key={item.occurrenceId} className="rounded-lg border-b border-border/50 last:border-0">
                <button
                  type="button"
                  className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setOpen(false)
                    onOpenTask(item.taskId)
                  }}
                >
                  <span className={`size-2 shrink-0 rounded-full ${item.seen ? 'bg-muted-foreground/30' : 'bg-primary'}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold" title={item.taskLabel}>{item.taskLabel || t('scheduledTaskInbox.taskFallback', { id: item.taskId })}</span>
                    <span className="mt-1 block break-all text-[11px] text-muted-foreground">
                      {target?.kind === 'workspace'
                        ? t('scheduledTaskInbox.workspace', { name: target.workspaceName || target.workspaceId })
                        : sessionName ? t('scheduledTaskInbox.session', { name: sessionName }) : t('scheduledTaskInbox.contextUnavailable')}
                    </span>
                    {target?.kind === 'workspace' && sessionName ? <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={sessionName}>{t('scheduledTaskInbox.session', { name: sessionName })}</span> : null}
                    {target?.kind === 'workspace' && target.cwd ? <span className="block truncate text-[11px] text-muted-foreground" title={target.cwd}>{target.cwd}</span> : null}
                    <span className="flex items-center gap-2">
                      <span className={`mt-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${details.className}`}>{t(`scheduledTaskInbox.status.${item.status}`)}</span>
                    </span>
                    <time className="mt-1 block text-[11px] text-muted-foreground" dateTime={item.updatedAt}>{t('scheduledTaskInbox.updatedAt', { time: formatScheduledTime(item.updatedAt) })}</time>
                    <span className="mt-1 block text-[11px] text-muted-foreground">{t(`scheduledTaskInbox.outcome.${item.status}`)}</span>
                    {item.error ? <span className="mt-1 block whitespace-pre-wrap break-words text-xs text-destructive">{item.error}</span> : null}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                </button>
                {item.sessionId && onOpenSession ? <button type="button" className="mb-2 ml-7 text-xs text-primary hover:underline" onClick={() => { setOpen(false); onOpenSession(item.sessionId!) }}>{t('scheduledTaskInbox.openSession')}</button> : null}
                </div>
              )
            })}
            {currentState.items.length > MAX_VISIBLE_ITEMS ? (
              <div className="flex items-center justify-between border-t border-border px-2.5 py-2 text-xs">
                <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} className="text-primary disabled:text-muted-foreground">{t('scheduledTaskInbox.newer')}</button>
                <span className="text-muted-foreground">{page * MAX_VISIBLE_ITEMS + 1}–{Math.min((page + 1) * MAX_VISIBLE_ITEMS, currentState.items.length)} / {currentState.items.length}</span>
                <button type="button" disabled={(page + 1) * MAX_VISIBLE_ITEMS >= currentState.items.length} onClick={() => setPage((value) => value + 1)} className="text-primary disabled:text-muted-foreground">{t('scheduledTaskInbox.older')}</button>
              </div>
            ) : null}
            {currentState.error ? <p role="alert" className="px-2.5 py-2 text-xs text-destructive">{currentState.error}</p> : null}
          </>
        )}
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('scheduledTaskInbox.trigger', { unread: unreadLabel })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="scheduled-task-inbox-popover"
        onClick={() => { if (!open) setPage(0); setOpen((value) => !value) }}
      >
        <Bell className="size-4" aria-hidden="true" />
        {currentState.unreadCount > 0 ? (
          <span className="absolute right-1 top-1 size-2 rounded-full bg-destructive ring-2 ring-background" aria-hidden="true" />
        ) : null}
      </button>
      {popover}
    </>
  )
}
