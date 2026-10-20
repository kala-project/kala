#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { io } from 'socket.io-client'
import { createRcEvidence } from './rc-evidence.mjs'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const asset = resolve(required('--asset'))
const predecessorAsset = option('--predecessor-asset') ? resolve(option('--predecessor-asset')) : asset
const target = required('--target')
const tag = required('--tag')
const revision = required('--revision')
const output = resolve(required('--output'))
if (basename(asset) !== 'kala-dashboard-with-runtime.cjs' || !existsSync(asset)) throw new Error('Portable CJS asset is missing')
if (basename(predecessorAsset) !== 'kala-dashboard-with-runtime.cjs' || !existsSync(predecessorAsset)) throw new Error('Portable predecessor CJS asset is missing')
if (target === 'win32-x64') {
  verifyWindowsPortableAndConpty()
  process.exit(0)
}
const executorAsset = resolve(required('--executor-asset'))
if (basename(executorAsset) !== `kala-executor-${target}` || !existsSync(executorAsset)) throw new Error(`Portable native Executor asset is missing for ${target}`)
const scratch = mkdtempSync(join(tmpdir(), 'runlab-portable-acceptance-'))
const install = join(scratch, 'kala-dashboard-with-runtime.cjs')
const state = join(scratch, 'state')
const sessions = join(state, 'sessions')
const artifacts = join(state, 'artifacts')
const workspace = join(scratch, 'workspace')
const home = join(scratch, 'home')
const workspaceIdFile = join(state, 'workspace-id')
const sessionId = 'portable-acceptance-' + randomUUID()
const executorToken = 'portable-acceptance-' + randomUUID()
mkdirSync(sessions, { recursive: true })
mkdirSync(artifacts, { recursive: true })
mkdirSync(workspace, { recursive: true })
mkdirSync(home, { recursive: true })
copyFileSync(predecessorAsset, install)
if (process.platform !== 'win32') chmodSync(install, 0o755)
let running
let executor

try {
  const first = await startPortable()
  const capabilities = await fetch(first.origin + '/runtime/capabilities').then(assertOkJson)
  if (capabilities.product !== 'portable' || capabilities.deployment?.architecture !== 'portable') throw new Error('CJS asset did not start in Portable mode')
  const dashboard = await fetch(first.origin + '/')
  if (!dashboard.ok || !(await dashboard.text()).includes('<html')) throw new Error('CJS asset did not serve its embedded Dashboard')
  const socket = await connect(first.origin)
  const nativeWorkspace = await waitForNativeExecutor(socket)
  const created = await emitAck(socket, 'client:create_session', {
    operationId: 'operation-' + randomUUID(), sessionId,
    workspaceId: nativeWorkspace.workspaceId, workspaceName: nativeWorkspace.workspaceName, cwd: workspace,
  })
  if (!created.ok) throw new Error('Portable Session creation failed: ' + String(created.error))
  const approval = await emitAck(socket, 'client:set_approval_mode', { operationId: 'operation-' + randomUUID(), sessionId, mode: 'allow_all' })
  if (!approval.ok) throw new Error('Portable Session approval setup failed: ' + String(approval.error))
  const listed = await listSessions(socket)
  if (!listed.sessions.some((entry) => entry.sessionId === sessionId)) throw new Error('created Portable Session was not listed')
  const ioMarker = 'PORTABLE_NATIVE_IO_OK'
  const ioOperation = 'operation-' + randomUUID()
  const ioResult = waitForShellResult(socket, ioOperation, ioMarker)
  const ioCommand = `!node -e "const fs=require('fs');fs.writeFileSync('portable-acceptance-io.txt','${ioMarker}\\n');process.stdout.write(fs.readFileSync('portable-acceptance-io.txt','utf8'))"`
  const message = await emitAck(socket, 'client:user_message', { operationId: ioOperation, sessionId, intent: 'shell', text: ioCommand })
  if (!message.ok) throw new Error('Portable native shell message failed: ' + String(message.error))
  await ioResult
  if (readFileSync(join(workspace, 'portable-acceptance-io.txt'), 'utf8') !== ioMarker + '\n') throw new Error('Portable native file write/read contract failed')
  socket.close()
  await stopChild(executor)
  executor = undefined
  await stopPortable(first.origin)

  const replacement = install + '.next'
  copyFileSync(asset, replacement)
  if (process.platform !== 'win32') chmodSync(replacement, 0o755)
  renameSync(replacement, install)
  const second = await startPortable()
  const restarted = await connect(second.origin)
  await waitForNativeExecutor(restarted)
  const afterRestart = await listSessions(restarted)
  if (!afterRestart.sessions.some((entry) => entry.sessionId === sessionId)) throw new Error('Portable Session state did not survive binary replacement and restart')
  const recoveryMarker = 'PORTABLE_RESTART_RECOVERY_OK'
  const recoveryOperation = 'operation-' + randomUUID()
  const recoveryResult = waitForShellResult(restarted, recoveryOperation, recoveryMarker)
  const recovery = await emitAck(restarted, 'client:user_message', {
    operationId: recoveryOperation, sessionId, intent: 'shell',
    text: `!node -e "const fs=require('fs');if(fs.readFileSync('portable-acceptance-io.txt','utf8').trim()!=='${ioMarker}')process.exit(9);process.stdout.write('${recoveryMarker}')"`,
  })
  if (!recovery.ok) throw new Error('Portable post-restart native shell message failed: ' + String(recovery.error))
  await recoveryResult
  restarted.close()
  await stopChild(executor)
  executor = undefined
  await stopPortable(second.origin)

  const evidence = createRcEvidence({
    category: 'portable', target, tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: basename(asset), sha256: createHash('sha256').update(readFileSync(asset)).digest('hex') },
    checks: {
      assetIntegrity: true, cleanInstall: true, boot: true, capabilities: true, dashboard: true,
      nativeExecutor: true, operatorCommandAccepted: true, fileRead: true, fileWrite: true,
      localShell: true, nativeTerminal: true, statePersistence: true, restartRecovery: true,
      cleanStop: true, reinstall: true,
    },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category: 'portable', target, evidence: basename(output) }) + '\n')
} finally {
  if (running) await stopPortable().catch(() => undefined)
  if (executor) await stopChild(executor).catch(() => undefined)
  rmSync(scratch, { recursive: true, force: true })
}

async function startPortable() {
  const port = await freePort()
  const logs = []
  const child = spawn(process.execPath, [install], {
    cwd: scratch,
    env: { ...process.env, KALA_BIND_HOST: '127.0.0.1', KALA_PORT: String(port), KALA_STATE_DIR: state, KALA_SESSIONS_DIR: sessions, KALA_ARTIFACTS_DIR: artifacts, KALA_EXECUTOR_TOKENS: JSON.stringify([{ token: executorToken }]), ANTHROPIC_API_KEY: 'acceptance-key-not-used' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  child.once('error', (error) => logs.push(`Portable process error: ${String(error)}\n`))
  running = { child, exit, logs }
  const origin = 'http://127.0.0.1:' + port
  try {
    const ready = await Promise.race([
      waitForHttp(origin + '/runtime/capabilities', 60_000).then(() => ({ ready: true })),
      exit.then((result) => ({ ready: false, result })),
    ])
    if (!ready.ready) throw new Error(`Portable process exited before readiness: ${JSON.stringify(ready.result)}`)
  } catch (error) {
    throw new Error(String(error) + '\n' + logs.join('').slice(-2000))
  }
  if (!executor) executor = startNativeExecutor(origin)
  return { origin }
}

function startNativeExecutor(origin) {
  if (process.platform !== target.split('-')[0] && !(process.platform === 'darwin' && target.startsWith('darwin-'))) throw new Error(`Portable ${target} acceptance requires its matching native runner`)
  chmodSync(executorAsset, 0o755)
  const logs = []
  const child = spawn(executorAsset, ['--host', origin, '--sandbox-root', workspace, '--name', 'portable-acceptance'], {
    cwd: workspace,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), EXECUTOR_TOKEN: executorToken, WORKSPACE_NAME: 'portable-acceptance', KALA_WORKSPACE_ID_FILE: workspaceIdFile },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  child.once('error', (error) => logs.push(`Portable Executor process error: ${String(error)}\n`))
  return { child, exit, logs }
}

async function stopPortable(origin) {
  const processState = running
  if (!processState) return
  if (!origin) processState.child.kill('SIGTERM')
  else {
    const response = await fetch(origin + '/runtime/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'checkpoint', reason: 'manual', timeoutMs: 10_000 }),
    })
    if (!response.ok) throw new Error('Portable graceful stop request failed: HTTP ' + response.status)
  }
  const exit = await Promise.race([processState.exit, delay(10_000).then(() => null)])
  running = undefined
  if (!exit) { processState.child.kill('SIGKILL'); throw new Error('Portable process did not stop gracefully') }
}

async function connect(origin) {
  const socket = io(origin + '/dashboard', { transports: ['websocket'], auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: false })
  await Promise.race([new Promise((resolveReady, reject) => { socket.once('session:ready', resolveReady); socket.once('connect_error', reject) }), delay(10_000).then(() => { throw new Error('Portable Dashboard socket did not become ready') })])
  return socket
}
function emitAck(socket, event, payload) { return socket.timeout(5_000).emitWithAck(event, payload) }
function listSessions(socket) { return new Promise((resolveList, reject) => { const timer = setTimeout(() => reject(new Error('Portable Session list timed out')), 5_000); socket.once('server:sessions', (value) => { clearTimeout(timer); resolveList(value) }); socket.emit('client:list_sessions', {}) }) }
function listExecutors(socket) { return new Promise((resolveList, reject) => { const timer = setTimeout(() => reject(new Error('Portable Executor list timed out')), 5_000); socket.once('server:executors', (value) => { clearTimeout(timer); resolveList(value) }); socket.emit('client:list_executors', {}) }) }
async function waitForNativeExecutor(socket) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await listExecutors(socket)
    const attached = result.executors.find((entry) => entry.runtime === 'node' && entry.workspaceId && entry.tools.includes('shell'))
    if (attached) return attached
    if (executor) {
      const exited = await Promise.race([executor.exit, delay(0).then(() => null)])
      if (exited) throw new Error(`Portable native Executor exited before announcing: ${JSON.stringify(exited)}\n${executor.logs.join('').slice(-2000)}`)
    }
    await delay(200)
  }
  throw new Error('Portable native Executor did not attach with shell capability')
}
function waitForShellResult(socket, operationId, marker) {
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { socket.off('event:appended', onEvent); reject(new Error(`Portable native terminal result timed out: ${marker}`)) }, 30_000)
    function onEvent(payload) {
      const text = payload?.event?.kind === 'user_message' ? payload.event.text : ''
      if (!text.includes('Shell command result') || !text.includes(`Operation: ${operationId}`)) return
      clearTimeout(timer)
      socket.off('event:appended', onEvent)
      if (!text.includes('Status: completed') || !text.includes('Exit status: 0') || !text.includes(marker)) reject(new Error(`Portable native terminal result failed: ${text.slice(-1000)}`))
      else resolveResult()
    }
    socket.on('event:appended', onEvent)
  })
}
async function stopChild(processState) {
  processState.child.kill('SIGTERM')
  const exit = await Promise.race([processState.exit, delay(10_000).then(() => null)])
  if (!exit) { processState.child.kill('SIGKILL'); throw new Error('Portable native Executor did not stop') }
}
async function assertOkJson(response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json() }
async function waitForHttp(url, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return } catch {}; await delay(100) }; throw new Error('Portable process did not become ready') }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('failed to allocate a port'))) }) }) }
function verifyWindowsPortableAndConpty() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows Portable acceptance requires a real Windows x64 runner')
  const releaseDir = resolve(required('--release-dir'))
  const names = [
    'kala-dashboard-with-runtime.cjs',
    'kala-executor-win32-x64.exe',
    'node-pty-win32-x64.tar.gz',
    'kala-executor-service-host-win32-x64.exe',
    'install-executor.ps1',
    'kala-copilot-runtime-win32-x64',
    'kala-copilot-runtime-node-win32-x64.node',
  ]
  for (const name of names) if (!existsSync(join(releaseDir, name))) throw new Error(`Windows release acceptance asset is missing: ${name}`)
  if (resolve(asset) !== resolve(releaseDir, 'kala-dashboard-with-runtime.cjs')) throw new Error('Windows Portable asset must come from the accepted release directory')
  const verifier = resolve(import.meta.dirname, '../product-e2e/verify-windows-terminal.mjs')
  for (const service of ['0', '1']) {
    const result = spawnSync(process.execPath, [verifier], {
      cwd: resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        PRODUCT_E2E_WINDOWS_HOST_RELEASE_DIR: releaseDir,
        PRODUCT_E2E_WINDOWS_EXECUTOR_RELEASE_DIR: releaseDir,
        PRODUCT_E2E_WINDOWS_TARGET: 'executor',
        PRODUCT_E2E_WINDOWS_SERVICE: service,
      },
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.status !== 0) throw new Error(`Windows ${service === '1' ? 'service' : 'temporary'} ConPTY acceptance failed`)
  }
  const artifacts = names.map((name) => ({ name, sha256: createHash('sha256').update(readFileSync(join(releaseDir, name))).digest('hex') }))
  const evidence = createRcEvidence({
    category: 'portable', target, tag, version: tag.slice(1), revision, ok: true,
    artifact: artifacts.find((entry) => entry.name === 'kala-dashboard-with-runtime.cjs'),
    artifacts,
    checks: {
      assetIntegrity: true, cleanInstall: true, boot: true, capabilities: true, dashboard: true,
      cleanStop: true, hostNode22: true, nativeExecutor: true,
      temporaryConptyLifecycle: true, serviceConptyLifecycle: true,
    },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category: 'portable', target, evidence: basename(output) }) + '\n')
}

function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
