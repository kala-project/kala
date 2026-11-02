import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert(/^[A-Za-z0-9_-]{43}$/u.test(config.routeHint))
const upstream = new URL(config.upstream)
assert(upstream.protocol === 'http:' && !upstream.username && !upstream.password && !upstream.search && !upstream.hash)
const publicOrigin = new URL(config.publicOrigin ?? config.upstream)
assert(['http:', 'https:'].includes(publicOrigin.protocol) && !publicOrigin.username && !publicOrigin.password
  && publicOrigin.pathname === '/' && !publicOrigin.search && !publicOrigin.hash)
const browserHosts = new Set((config.browserPublicOrigins ?? []).map(value => {
  const origin = new URL(value)
  assert(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password
    && origin.pathname === '/' && !origin.search && !origin.hash)
  return origin.host
}))
assert(['127.0.0.1', '0.0.0.0'].includes(config.listenHost))
assert(Number.isInteger(config.port) && config.port > 1024 && config.port < 65536)
const headers = request => ({
  ...request.headers,
  host: browserHosts.has(request.headers.host) ? request.headers.host : publicOrigin.host,
  'x-kala-executor-route': config.routeHint,
})
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ready: true, kind: 'legacy-executor-compatibility' }))
    return
  }
  const outgoing = http.request(upstream, { method: request.method, path: request.url, headers: headers(request) }, incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers)
    incoming.pipe(response)
  })
  outgoing.setTimeout(30000, () => outgoing.destroy(new Error('upstream_timeout')))
  outgoing.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'legacy_executor_upstream_unavailable' }))
  })
  request.on('aborted', () => outgoing.destroy())
  request.pipe(outgoing)
})
const connections = new Set()
server.on('connection', socket => {
  connections.add(socket)
  socket.on('close', () => connections.delete(socket))
})
server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/socket.io/')) { socket.destroy(); return }
  const outgoing = http.request(upstream, { method: 'GET', path: request.url, headers: headers(request) })
  outgoing.setTimeout(15000, () => outgoing.destroy(new Error('upgrade_timeout')))
  outgoing.on('upgrade', (response, remote, remoteHead) => {
    outgoing.setTimeout(0)
    const lines = []
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
    }
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${lines.join('\r\n')}\r\n\r\n`)
    if (remoteHead.length) socket.write(remoteHead)
    if (head.length) remote.write(head)
    remote.on('error', () => socket.destroy())
    socket.on('error', () => remote.destroy())
    socket.on('close', () => remote.destroy())
    remote.on('close', () => socket.destroy())
    socket.pipe(remote).pipe(socket)
  })
  outgoing.on('response', response => {
    response.resume()
    socket.end(`HTTP/1.1 ${response.statusCode} Upstream rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  outgoing.on('error', () => socket.destroy())
  socket.on('error', () => outgoing.destroy())
  outgoing.end()
})
server.listen(config.port, config.listenHost, () => console.log(JSON.stringify({ ready: true, port: config.port })))
const stop = () => {
  for (const socket of connections) socket.destroy()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
