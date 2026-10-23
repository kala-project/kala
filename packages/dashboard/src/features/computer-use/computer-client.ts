import { ComputerResponseSchema, type ComputerRequest, type ComputerResponse } from '@agent-kernel/shared'
import type { WorkspaceSocket } from '../../lib/workspace-exec.js'
import { dashboardConnectionManager } from '../../session.js'

export async function requestComputer(socket: WorkspaceSocket, request: ComputerRequest): Promise<ComputerResponse> {
  const release: Array<() => void> = []
  try {
    if (typeof socket.on === 'function' && typeof socket.off === 'function' && 'io' in socket) {
      const manager = dashboardConnectionManager(socket)
      const channels = [`session:${request.sessionId}`, `workspace:${request.workspaceId}`] as const
      for (const channel of channels) release.push(manager.acquire(channel))
      await Promise.all(channels.map((channel) => manager.waitUntilActive(channel, 2_000)))
    }
    return await new Promise<ComputerResponse>((resolve) => {
      const timer = window.setTimeout(() => resolve({ requestId: request.requestId, error: { code: 'unavailable', message: 'Desktop request timed out; access will expire automatically if the connection is lost.' } }), 20_000)
      socket.emit('computer:request', request, (response) => {
        window.clearTimeout(timer)
        const parsed = ComputerResponseSchema.safeParse(response)
        resolve(parsed.success && parsed.data.requestId === request.requestId ? parsed.data : { requestId: request.requestId, error: { code: 'execution_error', message: typeof response?.error === 'string' ? response.error : 'The Host returned an invalid desktop response. Reconnect or update the Host and Executor.' } })
      })
    })
  } catch (error) {
    return { requestId: request.requestId, error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
  } finally {
    release.forEach((dispose) => dispose())
  }
}
