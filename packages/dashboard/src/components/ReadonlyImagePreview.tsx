import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minus, Plus, Scan, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '../lib/utils.js'
import { ScrollArea } from './ui/scroll-area.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js'

type ImageSize = { width: number; height: number }
type PreviewMedia =
  | { kind: 'image'; src: string; imageTestId?: string }
  | { kind: 'svg'; svg: string; size: ImageSize; imageTestId?: string }

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25

function ReadonlyMediaCanvas({
  media,
  alt,
  className,
  stageTestId = 'readonly-image-preview-stage',
}: {
  media: PreviewMedia
  alt: string
  className?: string
  stageTestId?: string
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState<ImageSize>({ width: 0, height: 0 })
  const [imageSize, setImageSize] = useState<ImageSize>({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const naturalSize = media.kind === 'svg' ? media.size : imageSize

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const update = (): void => setStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  useEffect(() => setZoom(1), [media])

  const fitScale = useMemo(() => {
    if (!stageSize.width || !stageSize.height || !naturalSize.width || !naturalSize.height) return 1
    const horizontalPadding = stageSize.width < 640 ? 16 : 32
    const verticalPadding = stageSize.height < 640 ? 16 : 32
    return Math.min(
      Math.max(1, stageSize.width - horizontalPadding) / naturalSize.width,
      Math.max(1, stageSize.height - verticalPadding) / naturalSize.height,
      1,
    )
  }, [naturalSize, stageSize])

  const renderedWidth = naturalSize.width ? Math.max(1, Math.round(naturalSize.width * fitScale * zoom)) : undefined
  const renderedHeight = naturalSize.height ? Math.max(1, Math.round(naturalSize.height * fitScale * zoom)) : undefined
  const percent = Math.round(zoom * 100)

  const setBoundedZoom = useCallback((next: number, maximum = MAX_ZOOM): void => {
    setZoom(Math.min(maximum, Math.max(MIN_ZOOM, next)))
  }, [])

  return (
    <div className={cn('relative grid h-full w-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-neutral-950', className)}>
      <ScrollArea
        viewportRef={stageRef}
        className="min-h-0 min-w-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.055),transparent_62%)]"
        viewportClassName="touch-pan-x touch-pan-y overscroll-contain"
        data-testid={stageTestId}
      >
        <div
          className="relative flex min-h-full min-w-full items-center justify-center p-2 sm:p-4"
          style={{
            width: renderedWidth ? Math.max(stageSize.width, renderedWidth + (stageSize.width < 640 ? 16 : 32)) : '100%',
            height: renderedHeight ? Math.max(stageSize.height, renderedHeight + (stageSize.height < 640 ? 16 : 32)) : '100%',
          }}
          data-testid="readonly-image-preview-scroll-content"
        >
          {media.kind === 'image' ? (
            <img
              src={media.src}
              alt={alt}
              draggable={false}
              className="block max-w-none select-none object-contain shadow-2xl shadow-black/25"
              style={{ width: renderedWidth, height: renderedHeight }}
              onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              data-testid={media.imageTestId}
            />
          ) : (
            <div
              role="img"
              aria-label={alt}
              className="block max-w-none select-none [&>svg]:block [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-none"
              style={{ width: renderedWidth, height: renderedHeight }}
              dangerouslySetInnerHTML={{ __html: media.svg }}
              data-testid={media.imageTestId}
            />
          )}
        </div>
      </ScrollArea>
      <div className="flex min-h-12 items-center justify-center gap-1 border-t border-white/10 bg-black/92 px-2 pb-[env(safe-area-inset-bottom)] text-white sm:min-h-11 sm:pb-0" data-testid="readonly-image-preview-controls">
        <PreviewControl label="Fit image" onClick={() => setZoom(1)}><Scan className="h-4 w-4" /></PreviewControl>
        <PreviewControl label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => setBoundedZoom(zoom - ZOOM_STEP)}><Minus className="h-4 w-4" /></PreviewControl>
        <button type="button" className="h-10 min-w-14 rounded-md px-2 font-mono text-xs text-white/75 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70" onClick={() => setZoom(1)} aria-label={`Reset zoom, currently ${percent}%`} data-testid="readonly-image-preview-zoom">{percent}%</button>
        <PreviewControl label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => setBoundedZoom(zoom + ZOOM_STEP)}><Plus className="h-4 w-4" /></PreviewControl>
        <PreviewControl label="Actual size" onClick={() => setBoundedZoom(fitScale > 0 ? 1 / fitScale : 1, Math.max(MAX_ZOOM, fitScale > 0 ? 1 / fitScale : 1))}><Maximize2 className="h-4 w-4" /></PreviewControl>
      </div>
    </div>
  )
}

export function ReadonlyImageCanvas({
  src,
  alt,
  className,
  imageTestId,
  stageTestId,
}: {
  src: string
  alt: string
  className?: string
  imageTestId?: string
  stageTestId?: string
}): JSX.Element {
  const media = useMemo<PreviewMedia>(() => ({ kind: 'image', src, imageTestId }), [imageTestId, src])
  return <ReadonlyMediaCanvas media={media} alt={alt} className={className} stageTestId={stageTestId} />
}

function getSvgSize(svg: string): ImageSize {
  const viewBox = /\bviewBox\s*=\s*["']\s*([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s*["']/iu.exec(svg)
  const width = viewBox ? Number(viewBox[3]) : 0
  const height = viewBox ? Number(viewBox[4]) : 0
  return width > 0 && height > 0 ? { width, height } : { width: 800, height: 600 }
}

function PreviewControl({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: JSX.Element }): JSX.Element {
  return (
    <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-30" disabled={disabled} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

export function ReadonlyImagePreviewDialog({
  open,
  onOpenChange,
  src,
  alt,
  title,
  description,
  dialogTestId,
  closeTestId,
  imageTestId,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  src: string
  alt: string
  title: string
  description?: string
  dialogTestId?: string
  closeTestId?: string
  imageTestId?: string
}): JSX.Element {
  const media = useMemo<PreviewMedia>(() => ({ kind: 'image', src, imageTestId }), [imageTestId, src])
  return (
    <ReadonlyMediaPreviewDialog
      open={open}
      onOpenChange={onOpenChange}
      media={media}
      alt={alt}
      title={title}
      description={description}
      dialogTestId={dialogTestId}
      closeTestId={closeTestId}
    />
  )
}

export function ReadonlySvgPreviewDialog({
  open,
  onOpenChange,
  svg,
  alt,
  title,
  dialogTestId,
  closeTestId,
  imageTestId,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  svg: string
  alt: string
  title: string
  dialogTestId?: string
  closeTestId?: string
  imageTestId?: string
}): JSX.Element {
  const media = useMemo<PreviewMedia>(() => ({ kind: 'svg', svg, size: getSvgSize(svg), imageTestId }), [imageTestId, svg])
  return (
    <ReadonlyMediaPreviewDialog
      open={open}
      onOpenChange={onOpenChange}
      media={media}
      alt={alt}
      title={title}
      dialogTestId={dialogTestId}
      closeTestId={closeTestId}
    />
  )
}

function ReadonlyMediaPreviewDialog({
  open,
  onOpenChange,
  media,
  alt,
  title,
  description,
  dialogTestId,
  closeTestId,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  media: PreviewMedia
  alt: string
  title: string
  description?: string
  dialogTestId?: string
  closeTestId?: string
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!bottom-0 !top-auto h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top))] max-h-none w-screen max-w-none !translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-x-0 bg-black p-0 sm:!bottom-auto sm:!top-[calc(50%+(env(safe-area-inset-top)-env(safe-area-inset-bottom))/2)] sm:h-[min(94dvh,64rem)] sm:w-[calc(100vw-1.5rem)] sm:max-w-[80rem] sm:!translate-y-[-50%] sm:rounded-xl sm:border-x lg:h-[min(90dvh,60rem)] lg:w-[calc(100vw-3rem)]"
        data-testid={dialogTestId}
      >
        <DialogHeader className="relative min-h-14 justify-center space-y-0 border-b border-white/10 bg-black/95 px-4 py-2 pr-14 text-white sm:px-5">
          <DialogTitle className="truncate text-sm font-medium sm:text-base" title={title}>{title}</DialogTitle>
          {description ? <DialogDescription className="hidden truncate text-xs text-white/55 sm:block">{description}</DialogDescription> : null}
          <DialogClose className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70" aria-label={t('chatCommon.closeImagePreview')} data-testid={closeTestId}>
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <ReadonlyMediaCanvas media={media} alt={alt} />
      </DialogContent>
    </Dialog>
  )
}
