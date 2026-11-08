#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '../../packages/shared/dist/index.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hostRelease = resolve(process.env.PRODUCT_E2E_WINDOWS_HOST_RELEASE_DIR ?? join(root, 'release'))
const executorRelease = resolve(process.env.PRODUCT_E2E_WINDOWS_EXECUTOR_RELEASE_DIR ?? join(root, 'release'))
const target = process.env.PRODUCT_E2E_WINDOWS_TARGET ?? 'executor'
const hostBundle = join(hostRelease, 'kala-dashboard-with-runtime.cjs')
const executor = join(executorRelease, 'kala-executor.cjs')
const serviceHost = join(executorRelease, 'kala-executor-service-host-win32-x64.exe')
const executorPrebuild = join(executorRelease, 'prebuilds', 'win32-x64')
const stateRoot = mkdtempSync(join(tmpdir(), 'kala-windows-terminal-'))
const port = Number(process.env.PRODUCT_E2E_WINDOWS_TERMINAL_PORT ?? 3325)
const origin = `http://127.0.0.1:${port}`
const sessionId = 'windows-terminal-e2e'
const marker = `KALA_CONPTY_${Date.now()}`
const logs = []
const serviceMode = process.env.PRODUCT_E2E_WINDOWS_SERVICE === '1'
const invitePreflight = process.env.PRODUCT_E2E_WINDOWS_INVITE_PREFLIGHT === '1'
let host
let executorProcess
let dashboard
let serviceOwned = false

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('verify-windows-terminal.mjs requires a real Windows x64 runner')
  if (!['host', 'executor'].includes(target)) throw new Error(`unsupported Windows acceptance target ${target}`)
  assertFiles([hostBundle], 'Windows Host CJS')

  host = start(process.execPath, [hostBundle], {
    KALA_BIND_HOST: '127.0.0.1', KALA_PORT: String(port), KALA_STATE_DIR: join(stateRoot, 'state'),
    KALA_SESSIONS_DIR: join(stateRoot, 'sessions'), KALA_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), ANTHROPIC_API_KEY: 'unused',
    HOME: stateRoot, USERPROFILE: stateRoot,
    ...(target === 'executor' ? { KALA_RELEASE_ASSETS_DIR: hostRelease } : {}),
  })
  await waitForHttp(`${origin}/models`)
  const dashboardResponse = await fetch(`${origin}/`)
  if (!dashboardResponse.ok || !(dashboardResponse.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`portable Host dashboard is not browser-accessible (${dashboardResponse.status})`)
  }
  if (target === 'host') {
    console.log('PASS Windows x64 Portable Host CJS boot and browser-accessible API')
  } else {
    if (serviceMode) {
      const preexisting = await run('sc.exe', ['query', 'KalaExecutor'])
      if (preexisting.code === 0 || !preexisting.stdout.includes('1060')) throw new Error('Windows Executor service is not absent before isolated installation')
      serviceOwned = true
    }
    await verifyExecutorLifecycle()
    if (invitePreflight && !serviceMode) await verifyInviteBootstrapSecurityBoundary()
  }
} catch (error) {
  console.error(error)
  console.error(`Captured child-process diagnostics: ${summarizeLogs(logs.join(''))}`)
  process.exitCode = 1
} finally {
  dashboard?.close()
  await Promise.all([stop(executorProcess), stop(host)])
  if (serviceOwned) {
    const remaining = await run('sc.exe', ['query', 'KalaExecutor']).catch(() => ({ code: -1, stdout: '' }))
    if (remaining.code === 0) {
      await run('sc.exe', ['stop', 'KalaExecutor']).catch(() => undefined)
      await run('sc.exe', ['delete', 'KalaExecutor']).catch(() => undefined)
      if (!process.exitCode) {
        console.error('Windows service was not removed by the lifecycle acceptance test')
        process.exitCode = 1
      }
    }
  }
  rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function verifyExecutorLifecycle() {
  assertFiles([
    executor,
    serviceHost,
    ...['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll'].map((name) => join(executorPrebuild, name)),
    join(executorRelease, 'worker', 'conoutSocketWorker.js'),
    join(executorRelease, 'shared', 'conout.js'),
  ], 'Windows CJS Executor and complete node-pty companion')

  const capabilitiesResponse = await fetch(`${origin}/api/executor-install-capabilities`)
  if (!capabilitiesResponse.ok) throw new Error(`Windows install capabilities failed: ${capabilitiesResponse.status}`)
  const capabilities = await capabilitiesResponse.json()
  if (capabilities?.platforms?.windows?.available !== true) throw new Error('Windows Host did not recognize the complete checksum-verified local installer payload')

  const createResponse = await fetch(`${origin}/api/executor-installs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'windows', mode: serviceMode ? 'service' : 'temporary', privilegeMode: 'privileged', workspaceRoot: stateRoot, label: 'windows-terminal-e2e' }),
  })
  if (!createResponse.ok) {
    const detail = await createResponse.text()
    if (createResponse.status === 422 && detail.includes('windows_installation_unsupported')) {
      throw new Error('Windows Host/Executor lifecycle is blocked: the current Host API rejects Windows installation sessions; integrate the Windows assets into the global release inventory before accepting this target')
    }
    throw new Error(`create Windows install failed: ${createResponse.status} ${detail}`)
  }
  const created = await createResponse.json()
  if (typeof created.command !== 'string' || created.command.length === 0) throw new Error('create Windows install did not return a PowerShell command')
  executorProcess = start('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', created.command], {
    HOME: stateRoot, USERPROFILE: stateRoot,
    KALA_TERMINAL_DIAGNOSTICS: '1',
  })
  // Windows Defender may scan the freshly downloaded native SEA and ConPTY payloads.
  const completedDeadline = Date.now() + 120_000
  let installationCompleted = false
  let lastInstallState = { status: 'created', seq: 0 }
  while (Date.now() < completedDeadline) {
    const response = await fetch(`${origin}/api/executor-installs/${encodeURIComponent(created.id)}`)
    if (!response.ok) throw new Error(`install status failed: ${response.status}`)
    const snapshot = await response.json()
    lastInstallState = { status: snapshot.status, seq: snapshot.seq, errorCode: snapshot.errorCode }
    if (snapshot.status === 'completed') { installationCompleted = true; break }
    if (['failed', 'rejected', 'expired'].includes(snapshot.status)) break
    if (!serviceMode && (executorProcess.exitCode !== null || executorProcess.signalCode !== null)) break
    await sleep(100)
  }
  if (!installationCompleted) {
    const installerSignals = { ...JSON.parse(summarizeLogs(logs.join(''))), powerShellExit: executorProcess.exitCode ?? (executorProcess.signalCode ? 'signal' : 'running'), ...lastInstallState }
    if (serviceMode) {
      const scm = await run('sc.exe', ['query', 'KalaExecutor'])
      const installDir = join(process.env.ProgramFiles, 'Kala', 'Executor')
      const evidence = Object.fromEntries(['wrapper', 'out', 'err'].map((kind) => {
        const path = join(installDir, `kala-executor-service.${kind}.log`)
        if (!existsSync(path)) return [kind, { present: false }]
        const body = readFileSync(path, 'utf8').slice(-16_384)
        return [kind, {
          bytes: statSync(path).size,
          accessDenied: /access denied|UnauthorizedAccessException/iu.test(body),
          missingFile: /cannot find|not found|FileNotFoundException/iu.test(body),
          configError: /Invalid Executor config|Invalid Executor credential/iu.test(body),
          identityRejected: /workspace_identity_mismatch|auth_failed|workspace_id_conflict/iu.test(body),
          exited: /process exited|exited with code/iu.test(body),
        }]
      }))
      throw new Error(`Windows Executor installation did not complete; signals=${JSON.stringify(installerSignals)}; SCM state=${scm.stdout.match(/STATE\s*:\s*\d+\s+\w+/u)?.[0] ?? 'unavailable'}; service log signals=${JSON.stringify(evidence)}`)
    }
    throw new Error(`Windows Executor installation did not complete; signals=${JSON.stringify(installerSignals)}`)
  }
  if (serviceMode) {
    const status = await run('sc.exe', ['query', 'KalaExecutor'])
    if (status.code !== 0 || !/STATE\s*:\s*4\s+RUNNING/u.test(status.stdout)) throw new Error(`Windows Executor service did not reach RUNNING: ${status.stdout || status.stderr}`)
    const config = await run('sc.exe', ['qc', 'KalaExecutor'])
    if (config.code !== 0 || !config.stdout.includes('kala-executor-service.exe')) throw new Error('SCM did not start the verified service host')
  }

  dashboard = io(`${origin}/dashboard`, { transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false })
  await once(dashboard, 'session:ready')
  let workspaceId
  const workspaceDeadline = Date.now() + 15_000
  while (Date.now() < workspaceDeadline && !workspaceId) {
    const listed = await emitAcklessResponse(dashboard, 'client:list_executors', 'server:executors', {})
    workspaceId = listed.executors.find((candidate) => candidate.installId === created.id)?.workspaceId
    if (!workspaceId) await sleep(100)
  }
  if (!workspaceId) throw new Error('installed Windows Executor did not announce its Workspace')
  const sessionCreated = await emitAck(dashboard, 'client:create_session', { operationId: `session-${Date.now()}`, sessionId, workspaceId, cwd: stateRoot })
  if (!sessionCreated?.ok) throw new Error(`session create failed: ${sessionCreated?.error ?? 'missing success acknowledgement'}`)
  const createdTerminal = await emitAck(dashboard, 'terminal:create', { requestId: `create-${Date.now()}`, workspaceId, sessionId, cwd: stateRoot, cols: 100, rows: 30 })
  if (createdTerminal.error || !createdTerminal.terminalId) throw new Error(`terminal create failed: ${createdTerminal.error ?? 'missing terminalId'}`)
  const output = []
  dashboard.on('server:terminal_output', (payload) => { if (payload.terminalId === createdTerminal.terminalId) output.push(payload.data) })
  dashboard.emit('terminal:resize', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, cols: 120, rows: 40 })
  // ConPTY creation can ACK before PowerShell is ready to consume input. A
  // command's echoed source is not proof of execution; require a result that
  // cannot occur in the source text before testing the real user input once.
  const readyToken = `KALA_READY_${Date.now()}_`
  const readyDeadline = Date.now() + 40_000
  let nextReadyProbe = 0
  while (Date.now() < readyDeadline && !output.join('').includes(`${readyToken}True`)) {
    if (Date.now() >= nextReadyProbe) {
      dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ("${readyToken}" + (2 -eq 2))\r` })
      nextReadyProbe = Date.now() + 3_000
    }
    await sleep(50)
  }
  if (!output.join('').includes(`${readyToken}True`)) throw new Error(`PowerShell was not ready after ConPTY create; output=${output.join('').slice(-2000)}`)
  dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ${marker}\r` })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !output.join('').includes(marker)) await sleep(50)
  if (!output.join('').includes(marker)) throw new Error(`terminal did not echo marker; output=${output.join('').slice(-2000)}`)

  const ptyProbe = `KALA_PTY_${Date.now()}_`
  dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ("${ptyProbe}" + [Console]::IsOutputRedirected)\r` })
  const ptyDeadline = Date.now() + 15_000
  while (Date.now() < ptyDeadline && !output.join('').includes(`${ptyProbe}False`) && !output.join('').includes(`${ptyProbe}True`)) await sleep(50)
  if (!output.join('').includes(`${ptyProbe}False`)) throw new Error('Windows Terminal used redirected pipes instead of ConPTY')
  const killed = await emitAck(dashboard, 'terminal:kill', { requestId: `kill-${Date.now()}`, workspaceId, sessionId, terminalId: createdTerminal.terminalId })
  if (!killed.killed) throw new Error(`terminal kill failed: ${killed.error ?? 'unknown'}`)
  if (logs.join('').includes('Failed to load native module: conpty.node')) throw new Error(`ConPTY native load failed; diagnostics=${summarizeLogs(logs.join(''))}`)

  if (serviceMode) {
    const installDir = join(process.env.ProgramFiles, 'Kala', 'Executor')
    const dataDir = join(process.env.ProgramData, 'Kala', 'Executor')
    const installedExecutor = join(installDir, 'kala-executor.cjs')
    assertFiles([installedExecutor, join(installDir, 'kala-executor-service.exe'), join(installDir, 'prebuilds', 'win32-x64', 'conpty.node'),
      join(installDir, 'worker', 'conoutSocketWorker.js'), join(installDir, 'shared', 'conout.js'),
      join(dataDir, 'config.json')], 'managed Windows service installation')
    const uninstall = await run(process.execPath, [installedExecutor, 'service', 'uninstall'])
    const statusName = uninstall.stdout.match(/Removal status file: (kala-executor-uninstall-[A-Za-z0-9]+\.status)/u)?.[1]
    if (uninstall.code !== 0 || !uninstall.stdout.includes('Kala Executor Windows service removal was scheduled') || !statusName) {
      const stage = /Unable to create Windows removal task/u.test(uninstall.stderr) ? 'register' : /Unable to start Windows removal task/u.test(uninstall.stderr) ? 'run' : /did not confirm startup/u.test(uninstall.stderr) ? 'startup-timeout' : /failed during startup/u.test(uninstall.stderr) ? 'startup-failed' : 'unknown'
      const code = uninstall.stderr.match(/\b(?:0x[0-9a-f]{8}|2147[0-9]{6})\b/iu)?.[0] ?? 'none'
      const failure = /XML/u.test(uninstall.stderr) ? 'xml' : /[Aa]ccess is denied/u.test(uninstall.stderr) ? 'access-denied' : /file specified could not be found|cannot find the file/u.test(uninstall.stderr) ? 'missing-file' : 'other'
      const xmlPosition = uninstall.stderr.match(/\((\d+),(\d+)\)/u)?.slice(1).join(':') ?? 'none'
      const xmlReason = /malformed/iu.test(uninstall.stderr) ? 'malformed' : /incorrectly formatted|out of range/iu.test(uninstall.stderr) ? 'value' : /unexpected node/iu.test(uninstall.stderr) ? 'unexpected-node' : /missing|required/iu.test(uninstall.stderr) ? 'missing-node' : 'other'
      throw new Error(`Windows service uninstall was not scheduled; code=${uninstall.code}; stage=${stage}; failure=${failure}; xmlReason=${xmlReason}; xmlPosition=${xmlPosition}; taskErrorCode=${code}; stdoutBytes=${Buffer.byteLength(uninstall.stdout)}; stderrBytes=${Buffer.byteLength(uninstall.stderr)}`)
    }
    const removalStatus = join(tmpdir(), statusName)
    const uninstallDeadline = Date.now() + 60_000
    let outcome = existsSync(removalStatus) ? readFileSync(removalStatus, 'utf8') : 'status-missing'
    while (Date.now() < uninstallDeadline && (existsSync(installDir) || existsSync(dataDir) || outcome !== 'removed')) {
      if (outcome.startsWith('failed:')) break
      await sleep(100)
      outcome = existsSync(removalStatus) ? readFileSync(removalStatus, 'utf8') : 'status-missing'
    }
    if (existsSync(installDir) || existsSync(dataDir) || outcome !== 'removed') {
      throw new Error(`Windows service uninstall left managed installation data; self-removal=${outcome}; installDir=${existsSync(installDir)}; dataDir=${existsSync(dataDir)}`)
    }
    rmSync(removalStatus, { force: true })
  }
  console.log(`PASS Windows CJS Executor ${serviceMode ? 'service' : 'temporary'} ConPTY create/input/resize/kill lifecycle`)
}

async function verifyInviteBootstrapSecurityBoundary() {
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `irm '${origin}/install/invite.ps1' | iex`], {
    env: {
      HOST_URL: origin,
      KALA_RELEASE_BASE_URL: `${origin}/install/assets`,
      KALA_RELEASE_TRUST: 'host',
      EXECUTOR_INVITE: 'isolated-invalid-invite',
      KALA_INVITE_INSTALL_MODE: 'temporary',
    },
  })
  const output = `${result.stdout}\n${result.stderr}`
  if (result.code === 0 || !output.includes('A valid Executor invite is required')) {
    throw new Error(`Private Cloud invite.ps1 security preflight did not reach the expected fake-invite rejection (code=${result.code}; stdoutBytes=${Buffer.byteLength(result.stdout)}; stderrBytes=${Buffer.byteLength(result.stderr)})`)
  }
  console.log('PASS real Windows invite.ps1 bootstrap rejected an isolated invalid invite at the credential boundary (not a Private Cloud topology E2E)')
}

function assertFiles(paths, label) {
  const missing = paths.filter((path) => !existsSync(path))
  if (missing.length > 0) throw new Error(`${label} is incomplete; missing: ${missing.join(', ')}`)
}
function start(file, args, env) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  child.once('error', (error) => logs.push(`${error.stack ?? error}\n`))
  return child
}
function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else child.kill()
  })
}
function run(file, args, options = {}) { return new Promise((resolvePromise, reject) => { const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options, env: { ...process.env, ...options.env } }); let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk }); child.once('error', reject); child.once('exit', (code) => resolvePromise({ code, stdout, stderr, pid: child.pid })) }) }
function summarizeLogs(value) { return JSON.stringify({ bytes: Buffer.byteLength(value), installerFailure: value.match(/Kala installer failure type: ([A-Za-z]{1,80}); line: ([0-9]{1,5})/u)?.slice(1) ?? null, downloadStarted: /\[1\/4\] Downloading verified installer/u.test(value), sessionClaimStarted: /\[2\/4\] Validating setup code/u.test(value), executorStarted: /\[3\/4\] Starting Executor/u.test(value), releaseTrustStarted: /Checking Windows Executor release trust/u.test(value), releaseTrustChecked: /Windows Executor release trust checked/u.test(value), nodeChecked: /Windows Executor Node\.js 22\+ checked/u.test(value), nodeVersionRejected: /Node\.js 22\+ is required for the Windows Executor/iu.test(value), nodeVersionInvalid: /Unable to determine Node\.js version/iu.test(value), architectureRejected: /This installer requires Windows(?: x64)?/iu.test(value), scriptParserError: /ParserError|Unexpected token/iu.test(value), assetDownloadStarted: /Downloading verified Windows Executor assets/u.test(value), checksumDownloadStarted: /Fetching verified asset SHA256SUMS\.\.\./u.test(value), binaryDownloadStarted: /Fetching verified asset kala-executor\.cjs\.\.\./u.test(value), companionDownloadStarted: /Fetching verified asset node-pty-win32-x64\.tar\.gz\.\.\./u.test(value), serviceHostDownloadStarted: /Fetching verified asset kala-executor-service-host-win32-x64\.exe\.\.\./u.test(value), serviceHostDownloadCompleted: /Asset download completed kala-executor-service-host-win32-x64\.exe/u.test(value), binaryHashStarted: /Verifying Windows Executor checksum/u.test(value), archiveHashStarted: /Verifying Windows ConPTY archive checksum/u.test(value), serviceHostHashStarted: /Verifying Windows service-host checksum/u.test(value), conptyValidationStarted: /Verifying Windows ConPTY companion/u.test(value), conptyInventoryStarted: /Checking Windows ConPTY tar inventory/u.test(value), conptyTarListed: /Windows ConPTY tar listed/u.test(value), conptyInventoryVerified: /Windows ConPTY inventory verified/u.test(value), conptyExtracted: /Windows ConPTY extracted/u.test(value), conptyManifestStarted: /Checking Windows ConPTY manifest/u.test(value), conptyFilesStarted: /Hashing Windows ConPTY files/u.test(value), conptyVerified: /Windows ConPTY archive verified/u.test(value), nativeLaunchStarted: /Starting verified Windows Executor/u.test(value), accessDenied: /access denied|UnauthorizedAccessException/iu.test(value), missingFile: /cannot find|not found|FileNotFoundException/iu.test(value), httpError: /remote server returned an error|response status code/iu.test(value), invalidSession: /invalid installation session|empty installation environment|setup code is invalid/iu.test(value), trustRejected: /Host-mediated release trust|redirected away from the trusted Host/iu.test(value), checksumError: /SHA256SUMS (?:must|exceeds|Sigstore)|Checksum mismatch/iu.test(value), archiveError: /unexpected file inventory|companion manifest|Failed to extract/iu.test(value), powershellBindingError: /ParameterBindingException|PropertyNotFoundException|MethodException/iu.test(value), configError: /Invalid Executor config|Invalid Executor credential/iu.test(value), identityRejected: /workspace_identity_mismatch|auth_failed|workspace_id_conflict/iu.test(value), nativeLoadFailure: /Failed to load native module/iu.test(value) }) }
async function waitForHttp(url) {
  const deadline = Date.now() + 90_000
  let lastStatus
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (response.ok) return
      lastStatus = response.status
    } catch {}
    if (host?.exitCode !== null) throw new Error(`Host exited before becoming available (${host.exitCode})`)
    await sleep(100)
  }
  throw new Error(`Host unavailable: ${url} (last HTTP status: ${lastStatus ?? 'no response'})`)
}
function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }
function once(socket, event) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 15_000); socket.once(event, (payload) => { clearTimeout(timer); resolvePromise(payload) }) }) }
function emitAck(socket, event, payload) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 15_000); socket.emit(event, payload, (result) => { clearTimeout(timer); resolvePromise(result) }) }) }
function emitAcklessResponse(socket, requestEvent, responseEvent, payload) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${responseEvent} timed out`)), 15_000); socket.once(responseEvent, (result) => { clearTimeout(timer); resolvePromise(result) }); socket.emit(requestEvent, payload) }) }
