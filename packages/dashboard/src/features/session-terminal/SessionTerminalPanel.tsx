import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Eraser, Loader2, Minus, Pin, PinOff, Play, Plus, RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ServerTerminalExit, ServerTerminalOutput } from '@agent-kernel/shared'
import { Button } from '../../components/ui/button.js'
import type { DashboardSocket } from '../../session.js'
import { useInterfaceScale } from '../../lib/interface-scale.js'
import { DASHBOARD_PREFERENCES, useBooleanPref, useNumberPref } from '../../lib/prefs.js'
import { installTerminalLineBreakInput } from './terminal-keyboard.js'
import { createTerminal, killTerminal } from './terminal-rpc.js'

type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'
type TerminalPreferenceScope = 'session' | 'workspace'

const DEFAULT_TERMINAL_FONT_SIZE = 12
const MIN_TERMINAL_FONT_SIZE = 10
const MAX_TERMINAL_FONT_SIZE = 24

export function SessionTerminalPanel({
  socket,
  workspaceId,
  sessionId,
  cwd,
  online = true,
  autoStart = false,
  visible = true,
  preferenceScope = 'session',
  onKeepRunningChange,
  onStatusChange,
}: {
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId: string
  cwd?: string
  online?: boolean
  autoStart?: boolean
  visible?: boolean
  preferenceScope?: TerminalPreferenceScope
  onKeepRunningChange?(keepRunning: boolean): void
  onStatusChange?(status: TerminalStatus): void
}): JSX.Element {
  const { t } = useTranslation()
  const interfaceScale = useInterfaceScale()
  const preferenceIdentity = preferenceScope === 'workspace' ? workspaceId ?? sessionId : sessionId
  const preferenceSuffix = `${preferenceScope}:${encodeURIComponent(preferenceIdentity)}`
  const [keepRunning, setKeepRunning] = useBooleanPref(
    `${DASHBOARD_PREFERENCES.terminalKeepRunningPrefix.key}${preferenceSuffix}`,
    true,
  )
  const [fontSize, setFontSize] = useNumberPref(
    `${DASHBOARD_PREFERENCES.terminalFontSizePrefix.key}${preferenceSuffix}`,
    DEFAULT_TERMINAL_FONT_SIZE,
    { min: MIN_TERMINAL_FONT_SIZE, max: MAX_TERMINAL_FONT_SIZE },
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const identityRef = useRef(`${workspaceId ?? ''}:${sessionId}`)
  const [terminalId, setTerminalIdState] = useState<string | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const inputContextRef = useRef({ socket, workspaceId, sessionId, status })
  const autoStartedRef = useRef(false)
  const disposedRef = useRef(false)
  const pendingCreateRef = useRef<ReturnType<typeof createTerminal> | null>(null)
  const keepRunningRef = useRef(keepRunning)
  const fitFrameRef = useRef<number | null>(null)
  const lastSizeRef = useRef<{ terminalId: string; cols: number; rows: number } | null>(null)
  inputContextRef.current = { socket, workspaceId, sessionId, status }
  keepRunningRef.current = keepRunning

  const setTerminalId = useCallback((value: string | null): void => {
    terminalIdRef.current = value
    lastSizeRef.current = null
    setTerminalIdState(value)
  }, [])

  const scheduleFitAndResize = useCallback((terminalIdOverride?: string): void => {
    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null
        const host = hostRef.current
        const term = terminalRef.current
        const fit = fitRef.current
        if (!host || !term || !fit || host.clientWidth <= 0 || host.clientHeight <= 0) return
        fit.fit()
        host.dataset.terminalCols = String(term.cols)
        host.dataset.terminalRows = String(term.rows)
        const id = terminalIdOverride ?? terminalIdRef.current
        if (!socket || !workspaceId || !id || term.cols <= 0 || term.rows <= 0) return
        const previous = lastSizeRef.current
        if (previous?.terminalId === id && previous.cols === term.cols && previous.rows === term.rows) return
        lastSizeRef.current = { terminalId: id, cols: term.cols, rows: term.rows }
        socket.emit('terminal:resize', { workspaceId, sessionId, terminalId: id, cols: term.cols, rows: term.rows })
      })
    })
  }, [sessionId, socket, workspaceId])

  useEffect(() => {
    const term = new XTerm({ cursorBlink: true, fontSize: 12, convertEol: true, rows: 12, theme: { background: '#0b0f14' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new SearchAddon())
    terminalRef.current = term
    fitRef.current = fit
    const inputDisposable = term.onData((data) => {
      const current = inputContextRef.current
      const id = terminalIdRef.current
      if (!current.socket || !current.workspaceId || !id || current.status !== 'running') return
      current.socket.emit('terminal:input', {
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        terminalId: id,
        data,
      })
    })
    let disposeLineBreakInput = (): void => {}
    if (hostRef.current) {
      term.open(hostRef.current)
      disposeLineBreakInput = installTerminalLineBreakInput(term)
      fit.fit()
    }
    return () => {
      disposeLineBreakInput()
      inputDisposable.dispose()
      term.dispose()
      terminalRef.current = null
      fitRef.current = null
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.fontSize = Math.round(fontSize * interfaceScale)
    scheduleFitAndResize()
  }, [fontSize, interfaceScale, scheduleFitAndResize])

  useEffect(() => {
    onKeepRunningChange?.(keepRunning)
  }, [keepRunning, onKeepRunningChange])

  useEffect(() => {
    onStatusChange?.(status)
  }, [onStatusChange, status])

  useEffect(() => {
    if (visible) scheduleFitAndResize()
  }, [scheduleFitAndResize, visible])

  useEffect(() => {
    const identity = `${workspaceId ?? ''}:${sessionId}`
    if (identityRef.current === identity) return
    pendingCreateRef.current?.cancel()
    pendingCreateRef.current = null
    autoStartedRef.current = false
    identityRef.current = identity
    setTerminalId(null)
    setStatus('idle')
    setError(null)
    terminalRef.current?.clear()
    terminalRef.current?.write('\u001bc')
  }, [sessionId, setTerminalId, workspaceId])

  useEffect(() => {
    if (!socket) return
    const onOutput = (payload: ServerTerminalOutput): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId || payload.terminalId !== terminalIdRef.current) return
      terminalRef.current?.write(payload.data)
    }
    const onExit = (payload: ServerTerminalExit): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId || payload.terminalId !== terminalIdRef.current) return
      setStatus('exited')
      terminalRef.current?.writeln(`\r\n[${t('terminal.exited', { code: payload.exitCode ?? payload.signal ?? t('terminal.unknown') })}]`)
    }
    socket.on('server:terminal_output', onOutput)
    socket.on('server:terminal_exit', onExit)
    return () => {
      socket.off('server:terminal_output', onOutput)
      socket.off('server:terminal_exit', onExit)
    }
  }, [sessionId, socket, t, workspaceId])

  useEffect(() => {
    if (visible && status === 'running' && terminalId) terminalRef.current?.focus()
  }, [status, terminalId, visible])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => scheduleFitAndResize())
    observer.observe(host)
    if (host.parentElement) observer.observe(host.parentElement)
    const onLayoutChange = (): void => scheduleFitAndResize()
    let active = true
    window.addEventListener('resize', onLayoutChange)
    document.addEventListener('visibilitychange', onLayoutChange)
    void document.fonts?.ready.then(() => {
      if (active) onLayoutChange()
    })
    scheduleFitAndResize()
    return () => {
      observer.disconnect()
      active = false
      window.removeEventListener('resize', onLayoutChange)
      document.removeEventListener('visibilitychange', onLayoutChange)
    }
  }, [scheduleFitAndResize])

  const start = useCallback(async (): Promise<void> => {
    if (!socket || !workspaceId || !online || pendingCreateRef.current) return
    setStatus('starting')
    setError(null)
    fitRef.current?.fit()
    const term = terminalRef.current
    const request = createTerminal(socket, { workspaceId, sessionId, cwd, cols: term?.cols ?? 100, rows: term?.rows ?? 12 })
    pendingCreateRef.current = request
    const result = await request.result
    if (disposedRef.current || pendingCreateRef.current !== request || identityRef.current !== `${workspaceId}:${sessionId}`) {
      request.cancel()
      return
    }
    pendingCreateRef.current = null
    request.accept()
    if (result.error || !result.terminalId) {
      setStatus('error')
      setError(result.error ?? t('terminal.startFailed'))
      return
    }
    setTerminalId(result.terminalId)
    setStatus('running')
    if (result.replay) term?.write(result.replay)
    if (!result.reused && result.cwd) term?.writeln(t('terminal.connected', { cwd: result.cwd }))
    scheduleFitAndResize(result.terminalId)
    term?.focus()
  }, [cwd, online, scheduleFitAndResize, sessionId, setTerminalId, socket, t, workspaceId])

  useEffect(() => {
    if (!autoStart || autoStartedRef.current || !socket || !workspaceId || !online) return
    autoStartedRef.current = true
    void start()
  }, [autoStart, online, socket, start, workspaceId])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      if (pendingCreateRef.current) {
        pendingCreateRef.current.cancel()
        pendingCreateRef.current = null
        autoStartedRef.current = false
      }
      const id = terminalIdRef.current
      if (!keepRunningRef.current && socket && workspaceId && id) {
        void killTerminal(socket, { workspaceId, sessionId, terminalId: id })
      }
    }
  }, [sessionId, socket, workspaceId])

  const kill = useCallback(async (): Promise<boolean> => {
    if (!socket || !workspaceId || !terminalIdRef.current) return false
    const result = await killTerminal(socket, { workspaceId, sessionId, terminalId: terminalIdRef.current })
    if (!result.killed) {
      if (result.error) setError(result.error)
      return false
    }
    setStatus('exited')
    return true
  }, [sessionId, socket, workspaceId])

  const restart = useCallback(async (): Promise<void> => {
    if (status === 'running' && !(await kill())) return
    setTerminalId(null)
    await start()
  }, [kill, setTerminalId, start, status])

  const sendKey = (data: string): void => {
    const id = terminalIdRef.current
    if (!socket || !workspaceId || !id || status !== 'running') return
    // Touch arrows must follow the same DECCKM mode as xterm's physical keys.
    const input = /^\u001b\[[ABCD]$/.test(data) && terminalRef.current?.modes.applicationCursorKeysMode
      ? data.replace('[', 'O')
      : data
    socket.emit('terminal:input', { workspaceId, sessionId, terminalId: id, data: input })
    terminalRef.current?.focus()
  }

  const disabled = !socket || !workspaceId || !online
  const statusLabel = !online ? t('terminal.offline') : error ? `${t(`terminal.status.${status}`)} · ${error}` : t(`terminal.status.${status}`)

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#0b0f14] text-white" data-testid="session-terminal-panel" data-terminal-status={status}>
      <div className="relative flex min-h-10 flex-none flex-nowrap items-center gap-1.5 overflow-hidden border-b border-border/35 bg-card/95 px-2 py-1 text-card-foreground sm:px-3" data-testid="terminal-toolbar">
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 truncate text-xs text-muted-foreground" data-testid="terminal-status"><span className={`h-1.5 w-1.5 flex-none rounded-full ${!online || status === 'error' ? 'bg-rose-500' : status === 'running' ? 'bg-emerald-500' : status === 'starting' ? 'animate-pulse bg-amber-500' : 'bg-muted-foreground/50'}`} />{statusLabel}</span>
        <div className="flex flex-none items-center rounded-lg border border-border/45 bg-background/35" data-testid="terminal-font-controls">
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 rounded-r-none" disabled={fontSize <= MIN_TERMINAL_FONT_SIZE} onClick={() => setFontSize(fontSize - 1)} title={t('terminal.decreaseFont')} aria-label={t('terminal.decreaseFont')} data-testid="terminal-font-decrease"><Minus className="h-3.5 w-3.5" /></Button>
          <Button type="button" variant="ghost" className="h-8 min-w-8 rounded-none px-1 font-mono text-[11px] tabular-nums" onClick={() => setFontSize(DEFAULT_TERMINAL_FONT_SIZE)} title={t('terminal.resetFont')} aria-label={t('terminal.resetFont')} data-testid="terminal-font-size">{fontSize}</Button>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 rounded-l-none" disabled={fontSize >= MAX_TERMINAL_FONT_SIZE} onClick={() => setFontSize(fontSize + 1)} title={t('terminal.increaseFont')} aria-label={t('terminal.increaseFont')} data-testid="terminal-font-increase"><Plus className="h-3.5 w-3.5" /></Button>
        </div>
        <Button
          type="button"
          size="icon"
          variant={keepRunning ? 'outline' : 'ghost'}
          className={`h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8 ${keepRunning ? 'border-primary/40 bg-primary/10 text-primary' : ''}`}
          onClick={() => setKeepRunning(!keepRunning)}
          title={keepRunning ? t('terminal.keepRunningOn') : t('terminal.keepRunningOff')}
          aria-label={t('terminal.keepRunning')}
          aria-pressed={keepRunning}
          data-testid="terminal-keep-running"
        >
          {keepRunning ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </Button>
        <Button type="button" size="sm" className="h-11 flex-none gap-1.5 rounded-lg px-3 sm:h-8" disabled={disabled || status === 'starting' || status === 'running'} onClick={() => void start()} data-testid="terminal-start">
          {status === 'starting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('terminal.start')}
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8" disabled={disabled || status === 'starting'} onClick={() => void restart()} title={t('terminal.restart')} aria-label={t('terminal.restart')} data-testid="terminal-restart"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <Button type="button" size="icon" variant="ghost" className="h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8" disabled={!terminalId || status !== 'running'} onClick={() => void kill()} title={t('terminal.kill')} aria-label={t('terminal.kill')} data-testid="terminal-kill"><Square className="h-3.5 w-3.5" /></Button>
        <Button type="button" size="icon" variant="ghost" className="h-11 w-11 flex-none rounded-lg sm:h-8 sm:w-8" onClick={() => terminalRef.current?.clear()} title={t('terminal.clear')} aria-label={t('terminal.clear')}><Eraser className="h-3.5 w-3.5" /></Button>
        {status === 'starting' ? <span className="ak-terminal-connecting absolute inset-x-0 bottom-0 h-px" aria-hidden="true" /> : null}
      </div>
      {!online ? <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">{t('terminal.offlineHelp')}</div> : null}
      <div
        ref={hostRef}
        className="min-h-0 min-w-0 flex-1 cursor-text overflow-hidden p-1.5 outline-none ring-inset focus-within:ring-1 focus-within:ring-primary/50 [&_.xterm]:h-full"
        data-testid="terminal-viewport"
        onPointerDown={() => terminalRef.current?.focus()}
        onTouchStart={() => terminalRef.current?.focus()}
      />
      <div className="grid flex-none grid-cols-6 gap-1 border-t border-border/40 bg-card px-2 py-1.5 text-card-foreground sm:flex sm:flex-wrap" data-testid="terminal-touch-keys">
        {([[t('terminal.keys.esc'), '\u001b'], [t('terminal.keys.tab'), '\t'], [t('terminal.keys.enter', { defaultValue: 'Enter' }), '\r'], ['Ctrl+C', '\u0003'], ['Ctrl+D', '\u0004'], ['Ctrl+Z', '\u001a'], ['Ctrl+B', '\u0002'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C']] as const).map(([label, data]) => (
          <Button key={label} type="button" size="sm" variant="outline" className="h-11 min-w-0 px-1 font-mono text-xs sm:h-8 sm:min-w-10 sm:px-2" disabled={status !== 'running'} onPointerDown={(event) => event.preventDefault()} onClick={() => sendKey(data)}>{label}</Button>
        ))}
      </div>
    </div>
  )
}
