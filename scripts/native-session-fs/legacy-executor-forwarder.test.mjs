import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const routeHint = 'a'.repeat(43)
const publicHost = 'kala.example:18081'
const browserHost = 'dashboard.example.test'

async function fixture(t) {
  const upstream = http.createServer((request, response) => {
    response.writeHead([publicHost, browserHost].includes(request.headers.host) ? 200 : 400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ url: request.url, headers: request.headers }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const directory = await mkdtemp(join(tmpdir(), 'kala-legacy-forwarder-test-'))
  const config = join(directory, 'route.json')
  await writeFile(config, JSON.stringify({
    routeHint, listenHost: '127.0.0.1', port,
    upstream: `http://127.0.0.1:${upstream.address().port}`, publicOrigin: `http://${publicHost}`,
    browserPublicOrigins: [`https://${browserHost}`],
  }), { mode: 0o600 })
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./legacy-executor-forwarder.mjs', import.meta.url)), config,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', data => { errors += data })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit')
      child.kill('SIGTERM')
      await stopped
    }
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    await rm(directory, { recursive: true })
  })
  await Promise.race([
    once(child.stdout, 'data').then(([data]) => assert.equal(JSON.parse(data.toString()).ready, true)),
    once(child, 'exit').then(([code]) => { throw new Error(`Forwarder exited ${code}: ${errors}`) }),
  ])
  return { upstream, port }
}

test('HTTP forwarding uses the public Host and trusted route without replacing original credentials', { timeout: 15000 }, async t => {
  const { port } = await fixture(t)
  const response = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
    headers: { authorization: 'Bearer original-executor-test-token', 'x-kala-executor-route': 'untrusted-route' },
  })
  assert.equal(response.status, 200)
  const received = await response.json()
  assert.equal(received.url, '/socket.io/?EIO=4&transport=polling')
  assert.equal(received.headers.host, publicHost)
  assert.equal(received.headers['x-kala-executor-route'], routeHint)
  assert.equal(received.headers.authorization, 'Bearer original-executor-test-token')
})

test('WebSocket forwarding preserves the canonical Host, credentials, upgrade headers and initial bytes', { timeout: 15000 }, async t => {
  const { upstream, port } = await fixture(t)
  let received
  upstream.on('upgrade', (request, socket) => {
    received = request.headers
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'X-Compatibility-Test: preserved\r\n\r\nlegacy-upgrade-head')
  })
  const upgraded = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: '/socket.io/?EIO=4&transport=websocket',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', authorization: 'Bearer original-executor-test-token',
        'x-kala-executor-route': 'untrusted-route' },
    })
    request.on('error', reject)
    request.on('response', response => { response.resume(); reject(new Error(`Upgrade rejected: ${response.statusCode}`)) })
    request.on('upgrade', (response, socket, head) => {
      const chunks = [head]
      socket.on('data', data => chunks.push(data))
      socket.on('error', reject)
      socket.on('close', () => resolve({ header: response.headers['x-compatibility-test'],
        body: Buffer.concat(chunks).toString() }))
    })
    request.end()
  })
  assert.equal(received.host, publicHost)
  assert.equal(received['x-kala-executor-route'], routeHint)
  assert.equal(received.authorization, 'Bearer original-executor-test-token')
  assert.deepEqual(upgraded, { header: 'preserved', body: 'legacy-upgrade-head' })
})

test('only explicitly registered browser authorities survive the compatibility listener', { timeout: 15000 }, async t => {
  const { port } = await fixture(t)
  for (const [host, expected] of [[browserHost, browserHost], ['untrusted.example.test', publicHost]]) {
    const body = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/auth/login', headers: { host,
        'x-forwarded-host': 'untrusted.example.test', origin: `https://${browserHost}` } }, response => {
        let text = ''
        response.on('data', data => { text += data })
        response.on('end', () => resolve(JSON.parse(text)))
      })
      request.on('error', reject)
    })
    assert.equal(body.headers.host, expected)
    assert.equal(body.headers.origin, `https://${browserHost}`)
  }
})
