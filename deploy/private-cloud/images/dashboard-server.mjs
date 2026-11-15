import { createReadStream } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const root = resolve(process.env.DASHBOARD_ROOT ?? '/app/dashboard')
const port = Number(process.env.DASHBOARD_PORT ?? 8080)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DASHBOARD_PORT must be a valid port')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8' }
const within = (candidate) => candidate === root || candidate.startsWith(`${root}${sep}`)

createServer(async (request, response) => {
  try {
    if (request.url === '/healthz') { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"ok":true}'); return }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return }
    let pathname; try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://dashboard.invalid').pathname) } catch { response.writeHead(400); response.end(); return }
    if (/^\/silo(?:\/|$)/u.test(pathname) || pathname === '/auth/silo/open') {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end('{"error":"native_console_route_unavailable"}')
      return
    }
    const relative = pathname.replace(/^\/+|\/+$/gu, '') || 'index.html'
    const normalized = normalize(relative)
    if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes('\0')) { response.writeHead(400); response.end(); return }
    let file = resolve(root, normalized)
    if (!within(file)) { response.writeHead(400); response.end(); return }
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html') } catch { if (extname(file)) { response.writeHead(404); response.end(); return } file = join(root, 'index.html') }
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || !within(file)) { response.writeHead(404); response.end(); return }
    const immutable = file !== join(root, 'index.html') && /(?:^|[._-])[a-f0-9]{8,}(?:[._-]|$)/iu.test(file.slice(root.length + 1))
    response.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(info.size), 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate', 'x-content-type-options': 'nosniff' })
    if (request.method === 'HEAD') response.end()
    else createReadStream(file).on('error', () => response.destroy()).pipe(response)
  } catch { if (!response.headersSent) response.writeHead(404); response.end() }
}).listen(port, '0.0.0.0', () => process.stdout.write(`${JSON.stringify({ event: 'dashboard_ready', port })}\n`))
