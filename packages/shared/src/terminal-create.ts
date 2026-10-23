import type { ClientTerminalCreate, TerminalCreateResult } from './protocol.js'

// Native ConPTY startup gets the standard one-minute Executor RPC budget.
// The Dashboard must outlive the Host's deadline to receive its final result.
export const TERMINAL_CREATE_ACK_TIMEOUT_MS = 60_000
export const TERMINAL_CREATE_CLIENT_TIMEOUT_MS = TERMINAL_CREATE_ACK_TIMEOUT_MS + 5_000

export function createTerminalRequestManager(options: {
  timeoutMs: number
  emit(payload: ClientTerminalCreate, ack: (result: TerminalCreateResult) => void): void
  dispose(payload: ClientTerminalCreate, result: TerminalCreateResult): void
}) {
  type Request = {
    active: boolean
    awaitingAck: boolean
    accepted: boolean
    payload: ClientTerminalCreate
    result?: TerminalCreateResult
  }
  type Group = {
    requests: Set<Request>
    claimed: Set<string>
    abandoned: Map<string, { payload: ClientTerminalCreate; result: TerminalCreateResult }>
  }
  const groups = new Map<string, Group>()

  return {
    request(payload: ClientTerminalCreate) {
      const key = JSON.stringify([payload.workspaceId, payload.sessionId])
      let group = groups.get(key)
      if (!group) {
        group = { requests: new Set(), claimed: new Set(), abandoned: new Map() }
        groups.set(key, group)
      }
      const currentGroup = group
      const request: Request = { active: true, awaitingAck: true, accepted: false, payload }
      currentGroup.requests.add(request)
      const collect = (): void => {
        const active = [...currentGroup.requests].some((entry) => entry.active)
        for (const [id, abandoned] of currentGroup.abandoned) {
          if (currentGroup.claimed.has(id)) currentGroup.abandoned.delete(id)
          else if (!active) {
            currentGroup.abandoned.delete(id)
            options.dispose(abandoned.payload, abandoned.result)
          }
        }
        if ([...currentGroup.requests].every((entry) => !entry.active && !entry.awaitingAck)) groups.delete(key)
      }
      const abandon = (): void => {
        if (request.result?.terminalId && !request.result.reused) {
          currentGroup.abandoned.set(request.result.terminalId, { payload, result: request.result })
        }
      }
      let resolve!: (result: TerminalCreateResult) => void
      const result = new Promise<TerminalCreateResult>((done) => { resolve = done })
      const cancel = (error = 'terminal create cancelled'): void => {
        if (!request.active || request.accepted) return
        request.active = false
        clearTimeout(timer)
        abandon()
        resolve({ requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error })
        collect()
      }
      const timer = setTimeout(() => cancel('terminal create acknowledgement timed out'), options.timeoutMs)
      options.emit(payload, (reply) => {
        if (!request.awaitingAck) return
        request.awaitingAck = false
        request.result = reply
        clearTimeout(timer)
        if (request.active) resolve(reply)
        else abandon()
        collect()
      })
      return {
        result,
        cancel: () => cancel(),
        accept(): void {
          if (!request.active || !request.result) return
          request.accepted = true
          request.active = false
          if (request.result.terminalId) currentGroup.claimed.add(request.result.terminalId)
          collect()
        },
      }
    },
  }
}
