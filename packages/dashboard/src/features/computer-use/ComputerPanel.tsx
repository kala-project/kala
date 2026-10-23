import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Monitor, RefreshCw, Square, ZoomIn } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { COMPUTER_TYPE_MAX_LENGTH, type ComputerInputAction, type ComputerRequest, type ComputerScreenshot, type ComputerStatus } from '@agent-kernel/shared'
import type { WorkspaceSocket } from '../../lib/workspace-exec.js'
import { randomId } from '../../lib/random-id.js'
import { Button } from '../../components/ui/button.js'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog.js'
import { requestComputer } from './computer-client.js'

type Props = { socket: WorkspaceSocket | null; workspaceId?: string; sessionId?: string | null; visible: boolean }
type Operation = ComputerRequest extends infer Request ? Request extends ComputerRequest ? Omit<Request, 'requestId' | 'workspaceId' | 'sessionId'> : never : never

export function ComputerPanel({ socket, workspaceId, sessionId, visible }: Props): JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [screenshot, setScreenshot] = useState<ComputerScreenshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [allowAgent, setAllowAgent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lease = useRef<string | null>(null)
  const generation = useRef(0)
  const capturing = useRef(false)
  const pointer = useRef<{ x: number; y: number; button: 'left' | 'middle' | 'right' } | null>(null)
  const click = useRef<{ timer: number; action: Extract<ComputerInputAction, { type: 'click' }> } | null>(null)
  const moving = useRef(false)
  const lastMove = useRef(0)
  const capture = useRef<() => Promise<void>>(async () => {})
  const region = useRef<HTMLDivElement>(null)

  const request = useCallback(async (operation: Operation) => {
    if (!socket || !workspaceId || !sessionId) throw new Error(t('computer.workspaceRequired'))
    const result = await requestComputer(socket, { ...operation, requestId: randomId(), workspaceId, sessionId })
    if (result.error) throw new Error(result.error.message)
    return result
  }, [socket, workspaceId, sessionId, t])

  const stop = useCallback(async () => {
    const id = lease.current
    const ownGeneration = generation.current
    lease.current = null
    if (click.current) window.clearTimeout(click.current.timer)
    click.current = null
    pointer.current = null
    setScreenshot(null)
    setAllowAgent(false)
    setExpanded(false)
    if (!id) return
    try {
      const result = await request({ operation: 'stop', leaseId: id })
      if (generation.current === ownGeneration && result.status) setStatus(result.status)
    } catch (error) {
      if (generation.current === ownGeneration) setError(error instanceof Error ? error.message : String(error))
    }
  }, [request])

  useEffect(() => {
    const ownGeneration = ++generation.current
    setStatus(null)
    setScreenshot(null)
    setError(null)
    setConsent(false)
    setAllowAgent(false)
    setBusy(false)
    setText('')
    setTyping(false)
    if (visible && socket && workspaceId && sessionId) {
      void request({ operation: 'status' }).then((result) => {
        if (generation.current === ownGeneration && result.status) setStatus(result.status)
      }).catch((error: unknown) => {
        if (generation.current === ownGeneration) setError(error instanceof Error ? error.message : String(error))
      })
    }
    return () => { generation.current += 1; void stop() }
  }, [visible, socket, workspaceId, sessionId, request, stop])

  capture.current = async () => {
    const id = lease.current
    if (!id || capturing.current || !visible || document.hidden) return
    const ownGeneration = generation.current
    capturing.current = true
    try {
      const result = await request({ operation: 'capture', leaseId: id })
      if (lease.current === id && generation.current === ownGeneration && result.screenshot) setScreenshot(result.screenshot)
    } catch (error) {
      if (lease.current === id) {
        setError(error instanceof Error ? error.message : String(error))
        void stop()
      }
    } finally { capturing.current = false }
  }

  useEffect(() => {
    const frames = window.setInterval(() => { void capture.current() }, 1_000)
    const heartbeat = window.setInterval(() => {
      const id = lease.current
      const ownGeneration = generation.current
      if (id) void request({ operation: 'renew', leaseId: id }).then((result) => {
        if (generation.current === ownGeneration && lease.current === id && result.status) setStatus(result.status)
      }).catch((error: unknown) => {
        if (generation.current === ownGeneration && lease.current === id) { setError(error instanceof Error ? error.message : String(error)); void stop() }
      })
    }, 10_000)
    const hidden = () => { if (document.hidden) void stop() }
    document.addEventListener('visibilitychange', hidden)
    return () => { window.clearInterval(frames); window.clearInterval(heartbeat); document.removeEventListener('visibilitychange', hidden) }
  }, [request, stop])

  const start = async () => {
    if (!consent || busy) return
    setBusy(true)
    setError(null)
    const ownGeneration = generation.current
    try {
      const result = await request({ operation: 'start', consent: true, allowAgent })
      if (generation.current !== ownGeneration) {
        if (result.leaseId) await request({ operation: 'stop', leaseId: result.leaseId })
        return
      }
      if (!result.leaseId) throw new Error(t('computer.invalidLease'))
      lease.current = result.leaseId
      if (result.status) setStatus(result.status)
      await capture.current()
      region.current?.focus()
    } catch (error) { if (generation.current === ownGeneration) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (generation.current === ownGeneration) setBusy(false) }
  }

  const send = async (action: ComputerInputAction) => {
    const id = lease.current
    if (!id) return false
    const ownGeneration = generation.current
    const current = () => lease.current === id && generation.current === ownGeneration
    setError(null)
    try {
      const pendingClick = click.current
      if (pendingClick) {
        window.clearTimeout(pendingClick.timer)
        click.current = null
        await request({ operation: 'input', leaseId: id, action: pendingClick.action })
        if (!current()) return false
      }
      const result = await request({ operation: 'input', leaseId: id, action })
      if (!current()) return false
      if (result.status) { setStatus(result.status); setAllowAgent(result.status.allowAgent) }
      await capture.current()
      return true
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : String(error)); return false }
  }

  const point = (event: PointerEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!screenshot || bounds.width <= 0 || bounds.height <= 0) return null
    return {
      x: screenshot.originX + Math.min(screenshot.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * screenshot.width / bounds.width))),
      y: screenshot.originY + Math.min(screenshot.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * screenshot.height / bounds.height))),
    }
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!lease.current || event.nativeEvent.isComposing || event.key === 'Tab' && !event.ctrlKey && !event.altKey) return
    if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      void send({ type: 'type', text: event.key })
      return
    }
    const names: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' }
    const key = names[event.key] ?? event.key
    if (!/^(?:[A-Za-z0-9]|Enter|Escape|Backspace|Delete|Home|End|PageUp|PageDown|Insert|Tab|Up|Down|Left|Right|Space|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(key)) return
    void send({ type: 'key', key: [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.metaKey ? ['Super'] : []), key].join('+') })
  }

  const panel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="computer-panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Monitor className="size-4" />
        <span className="min-w-0 flex-1 text-sm font-medium">{t('computer.title')}</span>
        <Button size="icon" variant="ghost" aria-label={t('computer.refresh')} onClick={() => {
          const ownGeneration = generation.current
          void request({ operation: 'status' }).then((result) => {
            if (generation.current === ownGeneration) { if (result.status) setStatus(result.status); setError(null) }
          }).catch((error: unknown) => { if (generation.current === ownGeneration) setError(error instanceof Error ? error.message : String(error)) })
        }} disabled={!socket || !sessionId}><RefreshCw className="size-4" /></Button>
        <Button size="icon" variant="ghost" aria-label={t('computer.expand')} disabled={!screenshot} onClick={() => setExpanded(!expanded)}><ZoomIn className="size-4" /></Button>
        {lease.current ? <Button data-testid="computer-stop" size="sm" variant="destructive" onClick={() => { void stop() }}><Square className="mr-1 size-3" />{t('computer.stop')}</Button> : null}
      </div>
      {error ? <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {!lease.current ? <div className="space-y-3 overflow-y-auto p-3 text-xs">
        <p>{t('computer.description')}</p>
        {!workspaceId || !sessionId ? <p>{t('computer.workspaceRequired')}</p> : !status?.available ? <p className="break-words text-muted-foreground">{status?.reason ?? t('computer.checking')}</p> : null}
        {status?.active ? <p className="text-amber-600">{t('computer.occupied')}</p> : null}
        <label className="flex items-start gap-2"><input data-testid="computer-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{t('computer.consent')}</label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={allowAgent} onChange={(event) => setAllowAgent(event.target.checked)} />{t('computer.allowAgent')}</label>
        <Button data-testid="computer-start" disabled={!consent || !status?.available || status.active || busy} onClick={() => { void start() }}>{busy ? t('computer.starting') : t('computer.start')}</Button>
      </div> : <>
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
          <span className="text-emerald-600">{t('computer.sharing')}</span>
          <label className="flex items-center gap-2"><input data-testid="computer-agent-permission" type="checkbox" checked={allowAgent} onChange={(event) => {
            const allowed = event.target.checked
            const id = lease.current
            const ownGeneration = generation.current
            if (id) void request({ operation: 'agent', leaseId: id, allowAgent: allowed }).then((result) => {
              if (generation.current === ownGeneration && lease.current === id) { setAllowAgent(allowed); if (result.status) setStatus(result.status) }
            }).catch((error: unknown) => { if (generation.current === ownGeneration && lease.current === id) setError(error instanceof Error ? error.message : String(error)) })
          }} />{t('computer.agentControl')}</label>
        </div>
        <div ref={region} tabIndex={0} role="group" aria-label={t('computer.input')} data-computer-input="true" className="min-h-0 flex-1 overflow-auto bg-black/90 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onKeyDown={keyboard} onContextMenu={(event) => event.preventDefault()}>
          {screenshot ? <img data-testid="computer-screen" src={`data:${screenshot.mimeType};base64,${screenshot.base64}`} alt={t('computer.screen')} className="h-auto w-full select-none touch-none" draggable={false} onPointerDown={(event) => {
            region.current?.focus()
            const position = point(event)
            if (!position) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            pointer.current = { ...position, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' }
          }} onPointerMove={(event) => {
            if (pointer.current || click.current || moving.current || Date.now() - lastMove.current < 150) return
            const position = point(event)
            if (!position) return
            lastMove.current = Date.now()
            moving.current = true
            void send({ type: 'move', ...position }).finally(() => { moving.current = false })
          }} onPointerCancel={() => { pointer.current = null }} onPointerUp={(event) => {
            const from = pointer.current
            pointer.current = null
            const to = point(event)
            if (!from || !to) return
            if (Math.hypot(from.x - to.x, from.y - to.y) > 4 && from.button === 'left') void send({ type: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y })
            else {
              const previous = click.current
              if (previous && previous.action.button === from.button && Math.hypot(previous.action.x - to.x, previous.action.y - to.y) <= 4) {
                window.clearTimeout(previous.timer)
                click.current = null
                void send({ type: 'click', ...to, button: from.button, clickCount: 2 })
              } else {
                if (previous) { window.clearTimeout(previous.timer); click.current = null; void send(previous.action) }
                const action = { type: 'click' as const, ...to, button: from.button }
                click.current = { action, timer: window.setTimeout(() => { click.current = null; void send(action) }, 220) }
              }
            }
          }} onWheel={(event) => {
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            void send({ type: 'scroll', x: screenshot.originX + Math.min(screenshot.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * screenshot.width / bounds.width))), y: screenshot.originY + Math.min(screenshot.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * screenshot.height / bounds.height))), deltaX: Math.sign(event.deltaX) * 120, deltaY: Math.sign(event.deltaY) * 120 })
          }} /> : <p className="p-4 text-xs text-white">{t('computer.capturing')}</p>}
        </div>
        <div className="space-y-2 border-t p-2">
          <p className="text-caption text-muted-foreground">{t('computer.keyboardHelp')}</p>
          <div className="flex gap-1">{['Tab', 'Escape', 'Enter', 'Ctrl+L', 'Ctrl+C'].map((key) => <Button key={key} size="sm" variant="outline" className="h-7 px-2 text-caption" onClick={() => { void send({ type: 'key', key }) }}>{key}</Button>)}</div>
          <textarea value={text} maxLength={COMPUTER_TYPE_MAX_LENGTH} onChange={(event) => setText(event.target.value)} aria-label={t('computer.text')} placeholder={t('computer.textHelp')} className="min-h-16 w-full rounded border bg-background p-2 text-xs" />
          <Button size="sm" disabled={!text || typing} onClick={() => {
            const value = text
            const ownGeneration = generation.current
            setTyping(true)
            void send({ type: 'type', text: value }).then((sent) => { if (sent && generation.current === ownGeneration) setText((current) => current === value ? '' : current) }).finally(() => { if (generation.current === ownGeneration) setTyping(false) })
          }}>{t('computer.sendText')}</Button>
        </div>
      </>}
    </div>
  )
  return expanded ? <Dialog open onOpenChange={(open) => { if (!open) setExpanded(false) }}>
    <DialogContent className="!left-4 !top-4 !block !h-[calc(100dvh-2rem)] !w-[calc(100vw-2rem)] !max-w-none translate-x-0 translate-y-0 overflow-hidden p-0" data-testid="computer-expanded-dialog" onEscapeKeyDown={(event) => {
      if (event.target instanceof Element && event.target.closest('[data-computer-input="true"]')) event.preventDefault()
    }}>
      <DialogTitle className="sr-only">{t('computer.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('computer.description')}</DialogDescription>
      {panel}
    </DialogContent>
  </Dialog> : panel
}
