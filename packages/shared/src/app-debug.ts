import { z } from 'zod'

/** Manual desktop TCP debugging v1; opaque bytes never belong in tool/history logs. */
export const APP_DEBUG_CHUNK_BYTES = 16 * 1024
export const APP_DEBUG_MAX_STREAMS = 32
export const APP_DEBUG_MAX_GRANTS = 8
export const APP_DEBUG_ACK_MS = 15_000
export const APP_DEBUG_LEASE_MS = 60_000
export const APP_DEBUG_IDLE_MS = 10 * 60_000
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u)
const sessionId = z.string().min(1).max(128)
const port = z.number().int().min(1024).max(65535)
export const AppDebugPortsSchema = z.array(port).min(1).max(8).refine((ports) => new Set(ports).size === ports.length, 'Ports must be unique')
const sequence = z.number().int().min(0).max(2_147_483_647)
const data = z.string().min(4).max(Math.ceil(APP_DEBUG_CHUNK_BYTES / 3) * 4).refine((value) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false
  const bytes = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  return bytes > 0 && bytes <= APP_DEBUG_CHUNK_BYTES && btoa(atob(value)) === value
}, 'Data must be canonical base64 encoding at most 16 KiB')
const stream = { grantId: id, streamId: id }
const OpenSchema = z.object({ ...stream, op: z.literal('open'), port }).strict()
const DataSchema = z.object({ ...stream, op: z.literal('data'), seq: sequence, data }).strict()
const EndSchema = z.object({ ...stream, op: z.literal('end'), seq: sequence }).strict()
const CloseSchema = z.object({ ...stream, op: z.literal('close') }).strict()
export const AppDebugFrameSchema = z.discriminatedUnion('op', [OpenSchema, DataSchema, EndSchema, CloseSchema])
export type AppDebugFrame = z.infer<typeof AppDebugFrameSchema>
export const AppDebugControlSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('context'), sessionId }).strict(),
  z.object({ op: z.literal('start'), sessionId, executorId: z.string().min(1).max(128), ports: AppDebugPortsSchema }).strict(),
  z.object({ op: z.literal('renew'), grantId: id }).strict(),
  z.object({ op: z.literal('stop'), grantId: id.optional() }).strict(),
])
export type AppDebugControl = z.infer<typeof AppDebugControlSchema>
export const AppDebugExecutorRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), grantId: id, ports: AppDebugPortsSchema }).strict(),
  z.object({ op: z.literal('renew'), grantId: id }).strict(),
  z.object({ op: z.literal('stop'), grantId: id }).strict(),
  OpenSchema, DataSchema, EndSchema, CloseSchema,
])
export type AppDebugExecutorRequest = z.infer<typeof AppDebugExecutorRequestSchema>
export type AppDebugContext = { principalKey: string; workspaceId: string; executorId: string }
export type AppDebugReply = { ok: true; grantId?: string; context?: AppDebugContext } | { ok: false; error: string }
export type AppDebugClosed = { grantId: string; error: string }
/** No retries: an interrupted TCP write may already have reached the application. */
export async function appDebugWait(operation: () => Promise<AppDebugReply>, signal?: AbortSignal): Promise<AppDebugReply> {
  const interrupted = () => appDebugFailure('Debug connection interrupted. The application request may already have executed; inspect its state before retrying.')
  if (signal?.aborted) return interrupted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const stopped = new Promise<AppDebugReply>((resolve) => {
    timer = setTimeout(() => resolve(appDebugFailure('Debug acknowledgement timed out. The request outcome is unknown; inspect the application before restarting forwarding.')), APP_DEBUG_ACK_MS)
    abort = () => resolve(interrupted())
    signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    const reply = await Promise.race([Promise.resolve().then(() => signal?.aborted ? interrupted() : operation()), stopped])
    return isAppDebugReply(reply) ? reply : appDebugFailure('Incompatible debug response. Update the Host, Executor and desktop together before retrying.')
  } catch {
    return interrupted()
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}
export const appDebugOk: AppDebugReply = { ok: true }
export const appDebugFailure = (error: string): AppDebugReply => ({ ok: false, error })
export function isAppDebugReply(value: unknown): value is AppDebugReply {
  if (!value || typeof value !== 'object') return false
  const reply = value as Record<string, unknown>
  return reply.ok === true || (reply.ok === false && typeof reply.error === 'string' && reply.error.length <= 2048)
}
