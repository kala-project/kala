import { ScrollArea } from '../../components/ui/scroll-area.js'
/**
 * TasksButton — a compact footer control mirroring [[BackgroundShellsButton]].
 *
 * Trigger shows `N Tasks · done/total` with a sky pulse when any todo is
 * `in_progress`, or emerald tone when everything is done. Clicking opens an
 * inline popover that expands upward from the trigger and lists the full todo
 * set with status icons. Closes on outside click or Escape.
 */

import { useEffect, useRef, useState } from 'react'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { Check, Circle, CircleDashed, ListChecks, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { cn } from '../../lib/utils.js'
import type { TaskItem, TaskStatus } from './tasks-from-timeline.js'

type Props = {
  todos: readonly TaskItem[]
}

export function TasksButton({ todos }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [listRef] = useAutoAnimate<HTMLUListElement>()

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (todos.length === 0) return null

  const total = todos.length
  const done = todos.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length
  const hasActive = todos.some((t) => t.status === 'in_progress')
  const allDone = done === total

  return (
    <div className="relative flex-none" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="tasks-button-trigger"
        aria-label={t('tasks.trigger', { done, total })}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('tasks.title', { done, total })}
        className={cn(
          'inline-flex h-9 flex-none items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none transition-colors hover:bg-accent sm:h-7',
          open && 'bg-accent text-foreground',
          !open && allDone && 'text-emerald-700 dark:text-emerald-300',
          !open && !allDone && hasActive && 'text-sky-700 dark:text-sky-300',
        )}
      >
        <ListChecks className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <span className="tabular-nums">
          {total} <span className="hidden sm:inline">{t('tasks.count', { count: total }).replace(/^\d+\s*/, '')}</span>
          <span className="ml-1 hidden text-muted-foreground sm:inline">
            · {done}/{total}
          </span>
        </span>
        {hasActive ? (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full bg-sky-500 shadow-[0_0_0_2px_hsl(var(--background))] animate-pulse"
            aria-hidden="true"
          />
        ) : null}
      </button>

      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('tasks.label')}
          className="fixed inset-x-2 bottom-[5.5rem] z-[70] flex max-h-[min(60dvh,28rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-2xl sm:inset-x-auto sm:bottom-20 sm:left-1/2 sm:w-[min(22rem,calc(100vw-1rem))] sm:-translate-x-1/2"
          data-testid="tasks-popover"
        >
          <div className="flex flex-none items-center gap-2 border-b border-border/50 px-3 py-2 text-xs">
            <ListChecks className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground">{t('tasks.label')}</span>
            <span className="text-caption text-muted-foreground">
              {t('tasks.done', { done, total })}
            </span>
          </div>
          <ScrollArea
            className="max-h-[calc(min(60dvh,28rem)-2.25rem)] min-h-0 overscroll-contain touch-pan-y [scrollbar-gutter:stable] sm:max-h-[calc(min(60vh,28rem)-2.25rem)]"
            data-testid="tasks-popover-scroll"
           contentClassName="min-h-full">
            <ul ref={listRef} className="flex flex-col gap-0.5 px-2 py-2" data-testid="tasks-popover-list">
              {todos.map((todo, i) => (
                <TaskRow key={i} todo={todo} />
              ))}
            </ul>
          </ScrollArea>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function TaskRow({ todo }: { todo: TaskItem }): JSX.Element {
  const strike = todo.status === 'completed' || todo.status === 'cancelled'
  return (
    <li
      className="flex items-start gap-2 rounded px-2 py-1.5 text-meta"
      data-testid="tasks-popover-item"
      data-status={todo.status}
    >
      <StatusIcon status={todo.status} />
      <span
        className={cn(
          'min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug [overflow-wrap:anywhere]',
          strike && 'text-muted-foreground line-through',
          todo.status === 'in_progress' && 'font-medium text-foreground',
          todo.status === 'pending' && 'text-foreground',
        )}
      >
        {todo.content}
      </span>
    </li>
  )
}

function StatusIcon({ status }: { status: TaskStatus }): JSX.Element {
  const cls = 'mt-0.5 h-3.5 w-3.5 flex-none'
  if (status === 'completed') {
    return <Check className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  }
  if (status === 'cancelled') {
    return <X className={cn(cls, 'text-muted-foreground')} />
  }
  if (status === 'in_progress') {
    return <CircleDashed className={cn(cls, 'text-sky-600 animate-pulse dark:text-sky-400')} />
  }
  return <Circle className={cn(cls, 'text-muted-foreground')} />
}
