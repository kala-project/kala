/**
 * ApprovalCard — the "approval face" of the composer/approval flip container.
 *
 * When one or more tool calls await user approval, the composer flips to this
 * card. It shows one approval at a time (1 of N) with prev/next navigation, a
 * details expansion (diff for file mutation tools, JSON otherwise), and top-right
 * batch "Approve all / Reject all" affordances. Keyboard: Enter approves,
 * Escape rejects, ←/→ navigate.
 *
 * Data flows in from `pendingApprovals`; user decisions call `onDecision` per
 * callId. The parent (app.tsx) is the source of truth for the pending list;
 * this component keeps only a local carousel index.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { JsonBlock } from '../../components/ui/json-block.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import { DiffPreview, hasDiffPreviewForTool } from './DiffPreview.js'
import { pickPrimaryArg } from './InlineStatusRow.js'

type Props = {
  approvals: readonly ApprovalRequiredEvent[]
  onDecision(callId: string, decision: 'approve' | 'reject'): void
}

export function ApprovalCard({ approvals, onDecision }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const approveBtnRef = useRef<HTMLButtonElement>(null)

  // Clamp `current` inside the current list. When the item at `current` is
  // approved/rejected the parent trims the list; keeping the index in range
  // lets the carousel naturally advance to the next pending item.
  const total = approvals.length
  useEffect(() => {
    if (total === 0) {
      setCurrent(0)
      setDetailsOpen(false)
      return
    }
    if (current >= total) setCurrent(total - 1)
  }, [total, current])

  // Auto-focus the primary action so `Enter` immediately approves. Refocus on
  // every carousel move so the shortcut keeps working after ←/→.
  useEffect(() => {
    if (total === 0) return
    approveBtnRef.current?.focus()
  }, [current, total])

  const approval = approvals[current] ?? null

  const goPrev = useCallback(() => {
    setCurrent((i) => (i - 1 + total) % Math.max(1, total))
    setDetailsOpen(false)
  }, [total])

  const goNext = useCallback(() => {
    setCurrent((i) => (i + 1) % Math.max(1, total))
    setDetailsOpen(false)
  }, [total])

  const approveCurrent = useCallback(() => {
    if (!approval) return
    onDecision(approval.callId, 'approve')
  }, [approval, onDecision])

  const rejectCurrent = useCallback(() => {
    if (!approval) return
    onDecision(approval.callId, 'reject')
  }, [approval, onDecision])

  const approveAll = useCallback(() => {
    // Snapshot so we don't race the parent's list-shrink between iterations.
    for (const a of approvals) onDecision(a.callId, 'approve')
  }, [approvals, onDecision])

  const rejectAll = useCallback(() => {
    for (const a of approvals) onDecision(a.callId, 'reject')
  }, [approvals, onDecision])

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Ignore keystrokes typed inside child inputs (should not exist today, but
    // keeps the handler safe if we later embed one).
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Enter') {
      e.preventDefault()
      approveCurrent()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      rejectCurrent()
    } else if (e.key === 'ArrowLeft' && total > 1) {
      e.preventDefault()
      goPrev()
    } else if (e.key === 'ArrowRight' && total > 1) {
      e.preventDefault()
      goNext()
    }
  }

  if (!approval) return null

  const hasDiff = hasDiffPreviewForTool(approval.name)
  const primary = pickPrimaryArg(approval.name, approval.input)

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/50 bg-card text-card-foreground shadow-sm',
      )}
      data-testid="approval-card"
      role="dialog"
      aria-label={t('chat.approval.requiredAria')}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <TriangleAlert className="h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold text-foreground">
          {t('chat.approval.required')}
        </span>
        {total > 1 ? (
          <span
            className="ml-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-caption font-medium tabular-nums text-amber-700 dark:text-amber-300"
            data-testid="approval-card-index"
          >
            {t('chat.approval.index', { current: current + 1, total })}
          </span>
        ) : null}
        <span className="flex-1" />
        {total > 1 ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={rejectAll}
              data-testid="approval-reject-all"
              className="h-9 px-2 text-caption text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-6"
            >
              {t('chat.approval.rejectAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={approveAll}
              data-testid="approval-approve-all"
              className="h-9 px-2 text-caption text-emerald-800 hover:bg-emerald-200/60 dark:text-emerald-200 dark:hover:bg-emerald-500/20 sm:h-6"
            >
              {t('chat.approval.approveAll')}
            </Button>
          </>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
        {approval.intent ? <p className="text-sm font-medium leading-5 text-foreground" data-testid="approval-card-intent">{approval.intent}</p> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-md border border-border/60 bg-muted/55 px-1.5 py-0.5 font-mono text-caption font-semibold text-foreground" data-testid="approval-tool-name">
            {approval.name}
          </span>
          {primary ? (
            <span
              className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-muted-foreground"
              title={primary}
              data-testid="approval-card-primary"
            >
              {primary}
            </span>
          ) : (
            <span className="text-[0.75rem] italic text-muted-foreground">
              {t('chat.approval.noArguments')}
            </span>
          )}
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex flex-none items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="approval-details-toggle"
            aria-expanded={detailsOpen}
          >
            {detailsOpen ? (
              <>
                <ChevronUp className="h-3 w-3" />
                {t('chat.approval.hideDetails')}
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" />
                {t('chat.approval.viewDetails')}
              </>
            )}
          </button>
        </div>

        {detailsOpen ? (
          <ScrollArea
            className="ak-expand-in max-h-56 rounded-lg border border-border/60 bg-muted/25"
            data-testid="approval-details"
          >
            <div className="p-2">
              {hasDiff ? (
                <DiffPreview toolName={approval.name} input={approval.input} />
              ) : (
                <JsonBlock value={approval.input} label={approval.name} collapsed={2} />
              )}
            </div>
          </ScrollArea>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {total > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={goPrev}
              data-testid="approval-prev"
              aria-label={t('chat.approval.previous')}
              className="h-8 flex-none px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('chat.approval.prev')}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={rejectCurrent}
            data-testid="approval-reject"
            className="h-8 flex-none px-3 text-foreground hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="mr-1 h-4 w-4" />
            {t('chat.approval.reject')}
          </Button>
          <Button
            ref={approveBtnRef}
            size="sm"
            onClick={approveCurrent}
            data-testid="approval-approve"
            className="h-8 flex-none bg-emerald-600 px-4 text-white shadow hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            <Check className="mr-1 h-4 w-4" />
            {t('chat.approval.approve')}
          </Button>
          {total > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={goNext}
              data-testid="approval-next"
              aria-label={t('chat.approval.nextAria')}
              className="h-8 flex-none px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t('chat.approval.next')}
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        <p className="text-caption text-muted-foreground">
          {t('chat.approval.shortcuts', { switchHint: total > 1 ? t('chat.approval.switchHint') : '' })}
        </p>
      </div>
    </div>
  )
}
