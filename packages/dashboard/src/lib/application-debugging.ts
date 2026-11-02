import {
  APP_DEBUG_ACK_MS, APP_DEBUG_LEASE_MS, AppDebugFrameSchema, AppDebugPortsSchema,
  appDebugFailure, appDebugOk, isAppDebugReply,
  type AppDebugClosed, type AppDebugControl, type AppDebugFrame, type AppDebugReply,
} from '@agent-kernel/shared'
import type { DashboardSocket } from '../session.js'
import type { ApplicationDebugBridge, NativeDebugEvent } from './desktop-bridge.js'

type Active = { id: string; run: number; generation: number; renewing: boolean }
type Scope = { alive: boolean; generation: number | null; run: number; cancelledThrough: number; executorId?: string; active?: Active; timer?: ReturnType<typeof setInterval> }
const interrupted = () => appDebugFailure('Debug connection interrupted or the Host does not support application debugging v1. Check connectivity and versions before restarting; application requests may already have executed.')

/** No discovery, inactive polling, credentials, payload logs, retries or reconnect queue. */
export function connectApplicationDebugging(bridge: ApplicationDebugBridge, socket: DashboardSocket, sessionId: string): () => void {
  let current: Scope | undefined
  let disposed = false
  const control = async (request: AppDebugControl): Promise<AppDebugReply> => {
    if (!socket.connected) return interrupted()
    try {
      const reply: unknown = await socket.timeout(APP_DEBUG_ACK_MS).emitWithAck('app_debug:control', request)
      return isAppDebugReply(reply) ? reply : interrupted()
    } catch { return interrupted() }
  }
  const stopHost = (grantId?: string) => { if (socket.connected) void control({ op: 'stop', ...(grantId ? { grantId } : {}) }) }
  const clearActive = (scope: Scope) => { clearInterval(scope.timer); scope.timer = undefined; scope.active = undefined }
  const invalidate = (scope: Scope): void => {
    scope.alive = false
    stopHost(scope.active?.id)
    clearActive(scope)
    if (scope.generation !== null) void bridge.detach(scope.generation).catch(() => {})
  }
  const abort = async (scope: Scope, active: Active, error: string): Promise<void> => {
    if (!scope.alive || scope.active !== active) return
    clearActive(scope)
    stopHost(active.id)
    await bridge.abort(active.generation, active.run, error).catch(() => {})
  }
  const nativeEvent = async (scope: Scope, event: NativeDebugEvent): Promise<void> => {
    if (!scope.alive || !Number.isSafeInteger(event.generation) || !Number.isSafeInteger(event.run) || event.generation <= 0 || event.run <= 0) return
    if (scope.generation !== null && scope.generation !== event.generation) return
    scope.generation = event.generation
    if (event.request.op === 'stop') {
      scope.cancelledThrough = Math.max(scope.cancelledThrough, event.run)
      if (event.run < scope.run && !event.request.grantId) return
      const grantId = event.request.grantId ?? (scope.active?.run === event.run ? scope.active.id : undefined)
      if (scope.active?.run === event.run) clearActive(scope)
      stopHost(grantId)
      return
    }
    if (event.id === 0 && event.request.op === 'frame') {
      const closed = AppDebugFrameSchema.safeParse(event.request.frame)
      if (closed.success && closed.data.op === 'close' && closed.data.grantId === scope.active?.id && socket.connected) void socket.timeout(APP_DEBUG_ACK_MS).emitWithAck('app_debug:frame', closed.data).catch(() => {})
      return
    }
    if (!Number.isSafeInteger(event.id) || event.id <= 0) return
    let result: AppDebugReply
    if (event.request.op === 'start') {
      if (!scope.executorId || event.run <= scope.run || event.run <= scope.cancelledThrough || !AppDebugPortsSchema.safeParse(event.request.ports).success) {
        result = appDebugFailure('Stale or invalid native debug start was rejected. Review ports and explicitly restart.')
      } else {
        scope.run = event.run
        result = await control({ op: 'start', sessionId, executorId: scope.executorId, ports: event.request.ports })
        if (result.ok && result.grantId && /^[A-Za-z0-9_-]{1,80}$/u.test(result.grantId)) {
          if (!scope.alive || scope.run !== event.run || scope.cancelledThrough >= event.run) { stopHost(result.grantId); return }
          const active: Active = { id: result.grantId, run: event.run, generation: event.generation, renewing: false }
          scope.active = active
          scope.timer = setInterval(() => {
            if (!scope.alive || scope.active !== active || active.renewing) return
            active.renewing = true
            void control({ op: 'renew', grantId: active.id }).then(async (reply) => {
              if (!scope.alive || scope.active !== active) return
              if (!reply.ok) { await abort(scope, active, reply.error); return }
              try { await bridge.touch(active.generation, active.id) } catch { await abort(scope, active, 'Desktop forwarding authorization is no longer active. Restart from settings.') }
            }).finally(() => { active.renewing = false })
          }, APP_DEBUG_LEASE_MS / 2)
        } else if (result.ok) {
          stopHost()
          result = appDebugFailure('Host did not return a valid debug grant. Update the Host before restarting forwarding.')
        }
      }
    } else {
      const parsed = AppDebugFrameSchema.safeParse(event.request.frame)
      if (!parsed.success || !scope.active || parsed.data.grantId !== scope.active.id || event.run !== scope.active.run) result = appDebugFailure('Native debug stream is no longer active. Reload after checking forwarding status.')
      else if (!socket.connected) result = interrupted()
      else {
        try {
          const reply: unknown = await socket.timeout(APP_DEBUG_ACK_MS).emitWithAck('app_debug:frame', parsed.data)
          result = isAppDebugReply(reply) ? reply : interrupted()
        } catch { result = interrupted() }
      }
    }
    if (!scope.alive) { if (result.ok && result.grantId) stopHost(result.grantId); return }
    try { await bridge.reply(event.generation, event.id, result) } catch {
      if (result.ok && result.grantId) stopHost(result.grantId)
      if (scope.active?.run === event.run) clearActive(scope)
    }
  }
  const connect = (): void => {
    if (disposed) return
    if (current) invalidate(current)
    const scope: Scope = { alive: true, generation: null, run: 0, cancelledThrough: 0 }
    current = scope
    void (async () => {
      const generation = await bridge.begin((event) => { void nativeEvent(scope, event).catch(() => {}) })
      scope.generation = generation
      if (!scope.alive) { await bridge.detach(generation); return }
      const reply = await control({ op: 'context', sessionId })
      if (!scope.alive) return
      if (!reply.ok || !reply.context) { await bridge.unavailable(generation, reply.ok ? 'Host returned no debug context. Update it before retrying.' : reply.error); return }
      scope.executorId = reply.context.executorId
      await bridge.setContext(generation, { ...reply.context, sessionId })
    })().catch(() => {
      if (scope.alive && scope.generation !== null) void bridge.unavailable(scope.generation, 'Native debugging could not be initialized. Check that the desktop and Host support application debugging v1.').catch(() => {})
    })
  }
  const disconnect = (): void => { if (current) invalidate(current); current = undefined }
  const frame = (input: AppDebugFrame, ack: (reply: AppDebugReply) => void): void => {
    if (typeof ack !== 'function') return
    const scope = current; const parsed = AppDebugFrameSchema.safeParse(input)
    if (!scope?.alive || scope.generation === null || !parsed.success || parsed.data.op === 'open' || parsed.data.grantId !== scope.active?.id) { ack(interrupted()); return }
    void bridge.receive(scope.generation, parsed.data).then(() => ack(appDebugOk), () => ack(appDebugFailure('Desktop TCP write failed or the stream was closed. Inspect application state before retrying.')))
  }
  const closed = (event: AppDebugClosed): void => { const scope = current; if (scope?.active?.id === event.grantId) void abort(scope, scope.active, event.error) }
  socket.on('connect', connect); socket.on('disconnect', disconnect); socket.on('app_debug:frame', frame); socket.on('app_debug:closed', closed)
  if (socket.connected) connect()
  return () => { disposed = true; disconnect(); socket.off('connect', connect); socket.off('disconnect', disconnect); socket.off('app_debug:frame', frame); socket.off('app_debug:closed', closed) }
}
