import { createTerminalRequestManager, TERMINAL_CREATE_CLIENT_TIMEOUT_MS } from '@agent-kernel/shared'
import type { TerminalKillResult } from '@agent-kernel/shared'
import { randomId } from '../../lib/random-id.js'
import type { DashboardSocket } from '../../session.js'

const requestsBySocket = new WeakMap<DashboardSocket, ReturnType<typeof createTerminalRequestManager>>()

export function createTerminal(socket: DashboardSocket, payload: { workspaceId: string; sessionId: string; cwd?: string; cols: number; rows: number }) {
  let requests = requestsBySocket.get(socket)
  if (!requests) {
    requests = createTerminalRequestManager({
      timeoutMs: TERMINAL_CREATE_CLIENT_TIMEOUT_MS,
      emit: (body, ack) => { socket.emit('terminal:create', body, ack) },
      dispose: (body, result) => {
        void killTerminal(socket, { workspaceId: body.workspaceId, sessionId: body.sessionId, terminalId: result.terminalId! })
      },
    })
    requestsBySocket.set(socket, requests)
  }
  return requests.request({ requestId: randomId(), ...payload })
}

export async function killTerminal(socket: DashboardSocket, payload: { workspaceId: string; sessionId: string; terminalId: string }): Promise<TerminalKillResult> {
  return await new Promise((resolve) => {
    const requestId = randomId()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'timed out' }), 5000)
    socket.emit('terminal:kill', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}
