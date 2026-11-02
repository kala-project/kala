import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Mic, Minimize2, Send, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog.js'
import { speechMaxMinutes } from '../voice/speech-api.js'
import { joinTranscriptChunks, type VoiceRecorderError, useVoiceRecorder } from '../voice/useVoiceRecorder.js'
import { cn } from '../../lib/utils.js'
import { VoiceLevelTrace } from './VoiceLevelTrace.js'

type Voice = ReturnType<typeof useVoiceRecorder>

function duration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function VoiceWorkbench({ voice, draft, onCompact, onStopAndSend }: {
  voice: Voice
  draft: { text: string; caret: number }
  onCompact(): void
  onStopAndSend(): Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ id: number; y: number } | null>(null)
  const suppressHandleClick = useRef(false)
  const actionPending = useRef(false)
  const followLatest = useRef(true)
  const [showReturn, setShowReturn] = useState(false)
  const liveMode = voice.configuration?.mode !== 'after_recording'
  const listening = voice.phase === 'listening'
  const transcript = joinTranscriptChunks(voice.finalTranscript, voice.interimTranscript)
  const interim = transcript.slice(voice.finalTranscript.length)
  const maxMinutes = speechMaxMinutes(liveMode ? voice.configuration?.realtimeMaxMinutes : voice.configuration?.afterRecordingMaxMinutes)
  const maxSeconds = maxMinutes * 60
  const status = voice.phase === 'requesting' ? t('composer.voice.requesting')
    : voice.phase === 'processing' ? t('composer.voice.processing')
      : voice.phase === 'error' ? voiceError(voice.error, t)
        : listening ? t('composer.voice.recording') : t('composer.voice.listening')
  const nearingLimit = listening && voice.elapsedSeconds >= maxSeconds - 30
  // Preserve the original caret insertion behavior; show nearby context when the caret is in the middle.
  const midDraft = draft.caret < draft.text.length && draft.caret >= 0
  const draftContext = midDraft
    ? `${draft.caret > 70 ? '…' : ''}${draft.text.slice(Math.max(0, draft.caret - 70), Math.min(draft.text.length, draft.caret + 70))}${draft.caret + 70 < draft.text.length ? '…' : ''}`
    : draft.text

  useEffect(() => {
    if (draftRef.current) draftRef.current.scrollTop = draftRef.current.scrollHeight
  }, [draftContext])
  useEffect(() => {
    const element = transcriptRef.current
    if (!element) return
    const update = (): void => {
      const away = element.scrollHeight - element.scrollTop - element.clientHeight > 12
      setShowReturn(element.scrollHeight > element.clientHeight + 2 && away)
    }
    if (followLatest.current) element.scrollTop = element.scrollHeight
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [transcript, listening])
  useEffect(() => {
    if (listening) actionPending.current = false
  }, [listening])

  const stop = (action: () => Promise<unknown>): void => {
    if (actionPending.current || !listening) return
    actionPending.current = true
    void action()
  }
  return (
    <Dialog open modal>
      <DialogContent
        className="!flex h-[min(760px,82dvh)] w-full max-w-[740px] flex-col gap-0 rounded-t-[26px] border-border/50 p-0 max-sm:!bottom-0 max-sm:!top-auto max-sm:h-[min(740px,84dvh)] max-sm:w-screen max-sm:max-w-none max-sm:!translate-y-0 max-sm:rounded-b-none"
        onEscapeKeyDown={(event) => { event.preventDefault(); if (voice.phase === 'error') voice.dismissError(); else void voice.cancel() }}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // The dialog has no trigger. Restore focus to the compact recorder or editor.
          window.requestAnimationFrame(() => {
            const next = document.querySelector<HTMLElement>('[data-testid="composer-voice-expand"], [data-testid="composer-input"], [data-testid="composer-input-simple"], [data-testid="composer-voice-start"]')
            next?.focus()
          })
        }}
        data-testid="voice-workbench"
      >
        <button
          type="button"
          className="flex w-full shrink-0 touch-none justify-center py-3 sm:hidden"
          data-testid="voice-workbench-drag-handle"
          aria-label={t('composer.voice.minimize')}
          onClick={() => {
            if (suppressHandleClick.current) { suppressHandleClick.current = false; return }
            onCompact()
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            dragStart.current = { id: event.pointerId, y: event.clientY }
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerUp={(event) => {
            const drag = dragStart.current
            if (drag && drag.id === event.pointerId && event.clientY - drag.y > 70) {
              suppressHandleClick.current = true
              onCompact()
            }
            dragStart.current = null
          }}
          onPointerCancel={() => { dragStart.current = null }}
        ><span className="h-1 w-12 rounded-full bg-muted-foreground/30" /></button>
        <header className="flex shrink-0 items-center justify-between gap-3 bg-muted/20 px-5 py-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Mic className="size-5" aria-hidden="true" /></span>
            <DialogTitle className="min-w-0 text-base font-semibold sm:text-lg">{t('composer.voice.workbenchTitle')} <span className="ml-1 text-xs font-normal text-muted-foreground sm:text-sm">· {t(liveMode ? 'composer.voice.realtimeMode' : 'composer.voice.afterRecordingMode')}</span></DialogTitle>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span role={nearingLimit ? 'alert' : 'status'} className={cn('flex items-center gap-2 rounded-full px-2 py-1.5 text-xs font-medium sm:px-3', nearingLimit ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300' : listening ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>
              {listening ? <span className={cn('size-1.5 rounded-full', nearingLimit ? 'bg-amber-500' : 'bg-emerald-500')} aria-hidden="true" /> : null}{nearingLimit ? t('composer.voice.finishingSoon') : status}
            </span>
            <button type="button" className="hidden size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent sm:flex" onClick={onCompact} aria-label={t('composer.voice.minimize')} title={t('composer.voice.minimize')} data-testid="voice-workbench-minimize"><Minimize2 className="size-4" aria-hidden="true" /></button>
          </div>
        </header>
        <DialogDescription className="sr-only">{t('composer.voice.workbenchDescription')}</DialogDescription>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-5 sm:gap-5 sm:px-7">
          {draft.text.trim() ? (
            <ScrollArea viewportRef={draftRef} className="max-h-24 shrink-0 rounded-xl ring-1 ring-border/50 bg-muted/40" data-testid="voice-workbench-draft" aria-live="off" contentClassName="px-4 py-3 min-h-full">
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t(midDraft ? 'composer.voice.draftAroundCaret' : 'composer.voice.draftContext')}</p>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground sm:text-base">{draftContext}</p>
            </ScrollArea>
          ) : null}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl ring-1 ring-border/50 bg-card shadow-sm">
            <ScrollArea
              viewportRef={transcriptRef}
              className="min-h-0 flex-1 whitespace-pre-wrap break-words text-[17px] leading-[1.9] sm:text-[22px]"
              viewportProps={{ onScroll: (event) => {
                const element = event.currentTarget
                followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12
                setShowReturn(element.scrollHeight > element.clientHeight + 2 && !followLatest.current)
              } }}
              data-testid="voice-workbench-transcript"
              aria-live="off"
             contentClassName="px-4 py-5 sm:px-6 sm:py-6 min-h-full">
              {listening && liveMode && transcript ? <><span className="text-foreground">{voice.finalTranscript}</span><span className="text-muted-foreground">{interim}</span></> : (
                <p className={cn('text-base', voice.phase === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{voice.phase === 'error' ? status : listening && !liveMode ? t('composer.voice.afterRecordingHint') : voice.phase === 'requesting' || voice.phase === 'processing' ? status : t('composer.voice.waitingForSpeech')}</p>
              )}
            </ScrollArea>
            {showReturn ? <button type="button" className="absolute bottom-3 right-4 inline-flex items-center gap-1 rounded-full ring-1 ring-border/50 bg-background px-3 py-1.5 text-xs font-medium text-primary shadow-md" onClick={() => { followLatest.current = true; transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }); setShowReturn(false) }} data-testid="voice-workbench-return-latest"><ArrowDown className="size-3.5" aria-hidden="true" />{t('composer.voice.returnToLatest')}</button> : null}
          </div>
        </div>
        <footer className="shrink-0 bg-muted/20 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-7 sm:pb-6">
          <div className="mb-4 flex min-w-0 items-center gap-4">
            <VoiceLevelTrace levels={voice.levels} className="min-w-0 flex-1" />
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:text-sm">{duration(voice.elapsedSeconds)}</span>
          </div>
          {listening ? <div className="grid grid-cols-[auto_1fr_1fr] gap-2 sm:gap-3">
            <button type="button" onClick={() => { void voice.cancel() }} className="inline-flex items-center justify-center gap-1.5 rounded-xl ring-1 ring-border/50 px-3 py-3 text-xs font-medium sm:px-5 sm:text-sm" aria-label={t('composer.voice.cancelDiscard')} data-testid="voice-workbench-cancel"><X className="size-4" aria-hidden="true" />{t('composer.voice.cancelShort')}</button>
            <button type="button" onClick={() => stop(voice.stop)} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-secondary px-2 py-3 text-xs font-medium text-secondary-foreground sm:text-sm" aria-label={t('composer.voice.stopAndEdit')} data-testid="voice-workbench-stop"><Square className="size-3.5" aria-hidden="true" />{t('composer.voice.edit')}</button>
            <button type="button" onClick={() => stop(onStopAndSend)} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-2 py-3 text-xs font-medium text-primary-foreground sm:text-sm" aria-label={t('composer.voice.stopAndSend')} data-testid="voice-workbench-send"><Send className="size-3.5" aria-hidden="true" />{t('composer.voice.send')}</button>
          </div> : voice.phase === 'error' ? <div className="flex justify-end gap-2"><button type="button" className="rounded-xl px-4 py-3 text-sm" onClick={voice.dismissError}>{t('composer.voice.dismiss')}</button><button type="button" className="rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground" onClick={() => { void voice.retry() }}>{t('composer.voice.retry')}</button></div> : null}
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function voiceError(error: VoiceRecorderError | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  if (error === 'not_configured') return t('composer.voice.errors.notConfigured')
  if (error === 'permission_denied') return t('composer.voice.errors.permissionDenied')
  if (error === 'microphone_unavailable') return t('composer.voice.errors.unavailable')
  if (error === 'secure_context_required') return t('composer.voice.errors.secureContext')
  if (error === 'no_speech') return t('composer.voice.errors.noSpeech')
  return t('composer.voice.errors.service')
}

export function VoiceCompactAnchor({ voice }: { voice: Voice }): JSX.Element {
  const { t } = useTranslation()
  return <div className="ak-voice-recorder flex min-h-12 min-w-0 items-center gap-2 rounded-[inherit] px-3 py-2" data-testid="composer-voice-anchor">
    <span className="size-2.5 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{t('composer.voice.workbenchTitle')}</span>
    <span className="font-mono text-xs text-muted-foreground">{duration(voice.elapsedSeconds)}</span>
  </div>
}
