import type { ClientRequest, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import httpProxy from 'http-proxy'

export type RuntimeProxyTarget = {
  readonly unitId: string
  readonly origin: string
}

export type ResolveRuntimeProxyTarget = (
  request: IncomingMessage,
) => RuntimeProxyTarget | undefined | Promise<RuntimeProxyTarget | undefined>

export type RuntimeUnitIngress = {
  attach(server: HttpServer): void
  close(): void
}

export function resetRuntimeUpgradeTransport(socket: Duplex): void {
  if (socket.destroyed) return
  // A raw TCP reset discards queued Socket.IO output. TLS sockets inherit from
  // Socket, but Node rejects resetAndDestroy() on their wrapped native handle.
  if (socket instanceof Socket) {
    try { socket.resetAndDestroy(); return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_HANDLE_TYPE') throw error
    }
  }
  socket.destroy()
}

/**
 * Routes public HTTP and WebSocket-upgrade traffic to a TenantRuntimeUnit's
 * private HTTP listener. Authentication and user-to-unit mapping stay outside
 * this router; the resolver receives an already trusted ingress request.
 */
export function createRuntimeUnitIngress(options: {
  resolve: ResolveRuntimeProxyTarget
  resolveUpgrade?: ResolveRuntimeProxyTarget
  isRoutableRequest?: (request: IncomingMessage) => boolean
}): RuntimeUnitIngress {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, changeOrigin: false })
  const isRoutable = options.isRoutableRequest ?? (() => true)
  let attached: HttpServer | undefined
  const upgradedClients = new Set<Duplex>()
  const upgradeRequests = new Set<ClientRequest>()
  const upgradedUpstreams = new Set<Duplex>()
  const upgradePeers = new Map<Duplex, Duplex>()
  const resetTransport = resetRuntimeUpgradeTransport
  const trackUpgrade = (set: Set<Duplex>, socket: Duplex): void => {
    set.add(socket)
    socket.once('close', () => set.delete(socket))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
        console.warn('[runtime ingress] upgrade transport failed', { code: error.code ?? 'unknown' })
      }
      resetTransport(socket)
    })
  }
  const closeUpgradePair = (socket: Duplex): void => {
    const peer = upgradePeers.get(socket)
    if (!peer) return
    upgradePeers.delete(socket)
    upgradePeers.delete(peer)
    resetTransport(socket)
    resetTransport(peer)
  }
  const pairUpgrades = (client: Duplex, upstream: Duplex): void => {
    upgradePeers.set(client, upstream)
    upgradePeers.set(upstream, client)
    // http-proxy pipes both directions, but a TCP half-close does not
    // necessarily close the opposite writable side. Socket.IO then keeps
    // broadcasting into an orphaned upstream socket until its send buffer is
    // full, delaying ping and Tool ACK traffic for healthy connections. A
    // WebSocket transport is one lifecycle: either half ending closes both.
    client.once('end', () => closeUpgradePair(client))
    client.once('finish', () => closeUpgradePair(client))
    client.once('error', () => closeUpgradePair(client))
    client.once('close', () => closeUpgradePair(client))
    upstream.once('end', () => closeUpgradePair(upstream))
    upstream.once('finish', () => closeUpgradePair(upstream))
    upstream.once('error', () => closeUpgradePair(upstream))
    upstream.once('close', () => closeUpgradePair(upstream))
  }
  proxy.on('proxyReqWs', (request: ClientRequest, _incoming, client: Duplex) => {
    upgradeRequests.add(request)
    request.once('close', () => upgradeRequests.delete(request))
    const abandonPendingUpgrade = (): void => {
      if (!request.destroyed) request.destroy()
      else if (request.socket) resetTransport(request.socket)
    }
    client.once('close', abandonPendingUpgrade)
    request.once('upgrade', (_response, upstream) => {
      upgradeRequests.delete(request)
      trackUpgrade(upgradedUpstreams, upstream)
      pairUpgrades(client, upstream)
    })
  })

  const rejectHttp = (response: ServerResponse, status: number, message: string): void => {
    if (response.headersSent) return
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: message }))
  }
  const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
    if (socket.destroyed || !socket.writable || socket.writableEnded) return
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (!isRoutable(request) || response.writableEnded) return
    void Promise.resolve(options.resolve(request)).then((target) => {
      if (!target) {
        rejectHttp(response, 404, 'TENANT_RUNTIME_UNIT_NOT_FOUND')
        return
      }
      proxy.web(request, response, { target: target.origin }, (error) => {
        rejectHttp(response, 502, error instanceof Error ? error.message : 'TENANT_RUNTIME_UNIT_UNAVAILABLE')
      })
    }).catch(() => rejectHttp(response, 503, 'TENANT_RUNTIME_UNIT_UNAVAILABLE'))
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (socket.destroyed || !socket.writable || socket.writableEnded || !isRoutable(request)) return
    trackUpgrade(upgradedClients, socket)
    void Promise.resolve((options.resolveUpgrade ?? options.resolve)(request)).then((target) => {
      if (!target) {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }
      proxy.ws(request, socket, head, { target: target.origin }, (error) => {
        rejectUpgrade(socket, 502, error instanceof Error ? error.message : 'Bad Gateway')
      })
    }).catch(() => rejectUpgrade(socket, 503, 'Service Unavailable'))
  }

  return {
    attach(server) {
      if (attached === server) return
      if (attached) throw new Error('RuntimeUnitIngress is already attached')
      attached = server
      // Prepend so the router claims Unit paths before static/API fallbacks.
      server.prependListener('request', onRequest)
      server.prependListener('upgrade', onUpgrade)
    },
    close() {
      if (attached) {
        attached.removeListener('request', onRequest)
        attached.removeListener('upgrade', onUpgrade)
        attached = undefined
      }
      for (const socket of upgradedClients) resetTransport(socket)
      for (const request of upgradeRequests) { if (request.socket) resetTransport(request.socket); request.destroy() }
      for (const socket of upgradedUpstreams) resetTransport(socket)
      upgradePeers.clear()
      proxy.close()
    },
  }
}
