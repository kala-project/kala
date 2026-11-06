import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { Server } from 'socket.io'
import { afterEach, expect, it } from 'vitest'
import { createExecutorRegistry } from './executor.js'
import { executionRequestDigest } from '../../../executor/src/execution-receipts.js'

const executorRoot = resolve(import.meta.dirname, '../../../executor')
const fixture = resolve(import.meta.dirname, '__fixtures__/arena-tls-executor.mjs')
const keeperCli = join(executorRoot, 'bin/kala-executor.ts')
const children: ChildProcess[] = []
let shutdown: (() => Promise<void>) | undefined
let testRoot: string | undefined

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 30))
  }
  throw new Error('Timed out waiting for isolated TLS Arena fixture')
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGKILL')
  await once(child, 'exit')
}

afterEach(async () => {
  for (const child of children.reverse()) await stop(child)
  children.length = 0
  await shutdown?.()
  shutdown = undefined
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
}, 20_000)

it.skipIf(process.platform !== 'linux')('uses a locally trusted CA, a real remote Executor and an independent keeper for named Git admission', async () => {
  testRoot = join(process.cwd(), `.arena-tls-fixture-${randomUUID()}`)
  await mkdir(testRoot, { mode: 0o700 })
  const workspace = join(testRoot, 'workspace')
  const keeperDir = join(testRoot, 'keeper')
  const journal = join(testRoot, 'receipts.jsonl')
  const identity = join(keeperDir, 'identity.json')
  await mkdir(workspace)
  await mkdir(keeperDir, { mode: 0o700 })
  await chmod(keeperDir, 0o700)
  execFileSync('git', ['init', '-q', workspace], { stdio: 'ignore' })
  await writeFile(join(workspace, 'README'), 'isolated TLS Git workspace\n')

  const caKey = join(testRoot, 'ca.key')
  const caCert = join(testRoot, 'ca.crt')
  const wrongCaCert = join(testRoot, 'wrong-ca.crt')
  const serverKey = join(testRoot, 'server.key')
  const csr = join(testRoot, 'server.csr')
  const serverCert = join(testRoot, 'server.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Isolated Arena Test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', caKey, '-out', caCert], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', serverKey, '-out', csr], { stdio: 'ignore' })
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-days', '1', '-sha256', '-copy_extensions', 'copy',
    '-out', serverCert], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Untrusted Test CA', '-keyout', join(testRoot, 'wrong-ca.key'),
    '-out', wrongCaCert], { stdio: 'ignore' })

  const https = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCert) })
  const io = new Server(https)
  const registry = createExecutorRegistry(io, {
    workspaceIdFor: () => 'arena-tls-fixture-workspace',
    approvedArenaReadParent: (_session, parentCallId) => parentCallId === 'approved-worktree-arena-parent',
    assertSessionEffectOwner: async () => ({ ownerGeneration: '1' }),
  }, 4_000, undefined, 0)
  io.of('/executor').on('connection', (socket) => {
    socket.on('executor:announce', (announcement) => registry.attach(socket, announcement))
    socket.on('disconnect', () => registry.detach(socket))
  })
  await new Promise<void>((done) => https.listen(0, '127.0.0.1', done))
  shutdown = async () => {
    await new Promise<void>((done) => io.close(() => done()))
    if (https.listening) await new Promise<void>((done) => https.close(() => done()))
  }
  const address = https.address()
  if (!address || typeof address === 'string') throw new Error('No isolated TLS listener')

  const startKeeper = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', keeperCli, 'arena-keeper', identity],
      { cwd: executorRoot, stdio: 'ignore' })
    children.push(child)
    await waitFor(async () => {
      try { return (JSON.parse(await readFile(identity, 'utf8')) as { pgid: number }).pgid === child.pid }
      catch { return false }
    })
    return child
  }
  let keeper = await startKeeper()
  const remoteArgs = ['--import', 'tsx', fixture,
    `https://127.0.0.1:${address.port}`, workspace, identity, journal]
  const untrusted = spawn(process.execPath, remoteArgs, {
    cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: wrongCaCert },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(untrusted)
  let tlsFailure = ''
  untrusted.stdout?.on('data', (chunk: Buffer) => { tlsFailure += chunk.toString() })
  untrusted.stderr?.on('data', (chunk: Buffer) => { tlsFailure += chunk.toString() })
  await waitFor(() => /certificate|self.signed|UNABLE_TO_VERIFY/i.test(tlsFailure), 3_000)
    .catch(() => { throw new Error(`Untrusted CA diagnostic: ${tlsFailure.slice(-1200)}`) })
  expect(registry.snapshot()).toHaveLength(0)
  await stop(untrusted)
  const child = spawn(process.execPath, remoteArgs, {
    cwd: process.cwd(),
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let diagnostics = ''
  child.stdout?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  await waitFor(() => registry.snapshot().some((entry) => entry.executorId === 'arena-tls-fixture-executor'),
    12_000).catch(() => { throw new Error(`TLS Executor did not announce: ${diagnostics.slice(-1000)}`) })
  expect(registry.snapshot()[0]?.arenaKeeperVersion).toBe(1)
  expect(registry.snapshot()[0]?.sandboxRoots).toContain(await realpath(workspace))
  const keeperIdentity = JSON.parse(await readFile(identity, 'utf8')) as { pgid: number; pidNamespace: string }
  expect(keeperIdentity.pgid).toBe(keeper.pid)
  expect(keeperIdentity.pgid).not.toBe(child.pid)
  expect(keeperIdentity.pidNamespace).toBe(await readlink(`/proc/${child.pid}/ns/pid`))

  const probe = (callId: string, cwd = workspace) => registry.callTool('tls-session', {
    callId, name: 'arena_git_probe', input: {
      parentCallId: 'approved-worktree-arena-parent', ownerGeneration: '1',
    }, cwd,
  })
  const success = await probe('arena-probe-TLSA')
  expect(success.ok, `${success.content}; Executor stderr: ${diagnostics.slice(-1800)}`).toBe(true)
  const repository = JSON.parse(success.content) as { repositoryIdentity: string }
  expect(repository).toMatchObject({
    finalEffectStopped: true, repoRoot: await realpath(workspace),
  })
  expect((await stat(journal)).size).toBeGreaterThan(0)
  const status = (callId: string, parentCallId = 'approved-worktree-arena-parent') => registry.callTool('tls-session', {
    callId, name: 'arena_git_status', cwd: workspace,
    input: { parentCallId, ownerGeneration: '1', repoRoot: workspace,
      repositoryIdentity: repository.repositoryIdentity, arenaId: 'tls-fixture',
      baseSha: '0'.repeat(40), candidates: [] },
  })
  expect((await status('arena-status-UNAPPROVED', 'not-approved')).ok).toBe(false)
  const safe = await status('arena-status-TLSA')
  expect(safe.ok, safe.content).toBe(true)
  expect(JSON.parse(safe.content)).toMatchObject({ finalEffectStopped: true, candidates: [] })
  execFileSync('git', ['-C', workspace, 'config', '--local', 'diff.attack.command', 'exit 1'], { stdio: 'ignore' })
  const unsafe = await status('arena-status-TLSB')
  expect(unsafe.ok, unsafe.content).toBe(true)
  expect(JSON.parse(unsafe.content).error).toMatch(/executable helpers/)
  execFileSync('git', ['-C', workspace, 'config', '--local', '--unset', 'diff.attack.command'], { stdio: 'ignore' })
  const outside = await probe('arena-probe-TLSB', testRoot)
  expect(outside.ok).toBe(false)

  await stop(keeper)
  const denied = await probe('arena-probe-TLSC')
  expect(denied.ok).toBe(false)
  expect(denied.content).toMatch(/keeper/i)
  expect(await registry.inspectArenaReceipt('tls-session', 'arena-probe-TLSC')).toMatchObject({
    state: 'denied', ownerGeneration: '1',
    requestDigest: executionRequestDigest({
      sessionId: 'tls-session', callId: 'arena-probe-TLSC', name: 'arena_git_probe',
      input: { parentCallId: 'approved-worktree-arena-parent', ownerGeneration: '1' },
      cwd: workspace, origin: 'host',
    }),
    result: { ok: false, failure: { code: 'arena_not_admitted' } },
  })
  keeper = await startKeeper()
  const resumed = await probe('arena-probe-TLSD')
  expect(resumed.ok, resumed.content).toBe(true)
  await stop(child)
  await waitFor(() => registry.snapshot().length === 0)
  expect(await registry.inspectArenaReceipt('tls-session', 'arena-probe-TLSC')).toEqual({ state: 'unavailable' })
}, 20_000)
