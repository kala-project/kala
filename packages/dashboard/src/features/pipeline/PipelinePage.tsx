import { ScrollArea } from '../../components/ui/scroll-area.js'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { ProductPage, ProductPageBody, ProductPageHeader, ProductPanel } from '../../components/ui/product-page.js'
import { cn } from '../../lib/utils.js'

type Step = {
  title: string
  subtitle: string
  detail: string
  signal: string
}

type Slide =
  | { kind: 'step'; step: Step; index: number; total: number }
  | { kind: 'principles' }

export function PipelinePage(): JSX.Element {
  const { t } = useTranslation()
  const [cursor, setCursor] = useState(0)

  const steps = t('pipeline.steps', { returnObjects: true }) as Step[]

  const slides = useMemo<Slide[]>(() => {
    const stepSlides: Slide[] = steps.map((step, i) => ({
      kind: 'step',
      step,
      index: i,
      total: steps.length,
    }))
    return [...stepSlides, { kind: 'principles' }]
  }, [steps])

  const total = slides.length
  const safeCursor = Math.min(Math.max(0, cursor), total - 1)
  const current = slides[safeCursor] ?? slides[0]!

  const goto = useCallback((next: number) => {
    setCursor(Math.max(0, Math.min(total - 1, next)))
  }, [total])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && isEditable(target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        goto(safeCursor + 1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        goto(safeCursor - 1)
      } else if (e.key === 'Home') {
        goto(0)
      } else if (e.key === 'End') {
        goto(total - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goto, safeCursor, total])

  const trackTitle = t('pipeline.tracks.runtime.title')
  const footerLabel = current.kind === 'step' ? current.step.title : t('pipeline.principlesTitle')

  return (
    <ProductPage testId="pipeline-page" className="overflow-hidden">
      <ProductPageHeader eyebrow={t('pipeline.buttonLabel')} title={t('pipeline.title')} description={t('pipeline.description')} actions={
        <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{trackTitle}</div>
      } />
      <ProductPageBody className="flex min-h-0 flex-col">
        <ProductPanel className="relative">
          <ScrollArea className="min-h-0 flex-1 overscroll-contain" data-testid="pipeline-scroll-body" contentClassName="min-h-full">
            <div className="mx-auto flex min-h-full w-full max-w-[88rem] items-center justify-center px-4 py-6 sm:px-8 sm:py-10">
          {current.kind === 'step' ? (
            <StepSlide step={current.step} index={current.index} total={current.total} whereToLook={t('pipeline.whereToLook')} />
          ) : (
            <PrinciplesSlide t={t} />
          )}
            </div>
          </ScrollArea>
          <div className="flex flex-none items-center justify-between border-t border-border/35 bg-muted/20 px-3 py-2 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => goto(safeCursor - 1)}
              disabled={safeCursor === 0}
              data-testid="pipeline-prev"
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              {t('pipeline.prev')}
            </Button>

            <div className="flex min-w-0 flex-col items-center gap-1">
              <div className="flex items-center gap-0.5" role="group" aria-label={t('pipeline.slidesLabel')}>
                {slides.map((_, i) => (
                  <button key={i} type="button" aria-label={t('pipeline.slideNumber', { index: i + 1 })} aria-current={i === safeCursor ? 'step' : undefined} onClick={() => goto(i)} data-testid={`pipeline-dot-${i}`} className={cn('flex h-8 min-w-6 items-center justify-center rounded-full transition-colors after:block after:h-1.5 after:rounded-full', i === safeCursor ? 'after:w-5 after:bg-primary' : 'after:w-1.5 after:bg-muted-foreground/30 hover:after:bg-muted-foreground/60')} />
                ))}
              </div>
              <div className="max-w-[42vw] truncate text-caption text-muted-foreground"><span className="font-mono">{safeCursor + 1} / {total}</span><span className="mx-1.5">·</span><span>{footerLabel}</span></div>
            </div>

            <Button type="button" variant="ghost" size="sm" onClick={() => goto(safeCursor + 1)} disabled={safeCursor === total - 1} data-testid="pipeline-next" className="gap-1">
              {t('pipeline.next')}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </ProductPanel>
      </ProductPageBody>
    </ProductPage>
  )
}

function StepSlide({
  step,
  index,
  total,
  whereToLook,
}: {
  step: Step
  index: number
  total: number
  whereToLook: string
}): JSX.Element {
  return (
    <article
      className="w-full max-w-4xl"
      data-testid="pipeline-slide-step"
      data-step-index={index}
    >
      <div className="font-mono text-4xl font-bold leading-none tracking-tight text-primary sm:text-6xl">
        {String(index + 1).padStart(2, '0')}
        <span className="ml-2 text-2xl text-muted-foreground/60">/ {String(total).padStart(2, '0')}</span>
      </div>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:mt-6 sm:text-3xl">{stripLeadingNumber(step.title)}</h2>
      <p className="mt-2 text-base text-muted-foreground sm:text-lg">{step.subtitle}</p>
      <p className="mt-4 text-sm leading-7 text-foreground/90 sm:mt-6 sm:text-base sm:leading-8">{step.detail}</p>
      <div className="mt-8 rounded-md border-l-2 border-primary/40 bg-muted/30 px-4 py-3">
        <div className="text-caption font-medium uppercase tracking-wider text-muted-foreground">
          {whereToLook.replace(/[:：]\s*$/, '')}
        </div>
        <p className="mt-1 text-sm leading-6 text-foreground/85">{step.signal}</p>
      </div>
    </article>
  )
}

function PrinciplesSlide({ t }: { t: TFunction }): JSX.Element {
  const keys = ['coreBoundary', 'replayFirst', 'teaching'] as const
  return (
    <article className="w-full max-w-5xl" data-testid="pipeline-slide-principles">
      <div className="font-mono text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('pipeline.principlesLabel')}
      </div>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        {t('pipeline.principlesTitle')}
      </h2>
      <div className="mt-8 space-y-5">
        {keys.map((key) => (
          <section key={key} className="rounded-md border border-border/50 bg-card/50 px-5 py-4">
            <h3 className="text-base font-semibold text-foreground">
              {t(`pipeline.principles.${key}.title`)}
            </h3>
            <p className="mt-1.5 text-sm leading-7 text-muted-foreground">
              {t(`pipeline.principles.${key}.body`)}
            </p>
          </section>
        ))}
      </div>
    </article>
  )
}

function stripLeadingNumber(title: string): string {
  return title.replace(/^\s*\d+[.、）)]\s*/, '')
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}
