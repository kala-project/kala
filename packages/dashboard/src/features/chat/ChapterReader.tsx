import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChapterReadingMode } from '@agent-kernel/shared'
import { segmentAssistantReply } from './chapter-segments.js'

type Props = {
  text: string
  renderMarkdown: (markdown: string) => ReactNode
  headerTarget?: HTMLElement | null
  defaultMode?: ChapterReadingMode
  sessionMode?: ChapterReadingMode
  onSessionModeChange?: (mode: ChapterReadingMode | null) => void
  onChapterNavigate?: () => void
  revealAll?: boolean
}

export default function ChapterReader({
  text, renderMarkdown, headerTarget, defaultMode = 'chapters', sessionMode,
  onSessionModeChange, onChapterNavigate, revealAll = false,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const chapters = useMemo(() => segmentAssistantReply(text), [text])
  const [index, setIndex] = useState(0)
  const [localMode, setLocalMode] = useState<ChapterReadingMode | null>(null)
  const [open, setOpen] = useState(false)
  const [searchRevealed, setSearchRevealed] = useState(false)
  const directoryRef = useRef<HTMLDivElement>(null)
  useEffect(() => setIndex((current) => Math.min(current, Math.max(0, chapters.length - 1))), [chapters.length])
  useEffect(() => { if (revealAll) setSearchRevealed(true) }, [revealAll])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!directoryRef.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  if (chapters.length < 2) return <>{renderMarkdown(text)}</>

  const selectedMode = onSessionModeChange ? sessionMode ?? null : localMode ?? sessionMode ?? null
  const effectiveMode = selectedMode ?? defaultMode
  const continuous = searchRevealed || effectiveMode === 'continuous'
  const chapterTitle = (chapter: typeof chapters[number]): string => {
    const title = chapter.title || t('chat.transcript.chapterIntroduction')
    return chapter.continuation ? t('chat.transcript.chapterContinuation', { title }) : title
  }
  const setMode = (mode: ChapterReadingMode | null): void => {
    if (onSessionModeChange) onSessionModeChange(mode)
    else setLocalMode(mode)
    setSearchRevealed(false)
    setOpen(false)
  }
  const scrollToChapter = (): void => {
    requestAnimationFrame(() => {
      if (onChapterNavigate) onChapterNavigate()
      else headerTarget?.scrollIntoView({ block: 'start', behavior: 'instant' })
    })
  }
  const select = (next: number): void => {
    setIndex(next)
    if (effectiveMode !== 'chapters') setMode('chapters')
    setSearchRevealed(false)
    setOpen(false)
    scrollToChapter()
  }
  const modeLabel = defaultMode === 'chapters'
    ? t('chat.transcript.chapterPaged')
    : t('chat.transcript.chapterContinuous')
  const navigation = (
    <div ref={directoryRef} className="relative flex min-w-0 items-center gap-1 normal-case tracking-normal" data-testid="chapter-navigation">
      <div className="min-w-0">
        <button type="button" aria-label={t('chat.transcript.chapterOpenToc')} aria-expanded={open} data-testid="chapter-toc-trigger" onClick={() => setOpen((value) => !value)} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium tabular-nums hover:bg-muted">
          <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="whitespace-nowrap">{continuous ? t('chat.transcript.chapterAll') : `${index + 1} / ${chapters.length}`}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </div>
      <select
        aria-label={t('chat.transcript.chapterSessionMode')}
        title={t('chat.transcript.chapterSessionMode')}
        data-testid="chapter-mode"
        value={selectedMode ?? 'inherit'}
        onChange={(event) => {
          const value = event.currentTarget.value
          const mode = value === 'inherit' ? null : value as ChapterReadingMode
          const becomesChapters = (mode ?? defaultMode) === 'chapters' && continuous
          setMode(mode)
          if (becomesChapters) scrollToChapter()
        }}
        className="h-7 min-w-0 max-w-[6.5rem] rounded-md bg-transparent px-1 text-xs font-normal text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[11rem]"
      >
        <option value="inherit">{t('chat.transcript.chapterFollowGlobal', { mode: modeLabel })}</option>
        <option value="chapters">{t('chat.transcript.chapterPaged')}</option>
        <option value="continuous">{t('chat.transcript.chapterContinuous')}</option>
      </select>
      {open ? <div role="menu" aria-label={t('chat.transcript.chapterToc')} data-testid="chapter-toc" className="absolute right-0 top-8 z-30 w-[min(300px,calc(100vw-32px))] rounded-xl border border-border/50 bg-popover p-1 shadow-xl">
        {chapters.map((chapter, position) => <button type="button" role="menuitem" key={position} data-testid={`chapter-select-${position}`} onClick={() => select(position)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs hover:bg-muted ${!continuous && position === index ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}><span className="w-5 shrink-0 text-center tabular-nums">{position + 1}</span><span className="min-w-0 flex-1 truncate">{chapterTitle(chapter)}</span>{!continuous && position === index ? <Check className="size-3.5 shrink-0" /> : null}</button>)}
      </div> : null}
    </div>
  )
  return <div className="min-w-0" data-testid="chapter-reader">
    {headerTarget ? createPortal(navigation, headerTarget) : null}
    <div data-testid="chapter-body" aria-live="polite">{renderMarkdown(continuous ? text : chapters[Math.min(index, chapters.length - 1)]!.markdown)}</div>
    {!continuous ? <nav aria-label={t('chat.transcript.chapterPaging')} className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 py-3 text-xs text-muted-foreground" data-testid="chapter-footer">
      <button type="button" data-testid="chapter-previous" disabled={index === 0} onClick={() => select(index - 1)} className="flex items-center gap-1 rounded-lg px-2 py-2 hover:bg-muted disabled:opacity-35"><ChevronLeft className="size-4" />{t('chat.transcript.chapterPrevious')}</button>
      <span className="tabular-nums">{index + 1} / {chapters.length}</span>
      <button type="button" data-testid="chapter-next" disabled={index === chapters.length - 1} onClick={() => select(index + 1)} className="flex items-center gap-1 rounded-lg px-2 py-2 hover:bg-muted disabled:opacity-35">{t('chat.transcript.chapterNext')}<ChevronRight className="size-4" /></button>
    </nav> : null}
  </div>
}
