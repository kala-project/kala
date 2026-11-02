import { Socket } from 'node:net'
import {
  APP_DEBUG_CHUNK_BYTES, APP_DEBUG_IDLE_MS, APP_DEBUG_LEASE_MS, APP_DEBUG_MAX_GRANTS, APP_DEBUG_MAX_STREAMS,
  AppDebugExecutorRequestSchema, appDebugFailure, appDebugOk, appDebugWait,
  type AppDebugFrame, type AppDebugReply, type NetworkPolicy,
} from '@agent-kernel/shared'

type Stream = {
  socket: Socket; abort: AbortController; inputSeq: number; outputSeq: number
  inputEnded: boolean; outputEnded: boolean; incoming: boolean; pumping: boolean; eof: boolean; closed: boolean
}
type Grant = { ports: Set<number>; streams: Map<string, Stream>; timer?: ReturnType<typeof setTimeout>; abort: AbortController }

/** Authenticated Host only; no DNS/arbitrary address support and no byte logging. */
export function createAppDebugEndpoint(options: {
  send(frame: AppDebugFrame): Promise<AppDebugReply>
  networkPolicy?: NetworkPolicy
}) {
  const grants = new Map<string, Grant>()
  const count = () => [...grants.values()].reduce((total, grant) => total + grant.streams.size, 0)

  function closeStream(grantId: string, streamId: string, notify = false): void {
    const grant = grants.get(grantId)
    const stream = grant?.streams.get(streamId)
    if (!grant || !stream) return
    grant.streams.delete(streamId)
    stream.closed = true
    stream.abort.abort()
    stream.socket.destroy()
    if (notify && !grant.abort.signal.aborted) {
      void appDebugWait(() => options.send({ op: 'close', grantId, streamId }), grant.abort.signal)
    }
  }
  function stop(grantId: string): void {
    const grant = grants.get(grantId)
    if (!grant) return
    clearTimeout(grant.timer)
    grant.abort.abort()
    for (const streamId of grant.streams.keys()) closeStream(grantId, streamId)
    grants.delete(grantId)
  }
  function renew(grantId: string, grant: Grant): void {
    clearTimeout(grant.timer)
    grant.timer = setTimeout(() => stop(grantId), APP_DEBUG_LEASE_MS)
    grant.timer.unref()
  }
  function finish(grantId: string, streamId: string, stream: Stream): void {
    if (stream.inputEnded && stream.outputEnded) closeStream(grantId, streamId)
  }
  async function open(grantId: string, streamId: string, port: number): Promise<AppDebugReply> {
    const grant = grants.get(grantId)!
    if (!grant.ports.has(port)) return appDebugFailure('This port is not approved. Stop forwarding and add it explicitly in desktop settings.')
    if (grant.streams.has(streamId)) return appDebugFailure('Duplicate debug stream. Stop and restart the group; existing bytes were not replayed.')
    if (grant.streams.size >= APP_DEBUG_MAX_STREAMS || count() >= APP_DEBUG_MAX_STREAMS) return appDebugFailure('Executor debug stream limit reached (32). Close unused application connections before retrying.')
    const socket = new Socket({ allowHalfOpen: true })
    const stream: Stream = { socket, abort: new AbortController(), inputSeq: 0, outputSeq: 0, inputEnded: false, outputEnded: false, incoming: false, pumping: false, eof: false, closed: false }
    grant.streams.set(streamId, stream)
    socket.setTimeout(APP_DEBUG_IDLE_MS, () => closeStream(grantId, streamId, true))
    socket.on('error', () => closeStream(grantId, streamId, true))
    socket.on('close', (hadError) => {
      // TCP may auto-close after both FINs while the final data/EOF is still
      // awaiting a relay ACK. Keep protocol state until that ACK drains; an
      // eager close here truncates responses on a real asynchronous transport.
      if (!hadError && stream.eof && socket.writableEnded) return
      closeStream(grantId, streamId, true)
    })
    const pump = async (): Promise<void> => {
      if (stream.closed || stream.pumping) return
      stream.pumping = true
      try {
        while (!stream.closed) {
          const bytes = socket.read(Math.min(APP_DEBUG_CHUNK_BYTES, socket.readableLength || APP_DEBUG_CHUNK_BYTES)) as Buffer | null
          if (bytes) {
            const reply = await appDebugWait(() => options.send({ op: 'data', grantId, streamId, seq: stream.outputSeq, data: bytes.toString('base64') }), stream.abort.signal)
            if (!reply.ok) { closeStream(grantId, streamId, true); return }
            stream.outputSeq += 1
          } else if (stream.eof && !stream.outputEnded) {
            const reply = await appDebugWait(() => options.send({ op: 'end', grantId, streamId, seq: stream.outputSeq }), stream.abort.signal)
            if (!reply.ok) { closeStream(grantId, streamId, true); return }
            stream.outputSeq += 1
            stream.outputEnded = true
            finish(grantId, streamId, stream)
            return
          } else return
        }
      } finally { stream.pumping = false }
    }
    socket.on('readable', () => { void pump() })
    socket.on('end', () => { stream.eof = true; void pump() })
    return await appDebugWait(() => new Promise<AppDebugReply>((resolve) => {
      socket.once('connect', () => resolve(appDebugOk))
      socket.prependOnceListener('error', (error: NodeJS.ErrnoException) => resolve(appDebugFailure(`Cannot connect to Executor loopback port ${port} (${error.code ?? 'connection error'}). Start that service, verify its IPv4 loopback binding, then restart forwarding.`)))
      socket.once('close', () => resolve(appDebugFailure(`Executor loopback port ${port} closed before the connection was ready. Check the service and restart forwarding.`)))
      socket.connect({ host: '127.0.0.1', port })
    }), stream.abort.signal).then((reply) => {
      if (!reply.ok) closeStream(grantId, streamId)
      return reply
    })
  }

  return {
    activeStreams: count,
    activeGrants: () => grants.size,
    close() { for (const grantId of grants.keys()) stop(grantId) },
    async request(input: unknown): Promise<AppDebugReply> {
      const parsed = AppDebugExecutorRequestSchema.safeParse(input)
      if (!parsed.success) return appDebugFailure('Invalid debug request. Use unique ports 1024–65535 and ordered frames of at most 16 KiB; no connection was created for this request.')
      const request = parsed.data
      if (request.op === 'start') {
        const policy = options.networkPolicy
        if (policy && (policy.defaultAction !== 'allow' || policy.rules.length > 0)) return appDebugFailure('Application debugging is unavailable under this HTTP-only network policy: opaque TCP cannot be authorized by HTTP rules. No TCP connection was opened. Ask the administrator for a TCP-capable policy implementation; do not disable policy implicitly.')
        if (grants.has(request.grantId) || grants.size >= APP_DEBUG_MAX_GRANTS) return appDebugFailure('Duplicate debug grant or Executor grant limit reached (8). Stop unused debug groups before starting another.')
        const grant: Grant = { ports: new Set(request.ports), streams: new Map(), abort: new AbortController() }
        grants.set(request.grantId, grant)
        renew(request.grantId, grant)
        return appDebugOk
      }
      const grant = grants.get(request.grantId)
      if (!grant) return appDebugFailure('Debug grant is no longer active. Reopen desktop settings and explicitly restart forwarding; old bytes will not be replayed.')
      if (request.op === 'stop') { stop(request.grantId); return appDebugOk }
      if (request.op === 'renew') { renew(request.grantId, grant); return appDebugOk }
      if (request.op === 'open') return open(request.grantId, request.streamId, request.port)
      const stream = grant.streams.get(request.streamId)
      if (!stream) return request.op === 'close' ? appDebugOk : appDebugFailure('Debug stream is closed or was never opened. Reload the application after checking forwarding status.')
      if (request.op === 'close') { closeStream(request.grantId, request.streamId); return appDebugOk }
      if (stream.inputEnded || stream.incoming || request.seq !== stream.inputSeq) {
        closeStream(request.grantId, request.streamId, true)
        return appDebugFailure('Out-of-order, concurrent or post-EOF debug data was rejected and the stream was closed. Inspect the application before reconnecting; no bytes were replayed.')
      }
      stream.incoming = true
      const result = await appDebugWait(() => new Promise<AppDebugReply>((resolve) => {
        if (request.op === 'data') stream.socket.write(Buffer.from(request.data, 'base64'), (error) => resolve(error ? appDebugFailure('Executor TCP write failed. The application request may be partially received; inspect its state before retrying.') : appDebugOk))
        else stream.socket.end(() => resolve(appDebugOk))
      }), stream.abort.signal)
      stream.incoming = false
      if (!result.ok || stream.closed) {
        closeStream(request.grantId, request.streamId, true)
        return result.ok ? appDebugFailure('Debug stream closed while writing; inspect application state before retrying.') : result
      }
      stream.inputSeq += 1
      if (request.op === 'end') stream.inputEnded = true
      finish(request.grantId, request.streamId, stream)
      return result
    },
  }
}
