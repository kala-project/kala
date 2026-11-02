import {
  APP_DEBUG_ACK_MS, AppDebugControlSchema, appDebugFailure,
  type AppDebugContext, type AppDebugReply,
} from '@agent-kernel/shared'
import type { Socket } from 'socket.io'
import type { DashboardClientToServerEvents, DashboardServerToClientEvents } from '@agent-kernel/shared'
import type { ExecutorRegistry } from './executor.js'
import { appDebugRelayFor } from './app-debug.js'

export function registerAppDebugDashboard(
  socket: Socket<DashboardClientToServerEvents, DashboardServerToClientEvents>,
  options: {
    executors: ExecutorRegistry
    captureCurrent?(sessionId: string): (() => boolean) | undefined
    resolveContext(sessionId: string): Promise<AppDebugContext | { error: string }>
  },
): void {
  const relay = appDebugRelayFor(options.executors)
  const denied = () => appDebugFailure('Application debugging requires runtime:write permission. Ask a Workspace owner or administrator for access; no forwarding was enabled.')
  socket.on('disconnect', () => relay.closeOwner(socket.id))
  socket.on('app_debug:frame', (frame, ack) => {
    if (typeof ack !== 'function') return
    if (socket.data.readOnly === true) { ack(denied()); return }
    void relay.frame(socket.id, frame).then(ack, () => ack(appDebugFailure('Debug relay failed. Check forwarding and application state before retrying; the request may already have executed.')))
  })
  socket.on('app_debug:control', (input, ack) => {
    if (typeof ack !== 'function') return
    const execute = async (): Promise<AppDebugReply> => {
      if (!socket.connected) return appDebugFailure('Dashboard disconnected. Reconnect and explicitly restart forwarding.')
      if (socket.data.readOnly === true) return denied()
      const parsed = AppDebugControlSchema.safeParse(input)
      if (!parsed.success) return appDebugFailure('Invalid application debugging settings. Select a Session and 1–8 unique ports between 1024 and 65535; no group was started.')
      const request = parsed.data
      if (request.op === 'stop') {
        if (request.grantId) return relay.stopOwnerGrant(socket.id, request.grantId)
        relay.closeOwner(socket.id, 'Forwarding cancelled by the desktop. No active group remains for this connection.')
        return { ok: true }
      }
      if (request.op === 'renew') return relay.renew(socket.id, request.grantId)
      const admission = request.op === 'start' ? relay.beginStart(socket.id) : undefined
      try {
        const context = await options.resolveContext(request.sessionId)
        if (admission && !admission.current()) return appDebugFailure('Debug Start was cancelled, superseded or interrupted by Runtime drain while authorization was pending. No group was started; explicitly start again after checking readiness.')
        if ('error' in context) return appDebugFailure(context.error)
        if (!socket.connected) return appDebugFailure('Dashboard disconnected while checking the selected Workspace. Reconnect before starting forwarding.')
        if (request.op === 'context') return { ok: true, context }
        if (context.executorId !== request.executorId) return appDebugFailure('Selected Executor changed. Reopen desktop settings to review the target; forwarding was not started.')
        const current = options.captureCurrent?.(request.sessionId)
        if (options.captureCurrent && !current) return appDebugFailure('No healthy local Session owner fence is available. Update the Runtime or wait for its owner to recover, then explicitly restart; no forwarding was enabled.')
        return await relay.start({
          ...(current ? { current } : {}),
          owner: socket.id, workspaceId: context.workspaceId, executorId: context.executorId, ports: request.ports,
          authorize: async () => {
            if (!socket.connected) return 'Dashboard disconnected. Forwarding authorization was revoked.'
            const current = await options.resolveContext(request.sessionId)
            if ('error' in current) return current.error
            return current.principalKey === context.principalKey && current.workspaceId === context.workspaceId && current.executorId === context.executorId
              ? undefined : 'Account, Workspace or Executor changed. Review the target and explicitly restart forwarding.'
          },
          deliver: (frame) => socket.connected
            ? socket.timeout(APP_DEBUG_ACK_MS).emitWithAck('app_debug:frame', frame)
            : Promise.resolve(appDebugFailure('Dashboard disconnected; application bytes were not replayed.')),
          closed: (event) => { if (socket.connected) socket.emit('app_debug:closed', event) },
        })
      } finally { admission?.release() }
    }
    void execute().then(ack, () => ack(appDebugFailure('Could not establish application debugging. Verify the selected Session, access and connectivity, then try again.')))
  })
}
