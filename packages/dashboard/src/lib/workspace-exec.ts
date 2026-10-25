/**
 * Thin dashboard-side client for the generic workspace:exec /
 * workspace:read_binary sockets (docs/planning/roadmap-notes/
 * workspace-exec-refactor.md).
 *
 * Replaces the per-feature request helpers scattered across
 * SourceControlPanel / SessionFilesPanel / useBackgroundTasks. All
 * domain parsing (git porcelain, ls output, bg task list) now runs in
 * the dashboard on top of these two primitives.
 */

import { randomId } from './random-id.js'
import { dashboardConnectionManager, workspaceSubscriptionChannels } from '../session.js'
import type { Socket } from 'socket.io-client'

import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
} from '@agent-kernel/shared'
import type {
  WorkspaceExecRequest,
  WorkspaceExecResponse,
  WorkspaceReadBinaryRequest,
  WorkspaceReadBinaryResponse,
} from '@agent-kernel/shared/workspace-exec'

export type WorkspaceSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

export type WorkspaceExecOptions = {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  stdin?: string
  /** Ack timeout — how long to wait for the host round-trip. Defaults to
   *  `timeoutMs + 2000` so the ack always outlasts a legitimate command. */
  ackTimeoutMs?: number
}

const DEFAULT_ACK_BUFFER_MS = 2_000

export async function ensureWorkspaceSubscription(socket: WorkspaceSocket, workspaceId: string, sessionId?: string): Promise<() => void> {
  // Lightweight feature-test sockets used by isolated panels predate channel
  // subscriptions; production Socket.IO sockets always provide on/off.
  if (typeof socket.on !== 'function' || typeof socket.off !== 'function' || !('io' in socket)) return () => {}
  const manager = dashboardConnectionManager(socket)
  const channels = workspaceSubscriptionChannels(socket, workspaceId, sessionId)
  const releases = channels.map((channel) => manager.acquire(channel))
  const release = (): void => releases.forEach((dispose) => dispose())
  try {
    const active = await Promise.all(channels.map((channel) => manager.waitUntilActive(channel)))
    if (!active.every(Boolean)) throw new Error('Unable to subscribe to this workspace Session.')
    return release
  } catch (error) { release(); throw error }
}

function workspaceReadFailure(requestId: string, code: 'EACCES' | 'ENOENT' | 'EINVAL' | 'EIO', message: string): WorkspaceReadBinaryResponse {
  return { requestId, base64: '', mime: 'application/octet-stream', size: 0, error: { code, message } }
}

export async function workspaceExec(
  socket: WorkspaceSocket,
  workspaceId: string,
  argv: readonly string[],
  options: WorkspaceExecOptions = {},
): Promise<WorkspaceExecResponse> {
  const releaseSubscription = await ensureWorkspaceSubscription(socket, workspaceId)
  const requestId = randomId()
  const payload: WorkspaceExecRequest = {
    requestId,
    workspaceId,
    argv,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
  }
  const ackTimeout = options.ackTimeoutMs ?? ((options.timeoutMs ?? 15_000) + DEFAULT_ACK_BUFFER_MS)
  return await new Promise<WorkspaceExecResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      releaseSubscription()
      resolve({
        requestId,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: ackTimeout,
        error: { code: 'ETIMEDOUT', message: `dashboard ack timeout after ${ackTimeout}ms` },
      })
    }, ackTimeout)
    socket.emit('workspace:exec', payload, (result: WorkspaceExecResponse) => {
      window.clearTimeout(timer)
      releaseSubscription()
      resolve(result)
    })
  })
}

export type WorkspaceReadBinaryOptions = {
  cwd?: string
  offset?: number
  maxBytes?: number
  ackTimeoutMs?: number
}

export async function workspaceReadBinary(
  socket: WorkspaceSocket,
  workspaceId: string,
  path: string,
  options: WorkspaceReadBinaryOptions = {},
): Promise<WorkspaceReadBinaryResponse> {
  const requestId = randomId()
  let releaseSubscription: () => void = () => {}
  try {
    releaseSubscription = await ensureWorkspaceSubscription(socket, workspaceId)
  } catch (error) {
    return workspaceReadFailure(requestId, 'EIO', error instanceof Error ? error.message : String(error))
  }
  const payload: WorkspaceReadBinaryRequest = {
    requestId,
    workspaceId,
    path,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  }
  const ackTimeout = options.ackTimeoutMs ?? 12_000
  return await new Promise<WorkspaceReadBinaryResponse>((resolve) => {
    let settled = false
    const finish = (result: WorkspaceReadBinaryResponse): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (typeof socket.off === 'function') socket.off('disconnect', onDisconnect)
      releaseSubscription()
      resolve(result)
    }
    const onDisconnect = (): void => finish(workspaceReadFailure(requestId, 'EIO', 'workspace connection closed while reading file'))
    const timer = window.setTimeout(() => {
      finish(workspaceReadFailure(requestId, 'EIO', `dashboard ack timeout after ${ackTimeout}ms`))
    }, ackTimeout)
    if (typeof socket.on === 'function') socket.on('disconnect', onDisconnect)
    try {
      socket.emit('workspace:read_binary', payload, (result: WorkspaceReadBinaryResponse) => {
        if (!result || typeof result !== 'object' || typeof result.base64 !== 'string' || typeof result.mime !== 'string' || typeof result.size !== 'number') {
          finish(workspaceReadFailure(requestId, 'EIO', 'invalid file response from host'))
          return
        }
        finish(result)
      })
    } catch (error) {
      finish(workspaceReadFailure(requestId, 'EIO', error instanceof Error ? error.message : String(error)))
    }
  })
}
