import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'

export type WindowsServiceAction = 'create' | 'start' | 'query' | 'stop' | 'delete' | 'recovery'

export interface WindowsServiceLayout {
  installDir: string
  dataDir: string
  executablePath: string
  nodeExecutablePath: string
  serviceHostPath: string
  serviceConfigPath: string
  configPath: string
}

export interface WindowsServiceCommand {
  action: WindowsServiceAction
  command: 'sc.exe'
  args: readonly string[]
}

export interface WindowsServicePlan {
  layout: WindowsServiceLayout
  commands: readonly WindowsServiceCommand[]
}

export interface WindowsServicePlanOptions {
  serviceName: string
  displayName?: string
  executableName?: string
  nodeExecutablePath?: string
  vendor?: string
  product?: string
  programFiles?: string
  programData?: string
  recovery?: {
    resetSeconds?: number
    restartDelaysMs?: readonly number[]
  }
}

export interface WindowsCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type WindowsCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { input?: string },
) => Promise<WindowsCommandResult>

export interface WindowsServiceExecutorOptions {
  runner?: WindowsCommandRunner
  platform?: NodeJS.Platform
}

export interface ManagedWindowsInstallation {
  installationSource: 'dashboard-native' | 'private-cloud-invite'
  installationId: string
}

export interface WindowsSelfRemovalPlan {
  taskName: string
  taskXmlPath: string
  statusPath: string
  taskXml: string
}

export interface WindowsSelfRemovalPlanOptions {
  installDir: string
  dataDir: string
  ownerPid: number
  statusDir?: string
  id?: string
}

const DEFAULT_VENDOR = 'Kala'
const DEFAULT_PRODUCT = 'Executor'
export const WINDOWS_SERVICE_HOST_ASSET = 'kala-executor-service-host-win32-x64.exe'
const WINDOWS_SERVICE_HOST_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
const WINDOWS_SERVICE_HOST_BYTES = 18_243_033

/** Re-verify the pinned release asset at the privileged installation boundary. */
export function copyWindowsServiceHost(sourceRoot: string, destinationRoot: string): void {
  const source = join(sourceRoot, WINDOWS_SERVICE_HOST_ASSET)
  if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).size !== WINDOWS_SERVICE_HOST_BYTES) {
    throw new Error('Windows service host is missing or has the wrong size')
  }
  const bytes = readFileSync(source)
  if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_SERVICE_HOST_SHA256) {
    throw new Error('Windows service host SHA-256 mismatch')
  }
  copyFileSync(source, join(destinationRoot, 'kala-executor-service.exe'))
  if (createHash('sha256').update(readFileSync(join(destinationRoot, 'kala-executor-service.exe'))).digest('hex') !== WINDOWS_SERVICE_HOST_SHA256) {
    throw new Error('Windows service host copy SHA-256 mismatch')
  }
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;')
}

function powershellLiteral(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw new Error('Invalid Windows self-removal value')
  return `'${value.replace(/'/gu, "''")}'`
}

function assertAbsoluteWindowsPath(value: string, label: string): string {
  if (!win32.isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error(`Invalid Windows self-removal ${label}`)
  const resolved = win32.resolve(value)
  if (win32.dirname(resolved) === resolved) throw new Error(`Unsafe Windows self-removal ${label}`)
  return resolved
}

function pathContains(parent: string, child: string): boolean {
  const relative = win32.relative(parent, child)
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative))
}

/**
 * Build an on-demand SYSTEM task whose action is self-contained. The XML is
 * written under the already ACL-hardened service data directory; no script in
 * a user-writable temporary directory is ever executed as SYSTEM.
 */
export function createWindowsSelfRemovalPlan(options: WindowsSelfRemovalPlanOptions): WindowsSelfRemovalPlan {
  const installDir = assertAbsoluteWindowsPath(options.installDir, 'installation path')
  const dataDir = assertAbsoluteWindowsPath(options.dataDir, 'data path')
  const statusDir = assertAbsoluteWindowsPath(options.statusDir ?? tmpdir(), 'status path')
  if (pathContains(installDir, dataDir) || pathContains(dataDir, installDir)) {
    throw new Error('Windows self-removal installation and data paths must be separate')
  }
  if (pathContains(installDir, statusDir) || pathContains(dataDir, statusDir)) {
    throw new Error('Windows self-removal status path must be outside removed directories')
  }
  if (!Number.isSafeInteger(options.ownerPid) || options.ownerPid <= 0) throw new Error('Invalid Windows self-removal owner PID')
  const id = options.id ?? randomUUID().replace(/-/gu, '')
  if (!/^[A-Za-z0-9]{16,64}$/u.test(id)) throw new Error('Invalid Windows self-removal identifier')

  const taskName = `KalaExecutor-Uninstall-${id}`
  const taskXmlPath = win32.join(dataDir, `.uninstall-${id}.xml`)
  const statusPath = win32.join(statusDir, `kala-executor-uninstall-${id}.status`)
  const script = `$ErrorActionPreference='Stop'\n` +
    `$status=${powershellLiteral(statusPath)}\n` +
    `function Set-Status([string]$value) { [IO.File]::WriteAllText($status,$value) }\n` +
    `function Remove-Tree([string]$path) {\n` +
    `  for ($attempt=0; $attempt -lt 100; $attempt++) {\n` +
    `    try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop; return }\n` +
    `    catch { if ($attempt -eq 99) { throw }; Start-Sleep -Milliseconds 200 }\n` +
    `  }\n` +
    `}\n` +
    `try {\n` +
    `  Set-Status 'started'\n` +
    `  & "$env:SystemRoot\\System32\\schtasks.exe" /Delete /TN ${powershellLiteral(taskName)} /F | Out-Null\n` +
    `  if ($LASTEXITCODE -ne 0) { throw 'task_cleanup' }\n` +
    `  $deadline=(Get-Date).AddSeconds(60)\n` +
    `  while (Get-Process -Id ${options.ownerPid} -ErrorAction SilentlyContinue) {\n` +
    `    Set-Status 'waiting-for-parent'\n` +
    `    if ((Get-Date) -ge $deadline) { throw 'owner_timeout' }\n` +
    `    Start-Sleep -Milliseconds 100\n` +
    `  }\n` +
    `  Set-Status 'deleting'\n` +
    `  Remove-Tree ${powershellLiteral(installDir)}\n` +
    `  Remove-Tree ${powershellLiteral(dataDir)}\n` +
    `  if ((Test-Path -LiteralPath ${powershellLiteral(installDir)}) -or (Test-Path -LiteralPath ${powershellLiteral(dataDir)})) { throw 'path_remaining' }\n` +
    `  Set-Status 'removed'\n` +
    `} catch {\n` +
    `  $kind=if ($_.Exception.Message -match '^(task_cleanup|owner_timeout|path_remaining)$') { $_.Exception.Message } else { $_.Exception.GetType().Name }\n` +
    `  try { Set-Status ('failed:'+$kind) } catch {}\n` +
    `  exit 1\n` +
    `}\n`
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>\n` +
    `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n` +
    `  <RegistrationInfo><Description>Kala Executor one-time removal</Description></RegistrationInfo>\n` +
    `  <Triggers />\n` +
    `  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>\n` +
    `  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT5M</ExecutionTimeLimit></Settings>\n` +
    `  <Actions Context="System"><Exec><Command>powershell.exe</Command><Arguments>${xml(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`)}</Arguments></Exec></Actions>\n` +
    `</Task>\n`
  return { taskName, taskXmlPath, statusPath, taskXml }
}

/** schtasks imports the XML file as UTF-16LE with a matching declaration. */
export function encodeWindowsTaskXml(taskXml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, 'utf16le')])
}

export async function deleteWindowsSelfRemovalTask(
  taskName: string,
  options: WindowsServiceExecutorOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows Task Scheduler is unavailable on this platform')
  const result = await (options.runner ?? spawnWindowsCommand)('schtasks.exe', ['/Delete', '/TN', taskName, '/F'])
  if (result.exitCode !== 0) throw new Error(`Unable to delete Windows removal task: ${result.stderr.trim() || result.stdout.trim()}`)
}

export async function registerWindowsSelfRemovalTask(
  plan: WindowsSelfRemovalPlan,
  options: WindowsServiceExecutorOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows Task Scheduler is unavailable on this platform')
  const runner = options.runner ?? spawnWindowsCommand
  const create = await runner('schtasks.exe', ['/Create', '/XML', plan.taskXmlPath, '/TN', plan.taskName])
  if (create.exitCode !== 0) throw new Error(`Unable to create Windows removal task: ${create.stderr.trim() || create.stdout.trim()}`)
  let run: WindowsCommandResult
  try {
    run = await runner('schtasks.exe', ['/Run', '/TN', plan.taskName])
  } catch (error) {
    await deleteWindowsSelfRemovalTask(plan.taskName, { ...options, runner }).catch(() => undefined)
    throw error
  }
  if (run.exitCode === 0) return
  await deleteWindowsSelfRemovalTask(plan.taskName, { ...options, runner }).catch(() => undefined)
  throw new Error(`Unable to start Windows removal task: ${run.stderr.trim() || run.stdout.trim()}`)
}

export function renderWindowsServiceConfig(layout: WindowsServiceLayout, serviceName: string, displayName: string): string {
  return `<service>\n  <id>${xml(safeValue(serviceName, 'name'))}</id>\n  <name>${xml(safeValue(displayName, 'display name'))}</name>\n  <description>Kala Executor (Node.js)</description>\n  <executable>${xml(layout.nodeExecutablePath)}</executable>\n  <arguments>${xml(quoteWindowsArgument(layout.executablePath))} --config ${xml(quoteWindowsArgument(layout.configPath))}</arguments>\n  <log mode="roll-by-size">\n    <sizeThreshold>10240</sizeThreshold>\n    <keepFiles>5</keepFiles>\n  </log>\n  <stoptimeout>15sec</stoptimeout>\n  <stopparentprocessfirst>true</stopparentprocessfirst>\n</service>\n`
}

export async function assertElevatedWindowsAdministrator(
  options: WindowsServiceExecutorOptions & { systemRoot?: string } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows service installation requires an elevated Administrator process')
  const systemRoot = options.systemRoot ?? process.env.SystemRoot
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows service installation requires an elevated Administrator process')
  // Use the same effective Administrator membership check as invite.ps1.
  // A high-integrity SID alone is not portable across supported Windows runner policies.
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }'
  const result = await (options.runner ?? spawnWindowsCommand)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]).catch(() => undefined)
  if (result?.exitCode !== 0) throw new Error('Windows service installation requires an elevated Administrator process')
}

export async function secureWindowsServiceDataDir(
  dataDir: string,
  options: WindowsServiceExecutorOptions = {},
): Promise<void> {
  await secureWindowsServiceDirectory(dataDir, 'credentials', options)
}

export async function secureWindowsServiceInstallDir(
  installDir: string,
  options: WindowsServiceExecutorOptions = {},
): Promise<void> {
  await secureWindowsServiceDirectory(installDir, 'installation', options)
}

async function secureWindowsServiceDirectory(
  path: string,
  label: string,
  options: WindowsServiceExecutorOptions,
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows ACL hardening is unavailable on this platform')
  // Strip inherited Users access before placing executable code or credentials.
  const result = await (options.runner ?? spawnWindowsCommand)('icacls.exe', [
    path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
  ])
  if (result.exitCode !== 0) throw new Error(`Unable to secure Windows Executor ${label} directory: ${result.stderr.trim() || result.stdout.trim()}`)
}

export const WINDOWS_NODE_PTY_RUNTIME_FILES = Object.freeze([
  'prebuilds/win32-x64/conpty.node',
  'prebuilds/win32-x64/conpty_console_list.node',
  'prebuilds/win32-x64/pty.node',
  'prebuilds/win32-x64/winpty-agent.exe',
  'prebuilds/win32-x64/winpty.dll',
  'worker/conoutSocketWorker.js',
  'shared/conout.js',
])

/** Recheck the archive manifest before and after copying its runtime closure beside the CJS. */
export function copyWindowsNodePtyRuntime(sourceRoot: string, destinationRoot: string, verifiedManifestDigest: string): void {
  const manifestPath = join(sourceRoot, 'node-pty-companion.json')
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) throw new Error('Windows node-pty companion manifest is missing')
  if (!/^[0-9a-f]{64}$/u.test(verifiedManifestDigest)
    || createHash('sha256').update(readFileSync(manifestPath)).digest('hex') !== verifiedManifestDigest) {
    throw new Error('Windows node-pty companion manifest changed since installer verification')
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersion?: number; product?: string; target?: string; nodePtyVersion?: string
    files?: { path: string; sha256: string; bytes: number }[]
  }
  if (manifest.schemaVersion !== 1 || manifest.product !== 'kala-executor-node-pty-companion'
    || manifest.target !== 'win32-x64' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.nodePtyVersion ?? '')
    || !Array.isArray(manifest.files) || manifest.files.length !== WINDOWS_NODE_PTY_RUNTIME_FILES.length
    || new Set(manifest.files.map((file) => file.path)).size !== WINDOWS_NODE_PTY_RUNTIME_FILES.length
    || WINDOWS_NODE_PTY_RUNTIME_FILES.some((relative) => !manifest.files!.some((file) => file.path === relative))) {
    throw new Error('Windows node-pty companion manifest inventory is invalid')
  }
  const files = WINDOWS_NODE_PTY_RUNTIME_FILES.map((relative) => ({
    relative,
    source: join(sourceRoot, ...relative.split('/')),
    destination: join(destinationRoot, ...relative.split('/')),
    metadata: manifest.files!.find((file) => file.path === relative)!,
  }))
  for (const file of files) {
    if (!existsSync(file.source) || !lstatSync(file.source).isFile()) throw new Error(`Windows node-pty runtime is missing ${file.relative}`)
    assertFileDigest(file.source, file.metadata.bytes, file.metadata.sha256, file.relative)
  }
  for (const file of files) {
    mkdirSync(dirname(file.destination), { recursive: true, mode: 0o700 })
    copyFileSync(file.source, file.destination)
    assertFileDigest(file.destination, file.metadata.bytes, file.metadata.sha256, file.relative)
  }
}

function assertFileDigest(path: string, bytes: number, sha256: string, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[0-9a-f]{64}$/u.test(sha256)
    || !lstatSync(path).isFile() || lstatSync(path).size !== bytes
    || createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) {
    throw new Error(`Windows Executor integrity mismatch for ${label}`)
  }
}

/** The installer verified signed SHA256SUMS; reject changes to the staged CJS at the service boundary. */
export function copyWindowsExecutorCjs(sourceRoot: string, destinationPath: string, verifiedDigest: string): void {
  const name = 'kala-executor.cjs'
  const sumsPath = join(sourceRoot, 'SHA256SUMS')
  const source = join(sourceRoot, name)
  if (!existsSync(sumsPath) || !lstatSync(sumsPath).isFile() || !existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error('Verified Windows Executor CJS or SHA256SUMS is missing')
  }
  const entries = readFileSync(sumsPath, 'utf8').split(/\r?\n/u)
    .map((line) => line.match(/^([0-9a-fA-F]{64})  kala-executor\.cjs$/u)?.[1]?.toLowerCase())
    .filter((digest): digest is string => digest !== undefined)
  if (entries.length !== 1) throw new Error('SHA256SUMS must contain exactly one Windows Executor CJS entry')
  if (!/^[0-9a-f]{64}$/u.test(verifiedDigest) || entries[0] !== verifiedDigest) {
    throw new Error('Windows Executor checksum changed since installer verification')
  }
  const bytes = lstatSync(source).size
  assertFileDigest(source, bytes, entries[0]!, name)
  copyFileSync(source, destinationPath)
  assertFileDigest(destinationPath, bytes, entries[0]!, name)
}

export function windowsExecutorSourceRoot(execPath: string, scriptPath: string | undefined, nodeVersion: string): string {
  if (!win32.isAbsolute(execPath) || win32.basename(execPath).toLowerCase() !== 'node.exe'
    || !scriptPath || !win32.isAbsolute(scriptPath) || win32.basename(scriptPath).toLowerCase() !== 'kala-executor.cjs'
    || Number(nodeVersion.split('.')[0]) < 22) {
    throw new Error('Windows service mode requires Node.js 22+ running a verified kala-executor.cjs')
  }
  return win32.dirname(scriptPath)
}

function safeValue(value: string, label: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error(`Invalid Windows service ${label}`)
  return value
}

/** Quote one argument using the Windows CommandLineToArgvW escaping rules. */
export function quoteWindowsArgument(value: string): string {
  safeValue(value, 'argument')
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

export function windowsServiceLayout(options: WindowsServicePlanOptions): WindowsServiceLayout {
  const vendor = safeValue(options.vendor ?? DEFAULT_VENDOR, 'vendor')
  const product = safeValue(options.product ?? DEFAULT_PRODUCT, 'product')
  const programFiles = safeValue(options.programFiles ?? 'C:\\Program Files', 'Program Files path')
  const programData = safeValue(options.programData ?? 'C:\\ProgramData', 'ProgramData path')
  const executableName = safeValue(options.executableName ?? 'kala-executor.cjs', 'executable name')
  const nodeExecutablePath = safeValue(options.nodeExecutablePath ?? (process.platform === 'win32' ? process.execPath : 'C:\\Program Files\\nodejs\\node.exe'), 'Node.js path')
  if (!win32.isAbsolute(nodeExecutablePath) || win32.basename(nodeExecutablePath).toLowerCase() !== 'node.exe') {
    throw new Error('Windows service requires an absolute Node.js executable path')
  }
  const installDir = win32.join(programFiles, vendor, product)
  const dataDir = win32.join(programData, vendor, product)
  return {
    installDir,
    dataDir,
    executablePath: win32.join(installDir, executableName),
    nodeExecutablePath,
    serviceHostPath: win32.join(installDir, 'kala-executor-service.exe'),
    serviceConfigPath: win32.join(installDir, 'kala-executor-service.xml'),
    configPath: win32.join(dataDir, 'config.json'),
  }
}

export function assertManagedWindowsInstallation(value: unknown): ManagedWindowsInstallation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Refusing to uninstall an unrecognized Windows Executor installation')
  const input = value as Record<string, unknown>
  if ((input.installationSource !== 'dashboard-native' && input.installationSource !== 'private-cloud-invite') || typeof input.installationId !== 'string' || !input.installationId || input.installationId.includes('\0')) throw new Error('Refusing to uninstall an unrecognized Windows Executor installation')
  return { installationSource: input.installationSource, installationId: input.installationId }
}

/**
 * Generate an SCM plan without touching the host. The service command line has
 * exactly one application option (`--config`); credentials never enter SCM.
 */
export function createWindowsServicePlan(options: WindowsServicePlanOptions): WindowsServicePlan {
  const serviceName = safeValue(options.serviceName, 'name')
  const displayName = safeValue(options.displayName ?? serviceName, 'display name')
  const layout = windowsServiceLayout(options)
  // Node.js is a console program and cannot report SERVICE_RUNNING to SCM.
  const binaryPath = quoteWindowsArgument(layout.serviceHostPath)
  const resetSeconds = options.recovery?.resetSeconds ?? 86_400
  const restartDelaysMs = options.recovery?.restartDelaysMs ?? [5_000, 30_000]
  if (!Number.isSafeInteger(resetSeconds) || resetSeconds < 0) throw new Error('Invalid recovery reset seconds')
  if (restartDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new Error('Invalid recovery restart delay')
  }
  const actions = [...restartDelaysMs.map((delay) => `restart/${delay}`), 'none/0'].join('/')
  const command = (action: WindowsServiceAction, args: readonly string[]): WindowsServiceCommand => ({
    action,
    command: 'sc.exe',
    args,
  })
  return {
    layout,
    commands: [
      command('create', ['create', serviceName, 'binPath=', binaryPath, 'start=', 'auto', 'DisplayName=', displayName]),
      command('recovery', ['failure', serviceName, 'reset=', String(resetSeconds), 'actions=', actions]),
      command('start', ['start', serviceName]),
      command('query', ['query', serviceName]),
      command('stop', ['stop', serviceName]),
      command('delete', ['delete', serviceName]),
    ],
  }
}

export async function executeWindowsServiceCommand(
  command: WindowsServiceCommand,
  options: WindowsServiceExecutorOptions = {},
): Promise<WindowsCommandResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows SCM is unavailable on this platform')
  const result = await (options.runner ?? spawnWindowsCommand)(command.command, command.args)
  if (result.exitCode !== 0) {
    throw new Error(`SCM ${command.action} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

export async function executeWindowsServicePlan(
  plan: WindowsServicePlan,
  actions: readonly WindowsServiceAction[],
  options: WindowsServiceExecutorOptions = {},
): Promise<readonly WindowsCommandResult[]> {
  const results: WindowsCommandResult[] = []
  for (const action of actions) {
    const command = plan.commands.find((candidate) => candidate.action === action)
    if (!command) throw new Error(`Windows service plan does not contain ${action}`)
    results.push(await executeWindowsServiceCommand(command, options))
  }
  return results
}

export async function waitForWindowsServiceStopped(
  plan: WindowsServicePlan,
  options: WindowsServiceExecutorOptions & { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  const query = plan.commands.find((command) => command.action === 'query')
  if (!query) throw new Error('Windows service plan does not contain query')
  while (true) {
    try {
      const result = await executeWindowsServiceCommand(query, options)
      const match = result.stdout.match(/\bSTATE\s*:\s*(\d+)\b/iu)
      if (!match) throw new Error('Windows SCM query returned an unrecognized state')
      if (Number(match[1]) === 1) return // STOPPED; pending stop is state 3.
    } catch (error) {
      // 1060 means the service was not registered (e.g. install failed before
      // sc create). Do not interpret any other SCM error as a stopped process.
      if (!(error instanceof Error) || !/SCM query failed \(1060\)|\[SC\] OpenService FAILED 1060/u.test(error.message)) throw error
      return
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Windows Executor service to stop')
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250))
  }
}

export const spawnWindowsCommand: WindowsCommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, shell: false, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
    child.stdin.end(options.input)
  })
