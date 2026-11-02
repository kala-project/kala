import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, CircleDot, Layers3, Loader2, MessageSquareText, Wrench, XCircle } from 'lucide-react'

import type { CachedSessionView } from '../../session-view-cache.js'
import { cn } from '../../lib/utils.js'
import { useSessionPreview, type SessionPreviewStore } from './session-preview-store.js'
import { projectSessionPreviewSummary, type SessionPreviewSummary } from './session-preview-items.js'

export type SessionPreviewAnchor = {
  sessionId: string
  label: string
  rect: DOMRect
}

type Props = {
  anchor: SessionPreviewAnchor | null
  previewRef?: Ref<HTMLDivElement>
  previewStore?: SessionPreviewStore
  getCachedSessionView?: (sessionId: string) => CachedSessionView | null
  subscribeCachedSessionView?: (sessionId: string, listener: () => void) => () => void
  onHoverChange(hovering: boolean): void
}

export function SessionHoverPreview({ anchor, previewRef, previewStore, getCachedSessionView, subscribeCachedSessionView, onHoverChange }: Props): JSX.Element | null {
  const [ready, setReady] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setReady(false)
    if (!anchor || (!previewStore && !getCachedSessionView)) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setReady(true)
    }, 50)
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [anchor?.sessionId, getCachedSessionView, previewStore])

  useEffect(() => {
    if (!ready || !anchor || !previewStore) return
    return previewStore.watch(anchor.sessionId)
  }, [anchor?.sessionId, previewStore, ready])

  const [cacheVersion, setCacheVersion] = useState(0)
  useEffect(() => {
    if (!ready || !anchor || previewStore || !subscribeCachedSessionView) return
    return subscribeCachedSessionView(anchor.sessionId, () => setCacheVersion((version) => version + 1))
  }, [anchor?.sessionId, previewStore, ready, subscribeCachedSessionView])

  const snapshot = useSessionPreview(previewStore, ready ? anchor?.sessionId ?? null : null)
  const cached = snapshot?.view ?? (ready && anchor ? getCachedSessionView?.(anchor.sessionId) ?? null : null)
  const summary = useMemo(
    () => cached?.state ? projectSessionPreviewSummary({
      messages: cached.state.messages,
      timeline: cached.timeline,
      state: cached.state,
      queuedMessages: cached.queuedMessages.length,
    }) : null,
    [cached?.state, cached?.timeline, cached?.queuedMessages.length, cacheVersion],
  )

  if (!anchor || !cached || cached.hydratedSessionId !== anchor.sessionId || !summary) return null

  const position = previewPosition(anchor.rect)
  return createPortal(
    <div
      ref={previewRef}
      className={cn(
        'fixed z-50 flex max-h-[min(32rem,calc(100vh-2rem))] min-h-0 w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-2xl',
        'ring-1 ring-black/5 dark:ring-white/10',
      )}
      style={{ left: position.left, top: position.top }}
      data-testid="session-hover-preview"
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-11 flex-none items-center justify-between gap-3 border-b border-border/60 bg-muted/25 px-3.5">
        <div className="min-w-0 truncate text-xs font-semibold" title={anchor.label}>{anchor.label}</div>
        <div className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 flex-none rounded-full', snapshot?.freshness === 'live' ? 'bg-emerald-500' : snapshot?.freshness === 'stale' ? 'bg-amber-500' : 'bg-slate-400')} aria-hidden="true" />
          <span className="sr-only" data-testid="session-hover-preview-freshness">{snapshot?.freshness ?? 'cached'}</span>
          <span className="max-w-32 truncate" title={cached.selectedModel ?? undefined}>{shortModel(cached.selectedModel)}</span>
        </div>
      </div>
      <ScrollArea className="min-h-0 overscroll-contain" data-testid="session-hover-preview-summary" contentClassName="p-3 min-h-full">
        <ActivitySummary activity={summary.activity} />
        <div className="mt-3 grid gap-3">
          {summary.goal ? <SummarySection icon={<MessageSquareText className="h-3.5 w-3.5" />} label="Current request" text={summary.goal} testId="session-preview-goal" /> : null}
          {summary.response ? <SummarySection icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Latest response" text={summary.response} testId="session-preview-response" /> : null}
          {!summary.goal && !summary.response ? <div className="rounded-xl bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">No conversation summary is available yet.</div> : null}
        </div>
        <ActivityStats stats={summary.stats} />
      </ScrollArea>
    </div>,
    document.body,
  )
}

function ActivitySummary({ activity }: { activity: SessionPreviewSummary['activity'] }): JSX.Element {
  const Icon = activity.tone === 'attention' ? AlertTriangle : activity.tone === 'active' ? Loader2 : activity.tone === 'success' ? CheckCircle2 : activity.tone === 'danger' ? XCircle : CircleDot
  return (
    <div className={cn(
      'flex min-w-0 items-start gap-2.5 rounded-xl border border-border/50 px-3 py-2.5',
      activity.tone === 'attention' && 'border-amber-500/30 bg-amber-500/10',
      activity.tone === 'active' && 'border-sky-500/25 bg-sky-500/8',
      activity.tone === 'success' && 'border-emerald-500/25 bg-emerald-500/8',
      activity.tone === 'danger' && 'border-rose-500/30 bg-rose-500/10',
      activity.tone === 'muted' && 'border-border/60 bg-muted/25',
    )} data-testid="session-preview-activity">
      <Icon className={cn('mt-0.5 h-4 w-4 flex-none', activity.tone === 'active' && 'animate-spin')} aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-caption font-semibold uppercase tracking-[0.12em] text-muted-foreground">{activity.label}</div>
        <div className="mt-0.5 text-xs leading-5 text-foreground/90">{activity.text}</div>
      </div>
    </div>
  )
}

function SummarySection({ icon, label, text, testId }: { icon: JSX.Element; label: string; text: string; testId: string }): JSX.Element {
  return (
    <section className="min-w-0" data-testid={testId}>
      <div className="mb-1 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-[0.12em] text-muted-foreground">{icon}{label}</div>
      <p className="m-0 line-clamp-3 break-words text-xs leading-5 text-foreground/85 [overflow-wrap:anywhere]">{text}</p>
    </section>
  )
}

function ActivityStats({ stats }: { stats: SessionPreviewSummary['stats'] }): JSX.Element | null {
  const values = [
    stats.toolCalls > 0 ? { icon: <Wrench className="h-3 w-3" />, text: `${stats.toolCalls} tools` } : null,
    stats.failedTools > 0 ? { icon: <AlertTriangle className="h-3 w-3" />, text: `${stats.failedTools} failed`, danger: true } : null,
    stats.omittedContent > 0 ? { icon: <Layers3 className="h-3 w-3" />, text: `${stats.omittedContent} rich items` } : null,
    stats.queuedMessages > 0 ? { icon: <MessageSquareText className="h-3 w-3" />, text: `${stats.queuedMessages} queued` } : null,
  ].filter(Boolean) as Array<{ icon: JSX.Element; text: string; danger?: boolean }>
  if (values.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-2.5 text-caption text-muted-foreground" data-testid="session-preview-stats">
      {values.map((value) => <span key={value.text} className={cn('inline-flex items-center gap-1', value.danger && 'text-rose-600 dark:text-rose-300')}>{value.icon}{value.text}</span>)}
    </div>
  )
}

function shortModel(model: string | null): string {
  if (!model) return ''
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
}

function previewPosition(rect: DOMRect): { left: number; top: number } {
  const width = Math.min(480, window.innerWidth - 32)
  const height = Math.min(512, window.innerHeight - 32)
  const gap = 8
  const rightSideLeft = rect.right + gap
  const left = rightSideLeft + width <= window.innerWidth - 8
    ? rightSideLeft
    : Math.max(8, rect.left - gap - width)
  const top = Math.min(Math.max(8, rect.top - 8), Math.max(8, window.innerHeight - height - 8))
  return { left, top }
}
