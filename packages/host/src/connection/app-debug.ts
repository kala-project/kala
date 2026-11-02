import { randomUUID } from 'node:crypto'
import {
  APP_DEBUG_LEASE_MS, APP_DEBUG_MAX_GRANTS, APP_DEBUG_MAX_STREAMS,
  AppDebugFrameSchema, AppDebugPortsSchema, appDebugFailure, appDebugOk, appDebugWait,
  type AppDebugClosed, type AppDebugExecutorRequest, type AppDebugFrame, type AppDebugReply,
} from '@agent-kernel/shared'
import type { ExecutorRegistry } from './executor.js'

export type AppDebugTarget = { executorId: string; connectionId: string; request(input: AppDebugExecutorRequest): Promise<AppDebugReply> }
type Stream = { inputSeq: number; outputSeq: number; inputEnded: boolean; outputEnded: boolean; incoming: boolean; outgoing: boolean; abort: AbortController }
type Grant = {
  id: string; owner: string; workspaceId: string; target: AppDebugTarget; ports: Set<number>; streams: Map<string, Stream>
  abort: AbortController; timer?: ReturnType<typeof setTimeout>; starting: boolean; renewing: boolean
  current?(): boolean
  authorize(): Promise<string | undefined>
  deliver(frame: AppDebugFrame): Promise<AppDebugReply>
  closed(event: AppDebugClosed): void
}
const inactive = () => appDebugFailure('Debug grant is not active for this connection. Open desktop settings and explicitly restart forwarding; old application bytes are not replayed.')

/** In-memory control/data plane. No payload logging, tools, Session events or DB access. */
export class AppDebugRelay {
  private readonly grants = new Map<string, Grant>()
  private readonly pendingStarts = new Map<string, object>()
  private available = (): boolean => true
  private closed = false
  /** Local-only state; never an async authorization/database check. */
  setAvailability(check: () => boolean): void { this.available = check }
  private accepting(): boolean {
    try { return !this.closed && this.available() } catch { return false }
  }
  constructor(private readonly targetFor: (workspaceId: string) => AppDebugTarget | undefined) {}
  activeGrants(): number { return this.grants.size }
  activeStreams(): number { return [...this.grants.values()].reduce((sum, grant) => sum + grant.streams.size, 0) }
  /** Track starts before their first async context check has created a Grant. */
  beginStart(owner: string): { current(): boolean; release(): void } {
    const token = this.accepting() ? {} : undefined
    if (token) this.pendingStarts.set(owner, token)
    return {
      current: () => !!token && this.accepting() && this.pendingStarts.get(owner) === token,
      release: () => { if (token && this.pendingStarts.get(owner) === token) this.pendingStarts.delete(owner) },
    }
  }
  private live(grant: Grant): boolean {
    if (this.grants.get(grant.id) !== grant) return false
    let currentAuthority = false
    try { currentAuthority = this.accepting() && (grant.current?.() ?? true) } catch { /* fail closed */ }
    if (!currentAuthority) {
      this.stop(grant, 'Runtime drained, Session subscription ended or its owner activation was lost. Forwarding stopped; inspect application state and explicitly restart after authorization recovers.')
      return false
    }
    const current = this.targetFor(grant.workspaceId)
    if (current?.connectionId === grant.target.connectionId && current.executorId === grant.target.executorId) return true
    this.stop(grant, 'Executor disconnected or was replaced. Restart forwarding explicitly after checking the application state.')
    return false
  }
  revoke(reason: string): void { this.pendingStarts.clear(); for (const grant of this.grants.values()) this.stop(grant, reason) }
  close(): void { this.closed = true; this.revoke('Runtime closed. Debug forwarding stopped before shutdown waits; application requests may already have executed and will not be replayed.') }
  private forward(grant: Grant, operation: () => Promise<AppDebugReply>, signal = grant.abort.signal): Promise<AppDebugReply> {
    // appDebugWait queues dispatch: recheck inside that microtask too, not only before it.
    return appDebugWait(() => this.live(grant) ? operation() : Promise.resolve(inactive()), signal)
  }
  private async authority(grant: Grant): Promise<string | undefined> {
    const reply = await appDebugWait(async () => {
      const error = await grant.authorize()
      return error ? appDebugFailure(error) : appDebugOk
    }, grant.abort.signal)
    return reply.ok ? undefined : reply.error
  }
  private lease(grant: Grant): void {
    clearTimeout(grant.timer)
    grant.timer = setTimeout(() => this.stop(grant, 'Forwarding authorization expired. Check your connection and restart the group in desktop settings.'), APP_DEBUG_LEASE_MS)
    grant.timer.unref()
  }
  private stop(grant: Grant, error: string): void {
    if (!this.grants.delete(grant.id)) return
    clearTimeout(grant.timer)
    grant.abort.abort()
    for (const stream of grant.streams.values()) stream.abort.abort()
    grant.streams.clear()
    void appDebugWait(() => grant.target.request({ op: 'stop', grantId: grant.id }))
    grant.closed({ grantId: grant.id, error })
  }
  private closeStream(grant: Grant, streamId: string): void {
    const stream = grant.streams.get(streamId)
    if (!stream) return
    grant.streams.delete(streamId)
    stream.abort.abort()
    const frame: AppDebugFrame = { op: 'close', grantId: grant.id, streamId }
    void appDebugWait(() => grant.target.request(frame), grant.abort.signal)
    void appDebugWait(() => grant.deliver(frame), grant.abort.signal)
  }
  private finish(grant: Grant, streamId: string, stream: Stream): void {
    if (stream.inputEnded && stream.outputEnded) { grant.streams.delete(streamId); stream.abort.abort() }
  }
  private owned(owner: string, grantId: string): Grant | undefined {
    const grant = this.grants.get(grantId)
    if (!grant || grant.owner !== owner) return undefined
    if (!this.live(grant)) return undefined
    return grant
  }
  targetsChanged(): void {
    for (const grant of this.grants.values()) this.live(grant)
  }
  closeExecutor(connectionId: string): void {
    for (const grant of this.grants.values()) if (grant.target.connectionId === connectionId) this.stop(grant, 'Executor disconnected. Application requests may already have executed; check them before retrying.')
  }
  closeOwner(owner: string, reason = 'Dashboard connection closed. Restart forwarding explicitly after reconnecting; no bytes were replayed.'): void {
    this.pendingStarts.delete(owner)
    for (const grant of this.grants.values()) if (grant.owner === owner) this.stop(grant, reason)
  }
  stopOwnerGrant(owner: string, grantId: string): AppDebugReply {
    const grant = this.owned(owner, grantId)
    if (!grant) return inactive()
    this.stop(grant, 'Forwarding stopped. Saved settings are retained; use Start to enable it again.')
    return appDebugOk
  }
  async start(input: {
    owner: string; workspaceId: string; executorId: string; ports: number[]
    current?(): boolean
    authorize(): Promise<string | undefined>
    deliver(frame: AppDebugFrame): Promise<AppDebugReply>
    closed(event: AppDebugClosed): void
  }): Promise<AppDebugReply> {
    if (!this.accepting()) return appDebugFailure('Runtime is draining, unavailable or closed. Wait for readiness and explicitly start a new debug group; old requests are not replayed.')
    if (!AppDebugPortsSchema.safeParse(input.ports).success) return appDebugFailure('Enter 1–8 unique ports between 1024 and 65535. No debug group was started.')
    const target = this.targetFor(input.workspaceId)
    if (!target || target.executorId !== input.executorId) return appDebugFailure('Selected Executor is offline, changed, or does not support application debugging v1. Check the selection and update it before restarting.')
    if (this.grants.size >= APP_DEBUG_MAX_GRANTS || [...this.grants.values()].some((grant) => grant.owner === input.owner)) return appDebugFailure('A debug group is already active for this Dashboard connection, or the Host limit (8) was reached. Stop an existing group first.')
    const grant: Grant = { ...input, id: randomUUID(), target, ports: new Set(input.ports), streams: new Map(), abort: new AbortController(), starting: true, renewing: false }
    this.grants.set(grant.id, grant)
    this.lease(grant)
    const error = await this.authority(grant)
    if (error || !this.live(grant)) {
      this.stop(grant, error ?? 'Executor changed while authorization was being checked. No application request was replayed.')
      return error ? appDebugFailure(error) : inactive()
    }
    const reply = await this.forward(grant, () => target.request({ op: 'start', grantId: grant.id, ports: input.ports }))
    if (!reply.ok || !this.live(grant)) { this.stop(grant, reply.ok ? 'Executor changed during start.' : reply.error); return reply.ok ? inactive() : reply }
    grant.starting = false
    this.lease(grant)
    return { ok: true, grantId: grant.id }
  }
  async renew(owner: string, grantId: string): Promise<AppDebugReply> {
    const grant = this.owned(owner, grantId)
    if (!grant || grant.starting || grant.renewing) return inactive()
    grant.renewing = true
    const error = await this.authority(grant)
    if (error || !this.live(grant)) { this.stop(grant, error ?? 'Executor changed during authorization.'); return error ? appDebugFailure(error) : inactive() }
    const reply = await this.forward(grant, () => grant.target.request({ op: 'renew', grantId }))
    grant.renewing = false
    if (!reply.ok || !this.live(grant)) { this.stop(grant, reply.ok ? 'Executor changed during renewal.' : reply.error); return reply.ok ? inactive() : reply }
    this.lease(grant)
    return appDebugOk
  }
  async frame(owner: string, input: unknown): Promise<AppDebugReply> {
    const parsed = AppDebugFrameSchema.safeParse(input)
    if (!parsed.success) return appDebugFailure('Invalid debug frame. Check client versions and the 16 KiB data limit; this frame was not forwarded.')
    const frame = parsed.data
    const grant = this.owned(owner, frame.grantId)
    if (!grant || grant.starting) return inactive()
    if (frame.op === 'close') { this.closeStream(grant, frame.streamId); return appDebugOk }
    let stream = grant.streams.get(frame.streamId)
    if (frame.op === 'open') {
      if (!grant.ports.has(frame.port) || stream || grant.streams.size >= APP_DEBUG_MAX_STREAMS) return appDebugFailure('Unapproved port, duplicate stream or stream limit (32). No TCP connection was opened for this request.')
      stream = { inputSeq: 0, outputSeq: 0, inputEnded: false, outputEnded: false, incoming: true, outgoing: false, abort: new AbortController() }
      grant.streams.set(frame.streamId, stream)
      const error = await this.authority(grant)
      if (error || !this.live(grant)) { this.stop(grant, error ?? 'Executor changed before stream open.'); return error ? appDebugFailure(error) : inactive() }
    } else {
      if (!stream || stream.incoming || stream.inputEnded || stream.inputSeq !== frame.seq) {
        this.closeStream(grant, frame.streamId)
        return appDebugFailure('Debug stream is closed or data is out of order. The stream was closed without replay; inspect application state before retrying.')
      }
      stream.incoming = true
    }
    const reply = await this.forward(grant, () => grant.target.request(frame), stream.abort.signal)
    stream.incoming = false
    if (!reply.ok || !this.live(grant)) { this.closeStream(grant, frame.streamId); return reply.ok ? inactive() : reply }
    if (frame.op !== 'open') stream.inputSeq += 1
    if (frame.op === 'end') stream.inputEnded = true
    this.finish(grant, frame.streamId, stream)
    return reply
  }
  async executorFrame(connectionId: string, input: unknown): Promise<AppDebugReply> {
    const parsed = AppDebugFrameSchema.safeParse(input)
    if (!parsed.success || parsed.data.op === 'open') return appDebugFailure('Invalid Executor debug frame. No desktop data was written.')
    const frame = parsed.data
    const grant = this.grants.get(frame.grantId)
    if (!grant || grant.target.connectionId !== connectionId || !this.live(grant)) return inactive()
    if (frame.op === 'close') { this.closeStream(grant, frame.streamId); return appDebugOk }
    const stream = grant.streams.get(frame.streamId)
    if (!stream || stream.outgoing || stream.outputEnded || stream.outputSeq !== frame.seq) {
      this.closeStream(grant, frame.streamId)
      return appDebugFailure('Invalid or out-of-order Executor stream. It was closed rather than replaying bytes.')
    }
    stream.outgoing = true
    const reply = await this.forward(grant, () => grant.deliver(frame), stream.abort.signal)
    stream.outgoing = false
    if (!reply.ok || !this.live(grant)) { this.closeStream(grant, frame.streamId); return reply.ok ? inactive() : reply }
    stream.outputSeq += 1
    if (frame.op === 'end') stream.outputEnded = true
    this.finish(grant, frame.streamId, stream)
    return reply
  }
}
const relays = new WeakMap<ExecutorRegistry, AppDebugRelay>()
export function appDebugRelayFor(executors: ExecutorRegistry): AppDebugRelay {
  let relay = relays.get(executors)
  if (!relay) {
    relay = new AppDebugRelay((workspaceId) => executors.appDebugTarget?.(workspaceId))
    relays.set(executors, relay)
    const current = relay
    executors.onChange?.(() => current.targetsChanged())
  }
  return relay
}
