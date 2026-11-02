#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { io } from 'socket.io-client'

const BUILD_INFO_PREFIX = 'globalThis.__KALA_BUILD_INFO__='
const DASHBOARD_MARKER = 'globalThis.__KALA_EMBEDDED_DASHBOARD__='

export function inspectPortableAsset(assetPath, { tag, revision }) {
  const asset = resolve(assetPath)
  const prefix = readPrefix(asset, 128 * 1024)
  assert.ok(prefix.startsWith('#!/usr/bin/env node\n'), 'Portable CJS must have a Node.js shebang')
  const metadataLine = prefix.split('\n', 3)[1] ?? ''
  assert.ok(metadataLine.startsWith(BUILD_INFO_PREFIX), 'Portable CJS is missing embedded build metadata')
  const build = JSON.parse(metadataLine.slice(BUILD_INFO_PREFIX.length).replace(/;$/u, ''))
  assert.equal(build.artifactKind, 'cjs', 'Portable asset must identify as CJS')
  assert.equal(build.dashboardMode, 'embedded', 'Portable CJS must embed the Dashboard')
  assert.ok(prefix.includes(DASHBOARD_MARKER), 'Portable CJS has no embedded Dashboard payload')
  assert.equal(build.releaseTag, tag, 'Portable CJS release tag does not match the image tag')
  assert.equal(build.productVersion, versionFromTag(tag), 'Portable CJS product version does not match the image version')
  assert.ok(revisionsMatch(build.gitCommit, revision), 'Portable CJS revision does not match the image revision')
  return { asset, build, sha256: createHash('sha256').update(readFileSync(asset)).digest('hex') }
}

export function revisionsMatch(embedded, expected) {
  if (typeof embedded !== 'string' || typeof expected !== 'string') return false
  const left = embedded.trim().toLowerCase()
  const right = expected.trim().toLowerCase()
  return left.length >= 7 && right.length >= 7 && (left.startsWith(right) || right.startsWith(left))
}

export function versionFromTag(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'tag must be a v-prefixed semantic version')
  return tag.slice(1)
}

function readPrefix(path, maximumBytes) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maximumBytes)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

async function main() {
  const tag = required('--tag')
  const revision = required('--revision')
  if (has('--inspect-artifact')) {
    const result = inspectPortableAsset(required('--asset'), { tag, revision })
    process.stdout.write(JSON.stringify({ ok: true, asset: basename(result.asset), sha256: result.sha256, build: result.build }) + '\n')
    return
  }

  if (!has('--isolated-vm') || process.env.KALA_PORTABLE_CONTAINER_ACCEPTANCE_VM !== '1') {
    throw new Error('container acceptance is restricted to an isolated VM/runner; pass --isolated-vm and set KALA_PORTABLE_CONTAINER_ACCEPTANCE_VM=1')
  }
  const image = required('--image')
  assert.match(image, /^ghcr\.io\/[a-z0-9][a-z0-9./_-]+@sha256:[0-9a-f]{64}$/u, 'Portable acceptance requires an immutable GHCR image digest')
  const output = option('--output')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const project = `kala-portable-acceptance-${suffix}`
  const network = `${project}-network`
  const volume = `${project}-state`
  const containers = [`${project}-first`, `${project}-second`]
  let socket

  const cleanup = () => {
    socket?.close()
    for (const container of containers) docker(['rm', '-f', container], { allowFailure: true })
    docker(['network', 'rm', network], { allowFailure: true })
    docker(['volume', 'rm', volume], { allowFailure: true })
  }
  const interrupt = () => { cleanup(); process.exit(130) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)

  try {
    const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0]
    assert.equal(imageInfo.Os, 'linux', 'only the verified Linux Portable image is accepted')
    assert.equal(imageInfo.Architecture, 'amd64', 'only the verified linux/amd64 Portable image is accepted')
    assert.equal(imageInfo.Config?.User, '65532:65532', 'Portable image must run as the unprivileged distroless user')
    assert.equal(imageInfo.Config?.Labels?.['io.kala.portable.runtime.source'], 'gcr.io/distroless/nodejs22-debian13@sha256:5e72a679e328276f6ffc3c4bb45c94f847f6abf0b424a1f8cc984f7f1c1daf47', 'Portable runtime source must match the security-scanned pinned image')
    assert.equal(imageInfo.Config?.Env?.some((entry) => entry === 'HOME=/var/lib/kala'), true, 'Portable home and settings must be persisted inside the volume')
    assert.equal(imageInfo.Config?.Labels?.['org.opencontainers.image.version'], versionFromTag(tag), 'image version label mismatch')
    assert.equal(imageInfo.Config?.Labels?.['org.opencontainers.image.revision'], revision, 'image revision label mismatch')
    assert.equal(imageInfo.Config?.Labels?.['io.kala.distribution'], 'portable', 'image distribution label mismatch')
    assert.match(imageInfo.Config?.Labels?.['io.kala.portable.asset.sha256'] ?? '', /^[a-f0-9]{64}$/u, 'image asset digest label is missing or invalid')
    assert.ok(imageInfo.Config?.Volumes?.['/var/lib/kala'], 'image must declare its persistent state volume')

    docker(['network', 'create', '--label', `io.kala.acceptance.project=${project}`, network])
    docker(['volume', 'create', '--label', `io.kala.acceptance.project=${project}`, volume])

    const first = startContainer(containers[0], image, network, volume, project)
    const firstOrigin = await waitForContainer(first)
    await assertPortableHttp(firstOrigin)
    const sessionId = `portable-container-${suffix}`
    socket = await connect(firstOrigin, sessionId)
    const created = await emitAck(socket, 'client:create_session', { operationId: `operation-${suffix}`, sessionId })
    assert.equal(created.ok, true, `Portable Session creation failed: ${String(created.error)}`)
    assert.ok((await listSessions(socket)).sessions.some((entry) => entry.sessionId === sessionId), 'created Session was not listed')
    socket.close()
    socket = undefined
    docker(['stop', '--time', '15', containers[0]])
    docker(['rm', containers[0]])

    const second = startContainer(containers[1], image, network, volume, project)
    const secondOrigin = await waitForContainer(second)
    socket = await connect(secondOrigin, sessionId)
    assert.ok((await listSessions(socket)).sessions.some((entry) => entry.sessionId === sessionId), 'Session did not survive container replacement')
    socket.close()
    socket = undefined
    docker(['stop', '--time', '15', containers[1]])
    docker(['rm', containers[1]])

    const evidence = {
      ok: true,
      category: 'portable-container',
      image,
      imageId: imageInfo.Id,
      architecture: imageInfo.Architecture,
      tag,
      version: versionFromTag(tag),
      revision,
      checks: { nonRoot: true, persistentVolume: true, loopbackPublish: true, capabilities: true, dashboard: true, sessionPersistence: true },
    }
    if (output) {
      const evidencePath = resolve(output)
      mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 })
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    }
    process.stdout.write(JSON.stringify(evidence) + '\n')
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    cleanup()
  }
}

function startContainer(name, image, network, volume, project) {
  docker([
    'run', '--detach', '--name', name,
    '--label', `io.kala.acceptance.project=${project}`,
    '--network', network,
    '--mount', `type=volume,source=${volume},target=/var/lib/kala`,
    // A fresh hosted VM has this loopback port free. Keep the external origin
    // equal to Portable Host's default allowlisted KALA_PUBLIC_URLS (port 3000);
    // Docker's random external port passed ordinary HTTP but the Socket.IO
    // origin gate correctly rejected the WebSocket handshake with HTTP 403.
    '--publish', '127.0.0.1:3000:3000',
    '--env', 'ANTHROPIC_API_KEY=synthetic-acceptance-key-not-used',
    image,
  ])
  return name
}

async function waitForContainer(container) {
  const deadline = Date.now() + 60_000
  let origin
  while (Date.now() < deadline) {
    const mapping = docker(['port', container, '3000/tcp'], { allowFailure: true }).trim().split('\n').find((line) => line.startsWith('127.0.0.1:'))
    if (mapping) origin = `http://${mapping}`
    if (origin) {
      try {
        const response = await fetch(origin + '/runtime/capabilities')
        if (response.ok) return origin
      } catch {}
    }
    const running = docker(['inspect', '--format', '{{.State.Running}}', container], { allowFailure: true }).trim()
    if (running === 'false') throw new Error(`Portable container exited before readiness:\n${docker(['logs', container], { allowFailure: true }).slice(-4000)}`)
    await delay(250)
  }
  throw new Error(`Portable container did not become ready:\n${docker(['logs', container], { allowFailure: true }).slice(-4000)}`)
}

async function assertPortableHttp(origin) {
  const capabilities = await fetch(origin + '/runtime/capabilities').then(assertOkJson)
  assert.equal(capabilities.product, 'portable', 'capabilities product is not portable')
  assert.equal(capabilities.deployment?.architecture, 'portable', 'deployment architecture is not portable')
  const dashboard = await fetch(origin + '/')
  assert.equal(dashboard.ok, true, 'embedded Dashboard request failed')
  assert.match(await dashboard.text(), /<html/u, 'embedded Dashboard HTML was not served')
}

async function connect(origin, sessionId) {
  const handshake = await fetch(`${origin}/socket.io/?EIO=4&transport=polling`)
  if (!handshake.ok) throw new Error(`Portable Socket.IO HTTP handshake returned ${handshake.status}`)
  const socket = io(origin + '/dashboard', { transports: ['websocket'], auth: { role: 'dashboard', sessionId, clientVersion: '1.1.0' }, reconnection: false })
  try {
    await Promise.race([
      new Promise((resolveReady, reject) => { socket.once('session:ready', resolveReady); socket.once('connect_error', reject) }),
      delay(10_000).then(() => { throw new Error('Portable Dashboard socket did not become ready') }),
    ])
    return socket
  } catch (error) {
    socket.close()
    const status = error?.context?.statusCode
    const code = error?.context?.code
    throw new Error(`Portable Dashboard WebSocket failed (handshake=${handshake.status}, status=${Number.isInteger(status) ? status : 'none'}, code=${typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : 'none'})`)
  }
}

function emitAck(socket, event, payload) { return socket.timeout(5_000).emitWithAck(event, payload) }
function listSessions(socket) { return new Promise((resolveList, reject) => { const timer = setTimeout(() => reject(new Error('Portable Session list timed out')), 5_000); socket.once('server:sessions', (value) => { clearTimeout(timer); resolveList(value) }); socket.emit('client:list_sessions', {}) }) }
async function assertOkJson(response) { assert.equal(response.ok, true, `HTTP ${response.status}`); return response.json() }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error && !allowFailure) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout ?? ''
}

function has(name) { return process.argv.includes(name) }
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function required(name) { const value = option(name); if (!value) throw new Error(`missing ${name}`); return value }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
}
